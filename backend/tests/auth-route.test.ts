/**
 * `handleAuth` — the POST /api/auth/* ROUTE handler in `src/routes/auth.ts`.
 *
 * Scope boundary, deliberate:
 *   - `tests/auth.test.ts`          covers `lib/auth` (hashPin/comparePin/signToken/verifyToken)
 *   - `tests/login-blocklist.test.ts` covers `isBlockedIdentifier` as a pure function
 *   - THIS FILE covers only the route: dispatch, guards, status codes, the
 *     response shape, the DB commands issued, and the audit line emitted.
 *
 * `lib/auth` and `lib/audit` are mocked so the route's own branching is what is
 * under test — not bcrypt, not JWT. Fully offline: no credentials, no live
 * writes, so no `ZZTEST_` marker is required.
 *
 * The two things worth stating as intent:
 *
 * 1. **A blocked identifier is refused before any lookup.** No GetCommand, no
 *    ScanCommand, no PIN comparison — so no timing difference reveals whether
 *    the account exists. The `admin-001` seed credential was used for an
 *    unauthorised login on 2026-08-02; deleting the record is not enough,
 *    because anyone can recreate an account with the same name.
 * 2. **Every login attempt is audited.** Success, failure and blocked all emit
 *    exactly one `logAuth` line carrying the source IP and user agent, and
 *    never the PIN.
 */

const mockDbSend = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  USERS_TABLE: 'test-users',
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  SETTINGS_TABLE: 'test-settings',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
  DeleteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Delete' })),
}));

const mockComparePin = jest.fn();
const mockSignToken = jest.fn();
const mockHashPin = jest.fn();
const mockVerifyToken = jest.fn();

jest.mock('../src/lib/auth', () => ({
  comparePin: (...a: any[]) => mockComparePin(...a),
  signToken: (...a: any[]) => mockSignToken(...a),
  hashPin: (...a: any[]) => mockHashPin(...a),
  verifyToken: (...a: any[]) => mockVerifyToken(...a),
}));

const mockLogAuth = jest.fn();

jest.mock('../src/lib/audit', () => ({
  logAuth: (...a: any[]) => mockLogAuth(...a),
  logOrder: jest.fn(),
  summarizeItems: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleAuth } = require('../src/routes/auth');

// ─── Fixtures & helpers ──────────────────────────────────────────────

const IP = '203.0.113.7';
const UA = 'Mozilla/5.0 (iPhone)';
const TOKEN = 'signed.jwt.token';

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    httpMethod: 'POST',
    path: '/api/auth/login',
    body: null,
    headers: { 'User-Agent': UA },
    queryStringParameters: null,
    pathParameters: null,
    requestContext: { identity: { sourceIp: IP } },
    ...overrides,
  } as any;
}

/** POST /api/auth/login with `body` as the JSON payload. */
function loginEvent(body: Record<string, any>, overrides: Record<string, any> = {}) {
  return makeEvent({ body: JSON.stringify(body), ...overrides });
}

/** POST /api/auth/update-pin carrying `token` as a Bearer header. */
function updatePinEvent(body: Record<string, any> | null, token = TOKEN, headerName = 'Authorization') {
  return makeEvent({
    path: '/api/auth/update-pin',
    body: body ? JSON.stringify(body) : null,
    headers: { [headerName]: `Bearer ${token}` },
  });
}

function userRecord(overrides: Record<string, any> = {}) {
  return {
    PK: 'USER#sarah', SK: 'META', userId: 'sarah', name: 'Sarah',
    nameLower: 'sarah', role: 'CASHIER', pinHash: 'stored-hash', isActive: true,
    ...overrides,
  };
}

const cmds = () => mockDbSend.mock.calls.map(c => c[0]);
const gets = () => cmds().filter(c => c.__cmd === 'Get');
const scans = () => cmds().filter(c => c.__cmd === 'Scan');
const updates = () => cmds().filter(c => c.__cmd === 'Update');

