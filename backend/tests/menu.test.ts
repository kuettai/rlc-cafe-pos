/**
 * The public menu route (`backend/src/routes/menu.ts`).
 *
 * `GET /api/menu` is the single most-hit endpoint in the app — every customer
 * page load and every POS refresh goes through it — and it had no suite of its
 * own. Three things are worth pinning, and only one of them is the response:
 *
 * 1. **The filter is DynamoDB's, not the handler's.** `isActive` /
 *    `isEnabledToday` are enforced by the `FilterExpression` on the
 *    `ScanCommand`, so the teeth of the "inactive items are hidden" claim are in
 *    an assertion on the command that was SENT. Asserting only on the returned
 *    body would pass even if the FilterExpression were deleted, because the mock
 *    decides what comes back.
 * 2. **The sort is the handler's.** `sortOrder` ordering is applied in JS after
 *    the scan, with `|| 0` for items that carry no `sortOrder` at all — which
 *    every legacy menu record does.
 * 3. **Everything else is a 404**, including `/api/menu/anything`: `index.ts:63`
 *    dispatches on `path.startsWith('/api/menu')`, so sub-paths and non-GET
 *    methods land in this handler and it — not the router — has to reject them.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked, so there is no network call, no credentials needed, and nothing
 * written to production — hence no `ZZTEST_` marker (that rule covers suites
 * that create real records).
 */

import { APIGatewayProxyEvent } from 'aws-lambda';

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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleMenu } = require('../src/routes/menu');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LATTE = {
  PK: 'MENU#latte-001', SK: 'META', menuItemId: 'latte-001', name: 'Latte',
  category: 'DRINK', basePrice: 8, isActive: true, isEnabledToday: true,
  sortOrder: 2,
};

const AMERICANO = {
  PK: 'MENU#americano-001', SK: 'META', menuItemId: 'americano-001', name: 'Americano',
  category: 'DRINK', basePrice: 6, isActive: true, isEnabledToday: true,
  sortOrder: 1,
};

const COOKIE = {
  PK: 'MENU#cookie-001', SK: 'META', menuItemId: 'cookie-001', name: 'Cookie',
  category: 'FOOD', basePrice: 3, isActive: true, isEnabledToday: true,
  sortOrder: 3, foodQuantityToday: 10, foodReserved: 0,
};

/** A legacy record from before `sortOrder` existed — no such attribute at all. */
const UNORDERED_MUFFIN = {
  PK: 'MENU#muffin-001', SK: 'META', menuItemId: 'muffin-001', name: 'Muffin',
  category: 'FOOD', basePrice: 4, isActive: true, isEnabledToday: true,
};

/**
 * Answer the one read this handler makes, keyed on the command and table it
 * actually asked for — not a `mockResolvedValueOnce` queue, which would let a
 * fixture fill the wrong slot (`invariants`, Test teeth). `undefined` stages a
 * response with NO `Items` key at all, which is what a scan of an empty table
 * can return and what the `|| []` fallback exists for.
 */
function stage(items: Record<string, unknown>[] | undefined) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-menu') {
      return items === undefined ? {} : { Items: items };
    }
    return {};
  });
}

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET', path: '/api/menu', body: null,
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

/** The parsed body the handler actually returned, for the happy path. */
async function getMenu(): Promise<any> {
  const res = await handleMenu(makeEvent());
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function names(body: any) { return body.items.map((i: any) => i.name); }

beforeEach(() => {
  mockDbSend.mockReset();
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/menu — the scan that is sent
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/menu — the ScanCommand carries the isActive/isEnabledToday filter', () => {
  it('scans MENU_TABLE filtering on BOTH flags, and reads nothing else', async () => {
    // The load-bearing assertion of the whole suite. Hiding an inactive or
    // not-enabled-today item is delegated entirely to DynamoDB, so if this
    // FilterExpression is weakened the customer menu shows items the café
    // cannot make — and no assertion on the response body would notice, since
    // the mock chooses what comes back.
    stage([LATTE]);

    await getMenu();

    const scans = cmds().filter((c) => c.__cmd === 'Scan');
    expect(scans).toHaveLength(1);
    expect(scans[0].TableName).toBe('test-menu');
    expect(scans[0].FilterExpression).toBe('isActive = :active AND isEnabledToday = :enabled');
    expect(scans[0].ExpressionAttributeValues).toEqual({ ':active': true, ':enabled': true });
    // One read total: no per-item follow-up Get, which is what would make this
    // endpoint expensive at Sunday-morning traffic.
    expect(mockDbSend).toHaveBeenCalledTimes(1);
  });

  it('does not write anything — the menu read is a read', async () => {
    stage([LATTE, COOKIE]);
    await getMenu();
    expect(cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd))).toHaveLength(0);
  });

  it('ignores query string parameters — there is no client-side filter to smuggle in', async () => {
    stage([LATTE]);
    const res = await handleMenu(makeEvent({ queryStringParameters: { category: 'FOOD' } }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items).toHaveLength(1);
    expect(cmds()[0].FilterExpression).toBe('isActive = :active AND isEnabledToday = :enabled');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/menu — the response
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/menu — an empty menu is an empty array, never a 404', () => {
  it('returns { items: [] } when the filtered scan matches nothing', async () => {
    // Every item switched off for the day is a normal weekday state, not an
    // error: the customer page renders "nothing available" from an empty list.
    stage([]);

    const res = await handleMenu(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [] });
  });

  it('returns { items: [] } when the scan response has NO Items key at all', async () => {
    // The `result.Items || []` fallback. A scan whose every row was filtered out
    // can come back without the key, and `undefined.sort` would be a 502.
    stage(undefined);

    const res = await handleMenu(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [] });
  });
});

