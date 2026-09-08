import { ScheduledEvent } from 'aws-lambda';

// ---------------------------------------------------------------------------
// Module mocks (mock-prefixed names so jest.mock factories may reference them)
// ---------------------------------------------------------------------------

const mockDbSend = jest.fn();
const mockSendLowStockAlert = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  INGREDIENTS_TABLE: 'test-ingredients',
  SETTINGS_TABLE: 'test-settings',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
}));

jest.mock('../src/lib/email', () => ({
  sendLowStockAlert: (...args: any[]) => mockSendLowStockAlert(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../src/expiry');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-06-09T05:00:00.000Z'); // 1pm MYT, mid-Sunday-service

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FIXED_NOW);
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  mockDbSend.mockReset();
  mockSendLowStockAlert.mockReset();

  // Default for any call a test does not explicitly stage.
  //
  // The staging helpers below queue a fixed number of `mockResolvedValueOnce`
  // responses, but handler() makes more calls than that: after the archive
  // logic it runs expirePreOrders(), which queries PREPARING and READY. Once
  // the queue was exhausted `send()` resolved to `undefined` and
  // `expirePreOrders` threw `Cannot read properties of undefined (reading
  // 'Items')` — failing every test in this file for reasons unrelated to what
  // each was asserting.
  //
  // `{}` is the safe empty shape: `r.Items || []` yields no rows and
  // `result.Item?.x` yields undefined, so unstaged branches simply find
  // nothing to do. Once-values are consumed first, so explicit staging still
  // takes precedence.
  mockDbSend.mockResolvedValue({});
});

const event = {} as ScheduledEvent;

function isoMinutesAgo(min: number): string {
  return new Date(FIXED_NOW.getTime() - min * 60 * 1000).toISOString();
}

function isoMinutesAhead(min: number): string {
  return new Date(FIXED_NOW.getTime() + min * 60 * 1000).toISOString();
}

/**
 * Stage the typical sequence of DB calls in handler():
 *   1. Query — PENDING expiry candidates
 *   2. (no PENDING for these tests, so no UpdateCommand)
 *   3. Get — Settings record (archiveAfterMinutes)
 *   4. Query — current READY orders
 *   5. Update — per archive eligible order
 *   6. Get — last alert record (lowStock alert dedup)
 *   7. Scan — ingredients
 *
 * Tests typically only set the first 4 and let the remaining calls —
 * expirePreOrders' two queries and the low-stock branch — fall through to the
 * `{}` default installed in beforeEach.
 */
function stagePendingThenSettings(settings: any, readyItems: any[]) {
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});   // re-arm the default that mockReset cleared
  mockDbSend
    .mockResolvedValueOnce({ Items: [] })          // 1. PENDING expiry query — none
    .mockResolvedValueOnce({ Item: settings })     // 2. Get settings (autoArchiveReadyOrders)
    .mockResolvedValueOnce({ Items: readyItems }); // 3. READY query
}

// Tail responses for the low-stock branch — runs after archive logic:
//   - Get(alertKey) → already sent
//   - (no scan, no put)
function stubLowStockNoop() {
  mockDbSend.mockResolvedValueOnce({ Item: { lastSent: '2026-06-09T01:00:00.000Z' } });
}

/**
 * Stage ONLY the 1-hour PENDING sweep (handler's first query) with real rows.
 * Everything after it — the archive Get/Query, expirePreOrders' three queries
 * and the low-stock branch — falls through to the `{}` default, which is the
 * "nothing to do" shape.
 */
function stagePendingSweep(items: any[]) {
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
  mockDbSend.mockResolvedValueOnce({ Items: items });
}

/**
 * Stage a quiet handler up to and including expirePreOrders' PENDING query,
 * which returns `items`. Call order (see `stagePendingThenSettings` above):
 *   1. Query — 1-hour PENDING sweep (none, so no money order is touched)
 *   2. Get   — Settings (archiveAfterMinutes)
 *   3. Query — READY (autoArchiveReadyOrders, none)
 *   4. Query — expirePreOrders PENDING  ← `items`
 * The caller stages whatever call 5 should be (a code-record Get, or the
 * Update's outcome); PREPARING/READY fall through to `{}`.
 *
 * Staged distinctly on purpose: the cron issues four queries against the same
 * index, so a fixture dropped into the wrong slot passes for the wrong reason.
 */
