/**
 * Passkey (WebAuthn) admin login — `src/lib/webauthn.ts`, the four
 * `/api/auth/passkey/*` routes in `src/routes/auth.ts`, and the two
 * `/api/admin/passkeys` branches in `src/routes/admin.ts`.
 *
 * ── Fully offline, and verified rather than assumed ────────────────────
 * `../src/lib/db` is mocked, and it is the ONLY DynamoDB client in the backend,
 * so nothing is read or written for real. `@simplewebauthn/server` is mocked too,
 * so no cryptography runs and no verification outcome depends on a real
 * authenticator. There is no network call, no credential is read from the
 * environment, and no production record is created — so this suite needs no
 * `ZZTEST_` marker (the prefix rule covers suites that create real records).
 * Same category as `item-notes.test.ts`.
 *
 * ── Test teeth ────────────────────────────────────────────────────────
 * Every assertion is on what the code PRODUCED: the `Item` of the `PutCommand` it
 * issued, the `UpdateExpression` / `ExpressionAttributeValues` it built, the
 * response body it serialised. Never on a fixture this file constructed.
 *
 * Two guards here are deliberately reached by a fixture that would otherwise
 * pass for the wrong reason:
 *   - the DELETE ownership check is tested with a caller who genuinely HAS other
 *     passkeys, so the 404 is caused by the ownership check and not by an empty
 *     list;
 *   - `credential-not-on-user` on login is likewise tested against a user whose
 *     `passkeyCredentials` is non-empty.
 *
 * Requests go through the real top-level router (`src/index.ts`) so path dispatch
 * is exercised by the same tests that check behaviour — a handler that stopped
 * being reachable would fail every case, not just the dispatch ones.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { signToken, hashPin } from '../src/lib/auth';

/** Ordered log of every DynamoDB command and every verifier call. */
const callLog: string[] = [];

const mockDbSend = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  INGREDIENTS_TABLE: 'test-ingredients',
  USERS_TABLE: 'test-users',
  SETTINGS_TABLE: 'test-settings',
  CUSTOMERS_TABLE: 'test-customers',
  VOUCHERS_TABLE: 'test-vouchers',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
  DeleteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Delete' })),
}));

const mockGenerateRegistrationOptions = jest.fn();
const mockVerifyRegistrationResponse = jest.fn();
const mockGenerateAuthenticationOptions = jest.fn();
const mockVerifyAuthenticationResponse = jest.fn();

// The library is mocked so the tests own the verification outcome. `lib/webauthn`
// is the only importer of it (deliberately — see the header comment there), so
// this single mock covers every route.
jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mockGenerateRegistrationOptions,
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
  generateAuthenticationOptions: mockGenerateAuthenticationOptions,
  verifyAuthenticationResponse: mockVerifyAuthenticationResponse,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../src/index');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleAdmin } = require('../src/routes/admin');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  RP_ID, CHALLENGE_TTL_SECONDS, nowEpochSeconds,
} = require('../src/lib/webauthn');

// ─── Fixtures ────────────────────────────────────────────────────────

const MARY = 'sister-mary';
const JOSEPH = 'brother-joseph';

/** Contains `-` and `_`: base64url, so path parsing must survive both. */
const CRED_B64URL = 'q3n-_Zx9AbC-dEf_gh';

const REG_CHALLENGE = 'REG-CHALLENGE-0123456789';
const LOGIN_CHALLENGE = 'LOGIN-CHALLENGE-abcdefgh';

/** The bytes the library "returns" as the COSE public key. */
const PUBKEY_BYTES = new Uint8Array([0x01, 0x02, 0x03, 0xfa, 0xfb, 0xfc, 0xff, 0x00]);

const NEW_COUNTER = 4242;

function marySettings(overrides: Record<string, any> = {}) {
  return {
    PK: `USER#${MARY}`, SK: 'META', userId: MARY, name: 'Sister Mary',
    nameLower: 'sister mary', role: 'ADMIN', isActive: true,
    forceUpdatePin: false, onboardingComplete: true, onboardingProgress: ['welcome'],
    ...overrides,
  };
}

/** One stored passkey, in the shape `register-verify` writes. */
function storedCred(credentialId: string, overrides: Record<string, any> = {}) {
  return {
    credentialId,
    publicKey: 'UEFTU0tFWS1QVUJMSUMtS0VZ',
    counter: 7,
    transports: ['internal'],
    deviceLabel: `Label for ${credentialId}`,
    createdAt: '2026-09-01T02:00:00.000Z',
    ...overrides,
  };
}

interface World {
  /** keyed by userId */
  users?: Record<string, any>;
  /** credentialId -> owning userId (the `PASSKEY_CRED#` reverse lookup) */
  creds?: Record<string, string>;
  /** requestId -> stored challenge attributes */
  challenges?: Record<string, any>;
  /** thrown by the next UpdateCommand, to drive the 409 path */
  updateThrows?: Error;
  /** Raw rows on USERS_TABLE, answered to a Scan — see `applyScanFilter`. */
  userTableRows?: any[];
  /** Thrown by a Delete of a `PASSKEY_CRED#` record, for the rethrow path. */
  credDeleteThrows?: Error;
}

/** What DynamoDB raises when a ConditionExpression is not satisfied. */
function conditionalCheckFailed() {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

/**
 * Evaluate a `FilterExpression` the way DynamoDB would, so a Scan test is
 * BEHAVIOURAL: drop the filter from the source and the mock hands every staged
 * row back, exactly as the real service would.
 *
 * Only the one form the code uses is understood; anything else throws rather
 * than silently passing every row, so a rewritten filter cannot pass by default.
 */
function applyScanFilter(rows: any[], cmd: any): any[] {
  const expr: string | undefined = cmd.FilterExpression;
  if (expr === undefined) return rows; // unfiltered Scan: the whole table
  const m = /^begins_with\((\w+), (:\w+)\)$/.exec(expr);
  if (!m) throw new Error(`stage(): unsupported FilterExpression ${JSON.stringify(expr)}`);
  const [, attr, ref] = m;
  const prefix = cmd.ExpressionAttributeValues?.[ref];
  if (typeof prefix !== 'string') {
    throw new Error(`stage(): FilterExpression references ${ref}, which is not bound to a string`);
  }
  return rows.filter((r) => String(r?.[attr] ?? '').startsWith(prefix));
}

/**
 * Answer every read from a described world, keyed on the actual `TableName` and
 * `Key.PK` the handler asked for.
 *
 * A dispatcher rather than a `mockResolvedValueOnce` queue on purpose: login-verify
 * issues THREE distinct Gets (challenge, reverse lookup, user) and a queue would
 * let a fixture silently answer the wrong one — the multi-query trap named under
 * **Test teeth** in the `invariants` skill.
 */
function stage(world: World = {}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    const pk = String(cmd.Key?.PK ?? cmd.Item?.PK ?? '');
    callLog.push(`${cmd.__cmd} ${cmd.TableName} ${pk}`);
    if (cmd.__cmd === 'Update' && world.updateThrows) throw world.updateThrows;

    // The two conditions on the `PASSKEY_CRED#` reverse record are EVALUATED, not
    // merely recorded: removing either from the source makes the corresponding
    // write succeed here, which is what gives the squat and cross-user-delete
    // tests their teeth.
    if (cmd.TableName === 'test-users' && pk.startsWith('PASSKEY_CRED#')) {
      const owner = world.creds?.[pk.slice('PASSKEY_CRED#'.length)];
      if (cmd.__cmd === 'Put' && cmd.ConditionExpression !== undefined) {
        // Both forms are understood, so dropping the `OR userId = :uid` half is a
        // BEHAVIOURAL change here (the owner's own retry starts failing) rather
        // than an unsupported-expression error.
        const uid = cmd.ExpressionAttributeValues?.[':uid'];
        if (cmd.ConditionExpression === 'attribute_not_exists(PK)') {
          if (owner !== undefined) throw conditionalCheckFailed();
          return {};
        }
        if (cmd.ConditionExpression !== 'attribute_not_exists(PK) OR userId = :uid') {
          throw new Error(`stage(): unsupported Put condition ${JSON.stringify(cmd.ConditionExpression)}`);
        }
        if (owner !== undefined && owner !== uid) throw conditionalCheckFailed();
        return {};
      }
      if (cmd.__cmd === 'Delete' && world.credDeleteThrows) throw world.credDeleteThrows;
      if (cmd.__cmd === 'Delete' && cmd.ConditionExpression !== undefined) {
        if (cmd.ConditionExpression !== 'userId = :caller') {
          throw new Error(`stage(): unsupported Delete condition ${JSON.stringify(cmd.ConditionExpression)}`);
        }
        // `userId = :caller` on an absent item is also a failed condition.
        if (owner !== cmd.ExpressionAttributeValues?.[':caller']) throw conditionalCheckFailed();
        return {};
      }
    }

    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-users') {
      return { Items: applyScanFilter(world.userTableRows ?? [], cmd) };
    }
    if (cmd.__cmd !== 'Get') return {};
    if (cmd.TableName === 'test-settings' && pk.startsWith('WEBAUTHN_CHALLENGE#')) {
      const rec = world.challenges?.[pk.slice('WEBAUTHN_CHALLENGE#'.length)];
      return rec ? { Item: { PK: pk, SK: 'META', ...rec } } : {};
    }
    if (cmd.TableName === 'test-users' && pk.startsWith('PASSKEY_CRED#')) {
      const owner = world.creds?.[pk.slice('PASSKEY_CRED#'.length)];
      return owner ? { Item: { PK: pk, SK: 'META', userId: owner } } : {};
    }
    if (cmd.TableName === 'test-users' && pk.startsWith('USER#')) {
      const rec = world.users?.[pk.slice('USER#'.length)];
      return rec ? { Item: rec } : {};
    }
    return {};
  });
}