describe('GET /api/menu — items are sorted by sortOrder', () => {
  it('sorts ascending regardless of the order the scan returned them in', async () => {
    // A Scan has no defined ordering, so the sequence the customer sees is the
    // handler's doing and nothing else's.
    stage([COOKIE, LATTE, AMERICANO]);

    const body = await getMenu();

    expect(names(body)).toEqual(['Americano', 'Latte', 'Cookie']);
  });

  it('treats a MISSING sortOrder as 0, so legacy records sort first', async () => {
    stage([LATTE, UNORDERED_MUFFIN, AMERICANO]);

    const body = await getMenu();

    expect(names(body)).toEqual(['Muffin', 'Americano', 'Latte']);
  });

  it('keeps the scan order among items that all lack sortOrder (stable sort)', async () => {
    // Both sides of the comparator fall back to 0 here. Node's sort is stable,
    // so equal keys keep their relative order rather than shuffling between
    // requests — a menu that reorders itself on refresh looks broken.
    const b = { ...UNORDERED_MUFFIN, menuItemId: 'b', name: 'B' };
    const a = { ...UNORDERED_MUFFIN, menuItemId: 'a', name: 'A' };
    const c = { ...UNORDERED_MUFFIN, menuItemId: 'c', name: 'C' };
    stage([b, a, c]);

    const body = await getMenu();

    expect(names(body)).toEqual(['B', 'A', 'C']);
  });

  it('orders a negative sortOrder before an absent one', async () => {
    const pinned = { ...LATTE, sortOrder: -1 };
    stage([UNORDERED_MUFFIN, pinned]);

    const body = await getMenu();

    expect(names(body)).toEqual(['Latte', 'Muffin']);
  });

  it('returns each record whole — the handler shapes nothing away', async () => {
    // The POS and the customer page both read fields straight off these objects
    // (`foodQuantityToday`, `category`, `basePrice`), so a projection added here
    // would break them silently.
    stage([COOKIE]);

    const body = await getMenu();

    expect(body.items).toEqual([COOKIE]);
  });

  it('passes DynamoDB\'s own filtering verdict straight through', async () => {
    // Documenting the division of labour rather than a behaviour to rely on:
    // the handler applies NO client-side isActive check, so an item that
    // reaches it is served. That is fine precisely because the assertion at the
    // top of this file pins the FilterExpression that stops it happening.
    const disabled = { ...LATTE, isEnabledToday: false, name: 'Should never be scanned' };
    stage([disabled]);

    const body = await getMenu();

    expect(names(body)).toEqual(['Should never be scanned']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Everything else — 404
// ══════════════════════════════════════════════════════════════════════════════

describe('handleMenu — the 404 branch, and that it never touches the table', () => {
  it.each([
    ['POST', '/api/menu'],
    ['PUT', '/api/menu'],
    ['DELETE', '/api/menu'],
    // `index.ts:63` dispatches on `startsWith('/api/menu')`, so these all arrive
    // here and this handler owns rejecting them. Admin menu writes live under
    // `/api/admin/menu`, never here.
    ['GET', '/api/menu/latte-001'],
    ['GET', '/api/menu/'],
    ['GET', '/api/menuitems'],
  ])('%s %s → 404 { error: "Not found" }', async (httpMethod, path) => {
    stage([LATTE]);

    const res = await handleMenu(makeEvent({ httpMethod, path }));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    // The guard sits BEFORE the scan, so an unmatched request costs no read
    // capacity — and, more to the point, cannot have written anything.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('returns a headers object on both branches, so index.ts can spread CORS onto it', async () => {
    // `index.ts:65` does `res.headers = { ...CORS_HEADERS, ...res.headers }`.
    // A handler returning no `headers` at all would still work there, but the
    // shape is part of the contract every other route keeps.
    stage([LATTE]);
    const ok = await handleMenu(makeEvent());
    const missing = await handleMenu(makeEvent({ path: '/api/menu/nope' }));

    expect(ok.headers).toEqual({});
    expect(missing.headers).toEqual({});
  });
});
