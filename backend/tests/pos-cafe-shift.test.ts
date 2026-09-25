/**
 * POS shift-summary and café-control sub-actions of `backend/src/routes/pos.ts`.
 *
 * Scope, deliberately narrow (this file is one of four splitting `pos.ts` by
 * sub-resource — order transitions, inventory/menu and onboarding-progress
 * belong to sibling suites and are not touched here):
 *
 *   GET  /api/pos/shift-summary   `getShiftSummary`   — the 3-bucket dedupe
 *   PUT  /api/pos/cafe/open       `openCafe`
 *   PUT  /api/pos/cafe/close      `closeCafe`         — expire, archive, reset
 *   PUT  /api/pos/cafe/celebration `toggleCelebration`
 *
 * Two things drive the design here.
 *
 * 1. **The DynamoDB mock applies the key condition it was given.** `stage()`
 *    holds ONE flat list of order records and answers each Query by filtering it
 *    on `:s` and — when the handler supplied one — on `createdAt >= :today`,
 *    exactly as the real index would. Bucket 1 and bucket 3 both query PENDING,
 *    so a pre-order created today is returned by BOTH from the same fixture: the
 *    dedupe is exercised by construction rather than by a test that hand-stages
 *    the answer it wants. If `byId` were dropped, `totalOrders` would read 8
 *    instead of 7 and `peakItem` would flip to Mocha — both are asserted.
 *
 * 2. **Aggregations are asserted against hand-computed figures**, worked out in
 *    the comment above each fixture, not against "a number came back".
 *
 * Fully offline and fully mocked (`../src/lib/db` is the only DynamoDB client in
 * the backend). No network, no credentials, nothing is written to production —
 * so no `ZZTEST_` marker applies; that rule covers suites that create real
 * records.
 *
 * The clock is pinned with `jest.useFakeTimers().setSystemTime(...)` because all
 * four handlers stamp `new Date()` into what they write or return, and
 * `getShiftSummary` derives its date bound from it. Malaysian dates come from
 * `lib/date.ts`, never from the ambient zone.
 *
 * Two findings remain pinned with `it.failing`, both shapes of the same
 * `toggleCelebration` validation defect. Those pass while the defect is present
 * and go RED the moment it is fixed, at which point delete the `.failing`.
 *
 * The UTC-day bound in `getShiftSummary` and the unpaginated `closeCafe` sweeps
 * were pinned the same way and are now FIXED — their tests below assert the
 * corrected behaviour directly.
 */

import { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbSend = jest.fn();

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

const mockLogOrder = jest.fn();
const mockSummarizeItems = jest.fn().mockReturnValue('summary');
jest.mock('../src/lib/audit', () => ({
  logOrder: mockLogOrder,
  summarizeItems: mockSummarizeItems,
  logAuth: jest.fn(),
}));

const mockSendOrderPush = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/lib/push', () => ({
  sendOrderPush: mockSendOrderPush,
  ensureVapidConfigured: jest.fn().mockResolvedValue(null),
  resetVapidState: jest.fn(),
}));

// `pos.ts` does NOT import this module, and that is the point of mocking it:
// `closeCafe` used to end with `sendDailySummaryEmail().catch(() => {})`, which
// Lambda's post-response freeze turned into a coin flip and lost the 2026-08-16
// summary entirely. The send now belongs to the expiry cron. If anyone
// reintroduces it on the request path, these spies stop being untouched.
const mockSendEmail = jest.fn().mockResolvedValue(true);
const mockSendEndOfDaySummary = jest.fn().mockResolvedValue(true);
const mockSendLowStockAlert = jest.fn().mockResolvedValue(true);
jest.mock('../src/lib/email', () => ({
  sendEmail: mockSendEmail,
  sendEndOfDaySummary: mockSendEndOfDaySummary,
  sendLowStockAlert: mockSendLowStockAlert,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePos } = require('../src/routes/pos');
// The real Malaysia-time helpers — the single source of truth for the
// conversion. Expected values are derived from them rather than restated.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { malaysiaToday, malaysiaDayStartUtc } = require('../src/lib/date');

const ACTOR = 'Cashier Grace';

// ─── Clock fixtures ───────────────────────────────────────────────────────────

/** 12:00 Sunday MYT. UTC date and Malaysian date agree, so no date bug hides. */
const SUNDAY_NOON_MYT = new Date('2026-08-16T04:00:00Z');
const SUNDAY_NOON_ISO = '2026-08-16T04:00:00.000Z';

/**
 * 07:00 Sunday MYT — 23:00 SATURDAY in UTC. The one hour-band where
 * `new Date().toISOString().slice(0,10)` and `malaysiaToday()` disagree.
 */
const SUNDAY_0700_MYT = new Date('2026-08-15T23:00:00Z');

// ─── Order fixtures ───────────────────────────────────────────────────────────

function order(o: Record<string, any>) {
  return { PK: `ORDER#${o.orderId}`, SK: 'META', ...o };
}

/**
 * One flat world of order records. `stage()` answers every Query out of this by
 * applying the handler's own key condition, so nothing is hand-placed into a
 * particular query slot.
 *
 * Hand-computed shift summary at 12:00 Sunday MYT (`today` = '2026-08-16'):
 *
 *   bucket 1  PENDING  + createdAt >= today  → PEND_TODAY, PREORDER_TODAY
 *   bucket 1  ARCHIVED + createdAt >= today  → ARCH_A, ARCH_B      (ARCH_SAT excluded)
 *   bucket 2  PREPARING, unbounded           → PREP
 *   bucket 2  READY,     unbounded           → READY_1
 *   bucket 3  PENDING,   unbounded, isPreOrder only
 *                                            → PREORDER_TODAY (ALREADY SEEN — deduped),
 *                                              PREORDER_WED   (new),
 *                                              PEND_TODAY / PEND_STALE filtered out
 *
 *   allOrders, in insertion order:
 *     PEND_TODAY, PREORDER_TODAY, ARCH_A, ARCH_B, PREP, READY_1, PREORDER_WED
 *
 *   totalOrders      7        (8 if the dedupe breaks)
 *   pendingOrders    3        PEND_TODAY, PREORDER_TODAY, PREORDER_WED
 *   preparingOrders  1
 *   readyOrders      1
 *   archivedOrders   2
 *   completedOrders  3        ARCHIVED + READY = ARCH_A, ARCH_B, READY_1
 *   totalRevenue     25       12 + 8 + 5   (NET totalAmount; gross is 16+11+9=36)
 *   newcomersServed  2        ARCH_A by customerClass, READY_1 by discountType
 *   itemCount        Latte 5, Cookie 4, Mocha 3   → peakItem 'Latte'
 *                    (double-counting PREORDER_TODAY would make Mocha 5 and win)
 */
const PEND_TODAY = order({
  orderId: 'pend-today', status: 'PENDING', createdAt: '2026-08-16T03:00:00.000Z',
  customerName: 'Ravi', totalAmount: 7, grossAmount: 7, expiresAt: 1786000000,
  items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, category: 'DRINK' }],
});