function stagePreOrderPendingSweep(items: any[]) {
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
  mockDbSend
    .mockResolvedValueOnce({ Items: [] })      // 1. 1-hour PENDING sweep
    .mockResolvedValueOnce({ Item: {} })       // 2. Get settings
    .mockResolvedValueOnce({ Items: [] })      // 3. READY archive query
    .mockResolvedValueOnce({ Items: items });  // 4. expirePreOrders PENDING
}

/**
 * Stage a completely quiet handler up to the low-stock branch. The next
 * unstaged call is checkLowStock's `Get(LOW_STOCK_ALERT#<date>)`.
 */
function stageQuietUntilLowStock() {
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
  mockDbSend
    .mockResolvedValueOnce({ Items: [] })   // 1. 1-hour PENDING sweep
    .mockResolvedValueOnce({ Item: {} })    // 2. Get settings
    .mockResolvedValueOnce({ Items: [] })   // 3. READY archive query
    .mockResolvedValueOnce({ Items: [] })   // 4. expirePreOrders PENDING
    .mockResolvedValueOnce({ Items: [] })   // 5. expirePreOrders PREPARING
    .mockResolvedValueOnce({ Items: [] });  // 6. expirePreOrders READY
}

const conditionalFail = () =>
  Object.assign(new Error('conditional fail'), { name: 'ConditionalCheckFailedException' });

function ordersUpdates() {
  return mockDbSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c.__cmd === 'Update' && c.TableName === 'test-orders');
}

