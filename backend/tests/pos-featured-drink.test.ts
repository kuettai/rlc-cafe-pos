/**
 * `backend/src/routes/pos.ts` — the FEATURED-DRINK sub-action only.
 *
 *   GET    /api/pos/featured-drink   (CASHIER/ADMIN — read the current pick)
 *   PUT    /api/pos/featured-drink   (CASHIER/ADMIN — set it, audited)
 *   DELETE /api/pos/featured-drink   (CASHIER/ADMIN — clear it, audited)
 *
 * A fixed path with no path parameter, so nothing here exercises the dispatcher's
 * `event.path` parsing; `router.test.ts` covers the dispatch itself. What is
 * pinned here:
 *
 *  1. **The read is defensive in two independent ways.** No `featuredDrinkId` on
 *     the settings row AND a `featuredDrinkId` pointing at a menu item that has
 *     since been deleted both answer `200 {featured:null}`, never a 404 and never
 *     a half-populated object. The customer display polls this endpoint on a
 *     loop; a 404 there would put an error state on the screen in the café for a
 *     condition that is simply "nothing featured today".
 *  2. **The audit partition key is the MALAYSIAN calendar date.** `closeCafe`
 *     writes the matching `UNFEATURE` row under `FEATURED_AUDIT#{malaysiaToday()}`,
 *     so a UTC day here would file a pre-08:00-MYT change under yesterday's
 *     partition and split one service's FEATURE/UNFEATURE pair across two. The
 *     clock is pinned with fake timers rather than read from the wall so the
 *     08:00-MYT boundary can be asserted from both sides.
 *  3. **Writes are ordered settings-then-audit,** and the settings Update is a
 *     plain `SET` on the singleton `SETTINGS/CONFIG` row — deliberately an upsert,
 *     because that row may not exist on a fresh table.
 *
 * `lib/db` and `lib/audit` are fully mocked — no network, no credentials, nothing
 * written to production, so no `ZZTEST_` marker applies.
 */

import { APIGatewayProxyEvent } from 'aws-lambda';
import { malaysiaToday } from '../src/lib/date';

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

jest.mock('../src/lib/audit', () => ({
  logOrder: jest.fn(),
  summarizeItems: (items: any) => (Array.isArray(items) ? items : []).map((i: any) => i.name).join(', '),
}));

jest.mock('../src/lib/push', () => ({ sendOrderPush: jest.fn().mockResolvedValue(undefined) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePos } = require('../src/routes/pos');

// ─── Helpers ─────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/api/pos/featured-drink',
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    body: null,
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEvent;
}

const PATH = '/api/pos/featured-drink';

function get() {
  return handlePos(makeEvent({ httpMethod: 'GET', path: PATH }), '');
}
function put(body: any, actor = 'Sarah') {
  return handlePos(makeEvent({ httpMethod: 'PUT', path: PATH, body: body === null ? null : JSON.stringify(body) }), actor);
}
function del(actor = 'Sarah') {
  return handlePos(makeEvent({ httpMethod: 'DELETE', path: PATH }), actor);
}

/** Every command handed to the mocked docClient, in call order. */
function cmds() {
  return mockDbSend.mock.calls.map((c) => c[0]);
}
function settingsUpdates() {
  return cmds().filter((c) => c.__cmd === 'Update' && c.TableName === 'test-settings');
}
function auditPuts() {
  return cmds().filter((c) => c.__cmd === 'Put' && String(c.Item?.PK || '').startsWith('FEATURED_AUDIT#'));
}

// ─── Fixtures ────────────────────────────────────────────────────────

const LATTE = {
  PK: 'MENU#latte', SK: 'META',
  menuItemId: 'latte', name: 'Latte', basePrice: 8,
  imageUrl: 'https://example.test/latte.jpg', category: 'DRINK',
};

/** Sunday 16 Aug 2026, noon in the café. */
const SUNDAY_NOON_MYT = new Date('2026-08-16T04:00:00Z');
/** Sunday 16 Aug 2026, 07:00 in the café — still 15 Aug in UTC. */
const SUNDAY_0700_MYT = new Date('2026-08-15T23:00:00Z');

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.setSystemTime(SUNDAY_NOON_MYT);
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
});

// ═════════════════════════════════════════════════════════════════════
// GET
// ═════════════════════════════════════════════════════════════════════

