/**
 * The admin USERS and SETTINGS routes in `backend/src/routes/admin.ts`. Menu /
 * ingredients / recipes are covered by `admin-catalog.test.ts`; reports and the
 * misc tail (verses, display, pre-order templates, stock history) are covered
 * elsewhere. `admin.ts` is ~1030 lines and is being covered one sub-resource per
 * suite.
 *
 * Four things are load-bearing and each is the reason a test below exists:
 *
 * 1. **A PIN must never be stored, only its hash.** `hashPin` is stubbed with a
 *    recognisable return (`HASH(<pin>)`), so the assertion is that the value the
 *    handler wrote CAME FROM `hashPin` — and, separately, that the raw PIN
 *    appears nowhere in the `Item` or in the 201 response. A test that only
 *    checked `pinHash` was set would pass if the handler stored the PIN itself.
 *    The stub also reproduces real `bcryptjs` faithfully: `hashSync(123456, 10)`
 *    throws `Illegal arguments: number, string` (verified against the installed
 *    bcryptjs), which is what makes the numeric-PIN case below a real 500.
 *
 * 2. **Two write paths reach `hashPin`, and they validate differently.** `POST`
 *    demands ≥ 6 digits before anything else; `PUT` only checks length when a
 *    `pin` key is present, and must strip `pin` from the update expression so
 *    the plaintext is not persisted alongside the hash. Both are pinned, in both
 *    directions. `PUT` also strips any caller-supplied `pinHash` before building
 *    the expression — the field is derived, never accepted — including when it is
 *    sent alongside a `pin` in the hope of landing last.
 *
 * 3. **Path-matching order.** `PUT /admin/users/{id}` uses an unanchored
 *    `/\/admin\/users\/[^/]+$/`, and `PUT /admin/users/{id}/reset-onboarding` is
 *    tested AFTER it. The only thing keeping the two apart is that `[^/]+$`
 *    cannot cross a slash. The teeth are the SHAPE of the command: reset-onboarding
 *    emits a FIXED `SET onboardingComplete = :c, onboardingProgress = :p`, the
 *    generic branch builds `SET #k = :k` from the body. Those cannot be confused,
 *    so an assertion on one cannot pass for the other.
 *
 * 4. **`PUT /admin/settings` validates `openingHours` BEFORE its write.** The
 *    exhaustive rule-by-rule table lives in `opening-hours-routes.test.ts`; what
 *    is pinned here is the branch itself — one rejection (nothing written) and
 *    one acceptance (the NORMALISED value written) — plus the fact that every
 *    other settings key is written through with no validation at all.
 *
 * Assertions are on what the handler produced: the `Item`, the
 * `UpdateExpression` / `ExpressionAttributeValues`, the `Key`, the parsed
 * response — never on the fixture this file constructed.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked; `hashPin` is stubbed and the S3 client `admin.ts` builds at
 * import time is mocked too. No network, no credentials, nothing written to
 * production — so no `ZZTEST_` marker applies (that rule covers suites that
 * create real records).
 */

import { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbSend = jest.fn();
const mockHashPin = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  SETTINGS_TABLE: 'test-settings',
  INGREDIENTS_TABLE: 'test-ingredients',
  USERS_TABLE: 'test-users',
  CUSTOMERS_TABLE: 'test-customers',
  VOUCHERS_TABLE: 'test-vouchers',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
  DeleteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Delete' })),
}));