function menuUpdates() {
  return mockDbSend.mock.calls
    .map((c) => c[0])
    .filter((c) => c.__cmd === 'Update' && c.TableName === 'test-menu');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoArchiveReadyOrders', () => {
  it('archives a READY order whose readyAt is older than the threshold', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        {
          PK: 'ORDER#abc',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(20),     // 20 min ago — past 15 min threshold
          updatedAt: isoMinutesAgo(20),
        },
      ]
    );
    mockDbSend.mockResolvedValueOnce({}); // archive update
    stubLowStockNoop();

    await handler(event);

    // Find the archive Update among the calls.
    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    )?.[0];
    expect(archiveCall).toBeDefined();
    expect(archiveCall.Key.PK).toBe('ORDER#abc');
    expect(archiveCall.UpdateExpression).toContain(':archived');
    expect(archiveCall.ExpressionAttributeValues[':archived']).toBe('ARCHIVED');
    expect(archiveCall.ConditionExpression).toBe('#s = :prev');
    expect(archiveCall.ExpressionAttributeValues[':prev']).toBe('READY');
    // Already had readyAt, so no backfill assignment in the SET clause.
    expect(archiveCall.UpdateExpression).not.toContain('readyAt = :readyAt');
  });

  it('does NOT archive a READY order whose readyAt is within the threshold', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        {
          PK: 'ORDER#fresh',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(8), // only 8 min ready — well within window
          updatedAt: isoMinutesAgo(8),
        },
      ]
    );
    stubLowStockNoop();

    await handler(event);

    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    );
    expect(archiveCall).toBeUndefined();
  });

  it('falls back to updatedAt and backfills readyAt for legacy orders', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        {
          PK: 'ORDER#legacy',
          SK: 'META',
          status: 'READY',
          // no readyAt — this is a record from before the feature shipped
          updatedAt: isoMinutesAgo(30),
        },
      ]
    );
    mockDbSend.mockResolvedValueOnce({}); // archive update
    stubLowStockNoop();

    await handler(event);

    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    )?.[0];
    expect(archiveCall).toBeDefined();
    // Backfill: SET clause must include readyAt = :readyAt with the legacy updatedAt value.
    expect(archiveCall.UpdateExpression).toContain('readyAt = :readyAt');
    expect(archiveCall.ExpressionAttributeValues[':readyAt']).toBe(isoMinutesAgo(30));
  });

  it('reads archiveAfterMinutes from the Settings record', async () => {
    // Threshold of 30 min — a 20-min-ready order should NOT archive.
    stagePendingThenSettings(
      { archiveAfterMinutes: 30 },
      [
        {
          PK: 'ORDER#twentymin',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(20),
          updatedAt: isoMinutesAgo(20),
        },
      ]
    );
    stubLowStockNoop();

    await handler(event);

    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    );
    expect(archiveCall).toBeUndefined();

    // Confirm the Settings Get was actually queried.
    const settingsGet = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Get' && c[0].TableName === 'test-settings' && c[0].Key.PK === 'SETTINGS'
    );
    expect(settingsGet).toBeDefined();
  });

  it('falls back to 15 min when archiveAfterMinutes is missing from settings', async () => {
    stagePendingThenSettings(
      { /* no archiveAfterMinutes */ },
      [
        {
          PK: 'ORDER#default',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(16),
          updatedAt: isoMinutesAgo(16),
        },
      ]
    );
    mockDbSend.mockResolvedValueOnce({}); // archive update
    stubLowStockNoop();

    await handler(event);

    // 16 min > default 15 min → archived
    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    );
    expect(archiveCall).toBeDefined();
  });

  it('silently no-ops when status changed mid-cron (race with cashier undo)', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        {
          PK: 'ORDER#raced',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(20),
          updatedAt: isoMinutesAgo(20),
        },
      ]
    );

    // Simulate the conditional check failing — DynamoDB throws when status
    // is no longer READY (e.g. cashier just undid back to PREPARING).
    const conditional = Object.assign(new Error('conditional fail'), {
      name: 'ConditionalCheckFailedException',
    });
    mockDbSend.mockRejectedValueOnce(conditional);
    stubLowStockNoop();

    // Must not throw.
    await expect(handler(event)).resolves.toBeUndefined();
  });

  it('RE-THROWS any other DynamoDB error from the archive update', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [{ PK: 'ORDER#boom', SK: 'META', status: 'READY', readyAt: isoMinutesAgo(20), updatedAt: isoMinutesAgo(20) }]
    );
    mockDbSend.mockRejectedValueOnce(
      Object.assign(new Error('table throttled'), { name: 'ProvisionedThroughputExceededException' })
    );

    await expect(handler(event)).rejects.toThrow('table throttled');
  });

  it('skips a READY order with neither readyAt nor updatedAt', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [{ PK: 'ORDER#undated', SK: 'META', status: 'READY' }]
    );
    stubLowStockNoop();

    await handler(event);

    expect(ordersUpdates()).toHaveLength(0);
  });

  it('processes multiple orders and only archives the eligible ones', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        { PK: 'ORDER#a', SK: 'META', status: 'READY', readyAt: isoMinutesAgo(2),  updatedAt: isoMinutesAgo(2) },
        { PK: 'ORDER#b', SK: 'META', status: 'READY', readyAt: isoMinutesAgo(20), updatedAt: isoMinutesAgo(20) },
        { PK: 'ORDER#c', SK: 'META', status: 'READY', readyAt: isoMinutesAgo(8),  updatedAt: isoMinutesAgo(8) },
        { PK: 'ORDER#d', SK: 'META', status: 'READY', readyAt: isoMinutesAgo(45), updatedAt: isoMinutesAgo(45) },
      ]
    );
    mockDbSend.mockResolvedValueOnce({}); // archive b
    mockDbSend.mockResolvedValueOnce({}); // archive d
    stubLowStockNoop();

    await handler(event);

    const archived = mockDbSend.mock.calls
      .filter((c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders')
      .map((c) => c[0].Key.PK);
    expect(archived.sort()).toEqual(['ORDER#b', 'ORDER#d']);
  });
});

// ---------------------------------------------------------------------------
// The 1-hour PENDING sweep — the FOOD counter it has to give back
// ---------------------------------------------------------------------------