// ─── What the code under test actually sent ──────────────────────────

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function of(kind: string, table?: string) {
  return cmds().filter((c) => c.__cmd === kind && (!table || c.TableName === table));
}
/** Every mutating command, whatever the table. */
function allWrites() {
  return cmds().filter((c) => c.__cmd === 'Put' || c.__cmd === 'Update' || c.__cmd === 'Delete');
}
function userWrites() { return allWrites().filter((c) => c.TableName === 'test-users'); }
/** The `WEBAUTHN_CHALLENGE#` items that were written. */
function challengePuts() {
  return of('Put', 'test-settings').filter((c) => String(c.Item?.PK).startsWith('WEBAUTHN_CHALLENGE#'));
}
function challengeDeletes() {
  return of('Delete', 'test-settings').filter((c) => String(c.Key?.PK).startsWith('WEBAUTHN_CHALLENGE#'));
}
function credPuts() {
  return of('Put', 'test-users').filter((c) => String(c.Item?.PK).startsWith('PASSKEY_CRED#'));
}
function credDeletes() {
  return of('Delete', 'test-users').filter((c) => String(c.Key?.PK).startsWith('PASSKEY_CRED#'));
}
function logIndexOf(fragment: string) { return callLog.findIndex((l) => l.includes(fragment)); }

// ─── Events ──────────────────────────────────────────────────────────

function makeEvent(o: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/',
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: { identity: { sourceIp: '203.0.113.9' } } as any,
    resource: '',
    body: null,
    isBase64Encoded: false,
    ...o,
  } as APIGatewayProxyEvent;
}