const PREORDER_TODAY = order({
  orderId: 'preorder-today', status: 'PENDING', isPreOrder: true,
  createdAt: '2026-08-16T02:00:00.000Z', customerName: 'Worship Team',
  totalAmount: 0, grossAmount: 16, discountType: 'MINISTRY_PREORDER',
  expiresAt: '2026-08-16T06:00:00.000Z',
  items: [{ menuItemId: 'mocha', name: 'Mocha', quantity: 2, category: 'DRINK' }],
});

const PREORDER_WED = order({
  orderId: 'preorder-wed', status: 'PENDING', isPreOrder: true,
  createdAt: '2026-08-12T01:00:00.000Z', customerName: 'Ushers',
  totalAmount: 0, grossAmount: 8, discountType: 'MINISTRY_PREORDER',
  expiresAt: '2026-08-16T06:00:00.000Z',
  items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, category: 'DRINK' }],
});

/** An ordinary stale PENDING order — bucket 3's `isPreOrder` filter must drop it. */
const PEND_STALE = order({
  orderId: 'pend-stale', status: 'PENDING', createdAt: '2026-08-09T02:00:00.000Z',
  customerName: 'Someone Last Week', totalAmount: 15, grossAmount: 15,
  items: [{ menuItemId: 'mocha', name: 'Mocha', quantity: 5, category: 'DRINK' }],
});

const ARCH_A = order({
  orderId: 'arch-a', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z',
  customerName: 'Newcomer Ana', totalAmount: 12, grossAmount: 16,
  customerClass: 'NEWCOMER', discountType: 'NEWCOMER',
  items: [
    { menuItemId: 'latte', name: 'Latte', quantity: 2, category: 'DRINK' },
    { menuItemId: 'cookie', name: 'Cookie', quantity: 1, category: 'FOOD' },
  ],
});

const ARCH_B = order({
  orderId: 'arch-b', status: 'ARCHIVED', createdAt: '2026-08-16T02:30:00.000Z',
  customerName: 'Ben', totalAmount: 8, grossAmount: 11,
  items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, category: 'DRINK' }],
});

/** 13:00 SATURDAY MYT. Yesterday's takings — must never reach today's figures. */
const ARCH_SAT = order({
  orderId: 'arch-sat', status: 'ARCHIVED', createdAt: '2026-08-15T05:00:00.000Z',
  customerName: 'Saturday Sale', totalAmount: 99, grossAmount: 99,
  items: [{ menuItemId: 'mocha', name: 'Mocha', quantity: 40, category: 'DRINK' }],
});

const PREP = order({
  orderId: 'prep-1', status: 'PREPARING', createdAt: '2026-08-16T03:40:00.000Z',
  customerName: 'Chloe', totalAmount: 20, grossAmount: 20,
  items: [{ menuItemId: 'cookie', name: 'Cookie', quantity: 3, category: 'FOOD' }],
});

const READY_1 = order({
  orderId: 'ready-1', status: 'READY', createdAt: '2026-08-16T03:30:00.000Z',
  customerName: 'Newcomer Dan', totalAmount: 5, grossAmount: 9,
  discountType: 'NEWCOMER',
  items: [{ menuItemId: 'mocha', name: 'Mocha', quantity: 1, category: 'DRINK' }],
});

/** Order of this array is the order each Query returns matching rows in. */
const SUNDAY_WORLD = [
  ARCH_A, ARCH_B, READY_1, PREP,
  PEND_TODAY, PREORDER_TODAY, PREORDER_WED, PEND_STALE,
  ARCH_SAT,
];

// ─── Menu fixtures (café close resets these) ──────────────────────────────────

const COOKIE_ROW = {
  PK: 'MENU#cookie', SK: 'META', menuItemId: 'cookie', name: 'Cookie',
  category: 'FOOD', foodQuantityToday: 12, foodReserved: 3, isEnabledToday: true,
};
const MUFFIN_ROW = {
  PK: 'MENU#muffin', SK: 'META', menuItemId: 'muffin', name: 'Muffin',
  category: 'FOOD', foodQuantityToday: 6, foodReserved: 0, isEnabledToday: true,
};
const LATTE_ROW = {
  PK: 'MENU#latte', SK: 'META', menuItemId: 'latte', name: 'Latte',
  category: 'DRINK', isEnabledToday: true,
};

// ─── Staging ──────────────────────────────────────────────────────────────────

interface World {
  /** Every order record that exists. Queries filter this, they are not fed it. */
  orders?: any[];
  /** Every menu record that exists. The FOOD Scan filters this. */
  menu?: any[];
  /** PKs whose Update must raise ConditionalCheckFailedException. */
  ccf?: string[];
  /** PK → error name for a non-conditional failure. */
  hardFail?: Record<string, string>;
  /**
   * When set, the first unbounded PENDING Query answers with this page plus a
   * `LastEvaluatedKey`; a follow-up Query carrying `ExclusiveStartKey` gets the
   * REMAINING matching orders, as a real paginated Query would. A caller that
   * ignores `LastEvaluatedKey` therefore sees only page 1.
   */
  firstPendingPage?: any[];
}