// Only `hashPin` is replaced. The rest of `lib/auth` stays real because
// `routes/auth` (imported by `admin.ts` for `isBlockedIdentifier`) pulls
// `signToken` / `verifyToken` from the same module.
jest.mock('../src/lib/auth', () => ({
  ...jest.requireActual('../src/lib/auth'),
  hashPin: (...args: unknown[]) => mockHashPin(...args),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Put' })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://example.invalid/presigned'),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleAdmin } = require('../src/routes/admin');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const GOOD_PIN = '123456';

const CASHIER_ROW = {
  PK: 'USER#u-cashier', SK: 'META', userId: 'u-cashier',
  name: 'Mary Tan', nameLower: 'mary tan', role: 'CASHIER',
  isActive: true, lastLoginAt: '2026-08-16T02:10:00.000Z',
  pinHash: '$2a$10$STOREDHASHFORMARY', forceUpdatePin: false,
  onboardingComplete: true, onboardingProgress: ['tour'],
};

const ADMIN_ROW = {
  PK: 'USER#u-admin', SK: 'META', userId: 'u-admin',
  name: 'Peter Lim', nameLower: 'peter lim', role: 'ADMIN',
  isActive: false, pinHash: '$2a$10$STOREDHASHFORPETER',
};

const SETTINGS_ROW = {
  PK: 'SETTINGS', SK: 'CONFIG',
  cafeStatus: 'OPEN', celebrationMode: true, celebrationPrice: 6,
  featuredDrinkId: 'latte-001', orderExpiryMinutes: 30,
};

const VALID_HOURS = {
  serviceDays: [3, 0],
  sessions: [
    { label: '  After 1st service  ', opensAt: '10:15', closesAt: '11:30', colour: 'red' },
    { label: 'After 2nd service', opensAt: '12:45', closesAt: '13:30' },
  ],
};

// ─── Staging ──────────────────────────────────────────────────────────────────

interface World {
  userRows?: Record<string, unknown>[];
  /** Set to make the users Scan look truncated (>1MB page). */
  scanLastKey?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

/**
 * Answer every read from a described world, keyed on the actual command and
 * `TableName` the handler asked for — not a `mockResolvedValueOnce` queue, which
 * would let a fixture silently fill the wrong slot (`invariants`, Test teeth).
 */
function stage(world: World = {}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-users') {
      return { Items: world.userRows, LastEvaluatedKey: world.scanLastKey };
    }
    if (cmd.__cmd === 'Get' && cmd.TableName === 'test-settings') {
      return world.settings === undefined ? {} : { Item: world.settings };
    }
    return {};
  });
}

function makeEvent(overrides: Record<string, unknown> = {}): APIGatewayProxyEvent {
  const { body, ...rest } = overrides as any;
  return {
    httpMethod: 'GET',
    path: '/api/admin/users',
    body: body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...rest,
  } as unknown as APIGatewayProxyEvent;
}

/** Every command the handler sent, in order. */
function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function sent(kind: string, table?: string) {
  return cmds().filter((c) => c.__cmd === kind && (table === undefined || c.TableName === table));
}
function writes() {
  return cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd));
}