/** The single outcome passed to logAuth, e.g. 'SUCCESS'. */
const loggedOutcome = () => mockLogAuth.mock.calls[0]?.[0];
const loggedExtra = () => mockLogAuth.mock.calls[0]?.[1];

beforeEach(() => {
  mockDbSend.mockReset();
  mockComparePin.mockReset();
  mockSignToken.mockReset();
  mockHashPin.mockReset();
  mockVerifyToken.mockReset();
  mockLogAuth.mockReset();
  mockSignToken.mockReturnValue(TOKEN);
  mockHashPin.mockReturnValue('new-hash');
});

// ─── POST /api/auth/login — request validation ───────────────────────

describe('POST /api/auth/login — missing fields', () => {
  it('returns 400 when userId is absent, and never touches the table', async () => {
    const res = await handleAuth(loginEvent({ pin: '907531' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'userId and pin required' });
    expect(mockDbSend).not.toHaveBeenCalled();
    expect(mockComparePin).not.toHaveBeenCalled();
  });

  it('returns 400 when pin is absent', async () => {
    const res = await handleAuth(loginEvent({ userId: 'sarah' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('userId and pin required');
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty body at all', async () => {
    const res = await handleAuth(makeEvent({ body: null }));
    expect(res.statusCode).toBe(400);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('audits the rejection as (none) rather than leaking a blank id', async () => {
    await handleAuth(loginEvent({ pin: '907531' }));
    expect(loggedOutcome()).toBe('REJECT_MISSING_FIELDS');
    expect(loggedExtra()).toEqual({ id: '(none)', ip: IP, ua: UA });
  });

  it('audits the submitted id when it was the PIN that was missing', async () => {
    await handleAuth(loginEvent({ userId: '  Sarah  ' }));
    expect(loggedOutcome()).toBe('REJECT_MISSING_FIELDS');
    expect(loggedExtra().id).toBe('sarah');
  });

  it('never passes the PIN to the audit log', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: userRecord() }).mockResolvedValue({});
    mockComparePin.mockReturnValue(true);
    await handleAuth(loginEvent({ userId: 'sarah', pin: '907531' }));
    expect(JSON.stringify(mockLogAuth.mock.calls)).not.toContain('907531');
  });
});

// ─── The blocklist gates ─────────────────────────────────────────────

describe('POST /api/auth/login — blocked submitted identifier', () => {
  it('refuses before any lookup and answers exactly like bad credentials', async () => {
    const res = await handleAuth(loginEvent({ userId: 'Admin', pin: '907531' }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid credentials' });

    // The security property: no Get, no Scan, no PIN comparison. A lookup here
    // would reintroduce the timing signal the gate exists to remove.
    expect(mockDbSend).not.toHaveBeenCalled();
    expect(mockComparePin).not.toHaveBeenCalled();
    expect(mockSignToken).not.toHaveBeenCalled();
  });

  it('audits it as BLOCKED_IDENTIFIER with the normalised id, ip and ua', async () => {
    await handleAuth(loginEvent({ userId: '  ADMIN-001 ', pin: '907531' }));
    expect(loggedOutcome()).toBe('BLOCKED_IDENTIFIER');
    expect(loggedExtra()).toEqual({ id: 'admin-001', ip: IP, ua: UA });
  });
});

describe('POST /api/auth/login — blocked resolved user', () => {
  /** Stage a direct-Get hit returning `user`. */
  function stageDirect(user: any) {
    mockDbSend.mockResolvedValueOnce({ Item: user }).mockResolvedValue({});
    mockComparePin.mockReturnValue(true);
  }

  it('refuses a blocked account reached under a benign alias (userId)', async () => {
    // The submitted identifier is clean, so gate 1 passes; the RECORD is the
    // blocked one. Correct PIN staged, so only the gate can produce the 401.
    stageDirect(userRecord({ userId: 'admin-001', nameLower: 'helper', name: 'Helper' }));
    const res = await handleAuth(loginEvent({ userId: 'helper', pin: '907531' }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid credentials' });
    expect(mockSignToken).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);            // no lastLoginAt written
    expect(loggedOutcome()).toBe('BLOCKED_RESOLVED_USER');
    expect(loggedExtra()).toEqual({ id: 'helper', resolved: 'admin-001', ip: IP, ua: UA });
  });

  it('refuses when only nameLower is blocked', async () => {
    stageDirect(userRecord({ userId: 'u-42', nameLower: 'administrator', name: 'Helper' }));
    const res = await handleAuth(loginEvent({ userId: 'u-42', pin: '907531' }));
    expect(res.statusCode).toBe(401);
    expect(loggedOutcome()).toBe('BLOCKED_RESOLVED_USER');
  });

  it('refuses when only the display name is blocked', async () => {
    stageDirect(userRecord({ userId: 'u-42', nameLower: 'helper', name: 'Admin Backup' }));
    const res = await handleAuth(loginEvent({ userId: 'u-42', pin: '907531' }));
    expect(res.statusCode).toBe(401);
    expect(loggedOutcome()).toBe('BLOCKED_RESOLVED_USER');
  });

  it('lets a clean record through even with absent/blank alias fields', async () => {
    // Exercises the gate's non-string and empty-after-trim paths through the
    // route: a record with no nameLower and a whitespace-only name must not
    // throw and must not be treated as blocked.
    const { nameLower, ...noNameLower } = userRecord({ name: '   ' });
    stageDirect(noNameLower);
    const res = await handleAuth(loginEvent({ userId: 'sarah', pin: '907531' }));
    expect(res.statusCode).toBe(200);
    expect(loggedOutcome()).toBe('SUCCESS');
  });
});

// ─── User resolution: direct Get, then the nameLower fallback ────────

describe('POST /api/auth/login — user resolution', () => {
  it('resolves by direct Get on USER#<lowercased id> and issues NO scan', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: userRecord() }).mockResolvedValue({});
    mockComparePin.mockReturnValue(true);

    const res = await handleAuth(loginEvent({ userId: '  SARAH  ', pin: '907531' }));
    expect(res.statusCode).toBe(200);

    expect(gets()).toHaveLength(1);
    expect(gets()[0].TableName).toBe('test-users');
    expect(gets()[0].Key).toEqual({ PK: 'USER#sarah', SK: 'META' });
    // The O(1) path must not also pay for a table scan.
    expect(scans()).toHaveLength(0);
  });

  it('falls back to the nameLower scan when the direct Get misses', async () => {
    mockDbSend
      .mockResolvedValueOnce({})                                   // Get — miss
      .mockResolvedValueOnce({ Items: [userRecord()] })            // Scan — hit
      .mockResolvedValue({});
    mockComparePin.mockReturnValue(true);

    const res = await handleAuth(loginEvent({ userId: 'Sarah', pin: '907531' }));
    expect(res.statusCode).toBe(200);

    expect(scans()).toHaveLength(1);
    const scan = scans()[0];
    expect(scan.TableName).toBe('test-users');
    expect(scan.FilterExpression).toBe('nameLower = :name AND isActive = :active');
    expect(scan.ExpressionAttributeValues).toEqual({ ':name': 'sarah', ':active': true });
  });

  it('falls back to the scan when the direct Get returns an INACTIVE record', async () => {
    // A deactivated volunteer must not be logged in by the fast path.
    mockDbSend
      .mockResolvedValueOnce({ Item: userRecord({ isActive: false }) })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValue({});

    const res = await handleAuth(loginEvent({ userId: 'sarah', pin: '907531' }));
    expect(scans()).toHaveLength(1);
    expect(res.statusCode).toBe(401);
    expect(mockComparePin).not.toHaveBeenCalled();
  });

  it('returns 401 when neither lookup finds anyone', async () => {
    mockDbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValue({});

    const res = await handleAuth(loginEvent({ userId: 'nobody', pin: '907531' }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid credentials' });
    expect(loggedOutcome()).toBe('FAIL');
    expect(loggedExtra()).toEqual({ id: 'nobody', reason: 'no-such-user', ip: IP, ua: UA });
  });

  it('treats an absent Items array from the scan as no user', async () => {
    mockDbSend.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValue({});
    const res = await handleAuth(loginEvent({ userId: 'nobody', pin: '907531' }));
    expect(res.statusCode).toBe(401);
    expect(loggedExtra().reason).toBe('no-such-user');
  });
});

// ─── Wrong PIN ───────────────────────────────────────────────────────

describe('POST /api/auth/login — wrong PIN', () => {
  it('returns 401 with the same body as an unknown user, audited as bad-pin', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: userRecord() }).mockResolvedValue({});
    mockComparePin.mockReturnValue(false);

    const res = await handleAuth(loginEvent({ userId: 'sarah', pin: '000000' }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid credentials' });

    expect(mockComparePin).toHaveBeenCalledWith('000000', 'stored-hash');
    expect(mockSignToken).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);

    // Only the audit line distinguishes the two 401s — the response must not.
    expect(loggedOutcome()).toBe('FAIL');
    expect(loggedExtra()).toEqual({ id: 'sarah', reason: 'bad-pin', ip: IP, ua: UA });
  });
});

// ─── Success ─────────────────────────────────────────────────────────

describe('POST /api/auth/login — success', () => {
  it('issues a token, stamps lastLoginAt, and returns the full response shape', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: userRecord() }).mockResolvedValue({});
    mockComparePin.mockReturnValue(true);

    const before = new Date().toISOString();
    const res = await handleAuth(loginEvent({ userId: 'sarah', pin: '907531' }));
    expect(res.statusCode).toBe(200);

    expect(JSON.parse(res.body)).toEqual({
      token: TOKEN,
      userId: 'sarah',
      name: 'Sarah',
      role: 'CASHIER',
      forceUpdatePin: false,
      onboardingComplete: false,
      onboardingProgress: [],
    });

    // The token claims come from the RECORD, never from the submitted body.
    expect(mockSignToken).toHaveBeenCalledWith({ userId: 'sarah', name: 'Sarah', role: 'CASHIER' });

    const update = updates()[0];
    expect(update.TableName).toBe('test-users');
    expect(update.Key).toEqual({ PK: 'USER#sarah', SK: 'META' });
    expect(update.UpdateExpression).toBe('SET lastLoginAt = :now');
    expect(update.ExpressionAttributeValues[':now'] >= before).toBe(true);

    expect(loggedOutcome()).toBe('SUCCESS');
    expect(loggedExtra()).toEqual({ id: 'sarah', name: 'Sarah', role: 'CASHIER', ip: IP, ua: UA });
  });

  it('keys the lastLoginAt update off the RECORD PK/SK, not the submitted id', async () => {
    // A user resolved by the nameLower fallback has a PK unrelated to what was
    // typed; writing USER#<typed> would create a phantom row.
    mockDbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [userRecord({ PK: 'USER#u-42', SK: 'META', userId: 'u-42' })] })
      .mockResolvedValue({});
    mockComparePin.mockReturnValue(true);

    const res = await handleAuth(loginEvent({ userId: 'Sarah', pin: '907531' }));
    expect(res.statusCode).toBe(200);
    expect(updates()[0].Key).toEqual({ PK: 'USER#u-42', SK: 'META' });
    expect(JSON.parse(res.body).userId).toBe('u-42');
  });

  it('passes forceUpdatePin through as a real boolean, not the stored value', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: userRecord({ forceUpdatePin: 'yes' }) }).mockResolvedValue({});
    mockComparePin.mockReturnValue(true);

    const res = await handleAuth(loginEvent({ userId: 'sarah', pin: '907531' }));
    expect(JSON.parse(res.body).forceUpdatePin).toBe(true);
  });

  it('returns stored onboarding state when the record carries it', async () => {
    mockDbSend.mockResolvedValueOnce({
      Item: userRecord({ role: 'ADMIN', onboardingComplete: true, onboardingProgress: ['menu', 'orders'] }),
    }).mockResolvedValue({});
    mockComparePin.mockReturnValue(true);

    const res = await handleAuth(loginEvent({ userId: 'sarah', pin: '907531' }));
    const body = JSON.parse(res.body);
    expect(body.onboardingComplete).toBe(true);
    expect(body.onboardingProgress).toEqual(['menu', 'orders']);
    expect(body.role).toBe('ADMIN');
  });

  it('emits exactly one audit line per attempt', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: userRecord() }).mockResolvedValue({});
    mockComparePin.mockReturnValue(true);
    await handleAuth(loginEvent({ userId: 'sarah', pin: '907531' }));
    expect(mockLogAuth).toHaveBeenCalledTimes(1);
  });
});