function ddbError(name: string) {
  const e: any = new Error(name);
  e.name = name;
  return e;
}

/**
 * Answer every command from the described world, keyed on the command the
 * handler actually built — never a blind `mockResolvedValueOnce` queue, which
 * would let a fixture silently fill the wrong slot in a multi-query handler.
 *
 * The two PENDING Queries in `getShiftSummary` are told apart the way they
 * genuinely differ: bucket 1 supplies `:today`, bucket 3 does not.
 */
function stage(world: World) {
  mockDbSend.mockReset();

  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Query' && cmd.TableName === 'test-orders') {
      const status = cmd.ExpressionAttributeValues[':s'];
      const bound = cmd.ExpressionAttributeValues[':today'];
      let items = (world.orders || []).filter((o) => o.status === status);
      // Apply the key condition the handler wrote, lexicographically on ISO
      // strings, exactly as `status-createdAt-index` would.
      if (bound !== undefined) {
        items = items.filter((o) => String(o.createdAt || '') >= String(bound));
      }
      if (world.firstPendingPage && status === 'PENDING' && bound === undefined) {
        const page1 = new Set(world.firstPendingPage.map((o) => o.PK));
        if (cmd.ExclusiveStartKey === undefined) {
          return { Items: world.firstPendingPage, LastEvaluatedKey: { PK: 'ORDER#cursor', SK: 'META' } };
        }
        // Page 2 is the REST, never a repeat of page 1 — a real Query resumes
        // from the cursor, so a fixture that re-served page 1 would let a
        // paginating caller double-apply its writes and look broken.
        return { Items: items.filter((o) => !page1.has(o.PK)) };
      }
      return { Items: items };
    }

    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-menu') {
      const wanted = cmd.ExpressionAttributeValues?.[':food'];
      const items = (world.menu || []).filter((m) => !wanted || m.category === wanted);
      return { Items: items };
    }

    if (cmd.__cmd === 'Update') {
      const pk = String(cmd.Key?.PK || '');
      if (world.hardFail?.[pk]) throw ddbError(world.hardFail[pk]);
      if ((world.ccf || []).includes(pk)) throw ddbError('ConditionalCheckFailedException');
      return {};
    }

    return {};
  });
}

// ─── Event + assertion helpers ────────────────────────────────────────────────

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET', path: '/api/pos/shift-summary', body: null,
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function of(kind: string, table?: string) {
  return cmds().filter((c) => c.__cmd === kind && (table === undefined || c.TableName === table));
}
function orderQueries() { return of('Query', 'test-orders'); }
/** The bucket-1 (date-bounded) Query for a status. */
function boundedQuery(status: string) {
  return orderQueries().find(
    (c) => c.ExpressionAttributeValues[':s'] === status
      && c.ExpressionAttributeValues[':today'] !== undefined,
  );
}
/** Updates issued against a single order, by orderId. */
function updatesFor(orderId: string) {
  return of('Update', 'test-orders').filter((c) => c.Key?.PK === `ORDER#${orderId}`);
}
function logged(action: string) {
  return mockLogOrder.mock.calls.filter((c) => c[0] === action);
}

async function call(overrides: Partial<APIGatewayProxyEvent>, expectStatus = 200) {
  const res = await handlePos(makeEvent(overrides), ACTOR);
  expect(res.statusCode).toBe(expectStatus);
  return JSON.parse(res.body);
}