function bearer(userId: string, role = 'ADMIN', name = 'Sister Mary') {
  return { Authorization: `Bearer ${signToken({ userId, name, role })}` };
}

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return handler(makeEvent({
    httpMethod: 'POST', path, headers,
    body: body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
}

const future = () => nowEpochSeconds() + CHALLENGE_TTL_SECONDS;
const past = () => nowEpochSeconds() - 5;

let logSpy: jest.SpyInstance;

beforeAll(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterAll(() => { logSpy.mockRestore(); });

/** The `[AUTH] …` lines `logAuth` emitted, one string per call. */
function authLogs(): string[] {
  return logSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith('[AUTH]'));
}

beforeEach(() => {
  callLog.length = 0;
  logSpy.mockClear();
  stage();
  mockGenerateRegistrationOptions.mockReset();
  mockVerifyRegistrationResponse.mockReset();
  mockGenerateAuthenticationOptions.mockReset();
  mockVerifyAuthenticationResponse.mockReset();

  mockGenerateRegistrationOptions.mockImplementation(async () => ({
    challenge: REG_CHALLENGE,
    rp: { id: RP_ID, name: 'RLC Café POS Admin' },
    user: { id: 'dXNlcg', name: MARY, displayName: 'Sister Mary' },
    pubKeyCredParams: [],
  }));
  mockGenerateAuthenticationOptions.mockImplementation(async () => ({
    challenge: LOGIN_CHALLENGE,
    rpId: RP_ID,
    allowCredentials: [],
    userVerification: 'preferred',
  }));
  mockVerifyRegistrationResponse.mockImplementation(async () => {
    callLog.push('verifyRegistrationResponse');
    return {
      verified: true,
      registrationInfo: {
        credential: {
          id: CRED_B64URL,
          publicKey: PUBKEY_BYTES,
          counter: 0,
          transports: ['internal', 'hybrid'],
        },
      },
    };
  });
  mockVerifyAuthenticationResponse.mockImplementation(async () => {
    callLog.push('verifyAuthenticationResponse');
    return { verified: true, authenticationInfo: { newCounter: NEW_COUNTER } };
  });
});

// ─── 1. Challenge issue ──────────────────────────────────────────────

describe('challenge issue — the WEBAUTHN_CHALLENGE# record', () => {
  it('login-options stores the challenge it issued with userId null', async () => {
    const before = nowEpochSeconds();
    const res = await post('/api/auth/passkey/login-options');
    const after = nowEpochSeconds();
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(body.options.challenge).toBe(LOGIN_CHALLENGE);

    expect(challengePuts()).toHaveLength(1);
    const item = challengePuts()[0].Item;
    // PK is derived from the requestId the response handed the browser — the two
    // must agree or login-verify can never find the record.
    expect(item.PK).toBe(`WEBAUTHN_CHALLENGE#${body.requestId}`);
    expect(item.SK).toBe('META');
    expect(challengePuts()[0].TableName).toBe('test-settings');
    // The challenge stored is the one that went out, not a fresh one.
    expect(item.challenge).toBe(body.options.challenge);
    // Nobody has identified themselves yet on the usernameless login path.
    expect(item.userId).toBeNull();

    // Epoch SECONDS, not milliseconds. A millisecond value is ~1.7e12 and would
    // put the TTL 55,000 years out, i.e. never expire.
    expect(Number.isInteger(item.expiresAt)).toBe(true);
    expect(item.expiresAt).toBeLessThan(1e11);
    expect(item.expiresAt).toBeGreaterThanOrEqual(before + CHALLENGE_TTL_SECONDS);
    expect(item.expiresAt).toBeLessThanOrEqual(after + CHALLENGE_TTL_SECONDS);
    expect(CHALLENGE_TTL_SECONDS).toBe(300);
  });

  it('register-options stores the challenge against the JWT userId', async () => {
    stage({ users: { [MARY]: marySettings() } });
    const before = nowEpochSeconds();
    const res = await post('/api/auth/passkey/register-options', {}, bearer(MARY));
    const after = nowEpochSeconds();
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.options.challenge).toBe(REG_CHALLENGE);

    expect(challengePuts()).toHaveLength(1);
    const item = challengePuts()[0].Item;
    expect(item.PK).toBe(`WEBAUTHN_CHALLENGE#${body.requestId}`);
    expect(item.SK).toBe('META');
    expect(item.challenge).toBe(body.options.challenge);
    // Tagged with the issuing admin, which is what lets register-verify refuse a
    // response presented under a different account's token.
    expect(item.userId).toBe(MARY);

    expect(Number.isInteger(item.expiresAt)).toBe(true);
    expect(item.expiresAt).toBeLessThan(1e11);
    expect(item.expiresAt).toBeGreaterThanOrEqual(before + CHALLENGE_TTL_SECONDS);
    expect(item.expiresAt).toBeLessThanOrEqual(after + CHALLENGE_TTL_SECONDS);
  });

  it('register-options excludes the passkeys already enrolled on the account', async () => {
    stage({
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [storedCred('cred-laptop'), storedCred(CRED_B64URL)],
        }),
      },
    });
    const res = await post('/api/auth/passkey/register-options', {}, bearer(MARY));
    expect(res.statusCode).toBe(200);

    const args = mockGenerateRegistrationOptions.mock.calls[0][0];
    expect(args.rpID).toBe(RP_ID);
    expect(args.excludeCredentials.map((c: any) => c.id)).toEqual(['cred-laptop', CRED_B64URL]);
    // Discoverable credential, or the usernameless login page has nothing to ask for.
    expect(args.authenticatorSelection.residentKey).toBe('required');
  });

  it('register-options refuses a caller whose user record is INACTIVE, writing no challenge', async () => {
    // The record EXISTS, so the 401 is caused by the isActive check and not by absence.
    stage({ users: { [MARY]: marySettings({ isActive: false }) } });
    const res = await post('/api/auth/passkey/register-options', {}, bearer(MARY));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(challengePuts()).toHaveLength(0);
    expect(mockGenerateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('register-options refuses a token for a user that no longer exists', async () => {
    stage({ users: {} });
    const res = await post('/api/auth/passkey/register-options', {}, bearer(MARY));
    expect(res.statusCode).toBe(401);
    expect(challengePuts()).toHaveLength(0);
  });
});

// ─── 2. Challenge not found / expired ────────────────────────────────

describe('challenge not found or expired', () => {
  const REG_BODY = { requestId: 'r-missing', credential: { id: CRED_B64URL } };

  it('register-verify with NO challenge record returns 400 and writes no credential', async () => {
    stage({ challenges: {} });
    const res = await post('/api/auth/passkey/register-verify', REG_BODY, bearer(MARY));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Challenge not found or expired' });
    expect(userWrites()).toHaveLength(0);
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('register-verify with an EXPIRED challenge returns the same 400 and writes no credential', async () => {
    // The record is present and well-formed; only expiresAt is in the past, so the
    // 400 is caused by the expiry check.
    stage({ challenges: { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: past() } } });
    const res = await post(
      '/api/auth/passkey/register-verify',
      { requestId: 'r1', credential: { id: CRED_B64URL } },
      bearer(MARY),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Challenge not found or expired' });
    expect(userWrites()).toHaveLength(0);
    // TTL deletion lags, so expiry is decided on the value and not on absence.
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('login-verify with NO challenge record returns the standard 401 and writes nothing', async () => {
    stage({ challenges: {} });
    const res = await post('/api/auth/passkey/login-verify', REG_BODY);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid credentials' });
    expect(userWrites()).toHaveLength(0);
    expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('login-verify with an EXPIRED challenge returns the standard 401 and writes nothing', async () => {
    stage({
      challenges: { r1: { challenge: LOGIN_CHALLENGE, userId: null, expiresAt: past() } },
      creds: { [CRED_B64URL]: MARY },
      users: { [MARY]: marySettings({ passkeyCredentials: [storedCred(CRED_B64URL)] }) },
    });
    const res = await post('/api/auth/passkey/login-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid credentials' });
    expect(userWrites()).toHaveLength(0);
    expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('register-verify rejects a missing requestId or credential before reading anything', async () => {
    stage();
    const res = await post('/api/auth/passkey/register-verify', { requestId: 'r1' }, bearer(MARY));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'requestId and credential required' });
    expect(of('Get', 'test-settings')).toHaveLength(0);
    expect(allWrites()).toHaveLength(0);
  });

  it('register-verify answers 400 rather than throwing on an unparseable body', async () => {
    // A throw here fails the invocation and API Gateway answers a raw 502 with no
    // CORS headers, which the browser cannot distinguish from being offline.
    stage();
    const res = await post('/api/auth/passkey/register-verify', '{not json', bearer(MARY));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON body' });
  });

  it('login-verify answers 401 rather than throwing on an unparseable body', async () => {
    stage();
    const res = await post('/api/auth/passkey/login-verify', '{not json');
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid credentials' });
    expect(allWrites()).toHaveLength(0);
  });
});

// ─── 3. register-verify success ──────────────────────────────────────

describe('register-verify success', () => {
  function validChallenge() {
    return {
      challenges: { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } },
      // register-verify re-reads the account after the challenge checks (the
      // token is valid for 8h, so the account can have been deactivated in
      // between), so the record has to exist for the success path.
      users: { [MARY]: marySettings() },
    };
  }

  async function enrol(body: Record<string, any> = {}) {
    stage(validChallenge());
    return post(
      '/api/auth/passkey/register-verify',
      { requestId: 'r1', credential: { id: CRED_B64URL, response: {} }, ...body },
      bearer(MARY),
    );
  }

  it('returns 201 with the credential id and the resolved device label', async () => {
    const res = await enrol({ deviceLabel: "  Mary's iPhone  " });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      registered: true,
      credentialId: CRED_B64URL,
      deviceLabel: "Mary's iPhone",
    });
  });

  it('appends with list_append(if_not_exists(...)) so an existing list is not clobbered', async () => {
    const res = await enrol();
    expect(res.statusCode).toBe(201);

    const updates = of('Update', 'test-users');
    expect(updates).toHaveLength(1);
    const expr = updates[0].UpdateExpression;
    expect(expr).toContain('list_append');
    expect(expr).toContain('if_not_exists(passkeyCredentials, :empty)');
    expect(updates[0].ExpressionAttributeValues[':empty']).toEqual([]);
    // Written against the JWT's own account.
    expect(updates[0].Key).toEqual({ PK: `USER#${MARY}`, SK: 'META' });
  });

  it('stores publicKey as a base64url STRING, not a Uint8Array/Binary', async () => {
    const res = await enrol();
    expect(res.statusCode).toBe(201);

    const appended = of('Update', 'test-users')[0].ExpressionAttributeValues[':new'];
    expect(Array.isArray(appended)).toBe(true);
    expect(appended).toHaveLength(1);
    const entry = appended[0];

    // The DocumentClient would marshal a Uint8Array as a DynamoDB Binary
    // attribute, whose round-trip type depends on the SDK version.
    expect(typeof entry.publicKey).toBe('string');
    expect(entry.publicKey).not.toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(entry.publicKey)).toBe(false);
    // Decoding the stored text gives back exactly the bytes the library handed over.
    expect(new Uint8Array(Buffer.from(entry.publicKey, 'base64url'))).toEqual(PUBKEY_BYTES);
    // base64url alphabet only — no '+', '/' or '=' padding.
    expect(entry.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(entry.credentialId).toBe(CRED_B64URL);
    expect(entry.counter).toBe(0);
    expect(entry.transports).toEqual(['internal', 'hybrid']);
    expect(typeof entry.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
  });

  it('writes the PASSKEY_CRED# reverse lookup pointing at the owner', async () => {
    const res = await enrol();
    expect(res.statusCode).toBe(201);

    expect(credPuts()).toHaveLength(1);
    expect(credPuts()[0].TableName).toBe('test-users');
    expect(credPuts()[0].Item).toEqual({
      PK: `PASSKEY_CRED#${CRED_B64URL}`, SK: 'META', userId: MARY,
    });
  });

  it('defaults a blank device label to "Passkey" and caps a long one at 60 chars', async () => {
    const blank = await enrol({ deviceLabel: '   ' });
    expect(JSON.parse(blank.body).deviceLabel).toBe('Passkey');
    expect(of('Update', 'test-users')[0].ExpressionAttributeValues[':new'][0].deviceLabel)
      .toBe('Passkey');

    const long = await enrol({ deviceLabel: 'x'.repeat(90) });
    const stored = of('Update', 'test-users')[0].ExpressionAttributeValues[':new'][0].deviceLabel;
    expect(stored).toBe('x'.repeat(60));
    expect(JSON.parse(long.body).deviceLabel).toBe(stored);
  });

  it('verifies against the STORED challenge, not one taken from the request body', async () => {
    stage(validChallenge());
    const res = await post('/api/auth/passkey/register-verify', {
      requestId: 'r1',
      credential: { id: CRED_B64URL },
      challenge: 'ATTACKER-SUPPLIED',
    }, bearer(MARY));
    expect(res.statusCode).toBe(201);
    expect(mockVerifyRegistrationResponse.mock.calls[0][0].expectedChallenge).toBe(REG_CHALLENGE);
    expect(mockVerifyRegistrationResponse.mock.calls[0][0].expectedRPID).toBe(RP_ID);
  });

  it('writes nothing when the library reports the response unverified', async () => {
    mockVerifyRegistrationResponse.mockImplementation(async () => {
      callLog.push('verifyRegistrationResponse');
      return { verified: false };
    });
    const res = await enrol();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Registration failed' });
    expect(userWrites()).toHaveLength(0);
  });

  it('writes nothing when the verifier throws', async () => {
    mockVerifyRegistrationResponse.mockImplementation(async () => {
      callLog.push('verifyRegistrationResponse');
      throw new Error('malformed attestation');
    });
    const res = await enrol();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Registration failed' });
    expect(userWrites()).toHaveLength(0);
  });
});

// ─── 4. register-verify wrong-user rejection ─────────────────────────

describe('register-verify refuses a challenge issued to another admin', () => {
  it('returns 403 and performs no write of any kind', async () => {
    // Challenge issued to Mary; a perfectly valid token for Joseph presents it.
    stage({ challenges: { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } } });
    const res = await post(
      '/api/auth/passkey/register-verify',
      { requestId: 'r1', credential: { id: CRED_B64URL } },
      bearer(JOSEPH, 'ADMIN', 'Brother Joseph'),
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
    // Nothing on the users table: no appended credential, no reverse lookup.
    expect(userWrites()).toHaveLength(0);
    // And the verifier was never even consulted.
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
    // The only write at all is the single-use challenge burn.
    expect(allWrites()).toHaveLength(1);
    expect(allWrites()[0].__cmd).toBe('Delete');
    expect(allWrites()[0].Key.PK).toBe('WEBAUTHN_CHALLENGE#r1');
  });
});

// ─── 5. register-verify without a usable JWT ─────────────────────────

describe('the enrolment routes require a JWT', () => {
  it('register-verify with no Authorization header returns 401 and touches nothing', async () => {
    stage({ challenges: { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } } });
    const res = await post('/api/auth/passkey/register-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(cmds()).toHaveLength(0);
  });

  it('register-verify with an unverifiable bearer token returns 401', async () => {
    stage({ challenges: { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } } });
    const res = await post('/api/auth/passkey/register-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    }, { Authorization: 'Bearer not.a.real.token' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(cmds()).toHaveLength(0);
  });

  it('register-options with no Authorization header returns 401', async () => {
    stage({ users: { [MARY]: marySettings() } });
    const res = await post('/api/auth/passkey/register-options', {});
    expect(res.statusCode).toBe(401);
    expect(challengePuts()).toHaveLength(0);
  });
});

// ─── 6 & 9. login-verify success, and the counter ────────────────────

describe('login-verify success', () => {
  /** Mary with THREE passkeys; the one being used is at index 1. */
  function loginWorld(credOverrides: Record<string, any> = {}) {
    return {
      challenges: { r1: { challenge: LOGIN_CHALLENGE, userId: null, expiresAt: future() } },
      creds: { [CRED_B64URL]: MARY },
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [
            storedCred('cred-old-laptop'),
            storedCred(CRED_B64URL, credOverrides),
            storedCred('cred-spare-key'),
          ],
        }),
      },
    };
  }

  function login(credential: Record<string, any> = { id: CRED_B64URL }) {
    return post('/api/auth/passkey/login-verify', { requestId: 'r1', credential });
  }

  it('returns exactly the seven fields of the PIN-login response shape', async () => {
    stage(loginWorld());
    const res = await login();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(Object.keys(body).sort()).toEqual([
      'forceUpdatePin', 'name', 'onboardingComplete', 'onboardingProgress',
      'role', 'token', 'userId',
    ]);
    expect(body.userId).toBe(MARY);
    expect(body.name).toBe('Sister Mary');
    expect(body.role).toBe('ADMIN');
    expect(body.forceUpdatePin).toBe(false);
    expect(body.onboardingComplete).toBe(true);
    expect(body.onboardingProgress).toEqual(['welcome']);
  });

  it('produces a real token carrying the resolved identity', async () => {
    stage(loginWorld());
    const body = JSON.parse((await login()).body);
    expect(typeof body.token).toBe('string');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { verifyToken } = require('../src/lib/auth');
    const payload = verifyToken(body.token);
    expect(payload.userId).toBe(MARY);
    expect(payload.name).toBe('Sister Mary');
    expect(payload.role).toBe('ADMIN');
  });

  it('matches POST /api/auth/login key-for-key — admin.js reuses that handler', async () => {
    stage(loginWorld());
    const passkeyBody = JSON.parse((await login()).body);

    // The same account, logging in with a PIN instead.
    const pin = '135790';
    stage({ users: { [MARY]: marySettings({ pinHash: hashPin(pin) }) } });
    const pinRes = await post('/api/auth/login', { userId: MARY, pin });
    expect(pinRes.statusCode).toBe(200);
    const pinBody = JSON.parse(pinRes.body);

    expect(Object.keys(passkeyBody).sort()).toEqual(Object.keys(pinBody).sort());
  });

  it('persists the new signature counter, aliasing the reserved word as #c', async () => {
    stage(loginWorld());
    expect((await login()).statusCode).toBe(200);

    const updates = of('Update', 'test-users');
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u.Key).toEqual({ PK: `USER#${MARY}`, SK: 'META' });
    // Index 1 — the element that actually matched, not 0 and not the whole list.
    expect(u.UpdateExpression).toBe('SET passkeyCredentials[1].#c = :c, lastLoginAt = :now');
    // `counter` is a DynamoDB reserved word: it appears in the NAMES map, and a
    // test looking for a literal `counter` in the expression would be wrong.
    expect(u.UpdateExpression).not.toContain('counter');
    expect(u.ExpressionAttributeNames).toEqual({ '#c': 'counter' });
    expect(u.ExpressionAttributeValues[':c']).toBe(NEW_COUNTER);
  });

  it('writes lastLoginAt as an ISO instant in the same update', async () => {
    stage(loginWorld());
    expect((await login()).statusCode).toBe(200);
    const now = of('Update', 'test-users')[0].ExpressionAttributeValues[':now'];
    expect(typeof now).toBe('string');
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('hands the verifier the stored public key decoded back to bytes', async () => {
    // base64url of the eight PUBKEY_BYTES, so the decode is observable.
    const stored = Buffer.from(PUBKEY_BYTES).toString('base64url');
    stage(loginWorld({ publicKey: stored, counter: 11 }));
    expect((await login()).statusCode).toBe(200);

    const args = mockVerifyAuthenticationResponse.mock.calls[0][0];
    expect(args.expectedChallenge).toBe(LOGIN_CHALLENGE);
    expect(args.expectedRPID).toBe(RP_ID);
    expect(args.credential.id).toBe(CRED_B64URL);
    expect(args.credential.counter).toBe(11);
    expect(new Uint8Array(args.credential.publicKey)).toEqual(PUBKEY_BYTES);
  });

  it('accepts rawId when the response carries no id', async () => {
    stage(loginWorld());
    const res = await login({ rawId: CRED_B64URL } as any);
    expect(res.statusCode).toBe(200);
    expect(of('Get', 'test-users')[0].Key.PK).toBe(`PASSKEY_CRED#${CRED_B64URL}`);
  });
});

// ─── 7. login-verify: three failures, one indistinguishable 401 ──────

describe('login-verify does not enumerate users', () => {
  const CHALLENGE = { r1: { challenge: LOGIN_CHALLENGE, userId: null, expiresAt: future() } };

  async function attempt(world: World) {
    stage({ challenges: CHALLENGE, ...world });
    const res = await post('/api/auth/passkey/login-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    });
    return { res, writes: userWrites().length };
  }

  it('unknown credential — no PASSKEY_CRED# record — is 401 Invalid credentials', async () => {
    const { res, writes } = await attempt({ creds: {} });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid credentials' });
    expect(writes).toBe(0);
  });

  it('reverse record present but the USER record gone is the same 401', async () => {
    const { res, writes } = await attempt({ creds: { [CRED_B64URL]: MARY }, users: {} });
    expect(res.statusCode).toBe(401);
    expect(writes).toBe(0);
  });

  it('user present but the credential is not on their list is the same 401', async () => {
    // The list is NON-EMPTY, so the rejection comes from the findIndex miss and
    // not from there being nothing to search.
    const { res, writes } = await attempt({
      creds: { [CRED_B64URL]: MARY },
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [storedCred('cred-other-a'), storedCred('cred-other-b')],
        }),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(writes).toBe(0);
  });

  it('all three failures return byte-identical responses', async () => {
    const a = await attempt({ creds: {} });
    const b = await attempt({ creds: { [CRED_B64URL]: MARY }, users: {} });
    const c = await attempt({
      creds: { [CRED_B64URL]: MARY },
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [storedCred('cred-other-a'), storedCred('cred-other-b')],
        }),
      },
    });
    expect(a.res.statusCode).toBe(b.res.statusCode);
    expect(b.res.statusCode).toBe(c.res.statusCode);
    // The BODIES, not merely the status — a differing message is the enumeration.
    expect(a.res.body).toBe(b.res.body);
    expect(b.res.body).toBe(c.res.body);
    expect(a.res.body).toBe(JSON.stringify({ error: 'Invalid credentials' }));
  });

  it('an inactive user is the same 401 and no counter is written', async () => {
    const { res, writes } = await attempt({
      creds: { [CRED_B64URL]: MARY },
      users: { [MARY]: marySettings({ isActive: false, passkeyCredentials: [storedCred(CRED_B64URL)] }) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(JSON.stringify({ error: 'Invalid credentials' }));
    expect(writes).toBe(0);
  });

  it('a blocked identifier cannot use a passkey enrolled before the block', async () => {
    // The passkey is valid and the verifier would say so — the resolved-record
    // gate is what must refuse it, or a passkey outlives the block.
    const { res, writes } = await attempt({
      creds: { [CRED_B64URL]: 'legacy-shared' },
      users: {
        'legacy-shared': marySettings({
          PK: 'USER#legacy-shared', userId: 'legacy-shared',
          name: 'Admin', nameLower: 'admin',
          passkeyCredentials: [storedCred(CRED_B64URL)],
        }),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(JSON.stringify({ error: 'Invalid credentials' }));
    expect(writes).toBe(0);
  });

  it('a stored entry whose publicKey is not a string is refused, not passed to the verifier', async () => {
    const { res, writes } = await attempt({
      creds: { [CRED_B64URL]: MARY },
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [storedCred(CRED_B64URL, { publicKey: PUBKEY_BYTES })],
        }),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(writes).toBe(0);
    expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
  });
});

// ─── 8. login-verify bad signature ───────────────────────────────────

describe('login-verify with a bad signature', () => {
  function world() {
    return {
      challenges: { r1: { challenge: LOGIN_CHALLENGE, userId: null, expiresAt: future() } },
      creds: { [CRED_B64URL]: MARY },
      users: { [MARY]: marySettings({ passkeyCredentials: [storedCred(CRED_B64URL)] }) },
    };
  }

  it('returns the standard 401 and writes no counter update', async () => {
    mockVerifyAuthenticationResponse.mockImplementation(async () => {
      callLog.push('verifyAuthenticationResponse');
      return { verified: false, authenticationInfo: { newCounter: 99999 } };
    });
    stage(world());
    const res = await post('/api/auth/passkey/login-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(JSON.stringify({ error: 'Invalid credentials' }));
    // The verifier DID run — so this is the bad-signature path, not an earlier guard.
    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledTimes(1);
    expect(of('Update', 'test-users')).toHaveLength(0);
    expect(userWrites()).toHaveLength(0);
  });

  it('returns the standard 401 when the verifier throws, and writes no counter update', async () => {
    mockVerifyAuthenticationResponse.mockImplementation(async () => {
      callLog.push('verifyAuthenticationResponse');
      throw new Error('signature parse error');
    });
    stage(world());
    const res = await post('/api/auth/passkey/login-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(JSON.stringify({ error: 'Invalid credentials' }));
    expect(of('Update', 'test-users')).toHaveLength(0);
  });
});

// ─── 10. The challenge is single-use, burnt before verification ──────

describe('the challenge is single-use on both verify routes', () => {
  it('register-verify deletes the challenge BEFORE verifying, and on the failure path too', async () => {
    mockVerifyRegistrationResponse.mockImplementation(async () => {
      callLog.push('verifyRegistrationResponse');
      return { verified: false };
    });
    // The account must exist, or the re-read gate answers 401 before the
    // verifier is reached — which would test the wrong thing here.
    stage({
      challenges: { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } },
      users: { [MARY]: marySettings() },
    });
    const res = await post('/api/auth/passkey/register-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    }, bearer(MARY));

    expect(res.statusCode).toBe(400);
    expect(challengeDeletes()).toHaveLength(1);
    expect(challengeDeletes()[0].Key).toEqual({ PK: 'WEBAUTHN_CHALLENGE#r1', SK: 'META' });
    expect(challengeDeletes()[0].TableName).toBe('test-settings');

    const burnt = logIndexOf('Delete test-settings WEBAUTHN_CHALLENGE#r1');
    const verified = logIndexOf('verifyRegistrationResponse');
    expect(burnt).toBeGreaterThanOrEqual(0);
    expect(verified).toBeGreaterThanOrEqual(0);
    expect(burnt).toBeLessThan(verified);
  });

  it('login-verify deletes the challenge BEFORE verifying, and on a bad signature too', async () => {
    mockVerifyAuthenticationResponse.mockImplementation(async () => {
      callLog.push('verifyAuthenticationResponse');
      return { verified: false };
    });
    stage({
      challenges: { r1: { challenge: LOGIN_CHALLENGE, userId: null, expiresAt: future() } },
      creds: { [CRED_B64URL]: MARY },
      users: { [MARY]: marySettings({ passkeyCredentials: [storedCred(CRED_B64URL)] }) },
    });
    const res = await post('/api/auth/passkey/login-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    });

    expect(res.statusCode).toBe(401);
    expect(challengeDeletes()).toHaveLength(1);
    expect(challengeDeletes()[0].Key).toEqual({ PK: 'WEBAUTHN_CHALLENGE#r1', SK: 'META' });

    const burnt = logIndexOf('Delete test-settings WEBAUTHN_CHALLENGE#r1');
    const verified = logIndexOf('verifyAuthenticationResponse');
    expect(burnt).toBeGreaterThanOrEqual(0);
    expect(burnt).toBeLessThan(verified);
  });

  it('login-verify burns the challenge even when the credential is unknown', async () => {
    stage({
      challenges: { r1: { challenge: LOGIN_CHALLENGE, userId: null, expiresAt: future() } },
      creds: {},
    });
    const res = await post('/api/auth/passkey/login-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    });
    expect(res.statusCode).toBe(401);
    expect(challengeDeletes()).toHaveLength(1);
  });
});

// ─── 11 & 12. DELETE /api/admin/passkeys/{credentialId} ──────────────

describe('DELETE /api/admin/passkeys/{credentialId}', () => {
  const OWN_A = 'cred-mary-laptop';
  const OWN_C = 'cred-mary-spare';

  function del(credentialId: string, headers: Record<string, string> = bearer(MARY), extra: Partial<APIGatewayProxyEvent> = {}) {
    return handler(makeEvent({
      httpMethod: 'DELETE',
      path: `/api/admin/passkeys/${credentialId}`,
      headers,
      ...extra,
    }));
  }

  /** Mary owns three passkeys, the middle one being the base64url id. */
  function ownWorld(extra: Partial<World> = {}) {
    return {
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [storedCred(OWN_A), storedCred(CRED_B64URL), storedCred(OWN_C)],
        }),
      },
      creds: { [OWN_A]: MARY, [CRED_B64URL]: MARY, [OWN_C]: MARY },
      ...extra,
    };
  }

  it('refuses another admin\'s credential with 404 and NO write at all', async () => {
    // Mary genuinely has two passkeys of her own, so the 404 is the ownership
    // check and not an empty list. Joseph's credential exists in the reverse
    // table, so it is findable — just not hers.
    stage({
      users: { [MARY]: marySettings({ passkeyCredentials: [storedCred(OWN_A), storedCred(OWN_C)] }) },
      creds: { [OWN_A]: MARY, [OWN_C]: MARY, 'cred-joseph-phone': JOSEPH },
    });
    const res = await del('cred-joseph-phone');

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(of('Update')).toHaveLength(0);
    expect(of('Delete')).toHaveLength(0);
    expect(allWrites()).toHaveLength(0);
    // It only ever looked at the CALLER's record.
    expect(of('Get', 'test-users')).toHaveLength(1);
    expect(of('Get', 'test-users')[0].Key.PK).toBe(`USER#${MARY}`);
  });

  it('removes the matched element by index, guarded by a ConditionExpression', async () => {
    stage(ownWorld());
    const res = await del(CRED_B64URL);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: CRED_B64URL });

    const updates = of('Update', 'test-users');
    expect(updates).toHaveLength(1);
    // Index 1: the middle element, not 0 and not the last.
    expect(updates[0].UpdateExpression).toBe('REMOVE passkeyCredentials[1]');
    // The guard against an enrolment racing the delete and shifting the index.
    expect(updates[0].ConditionExpression).toBe('passkeyCredentials[1].credentialId = :cid');
    expect(updates[0].ExpressionAttributeValues).toEqual({ ':cid': CRED_B64URL });
    expect(updates[0].Key).toEqual({ PK: `USER#${MARY}`, SK: 'META' });
  });

  it('also deletes the PASSKEY_CRED# reverse-lookup record', async () => {
    stage(ownWorld());
    expect((await del(CRED_B64URL)).statusCode).toBe(200);
    expect(credDeletes()).toHaveLength(1);
    expect(credDeletes()[0].Key).toEqual({ PK: `PASSKEY_CRED#${CRED_B64URL}`, SK: 'META' });
    expect(credDeletes()[0].TableName).toBe('test-users');
  });

  it('returns 409 on a lost race and leaves the reverse-lookup record in place', async () => {
    const conflict = Object.assign(new Error('conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    });
    stage(ownWorld({ updateThrows: conflict }));
    const res = await del(CRED_B64URL);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Conflict' });
    // The reverse record must survive, or the credential becomes unresolvable
    // while still sitting on the user.
    expect(credDeletes()).toHaveLength(0);
  });

  it('takes the credential id from event.path, ignoring event.pathParameters', async () => {
    // API Gateway proxy integration never populates pathParameters; a decoy value
    // here proves the dispatcher parses the path itself.
    stage(ownWorld());
    const res = await del(CRED_B64URL, bearer(MARY), {
      pathParameters: { credentialId: 'DECOY-NOT-THIS-ONE' } as any,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: CRED_B64URL });
    // The base64url id survived intact — '-' and '_' included.
    expect(of('Update', 'test-users')[0].ExpressionAttributeValues[':cid']).toBe(CRED_B64URL);
    expect(credDeletes()[0].Key.PK).toBe(`PASSKEY_CRED#${CRED_B64URL}`);
    expect(JSON.stringify(cmds())).not.toContain('DECOY-NOT-THIS-ONE');
  });

  it('callerFromToken returning null yields 401 before any read', async () => {
    // Reached by calling the route module directly: index.ts turns an unauthenticated
    // request away first, so this is the belt-and-braces self-service check.
    stage(ownWorld());
    const res = await handleAdmin(makeEvent({
      httpMethod: 'DELETE', path: `/api/admin/passkeys/${CRED_B64URL}`, headers: {},
    }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(cmds()).toHaveLength(0);
  });
});

// ─── 13. GET /api/admin/passkeys must not leak key material ──────────

describe('GET /api/admin/passkeys', () => {
  const SECRET_KEY = 'UEtTRUNSRVQtTk9ULUZPUi1USEUtQlJPV1NFUg';
  const SECRET_COUNTER = 991337;

  function get(headers: Record<string, string> = bearer(MARY)) {
    return handler(makeEvent({ httpMethod: 'GET', path: '/api/admin/passkeys', headers }));
  }

  it('never serialises publicKey or counter', async () => {
    stage({
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [
            storedCred(CRED_B64URL, {
              publicKey: SECRET_KEY, counter: SECRET_COUNTER, deviceLabel: "Mary's iPhone",
            }),
          ],
        }),
      },
    });
    const res = await get();
    expect(res.statusCode).toBe(200);

    // Asserted on the raw JSON string, so a nested leak cannot slip past.
    expect(res.body).not.toContain('publicKey');
    expect(res.body).not.toContain('counter');
    expect(res.body).not.toContain(SECRET_KEY);
    expect(res.body).not.toContain(String(SECRET_COUNTER));
    expect(res.body).not.toContain('transports');

    const { passkeys } = JSON.parse(res.body);
    expect(passkeys).toHaveLength(1);
    expect(Object.keys(passkeys[0]).sort()).toEqual(['createdAt', 'deviceLabel', 'id']);
    expect(passkeys[0].id).toBe(CRED_B64URL);
    expect(passkeys[0].deviceLabel).toBe("Mary's iPhone");
    expect(passkeys[0].createdAt).toBe('2026-09-01T02:00:00.000Z');
  });

  it('lists the CALLER\'s passkeys only, in stored order', async () => {
    stage({
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [storedCred('cred-a'), storedCred('cred-b')],
        }),
        [JOSEPH]: marySettings({
          PK: `USER#${JOSEPH}`, userId: JOSEPH,
          passkeyCredentials: [storedCred('cred-joseph')],
        }),
      },
    });
    const res = await get();
    expect(JSON.parse(res.body).passkeys.map((p: any) => p.id)).toEqual(['cred-a', 'cred-b']);
    expect(res.body).not.toContain('cred-joseph');
    expect(of('Get', 'test-users')[0].Key.PK).toBe(`USER#${MARY}`);
  });

  it('returns an empty list, not an error, for an account with no passkeys', async () => {
    stage({ users: { [MARY]: marySettings() } });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ passkeys: [] });
  });

  it('skips a malformed entry and defaults a missing label and date', async () => {
    stage({
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [
            null,
            { credentialId: 'cred-bare' },
            { deviceLabel: 'no id at all' },
          ],
        }),
      },
    });
    const res = await get();
    expect(JSON.parse(res.body).passkeys).toEqual([
      { id: 'cred-bare', deviceLabel: 'Passkey', createdAt: null },
    ]);
  });

  it('is refused for a CASHIER token by the router, before the handler', async () => {
    stage({ users: { [MARY]: marySettings() } });
    const res = await get(bearer(MARY, 'CASHIER'));
    expect(res.statusCode).toBe(403);
    expect(cmds()).toHaveLength(0);
  });
});