// ─── Request metadata for the audit trail ────────────────────────────

describe('POST /api/auth/login — audit metadata', () => {
  it('reads a lowercase user-agent header when the canonical casing is absent', async () => {
    const res = await handleAuth(makeEvent({
      body: JSON.stringify({ userId: 'Admin', pin: '907531' }),
      headers: { 'user-agent': 'curl/8.0' },
    }));
    expect(res.statusCode).toBe(401);
    expect(loggedExtra().ua).toBe('curl/8.0');
  });

  it('survives a missing requestContext and missing headers entirely', async () => {
    const res = await handleAuth({
      httpMethod: 'POST', path: '/api/auth/login',
      body: JSON.stringify({ userId: 'Admin', pin: '907531' }),
    } as any);
    expect(res.statusCode).toBe(401);
    expect(loggedExtra().ip).toBeUndefined();
    expect(loggedExtra().ua).toBeUndefined();
  });
});

// ─── POST /api/auth/update-pin ───────────────────────────────────────

describe('POST /api/auth/update-pin', () => {
  it('returns 401 when the Authorization header is absent', async () => {
    mockVerifyToken.mockImplementation(() => { throw new Error('jwt must be provided'); });
    const res = await handleAuth(makeEvent({
      path: '/api/auth/update-pin',
      body: JSON.stringify({ newPin: '482260' }),
      headers: {},
    }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    expect(mockDbSend).not.toHaveBeenCalled();
    expect(mockHashPin).not.toHaveBeenCalled();
  });

  it('returns 401 when the token does not verify', async () => {
    mockVerifyToken.mockImplementation(() => { throw new Error('invalid signature'); });
    const res = await handleAuth(updatePinEvent({ newPin: '482260' }, 'tampered.jwt.here'));
    expect(res.statusCode).toBe(401);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('strips the Bearer prefix before verifying', async () => {
    mockVerifyToken.mockReturnValue({ userId: 'sarah', name: 'Sarah', role: 'CASHIER' });
    mockDbSend.mockResolvedValue({});
    await handleAuth(updatePinEvent({ newPin: '482260' }));
    expect(mockVerifyToken).toHaveBeenCalledWith(TOKEN);
  });

  it('accepts a lowercase authorization header too', async () => {
    mockVerifyToken.mockReturnValue({ userId: 'sarah', name: 'Sarah', role: 'CASHIER' });
    mockDbSend.mockResolvedValue({});
    const res = await handleAuth(updatePinEvent({ newPin: '482260' }, TOKEN, 'authorization'));
    expect(res.statusCode).toBe(200);
    expect(mockVerifyToken).toHaveBeenCalledWith(TOKEN);
  });

  it('returns 400 when newPin is missing, and writes nothing', async () => {
    mockVerifyToken.mockReturnValue({ userId: 'sarah', name: 'Sarah', role: 'CASHIER' });
    const res = await handleAuth(updatePinEvent(null));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'newPin required (min 6 digits)' });
    expect(mockDbSend).not.toHaveBeenCalled();
    expect(mockHashPin).not.toHaveBeenCalled();
  });

  it('returns 400 for a newPin shorter than 6 digits', async () => {
    mockVerifyToken.mockReturnValue({ userId: 'sarah', name: 'Sarah', role: 'CASHIER' });
    for (const bad of ['1', '12345']) {
      mockDbSend.mockReset();
      const res = await handleAuth(updatePinEvent({ newPin: bad }));
      expect(res.statusCode).toBe(400);
      expect(mockDbSend).not.toHaveBeenCalled();
    }
  });

  it('measures the length of a NUMERIC newPin by its string form', async () => {
    mockVerifyToken.mockReturnValue({ userId: 'sarah', name: 'Sarah', role: 'CASHIER' });
    mockDbSend.mockResolvedValue({});
    expect((await handleAuth(updatePinEvent({ newPin: 12345 }))).statusCode).toBe(400);
    expect((await handleAuth(updatePinEvent({ newPin: 482260 }))).statusCode).toBe(200);
  });

  it('hashes the new PIN, clears forceUpdatePin, and keys off the TOKEN', async () => {
    mockVerifyToken.mockReturnValue({ userId: 'sarah', name: 'Sarah', role: 'CASHIER' });
    mockDbSend.mockResolvedValue({});

    const res = await handleAuth(updatePinEvent({ newPin: '482260' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    // The identity comes from the verified token, never from the body — or one
    // volunteer could reset another's PIN.
    expect(mockHashPin).toHaveBeenCalledWith('482260');
    const update = updates()[0];
    expect(update.TableName).toBe('test-users');
    expect(update.Key).toEqual({ PK: 'USER#sarah', SK: 'META' });
    expect(update.UpdateExpression).toBe('SET pinHash = :ph, forceUpdatePin = :f');
    expect(update.ExpressionAttributeValues).toEqual({ ':ph': 'new-hash', ':f': false });
  });

  it('never stores the raw PIN', async () => {
    mockVerifyToken.mockReturnValue({ userId: 'sarah', name: 'Sarah', role: 'CASHIER' });
    mockDbSend.mockResolvedValue({});
    await handleAuth(updatePinEvent({ newPin: '482260' }));
    expect(JSON.stringify(updates()[0])).not.toContain('482260');
  });

  it('ignores a userId supplied in the body', async () => {
    mockVerifyToken.mockReturnValue({ userId: 'sarah', name: 'Sarah', role: 'CASHIER' });
    mockDbSend.mockResolvedValue({});
    await handleAuth(updatePinEvent({ newPin: '482260', userId: 'someone-else' }));
    expect(updates()[0].Key.PK).toBe('USER#sarah');
  });
});

// ─── Dispatch ────────────────────────────────────────────────────────

describe('handleAuth dispatch', () => {
  it('returns 404 for an unknown path under /api/auth', async () => {
    const res = await handleAuth(makeEvent({ path: '/api/auth/logout' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('returns 404 for the right path with the wrong method', async () => {
    for (const httpMethod of ['GET', 'PUT', 'DELETE']) {
      for (const path of ['/api/auth/login', '/api/auth/update-pin']) {
        const res = await handleAuth(makeEvent({ httpMethod, path, body: JSON.stringify({}) }));
        expect(res.statusCode).toBe(404);
      }
    }
    expect(mockDbSend).not.toHaveBeenCalled();
    expect(mockLogAuth).not.toHaveBeenCalled();
  });

  it('does not treat a path that merely contains /api/auth/login as a login', async () => {
    const res = await handleAuth(makeEvent({
      path: '/api/auth/login/extra',
      body: JSON.stringify({ userId: 'sarah', pin: '907531' }),
    }));
    expect(res.statusCode).toBe(404);
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