const shiftSummary = () => call({ httpMethod: 'GET', path: '/api/pos/shift-summary' });
const openCafe = () => call({ httpMethod: 'PUT', path: '/api/pos/cafe/open', body: null });
const closeCafe = () => call({ httpMethod: 'PUT', path: '/api/pos/cafe/close', body: null });
const celebration = (body: unknown, status = 200) =>
  call({ httpMethod: 'PUT', path: '/api/pos/cafe/celebration', body: JSON.stringify(body) }, status);

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.setSystemTime(SUNDAY_NOON_MYT);
  mockDbSend.mockReset();
  mockLogOrder.mockClear();
  mockSummarizeItems.mockClear();
  mockSendOrderPush.mockClear();
  mockSendEmail.mockClear();
  mockSendEndOfDaySummary.mockClear();
  mockSendLowStockAlert.mockClear();
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/pos/shift-summary — the three buckets and their dedupe
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/pos/shift-summary — bucket merge and aggregation', () => {
  it('returns the hand-computed figures for the whole Sunday world', async () => {
    stage({ orders: SUNDAY_WORLD });

    const body = await shiftSummary();

    expect(body).toEqual({
      totalOrders: 7,
      totalRevenue: 25,
      completedOrders: 3,
      pendingOrders: 3,
      preparingOrders: 1,
      readyOrders: 1,
      archivedOrders: 2,
      newcomersServed: 2,
      peakItem: 'Latte',
      closedAt: SUNDAY_NOON_ISO,
    });
  });

  it('issues exactly five index Queries — two bounded, three unbounded', async () => {
    stage({ orders: SUNDAY_WORLD });
    await shiftSummary();

    const qs = orderQueries();
    expect(qs).toHaveLength(5);
    expect(qs.map((c) => [c.ExpressionAttributeValues[':s'], c.ExpressionAttributeValues[':today'] !== undefined]))
      .toEqual([
        ['PENDING', true],    // bucket 1
        ['ARCHIVED', true],   // bucket 1
        ['PREPARING', false], // bucket 2
        ['READY', false],     // bucket 2
        ['PENDING', false],   // bucket 3
      ]);
    for (const q of qs) {
      expect(q.IndexName).toBe('status-createdAt-index');
      expect(q.ExpressionAttributeNames).toEqual({ '#s': 'status' });
    }
    expect(qs[0].KeyConditionExpression).toBe('#s = :s AND createdAt >= :today');
    expect(qs[2].KeyConditionExpression).toBe('#s = :s');
  });

  it('DEDUPES a today-created pre-order returned by BOTH PENDING queries', async () => {
    // The load-bearing case. Buckets 1 and 3 both query PENDING unfiltered by
    // pre-order-ness, so this record legitimately comes back twice — and the two
    // objects are DISTINCT instances, as they would be from two real Queries, so
    // an identity-based dedupe would not save it.
    stage({ orders: [PREORDER_TODAY, { ...PREORDER_TODAY }] });

    const body = await shiftSummary();

    expect(body.totalOrders).toBe(1);
    expect(body.pendingOrders).toBe(1);
    // 2 Mochas, not 4 — the item tally is where a double count does real damage,
    // because the barista prep list is sized off it.
    expect(body.peakItem).toBe('Mocha');
    expect(body.totalRevenue).toBe(0);
  });

  it('dedupes on PK when a legacy record carries no orderId', async () => {
    const legacy = {
      PK: 'ORDER#legacy-1', SK: 'META', status: 'PENDING', isPreOrder: true,
      createdAt: '2026-08-16T02:00:00.000Z', totalAmount: 0,
      items: [{ name: 'Teh', quantity: 1 }],
    };
    stage({ orders: [legacy, { ...legacy }] });

    const body = await shiftSummary();

    expect(body.totalOrders).toBe(1);
    expect(body.peakItem).toBe('Teh');
  });

  it('surfaces a pre-order created DAYS ago that no other bucket can see', async () => {
    // Bucket 3's whole reason to exist: since v1.71 pre-orders are born PENDING,
    // so a Wednesday pre-order for Sunday is missed by bucket 1's date bound and
    // by bucket 2's PREPARING/READY statuses.
    stage({ orders: [PREORDER_WED] });

    const body = await shiftSummary();

    expect(body.totalOrders).toBe(1);
    expect(body.pendingOrders).toBe(1);
  });

  it('bucket 3 does NOT surface a stale ORDINARY pending order', async () => {
    // The `isPreOrder !== true` continue at pos.ts:168, with a fixture that
    // reaches it — the record is returned by the unbounded PENDING Query and is
    // dropped by the guard, not by the date bound.
    stage({ orders: [PEND_STALE] });

    const body = await shiftSummary();

    expect(body.totalOrders).toBe(0);
    expect(body.pendingOrders).toBe(0);
    expect(body.peakItem).toBe('—');
    // Proof the fixture reached the guard: the unbounded PENDING Query did match
    // it, so its absence above is the `continue` and nothing else.
    const bucket3 = orderQueries()[4];
    expect(bucket3.ExpressionAttributeValues[':today']).toBeUndefined();
  });

  it("excludes yesterday's ARCHIVED takings via the bucket-1 date bound", async () => {
    stage({ orders: [ARCH_A, ARCH_SAT] });

    const body = await shiftSummary();

    expect(body.archivedOrders).toBe(1);
    expect(body.totalRevenue).toBe(12);      // not 111
    expect(boundedQuery('ARCHIVED')).toBeDefined();
  });
});

describe('GET /api/pos/shift-summary — revenue is NET and completed-only', () => {
  it('sums totalAmount, never grossAmount', async () => {
    stage({ orders: [ARCH_A, ARCH_B, READY_1] });
    const body = await shiftSummary();
    // gross would be 16 + 11 + 9 = 36.
    expect(body.totalRevenue).toBe(25);
  });

  it('excludes PENDING and PREPARING from revenue while still counting them', async () => {
    stage({ orders: [PEND_TODAY, PREP] });
    const body = await shiftSummary();

    expect(body.totalOrders).toBe(2);
    expect(body.pendingOrders).toBe(1);
    expect(body.preparingOrders).toBe(1);
    expect(body.completedOrders).toBe(0);
    expect(body.totalRevenue).toBe(0);       // 7 + 20 collected by nobody yet
  });

  it('counts a READY pre-order as completed but adds RM 0 to revenue', async () => {
    const readyPreorder = order({
      orderId: 'ready-pre', status: 'READY', isPreOrder: true,
      createdAt: '2026-08-16T03:00:00.000Z', totalAmount: 0, grossAmount: 24,
      discountType: 'MINISTRY_PREORDER',
      items: [{ menuItemId: 'latte', name: 'Latte', quantity: 3 }],
    });
    stage({ orders: [ARCH_B, readyPreorder] });

    const body = await shiftSummary();

    expect(body.completedOrders).toBe(2);
    expect(body.readyOrders).toBe(1);
    expect(body.totalRevenue).toBe(8);
  });

  it('treats a missing or unparseable totalAmount as 0 rather than NaN', async () => {
    stage({
      orders: [
        order({ orderId: 'no-total', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', items: [] }),
        order({ orderId: 'ok', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 4.5, items: [] }),
      ],
    });

    const body = await shiftSummary();

    expect(body.totalRevenue).toBe(4.5);
    expect(Number.isNaN(body.totalRevenue)).toBe(false);
  });

  it('counts newcomers from EITHER customerClass or discountType', async () => {
    stage({
      orders: [
        order({ orderId: 'n1', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 0, customerClass: 'NEWCOMER', items: [] }),
        order({ orderId: 'n2', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 3, discountType: 'NEWCOMER', items: [] }),
        // The two fields can still diverge, so a NEWCOMER whose `discountType`
        // is NONE must still be counted via `customerClass`. (The old example
        // for this was "a newcomer who ordered FOOD only gets no discount" —
        // no longer true, NEWCOMER discounts FOOD now. Records written under
        // the old DRINK-only rules keep this shape, and an all-RM0 basket
        // still reduces nothing today.) `items` is empty here on purpose: this
        // pins the COUNTING rule, not a price computation.
        order({ orderId: 'n3', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 3, customerClass: 'NEWCOMER', discountType: 'NONE', items: [] }),
        order({ orderId: 'r1', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 8, customerClass: 'REGULAR', items: [] }),
      ],
    });

    const body = await shiftSummary();

    expect(body.newcomersServed).toBe(3);
    expect(body.totalOrders).toBe(4);
  });
});

describe('GET /api/pos/shift-summary — peakItem', () => {
  it('picks the highest total QUANTITY, not the most frequent line', async () => {
    stage({
      orders: [
        order({ orderId: 'q1', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 0, items: [{ name: 'Teh', quantity: 1 }] }),
        order({ orderId: 'q2', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 0, items: [{ name: 'Teh', quantity: 1 }] }),
        order({ orderId: 'q3', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 0, items: [{ name: 'Kopi', quantity: 5 }] }),
      ],
    });
    expect((await shiftSummary()).peakItem).toBe('Kopi');
  });

  it('defaults a missing quantity to 1', async () => {
    stage({
      orders: [
        order({ orderId: 'q1', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 0, items: [{ name: 'Teh' }, { name: 'Teh' }] }),
        order({ orderId: 'q2', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 0, items: [{ name: 'Kopi' }] }),
      ],
    });
    expect((await shiftSummary()).peakItem).toBe('Teh');
  });

  it("returns the em-dash placeholder when nothing was ordered at all", async () => {
    stage({ orders: [] });
    const body = await shiftSummary();
    expect(body.peakItem).toBe('—');
    expect(body).toMatchObject({ totalOrders: 0, totalRevenue: 0, completedOrders: 0 });
  });

  it('tolerates an order with no items array', async () => {
    stage({ orders: [order({ orderId: 'bare', status: 'ARCHIVED', createdAt: '2026-08-16T01:00:00.000Z', totalAmount: 6 })] });
    const body = await shiftSummary();
    expect(body.peakItem).toBe('—');
    expect(body.totalRevenue).toBe(6);
  });
});

describe('GET /api/pos/shift-summary — it is a READ', () => {
  it('writes nothing: no Put, Update or Delete', async () => {
    stage({ orders: SUNDAY_WORLD, menu: [COOKIE_ROW] });
    await shiftSummary();
    expect(cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd))).toHaveLength(0);
  });

  it('stamps closedAt from the pinned clock, so the response is deterministic', async () => {
    stage({ orders: [] });
    jest.setSystemTime(new Date('2026-08-16T06:30:45Z'));
    expect((await shiftSummary()).closedAt).toBe('2026-08-16T06:30:45.000Z');
  });
});