describe('GET /api/pos/featured-drink', () => {
  it('returns the featured drink joined onto the menu row', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { PK: 'SETTINGS', SK: 'CONFIG', featuredDrinkId: 'latte' } })
      .mockResolvedValueOnce({ Item: LATTE });

    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      featured: {
        menuItemId: 'latte',
        name: 'Latte',
        basePrice: 8,
        imageUrl: 'https://example.test/latte.jpg',
        category: 'DRINK',
      },
    });
  });

  it('reads the settings singleton and then the menu row, in that order', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { featuredDrinkId: 'latte' } })
      .mockResolvedValueOnce({ Item: LATTE });

    await get();
    const all = cmds();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      __cmd: 'Get', TableName: 'test-settings', Key: { PK: 'SETTINGS', SK: 'CONFIG' },
    });
    expect(all[1]).toMatchObject({
      __cmd: 'Get', TableName: 'test-menu', Key: { PK: 'MENU#latte', SK: 'META' },
    });
  });

  it('200 {featured:null} when nothing is featured — no second read', async () => {
    // The customer display polls this on a loop. "Nothing featured today" is a
    // normal state, not an error, so it must not surface as a 404.
    mockDbSend.mockResolvedValueOnce({ Item: { PK: 'SETTINGS', SK: 'CONFIG' } });

    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ featured: null });
    expect(cmds()).toHaveLength(1);
  });

  it('200 {featured:null} when the settings row itself is absent', async () => {
    // Fresh table, or before the café has ever been opened.
    mockDbSend.mockResolvedValueOnce({});

    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ featured: null });
  });

  it('200 {featured:null} when the featured menu item has been DELETED', async () => {
    // A dangling pointer: `unsetFeaturedDrink` is the only writer that clears
    // `featuredDrinkId`, so deleting the menu item from the admin screen leaves
    // the id behind. The read must degrade to null, not to a half-populated
    // object with `name: undefined` on the display.
    mockDbSend
      .mockResolvedValueOnce({ Item: { featuredDrinkId: 'ghost' } })
      .mockResolvedValueOnce({});

    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ featured: null });
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('treats a %s featuredDrinkId as nothing featured', async (_label, value) => {
    // `unsetFeaturedDrink` writes literal `null`, so this is the ordinary
    // post-close state and by far the most common one this endpoint serves.
    mockDbSend.mockResolvedValueOnce({ Item: { featuredDrinkId: value } });

    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ featured: null });
    expect(cmds()).toHaveLength(1);
  });

  it('normalises a missing imageUrl to null rather than omitting it', async () => {
    // The display renders a placeholder on `null`; an absent key would serialise
    // away entirely and read as "not yet loaded".
    mockDbSend
      .mockResolvedValueOnce({ Item: { featuredDrinkId: 'latte' } })
      .mockResolvedValueOnce({ Item: { ...LATTE, imageUrl: undefined } });

    const body = JSON.parse((await get()).body);
    expect(body.featured.imageUrl).toBeNull();
    expect(Object.keys(body.featured)).toContain('imageUrl');
  });

  it('writes nothing — GET is read-only', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { featuredDrinkId: 'latte' } })
      .mockResolvedValueOnce({ Item: LATTE });

    await get();
    expect(cmds().every((c) => c.__cmd === 'Get')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// PUT
// ═════════════════════════════════════════════════════════════════════

describe('PUT /api/pos/featured-drink', () => {
  it('sets featuredDrinkId on the settings singleton and echoes the drink', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: LATTE })   // getMenuItem
      .mockResolvedValue({});

    const res = await put({ menuItemId: 'latte' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      featured: { menuItemId: 'latte', name: 'Latte', basePrice: 8, imageUrl: 'https://example.test/latte.jpg' },
    });

    const u = settingsUpdates()[0];
    expect(u).toMatchObject({
      TableName: 'test-settings',
      Key: { PK: 'SETTINGS', SK: 'CONFIG' },
      UpdateExpression: 'SET featuredDrinkId = :id',
    });
    expect(u.ExpressionAttributeValues[':id']).toBe('latte');
  });

  it('validates the menu item EXISTS before writing anything', async () => {
    mockDbSend.mockResolvedValueOnce({});   // getMenuItem misses

    const res = await put({ menuItemId: 'ghost' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Menu item not found' });
    // No settings write, no audit row: a typo'd id must not park a dangling
    // pointer on the singleton that the display then renders as null forever.
    expect(settingsUpdates()).toHaveLength(0);
    expect(auditPuts()).toHaveLength(0);
  });

  it.each([
    ['an empty body', {}],
    ['an empty menuItemId', { menuItemId: '' }],
    ['a null menuItemId', { menuItemId: null }],
    ['no body at all', null],
  ])('400 on %s, touching the database not at all', async (_label, body) => {
    const res = await put(body);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'menuItemId is required' });
    expect(cmds()).toHaveLength(0);
  });

  it('audits FEATURE under the MALAYSIAN calendar date', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: LATTE }).mockResolvedValue({});

    await put({ menuItemId: 'latte' }, 'Sarah');

    expect(auditPuts()).toHaveLength(1);
    const row = auditPuts()[0];
    expect(row.TableName).toBe('test-settings');
    expect(row.Item).toMatchObject({
      PK: `FEATURED_AUDIT#${malaysiaToday(SUNDAY_NOON_MYT)}`,
      action: 'FEATURE',
      menuItemId: 'latte',
      menuItemName: 'Latte',
      user: 'Sarah',
    });
    expect(row.Item.PK).toBe('FEATURED_AUDIT#2026-08-16');
  });

  it('files an 07:00-MYT change under TODAY, not under yesterday in UTC', async () => {
    // 2026-08-15T23:00:00Z is Sunday 07:00 in the café — before the 08:00 open,
    // when a cashier is setting up. A `new Date().toISOString().slice(0,10)` here
    // would write `FEATURED_AUDIT#2026-08-15`, splitting this service's FEATURE
    // row from the `UNFEATURE` row `closeCafe` writes that afternoon under
    // `FEATURED_AUDIT#2026-08-16`. Same class of bug as the end-of-day summary
    // emails that went out headed "Saturday, 1 August 2026".
    jest.setSystemTime(SUNDAY_0700_MYT);
    mockDbSend.mockResolvedValueOnce({ Item: LATTE }).mockResolvedValue({});

    await put({ menuItemId: 'latte' });

    expect(auditPuts()[0].Item.PK).toBe('FEATURED_AUDIT#2026-08-16');
    expect(auditPuts()[0].Item.PK).not.toBe('FEATURED_AUDIT#2026-08-15');
    // The sort key stays a true UTC instant — only the partition is a local date.
    expect(auditPuts()[0].Item.SK).toBe('2026-08-15T23:00:00.000Z');
  });

  it('sorts the audit row by a UTC ISO instant, matching timestamp', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: LATTE }).mockResolvedValue({});
    await put({ menuItemId: 'latte' });

    const item = auditPuts()[0].Item;
    expect(item.SK).toBe('2026-08-16T04:00:00.000Z');
    expect(item.timestamp).toBe(item.SK);
  });

  it('commits the settings write BEFORE the audit row', async () => {
    // The audit trail must never claim a change that did not land.
    mockDbSend.mockResolvedValueOnce({ Item: LATTE }).mockResolvedValue({});
    await put({ menuItemId: 'latte' });

    const all = cmds();
    const updateIdx = all.findIndex((c) => c.__cmd === 'Update');
    const auditIdx = all.findIndex((c) => String(c.Item?.PK || '').startsWith('FEATURED_AUDIT#'));
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(auditIdx).toBeGreaterThan(updateIdx);
  });

  it('records an empty actor rather than undefined when there is no JWT name', async () => {
    // `handlePos` defaults `actor` to ''. An `undefined` member would THROW in
    // production: `lib/db.ts` builds the document client with no marshallOptions,
    // so `removeUndefinedValues` is false.
    mockDbSend.mockResolvedValueOnce({ Item: LATTE }).mockResolvedValue({});
    await put({ menuItemId: 'latte' }, '');

    expect(auditPuts()[0].Item.user).toBe('');
    expect(auditPuts()[0].Item.user).not.toBeUndefined();
  });

  it('features a FOOD item too — the endpoint does not filter by category', async () => {
    // Worth pinning either way: the name says "drink", the guard is existence
    // only, and the /display surface renders whatever it is handed.
    mockDbSend
      .mockResolvedValueOnce({ Item: { ...LATTE, PK: 'MENU#cookie', menuItemId: 'cookie', name: 'Cookie', category: 'FOOD' } })
      .mockResolvedValue({});

    const res = await put({ menuItemId: 'cookie' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).featured.menuItemId).toBe('cookie');
  });

  it('omits category from the PUT response — only GET joins it', async () => {
    // Not obviously deliberate, but the frontend refetches after a set, so pin
    // the shape rather than let it drift silently.
    mockDbSend.mockResolvedValueOnce({ Item: LATTE }).mockResolvedValue({});
    const body = JSON.parse((await put({ menuItemId: 'latte' })).body);
    expect(body.featured).not.toHaveProperty('category');
  });
});