// ─── 14. Path dispatch ───────────────────────────────────────────────

describe('path dispatch — all six routes reach their handler', () => {
  function fullWorld(extra: Partial<World> = {}) {
    return {
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [storedCred(CRED_B64URL)],
          pinHash: undefined,
        }),
      },
      creds: { [CRED_B64URL]: MARY },
      challenges: {
        rreg: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() },
        rlog: { challenge: LOGIN_CHALLENGE, userId: null, expiresAt: future() },
      },
      ...extra,
    };
  }

  it('POST /api/auth/passkey/register-options', async () => {
    stage(fullWorld());
    const res = await post('/api/auth/passkey/register-options', {}, bearer(MARY));
    expect(res.statusCode).toBe(200);
    // Proof the handler body ran, not merely that it was not a 404.
    expect(mockGenerateRegistrationOptions).toHaveBeenCalledTimes(1);
    expect(challengePuts()).toHaveLength(1);
  });

  it('POST /api/auth/passkey/register-verify', async () => {
    // Mary starts with NO passkeys here: fullWorld() already holds
    // CRED_B64URL, which is the id the mocked verifier returns, and re-enrolling
    // an already-present credentialId is now a 409 — a different route than the
    // dispatch this test is about.
    stage(fullWorld({ users: { [MARY]: marySettings({ pinHash: undefined }) } }));
    const res = await post('/api/auth/passkey/register-verify', {
      requestId: 'rreg', credential: { id: CRED_B64URL },
    }, bearer(MARY));
    expect(res.statusCode).toBe(201);
    expect(mockVerifyRegistrationResponse).toHaveBeenCalledTimes(1);
  });

  it('POST /api/auth/passkey/login-options — public, no Authorization header', async () => {
    stage(fullWorld());
    const res = await post('/api/auth/passkey/login-options');
    expect(res.statusCode).toBe(200);
    expect(mockGenerateAuthenticationOptions).toHaveBeenCalledTimes(1);
  });

  it('POST /api/auth/passkey/login-verify — public, no Authorization header', async () => {
    stage(fullWorld());
    const res = await post('/api/auth/passkey/login-verify', {
      requestId: 'rlog', credential: { id: CRED_B64URL },
    });
    expect(res.statusCode).toBe(200);
    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });

  it('GET /api/admin/passkeys', async () => {
    stage(fullWorld());
    const res = await handler(makeEvent({
      httpMethod: 'GET', path: '/api/admin/passkeys', headers: bearer(MARY),
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).passkeys.map((p: any) => p.id)).toEqual([CRED_B64URL]);
  });

  it('DELETE /api/admin/passkeys/{credentialId} with a base64url id', async () => {
    stage(fullWorld());
    const res = await handler(makeEvent({
      httpMethod: 'DELETE', path: `/api/admin/passkeys/${CRED_B64URL}`, headers: bearer(MARY),
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: CRED_B64URL });
  });

  it('every route carries the router\'s CORS headers', async () => {
    stage(fullWorld());
    const res = await post('/api/auth/passkey/login-options');
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers?.['Access-Control-Allow-Methods']).toContain('DELETE');
  });

  it('an unknown /api/auth/passkey/* path still 404s — dispatch is by exact path', async () => {
    stage(fullWorld());
    const res = await post('/api/auth/passkey/register-optionsX', {}, bearer(MARY));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(cmds()).toHaveLength(0);
  });

  it('GET /api/admin/passkeys is not shadowed by another admin branch', async () => {
    // The GET reads the CALLER's user record and nothing else — a branch above it
    // that had captured the path would read some other table.
    stage(fullWorld());
    await handler(makeEvent({
      httpMethod: 'GET', path: '/api/admin/passkeys', headers: bearer(MARY),
    }));
    expect(cmds().map((c) => `${c.__cmd} ${c.TableName}`)).toEqual(['Get test-users']);
  });
});