describe('GET /api/pos/shift-summary — Malaysian vs UTC date', () => {
  it('bounds bucket 1 at the UTC INSTANT the Malaysian day began', async () => {
    stage({ orders: SUNDAY_WORLD });
    await shiftSummary();
    // The bound is compared against a stored `createdAt`, which is a full UTC ISO
    // string — so it must be an instant, not a bare YYYY-MM-DD. Derived from
    // `lib/date.ts` rather than restated, so the two cannot drift apart.
    expect(malaysiaToday(SUNDAY_NOON_MYT)).toBe('2026-08-16');
    expect(boundedQuery('PENDING').ExpressionAttributeValues[':today'])
      .toBe(malaysiaDayStartUtc('2026-08-16'));
    expect(boundedQuery('PENDING').ExpressionAttributeValues[':today'])
      .toBe('2026-08-15T16:00:00.000Z');
  });

  it("does not leak Saturday's takings into Sunday before 08:00 MYT", async () => {
    // FIXED (was pinned as BUG pos.ts:113). 07:00 Sunday MYT is 23:00 SATURDAY
    // in UTC, so the old `new Date().toISOString().slice(0,10)` yielded
    // '2026-08-15' and every ARCHIVED order from 08:00 MYT Saturday onward
    // satisfied `createdAt >= :today`, landing in SUNDAY's shift summary.
    jest.setSystemTime(SUNDAY_0700_MYT);
    stage({ orders: [ARCH_SAT] });

    const body = await shiftSummary();

    // Saturday's RM99 is not Sunday's revenue.
    expect(body.totalRevenue).toBe(0);
    expect(body.archivedOrders).toBe(0);
    expect(boundedQuery('ARCHIVED').ExpressionAttributeValues[':today'])
      .toBe(malaysiaDayStartUtc(malaysiaToday(SUNDAY_0700_MYT)));
  });

  it('still COUNTS an order placed before 08:00 MYT — the mirror-image bug', async () => {
    // A bare `malaysiaToday()` would fix the leak above and introduce this: an
    // order placed at 07:30 Sunday MYT has `createdAt` '2026-08-15T23:30…Z',
    // which fails `>= '2026-08-16'`. Only the day-START instant satisfies both
    // directions, which is what `malaysiaDayStartUtc`'s doc comment warns about.
    jest.setSystemTime(SUNDAY_0700_MYT);
    const earlyBird = order({
      orderId: 'early', status: 'ARCHIVED', createdAt: '2026-08-15T23:30:00.000Z',
      customerName: 'Early Bird', totalAmount: 6, grossAmount: 6, items: [],
    });
    stage({ orders: [earlyBird, ARCH_SAT] });

    const body = await shiftSummary();

    expect(body.archivedOrders).toBe(1);
    expect(body.totalRevenue).toBe(6);      // the early order, not Saturday's 99
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/pos/cafe/open
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/pos/cafe/open', () => {
  it('flips cafeStatus to OPEN with a single settings Update and nothing else', async () => {
    stage({});

    const body = await openCafe();

    expect(body).toEqual({ cafeStatus: 'OPEN' });
    const all = cmds();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      __cmd: 'Update',
      TableName: 'test-settings',
      Key: { PK: 'SETTINGS', SK: 'CONFIG' },
      UpdateExpression: 'SET cafeStatus = :s',
      ExpressionAttributeValues: { ':s': 'OPEN' },
    });
  });

  it('does not resurrect celebration mode, the featured drink or food counters', async () => {
    // Opening is deliberately not the inverse of closing: the previous service's
    // celebration and featured drink stay reset, and stock stays at whatever the
    // volunteers counted in.
    stage({ orders: SUNDAY_WORLD, menu: [COOKIE_ROW, MUFFIN_ROW] });

    await openCafe();

    const values = of('Update', 'test-settings')[0].ExpressionAttributeValues;
    expect(Object.keys(values)).toEqual([':s']);
    expect(of('Update', 'test-menu')).toHaveLength(0);
    expect(of('Update', 'test-orders')).toHaveLength(0);
    expect(of('Scan')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/pos/cafe/close
// ══════════════════════════════════════════════════════════════════════════════

/** The world a normal end-of-service close acts on. */
const CLOSE_WORLD: World = {
  orders: [PEND_TODAY, PREORDER_TODAY, PREORDER_WED, PREP, READY_1],
  menu: [COOKIE_ROW, MUFFIN_ROW, LATTE_ROW],
};

describe('PUT /api/pos/cafe/close — the settings flip', () => {
  it('sets CLOSED and resets the featured drink AND celebration mode in one Update', async () => {
    stage(CLOSE_WORLD);

    await closeCafe();

    const upd = of('Update', 'test-settings');
    expect(upd).toHaveLength(1);
    expect(upd[0].Key).toEqual({ PK: 'SETTINGS', SK: 'CONFIG' });
    expect(upd[0].UpdateExpression)
      .toBe('SET cafeStatus = :s, featuredDrinkId = :n, celebrationMode = :c');
    // Celebration is a per-service decision. Left on, it silently reprices every
    // eligible drink next Sunday.
    expect(upd[0].ExpressionAttributeValues)
      .toEqual({ ':s': 'CLOSED', ':n': null, ':c': false });
  });

  it('flips the status BEFORE sweeping any order', async () => {
    // Ordering matters twice: it stops a cashier approving into a closing café,
    // and `cafeStatus === 'CLOSED'` is the gate the expiry cron waits on before
    // sending the end-of-day summary.
    stage(CLOSE_WORLD);
    await closeCafe();

    const all = cmds();
    expect(all[0]).toMatchObject({ __cmd: 'Update', TableName: 'test-settings' });
    const firstOrderWrite = all.findIndex((c) => c.__cmd === 'Update' && c.TableName === 'test-orders');
    expect(firstOrderWrite).toBeGreaterThan(0);
  });

  it('writes a FEATURED_AUDIT UNFEATURE row attributed to SYSTEM/CLOSE', async () => {
    stage(CLOSE_WORLD);
    await closeCafe();

    const puts = of('Put', 'test-settings');
    expect(puts).toHaveLength(1);
    expect(puts[0].Item).toEqual({
      PK: 'FEATURED_AUDIT#2026-08-16',
      SK: SUNDAY_NOON_ISO,
      action: 'UNFEATURE',
      menuItemId: null,
      menuItemName: 'ALL',
      user: 'SYSTEM/CLOSE',
      timestamp: SUNDAY_NOON_ISO,
    });
  });
});

describe('PUT /api/pos/cafe/close — PENDING orders are EXPIRED', () => {
  it('expires an ordinary PENDING order with the exact guarded write', async () => {
    stage(CLOSE_WORLD);

    await closeCafe();

    const upd = updatesFor('pend-today');
    expect(upd).toHaveLength(1);
    expect(upd[0].Key).toEqual({ PK: 'ORDER#pend-today', SK: 'META' });
    // `REMOVE expiresAt` is the invariant: a NUMERIC expiresAt left behind is a
    // live DynamoDB TTL that silently deletes the archived record later.
    expect(upd[0].UpdateExpression).toBe('SET #s = :expired, updatedAt = :now REMOVE expiresAt');
    expect(upd[0].ExpressionAttributeNames).toEqual({ '#s': 'status' });
    expect(upd[0].ExpressionAttributeValues)
      .toEqual({ ':expired': 'EXPIRED', ':now': SUNDAY_NOON_ISO, ':prev': 'PENDING' });
    expect(upd[0].ConditionExpression).toBe('#s = :prev');
  });

  it('SKIPS pre-orders — a fixture reaches the guard and no write is issued', async () => {
    // Both pre-orders are returned by the unbounded PENDING Query, so the
    // `continue` at pos.ts:1018 is what stops them, not an empty result set.
    // Without it, one close would EXPIRE every outstanding pre-order — and the
    // `REMOVE expiresAt` above would destroy the ISO service-end time that
    // `expirePreOrders()` needs, killing the feature silently.
    stage(CLOSE_WORLD);

    const body = await closeCafe();

    expect(updatesFor('preorder-today')).toHaveLength(0);
    expect(updatesFor('preorder-wed')).toHaveLength(0);
    expect(body.expiredOrders).toBe(1);
    expect(logged('CLOSE_EXPIRE').map((c) => c[1])).toEqual(['pend-today']);
  });

  it('audits each expiry with the customer and the total', async () => {
    stage(CLOSE_WORLD);
    await closeCafe();

    expect(logged('CLOSE_EXPIRE')).toHaveLength(1);
    expect(logged('CLOSE_EXPIRE')[0]).toEqual([
      'CLOSE_EXPIRE', 'pend-today', { customer: 'Ravi', total: 7 },
    ]);
  });

  it('counts a mid-close approval as skipped instead of failing the batch', async () => {
    const second = order({
      orderId: 'pend-2', status: 'PENDING', createdAt: '2026-08-16T03:10:00.000Z',
      customerName: 'Mid-close', totalAmount: 9, items: [],
    });
    stage({ ...CLOSE_WORLD, orders: [...(CLOSE_WORLD.orders || []), second], ccf: ['ORDER#pend-today'] });

    const body = await closeCafe();

    // The conditional write was attempted and lost the race, so it is not
    // counted — and the rest of the sweep still ran.
    expect(updatesFor('pend-today')).toHaveLength(1);
    expect(body.expiredOrders).toBe(1);
    expect(logged('CLOSE_EXPIRE').map((c) => c[1])).toEqual(['pend-2']);
  });

  it('rethrows a NON-conditional DynamoDB failure instead of reporting success', async () => {
    stage({ ...CLOSE_WORLD, hardFail: { 'ORDER#pend-today': 'ValidationException' } });

    await expect(handlePos(makeEvent({ httpMethod: 'PUT', path: '/api/pos/cafe/close', body: null }), ACTOR))
      .rejects.toThrow('ValidationException');
  });

  it('FOLLOWS LastEvaluatedKey, so a busy Sunday strands no order on page 2', async () => {
    // FIXED (was pinned as BUG pos.ts:1010). A single Query returns at most 1MB.
    // `releaseAllPreOrders` in this same file loops on `LastEvaluatedKey` and
    // documents why a MUTATING batch must; `closeCafe` did not, so the cashier
    // was told "expiredOrders: 1", reasonably believed the queue was clear, and
    // page 2 stayed PENDING with its numeric TTL still armed.
    const page2 = order({
      orderId: 'pend-page2', status: 'PENDING', createdAt: '2026-08-16T03:20:00.000Z',
      customerName: 'Page Two', totalAmount: 11, items: [],
    });
    stage({
      orders: [PEND_TODAY, page2],
      menu: [COOKIE_ROW],
      firstPendingPage: [PEND_TODAY],
    });

    const body = await closeCafe();

    expect(body.expiredOrders).toBe(2);
    expect(updatesFor('pend-page2')).toHaveLength(1);
    // And the page-1 order is expired exactly ONCE — the second Query resumes
    // from the cursor rather than replaying it.
    expect(updatesFor('pend-today')).toHaveLength(1);
    // Proof the fixture actually exercised pagination: two PENDING Queries, the
    // second carrying the cursor.
    const pendingQs = orderQueries().filter((c) => c.ExpressionAttributeValues[':s'] === 'PENDING');
    expect(pendingQs).toHaveLength(2);
    expect(pendingQs[0].ExclusiveStartKey).toBeUndefined();
    expect(pendingQs[1].ExclusiveStartKey).toEqual({ PK: 'ORDER#cursor', SK: 'META' });
  });
});

describe('PUT /api/pos/cafe/close — PREPARING and READY are ARCHIVED', () => {
  it('archives each, guarding on its OWN previous status', async () => {
    stage(CLOSE_WORLD);

    const body = await closeCafe();

    for (const [id, prev] of [['prep-1', 'PREPARING'], ['ready-1', 'READY']] as const) {
      const upd = updatesFor(id);
      expect(upd).toHaveLength(1);
      expect(upd[0].UpdateExpression).toBe('SET #s = :archived, updatedAt = :now REMOVE expiresAt');
      expect(upd[0].ExpressionAttributeNames).toEqual({ '#s': 'status' });
      expect(upd[0].ExpressionAttributeValues)
        .toEqual({ ':archived': 'ARCHIVED', ':now': SUNDAY_NOON_ISO, ':prev': prev });
      expect(upd[0].ConditionExpression).toBe('#s = :prev');
    }
    expect(body.archivedOrders).toBe(2);
  });

  it('queries PREPARING then READY, both unbounded by date', async () => {
    stage(CLOSE_WORLD);
    await closeCafe();

    const statuses = orderQueries().map((c) => c.ExpressionAttributeValues[':s']);
    expect(statuses).toEqual(['PENDING', 'PREPARING', 'READY']);
    for (const q of orderQueries()) {
      expect(q.IndexName).toBe('status-createdAt-index');
      expect(q.KeyConditionExpression).toBe('#s = :s');
      expect(q.ExpressionAttributeValues[':today']).toBeUndefined();
    }
  });

  it('audits each archive with its previous status', async () => {
    stage(CLOSE_WORLD);
    await closeCafe();

    expect(logged('CLOSE_ARCHIVE')).toEqual([
      ['CLOSE_ARCHIVE', 'prep-1', { customer: 'Chloe', prevStatus: 'PREPARING', total: 20 }],
      ['CLOSE_ARCHIVE', 'ready-1', { customer: 'Newcomer Dan', prevStatus: 'READY', total: 5 }],
    ]);
  });

  it('does not count an order a cashier moved mid-close', async () => {
    stage({ ...CLOSE_WORLD, ccf: ['ORDER#ready-1'] });

    const body = await closeCafe();

    expect(body.archivedOrders).toBe(1);
    expect(logged('CLOSE_ARCHIVE').map((c) => c[1])).toEqual(['prep-1']);
  });

  it('reports truthful counts for the whole close', async () => {
    stage(CLOSE_WORLD);
    expect(await closeCafe()).toEqual({
      cafeStatus: 'CLOSED', expiredOrders: 1, archivedOrders: 2,
    });
  });

  it('returns zeroes on an empty queue without writing to any order', async () => {
    stage({ orders: [], menu: [COOKIE_ROW] });

    const body = await closeCafe();

    expect(body).toEqual({ cafeStatus: 'CLOSED', expiredOrders: 0, archivedOrders: 0 });
    expect(of('Update', 'test-orders')).toHaveLength(0);
    expect(mockLogOrder).not.toHaveBeenCalled();
  });
});

describe('PUT /api/pos/cafe/close — food counters reset', () => {
  it('zeroes foodQuantityToday AND foodReserved and disables the item for the day', async () => {
    stage(CLOSE_WORLD);

    await closeCafe();

    const menuUpdates = of('Update', 'test-menu');
    expect(menuUpdates).toHaveLength(2);            // COOKIE + MUFFIN, not LATTE
    expect(menuUpdates.map((c) => c.Key)).toEqual([
      { PK: 'MENU#cookie', SK: 'META' },
      { PK: 'MENU#muffin', SK: 'META' },
    ]);
    for (const u of menuUpdates) {
      expect(u.UpdateExpression)
        .toBe('SET foodQuantityToday = :z, foodReserved = :z, isEnabledToday = :f');
      // Both counters go to the same literal 0 — a stale foodReserved is the
      // drift `scripts/reset-food-reserved.mjs` exists to repair.
      expect(u.ExpressionAttributeValues).toEqual({ ':z': 0, ':f': false });
    }
  });

  it('resets the item that had reservations outstanding, not only the untouched one', async () => {
    // COOKIE_ROW carries foodReserved: 3. The reset must not be conditional on
    // the counters already balancing.
    stage({ orders: [], menu: [COOKIE_ROW] });
    await closeCafe();

    const u = of('Update', 'test-menu');
    expect(u).toHaveLength(1);
    expect(u[0].Key).toEqual({ PK: 'MENU#cookie', SK: 'META' });
    expect(u[0].ExpressionAttributeValues[':z']).toBe(0);
  });

  it('scans the menu filtered to FOOD, leaving DRINKs enabled', async () => {
    stage(CLOSE_WORLD);
    await closeCafe();

    const scans = of('Scan', 'test-menu');
    expect(scans).toHaveLength(1);
    expect(scans[0].FilterExpression).toBe('category = :food');
    expect(scans[0].ExpressionAttributeValues).toEqual({ ':food': 'FOOD' });
    expect(of('Update', 'test-menu').map((c) => c.Key.PK)).not.toContain('MENU#latte');
  });

  it('handles a café with no food on the menu at all', async () => {
    stage({ orders: [], menu: [LATTE_ROW] });
    const body = await closeCafe();
    expect(of('Update', 'test-menu')).toHaveLength(0);
    expect(body.cafeStatus).toBe('CLOSED');
  });
});

describe('PUT /api/pos/cafe/close — sends NO email', () => {
  it('does not send the end-of-day summary, or any other mail, from the request path', async () => {
    // Deliberate since v1.72.0: Lambda freezes the sandbox the instant the 200
    // goes out, so the old un-awaited `sendDailySummaryEmail().catch(() => {})`
    // was a coin flip on later traffic and silently lost the 2026-08-16 report.
    // `sendDailySummary()` in `expiry.ts` owns it now, gated on CLOSED and
    // guarded by a `DAILY_SUMMARY#{date}` marker so it sends exactly once.
    stage(CLOSE_WORLD);

    await closeCafe();

    expect(mockSendEndOfDaySummary).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendLowStockAlert).not.toHaveBeenCalled();
  });

  it('leaves no DAILY_SUMMARY marker — that is the cron\'s record, not the close\'s', async () => {
    stage(CLOSE_WORLD);
    await closeCafe();

    const markerWrites = cmds().filter(
      (c) => String(c.Item?.PK || c.Key?.PK || '').startsWith('DAILY_SUMMARY'),
    );
    expect(markerWrites).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/pos/cafe/celebration
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/pos/cafe/celebration', () => {
  it.each([[true], [false]])('persists enabled=%s and echoes it back', async (enabled) => {
    stage({});

    const body = await celebration({ enabled });

    expect(body).toEqual({ celebrationMode: enabled });
    const upd = of('Update', 'test-settings');
    expect(upd).toHaveLength(1);
    expect(upd[0].Key).toEqual({ PK: 'SETTINGS', SK: 'CONFIG' });
    expect(upd[0].UpdateExpression).toBe('SET celebrationMode = :m');
    expect(upd[0].ExpressionAttributeValues).toEqual({ ':m': enabled });
  });

  it('touches only celebrationMode — not cafeStatus, not the featured drink', async () => {
    stage({});
    await celebration({ enabled: true });

    const all = cmds();
    expect(all).toHaveLength(1);
    expect(all[0].UpdateExpression).not.toContain('cafeStatus');
    expect(all[0].UpdateExpression).not.toContain('featuredDrinkId');
    expect(of('Get')).toHaveLength(0);   // a blind write, not read-modify-write
  });

  it('does not read or reprice any order — pricing is applied at approve time', async () => {
    stage({ orders: SUNDAY_WORLD });
    await celebration({ enabled: true });
    expect(of('Query')).toHaveLength(0);
    expect(of('Update', 'test-orders')).toHaveLength(0);
  });

  it.failing(
    'BUG pos.ts:1104 — toggleCelebration never validates body.enabled, so a STRING turns celebration on',
    async () => {
      // `celebrationApplies` in `lib/pricing.ts:150` tests
      // `!!settings?.celebrationMode`, so any truthy value reprices every
      // eligible drink. `'false'` — what a form or a hand-rolled client can
      // easily send — is truthy. The handler writes it through verbatim and
      // reports success. Money-affecting settings need a parsed boolean, the way
      // `parseCustomerClass` guards `discountType`.
      stage({});

      await celebration({ enabled: 'false' });

      const written = of('Update', 'test-settings')[0].ExpressionAttributeValues[':m'];
      expect(typeof written).toBe('boolean');
      expect(written).toBe(false);
    },
  );

  it.failing(
    'BUG pos.ts:1104 — a body with no `enabled` writes undefined into the settings record',
    async () => {
      // The doc client is constructed with no `removeUndefinedValues`, so in
      // production this is a marshalling failure surfacing as a 502 rather than
      // the 400 the request deserves. Either way the handler should reject
      // before its UpdateCommand, as `PUT /api/admin/settings` does for
      // `openingHours`.
      stage({});

      const res = await handlePos(
        makeEvent({ httpMethod: 'PUT', path: '/api/pos/cafe/celebration', body: '{}' }),
        ACTOR,
      );

      expect(res.statusCode).toBe(400);
      expect(mockDbSend).not.toHaveBeenCalled();
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// Dispatch — these four paths only
// ══════════════════════════════════════════════════════════════════════════════

describe('handlePos dispatch for the shift-summary and café routes', () => {
  it.each([
    ['GET', '/api/pos/shift-summary'],
    ['PUT', '/api/pos/cafe/open'],
    ['PUT', '/api/pos/cafe/close'],
  ])('%s %s reaches its handler', async (httpMethod, path) => {
    stage({ orders: [], menu: [] });
    const res = await handlePos(makeEvent({ httpMethod, path, body: null }), ACTOR);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).error).toBeUndefined();
  });

  it.each([
    ['POST', '/api/pos/shift-summary'],
    ['GET', '/api/pos/cafe/open'],
    ['POST', '/api/pos/cafe/close'],
    ['GET', '/api/pos/cafe/celebration'],
  ])('%s %s is a 404, not a silent no-op', async (httpMethod, path) => {
    stage({});
    const res = await handlePos(makeEvent({ httpMethod, path, body: '{}' }), ACTOR);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it.each([
    '/api/pos/cafe/open/',
    '/api/pos/cafe/close/extra',
    '/api/pos/cafe',
  ])('the café routes are EXACT matches — %s does not dispatch', async (path) => {
    stage({});
    const res = await handlePos(makeEvent({ httpMethod: 'PUT', path, body: null }), ACTOR);
    expect(res.statusCode).toBe(404);
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});