// ═════════════════════════════════════════════════════════════════════
// DELETE
// ═════════════════════════════════════════════════════════════════════

describe('DELETE /api/pos/featured-drink', () => {
  it('writes a literal null over featuredDrinkId and returns featured:null', async () => {
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ featured: null });

    const u = settingsUpdates()[0];
    expect(u).toMatchObject({
      TableName: 'test-settings',
      Key: { PK: 'SETTINGS', SK: 'CONFIG' },
      UpdateExpression: 'SET featuredDrinkId = :n',
    });
    // `SET … = null`, not `REMOVE`: the attribute stays present so the GET path's
    // falsy check is the only branch that matters, and `closeCafe` does the same.
    expect(u.ExpressionAttributeValues[':n']).toBeNull();
    expect(u.UpdateExpression).not.toContain('REMOVE');
  });

  it('audits UNFEATURE under the Malaysian date, with null id and empty name', async () => {
    await del('Mei');

    expect(auditPuts()).toHaveLength(1);
    expect(auditPuts()[0].Item).toMatchObject({
      PK: 'FEATURED_AUDIT#2026-08-16',
      action: 'UNFEATURE',
      menuItemId: null,
      menuItemName: '',
      user: 'Mei',
    });
  });

  it('files an 07:00-MYT clear under today, same rule as FEATURE', async () => {
    jest.setSystemTime(SUNDAY_0700_MYT);
    await del();
    expect(auditPuts()[0].Item.PK).toBe('FEATURED_AUDIT#2026-08-16');
  });

  it('is idempotent: clearing when nothing is featured still succeeds', async () => {
    // No preceding read, so there is no 404 branch to hit. A double-tapped Clear
    // just writes null twice and logs twice — safe, and the audit rows are
    // distinguished by their ISO sort key.
    const first = await del();
    jest.setSystemTime(new Date(SUNDAY_NOON_MYT.getTime() + 1000));
    const second = await del();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(auditPuts()).toHaveLength(2);
    expect(auditPuts()[0].Item.SK).not.toBe(auditPuts()[1].Item.SK);
  });

  it('reads nothing before writing — one Update, one Put', async () => {
    await del();
    const all = cmds();
    expect(all).toHaveLength(2);
    expect(all[0].__cmd).toBe('Update');
    expect(all[1].__cmd).toBe('Put');
  });

  it('records an empty actor rather than undefined', async () => {
    await del('');
    expect(auditPuts()[0].Item.user).toBe('');
    expect(auditPuts()[0].Item.user).not.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Cross-cutting
// ═════════════════════════════════════════════════════════════════════

describe('featured-drink: FEATURE and UNFEATURE share one partition per service', () => {
  it('a set at 07:00 MYT and a clear at 16:00 MYT land in the SAME partition', async () => {
    // This is the whole point of `malaysiaToday()` here: the admin screen reads
    // one day's history with a single Query on `FEATURED_AUDIT#{date}`, so a pair
    // split across two partitions shows the service as half-empty.
    jest.setSystemTime(SUNDAY_0700_MYT);                     // 2026-08-15T23:00Z
    mockDbSend.mockResolvedValueOnce({ Item: LATTE }).mockResolvedValue({});
    await put({ menuItemId: 'latte' });
    const featurePk = auditPuts()[0].Item.PK;

    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
    jest.setSystemTime(new Date('2026-08-16T08:00:00Z'));    // 16:00 MYT, same service
    await del();
    const unfeaturePk = auditPuts()[0].Item.PK;

    expect(featurePk).toBe(unfeaturePk);
    expect(featurePk).toBe('FEATURED_AUDIT#2026-08-16');
  });

  it('the audit rows live on the SETTINGS table, not a table of their own', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: LATTE }).mockResolvedValue({});
    await put({ menuItemId: 'latte' });
    expect(auditPuts()[0].TableName).toBe('test-settings');
  });

  it.each([
    ['GET', 'GET'],
    ['PUT', 'PUT'],
    ['DELETE', 'DELETE'],
  ])('%s is dispatched on the exact path with no path parameter', async (_label, method) => {
    // Guards against a `startsWith` creeping into the dispatcher: the featured
    // routes are exact matches, so a trailing segment must NOT resolve here.
    mockDbSend.mockResolvedValue({ Item: LATTE });
    const res = await handlePos(
      makeEvent({ httpMethod: method, path: '/api/pos/featured-drink/latte', body: JSON.stringify({ menuItemId: 'latte' }) }),
      'Sarah',
    );
    expect(res.statusCode).toBe(404);
  });
});
