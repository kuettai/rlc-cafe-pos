/**
 * The admin REPORTS routes in `backend/src/routes/admin.ts` — the date-range
 * report, discounts, sessions, monthly, daily, weekly, restock and inventory.
 * Menu / ingredients / recipes are covered by `admin-catalog.test.ts`; users,
 * settings and the misc tail are other suites. `admin.ts` is ~1030 lines and is
 * being covered one sub-resource per file.
 *
 * These eight branches are almost entirely PURE AGGREGATION over query results,
 * so the only assertion with teeth is on the NUMBER the handler produced,
 * hand-computed from the fixture. "Returns a number" is not evidence it is the
 * right number, and four of the eight numbers below are the ones the café
 * reconciles cash against.
 *
 * Five things are load-bearing and each is why a test below exists:
 *
 * 1. **`totalAmount` is NET, `discountOffset` is the reduction already applied**
 *    (conventions; `lib/daily-summary.ts:46` states it and deducts refunds only,
 *    "subtracting discounts again would double-count them"). `netExpected`
 *    (daily) and `netCollection` (monthly) both used to subtract it a SECOND
 *    time, understating the two figures the café reconciles cash against by the
 *    whole period's discount. Each now has a regression test asserting the net is
 *    the revenue — and, for daily, that it still deducts a post-completion
 *    cancel, which is the one thing that legitimately comes off it. Session
 *    revenue counted every status, cancelled orders included; that has its own
 *    pair of tests. All four are hand-computed from the fixtures.
 *
 * 2. **`/reports/daily` is a 3-bucket union with a first-wins dedupe**
 *    (today-scan, then the PREPARING/READY queries, then PENDING pre-orders).
 *    A dedupe is untestable unless the same record is actually staged into more
 *    than one bucket, so two orders here appear in two buckets each and the
 *    copies carry a `bucket` field the handler never reads — that is what proves
 *    WHICH copy survived, rather than merely that the count came out right.
 *
 * 3. **`/reports/sessions` derives its split time from the handover checklist
 *    inside a `try`/`catch`.** Both directions are exercised: a completed
 *    handover log (`splitSource: 'handover'`) and the fallback to 690 minutes,
 *    reached four different ways including a throwing read. The same order
 *    fixtures are run under both splits, so an order visibly MOVES between
 *    sessions — a fallback test that cannot change any bucket proves nothing.
 *
 * 4. **A staged fixture is what DynamoDB would have returned AFTER its
 *    FilterExpression.** The mock does not evaluate filters, so a test claiming
 *    "CANCELLED orders are excluded" would be vacuous where the exclusion is
 *    server-side. Those cases assert the `FilterExpression` /
 *    `ExpressionAttributeValues` the handler built instead. Where the filtering
 *    is in JS (`o.PK?.startsWith('ORDER#')`, `status === 'ARCHIVED' || 'READY'`,
 *    `postCompletionCancel === true`, `isPreOrder !== true`) the fixture reaches
 *    the guard and the assertion is on the output.
 *
 * 5. **Every "now" is injected.** `/reports/monthly`, `/reports/weekly` and the
 *    default `date` of the daily/discounts/sessions branches all read the wall
 *    clock, so the clock is pinned with `jest.setSystemTime`. The suite runs
 *    under `TZ=UTC` (`npm test`); the report code derives its dates from
 *    `toISOString()`, i.e. in UTC rather than through `lib/date.ts`, which one
 *    test pins deliberately.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked; the S3 client `admin.ts` builds at import time is mocked too. No
 * network, no credentials, nothing written to production — so no `ZZTEST_` marker
 * applies (that rule covers suites that create real records).
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

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Put' })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://example.invalid/presigned'),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleAdmin } = require('../src/routes/admin');

// ─── Clocks ───────────────────────────────────────────────────────────────────

/** Wednesday 2 Sep 2026, 12:00 MYT. The default clock for this suite. */
const WED_2026_09_02 = new Date('2026-09-02T04:00:00.000Z');
/** Sunday 6 Sep 2026, 09:00 MYT — mid-service, the date the fixtures use. */
const SUN_2026_09_06 = new Date('2026-09-06T01:00:00.000Z');
/** The service date most fixtures below carry. */
const SERVICE_DATE = '2026-09-06';

// ─── Order fixtures ───────────────────────────────────────────────────────────
// `totalAmount` NET, `grossAmount` undiscounted, `discountOffset` the reduction.
// Where a fixture's three money fields are mutually inconsistent that is
// DELIBERATE: it is how a test proves which field an aggregation read.

/** Discounted orders for /reports/discounts, on SERVICE_DATE. */
const D_NEWCOMER_1 = {
  PK: 'ORDER#d1', orderId: 'd1', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:00:00.000Z`,
  grossAmount: 11, totalAmount: 8, discountOffset: 3, discountType: 'NEWCOMER',
  items: [
    { name: 'Latte', category: 'DRINK', quantity: 2 },
    { name: 'Cookie', category: 'FOOD', quantity: 1 },
  ],
};
const D_NEWCOMER_2 = {
  PK: 'ORDER#d2', orderId: 'd2', status: 'READY', createdAt: `${SERVICE_DATE}T02:10:00.000Z`,
  grossAmount: 8, totalAmount: 6, discountOffset: 2, discountType: 'NEWCOMER',
  // No `quantity` — the breakdown must default it to 1, not skip the line.
  items: [{ name: 'Latte', category: 'DRINK' }],
};
const D_CELEBRATION = {
  PK: 'ORDER#d3', orderId: 'd3', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:20:00.000Z`,
  // gross − net is 10 here while discountOffset is 4. If the summary summed the
  // difference instead of the field, this row alone would report 10.
  grossAmount: 20, totalAmount: 10, discountOffset: 4, discountType: 'CELEBRATION',
  items: [{ name: 'Mocha', category: 'DRINK', quantity: 3 }],
};
const D_NONE = {
  PK: 'ORDER#d4', orderId: 'd4', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:30:00.000Z`,
  grossAmount: 9, totalAmount: 9, discountOffset: 0, discountType: 'NONE',
  items: [{ name: 'Latte', category: 'DRINK', quantity: 1 }],
};
const D_UNDISCOUNTED = {
  PK: 'ORDER#d5', orderId: 'd5', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:40:00.000Z`,
  grossAmount: 9, totalAmount: 9,
  items: [{ name: 'Mocha', category: 'DRINK', quantity: 1 }],
};
const D_PREORDER = {
  PK: 'ORDER#d6', orderId: 'd6', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:50:00.000Z`,
  grossAmount: 8, totalAmount: 0, discountOffset: 8, discountType: 'MINISTRY_PREORDER',
  isPreOrder: true,
  items: [{ name: 'Long Black', category: 'DRINK', quantity: 1 }],
};
/** Discounted but with NO `discountOffset` and no DRINK line at all. */
const D_STAFF_NO_OFFSET = {
  PK: 'ORDER#d7', orderId: 'd7', status: 'READY', createdAt: `${SERVICE_DATE}T03:00:00.000Z`,
  grossAmount: 5, totalAmount: 4, discountType: 'STAFF',
  items: [{ name: 'Cookie', category: 'FOOD', quantity: 2 }],
};

/** Orders for /reports/sessions, spread across the morning in MYT. */
const S_1000 = {
  PK: 'ORDER#s1', orderId: 's1', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:00:00.000Z`,
  totalAmount: 10, items: [{ name: 'Latte', quantity: 2 }],
};
/** 11:20 MYT — exactly the handover split minute, which is INCLUSIVE. */
const S_1120 = {
  PK: 'ORDER#s2', orderId: 's2', status: 'READY', createdAt: `${SERVICE_DATE}T03:20:00.000Z`,
  totalAmount: 5, items: [{ name: 'Latte', quantity: 1 }, { name: 'Cookie' }],
};
/** 11:21 MYT — one minute past the handover split, but before the 11:30 default. */
const S_1121 = {
  PK: 'ORDER#s3', orderId: 's3', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T03:21:00.000Z`,
  totalAmount: 8, items: [{ name: 'Mocha', quantity: 1 }],
};
/** 13:00 MYT, and CANCELLED — never collected, so never session revenue. */
const S_1300_CANCELLED = {
  PK: 'ORDER#s4', orderId: 's4', status: 'CANCELLED', createdAt: `${SERVICE_DATE}T05:00:00.000Z`,
  totalAmount: 7, items: [{ name: 'Tea', quantity: 1 }],
};
/**
 * 13:10 MYT and ARCHIVED. Keeps session 2 non-empty under BOTH splits, so the
 * cancelled order above is excluded against a live bucket rather than against a
 * bucket that would have been empty anyway.
 */
const S_1310 = {
  PK: 'ORDER#s5', orderId: 's5', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T05:10:00.000Z`,
  totalAmount: 6, items: [{ name: 'Soda', quantity: 1 }],
};
/** A post-completion cancel: a refund of a real sale, also not session revenue. */
const S_1030_REFUNDED = {
  PK: 'ORDER#s6', orderId: 's6', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:30:00.000Z`,
  totalAmount: 9, postCompletionCancel: true, items: [{ name: 'Muffin', quantity: 1 }],
};
const SESSION_ORDERS = [S_1000, S_1120, S_1121, S_1300_CANCELLED, S_1310];

/** A completed handover checklist log — the `splitSource: 'handover'` input. */
const HANDOVER_COMPLETE = {
  PK: `CHECKLIST_LOG#${SERVICE_DATE}#handover`, SK: 'META', allCompleted: true,
  items: {
    wipeMachine: { checked: true, completedAt: `${SERVICE_DATE}T03:05:00.000Z` },
    countCash: { checked: true, completedAt: `${SERVICE_DATE}T03:20:00.000Z` }, // latest
    restock: { checked: false },                                               // no timestamp
  },
};

