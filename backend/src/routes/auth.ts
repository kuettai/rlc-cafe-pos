import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuid } from 'uuid';
import { docClient, USERS_TABLE, ScanCommand, UpdateCommand, GetCommand, PutCommand, QueryCommand } from '../lib/db';
import { comparePin, signToken, hashPin, verifyToken } from '../lib/auth';
import { logAuth } from '../lib/audit';
import {
  buildRegistrationOptions, verifyRegistration,
  buildAuthenticationOptions, verifyAuthentication,
  putChallenge, getChallenge, deleteChallenge, isChallengeExpired,
  toBase64Url, RP_ID, ORIGIN, type StoredPasskeyCredential,
} from '../lib/webauthn';

/**
 * Hard cap on enrolled passkeys per account.
 *
 * `list_append` has no bound of its own. A DynamoDB item is capped at 400KB, and
 * a stored credential is ~300 bytes, so the theoretical ceiling is high — but the
 * failure mode when an item does hit the limit is that *every* later write to it
 * is rejected, including `lastLoginAt` and the PIN change. The account would
 * brick itself. 10 covers phone + laptop + tablet + spares with room to spare.
 */
const MAX_PASSKEYS_PER_USER = 10;

/**
 * Identifiers that can never log in, matched case-insensitively against both
 * the submitted identifier and the resolved user record.
 *
 * Rationale: the original seed account (`admin-001`, name `Admin`) was a shared
 * ADMIN credential whose PIN was committed to a public repository. It was used
 * for an unauthorised login on 2026-08-02. Deleting the record is not enough on
 * its own — anyone can recreate an account with the same name — so the
 * identifier itself is refused at the door.
 *
 * The pattern is a prefix match, so `admin`, `Admin`, `ADMIN`, `admin-001` and
 * `Admin-002` are all refused. A real volunteer whose name begins with "admin"
 * would also be refused; that is an accepted trade-off for a security control,
 * and such a person can be given any other display name.
 */
export const BLOCKED_LOGIN_PATTERNS: RegExp[] = [/^admin/i];

/** True if this identifier is permanently barred from logging in. */
export function isBlockedIdentifier(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return BLOCKED_LOGIN_PATTERNS.some(re => re.test(normalized));
}

