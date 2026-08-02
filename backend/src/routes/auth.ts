import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { docClient, USERS_TABLE, ScanCommand, UpdateCommand, GetCommand, QueryCommand } from '../lib/db';
import { comparePin, signToken, hashPin, verifyToken } from '../lib/auth';
import { logAuth } from '../lib/audit';

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

  return { statusCode: 404, headers: {}, body: JSON.stringify({ error: 'Not found' }) };
}