// ─── 15. GET /api/admin/users must not list the reverse records ──────
//
// Lives in this suite rather than admin-users-settings.test.ts because the rows
// that leak are written by register-verify: the fixture needs a real
// `PASSKEY_CRED#` item, and the assertion is about the passkey feature polluting
// a pre-existing list. The mock evaluates the FilterExpression the way DynamoDB
// would (see `applyScanFilter`), so dropping the filter from the source makes
// these tests fail rather than pass on a mock that filters nothing.

describe('GET /api/admin/users excludes the PASSKEY_CRED# reverse records', () => {
  const MARY_ROW = marySettings({
    lastLoginAt: '2026-09-06T01:15:00.000Z', pinHash: 'STOREDHASH-NEVER-SERIALISED',
  });
  const JOSEPH_ROW = marySettings({
    PK: `USER#${JOSEPH}`, userId: JOSEPH, name: 'Brother Joseph', nameLower: 'brother joseph',
    role: 'CASHIER', lastLoginAt: null,
  });
  const MARY_CRED_ROW = { PK: `PASSKEY_CRED#${CRED_B64URL}`, SK: 'META', userId: MARY };
  const JOSEPH_CRED_ROW = { PK: 'PASSKEY_CRED#cred-joseph-phone', SK: 'META', userId: JOSEPH };

  function listUsers(headers: Record<string, string> = bearer(MARY)) {
    return handler(makeEvent({ httpMethod: 'GET', path: '/api/admin/users', headers }));
  }

  it('lists the two real accounts and neither phantom', async () => {
    // Reverse records first, so an unfiltered Scan would put a phantom at the top
    // of the volunteer list.
    stage({ userTableRows: [MARY_CRED_ROW, MARY_ROW, JOSEPH_CRED_ROW, JOSEPH_ROW] });
    const res = await listUsers();
    expect(res.statusCode).toBe(200);

    const { users } = JSON.parse(res.body);
    expect(users).toEqual([
      {
        userId: MARY, name: 'Sister Mary', role: 'ADMIN', isActive: true,
        lastLoginAt: '2026-09-06T01:15:00.000Z',
      },
      {
        userId: JOSEPH, name: 'Brother Joseph', role: 'CASHIER', isActive: true,
        lastLoginAt: null,
      },
    ]);
    // Each phantom carried the REAL owner's userId, so the row's Delete button
    // deleted a live volunteer. One entry per account, not two.
    expect(users.filter((u: any) => u.userId === MARY)).toHaveLength(1);
    expect(users.filter((u: any) => u.userId === JOSEPH)).toHaveLength(1);
    // A nameless row was the phantom's visible signature.
    expect(users.every((u: any) => typeof u.name === 'string' && u.name.length > 0)).toBe(true);
    expect(res.body).not.toContain('PASSKEY_CRED');
    expect(res.body).not.toContain('STOREDHASH-NEVER-SERIALISED');

    const scans = of('Scan', 'test-users');
    expect(scans).toHaveLength(1);
    expect(scans[0].FilterExpression).toBe('begins_with(PK, :userPk)');
    expect(scans[0].ExpressionAttributeValues).toEqual({ ':userPk': 'USER#' });
    expect(allWrites()).toHaveLength(0);
  });

  it('answers an empty list for a table holding nothing but reverse records', async () => {
    stage({ userTableRows: [MARY_CRED_ROW, JOSEPH_CRED_ROW] });
    const res = await listUsers();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ users: [] });
  });
});