describe('1-hour PENDING sweep', () => {
  it('EXPIREs the order, REMOVEs expiresAt, and releases foodReserved per FOOD item', async () => {
    stagePendingSweep([
      {
        PK: 'ORDER#food1',
        SK: 'META',
        orderId: 'food1',
        status: 'PENDING',
        customerName: 'Ah Meng',
        totalAmount: 12,
        createdAt: isoMinutesAgo(90),
        items: [
          { menuItemId: 'latte-001', category: 'DRINK', quantity: 2 },
          { menuItemId: 'curry-puff-001', category: 'FOOD', quantity: 3 },
        ],
      },
    ]);

    await handler(event);

    // The order transition itself: out of PENDING, so the numeric TTL must go.
    const [orderUpdate] = ordersUpdates();
    expect(orderUpdate).toBeDefined();
    expect(orderUpdate.Key).toEqual({ PK: 'ORDER#food1', SK: 'META' });
    expect(orderUpdate.ExpressionAttributeValues[':expired']).toBe('EXPIRED');
    expect(orderUpdate.UpdateExpression).toContain('REMOVE expiresAt');

    // Only the FOOD line gives its reservation back — a DRINK holds no counter.
    const menu = menuUpdates();
    expect(menu).toHaveLength(1);
    expect(menu[0].Key).toEqual({ PK: 'MENU#curry-puff-001', SK: 'META' });
    expect(menu[0].UpdateExpression).toBe('SET foodReserved = foodReserved - :qty');
    expect(menu[0].ExpressionAttributeValues[':qty']).toBe(3);
  });

  it('releases 1 when a FOOD item carries no quantity', async () => {
    stagePendingSweep([
      {
        PK: 'ORDER#food2',
        SK: 'META',
        orderId: 'food2',
        status: 'PENDING',
        createdAt: isoMinutesAgo(90),
        items: [{ menuItemId: 'kaya-toast-001', category: 'FOOD' }], // no quantity
      },
    ]);

    await handler(event);

    const menu = menuUpdates();
    expect(menu).toHaveLength(1);
    expect(menu[0].ExpressionAttributeValues[':qty']).toBe(1);
  });

  it('touches no menu counter for a drinks-only order, and tolerates a missing items array', async () => {
    stagePendingSweep([
      {
        PK: 'ORDER#drinks',
        SK: 'META',
        orderId: 'drinks',
        status: 'PENDING',
        createdAt: isoMinutesAgo(90),
        items: [{ menuItemId: 'latte-001', category: 'DRINK', quantity: 1 }],
      },
      {
        PK: 'ORDER#noitems',
        SK: 'META',
        orderId: 'noitems',
        status: 'PENDING',
        createdAt: isoMinutesAgo(90),
        // no items attribute at all
      },
    ]);

    await handler(event);

    expect(ordersUpdates().map((c) => c.Key.PK)).toEqual(['ORDER#drinks', 'ORDER#noitems']);
    expect(menuUpdates()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The 1-hour PENDING sweep — the stale-GSI race with a cashier approve
//
// Candidates come from `status-createdAt-index`, which is eventually
// consistent. A cashier can approve an order (PENDING → PREPARING, food
// already deducted once) just before the sweep reads a stale PENDING
// projection of it. Without the `#s = :prev` guard the sweep force-expires a
// paid, approved order AND decrements foodReserved a second time.
// ---------------------------------------------------------------------------

describe('1-hour PENDING sweep — race with a cashier approve (stale GSI read)', () => {
  const pendingWithFood = (id: string) => ({
    PK: `ORDER#${id}`,
    SK: 'META',
    orderId: id,
    status: 'PENDING',
    customerName: 'Ah Meng',
    totalAmount: 12,
    createdAt: isoMinutesAgo(90),
    items: [{ menuItemId: 'curry-puff-001', category: 'FOOD', quantity: 3 }],
  });

  it('expires a still-PENDING order, under a guard on PENDING', async () => {
    stagePendingSweep([pendingWithFood('still-pending')]);

    await handler(event);

    const [update] = ordersUpdates();
    expect(update).toBeDefined();
    expect(update.Key).toEqual({ PK: 'ORDER#still-pending', SK: 'META' });
    expect(update.ExpressionAttributeValues[':expired']).toBe('EXPIRED');
    // The guard: same shape as every other status flip in this file.
    expect(update.ConditionExpression).toBe('#s = :prev');
    expect(update.ExpressionAttributeValues[':prev']).toBe('PENDING');
    expect(update.UpdateExpression).toContain('REMOVE expiresAt');

    // Food released exactly once for the genuinely-expired order.
    expect(menuUpdates()).toHaveLength(1);
    expect(menuUpdates()[0].ExpressionAttributeValues[':qty']).toBe(3);
  });

  it('SKIPS an order that raced to PREPARING — no second food decrement, and the sweep continues', async () => {
    stagePendingSweep([pendingWithFood('raced'), pendingWithFood('genuine')]);
    // Call 2 is the first order's EXPIRED update: the cashier already approved
    // it, so DynamoDB rejects the precondition. Call 3 (the second order's
    // update) falls through to the `{}` default and succeeds.
    mockDbSend.mockRejectedValueOnce(conditionalFail());

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(handler(event)).resolves.toBeUndefined();

      // Both were attempted — one raced order must not abort the batch.
      expect(ordersUpdates().map((c) => c.Key.PK)).toEqual(['ORDER#raced', 'ORDER#genuine']);

      // The teeth: only the genuinely-expired order gave its reservation back.
      // The raced order's food was already deducted by approve; decrementing it
      // here as well is exactly the drift this guard prevents.
      const menu = menuUpdates();
      expect(menu).toHaveLength(1);
      expect(menu[0].Key).toEqual({ PK: 'MENU#curry-puff-001', SK: 'META' });

      // Skipped, not silent.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toBe('raced');
    } finally {
      warn.mockRestore();
    }
  });

  it('RE-THROWS any other DynamoDB error from the expiring update', async () => {
    stagePendingSweep([pendingWithFood('boom')]);
    mockDbSend.mockRejectedValueOnce(
      Object.assign(new Error('table throttled'), { name: 'ProvisionedThroughputExceededException' })
    );

    await expect(handler(event)).rejects.toThrow('table throttled');
  });
});

// ---------------------------------------------------------------------------
// expirePreOrders — the two conditional-update catch blocks
// ---------------------------------------------------------------------------

describe('expirePreOrders — races on the expiring update', () => {
  const duePreOrder = {
    PK: 'ORDER#po-due',
    SK: 'META',
    orderId: 'po-due',
    status: 'PENDING',
    isPreOrder: true,
    customerName: 'ZZ Ministry',
    preorderCode: 'SUN01',
    expiresAt: isoMinutesAgo(60),   // ISO string, already past → due to expire
  };

  it('swallows ConditionalCheckFailedException when the cashier approved mid-cron', async () => {
    stagePreOrderPendingSweep([duePreOrder]);
    mockDbSend.mockRejectedValueOnce(conditionalFail()); // 5. the EXPIRED update

    await expect(handler(event)).resolves.toBeUndefined();

    // Teeth: the guarded update really was attempted, on the expiring path.
    const [attempt] = ordersUpdates();
    expect(attempt).toBeDefined();
    expect(attempt.Key.PK).toBe('ORDER#po-due');
    expect(attempt.ExpressionAttributeValues[':expired']).toBe('EXPIRED');
    expect(attempt.ExpressionAttributeValues[':prev']).toBe('PENDING');
    expect(attempt.ConditionExpression).toBe('#s = :prev');
    expect(attempt.UpdateExpression).toContain('REMOVE expiresAt');
  });

  it('RE-THROWS any other DynamoDB error rather than hiding it', async () => {
    stagePreOrderPendingSweep([duePreOrder]);
    mockDbSend.mockRejectedValueOnce(
      Object.assign(new Error('throughput exceeded'), {
        name: 'ProvisionedThroughputExceededException',
      })
    );

    await expect(handler(event)).rejects.toThrow('throughput exceeded');
  });
});

describe('expirePreOrders — races on the expiresAt backfill', () => {
  // No expiresAt at all: the sweep recovers the cutoff from the code record.
  // serviceEndTime is in the FUTURE, so this order is not due — it takes the
  // backfill branch, not the expiring one.
  const strandedPreOrder = {
    PK: 'ORDER#po-stranded',
    SK: 'META',
    orderId: 'po-stranded',
    status: 'PENDING',
    isPreOrder: true,
    preorderCode: 'SUN01',
    // expiresAt lost (e.g. an undo back to PENDING stripped it)
  };

  function stageStrandedThenBackfill() {
    stagePreOrderPendingSweep([strandedPreOrder]);
    mockDbSend.mockResolvedValueOnce({          // 5. Get PREORDER_CODE#SUN01
      Item: { code: 'SUN01', serviceEndTime: isoMinutesAhead(120) },
    });
  }

  it('swallows ConditionalCheckFailedException when the status moved under it', async () => {
    stageStrandedThenBackfill();
    mockDbSend.mockRejectedValueOnce(conditionalFail()); // 6. the backfill update

    await expect(handler(event)).resolves.toBeUndefined();

    // Teeth: it was the BACKFILL that was attempted (SET expiresAt, no REMOVE,
    // never numeric), not an expiry.
    const [attempt] = ordersUpdates();
    expect(attempt).toBeDefined();
    expect(attempt.Key.PK).toBe('ORDER#po-stranded');
    expect(attempt.UpdateExpression).toBe('SET expiresAt = :ea, updatedAt = :now');
    expect(attempt.ExpressionAttributeValues[':ea']).toBe(isoMinutesAhead(120));
    expect(typeof attempt.ExpressionAttributeValues[':ea']).toBe('string');
    expect(attempt.ConditionExpression).toBe('#s = :prev');
    expect(attempt.ExpressionAttributeValues[':prev']).toBe('PENDING');
  });

  it('RE-THROWS any other DynamoDB error from the backfill', async () => {
    stageStrandedThenBackfill();
    mockDbSend.mockRejectedValueOnce(
      Object.assign(new Error('validation exploded'), { name: 'ValidationException' })
    );

    await expect(handler(event)).rejects.toThrow('validation exploded');
  });
});

describe('expirePreOrders — unresolvable code', () => {
  it('skips and logs rather than guessing a cutoff, and looks the code up ONCE per sweep', async () => {
    const stranded = (id: string) => ({
      PK: `ORDER#${id}`,
      SK: 'META',
      orderId: id,
      status: 'PENDING',
      isPreOrder: true,
      preorderCode: 'sun01',   // lower case on purpose — the cache key is uppercased
    });

    stagePreOrderPendingSweep([stranded('po-x'), stranded('po-y')]);
    // 5. Get PREORDER_CODE#SUN01 → hard-deleted link, so no serviceEndTime.
    mockDbSend.mockResolvedValueOnce({});

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(handler(event)).resolves.toBeUndefined();

      // Fail closed: nothing expired, nothing backfilled against a guess.
      expect(ordersUpdates()).toHaveLength(0);
      // Both orders reported, so neither goes silently immortal.
      expect(warn).toHaveBeenCalledTimes(2);
      // One lookup for the two orders — the second is served from codeCache.
      const codeGets = mockDbSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c.__cmd === 'Get' && c.Key?.PK === 'PREORDER_CODE#SUN01');
      expect(codeGets).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('does nothing at all when a query comes back with no Items attribute', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({}); // every query answers `{}` — no Items key

    await handler(event);

    expect(ordersUpdates()).toHaveLength(0);
    expect(menuUpdates()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkLowStock — the scan filter, the email, and the date-keyed marker
// ---------------------------------------------------------------------------

describe('checkLowStock', () => {
  // FIXED_NOW is 2026-06-09 13:00 MYT — a Tuesday, so the Sunday-before-2pm
  // gate does not apply and the alert path runs.
  const ALERT_KEY = 'LOW_STOCK_ALERT#2026-06-09';

  const INGREDIENTS = [
    { PK: 'INGREDIENT#beans', name: 'Coffee Beans', currentStock: 2, unit: 'kg', lowStockThreshold: 5 },
    { PK: 'INGREDIENT#sugar', name: 'Sugar', currentStock: 5, unit: 'kg', lowStockThreshold: 5 },   // equal → low
    { PK: 'INGREDIENT#cups', name: 'Cups', currentStock: 100, unit: 'pcs', lowStockThreshold: 20 }, // healthy
    { PK: 'INGREDIENT#milk', name: 'Milk', currentStock: 0, unit: 'L', lowStockThreshold: 0 },      // threshold not set
    { PK: 'INGREDIENT#ice', name: 'Ice', currentStock: 0, unit: 'kg' },                             // no threshold key
  ];

  function settingsPuts() {
    return mockDbSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c.__cmd === 'Put' && c.TableName === 'test-settings');
  }

  it('emails only the ingredients at or below a CONFIGURED threshold', async () => {
    stageQuietUntilLowStock();
    mockDbSend.mockResolvedValueOnce({});                  // 7. Get(alertKey) — never sent
    mockDbSend.mockResolvedValueOnce({ Items: INGREDIENTS }); // 8. Scan ingredients
    mockSendLowStockAlert.mockResolvedValue(true);

    await handler(event);

    expect(mockSendLowStockAlert).toHaveBeenCalledTimes(1);
    expect(mockSendLowStockAlert).toHaveBeenCalledWith([
      { name: 'Coffee Beans', currentStock: 2, unit: 'kg', threshold: 5 },
      { name: 'Sugar', currentStock: 5, unit: 'kg', threshold: 5 },
    ]);
    // A zero/absent threshold means "not tracked", not "out of stock" — Milk and
    // Ice are both at 0 and must NOT be reported.
    const reported = mockSendLowStockAlert.mock.calls[0][0].map((i: any) => i.name);
    expect(reported).not.toContain('Milk');
    expect(reported).not.toContain('Ice');
  });

  it('writes the date-keyed marker ONLY after a confirmed send', async () => {
    stageQuietUntilLowStock();
    mockDbSend.mockResolvedValueOnce({});
    mockDbSend.mockResolvedValueOnce({ Items: INGREDIENTS });
    mockSendLowStockAlert.mockResolvedValue(true);

    await handler(event);

    const [marker] = settingsPuts();
    expect(marker).toBeDefined();
    expect(marker.Item.PK).toBe(ALERT_KEY);
    expect(marker.Item.SK).toBe('META');
    expect(marker.Item.itemCount).toBe(2);
    expect(marker.Item.lastSent).toBe(FIXED_NOW.toISOString());
  });

  it('leaves NO marker when the send fails, so the next run retries', async () => {
    stageQuietUntilLowStock();
    mockDbSend.mockResolvedValueOnce({});
    mockDbSend.mockResolvedValueOnce({ Items: INGREDIENTS });
    mockSendLowStockAlert.mockResolvedValue(false);

    await handler(event);

    expect(mockSendLowStockAlert).toHaveBeenCalledTimes(1);
    expect(settingsPuts()).toHaveLength(0);
  });

  it('sends nothing when every ingredient is healthy', async () => {
    stageQuietUntilLowStock();
    mockDbSend.mockResolvedValueOnce({});
    mockDbSend.mockResolvedValueOnce({
      Items: [{ PK: 'INGREDIENT#cups', name: 'Cups', currentStock: 100, unit: 'pcs', lowStockThreshold: 20 }],
    });

    await handler(event);

    expect(mockSendLowStockAlert).not.toHaveBeenCalled();
    expect(settingsPuts()).toHaveLength(0);
  });

  it('does not scan or re-send once the marker exists for today', async () => {
    stageQuietUntilLowStock();
    mockDbSend.mockResolvedValueOnce({ Item: { PK: ALERT_KEY, lastSent: '2026-06-09T02:00:00.000Z' } });

    await handler(event);

    const scans = mockDbSend.mock.calls.map((c) => c[0]).filter((c) => c.__cmd === 'Scan');
    expect(scans).toHaveLength(0);
    expect(mockSendLowStockAlert).not.toHaveBeenCalled();
    expect(settingsPuts()).toHaveLength(0);

    // And it looked for the marker under the MALAYSIAN date, not the UTC one.
    const alertGet = mockDbSend.mock.calls
      .map((c) => c[0])
      .find((c) => c.__cmd === 'Get' && String(c.Key?.PK).startsWith('LOW_STOCK_ALERT#'));
    expect(alertGet.Key).toEqual({ PK: ALERT_KEY, SK: 'META' });
  });
});