// ─── Ingredient fixtures ──────────────────────────────────────────────────────

/** stock 6 vs threshold 4 → exactly 1.5×, the inclusive restock boundary. */
const MILK = {
  PK: 'INGREDIENT#milk-001', SK: 'META', ingredientId: 'milk-001', name: 'Fresh Milk',
  unit: 'L', currentStock: 6, lowStockThreshold: 4, storageLocation: 'Fridge', isActive: true,
};
/** 7 vs 4 → 7 > 6, just outside the restock window. */
const BEANS = {
  PK: 'INGREDIENT#beans-002', SK: 'META', ingredientId: 'beans-002', name: 'Coffee Beans',
  unit: 'kg', currentStock: 7, lowStockThreshold: 4, storageLocation: 'Shelf', isActive: true,
};
const SYRUP = {
  PK: 'INGREDIENT#syrup-003', SK: 'META', ingredientId: 'syrup-003', name: 'Vanilla Syrup',
  unit: 'bottle', currentStock: 1, lowStockThreshold: 2, storageLocation: 'Shelf', isActive: true,
};
const CUPS = {
  PK: 'INGREDIENT#cups-004', SK: 'META', ingredientId: 'cups-004', name: 'Paper Cups',
  unit: 'pcs', currentStock: 0, lowStockThreshold: 10, storageLocation: 'Store', isActive: true,
};
/** A DISABLED ingredient that is nonetheless low. */
const OAT_MILK_OFF = {
  PK: 'INGREDIENT#oat-005', SK: 'META', ingredientId: 'oat-005', name: 'Oat Milk',
  unit: 'L', currentStock: 1, lowStockThreshold: 5, storageLocation: 'Fridge', isActive: false,
};
/** A legacy row with neither stock nor threshold — every comparison is NaN. */
const LEGACY_SUGAR = {
  PK: 'INGREDIENT#sugar-006', SK: 'META', ingredientId: 'sugar-006', name: 'Sugar', unit: 'kg',
};
const ALL_INGREDIENTS = [MILK, BEANS, SYRUP, CUPS, OAT_MILK_OFF, LEGACY_SUGAR];

// ─── Staging ──────────────────────────────────────────────────────────────────

type World = {
  /** Answers the `Scan` on the orders table (today-scan / weekly / monthly). */
  ordersScan?: any[];
  /** Answers the `Query` on `status-createdAt-index`, keyed by the `:s` value. */
  ordersByStatus?: Record<string, any[]>;
  /** Answers the `Scan` on the ingredients table. */
  ingredients?: any[];
  /** The handover checklist `Get` on the settings table. `'throw'` → rejects. */
  handover?: Record<string, unknown> | 'throw';
};

/**
 * Answer every read from a described world, keyed on the command the handler
 * actually built — never a `mockResolvedValueOnce` queue, which lets a fixture
 * silently fill the wrong slot in a multi-query handler (`invariants`, Test
 * teeth). `/reports/daily` alone issues four reads against two shapes.
 */
function stage(world: World) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Get' && cmd.TableName === 'test-settings') {
      if (world.handover === 'throw') throw new Error('checklist log read failed');
      return world.handover ? { Item: world.handover } : {};
    }
    if (cmd.__cmd === 'Query' && cmd.TableName === 'test-orders') {
      const status = String(cmd.ExpressionAttributeValues?.[':s'] ?? '');
      return { Items: world.ordersByStatus?.[status] ?? [] };
    }
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-orders') {
      return { Items: world.ordersScan ?? [] };
    }
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-ingredients') {
      return { Items: world.ingredients ?? [] };
    }
    return {};
  });
}

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET', path: '/api/admin/reports', body: null,
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

/** GET a report path and return the parsed body the handler produced. */
async function getReport(path: string, queryStringParameters: Record<string, string> | null = null) {
  const res = await handleAdmin(makeEvent({ path, queryStringParameters } as any));
  expect(res.statusCode).toBe(200);
  expect(res.headers).toEqual({ 'Content-Type': 'application/json' });
  return JSON.parse(res.body);
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function writes() { return cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd)); }

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.setSystemTime(WED_2026_09_02);
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports — the date-range reconciliation report
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/reports — argument validation happens BEFORE any read', () => {
  it.each([
    ['no query string at all', null, 'startDate and endDate query params required (YYYY-MM-DD)'],
    ['only startDate', { startDate: '2026-09-06' }, 'startDate and endDate query params required (YYYY-MM-DD)'],
    ['only endDate', { endDate: '2026-09-06' }, 'startDate and endDate query params required (YYYY-MM-DD)'],
    ['an empty startDate', { startDate: '', endDate: '2026-09-06' }, 'startDate and endDate query params required (YYYY-MM-DD)'],
    ['an unpadded startDate', { startDate: '2026-9-6', endDate: '2026-09-06' }, 'startDate / endDate must be YYYY-MM-DD'],
    ['an ISO instant', { startDate: '2026-09-06T00:00:00Z', endDate: '2026-09-06' }, 'startDate / endDate must be YYYY-MM-DD'],
    ['a reversed range', { startDate: '2026-09-07', endDate: '2026-09-06' }, 'endDate must be on or after startDate'],
  ])('rejects %s with 400 and reads nothing', async (_name, qs, expected) => {
    const res = await handleAdmin(makeEvent({ path: '/api/admin/reports', queryStringParameters: qs } as any));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: expected });
    // "No error thrown" is not an assertion — the guard must return before the
    // four paginated Queries, or a typo'd date costs four full index scans.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('accepts a single-day range where startDate === endDate', async () => {
    stage({ ordersByStatus: {} });
    const body = await getReport('/api/admin/reports', { startDate: SERVICE_DATE, endDate: SERVICE_DATE });
    expect(body).toEqual({ orders: [], startDate: SERVICE_DATE, endDate: SERVICE_DATE });
  });
});