export async function handleAuth(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod === 'POST' && event.path === '/api/auth/login') {
    const body = JSON.parse(event.body || '{}');
    const rawUserId = body.userId;
    const userId = rawUserId ? rawUserId.toLowerCase().trim() : '';
    const pin = body.pin;

    // Request metadata for the audit trail. Never log the PIN.
    const sourceIp = event.requestContext?.identity?.sourceIp;
    const userAgent = event.headers?.['User-Agent'] || event.headers?.['user-agent'];

    if (!userId || !pin) {
      logAuth('REJECT_MISSING_FIELDS', { id: userId || '(none)', ip: sourceIp, ua: userAgent });
      return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'userId and pin required' }) };
    }

    // Blocked identifiers are refused before any lookup, so no PIN comparison
    // happens and no timing difference reveals whether the account exists. The
    // response is deliberately identical to a wrong-credentials response.
    if (isBlockedIdentifier(userId)) {
      logAuth('BLOCKED_IDENTIFIER', { id: userId, ip: sourceIp, ua: userAgent });
      return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    // Try direct GetCommand by userId first (O(1) instead of scan)
    let user: any = null;
    const directGet = await docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: `USER#${userId}`, SK: 'META' },
    }));
    if (directGet.Item && directGet.Item.isActive) {
      user = directGet.Item;
    }

    // Fallback: query by nameLower (only if direct lookup failed, still a
    // scan but unavoidable without a GSI). nameLower is maintained by the
    // admin user create/update paths; legacy records were backfilled via
    // scripts/backfill-user-namelower.mjs.
    if (!user) {
      const result = await docClient.send(new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: 'nameLower = :name AND isActive = :active',
        ExpressionAttributeValues: { ':name': userId, ':active': true },
      }));
      user = result.Items?.[0];
    }

    // Second gate: the resolved record itself. Catches a blocked account
    // reachable under an alias the submitted identifier didn't reveal.
    if (user && (isBlockedIdentifier(user.userId) || isBlockedIdentifier(user.nameLower) || isBlockedIdentifier(user.name))) {
      logAuth('BLOCKED_RESOLVED_USER', { id: userId, resolved: user.userId, ip: sourceIp, ua: userAgent });
      return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    if (!user || !comparePin(pin, user.pinHash)) {
      logAuth('FAIL', { id: userId, reason: user ? 'bad-pin' : 'no-such-user', ip: sourceIp, ua: userAgent });
      return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    const token = signToken({ userId: user.userId, name: user.name, role: user.role });
    await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { PK: user.PK, SK: user.SK },
      UpdateExpression: 'SET lastLoginAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));
    logAuth('SUCCESS', { id: user.userId, name: user.name, role: user.role, ip: sourceIp, ua: userAgent });
    return { statusCode: 200, headers: {}, body: JSON.stringify({ token, userId: user.userId, name: user.name, role: user.role, forceUpdatePin: !!user.forceUpdatePin, onboardingComplete: user.onboardingComplete || false, onboardingProgress: user.onboardingProgress || [] }) };
  }

  if (event.httpMethod === 'POST' && event.path === '/api/auth/update-pin') {
    const authHeader = event.headers?.Authorization || event.headers?.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    let payload;
    try { payload = verifyToken(token); } catch { return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Unauthorized' }) }; }
    const body = JSON.parse(event.body || '{}');
    if (!body.newPin || String(body.newPin).length < 6) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'newPin required (min 6 digits)' }) };
    await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { PK: `USER#${payload.userId}`, SK: 'META' },
      UpdateExpression: 'SET pinHash = :ph, forceUpdatePin = :f',
      ExpressionAttributeValues: { ':ph': hashPin(body.newPin), ':f': false },
    }));
    return { statusCode: 200, headers: {}, body: JSON.stringify({ success: true }) };
  }

  // ─── Passkeys (WebAuthn) ──────────────────────────────────────────────
  // Two enrolment routes behind a JWT (an admin adds a passkey to the account
  // they are already signed into with a PIN) and two public login routes. The
  // login pair is usernameless: the credential is discoverable, so the browser
  // picks it and the server resolves the owner from the credential ID.

  // POST /api/auth/passkey/register-options — requires an ADMIN JWT
  if (event.httpMethod === 'POST' && event.path === '/api/auth/passkey/register-options') {
    const authHeader = event.headers?.Authorization || event.headers?.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    let payload;
    try { payload = verifyToken(token); } catch { return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Unauthorized' }) }; }
    // Role comes off the token, so this costs no read. These routes live on the
    // PUBLIC /api/auth prefix, which means index.ts applies no role check to
    // them — the gate has to be here. A CASHIER must not enrol a credential:
    // both management routes (list, revoke) are ADMIN-only, so theirs would be
    // unlistable and unrevokable.
    if (payload.role !== 'ADMIN') {
      return { statusCode: 403, headers: {}, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    const got = await docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: `USER#${payload.userId}`, SK: 'META' },
    }));
    const user = got.Item;
    if (!user || !user.isActive) {
      return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    // A first-login account must change its seeded PIN before it can mint a
    // credential that skips the PIN entirely — otherwise a passkey is a
    // permanent bypass of the forced-PIN-change invariant, and the admin-issued
    // PIN stays live forever.
    if (user.forceUpdatePin) {
      return { statusCode: 403, headers: {}, body: JSON.stringify({ error: 'PIN change required before enrolling a passkey' }) };
    }

    const existing: StoredPasskeyCredential[] = Array.isArray(user.passkeyCredentials) ? user.passkeyCredentials : [];
    const options = await buildRegistrationOptions(
      { userId: payload.userId, name: user.name || payload.name },
      existing,
    );
    // The challenge lives server-side under a one-shot requestId, tagged with
    // the issuing user, so register-verify can prove the response it is handed
    // belongs to the same admin that asked for the challenge.
    //
    // Tagged with `payload.userId` — the SAME expression register-verify compares
    // against. Deriving it from the record instead (`user.userId`) gives the
    // binding two sources: a record whose `userId` attribute ever drifted from its
    // PK suffix would 403 on every enrolment, with nothing in the response saying
    // why.
    const requestId = uuid();
    await putChallenge(requestId, options.challenge, payload.userId);
    return { statusCode: 200, headers: {}, body: JSON.stringify({ requestId, options }) };
  }

  // POST /api/auth/passkey/register-verify — requires an ADMIN JWT
  if (event.httpMethod === 'POST' && event.path === '/api/auth/passkey/register-verify') {
    const authHeader = event.headers?.Authorization || event.headers?.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    let payload;
    try { payload = verifyToken(token); } catch { return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Unauthorized' }) }; }
    // Same gate as register-options, and for the same reason: /api/auth is the
    // public prefix, so index.ts checks no role here. Off the token, so it costs
    // no read and burns no challenge.
    if (payload.role !== 'ADMIN') {
      return { statusCode: 403, headers: {}, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    const sourceIp = event.requestContext?.identity?.sourceIp;
    const userAgent = event.headers?.['User-Agent'] || event.headers?.['user-agent'];
    // Parsed in a guard, not bare: `index.ts` has no top-level catch, so a throw
    // here fails the invocation and API Gateway answers a raw 502 with no CORS
    // headers — the browser sees an opaque network error instead of a 400.
    let body: any;
    try { body = event.body ? JSON.parse(event.body) : {}; } catch {
      return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    const requestId = body.requestId;
    const credential = body.credential;
    if (!requestId || !credential) {
      return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'requestId and credential required' }) };
    }

    const stored = await getChallenge(requestId);
    if (!stored) {
      logAuth('PASSKEY_REGISTER_FAIL', { id: payload.userId, method: 'passkey', reason: 'no-such-challenge', ip: sourceIp, ua: userAgent });
      return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'Challenge not found or expired' }) };
    }
    // Single use: burn the challenge FIRST, so every path below — expiry,
    // mismatch, a thrown verifier, a bad signature — leaves nothing to retry.
    // TTL deletion is not prompt, so the expiry is checked here and not
    // inferred from the record being gone.
    await deleteChallenge(requestId);
    if (isChallengeExpired(stored)) {
      logAuth('PASSKEY_REGISTER_FAIL', { id: payload.userId, method: 'passkey', reason: 'challenge-expired', ip: sourceIp, ua: userAgent });
      return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'Challenge not found or expired' }) };
    }
    // A challenge issued to one admin must not enrol a passkey on another's
    // account, even with a valid token for that other account.
    if (stored.userId !== payload.userId) {
      logAuth('PASSKEY_REGISTER_FAIL', { id: payload.userId, method: 'passkey', reason: 'challenge-user-mismatch', ip: sourceIp, ua: userAgent });
      return { statusCode: 403, headers: {}, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    // Re-read the account HERE, not only at register-options: the token is valid
    // for 8h, so the account can have been deactivated or deleted in between.
    // Without this a passkey enrolled on a stale token would go on to RESURRECT
    // `USER#{id}` as a partial record (UpdateCommand creates the item), which
    // then looks like a live account to every reader of this table.
    const owner = await docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: `USER#${payload.userId}`, SK: 'META' },
    }));
    const ownerRecord = owner.Item;
    if (!ownerRecord || !ownerRecord.isActive) {
      logAuth('PASSKEY_REGISTER_FAIL', { id: payload.userId, method: 'passkey', reason: 'no-such-user-or-inactive', ip: sourceIp, ua: userAgent });
      return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    if (ownerRecord.forceUpdatePin) {
      return { statusCode: 403, headers: {}, body: JSON.stringify({ error: 'PIN change required before enrolling a passkey' }) };
    }

    const ownList: StoredPasskeyCredential[] = Array.isArray(ownerRecord.passkeyCredentials) ? ownerRecord.passkeyCredentials : [];
    // `list_append` neither dedupes nor caps. Unbounded, the user item grows
    // toward the 400KB item limit and then EVERY later write to it fails —
    // including `lastLoginAt` and the PIN change, i.e. the account bricks itself.
    // 10 is well past any real need (phone, laptop, tablet, a spare key) and far
    // short of the limit.
    if (ownList.length >= MAX_PASSKEYS_PER_USER) {
      logAuth('PASSKEY_REGISTER_FAIL', { id: payload.userId, method: 'passkey', reason: 'limit-reached', ip: sourceIp, ua: userAgent });
      return { statusCode: 409, headers: {}, body: JSON.stringify({ error: 'Passkey limit reached' }) };
    }

    let verification;
    try {
      verification = await verifyRegistration(credential, stored.challenge);
    } catch (err: unknown) {
      // The library's own message, which is the ONLY signal for the single most
      // likely misconfiguration of this whole feature — an RP_ID / ORIGIN
      // mismatch, whose text names the expected and received values. A bare
      // `verify-threw` is undiagnosable from CloudWatch. Message only, no stack;
      // the response body stays as minimal as it was.
      logAuth('PASSKEY_REGISTER_FAIL', {
        id: payload.userId, method: 'passkey', reason: 'verify-threw',
        detail: err instanceof Error ? err.message : String(err),
        rpID: RP_ID, origin: ORIGIN, ip: sourceIp, ua: userAgent,
      });
      return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'Registration failed' }) };
    }
    if (!verification.verified || !verification.registrationInfo) {
      logAuth('PASSKEY_REGISTER_FAIL', { id: payload.userId, method: 'passkey', reason: 'not-verified', ip: sourceIp, ua: userAgent });
      return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'Registration failed' }) };
    }

    const verified = verification.registrationInfo.credential;
    // Re-enrolling the same authenticator must not append a second entry.
    // `excludeCredentials` asks the browser to prevent this, but it is a request,
    // not a guarantee — and a hand-rolled client ignores it entirely. Duplicates
    // are worse than untidy: the login path takes the FIRST match by
    // `findIndex`, so the counter would advance on one copy while the other stays
    // stale, and DELETE would only ever remove one of them.
    if (ownList.some((c) => c.credentialId === verified.id)) {
      logAuth('PASSKEY_REGISTER_FAIL', { id: payload.userId, method: 'passkey', reason: 'already-enrolled', credentialId: verified.id, ip: sourceIp, ua: userAgent });
      return { statusCode: 409, headers: {}, body: JSON.stringify({ error: 'Passkey already enrolled' }) };
    }

    const rawLabel = typeof body.deviceLabel === 'string' ? body.deviceLabel.trim() : '';
    const entry: StoredPasskeyCredential = {
      credentialId: verified.id,
      // base64url text, never the raw Uint8Array — see lib/webauthn.ts.
      publicKey: toBase64Url(verified.publicKey),
      counter: verified.counter || 0,
      transports: verified.transports || [],
      deviceLabel: rawLabel ? rawLabel.slice(0, 60) : 'Passkey',
      createdAt: new Date().toISOString(),
    };

    // Ordering is deliberate: STAKE THE REVERSE RECORD FIRST, then append to the
    // user's list. There is no transaction across the two writes, so one of the
    // two orders has to be chosen for its failure mode. This way a rejected claim
    // leaves nothing behind; the other way round would leave a credential in the
    // user's list that login can never resolve to an owner.
    //
    // The condition blocks a second account claiming a credentialId that already
    // maps to someone else — which would otherwise silently repoint the login
    // path at the squatter. `userId = :uid` is allowed through so the legitimate
    // owner can retry after a partial failure, instead of being permanently
    // locked out of that one credentialId by their own half-finished write.
    try {
      await docClient.send(new PutCommand({
        TableName: USERS_TABLE,
        Item: { PK: `PASSKEY_CRED#${entry.credentialId}`, SK: 'META', userId: payload.userId },
        ConditionExpression: 'attribute_not_exists(PK) OR userId = :uid',
        ExpressionAttributeValues: { ':uid': payload.userId },
      }));
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      logAuth('PASSKEY_REGISTER_FAIL', { id: payload.userId, method: 'passkey', reason: 'credential-owned-by-other-user', credentialId: entry.credentialId, ip: sourceIp, ua: userAgent });
      return { statusCode: 409, headers: {}, body: JSON.stringify({ error: 'Credential already registered' }) };
    }

    // `attribute_exists(PK)` because UpdateCommand is an upsert: without it, a
    // user deleted between the Get above and this write is recreated here as a
    // record holding nothing but a passkey list — no role, no isActive, no PIN —
    // which readers of this table would treat as an account.
    try {
      await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { PK: `USER#${payload.userId}`, SK: 'META' },
        UpdateExpression: 'SET passkeyCredentials = list_append(if_not_exists(passkeyCredentials, :empty), :new)',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':empty': [], ':new': [entry] },
      }));
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      logAuth('PASSKEY_REGISTER_FAIL', { id: payload.userId, method: 'passkey', reason: 'user-vanished', ip: sourceIp, ua: userAgent });
      return { statusCode: 409, headers: {}, body: JSON.stringify({ error: 'Conflict' }) };
    }

    logAuth('PASSKEY_REGISTERED', { id: payload.userId, method: 'passkey', credentialId: entry.credentialId, deviceLabel: entry.deviceLabel, ip: sourceIp, ua: userAgent });
    return { statusCode: 201, headers: {}, body: JSON.stringify({ registered: true, credentialId: entry.credentialId, deviceLabel: entry.deviceLabel }) };
  }

  // POST /api/auth/passkey/login-options — public
  if (event.httpMethod === 'POST' && event.path === '/api/auth/passkey/login-options') {
    const options = await buildAuthenticationOptions();
    const requestId = uuid();
    // userId null: nobody has identified themselves yet. login-verify learns who
    // it is from the credential the browser returns.
    await putChallenge(requestId, options.challenge, null);
    return { statusCode: 200, headers: {}, body: JSON.stringify({ requestId, options }) };
  }

  // POST /api/auth/passkey/login-verify — public
  if (event.httpMethod === 'POST' && event.path === '/api/auth/passkey/login-verify') {
    const sourceIp = event.requestContext?.identity?.sourceIp;
    const userAgent = event.headers?.['User-Agent'] || event.headers?.['user-agent'];

    // Every failure is the SAME 401 with the SAME message as a wrong PIN — no
    // user enumeration and nothing that tells an attacker which step failed.
    // The real reason goes to CloudWatch only.
    const fail = (reason: string, id?: string): APIGatewayProxyResult => {
      logAuth('FAIL', { id: id || '(passkey)', method: 'passkey', reason, ip: sourceIp, ua: userAgent });
      return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Invalid credentials' }) };
    };

    // Public route: an unparseable body must not fail the invocation (raw 502,
    // no CORS headers) — same guard as register-verify above.
    let body: any;
    try { body = event.body ? JSON.parse(event.body) : {}; } catch {
      return fail('invalid-json-body');
    }
    const requestId = body.requestId;
    const credential = body.credential;
    if (!requestId || !credential) return fail('missing-fields');

    const stored = await getChallenge(requestId);
    if (!stored) return fail('no-such-challenge');
    // Single use, burned before any verification — same reasoning as
    // register-verify above.
    await deleteChallenge(requestId);
    if (isChallengeExpired(stored)) return fail('challenge-expired');

    const credentialId = typeof credential.id === 'string' && credential.id
      ? credential.id
      : (typeof credential.rawId === 'string' ? credential.rawId : '');
    if (!credentialId) return fail('no-credential-id');

    const lookup = await docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: `PASSKEY_CRED#${credentialId}`, SK: 'META' },
    }));
    const ownerId = typeof lookup.Item?.userId === 'string' ? lookup.Item.userId : '';
    if (!ownerId) return fail('unknown-credential');

    const got = await docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: `USER#${ownerId}`, SK: 'META' },
    }));
    const user = got.Item;
    if (!user || !user.isActive) return fail('no-such-user', ownerId);

    // Same gate the PIN path applies to the RESOLVED record: a permanently
    // barred identifier must not have a second door. Without this, a passkey
    // enrolled before the block would outlive it.
    if (isBlockedIdentifier(user.userId) || isBlockedIdentifier(user.nameLower) || isBlockedIdentifier(user.name)) {
      logAuth('BLOCKED_RESOLVED_USER', { id: ownerId, resolved: user.userId, method: 'passkey', ip: sourceIp, ua: userAgent });
      return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    const list: StoredPasskeyCredential[] = Array.isArray(user.passkeyCredentials) ? user.passkeyCredentials : [];
    const index = list.findIndex(c => c?.credentialId === credentialId);
    if (index === -1) return fail('credential-not-on-user', ownerId);
    const entry = list[index];
    if (typeof entry.publicKey !== 'string' || !entry.publicKey) return fail('credential-missing-public-key', ownerId);

    let verification;
    try {
      verification = await verifyAuthentication(credential, stored.challenge, entry);
    } catch (err: unknown) {
      // Message included for the same reason as register-verify: an RP_ID or
      // ORIGIN mismatch is the likeliest cause and the library names the
      // mismatched values. Log only — the response stays `Invalid credentials`.
      logAuth('PASSKEY_LOGIN_VERIFY_ERROR', {
        id: ownerId, method: 'passkey',
        detail: err instanceof Error ? err.message : String(err),
        rpID: RP_ID, origin: ORIGIN, ip: sourceIp, ua: userAgent,
      });
      return fail('verify-threw', ownerId);
    }
    if (!verification.verified) return fail('bad-signature', ownerId);

    // The signature counter IS the replay protection, so it has to persist.
    // `counter` is a DynamoDB reserved word, hence the #c alias. Writing the one
    // list element rather than the whole list means a concurrent enrolment on
    // another device is not clobbered.
    //
    // The condition re-checks that element's credentialId, because `index` came
    // from a Get that has since gone stale: a DELETE of an earlier passkey shifts
    // every later element down by one, so a bare positional write could stamp
    // this counter onto a DIFFERENT credential — advancing a counter that no
    // signature justified, and leaving the real one behind (a replay window).
    // On conflict the login still succeeds; only the counter write is dropped.
    try {
      await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { PK: `USER#${ownerId}`, SK: 'META' },
        UpdateExpression: `SET passkeyCredentials[${index}].#c = :c, lastLoginAt = :now`,
        ConditionExpression: `passkeyCredentials[${index}].credentialId = :cid`,
        ExpressionAttributeNames: { '#c': 'counter' },
        ExpressionAttributeValues: { ':c': verification.authenticationInfo.newCounter, ':now': new Date().toISOString(), ':cid': credentialId },
      }));
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      logAuth('PASSKEY_COUNTER_WRITE_SKIPPED', { id: ownerId, method: 'passkey', credentialId, ip: sourceIp, ua: userAgent });
    }

    const token = signToken({ userId: user.userId, name: user.name, role: user.role });
    logAuth('SUCCESS', { id: user.userId, name: user.name, role: user.role, ip: sourceIp, ua: userAgent, method: 'passkey' });
    // Byte-identical to POST /api/auth/login: the admin page reuses its
    // post-login handler unchanged, so a missing field is a bug here.
    return { statusCode: 200, headers: {}, body: JSON.stringify({ token, userId: user.userId, name: user.name, role: user.role, forceUpdatePin: !!user.forceUpdatePin, onboardingComplete: user.onboardingComplete || false, onboardingProgress: user.onboardingProgress || [] }) };
  }

  return { statusCode: 404, headers: {}, body: JSON.stringify({ error: 'Not found' }) };
}