// ─── 16. Enrolment is ADMIN-only ─────────────────────────────────────

describe('the enrolment routes are ADMIN-only', () => {
  const CH = { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } };

  it('register-options refuses a CASHIER token with 403, reading nothing', async () => {
    stage({ users: { [MARY]: marySettings({ role: 'CASHIER' }) }, challenges: CH });
    const res = await post('/api/auth/passkey/register-options', {}, bearer(MARY, 'CASHIER'));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
    // /api/auth is the public prefix, so index.ts applies no role check — this
    // gate is the only one, and it is decided off the token, before any read.
    expect(cmds()).toHaveLength(0);
    expect(mockGenerateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('register-verify refuses a CASHIER token without even burning the challenge', async () => {
    // The challenge is valid, unexpired and issued to this very user, so without
    // the gate this request would have enrolled a credential.
    stage({ users: { [MARY]: marySettings({ role: 'CASHIER' }) }, challenges: CH });
    const res = await post(
      '/api/auth/passkey/register-verify',
      { requestId: 'r1', credential: { id: CRED_B64URL } },
      bearer(MARY, 'CASHIER'),
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
    expect(cmds()).toHaveLength(0);
    expect(challengeDeletes()).toHaveLength(0);
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('control: byte-for-byte the same request under an ADMIN token enrols', async () => {
    stage({ users: { [MARY]: marySettings() }, challenges: CH });
    const res = await post(
      '/api/auth/passkey/register-verify',
      { requestId: 'r1', credential: { id: CRED_B64URL } },
      bearer(MARY),
    );
    expect(res.statusCode).toBe(201);
    expect(of('Update', 'test-users')).toHaveLength(1);
  });
});

// ─── 17 & 18. The reverse-record claim, and its ordering ─────────────

describe('the PASSKEY_CRED# claim is guarded against a squat', () => {
  function world(extra: Partial<World> = {}): World {
    return {
      challenges: { r1: { challenge: REG_CHALLENGE, userId: JOSEPH, expiresAt: future() } },
      users: {
        [JOSEPH]: marySettings({
          PK: `USER#${JOSEPH}`, userId: JOSEPH, name: 'Brother Joseph', nameLower: 'brother joseph',
        }),
      },
      ...extra,
    };
  }

  /** Joseph presents a credential whose id the verifier reports as CRED_B64URL. */
  function claim() {
    return post(
      '/api/auth/passkey/register-verify',
      { requestId: 'r1', credential: { id: CRED_B64URL } },
      bearer(JOSEPH, 'ADMIN', 'Brother Joseph'),
    );
  }

  it('409s when the credentialId already maps to ANOTHER user, appending nothing', async () => {
    stage(world({ creds: { [CRED_B64URL]: MARY } }));
    const res = await claim();

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Credential already registered' });
    // The claim was attempted and the condition rejected it, so the list write
    // never happened — an unguarded Put would have repointed login at Joseph.
    expect(credPuts()).toHaveLength(1);
    expect(credPuts()[0].ConditionExpression).toBe('attribute_not_exists(PK) OR userId = :uid');
    expect(credPuts()[0].ExpressionAttributeValues).toEqual({ ':uid': JOSEPH });
    expect(of('Update', 'test-users')).toHaveLength(0);
    expect(authLogs().some((l) => l.includes('reason=credential-owned-by-other-user'))).toBe(true);
  });

  it('lets the RIGHTFUL owner re-claim their own credentialId after a partial failure', async () => {
    // Same shape, but the existing reverse record already points at the caller.
    // The `userId = :uid` half of the condition has to let this through, or a
    // half-finished enrolment locks that credentialId out of the account forever.
    stage(world({ creds: { [CRED_B64URL]: JOSEPH } }));
    const res = await claim();

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).credentialId).toBe(CRED_B64URL);
    expect(of('Update', 'test-users')).toHaveLength(1);
  });

  it('stakes the reverse record BEFORE appending to the user list', async () => {
    stage(world());
    expect((await claim()).statusCode).toBe(201);

    // The order actually sent, not the order the source reads in.
    const writes = userWrites().map((c) => c.__cmd);
    expect(writes).toEqual(['Put', 'Update']);
    const staked = logIndexOf(`Put test-users PASSKEY_CRED#${CRED_B64URL}`);
    const appended = logIndexOf(`Update test-users USER#${JOSEPH}`);
    expect(staked).toBeGreaterThanOrEqual(0);
    expect(appended).toBeGreaterThanOrEqual(0);
    expect(staked).toBeLessThan(appended);
  });

  it('a non-conditional failure on the claim is not turned into a 409', async () => {
    stage(world({ creds: { [CRED_B64URL]: MARY } }));
    mockDbSend.mockImplementation(async (cmd: any) => {
      if (cmd.__cmd === 'Get' && String(cmd.Key?.PK).startsWith('WEBAUTHN_CHALLENGE#')) {
        return { Item: { challenge: REG_CHALLENGE, userId: JOSEPH, expiresAt: future() } };
      }
      if (cmd.__cmd === 'Get') return { Item: marySettings({ PK: `USER#${JOSEPH}`, userId: JOSEPH }) };
      if (cmd.__cmd === 'Put' && String(cmd.Item?.PK).startsWith('PASSKEY_CRED#')) {
        throw Object.assign(new Error('throughput'), { name: 'ProvisionedThroughputExceededException' });
      }
      return {};
    });
    // Reporting "already registered" for a throttle would send the admin off
    // hunting a credential that is not there.
    await expect(claim()).rejects.toThrow('throughput');
  });
});

// ─── 19. A lost counter-write race still logs the admin in ───────────

describe('login-verify survives a lost counter-write race', () => {
  function loginWorld(extra: Partial<World> = {}): World {
    return {
      challenges: { r1: { challenge: LOGIN_CHALLENGE, userId: null, expiresAt: future() } },
      creds: { [CRED_B64URL]: MARY },
      users: {
        [MARY]: marySettings({
          passkeyCredentials: [
            storedCred('cred-old-laptop'),
            storedCred(CRED_B64URL),
            storedCred('cred-spare-key'),
          ],
        }),
      },
      ...extra,
    };
  }

  function login() {
    return post('/api/auth/passkey/login-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    });
  }

  it('returns the full seven-field body when the counter Update is rejected', async () => {
    stage(loginWorld({ updateThrows: conditionalCheckFailed() }));
    const res = await login();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body).sort()).toEqual([
      'forceUpdatePin', 'name', 'onboardingComplete', 'onboardingProgress',
      'role', 'token', 'userId',
    ]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { verifyToken } = require('../src/lib/auth');
    expect(verifyToken(body.token).userId).toBe(MARY);
    // A dropped counter write is a diagnosable event, not a silent one.
    expect(authLogs().some((l) => l.startsWith('[AUTH] PASSKEY_COUNTER_WRITE_SKIPPED'))).toBe(true);
    expect(authLogs().some((l) => l.startsWith('[AUTH] SUCCESS'))).toBe(true);
  });

  it('guards the counter write on that element still being the same credential', async () => {
    stage(loginWorld());
    expect((await login()).statusCode).toBe(200);

    const u = of('Update', 'test-users')[0];
    // A DELETE of an earlier passkey shifts every later element down one, so a
    // bare positional write could stamp this counter onto a DIFFERENT credential.
    expect(u.ConditionExpression).toBe('passkeyCredentials[1].credentialId = :cid');
    expect(u.ExpressionAttributeValues[':cid']).toBe(CRED_B64URL);
    // The same index in both expressions, or the guard checks the wrong element.
    expect(u.UpdateExpression).toContain('passkeyCredentials[1].#c');
  });

  it('does not swallow a non-conditional failure of the counter write', async () => {
    stage(loginWorld({
      updateThrows: Object.assign(new Error('throughput'), {
        name: 'ProvisionedThroughputExceededException',
      }),
    }));
    // Swallowing everything here would hide a table that has stopped accepting
    // writes, while logins carried on looking healthy.
    await expect(login()).rejects.toThrow('throughput');
  });
});

// ─── 20. register-verify re-reads the account ────────────────────────

describe('register-verify re-reads the account before it writes', () => {
  const CH = { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } };

  function attempt(users: Record<string, any>, extra: Partial<World> = {}) {
    stage({ challenges: CH, users, ...extra });
    return post(
      '/api/auth/passkey/register-verify',
      { requestId: 'r1', credential: { id: CRED_B64URL } },
      bearer(MARY),
    );
  }

  it('401s when the account was deleted after the token was issued', async () => {
    const res = await attempt({});
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    // UpdateCommand is an upsert: reaching it would RESURRECT USER#sister-mary as
    // a record holding nothing but a passkey list, which every reader of this
    // table would treat as a live account.
    expect(userWrites()).toHaveLength(0);
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
    // The single-use challenge is still burned.
    expect(challengeDeletes()).toHaveLength(1);
    expect(authLogs().some((l) => l.includes('reason=no-such-user-or-inactive'))).toBe(true);
  });

  it('401s when the account was DEACTIVATED after the token was issued', async () => {
    // The record exists, so the refusal is the isActive check and not absence.
    const res = await attempt({ [MARY]: marySettings({ isActive: false }) });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(userWrites()).toHaveLength(0);
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('403s when the account still owes a forced PIN change', async () => {
    // Otherwise a passkey is a permanent bypass of the forced-change invariant,
    // and the admin-issued PIN stays live forever.
    const res = await attempt({ [MARY]: marySettings({ forceUpdatePin: true }) });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'PIN change required before enrolling a passkey',
    });
    expect(userWrites()).toHaveLength(0);
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('register-options 403s on the same forced PIN change, issuing no challenge', async () => {
    stage({ users: { [MARY]: marySettings({ forceUpdatePin: true }) } });
    const res = await post('/api/auth/passkey/register-options', {}, bearer(MARY));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'PIN change required before enrolling a passkey',
    });
    expect(challengePuts()).toHaveLength(0);
    expect(mockGenerateRegistrationOptions).not.toHaveBeenCalled();
  });

  it('guards the append with attribute_exists(PK) so it cannot upsert', async () => {
    const res = await attempt({ [MARY]: marySettings() });
    expect(res.statusCode).toBe(201);
    expect(of('Update', 'test-users')[0].ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('409s Conflict when the account vanishes between the re-read and the append', async () => {
    const res = await attempt(
      { [MARY]: marySettings() },
      { updateThrows: conditionalCheckFailed() },
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Conflict' });
    expect(authLogs().some((l) => l.includes('reason=user-vanished'))).toBe(true);
    // Documented residue of the write order: the reverse claim was already
    // staked and is left behind. Harmless — login resolves the owner, finds no
    // such credential on the record and stops at `credential-not-on-user`.
    expect(credPuts()).toHaveLength(1);
  });
});

// ─── 21. Duplicates and the per-account cap ──────────────────────────

describe('enrolment dedupes and caps the credential list', () => {
  const CH = { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } };

  function enrolWith(list: any[]) {
    stage({ challenges: CH, users: { [MARY]: marySettings({ passkeyCredentials: list }) } });
    return post(
      '/api/auth/passkey/register-verify',
      { requestId: 'r1', credential: { id: CRED_B64URL } },
      bearer(MARY),
    );
  }

  const others = (n: number) => Array.from({ length: n }, (_, i) => storedCred(`cred-device-${i}`));

  it('409s Passkey already enrolled rather than appending a second copy', async () => {
    // Duplicates are worse than untidy: login takes the FIRST match by findIndex,
    // so the counter advances on one copy while the other stays stale, and DELETE
    // only ever removes one of them.
    const res = await enrolWith([storedCred('cred-laptop'), storedCred(CRED_B64URL)]);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Passkey already enrolled' });
    expect(userWrites()).toHaveLength(0);
    expect(authLogs().some((l) => l.includes('reason=already-enrolled'))).toBe(true);
  });

  it('refuses the 11th passkey with 409 Passkey limit reached and writes nothing', async () => {
    const list = others(10);
    // Ten DIFFERENT ids, so the refusal is the cap and not the dedupe above.
    expect(list.some((c) => c.credentialId === CRED_B64URL)).toBe(false);
    const res = await enrolWith(list);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Passkey limit reached' });
    // Unbounded, the item grows toward the 400KB limit and then EVERY later write
    // to it fails — including lastLoginAt and the PIN change.
    expect(userWrites()).toHaveLength(0);
    // Refused before any cryptography runs.
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
    expect(authLogs().some((l) => l.includes('reason=limit-reached'))).toBe(true);
  });

  it('the cap is exclusive: with nine enrolled, the tenth is accepted', async () => {
    const res = await enrolWith(others(9));
    expect(res.statusCode).toBe(201);
    const appended = of('Update', 'test-users')[0].ExpressionAttributeValues[':new'];
    expect(appended).toHaveLength(1);
    expect(appended[0].credentialId).toBe(CRED_B64URL);
  });
});

// ─── 22. A thrown verifier is diagnosable from the log only ──────────

describe('a thrown verifier is diagnosable from the log but not from the response', () => {
  const DETAIL = 'Unexpected registration response origin "https://evil.test", expected "https://153.oasisofcare.org"';
  const ORIGIN = 'https://153.oasisofcare.org';

  function loginWorld(): World {
    return {
      challenges: { r1: { challenge: LOGIN_CHALLENGE, userId: null, expiresAt: future() } },
      creds: { [CRED_B64URL]: MARY },
      users: { [MARY]: marySettings({ passkeyCredentials: [storedCred(CRED_B64URL)] }) },
    };
  }

  function login() {
    return post('/api/auth/passkey/login-verify', {
      requestId: 'r1', credential: { id: CRED_B64URL },
    });
  }

  it('register-verify logs the library message with rpID and origin', async () => {
    mockVerifyRegistrationResponse.mockImplementation(async () => { throw new Error(DETAIL); });
    stage({
      challenges: { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } },
      users: { [MARY]: marySettings() },
    });
    const res = await post(
      '/api/auth/passkey/register-verify',
      { requestId: 'r1', credential: { id: CRED_B64URL } },
      bearer(MARY),
    );

    expect(res.statusCode).toBe(400);
    // The response stays as minimal as it was: no detail reaches the browser.
    expect(res.body).toBe(JSON.stringify({ error: 'Registration failed' }));
    expect(res.body).not.toContain('evil.test');

    const line = authLogs().find((l) => l.includes('reason=verify-threw'));
    expect(line).toBeDefined();
    // An RP_ID/ORIGIN mismatch is the likeliest misconfiguration of this whole
    // feature and the library's message names the mismatched values; a bare
    // `verify-threw` is undiagnosable from CloudWatch.
    expect(line).toContain(`detail=${DETAIL}`);
    expect(line).toContain(`rpID=${RP_ID}`);
    expect(line).toContain(`origin=${ORIGIN}`);
    // Message only, no stack — a stack would break the one-line grep convention.
    expect(line).not.toContain('\n');
  });

  it('login-verify logs the same diagnostics and still answers the standard 401', async () => {
    mockVerifyAuthenticationResponse.mockImplementation(async () => { throw new Error(DETAIL); });
    stage(loginWorld());
    const res = await login();

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(JSON.stringify({ error: 'Invalid credentials' }));
    expect(res.body).not.toContain('evil.test');

    const line = authLogs().find((l) => l.startsWith('[AUTH] PASSKEY_LOGIN_VERIFY_ERROR'));
    expect(line).toBeDefined();
    expect(line).toContain(`detail=${DETAIL}`);
    expect(line).toContain(`rpID=${RP_ID}`);
    expect(line).toContain(`origin=${ORIGIN}`);
    expect(line).not.toContain('\n');
    // And the attempt is still counted as a failure, attributed to the owner.
    expect(authLogs().some((l) => l.includes('reason=verify-threw'))).toBe(true);
    expect(of('Update', 'test-users')).toHaveLength(0);
  });

  it('the verify-threw 401 is byte-identical to the other login failures', async () => {
    const bodies: string[] = [];

    // Unknown credential.
    stage({ ...loginWorld(), creds: {} });
    bodies.push((await login()).body);

    // The verifier threw.
    mockVerifyAuthenticationResponse.mockImplementation(async () => { throw new Error(DETAIL); });
    stage(loginWorld());
    bodies.push((await login()).body);

    // A bad signature.
    mockVerifyAuthenticationResponse.mockImplementation(async () => ({ verified: false }));
    stage(loginWorld());
    bodies.push((await login()).body);

    // A differing body is the enumeration, whatever the status code says.
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(JSON.stringify({ error: 'Invalid credentials' }));
  });

  it('enrolment DOES distinguish its refusals — different admin-facing causes', async () => {
    // Deliberate asymmetry: the caller is already authenticated as this admin, so
    // there is nothing to enumerate, and "limit reached" vs "already enrolled" is
    // the difference between two different things for the admin to do about it.
    const CH = { r1: { challenge: REG_CHALLENGE, userId: MARY, expiresAt: future() } };
    const body = { requestId: 'r1', credential: { id: CRED_B64URL } };

    stage({ challenges: CH, users: { [MARY]: marySettings({ passkeyCredentials: [storedCred(CRED_B64URL)] }) } });
    const dupe = await post('/api/auth/passkey/register-verify', body, bearer(MARY));

    stage({
      challenges: CH,
      users: {
        [MARY]: marySettings({
          passkeyCredentials: Array.from({ length: 10 }, (_, i) => storedCred(`cred-${i}`)),
        }),
      },
    });
    const capped = await post('/api/auth/passkey/register-verify', body, bearer(MARY));

    expect(dupe.statusCode).toBe(409);
    expect(capped.statusCode).toBe(409);
    expect(dupe.body).not.toBe(capped.body);
    expect(JSON.parse(dupe.body).error).toBe('Passkey already enrolled');
    expect(JSON.parse(capped.body).error).toBe('Passkey limit reached');
  });
});

// ─── 23. The DELETE's reverse-record removal is ownership-guarded ─────

describe('DELETE removes the reverse record only when the caller owns it', () => {
  function del(credentialId: string, headers: Record<string, string> = bearer(MARY)) {
    return handler(makeEvent({
      httpMethod: 'DELETE', path: `/api/admin/passkeys/${credentialId}`, headers,
    }));
  }

  const maryOwns = (extra: Partial<World> = {}): World => ({
    users: { [MARY]: marySettings({ passkeyCredentials: [storedCred(CRED_B64URL)] }) },
    creds: { [CRED_B64URL]: MARY },
    ...extra,
  });

  it('conditions the reverse delete on ownership and sends it AFTER the list removal', async () => {
    stage(maryOwns());
    expect((await del(CRED_B64URL)).statusCode).toBe(200);

    expect(credDeletes()).toHaveLength(1);
    // The key is not namespaced by user, so an unconditional delete here is a
    // cross-user write.
    expect(credDeletes()[0].ConditionExpression).toBe('userId = :caller');
    expect(credDeletes()[0].ExpressionAttributeValues).toEqual({ ':caller': MARY });

    // List entry first, so the failure window stays fail-closed.
    const removed = logIndexOf(`Update test-users USER#${MARY}`);
    const reverse = logIndexOf(`Delete test-users PASSKEY_CRED#${CRED_B64URL}`);
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(reverse).toBeGreaterThanOrEqual(0);
    expect(removed).toBeLessThan(reverse);
  });

  it('leaves another admin\'s reverse record alone and still reports success', async () => {
    // Diverged tables: Mary lists the credential but the reverse record points at
    // Joseph. Her list entry is already gone, so her passkey is dead and 200 is
    // the truthful answer — but the divergence has to be logged.
    stage(maryOwns({ creds: { [CRED_B64URL]: JOSEPH } }));
    const res = await del(CRED_B64URL);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: CRED_B64URL });
    expect(of('Update', 'test-users')).toHaveLength(1);
    expect(authLogs().some((l) => l.startsWith('[AUTH] PASSKEY_DELETE_REVERSE_NOT_OWNED'))).toBe(true);
    expect(authLogs().some((l) => l.startsWith('[AUTH] PASSKEY_DELETED'))).toBe(true);
  });

  it('does not swallow a non-conditional failure of the reverse delete', async () => {
    stage(maryOwns({
      credDeleteThrows: Object.assign(new Error('throughput'), {
        name: 'ProvisionedThroughputExceededException',
      }),
    }));
    const res = await del(CRED_B64URL);
    // Rethrown, so handleAdmin's own catch turns it into a 500 — NOT reported as
    // a successful revoke. A blanket swallow here would hide a table that had
    // stopped accepting writes.
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('deleted');
    expect(authLogs().some((l) => l.startsWith('[AUTH] PASSKEY_DELETED'))).toBe(false);
  });
});

export {};