describe('GET /api/admin/reports — which orders are reportable, and in what order', () => {
  const ARCHIVED_LATE = {
    PK: 'ORDER#a1', orderId: 'a1', status: 'ARCHIVED',
    createdAt: `${SERVICE_DATE}T05:00:00.000Z`, totalAmount: 12,
  };
  const READY_EARLY = {
    PK: 'ORDER#r1', orderId: 'r1', status: 'READY',
    createdAt: `${SERVICE_DATE}T02:00:00.000Z`, totalAmount: 8,
  };
  const PREPARING_MID = {
    PK: 'ORDER#p1', orderId: 'p1', status: 'PREPARING',
    createdAt: `${SERVICE_DATE}T04:00:00.000Z`, totalAmount: 6,
  };
  /** A refund of a real sale — reportable. */
  const CANCEL_POST = {
    PK: 'ORDER#c1', orderId: 'c1', status: 'CANCELLED', postCompletionCancel: true,
    createdAt: `${SERVICE_DATE}T03:00:00.000Z`, totalAmount: 7,
  };
  /** A PENDING-stage rejection — never a transaction, so NOT reportable. */
  const CANCEL_REJECTED = {
    PK: 'ORDER#c2', orderId: 'c2', status: 'CANCELLED', rejectionReason: 'no payment',
    createdAt: `${SERVICE_DATE}T03:30:00.000Z`, totalAmount: 5,
  };
  /** The flag present but false — must be treated as a rejection, not a refund. */
  const CANCEL_FLAG_FALSE = {
    PK: 'ORDER#c3', orderId: 'c3', status: 'CANCELLED', postCompletionCancel: false,
    createdAt: `${SERVICE_DATE}T03:45:00.000Z`, totalAmount: 4,
  };

  beforeEach(() => {
    stage({
      ordersByStatus: {
        ARCHIVED: [ARCHIVED_LATE],
        READY: [READY_EARLY],
        PREPARING: [PREPARING_MID],
        CANCELLED: [CANCEL_POST, CANCEL_REJECTED, CANCEL_FLAG_FALSE],
      },
    });
  });

  it('keeps only post-completion cancels, and sorts the merged buckets by createdAt', async () => {
    const body = await getReport('/api/admin/reports', { startDate: SERVICE_DATE, endDate: SERVICE_DATE });

    // The four buckets are queried newest-status-first and each returns its own
    // order; the sort is what makes the merged list chronological. Asserting the
    // ids in order is what proves the merge ran, not just that 4 rows came back.
    expect(body.orders.map((o: any) => o.orderId)).toEqual(['r1', 'c1', 'p1', 'a1']);
    expect(body.orders).toHaveLength(4);
    // Both non-refund cancels reached the `postCompletionCancel === true` guard.
    expect(body.orders.map((o: any) => o.orderId)).not.toContain('c2');
    expect(body.orders.map((o: any) => o.orderId)).not.toContain('c3');
    expect(body.startDate).toBe(SERVICE_DATE);
    expect(body.endDate).toBe(SERVICE_DATE);
  });

  it('queries the four reportable statuses on the index, and no others', async () => {
    await getReport('/api/admin/reports', { startDate: SERVICE_DATE, endDate: SERVICE_DATE });

    const queries = cmds().filter((c) => c.__cmd === 'Query');
    expect(queries.map((q) => q.ExpressionAttributeValues[':s']))
      .toEqual(['ARCHIVED', 'READY', 'PREPARING', 'CANCELLED']);
    // PENDING and EXPIRED are deliberately never asked for.
    expect(queries.map((q) => q.ExpressionAttributeValues[':s'])).not.toContain('PENDING');
    expect(queries.map((q) => q.ExpressionAttributeValues[':s'])).not.toContain('EXPIRED');
    for (const q of queries) {
      expect(q.TableName).toBe('test-orders');
      expect(q.IndexName).toBe('status-createdAt-index');
      expect(q.KeyConditionExpression).toBe('#s = :s AND createdAt BETWEEN :start AND :end');
      expect(q.ExpressionAttributeNames).toEqual({ '#s': 'status' });
    }
    expect(writes()).toHaveLength(0);
  });

  it('turns the two YYYY-MM-DD params into an inclusive whole-day UTC window', async () => {
    await getReport('/api/admin/reports', { startDate: '2026-08-30', endDate: SERVICE_DATE });

    const q = cmds().find((c) => c.__cmd === 'Query');
    expect(q.ExpressionAttributeValues[':start']).toBe('2026-08-30T00:00:00.000Z');
    // .999Z, not the next midnight — an order at 23:59:59.500 on the end date is
    // inside the window and must not be dropped.
    expect(q.ExpressionAttributeValues[':end']).toBe('2026-09-06T23:59:59.999Z');
  });

  it('PAGINATES each status query until LastEvaluatedKey is gone', async () => {
    // A single Query returns at most 1MB. Without the ExclusiveStartKey loop a
    // wide date range silently truncates — and a truncated reconciliation report
    // is worse than no report, because it looks complete.
    const PAGE_1 = { PK: 'ORDER#pg1', orderId: 'pg1', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:00:00.000Z` };
    const PAGE_2 = { PK: 'ORDER#pg2', orderId: 'pg2', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:30:00.000Z` };
    const LAST_KEY = { PK: 'ORDER#pg1', createdAt: `${SERVICE_DATE}T02:00:00.000Z` };

    mockDbSend.mockReset();
    let archivedCalls = 0;
    mockDbSend.mockImplementation(async (cmd: any) => {
      if (cmd.ExpressionAttributeValues?.[':s'] === 'ARCHIVED') {
        archivedCalls++;
        return archivedCalls === 1
          ? { Items: [PAGE_1], LastEvaluatedKey: LAST_KEY }
          : { Items: [PAGE_2] };
      }
      return { Items: [] };
    });

    const body = await getReport('/api/admin/reports', { startDate: SERVICE_DATE, endDate: SERVICE_DATE });

    expect(body.orders.map((o: any) => o.orderId)).toEqual(['pg1', 'pg2']);
    expect(archivedCalls).toBe(2);
    const archived = cmds().filter((c) => c.ExpressionAttributeValues?.[':s'] === 'ARCHIVED');
    expect(archived[0].ExclusiveStartKey).toBeUndefined();
    expect(archived[1].ExclusiveStartKey).toEqual(LAST_KEY);
    // Five reads in total: 2 pages of ARCHIVED + one each for the other three.
    expect(cmds()).toHaveLength(5);
  });

  it('is dispatched by EXACT path match, so a trailing slash is a 404', async () => {
    // Every other admin branch uses `path.endsWith(...)`; this one is
    // `path === '/api/admin/reports'`. Pinned because it is the only branch in
    // the file whose matching would break if the router ever prefixed a stage.
    const res = await handleAdmin(makeEvent({
      path: '/api/admin/reports/', queryStringParameters: { startDate: SERVICE_DATE, endDate: SERVICE_DATE },
    } as any));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('Not found');
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports/discounts
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/reports/discounts — the offset summary', () => {
  const ALL_DISCOUNT_ORDERS = [
    D_NEWCOMER_1, D_NEWCOMER_2, D_CELEBRATION, D_NONE, D_UNDISCOUNTED, D_PREORDER, D_STAFF_NO_OFFSET,
  ];

  it('groups by discountType and sums discountOffset — hand-computed', async () => {
    stage({ ordersScan: ALL_DISCOUNT_ORDERS });

    const body = await getReport('/api/admin/reports/discounts', { date: SERVICE_DATE });

    // NEWCOMER: 3 + 2 = 5 over two orders. CELEBRATION: 4 — NOT the 10 that
    // grossAmount − totalAmount would give for that fixture, which is how this
    // pins the field being summed. MINISTRY_PREORDER: the whole 8 gross written
    // off. STAFF: no discountOffset attribute at all → 0, not NaN.
    expect(body.summary).toEqual({
      NEWCOMER: { count: 2, totalOffset: 5 },
      CELEBRATION: { count: 1, totalOffset: 4 },
      MINISTRY_PREORDER: { count: 1, totalOffset: 8 },
      STAFF: { count: 1, totalOffset: 0 },
    });
    // 'NONE' and the order with no discountType are both filtered out in JS.
    expect(Object.keys(body.summary)).not.toContain('NONE');
    expect(body.totalDiscountedOrders).toBe(5);
    expect(body.totalOffset).toBe(17); // 3 + 2 + 4 + 8 + 0
  });

  it('drinkBreakdown counts DRINK lines per discount type and skips FOOD', async () => {
    stage({ ordersScan: ALL_DISCOUNT_ORDERS });

    const body = await getReport('/api/admin/reports/discounts', { date: SERVICE_DATE });

    expect(body.drinkBreakdown).toEqual({
      NEWCOMER: { Latte: 3 },            // 2 from d1, then d2's line with NO quantity → 1
      CELEBRATION: { Mocha: 3 },
      MINISTRY_PREORDER: { 'Long Black': 1 },
      // STAFF is absent, not `{}`: the key is only created when a DRINK is seen,
      // and d7 is two cookies.
    });
    expect(body.drinkBreakdown.STAFF).toBeUndefined();
    // FOOD is excluded from THIS aggregate only. It is counted in the parallel
    // `foodBreakdown` — see the next test — because PASTOR/NEWCOMER discount food.
    expect(JSON.stringify(body.drinkBreakdown)).not.toContain('Cookie');
  });

  it('foodBreakdown counts FOOD lines per discount type and skips DRINK', async () => {
    stage({ ordersScan: ALL_DISCOUNT_ORDERS });

    const body = await getReport('/api/admin/reports/discounts', { date: SERVICE_DATE });

    // Hand-computed from the fixtures: d1 (NEWCOMER) has one Cookie alongside its
    // two Lattes; d7 (STAFF) is two Cookies and nothing else. d2/d3/d4/d6 are
    // drink-only, so they contribute no keys at all.
    expect(body.foodBreakdown).toEqual({
      NEWCOMER: { Cookie: 1 },
      STAFF: { Cookie: 2 },
    });
    // The asymmetry worth pinning: d7 appears HERE but is absent from
    // drinkBreakdown, and the drink-only CELEBRATION / MINISTRY_PREORDER orders
    // are the other way round. A type with no matching line gets no key — not an
    // empty object — in both aggregates.
    expect(body.drinkBreakdown.STAFF).toBeUndefined();
    expect(body.foodBreakdown.CELEBRATION).toBeUndefined();
    expect(body.foodBreakdown.MINISTRY_PREORDER).toBeUndefined();
    expect(JSON.stringify(body.foodBreakdown)).not.toContain('Latte');
  });

  it('scopes the scan to the requested date and to completed sales only', async () => {
    // DynamoDB applies this FilterExpression, not the handler, so the ONLY
    // honest assertion is on the command the handler built.
    stage({ ordersScan: [] });

    await getReport('/api/admin/reports/discounts', { date: '2026-08-30' });

    const scan = cmds().find((c) => c.__cmd === 'Scan');
    expect(scan.TableName).toBe('test-orders');
    expect(scan.FilterExpression).toBe('begins_with(createdAt, :today) AND #s IN (:s1, :s2)');
    expect(scan.ExpressionAttributeValues).toEqual({
      ':today': '2026-08-30', ':s1': 'ARCHIVED', ':s2': 'READY',
    });
    expect(scan.ExpressionAttributeNames).toEqual({ '#s': 'status' });
    expect(writes()).toHaveLength(0);
  });

  it('defaults the date to TODAY IN MALAYSIA TIME when no date param is given', async () => {
    // Fixed: the reports now derive "today" from `malaysiaToday()`
    // (`lib/date.ts`) instead of `new Date().toISOString()`. Between 00:00
    // and 08:00 MYT, UTC still names the previous day — this pins that the
    // admin dashboard no longer inherits that divergence.
    jest.setSystemTime(new Date('2026-09-06T17:00:00.000Z')); // 01:00 MYT, Mon 7 Sep
    stage({ ordersScan: [] });

    const body = await getReport('/api/admin/reports/discounts');

    const scan = cmds().find((c) => c.__cmd === 'Scan');
    expect(scan.ExpressionAttributeValues[':today']).toBe('2026-09-07');
    expect(body.totalDiscountedOrders).toBe(0);
  });

  it('returns empty aggregates, not nulls, when the day had no discounts', async () => {
    stage({ ordersScan: [D_NONE, D_UNDISCOUNTED] });

    const body = await getReport('/api/admin/reports/discounts', { date: SERVICE_DATE });

    expect(body).toEqual({
      summary: {}, drinkBreakdown: {}, foodBreakdown: {}, totalDiscountedOrders: 0, totalOffset: 0,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports/sessions — the handover split
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/reports/sessions — split derived from the handover checklist', () => {
  it('takes the LAST completed checklist timestamp as the split, converted to MYT', async () => {
    stage({ ordersScan: SESSION_ORDERS, handover: HANDOVER_COMPLETE });

    const body = await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE });

    // 03:20Z → 11:20 MYT → 11*60 + 20 = 680. The 03:05 entry is earlier and the
    // unchecked row has no timestamp, so neither can win.
    expect(body.splitSource).toBe('handover');
    expect(body.splitMinutes).toBe(680);
    expect(body.splitTime).toBe('11:20');
    expect(body.date).toBe(SERVICE_DATE);
  });

  it('reads the checklist log for the SAME date as the orders', async () => {
    stage({ ordersScan: [], handover: HANDOVER_COMPLETE });

    await getReport('/api/admin/reports/sessions', { date: '2026-08-30' });

    const get = cmds().find((c) => c.__cmd === 'Get');
    expect(get.TableName).toBe('test-settings');
    expect(get.Key).toEqual({ PK: 'CHECKLIST_LOG#2026-08-30#handover', SK: 'META' });
    const scan = cmds().find((c) => c.__cmd === 'Scan');
    expect(scan.FilterExpression).toBe('begins_with(createdAt, :today)');
    expect(scan.ExpressionAttributeValues).toEqual({ ':today': '2026-08-30' });
  });

  it('buckets on the split INCLUSIVELY and aggregates each session — hand-computed', async () => {
    stage({ ordersScan: SESSION_ORDERS, handover: HANDOVER_COMPLETE });

    const body = await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE });

    // Session 1 = 10:00 and 11:20 (`localMinutes <= splitMinutes`, so the order
    // placed AT 11:20 belongs to the first shift). 10 + 5 = 15 over 2 orders.
    expect(body.session1.orderCount).toBe(2);
    expect(body.session1.revenue).toBe(15);
    expect(body.session1.avgOrderValue).toBe(7.5);
    // Latte 2 (s1) + 1 (s2) = 3; Cookie has no `quantity` → 1.
    expect(body.session1.topItems).toEqual([{ name: 'Latte', count: 3 }, { name: 'Cookie', count: 1 }]);
    expect(body.session1.timeRange).toBe('8:00 – 11:20 MYT');

    // Session 2 = 11:21 and 13:10. The 13:00 CANCELLED order is in the same
    // bucket and contributes nothing. 8 + 6 = 14 over 2 orders.
    expect(body.session2.orderCount).toBe(2);
    expect(body.session2.revenue).toBe(14);
    expect(body.session2.avgOrderValue).toBe(7);
    expect(body.session2.topItems).toEqual([{ name: 'Mocha', count: 1 }, { name: 'Soda', count: 1 }]);
    // s2 starts the minute AFTER the split, so there is no shared boundary
    // minute and no one-minute gap.
    expect(body.session2.timeRange).toBe('11:21 – 14:00 MYT');
  });

  it('counts COMPLETED SALES only — a CANCELLED order is not session revenue', async () => {
    // Regression: this branch used to be `const orders = result.Items || []` with
    // no status filter at all, unlike /reports/daily, /weekly and /monthly, so a
    // cancelled order was billed as session revenue. That is the exact bug
    // `lib/daily-summary.ts:37-45` records as having inflated the 2026-08-09
    // emailed net by RM 52.40 before it was fixed there.
    stage({ ordersScan: SESSION_ORDERS, handover: HANDOVER_COMPLETE });

    const body = await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE });

    // The RM 7 cancelled order sits in session 2 and is excluded from BOTH the
    // money and the item counts — the same subset `summarizeDailyRevenue` uses
    // for its own top-items list.
    expect(body.session2.revenue).toBe(14);
    expect(body.session2.orderCount).toBe(2);
    expect(body.session2.topItems.map((i: any) => i.name)).not.toContain('Tea');
    // …so the sessions card now reconciles with the daily card: 15 + 14 = 29,
    // which is the completed-sales revenue for these same fixtures.
    expect(body.session1.revenue + body.session2.revenue).toBe(29);
  });

  it('excludes a POST-COMPLETION CANCEL too — an ARCHIVED order that was refunded', async () => {
    // The subtler half of the same rule. `S_1030_REFUNDED` is ARCHIVED, so a
    // status-only filter would count it; it carries `postCompletionCancel`, so
    // the money was handed back and it is not revenue either.
    stage({ ordersScan: [...SESSION_ORDERS, S_1030_REFUNDED], handover: HANDOVER_COMPLETE });

    const body = await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE });

    // 10:30 MYT is in session 1, which is unchanged at RM 15 over 2 orders.
    expect(body.session1.revenue).toBe(15);
    expect(body.session1.orderCount).toBe(2);
    expect(body.session1.topItems.map((i: any) => i.name)).not.toContain('Muffin');
  });
});