/** Call the handler and return `[statusCode, parsedBody]`. */
async function call(event: APIGatewayProxyEvent): Promise<[number, any]> {
  const r = await handleAdmin(event);
  expect(r.headers).toEqual({ 'Content-Type': 'application/json' });
  return [r.statusCode, JSON.parse(r.body)];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  stage();
  mockHashPin.mockReset();
  // Faithful to the installed bcryptjs: `hashSync(123456, 10)` throws
  // `Illegal arguments: number, string`. Verified, not assumed — it is what
  // makes the numeric-PIN test below a genuine 500 rather than a mock artefact.
  mockHashPin.mockImplementation((pin: unknown) => {
    if (typeof pin !== 'string') throw new Error(`Illegal arguments: ${typeof pin}, string`);
    return `HASH(${pin})`;
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/users
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/users', () => {
  it('projects five fields and NEVER the PIN hash', async () => {
    // The teeth: the fixtures carry `pinHash` and `forceUpdatePin`. This route
    // feeds the admin Users tab in a browser, so the projection is the only thing
    // keeping every volunteer's bcrypt hash off the wire.
    stage({ userRows: [CASHIER_ROW, ADMIN_ROW] });

    const r = await handleAdmin(makeEvent());

    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('STOREDHASHFORMARY');
    expect(r.body).not.toContain('pinHash');
    const { users } = JSON.parse(r.body);
    expect(users).toEqual([
      {
        userId: 'u-cashier', name: 'Mary Tan', role: 'CASHIER',
        isActive: true, lastLoginAt: '2026-08-16T02:10:00.000Z',
      },
      // `lastLoginAt` is absent on this row, so JSON.stringify drops the key —
      // the frontend must treat missing as "never logged in".
      { userId: 'u-admin', name: 'Peter Lim', role: 'ADMIN', isActive: false },
    ]);
  });

  it('returns an empty list when the table has no rows', async () => {
    stage({ userRows: undefined });
    const [status, body] = await call(makeEvent());
    expect(status).toBe(200);
    expect(body).toEqual({ users: [] });
  });

  it('sends exactly one Scan of the users table, filtered to USER# rows', async () => {
    stage({ userRows: [CASHIER_ROW] });
    await call(makeEvent());

    const scans = sent('Scan', 'test-users');
    expect(scans).toHaveLength(1);
    // The Scan used to be unfiltered. That stopped being harmless when the
    // passkey feature put `PASSKEY_CRED#<id>/META` rows on this same table:
    // unfiltered, each one is listed as a phantom user, and deleting the phantom
    // takes the real owner's account with it.
    expect(scans[0].FilterExpression).toBe('begins_with(PK, :userPk)');
    expect(scans[0].ExpressionAttributeValues).toEqual({ ':userPk': 'USER#' });
    expect(writes()).toHaveLength(0);
  });

  it('DEFECT: a truncated Scan is silently short — LastEvaluatedKey is ignored', async () => {
    // admin.ts:233 does a single `ScanCommand` with no ExclusiveStartKey loop, so
    // a users table over the 1MB page limit lists a subset with no indication.
    // Small today (a dozen volunteers); the report route on line 389 does
    // paginate, so the pattern for a fix already exists in this file.
    stage({ userRows: [CASHIER_ROW], scanLastKey: { PK: 'USER#u-cashier', SK: 'META' } });

    const [status, body] = await call(makeEvent());

    expect(status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(sent('Scan', 'test-users')).toHaveLength(1); // no follow-up page
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/admin/users
// ══════════════════════════════════════════════════════════════════════════════

function createEvent(body: Record<string, unknown>) {
  return makeEvent({ httpMethod: 'POST', path: '/api/admin/users', body });
}

describe('POST /api/admin/users', () => {
  it('hashes the PIN through hashPin and stores the HASH, never the PIN', async () => {
    const [status, body] = await call(createEvent({
      name: 'Grace Wong', role: 'CASHIER', pin: GOOD_PIN,
    }));

    expect(mockHashPin).toHaveBeenCalledTimes(1);
    expect(mockHashPin).toHaveBeenCalledWith(GOOD_PIN);

    const puts = sent('Put', 'test-users');
    expect(puts).toHaveLength(1);
    const item = puts[0].Item;
    expect(item.pinHash).toBe(`HASH(${GOOD_PIN})`);
    // Separately from `pinHash` being right: the plaintext must appear NOWHERE.
    expect(JSON.stringify(item)).not.toContain(`"${GOOD_PIN}"`);
    expect(item.pin).toBeUndefined();

    expect(item.userId).toMatch(UUID_V4);
    expect(item.PK).toBe(`USER#${item.userId}`);
    expect(item.SK).toBe('META');
    expect(item.name).toBe('Grace Wong');
    expect(item.nameLower).toBe('grace wong');
    expect(item.role).toBe('CASHIER');
    expect(item.isActive).toBe(true);
    // New accounts are handed out with a shared PIN, so the first login must
    // force a change.
    expect(item.forceUpdatePin).toBe(true);

    expect(status).toBe(201);
    // The response is a deliberate subset — the created record is NOT echoed,
    // so the hash cannot leak this way either.
    expect(body).toEqual({ userId: item.userId, name: 'Grace Wong', role: 'CASHIER' });
  });

  it('derives nameLower lowercased and trimmed, while name keeps the raw spelling', async () => {
    // `nameLower` is what the login fallback Scan matches on (routes/auth.ts:72),
    // so a mismatch here locks the new volunteer out.
    await call(createEvent({ name: '  Ah Meng LEE  ', role: 'CASHIER', pin: GOOD_PIN }));

    const item = sent('Put', 'test-users')[0].Item;
    expect(item.nameLower).toBe('ah meng lee');
    expect(item.name).toBe('  Ah Meng LEE  ');
  });

  it.each([
    ['a missing pin', {}],
    ['an empty pin', { pin: '' }],
    ['a 5-digit pin', { pin: '12345' }],
  ])('rejects %s with 400, and never reaches hashPin or a write', async (_name, patch) => {
    const [status, body] = await call(createEvent({ name: 'Grace Wong', role: 'CASHIER', ...patch }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'pin required (min 6 digits)' });
    expect(mockHashPin).not.toHaveBeenCalled();
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('accepts exactly 6 digits — the boundary is >= 6, not > 6', async () => {
    const [status] = await call(createEvent({ name: 'Grace Wong', role: 'CASHIER', pin: '000000' }));
    expect(status).toBe(201);
    expect(mockHashPin).toHaveBeenCalledWith('000000');
  });

  it.each([
    ['Admin', 'Admin'],
    ['admin (case-insensitive)', 'admin'],
    ['Administrator', '  Administrator  '],
  ])('refuses the reserved name %s at creation time', async (_label, name) => {
    // A volunteer whose name matches BLOCKED_LOGIN_PATTERNS could never log in
    // (routes/auth.ts:50), so creating one produces a permanently unusable
    // account. The refusal has to happen here, not at first login.
    const [status, body] = await call(createEvent({ name, role: 'CASHIER', pin: GOOD_PIN }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'That name is reserved and cannot be used' });
    // The PIN gate runs first, so a valid PIN is present — and still no hashing
    // and no write happen.
    expect(mockHashPin).not.toHaveBeenCalled();
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('DEFECT: a NUMERIC pin is a 500, not a 400', async () => {
    // `String(pin).length` accepts the number 123456, then `hashPin(pin)` hands a
    // number to `bcrypt.hashSync`, which throws `Illegal arguments: number, string`
    // (admin.ts:240 validates the STRINGIFIED length but line 254 passes the raw
    // value). The handler's catch-all turns it into an opaque 500 the admin UI
    // cannot explain. A `typeof pin !== 'string'` arm on the line-240 guard, or a
    // `String(pin)` at line 254, would make it the 400 it should be.
    const [status, body] = await call(createEvent({ name: 'Grace Wong', role: 'CASHIER', pin: 123456 }));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Illegal arguments: number, string' });
    expect(writes()).toHaveLength(0);
  });

  it('DEFECT: name and role are never validated — an unusable record is built', async () => {
    // Only `pin` and the reserved-name pattern are checked (admin.ts:239-248).
    // With `name` and `role` absent the handler builds an Item carrying three
    // `undefined` attributes and reports 201. In production it does not even get
    // that far: `docClient` is created with no `removeUndefinedValues`
    // (lib/db.ts:5), so the real DocumentClient rejects the Put and the caller
    // sees an SDK 500 instead of "name required".
    const [status, body] = await call(createEvent({ pin: GOOD_PIN }));

    const item = sent('Put', 'test-users')[0].Item;
    expect(item.name).toBeUndefined();
    expect(item.nameLower).toBeUndefined();
    expect(item.role).toBeUndefined();
    expect(status).toBe(201);
    expect(body.userId).toMatch(UUID_V4);
  });

  it('passes a non-string name through the nameLower branch untouched', async () => {
    // `typeof body.name === 'string' ? … : body.name` — the guard exists, so a
    // number name does not throw here. It still produces a junk record; see the
    // missing-validation defect above.
    const [status] = await call(createEvent({ name: 42, role: 'CASHIER', pin: GOOD_PIN }));
    expect(status).toBe(201);
    expect(sent('Put', 'test-users')[0].Item.nameLower).toBe(42);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/admin/users/{id}
// ══════════════════════════════════════════════════════════════════════════════

function updateEvent(id: string, body: Record<string, unknown>) {
  return makeEvent({ httpMethod: 'PUT', path: `/api/admin/users/${id}`, body });
}

describe('PUT /api/admin/users/{id}', () => {
  it('builds SET #k = :k from the body, keyed on USER#{id}', async () => {
    const [status, body] = await call(updateEvent('u-cashier', {
      name: 'Mary Tan Ai Ling', role: 'ADMIN', isActive: false,
    }));

    const updates = sent('Update', 'test-users');
    expect(updates).toHaveLength(1);
    expect(updates[0].Key).toEqual({ PK: 'USER#u-cashier', SK: 'META' });
    for (const key of ['name', 'nameLower', 'role', 'isActive']) {
      expect(updates[0].UpdateExpression).toContain(`#${key} = :${key}`);
    }
    expect(updates[0].ExpressionAttributeNames['#role']).toBe('role');
    expect(updates[0].ExpressionAttributeValues[':role']).toBe('ADMIN');
    expect(updates[0].ExpressionAttributeValues[':isActive']).toBe(false);
    // No read first: this route trusts the id and does a blind update.
    expect(sent('Get')).toHaveLength(0);

    expect(status).toBe(200);
    expect(body.userId).toBe('u-cashier');
    expect(body.updated.sort()).toEqual(['isActive', 'nameLower', 'name', 'role'].sort());
  });

  it('turns a pin into pinHash + forceUpdatePin and DROPS the plaintext', async () => {
    const [status, body] = await call(updateEvent('u-cashier', { pin: '654321' }));

    expect(mockHashPin).toHaveBeenCalledTimes(1);
    expect(mockHashPin).toHaveBeenCalledWith('654321');

    const u = sent('Update', 'test-users')[0];
    expect(u.ExpressionAttributeValues[':pinHash']).toBe('HASH(654321)');
    expect(u.ExpressionAttributeValues[':forceUpdatePin']).toBe(true);
    // The `delete updates.pin` on admin.ts:272 is the whole point: without it the
    // plaintext PIN would be written as its own attribute next to the hash.
    expect(u.UpdateExpression).not.toContain('#pin =');
    expect(u.ExpressionAttributeValues[':pin']).toBeUndefined();
    expect(JSON.stringify(u.ExpressionAttributeValues)).not.toContain('"654321"');

    expect(status).toBe(200);
    expect(body.updated.sort()).toEqual(['forceUpdatePin', 'pinHash']);
  });

  it('rejects a short pin with 400 before any write', async () => {
    const [status, body] = await call(updateEvent('u-cashier', { pin: '12345', role: 'ADMIN' }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'pin must be at least 6 digits' });
    expect(mockHashPin).not.toHaveBeenCalled();
    // The sibling `role` change is rejected with it — the request is all or
    // nothing, which is what stops a half-applied update.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('ignores an absent pin key entirely — the guard is presence-gated', async () => {
    const [status] = await call(updateEvent('u-cashier', { isActive: true }));
    expect(status).toBe(200);
    expect(mockHashPin).not.toHaveBeenCalled();
    expect(sent('Update', 'test-users')[0].ExpressionAttributeValues).toEqual({ ':isActive': true });
  });

  it('re-syncs nameLower on a rename, trimmed and lowercased', async () => {
    const [status, body] = await call(updateEvent('u-cashier', { name: '  Mary TAN  ' }));

    const values = sent('Update', 'test-users')[0].ExpressionAttributeValues;
    expect(values[':name']).toBe('  Mary TAN  ');
    expect(values[':nameLower']).toBe('mary tan');
    expect(status).toBe(200);
    // `nameLower` was never in the request body; `updated` reports what was
    // WRITTEN, which includes the derived key.
    expect(body.updated).toContain('nameLower');
  });

  it('does not touch nameLower when name is not a string', async () => {
    await call(updateEvent('u-cashier', { name: null }));
    const values = sent('Update', 'test-users')[0].ExpressionAttributeValues;
    expect(values[':name']).toBeNull();
    expect(values[':nameLower']).toBeUndefined();
  });

  it('refuses a rename to a reserved name with 400 and no write', async () => {
    const [status, body] = await call(updateEvent('u-cashier', { name: 'ADMIN' }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'That name is reserved and cannot be used' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('STRIPS a caller-supplied pinHash — the stored hash is only ever derived', async () => {
    // Regression: the body is spread straight into the UpdateExpression, so
    // `pinHash` used to be just another writable attribute. `pinHash: ''` left an
    // account whose stored hash no bcrypt comparison could match; a
    // caller-generated hash is a PIN the caller knows. The route is
    // admin-authenticated, so it was privilege-widening rather than an open door.
    const [status, body] = await call(updateEvent('u-cashier', { pinHash: 'not-a-bcrypt-hash' }));

    expect(mockHashPin).not.toHaveBeenCalled();
    const u = sent('Update', 'test-users')[0];
    expect(u.UpdateExpression).not.toContain('pinHash');
    expect(u.ExpressionAttributeValues[':pinHash']).toBeUndefined();
    expect(JSON.stringify(u)).not.toContain('not-a-bcrypt-hash');
    // Nothing else was in the body, so the update degenerates to the empty-body
    // shape pinned below — the strip happens before the expression is built.
    expect(status).toBe(200);
    expect(body).toEqual({ userId: 'u-cashier', updated: [] });
  });

  it('a pinHash sent ALONGSIDE a pin cannot override the derived hash', async () => {
    // The dangerous combination: the caller supplies both, hoping the verbatim
    // copy lands last. `hashPin(pin)` must be the only writer of the field.
    const [status] = await call(updateEvent('u-cashier', {
      pin: '654321', pinHash: 'attacker-controlled',
    }));

    expect(status).toBe(200);
    expect(mockHashPin).toHaveBeenCalledWith('654321');
    const u = sent('Update', 'test-users')[0];
    expect(u.ExpressionAttributeValues[':pinHash']).toBe('HASH(654321)');
    expect(JSON.stringify(u)).not.toContain('attacker-controlled');
  });

  it('DEFECT: an EMPTY body builds a malformed `SET ` with no assignments', async () => {
    // `fields` is empty, so `SET ${fields.join(', ')}` is the string `SET ` and
    // `ExpressionAttributeNames` is `{}`. The mock accepts it; the real
    // DynamoDB answers ValidationException, which the catch-all turns into a 500
    // reading "Invalid UpdateExpression". A `if (!fields.length) return res(400, …)`
    // guard is missing here and in `PUT /admin/settings` (same shape, line 335).
    const [status, body] = await call(updateEvent('u-cashier', {}));

    const u = sent('Update', 'test-users')[0];
    expect(u.UpdateExpression).toBe('SET ');
    expect(u.ExpressionAttributeValues).toEqual({});
    expect(status).toBe(200);
    expect(body).toEqual({ userId: 'u-cashier', updated: [] });
  });

  it('does not check that the user exists — a blind update on an unknown id is 200', async () => {
    const [status] = await call(updateEvent('no-such-user', { isActive: false }));
    expect(status).toBe(200);
    // An UpdateCommand with no ConditionExpression UPSERTS: this creates a bare
    // `USER#no-such-user` row carrying only `isActive`. Pinned as current
    // behaviour; a `ConditionExpression: 'attribute_exists(PK)'` would make it 404.
    expect(sent('Update', 'test-users')[0].ConditionExpression).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/admin/users/{id}
// ══════════════════════════════════════════════════════════════════════════════

describe('DELETE /api/admin/users/{id}', () => {
  it('deletes USER#{id}/META and reports the id back', async () => {
    const [status, body] = await call(makeEvent({
      httpMethod: 'DELETE', path: '/api/admin/users/u-cashier',
    }));

    const deletes = sent('Delete', 'test-users');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Key).toEqual({ PK: 'USER#u-cashier', SK: 'META' });
    expect(status).toBe(200);
    expect(body).toEqual({ deleted: 'u-cashier' });
    // No read, no soft-delete: the row is gone. `isActive: false` via PUT is the
    // reversible option, and the admin UI should prefer it.
    expect(sent('Get')).toHaveLength(0);
    expect(sent('Update')).toHaveLength(0);
  });

  it('reports success for an id that never existed', async () => {
    const [status, body] = await call(makeEvent({
      httpMethod: 'DELETE', path: '/api/admin/users/ghost',
    }));
    expect(status).toBe(200);
    expect(body).toEqual({ deleted: 'ghost' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/admin/users/{id}/reset-onboarding
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/admin/users/{id}/reset-onboarding', () => {
  it('clears both onboarding attributes with a FIXED expression', async () => {
    const [status, body] = await call(makeEvent({
      httpMethod: 'PUT', path: '/api/admin/users/u-cashier/reset-onboarding',
    }));

    const updates = sent('Update', 'test-users');
    expect(updates).toHaveLength(1);
    expect(updates[0].Key).toEqual({ PK: 'USER#u-cashier', SK: 'META' });
    expect(updates[0].UpdateExpression)
      .toBe('SET onboardingComplete = :c, onboardingProgress = :p');
    expect(updates[0].ExpressionAttributeValues).toEqual({ ':c': false, ':p': [] });
    // Nothing name-mapped: this is the shape that proves the generic per-id
    // branch did NOT handle the request.
    expect(updates[0].ExpressionAttributeNames).toBeUndefined();

    expect(status).toBe(200);
    expect(body).toEqual({ reset: true });
  });

  it('is NOT swallowed by the generic PUT /admin/users/{id} branch above it', async () => {
    // admin.ts:260 is tested BEFORE line 302, and its regex `\/admin\/users\/[^/]+$`
    // is unanchored — the ONLY reason this path survives is that `[^/]+$` cannot
    // cross the slash before `reset-onboarding`. If someone loosens that regex,
    // this request becomes a body-driven update instead, and with an empty body
    // that is the malformed `SET ` above.
    await call(makeEvent({
      httpMethod: 'PUT', path: '/api/admin/users/u-cashier/reset-onboarding',
      body: { role: 'ADMIN' },
    }));

    const u = sent('Update', 'test-users')[0];
    expect(u.UpdateExpression).not.toContain('#role');
    // A body sent to this route is ignored outright — no privilege change rides in.
    expect(u.ExpressionAttributeValues[':role']).toBeUndefined();
  });

  it('ignores a trailing id that looks like another user', async () => {
    // `extractId` takes the segment AFTER the first `users`, so the id is the
    // path param and never the literal `reset-onboarding`.
    await call(makeEvent({
      httpMethod: 'PUT', path: '/api/admin/users/u-admin/reset-onboarding',
    }));
    expect(sent('Update', 'test-users')[0].Key.PK).toBe('USER#u-admin');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/settings
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/settings', () => {
  it('returns the stored CONFIG record as-is', async () => {
    stage({ settings: SETTINGS_ROW });

    const [status, body] = await call(makeEvent({ path: '/api/admin/settings' }));

    const gets = sent('Get', 'test-settings');
    expect(gets).toHaveLength(1);
    expect(gets[0].Key).toEqual({ PK: 'SETTINGS', SK: 'CONFIG' });
    expect(status).toBe(200);
    // Unprojected: the raw item including its PK/SK. Anything ever added to this
    // record is published to the admin UI by default, so a secret must not live
    // here.
    expect(body).toEqual(SETTINGS_ROW);
  });

  it('returns an empty object when the record does not exist yet', async () => {
    stage({ settings: undefined });
    const [status, body] = await call(makeEvent({ path: '/api/admin/settings' }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/admin/settings
// ══════════════════════════════════════════════════════════════════════════════
// The rule-by-rule `validateOpeningHours` table lives in
// `opening-hours-routes.test.ts`. What is pinned here is the branch inside
// `admin.ts`: rejection writes nothing, acceptance writes the NORMALISED value,
// and every other key is written through unvalidated.

function settingsPut(body: unknown) {
  return makeEvent({ httpMethod: 'PUT', path: '/api/admin/settings', body });
}

describe('PUT /api/admin/settings', () => {
  it('writes each body key as its own SET clause on SETTINGS/CONFIG', async () => {
    const [status, body] = await call(settingsPut({
      cafeStatus: 'CLOSED', celebrationMode: true, celebrationPrice: 6,
    }));

    const updates = sent('Update', 'test-settings');
    expect(updates).toHaveLength(1);
    expect(updates[0].Key).toEqual({ PK: 'SETTINGS', SK: 'CONFIG' });
    expect(updates[0].ExpressionAttributeValues).toEqual({
      ':cafeStatus': 'CLOSED', ':celebrationMode': true, ':celebrationPrice': 6,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ updated: ['cafeStatus', 'celebrationMode', 'celebrationPrice'] });
  });

  it('validates openingHours BEFORE the write — a rejection persists nothing', async () => {
    const [status, body] = await call(settingsPut({
      celebrationPrice: 6,
      openingHours: { serviceDays: [0], sessions: [] },
    }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'openingHours.sessions must list at least one session' });
    // "No error thrown" is not an assertion — the write must not have happened,
    // and the valid sibling key must not have been written either.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('persists a valid openingHours NORMALISED, not as submitted', async () => {
    const [status, body] = await call(settingsPut({ openingHours: VALID_HOURS }));

    expect(status).toBe(200);
    expect(body).toEqual({ updated: ['openingHours'] });
    const written = sent('Update', 'test-settings')[0]
      .ExpressionAttributeValues[':openingHours'];
    // Days sorted, labels trimmed, unknown session keys (`colour`) dropped —
    // asserted on what the handler built, not on the fixture above.
    expect(written).toEqual({
      serviceDays: [0, 3],
      sessions: [
        { label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' },
        { label: 'After 2nd service', opensAt: '12:45', closesAt: '13:30' },
      ],
    });
    expect(written).not.toEqual(VALID_HOURS);
  });

  it('reports the RAW body keys in `updated` while writing the normalised value', async () => {
    // `res(200, { updated: Object.keys(body) })` reads the pre-normalisation
    // body — harmless, but it means `updated` is a list of what was asked for.
    const [, body] = await call(settingsPut({ openingHours: VALID_HOURS, cafeStatus: 'OPEN' }));
    expect(body.updated).toEqual(['openingHours', 'cafeStatus']);
  });

  it('DEFECT: every key EXCEPT openingHours is written with no validation', async () => {
    // Commented as a known follow-up at admin.ts:327. `cafeStatus` is the one that
    // matters: `routes/orders.ts` compares it to the literal `'OPEN'`, so this
    // typo silently leaves the café shut with the admin UI showing a saved value.
    const [status] = await call(settingsPut({ cafeStatus: 'OPEM', celebrationPrice: -99 }));

    expect(status).toBe(200);
    const values = sent('Update', 'test-settings')[0].ExpressionAttributeValues;
    expect(values[':cafeStatus']).toBe('OPEM');
    expect(values[':celebrationPrice']).toBe(-99);
  });

  it('DEFECT: an EMPTY body builds the same malformed `SET ` as the users route', async () => {
    const [status, body] = await call(settingsPut({}));
    const u = sent('Update', 'test-settings')[0];
    expect(u.UpdateExpression).toBe('SET ');
    expect(u.ExpressionAttributeNames).toEqual({});
    expect(status).toBe(200);
    expect(body).toEqual({ updated: [] });
  });

  it('does not confuse /admin/settings/preorder-templates with the generic settings PUT', async () => {
    // `path.endsWith('/admin/settings')` is a literal suffix test, so the
    // templates sub-path falls through to its own branch further down the file
    // (admin.ts:778) — which writes a whole Item rather than a SET expression.
    const [status] = await call(settingsPut({ collectionOptions: ['After 1st Service'] }));
    expect(status).toBe(200);

    stage();
    const [tplStatus] = await call(makeEvent({
      httpMethod: 'PUT', path: '/api/admin/settings/preorder-templates',
      body: { bannerMessage: 'x', collectionOptions: ['After 1st Service'] },
    }));
    expect(tplStatus).toBe(200);
    expect(sent('Update', 'test-settings')).toHaveLength(0);
    expect(sent('Put', 'test-settings')).toHaveLength(1);
  });
});