describe('GET /api/admin/reports/sessions — the 690-minute fallback, all four ways in', () => {
  /** The same orders under the default split: 11:21 lands in session 1. */
  async function expectDefaultSplit(body: any) {
    expect(body.splitSource).toBe('default');
    expect(body.splitMinutes).toBe(690);
    expect(body.splitTime).toBe('11:30');
    expect(body.session1.timeRange).toBe('8:00 – 11:30 MYT');
    expect(body.session2.timeRange).toBe('11:31 – 14:00 MYT');
    // The teeth: the 11:21 order MOVED out of session 2 into session 1, so the
    // fallback demonstrably changed the bucketing rather than just a label.
    expect(body.session1.orderCount).toBe(3);
    expect(body.session1.revenue).toBe(23);              // 10 + 5 + 8
    expect(body.session1.avgOrderValue).toBe(7.67);      // round(23/3 * 100) / 100
    expect(body.session1.topItems).toEqual([
      { name: 'Latte', count: 3 }, { name: 'Cookie', count: 1 }, { name: 'Mocha', count: 1 },
    ]);
    // Only the 13:10 sale is left in session 2; the 13:00 CANCELLED order is not
    // revenue under either split.
    expect(body.session2.orderCount).toBe(1);
    expect(body.session2.revenue).toBe(6);
    expect(body.session2.avgOrderValue).toBe(6);
    expect(body.session2.topItems).toEqual([{ name: 'Soda', count: 1 }]);
  }

  it('falls back when the checklist READ THROWS (the try/catch path)', async () => {
    stage({ ordersScan: SESSION_ORDERS, handover: 'throw' });

    const body = await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE });

    // The inner catch must swallow it: a broken checklist read may not turn the
    // whole sessions card into the outer handler's 500.
    await expectDefaultSplit(body);
  });

  it('falls back when there is no checklist log for the date', async () => {
    stage({ ordersScan: SESSION_ORDERS });
    await expectDefaultSplit(await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE }));
  });

  it('falls back when the handover was started but NOT allCompleted', async () => {
    stage({
      ordersScan: SESSION_ORDERS,
      handover: {
        ...HANDOVER_COMPLETE, allCompleted: false,
        items: { countCash: { checked: true, completedAt: `${SERVICE_DATE}T03:20:00.000Z` } },
      },
    });
    // A timestamp IS present and reachable — only `allCompleted` differs, so
    // this pins the flag rather than the absence of data.
    await expectDefaultSplit(await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE }));
  });

  it('falls back when completed rows carry an UNPARSEABLE completedAt', async () => {
    stage({
      ordersScan: SESSION_ORDERS,
      handover: {
        ...HANDOVER_COMPLETE, allCompleted: true,
        items: { countCash: { checked: true, completedAt: 'yesterday-ish' } },
      },
    });
    await expectDefaultSplit(await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE }));
  });

  it('falls back when allCompleted is true but no row has a timestamp', async () => {
    stage({
      ordersScan: SESSION_ORDERS,
      handover: { ...HANDOVER_COMPLETE, allCompleted: true, items: { countCash: { checked: true } } },
    });
    await expectDefaultSplit(await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE }));
  });

  it('returns two empty sessions rather than dividing by zero', async () => {
    stage({ ordersScan: [] });

    const body = await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE });

    expect(body.session1).toEqual({ orderCount: 0, revenue: 0, avgOrderValue: 0, topItems: [], timeRange: '8:00 – 11:30 MYT' });
    expect(body.session2.avgOrderValue).toBe(0);
    expect(writes()).toHaveLength(0);
  });

  it('caps topItems at THREE per session', async () => {
    const many = {
      PK: 'ORDER#many', orderId: 'many', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:00:00.000Z`,
      totalAmount: 20,
      items: [
        { name: 'Latte', quantity: 5 }, { name: 'Mocha', quantity: 4 },
        { name: 'Tea', quantity: 3 }, { name: 'Soda', quantity: 2 }, { name: 'Water', quantity: 1 },
      ],
    };
    stage({ ordersScan: [many] });

    const body = await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE });

    expect(body.session1.topItems).toEqual([
      { name: 'Latte', count: 5 }, { name: 'Mocha', count: 4 }, { name: 'Tea', count: 3 },
    ]);
  });

  it('hardcodes an 8:00–14:00 frame that ignores the configured openingHours', async () => {
    // Known invariant violation, recorded in the `invariants` skill as one of the
    // five disagreeing notions of when the café opens. Pinned so a fix has to
    // change a test rather than slip through: the labels are literals in
    // `admin.ts:522` / `:526`, not derived from `lib/opening-hours.ts`.
    stage({ ordersScan: [] });
    const body = await getReport('/api/admin/reports/sessions', { date: SERVICE_DATE });
    expect(body.session1.timeRange).toMatch(/^8:00 – /);
    expect(body.session2.timeRange).toMatch(/ – 14:00 MYT$/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports/monthly — rolling 30 days
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/reports/monthly', () => {
  const M1_NEWCOMER_CLASS = {
    PK: 'ORDER#m1', orderId: 'm1', status: 'ARCHIVED', createdAt: '2026-08-09T02:00:00.000Z',
    grossAmount: 12, totalAmount: 10, discountOffset: 2, customerClass: 'NEWCOMER',
    items: [{ name: 'Latte', category: 'DRINK', quantity: 2 }],
  };
  const M2_NEWCOMER_TYPE = {
    PK: 'ORDER#m2', orderId: 'm2', status: 'READY', createdAt: '2026-08-16T02:30:00.000Z',
    grossAmount: 8, totalAmount: 8, discountOffset: 0, discountType: 'NEWCOMER',
    items: [{ name: 'Latte', category: 'DRINK', quantity: 1 }, { name: 'Mocha', category: 'DRINK', quantity: 1 }],
  };
  const M3 = {
    PK: 'ORDER#m3', orderId: 'm3', status: 'ARCHIVED', createdAt: '2026-08-30T02:00:00.000Z',
    grossAmount: 20, totalAmount: 15, discountOffset: 5,
    items: [{ name: 'Cookie', category: 'FOOD', quantity: 1 }, { name: 'Tea', category: 'DRINK', quantity: 2 }],
  };
  /** CANCELLED, and deliberately huge — if it leaked in, every total would move. */
  const M4_CANCELLED = {
    PK: 'ORDER#m4', orderId: 'm4', status: 'CANCELLED', createdAt: '2026-08-30T03:00:00.000Z',
    grossAmount: 150, totalAmount: 100, discountOffset: 50,
    items: [{ name: 'Latte', category: 'DRINK', quantity: 10 }],
  };
  const M5_TODAY = {
    PK: 'ORDER#m5', orderId: 'm5', status: 'ARCHIVED', createdAt: '2026-09-02T01:00:00.000Z',
    grossAmount: 8, totalAmount: 7, discountOffset: 1,
    items: [{ name: 'Long Black', category: 'DRINK', quantity: 1 }],
  };
  /** A non-order row in the same table — the `PK.startsWith('ORDER#')` guard. */
  const NOT_AN_ORDER = {
    PK: 'DAILY_SUMMARY#2026-08-30', SK: 'META', status: 'ARCHIVED',
    createdAt: '2026-08-30T09:00:00.000Z', totalAmount: 999, discountOffset: 111,
  };
  const MONTH_SCAN = [M1_NEWCOMER_CLASS, M2_NEWCOMER_TYPE, M3, M4_CANCELLED, M5_TODAY, NOT_AN_ORDER];

  it('totals only completed sales from ORDER# rows — hand-computed', async () => {
    stage({ ordersScan: MONTH_SCAN });

    const body = await getReport('/api/admin/reports/monthly');

    // m1 + m2 + m3 + m5. The CANCELLED RM 100 and the RM 999 summary row are
    // both filtered out in JS, so both guards are genuinely reached.
    expect(body.totalOrders).toBe(4);
    expect(body.totalRevenue).toBe(40);   // 10 + 8 + 15 + 7, all NET
    expect(body.totalOffsets).toBe(8);    // 2 + 0 + 5 + 1
  });

  it('netCollection does NOT re-subtract discountOffset from an already-NET revenue', async () => {
    stage({ ordersScan: MONTH_SCAN });

    const body = await getReport('/api/admin/reports/monthly');

    // Regression: this was `netCollection = totalRevenue - totalOffsets`, where
    // totalRevenue sums `totalAmount` — ALREADY net of the discount. The discount
    // was therefore deducted twice and the month understated by RM 8 of these
    // fixtures. `lib/daily-summary.ts:46` states the rule and deducts refunds
    // only: "subtracting discounts again would double-count them".
    expect(body.netCollection).toBe(40);
    expect(body.netCollection).toBe(body.totalRevenue);
    expect(body.netCollection).not.toBe(body.totalRevenue - body.totalOffsets);
    // `totalOffsets` is still reported as CONTEXT — it is rendered next to the
    // figure in the shared monthly text report (`admin.js:1572`) — so the fix is
    // that it stopped being deducted, not that it stopped being returned.
    expect(body.totalOffsets).toBe(8);
  });

  it('counts newcomers via isNewcomerOrder — customerClass OR discountType', async () => {
    stage({ ordersScan: MONTH_SCAN });

    const body = await getReport('/api/admin/reports/monthly');

    // m1 carries `customerClass: 'NEWCOMER'` and m2 `discountType: 'NEWCOMER'`.
    // A discountType-only check would report 1 and a class-only check 1; only
    // `isNewcomerOrder()` reports both.
    expect(body.newcomersServed).toBe(2);
  });

  it('counts DISTINCT service days and rounds the average', async () => {
    stage({ ordersScan: MONTH_SCAN });

    const body = await getReport('/api/admin/reports/monthly');

    // 08-09, 08-16, 08-30, 09-02 — the CANCELLED order shares 08-30 and must not
    // add a fifth day, since the date set is built from the filtered orders.
    expect(body.serviceDays).toBe(4);
    expect(body.avgOrdersPerServiceDay).toBe(1); // Math.round(4 / 4)
  });

  it('ranks the top five items and accumulates quantities across orders', async () => {
    stage({ ordersScan: MONTH_SCAN });

    const body = await getReport('/api/admin/reports/monthly');

    // Latte 2 (m1) + 1 (m2) = 3; Tea 2; the rest 1 each. Ties keep first-seen
    // order because Array#sort is stable. FOOD counts here in the SAME list as
    // drinks — this is a popularity ranking, not a money figure, so it needs no
    // per-category split (the discount report splits DRINK and FOOD into two
    // breakdowns because there the categories are discounted by different rules).
    expect(body.topItems).toEqual([
      { name: 'Latte', count: 3 }, { name: 'Tea', count: 2 },
      { name: 'Mocha', count: 1 }, { name: 'Cookie', count: 1 }, { name: 'Long Black', count: 1 },
    ]);
  });

  it('buckets revenue into weeks, merging two orders in the same week', async () => {
    stage({ ordersScan: MONTH_SCAN });

    const body = await getReport('/api/admin/reports/monthly');

    // Hand-computed with the handler's own (non-ISO) formula, anchored on Jan 4
    // 2026 which is a Sunday: 08-09 → W32, 08-16 → W33, 08-30 and 09-02 → both
    // W35, so the last bucket must hold 2 orders and 15 + 7 = 22.
    expect(body.weeklyBreakdown).toEqual([
      { week: '2026-W32', orders: 1, revenue: 10 },
      { week: '2026-W33', orders: 1, revenue: 8 },
      { week: '2026-W35', orders: 2, revenue: 22 },
    ]);
  });

  it('scans a rolling 30-day INSTANT while labelling the period as a calendar month', async () => {
    stage({ ordersScan: [] });

    const body = await getReport('/api/admin/reports/monthly');

    const scan = cmds().find((c) => c.__cmd === 'Scan');
    expect(scan.TableName).toBe('test-orders');
    expect(scan.FilterExpression).toBe('createdAt >= :start');
    // Not a day boundary — 04:00Z, i.e. the earliest day in the window is only
    // partly covered, and the window slides with the time of the request.
    expect(scan.ExpressionAttributeValues).toEqual({ ':start': '2026-08-03T04:00:00.000Z' });
    // …while the heading says September, of which the window contains 2 days.
    // Pinned as-is: the label and the data describe different periods.
    expect(body.period).toBe('September 2026');
    expect(writes()).toHaveLength(0);
  });

  it('returns zeros for an empty month instead of NaN', async () => {
    stage({ ordersScan: [] });

    const body = await getReport('/api/admin/reports/monthly');

    expect(body).toEqual({
      period: 'September 2026', totalOrders: 0, totalRevenue: 0, totalOffsets: 0,
      netCollection: 0, newcomersServed: 0, serviceDays: 0, avgOrdersPerServiceDay: 0,
      topItems: [], weeklyBreakdown: [],
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports/daily — the three-bucket union
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/reports/daily — union of three buckets, deduped by orderId', () => {
  // Bucket 1: created today, any status.
  const T_ARCHIVED = {
    PK: 'ORDER#o-1', orderId: 'o-1', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:00:00.000Z`,
    grossAmount: 15, totalAmount: 12, discountOffset: 3, bucket: 'today-scan',
  };
  /** Created today AND active — so it appears in bucket 1 and bucket 2. */
  const T_PREPARING = {
    PK: 'ORDER#o-2', orderId: 'o-2', status: 'PREPARING', createdAt: `${SERVICE_DATE}T03:00:00.000Z`,
    grossAmount: 9, totalAmount: 9, discountOffset: 0, bucket: 'today-scan',
  };
  const T_CANCELLED = {
    PK: 'ORDER#o-3', orderId: 'o-3', status: 'CANCELLED', createdAt: `${SERVICE_DATE}T03:10:00.000Z`,
    grossAmount: 6, totalAmount: 6, discountOffset: 0, bucket: 'today-scan',
  };
  /** A pre-order created today — bucket 1 AND bucket 3. */
  const T_PREORDER_PENDING = {
    PK: 'ORDER#o-4', orderId: 'o-4', status: 'PENDING', isPreOrder: true,
    createdAt: `${SERVICE_DATE}T01:00:00.000Z`, grossAmount: 8, totalAmount: 0, discountOffset: 8,
    bucket: 'today-scan',
  };
  /** A sale that was cancelled AFTER completion: a real refund line. */
  const T_REFUNDED = {
    PK: 'ORDER#o-10', orderId: 'o-10', status: 'CANCELLED', postCompletionCancel: true,
    createdAt: `${SERVICE_DATE}T03:30:00.000Z`, grossAmount: 7, totalAmount: 6, discountOffset: 1,
    bucket: 'today-scan',
  };
  /**
   * A refunded order still sitting at ARCHIVED. A status-only filter would count
   * it as a sale AND as a refund, so it pins the `postCompletionCancel !== true`
   * half of the completed-sales guard.
   */
  const T_ARCHIVED_REFUNDED = {
    PK: 'ORDER#o-11', orderId: 'o-11', status: 'ARCHIVED', postCompletionCancel: true,
    createdAt: `${SERVICE_DATE}T03:40:00.000Z`, grossAmount: 4, totalAmount: 4, discountOffset: 0,
    bucket: 'today-scan',
  };
  /** No orderId at all — the `orderId || PK` dedupe key fallback. Both buckets. */
  const T_LEGACY_READY = {
    PK: 'ORDER#o-9', status: 'READY', createdAt: `${SERVICE_DATE}T04:00:00.000Z`,
    grossAmount: 5, totalAmount: 5, bucket: 'today-scan',
  };

  // Bucket 2: active regardless of date.
  const A_PREPARING_OLD = {
    PK: 'ORDER#o-5', orderId: 'o-5', status: 'PREPARING', createdAt: '2026-08-30T02:00:00.000Z',
    grossAmount: 7, totalAmount: 7, discountOffset: 0, bucket: 'active-query',
  };
  const A_READY_OLD = {
    PK: 'ORDER#o-6', orderId: 'o-6', status: 'READY', createdAt: '2026-08-30T03:00:00.000Z',
    grossAmount: 25, totalAmount: 20, discountOffset: 5, bucket: 'active-query',
  };

  // Bucket 3: PENDING pre-orders regardless of date.
  const P_PREORDER_EARLIER = {
    PK: 'ORDER#o-7', orderId: 'o-7', status: 'PENDING', isPreOrder: true,
    createdAt: '2026-09-04T06:00:00.000Z', grossAmount: 8, totalAmount: 0, discountOffset: 8,
    bucket: 'pending-query',
  };
  /** An ordinary stale PENDING order — must be skipped by `isPreOrder !== true`. */
  const P_STALE_ORDINARY = {
    PK: 'ORDER#o-8', orderId: 'o-8', status: 'PENDING',
    createdAt: '2026-08-30T04:00:00.000Z', grossAmount: 4, totalAmount: 4, bucket: 'pending-query',
  };

  function stageDaily() {
    stage({
      ordersScan: [T_ARCHIVED, T_PREPARING, T_CANCELLED, T_PREORDER_PENDING, T_LEGACY_READY],
      ordersByStatus: {
        // Each duplicate carries `bucket: 'active-query'` / `'pending-query'` —
        // a field the handler never reads, so it can only come from the losing
        // copy. That is what makes "first wins" falsifiable.
        PREPARING: [{ ...T_PREPARING, bucket: 'active-query' }, A_PREPARING_OLD],
        READY: [{ ...T_LEGACY_READY, bucket: 'active-query' }, A_READY_OLD],
        PENDING: [{ ...T_PREORDER_PENDING, bucket: 'pending-query' }, P_PREORDER_EARLIER, P_STALE_ORDINARY],
      },
    });
  }

  beforeEach(() => { jest.setSystemTime(SUN_2026_09_06); });

  it('issues exactly one scan and three status queries', async () => {
    stageDaily();

    await getReport('/api/admin/reports/daily', { date: SERVICE_DATE });

    expect(cmds()).toHaveLength(4);
    const scan = cmds().find((c) => c.__cmd === 'Scan');
    expect(scan.FilterExpression).toBe('begins_with(createdAt, :today)');
    expect(scan.ExpressionAttributeValues).toEqual({ ':today': SERVICE_DATE });
    const queries = cmds().filter((c) => c.__cmd === 'Query');
    expect(queries.map((q) => q.ExpressionAttributeValues[':s'])).toEqual(['PREPARING', 'READY', 'PENDING']);
    for (const q of queries) expect(q.IndexName).toBe('status-createdAt-index');

    const byStatus = new Map(queries.map((q) => [q.ExpressionAttributeValues[':s'], q]));
    // PREPARING and PENDING carry NO date condition, deliberately: that is what
    // makes buckets 2 and 3 reach back before today for a stalled order or an
    // early ministry pre-order. Neither status is revenue-bearing, so neither can
    // move the money.
    expect(byStatus.get('PREPARING').KeyConditionExpression).toBe('#s = :s');
    expect(byStatus.get('PENDING').KeyConditionExpression).toBe('#s = :s');
    // READY *is* revenue-bearing, so it is bound to the reported date with the
    // same prefix condition as the scan above.
    expect(byStatus.get('READY').KeyConditionExpression)
      .toBe('#s = :s AND begins_with(createdAt, :today)');
    expect(byStatus.get('READY').ExpressionAttributeValues)
      .toEqual({ ':s': 'READY', ':today': SERVICE_DATE });

    expect(writes()).toHaveLength(0);
  });

  it('DEDUPES a record present in two buckets, keeping the today-scan copy', async () => {
    stageDaily();

    const body = await getReport('/api/admin/reports/daily', { date: SERVICE_DATE });

    const ids = body.orders.map((o: any) => o.orderId || o.PK);
    // o-2 (today + PREPARING query) and o-9 (today + READY query, deduped by PK
    // because it has no orderId) each appear ONCE. o-4 is in the today scan and
    // the PENDING query.
    expect(ids).toEqual(['o-1', 'o-2', 'o-3', 'o-4', 'ORDER#o-9', 'o-5', 'o-6', 'o-7']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(body.orders).toHaveLength(8);

    // First writer wins: every duplicated record is the today-scan copy.
    const byKey = new Map<string, any>(body.orders.map((o: any) => [o.orderId || o.PK, o]));
    expect(byKey.get('o-2').bucket).toBe('today-scan');
    expect(byKey.get('ORDER#o-9').bucket).toBe('today-scan');
    expect(byKey.get('o-4').bucket).toBe('today-scan');
    // …and the records that exist in only one bucket keep their own provenance,
    // which proves the assertion above is not just reading the scan array back.
    expect(byKey.get('o-5').bucket).toBe('active-query');
    expect(byKey.get('o-7').bucket).toBe('pending-query');
  });

  it('skips a stale ordinary PENDING order but keeps a PENDING PRE-ORDER', async () => {
    stageDaily();

    const body = await getReport('/api/admin/reports/daily', { date: SERVICE_DATE });

    const ids = body.orders.map((o: any) => o.orderId);
    // The `isPreOrder !== true` continue is REACHED — o-8 is in the query result.
    expect(ids).not.toContain('o-8');
    // o-7 is a pre-order from two days ago: bucket 3 exists precisely so a
    // pre-order created before today shows on today's dashboard.
    expect(ids).toContain('o-7');
  });

  it('counts revenue from completed sales only — hand-computed', async () => {
    stageDaily();

    const body = await getReport('/api/admin/reports/daily', { date: SERVICE_DATE });

    // paidCompleted = o-1 (ARCHIVED 12) + o-6 (READY 20) + o-9 (READY 5).
    // PREPARING, PENDING and CANCELLED are all present in `orders` and all
    // excluded from the money, so each of those statuses reaches the filter.
    expect(body.totalOrders).toBe(3);
    expect(body.totalRevenue).toBe(37);
    expect(body.totalOffsets).toBe(8);   // 3 (o-1) + 5 (o-6); o-9 has none
    expect(body.date).toBe(SERVICE_DATE);
    // The RM 0 pre-orders contribute nothing to revenue but do carry offsets
    // they are NOT counted for, because they are not ARCHIVED/READY.
    expect(body.totalOffsets).not.toBe(24);
  });

  it('netExpected does NOT re-subtract discountOffset from an already-NET revenue', async () => {
    stageDaily();

    const body = await getReport('/api/admin/reports/daily', { date: SERVICE_DATE });

    // Regression: this was `totalRevenue - totalOffsets`, the same double-count as
    // monthly's netCollection but on the figure the café reconciles CASH against.
    // `lib/daily-summary.ts` computes the SAME NAME as `totalRevenue -
    // totalRefunds`, so the dashboard's "Net Expected" and the end-of-day email's
    // "Net Expected" disagreed by the whole day's discount, every service.
    expect(body.netExpected).toBe(37);
    expect(body.totalRefunds).toBe(0);
    expect(body.netExpected).toBe(body.totalRevenue);
    expect(body.netExpected).not.toBe(body.totalRevenue - body.totalOffsets);
  });

  it('netExpected DOES deduct a post-completion cancel, like the end-of-day email', async () => {
    // The distinct concept the name carries: a refund of a sale that WAS
    // collected comes off the net. Both record shapes are staged — the usual
    // CANCELLED+flag, and an ARCHIVED row still carrying the flag, which a
    // status-only filter would have double-counted as a sale AND a refund.
    stage({
      ordersScan: [
        T_ARCHIVED, T_REFUNDED, T_ARCHIVED_REFUNDED,
        // A refund line with NO totalAmount at all: it must add nothing rather
        // than turn the whole figure into NaN.
        {
          PK: 'ORDER#o-12', orderId: 'o-12', status: 'CANCELLED', postCompletionCancel: true,
          createdAt: `${SERVICE_DATE}T03:50:00.000Z`,
        },
      ],
      ordersByStatus: {},
    });

    const body = await getReport('/api/admin/reports/daily', { date: SERVICE_DATE });

    // Only o-1 is a sale: RM 12. o-10 (RM 6) and o-11 (RM 4) are refunds.
    expect(body.totalOrders).toBe(1);
    expect(body.totalRevenue).toBe(12);
    expect(body.totalRefunds).toBe(10);
    expect(body.netExpected).toBe(2);
  });

  it('binds the READY query to the reported date, so a stale READY order cannot leak', async () => {
    // Regression: bucket 2 queried READY with no date condition and `paidCompleted`
    // then took every READY order, so o-6 — created 2026-08-30 and never archived —
    // booked RM 20 of last week's money into today's revenue, where the email
    // (which reads a single date) could never see it and reconcile.
    //
    // The shared `stage()` mock does not evaluate key conditions, so this test
    // HONOURS the condition the handler built: the stale row is in the table and
    // only the prefix condition keeps it out. Drop the condition from the handler
    // and the RM 20 comes straight back.
    mockDbSend.mockReset();
    mockDbSend.mockImplementation(async (cmd: any) => {
      if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-orders') return { Items: [T_ARCHIVED] };
      if (cmd.__cmd === 'Query' && cmd.TableName === 'test-orders') {
        const rows = cmd.ExpressionAttributeValues[':s'] === 'READY' ? [A_READY_OLD] : [];
        const prefix = String(cmd.KeyConditionExpression).includes('begins_with(createdAt, :today)')
          ? String(cmd.ExpressionAttributeValues[':today'])
          : '';
        return { Items: rows.filter((r) => r.createdAt.startsWith(prefix)) };
      }
      return {};
    });

    const body = await getReport('/api/admin/reports/daily', { date: SERVICE_DATE });

    expect(body.orders.map((o: any) => o.orderId)).toEqual(['o-1']);
    expect(body.totalOrders).toBe(1);
    expect(body.totalRevenue).toBe(12);
    expect(body.netExpected).toBe(12);
  });

  it('a READY order created TODAY still counts — the date bound is a bound, not a ban', async () => {
    // The other direction of the same condition: bucket 2 must still see today's
    // READY orders, which is the whole reason the query exists.
    stage({
      ordersScan: [],
      ordersByStatus: { PREPARING: [], READY: [T_LEGACY_READY], PENDING: [] },
    });

    const body = await getReport('/api/admin/reports/daily', { date: SERVICE_DATE });

    expect(body.totalOrders).toBe(1);
    expect(body.totalRevenue).toBe(5);
  });

  it('defaults the date to today (UTC) and returns zeros on a quiet day', async () => {
    stage({});

    const body = await getReport('/api/admin/reports/daily');

    expect(body).toEqual({
      date: SERVICE_DATE, totalOrders: 0, totalRevenue: 0, totalOffsets: 0,
      totalRefunds: 0, netExpected: 0, orders: [],
    });
  });

  it('coerces string money fields with Number() rather than concatenating them', async () => {
    // The daily branch is the only one using `Number(...)`; a legacy record
    // written with a string amount must add, not become '012'.
    stage({
      ordersScan: [
        { PK: 'ORDER#s-1', orderId: 's-1', status: 'ARCHIVED', createdAt: `${SERVICE_DATE}T02:00:00.000Z`, totalAmount: '12', discountOffset: '3' },
        { PK: 'ORDER#s-2', orderId: 's-2', status: 'READY', createdAt: `${SERVICE_DATE}T02:30:00.000Z`, totalAmount: 8 },
      ],
      ordersByStatus: {},
    });

    const body = await getReport('/api/admin/reports/daily', { date: SERVICE_DATE });

    expect(body.totalRevenue).toBe(20);
    expect(body.totalOffsets).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports/weekly — rolling 7 days
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/reports/weekly', () => {
  const W1 = {
    PK: 'ORDER#w1', orderId: 'w1', status: 'ARCHIVED', createdAt: '2026-08-30T02:00:00.000Z',
    grossAmount: 20, totalAmount: 15, discountOffset: 5,
    items: [{ name: 'Latte', category: 'DRINK', quantity: 2 }],
  };
  const W2 = {
    PK: 'ORDER#w2', orderId: 'w2', status: 'READY', createdAt: '2026-08-30T03:00:00.000Z',
    grossAmount: 8, totalAmount: 8, discountOffset: 0,
    items: [{ name: 'Mocha', category: 'DRINK', quantity: 1 }],
  };
  const W3 = {
    PK: 'ORDER#w3', orderId: 'w3', status: 'ARCHIVED', createdAt: '2026-09-02T01:00:00.000Z',
    grossAmount: 9, totalAmount: 7, discountOffset: 2,
    items: [{ name: 'Latte', category: 'DRINK', quantity: 1 }, { name: 'Cookie', category: 'FOOD', quantity: 1 }],
  };
  const W4_EXPIRED = {
    PK: 'ORDER#w4', orderId: 'w4', status: 'EXPIRED', createdAt: '2026-08-30T02:30:00.000Z',
    grossAmount: 50, totalAmount: 50, discountOffset: 0,
    items: [{ name: 'Latte', category: 'DRINK', quantity: 5 }],
  };
  const W5_NOT_AN_ORDER = {
    PK: 'STOCK_SNAPSHOT#2026-08-30', SK: 'META', status: 'ARCHIVED',
    createdAt: '2026-08-30T06:00:00.000Z', totalAmount: 99, discountOffset: 9,
  };
  const WEEK_SCAN = [W1, W2, W3, W4_EXPIRED, W5_NOT_AN_ORDER];

  it('groups by DATE with per-day revenue and offsets — hand-computed', async () => {
    stage({ ordersScan: WEEK_SCAN });

    const body = await getReport('/api/admin/reports/weekly');

    // 08-30 holds w1 + w2 (15 + 8 = 23 net, 5 + 0 offsets). The EXPIRED RM 50
    // and the snapshot row share that date and must not appear anywhere.
    expect(body.days).toEqual([
      { date: '2026-08-30', orderCount: 2, revenue: 23, offsets: 5 },
      { date: '2026-09-02', orderCount: 1, revenue: 7, offsets: 2 },
    ]);
  });

  it('totals the week and averages over DAYS WITH ORDERS, not days in the window', async () => {
    stage({ ordersScan: WEEK_SCAN });

    const body = await getReport('/api/admin/reports/weekly');

    expect(body.totals).toEqual({
      totalOrders: 3, totalRevenue: 30, totalOffsets: 7,
      // Math.round(3 / 2) = 2 — the divisor is `days.length` (2 service days),
      // not the 8 calendar days the window spans. Pinned deliberately: for this
      // café that is the useful figure, but it means avgPerDay === totalOrders
      // whenever only one service falls in the window.
      avgPerDay: 2,
    });
    // No net field here at all, so the weekly card escapes the double-subtraction
    // that daily and monthly both have.
    expect(body.totals).not.toHaveProperty('netExpected');
    expect(body.totals).not.toHaveProperty('netCollection');
  });

  it('ranks the top five items across the week, FOOD included', async () => {
    stage({ ordersScan: WEEK_SCAN });

    const body = await getReport('/api/admin/reports/weekly');

    expect(body.topItems).toEqual([
      { name: 'Latte', count: 3 }, { name: 'Mocha', count: 1 }, { name: 'Cookie', count: 1 },
    ]);
  });

  it('labels a whole-day range while querying from an INSTANT seven days back', async () => {
    stage({ ordersScan: [] });

    const body = await getReport('/api/admin/reports/weekly');

    expect(body.startDate).toBe('2026-08-26');
    expect(body.endDate).toBe('2026-09-02');
    const scan = cmds().find((c) => c.__cmd === 'Scan');
    expect(scan.FilterExpression).toBe('createdAt >= :start');
    // 04:00Z, not 2026-08-26T00:00:00.000Z. So the report claims to cover all of
    // 26 August while the query silently drops anything before noon MYT that
    // day — the label and the window disagree by the time of the request.
    expect(scan.ExpressionAttributeValues).toEqual({ ':start': '2026-08-26T04:00:00.000Z' });
  });

  it('returns an empty week without dividing by zero', async () => {
    stage({ ordersScan: [W4_EXPIRED] });

    const body = await getReport('/api/admin/reports/weekly');

    expect(body.days).toEqual([]);
    expect(body.totals).toEqual({ totalOrders: 0, totalRevenue: 0, totalOffsets: 0, avgPerDay: 0 });
    expect(body.topItems).toEqual([]);
    expect(writes()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/reports/restock  and  /reports/inventory
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/reports/restock', () => {
  it('includes anything at or below 1.5× its threshold, with a suggested quantity', async () => {
    stage({ ingredients: ALL_INGREDIENTS });

    const body = await getReport('/api/admin/reports/restock');

    // MILK is exactly 1.5× (6 vs 4) and the comparison is `<=`, so it is IN;
    // BEANS at 7 vs 4 is 1.75× and is OUT. suggestedRestock = threshold*2 − stock.
    expect(body.items).toEqual([
      { name: 'Fresh Milk', unit: 'L', currentStock: 6, lowStockThreshold: 4, suggestedRestock: 2, storageLocation: 'Fridge' },
      { name: 'Vanilla Syrup', unit: 'bottle', currentStock: 1, lowStockThreshold: 2, suggestedRestock: 3, storageLocation: 'Shelf' },
      { name: 'Paper Cups', unit: 'pcs', currentStock: 0, lowStockThreshold: 10, suggestedRestock: 20, storageLocation: 'Store' },
      // A DISABLED ingredient still appears — there is no isActive filter here.
      // Minor, and pinned rather than endorsed: the shopping list can send a
      // volunteer out for something the café has switched off.
      { name: 'Oat Milk', unit: 'L', currentStock: 1, lowStockThreshold: 5, suggestedRestock: 9, storageLocation: 'Fridge' },
    ]);
    // A legacy row with no numbers compares NaN and is silently dropped.
    expect(JSON.stringify(body.items)).not.toContain('Sugar');
    expect(body.items.map((i: any) => i.name)).not.toContain('Coffee Beans');
  });

  it('projects six fields only — no ingredientId, no PK, no isActive', async () => {
    stage({ ingredients: [SYRUP] });

    const body = await getReport('/api/admin/reports/restock');

    expect(Object.keys(body.items[0]).sort()).toEqual([
      'currentStock', 'lowStockThreshold', 'name', 'storageLocation', 'suggestedRestock', 'unit',
    ]);
  });

  it('scans only INGREDIENT#/META rows, so recipe rows cannot leak in', async () => {
    stage({ ingredients: [] });

    const body = await getReport('/api/admin/reports/restock');

    const scan = cmds().find((c) => c.__cmd === 'Scan');
    expect(scan.TableName).toBe('test-ingredients');
    expect(scan.FilterExpression).toBe('begins_with(PK, :prefix) AND SK = :sk');
    expect(scan.ExpressionAttributeValues).toEqual({ ':prefix': 'INGREDIENT#', ':sk': 'META' });
    expect(body.items).toEqual([]);
    expect(writes()).toHaveLength(0);
  });
});

describe('GET /api/admin/reports/inventory', () => {
  it('lists STRICTLY below-threshold rows, returning the whole record', async () => {
    stage({ ingredients: ALL_INGREDIENTS });

    const body = await getReport('/api/admin/reports/inventory');

    expect(body.lowStock.map((i: any) => i.ingredientId)).toEqual(['syrup-003', 'cups-004', 'oat-005']);
    // Unlike restock this is unprojected — the full item, `isActive` included.
    expect(body.lowStock[0]).toEqual(SYRUP);
    expect(Object.keys(body)).toEqual(['lowStock']);
  });

  it('does NOT reconcile with restock, and that is the intended asymmetry', async () => {
    // Fresh Milk at exactly its threshold ×1.5 is on the shopping list and is
    // NOT "low stock" (`currentStock < lowStockThreshold` is 6 < 4, false).
    // Pinned because the two lists are read side by side on the admin page and
    // the difference looks like a bug until you know which comparison is which.
    stage({ ingredients: [MILK] });
    expect((await getReport('/api/admin/reports/inventory')).lowStock).toEqual([]);

    stage({ ingredients: [MILK] });
    expect((await getReport('/api/admin/reports/restock')).items).toHaveLength(1);
  });

  it('returns an empty list when nothing is low', async () => {
    stage({ ingredients: [BEANS, LEGACY_SUGAR] });
    expect((await getReport('/api/admin/reports/inventory')).lowStock).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Failure shape
// ══════════════════════════════════════════════════════════════════════════════

describe('reports — a failed read becomes a minimal 500', () => {
  it.each([
    ['/api/admin/reports/daily'],
    ['/api/admin/reports/weekly'],
    ['/api/admin/reports/monthly'],
    ['/api/admin/reports/discounts'],
    ['/api/admin/reports/restock'],
    ['/api/admin/reports/inventory'],
  ])('%s returns 500 with only the message', async (path) => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));

    const res = await handleAdmin(makeEvent({ path }));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'ProvisionedThroughputExceeded' });
    expect(res.body).not.toContain('stack');
  });

  it('/reports/sessions swallows a checklist failure but NOT an orders failure', async () => {
    // The inner try/catch covers only the handover Get. If the orders scan
    // fails the card must fail loudly rather than report an empty service.
    mockDbSend.mockReset();
    mockDbSend.mockImplementation(async (cmd: any) => {
      if (cmd.__cmd === 'Scan') throw new Error('orders scan failed');
      return {};
    });

    const res = await handleAdmin(makeEvent({ path: '/api/admin/reports/sessions' }));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'orders scan failed' });
  });
});
