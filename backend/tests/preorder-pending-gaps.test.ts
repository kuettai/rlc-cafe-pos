/**
 * Coverage gaps found auditing T4 (pre-orders live in PENDING, v1.71).
 *
 * Each `describe` below corresponds to a T4 behaviour that survived a mutation
 * of its own guard with the whole offline suite still green — i.e. it shipped
 * with no test at all. The mutation that each block is written to kill is named
 * in its comment, so the next person can re-run the experiment.
 *
 * Style and fixtures deliberately mirror `preorder-pending.test.ts`; this file is
 * separate only so the audit's additions are distinguishable from the
 * implementer's own suite.
 */

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

jest.mock('../src/routes/customers', () => ({
  linkOrderToCustomer: jest.fn().mockResolvedValue(undefined),
  handleCustomers: jest.fn(),
}));

jest.mock('../src/lib/email', () => ({
  sendEndOfDaySummary: jest.fn().mockResolvedValue(true),
  sendLowStockAlert: jest.fn().mockResolvedValue(true),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleOrders } = require('../src/routes/orders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePos } = require('../src/routes/pos');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleAdmin } = require('../src/routes/admin');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: expiryHandler } = require('../src/expiry');

// ─── Fixtures (same shapes as preorder-pending.test.ts) ──────────────

const LATTE = {
  PK: 'MENU#latte', SK: 'META', menuItemId: 'latte', name: 'Latte',
  category: 'DRINK', basePrice: 8, isActive: true, isEnabledToday: true,
};

const FUTURE_END = '2099-12-25T07:00:00.000Z';

function codeRecord(overrides: Record<string, any> = {}) {
  const now = Date.now();
  return {
    PK: 'PREORDER_CODE#ABC123', SK: 'META', code: 'ABC123', name: 'Music team',
    opensAt: new Date(now - 3600_000).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(),
    serviceDate: '2099-12-25', serviceEndTime: FUTURE_END,
    isActive: true, eligibleItems: [],
    ...overrides,
  };
}

function preOrder(overrides: Record<string, any> = {}) {
  return {
    PK: 'ORDER#p1', SK: 'META', orderId: 'p1', customerName: 'Grace',
    status: 'PENDING', isPreOrder: true, preorderCode: 'ABC123',
    customerClass: 'PREORDER', discountType: 'MINISTRY_PREORDER',
    items: [{
      menuItemId: 'latte', name: 'Latte', variant: null, quantity: 2,
      unitPrice: 8, grossUnitPrice: 8, category: 'DRINK',
    }],
    totalAmount: 0, grossAmount: 16, discountOffset: 16,
    expiresAt: FUTURE_END,
    ...overrides,
  };
}

function cmds() { return mockDbSend.mock.calls.map(c => c[0]); }
function orderUpdates() { return cmds().filter(c => c.__cmd === 'Update' && c.TableName === 'test-orders'); }
function expiryUpdates() {
  return orderUpdates().filter(u => u.ExpressionAttributeValues?.[':expired'] === 'EXPIRED');
}

beforeEach(() => { mockDbSend.mockReset(); });

// ─── GAP 1 ───────────────────────────────────────────────────────────

/**
 * MUTATION KILLED: delete `if (order.isPreOrder === true) continue;` from the
 * 1-hour PENDING sweep in `expiry.ts` (handler, ~line 28).
 *
 * With that guard gone the whole T4 feature dies silently: a Wednesday
 * pre-order is EXPIRED by the next cron tick an hour after it is placed, and
 * `REMOVE expiresAt` takes its service-end time with it. Nothing in the suite
 * noticed, because every existing fixture stages `{ Items: [] }` for this
 * query — including `stageExpiry()` in `preorder-pending.test.ts`, whose
 * "leaves an ordinary PENDING order to the 1-hour sweep" test actually stages
 * its row into `expirePreOrders`' query, not this one.
 *
 * So this is the first fixture in the repo that puts a row in front of the
 * 1-hour sweep at all. The ordinary order alongside it is the control: it must
 * still be expired, which proves the loop ran rather than being skipped
 * wholesale.
 */
describe('the 1-hour PENDING sweep skips pre-orders (gap: previously untested)', () => {
  /** Stage rows for the FIRST query in handler() — the 1-hour PENDING sweep. */
  function stageOneHourSweep(items: any[]) {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
    mockDbSend
      .mockResolvedValueOnce({ Items: items })                    // 1h sweep candidates
      .mockResolvedValueOnce({ Item: { archiveAfterMinutes: 15 } }) // settings
      .mockResolvedValueOnce({ Items: [] });                      // READY (auto-archive)
  }

  const longAgo = '2026-01-01T00:00:00.000Z';

  it('does not expire a PENDING pre-order, however old, while expiring the ordinary one', async () => {
    stageOneHourSweep([
      { PK: 'ORDER#ordinary', SK: 'META', orderId: 'ordinary', status: 'PENDING', createdAt: longAgo, items: [] },
      preOrder({ PK: 'ORDER#pre', orderId: 'pre', createdAt: longAgo }),
    ]);

    await expiryHandler({} as any);

    // Control: the ordinary stale order IS expired, so the loop definitely ran.
    const expired = expiryUpdates().map(u => u.Key.PK);
    expect(expired).toEqual(['ORDER#ordinary']);
    expect(expired).not.toContain('ORDER#pre');
  });

  it('does not strip the pre-order ISO expiresAt via the 1-hour sweep', async () => {
    // The sweep's UpdateExpression carries `REMOVE expiresAt`. Applied to a
    // pre-order it destroys the only input `expirePreOrders` has, on top of
    // wrongly expiring the order.
    stageOneHourSweep([preOrder({ PK: 'ORDER#pre', orderId: 'pre', createdAt: longAgo })]);

    await expiryHandler({} as any);

    expect(orderUpdates().filter(u => u.Key.PK === 'ORDER#pre')).toHaveLength(0);
  });

  it('releases no food counters for a skipped pre-order', async () => {
    // Belt and braces on the `continue`: the sweep's food-release loop must not
    // run either. (A pre-order cannot hold FOOD, but the guard is what
    // guarantees that, so assert on the effect rather than the premise.)
    stageOneHourSweep([
      preOrder({
        PK: 'ORDER#pre', orderId: 'pre', createdAt: longAgo,
        items: [{ menuItemId: 'cookie', name: 'Cookie', quantity: 2, category: 'FOOD', unitPrice: 3, grossUnitPrice: 3 }],
      }),
    ]);

    await expiryHandler({} as any);

    expect(cmds().filter(c => c.__cmd === 'Update' && c.TableName === 'test-menu')).toHaveLength(0);
  });
});

// ─── GAP 2 ───────────────────────────────────────────────────────────

/**
 * MUTATION KILLED: delete the `if (!out.released) return res(409, …)` branch in
 * `approveOrder`'s pre-order arm (`pos.ts`).
 *
 * `releasePreOrderToPreparing` reports a failed `#s = :pending` guard as
 * `released: false` rather than throwing, so swallowing that return value is a
 * silent 200: the POS is told "PREPARING, RM0" for an order that was never
 * written. The bulk path's conflict handling is tested; the single path's is
 * not, and the project's own rule is "a new order transition needs the happy
 * path AND the 409 on a stale status".
 */
describe('approveOrder on a pre-order returns 409 on a stale status (gap: previously untested)', () => {
  const conflict = () => Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });

  function approveEvent(id: string, body: Record<string, any> = { approvedBy: 'Sarah' }) {
    return {
      httpMethod: 'PUT', path: `/api/pos/orders/${id}/approve`,
      body: JSON.stringify(body),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any;
  }

  it('409s when the customer cancelled or edited between read and write', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: preOrder() })     // Get(order)
      .mockImplementation(async (c: any) => {
        if (c.__cmd === 'Update' && c.TableName === 'test-orders') throw conflict();
        return {};
      });

    const res = await handlePos(approveEvent('p1'), 'Sarah');

    expect(res.statusCode).toBe(409);
    // Same minimal message the ordinary approve path returns.
    expect(JSON.parse(res.body).error).toBe('Order was just cancelled or modified by the customer');
  });

  it('runs none of the release side effects when the guard fails', async () => {
    // A 409 that had already deducted ingredients / pushed / audited would be
    // worse than the wrong status code: the cashier retries and it double-counts.
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockDbSend.mockReset();
      mockDbSend
        .mockResolvedValueOnce({ Item: preOrder() })
        .mockImplementation(async (c: any) => {
          if (c.__cmd === 'Update' && c.TableName === 'test-orders') throw conflict();
          return {};
        });

      await handlePos(approveEvent('p1'), 'Sarah');

      const recipeQueries = cmds().filter(
        c => c.__cmd === 'Query' && String(c.ExpressionAttributeValues?.[':pk'] || '').startsWith('RECIPE#'),
      );
      expect(recipeQueries).toHaveLength(0);
      expect(logSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes('[ORDER] APPROVE'))).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ─── GAP 3 ───────────────────────────────────────────────────────────

/**
 * MUTATION KILLED: make `getPreorderCode` return null for a link whose ordering
 * window has closed (i.e. re-introduce `validatePreorderCode`'s time gate inside
 * it, or have `modifyOrder` call validate and use `v.code` on failure).
 *
 * The existing test "uses a plain lookup, so a closed ordering window does not
 * block the edit" asserts a 200 — but a null record ALSO yields 200, because
 * `preorderItemRejection(null, …)` only enforces drinks-only. So that test
 * cannot see the difference, and the silent-bypass shape of the regression ships
 * green. On a Sunday the ordering window is normally already closed, which is
 * precisely when this matters.
 *
 * The distinguishing assertion has to be that a RESTRICTION is still enforced
 * through a closed-window link.
 */
describe('a closed-window link still supplies its restrictions on edit (gap: no teeth before)', () => {
  const CLOSED_WINDOW = {
    opensAt: '1999-01-01T00:00:00.000Z',
    expiresAt: '2000-01-01T00:00:00.000Z',
  };

  /** Get(order) → settings → getPreorderCode → menu item. */
  function stageEdit(order: any, code: any, menu: any) {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order })
      .mockResolvedValueOnce({ Item: { cafeStatus: 'OPEN', celebrationMode: false } })
      .mockResolvedValueOnce(code === null ? {} : { Item: code })
      .mockResolvedValueOnce({ Item: menu })
      .mockResolvedValue({});
  }

  function editEvent(items: any[]) {
    return {
      httpMethod: 'PUT', path: '/api/orders/p1',
      body: JSON.stringify({ action: 'update', items }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any;
  }

  it('still refuses an excludedOptions variant when the link window has closed', async () => {
    stageEdit(preOrder(), codeRecord({ ...CLOSED_WINDOW, excludedOptions: ['Milk:Oat Milk'] }), LATTE);

    const res = await handleOrders(editEvent([{
      menuItemId: 'latte', quantity: 1,
      selectedVariants: [{ group: 'Milk', option: 'Oat Milk', price: 1 }],
    }]));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Oat Milk is not available/i);
    expect(orderUpdates()).toHaveLength(0);
  });

  it('still refuses a drink outside eligibleItems when the link window has closed', async () => {
    stageEdit(preOrder(), codeRecord({ ...CLOSED_WINDOW, eligibleItems: ['mocha'] }), LATTE);

    const res = await handleOrders(editEvent([{ menuItemId: 'latte', quantity: 1 }]));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not available on this pre-order link/i);
    expect(orderUpdates()).toHaveLength(0);
  });

  it('reads the link record itself, not a validated view of it', async () => {
    // The lookup is unconditional for a pre-order with a code: it is a plain
    // Get on the PREORDER_CODE# key, with no second read and no time gate.
    stageEdit(preOrder(), codeRecord(CLOSED_WINDOW), LATTE);
    await handleOrders(editEvent([{ menuItemId: 'latte', quantity: 1 }]));

    const lookups = cmds().filter(c => c.__cmd === 'Get' && String(c.Key?.PK || '').startsWith('PREORDER_CODE#'));
    expect(lookups).toHaveLength(1);
    expect(lookups[0].Key).toEqual({ PK: 'PREORDER_CODE#ABC123', SK: 'META' });
  });
});

// ─── GAP 4 ───────────────────────────────────────────────────────────

/**
 * MUTATION KILLED: delete the five pre-order context fields T4 added to
 * `getOrder`'s response (`isPreOrder`, `preorderCode`, `discountType`,
 * `discountOffset`, `grossAmount`).
 *
 * `track.html` needs them to label the edit window and to render "free" instead
 * of a total of RM0 against items priced in full. Nothing offline read the
 * getOrder response at all before this.
 */
describe('getOrder returns the pre-order context track.html needs (gap: previously untested)', () => {
  function getEvent(id: string) {
    return {
      httpMethod: 'GET', path: `/api/orders/${id}`,
      body: null, headers: {}, queryStringParameters: null, pathParameters: null,
    } as any;
  }

  it('exposes isPreOrder, the code, and the net/gross/offset triple', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValueOnce({ Item: preOrder({ notes: '[PRE-ORDER: ABC123] Collect: After 1st Service' }) })
      .mockResolvedValue({});

    const res = await handleOrders(getEvent('p1'));
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);

    expect(b.isPreOrder).toBe(true);
    expect(b.preorderCode).toBe('ABC123');
    expect(b.discountType).toBe('MINISTRY_PREORDER');
    // Storage convention: totalAmount NET, grossAmount undiscounted,
    // discountOffset the reduction. The page shows "free" off these.
    expect(b.totalAmount).toBe(0);
    expect(b.grossAmount).toBe(16);
    expect(b.discountOffset).toBe(16);
    // PENDING is what makes the Edit/Cancel buttons appear.
    expect(b.status).toBe('PENDING');
    expect(b.notes).toBe('[PRE-ORDER: ABC123] Collect: After 1st Service');
  });

  it('reports isPreOrder false — never undefined — for an ordinary order', async () => {
    // `o.isPreOrder === true` rather than a pass-through, so the page can branch
    // on a boolean instead of on absence.
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValueOnce({
      Item: {
        PK: 'ORDER#n1', SK: 'META', orderId: 'n1', customerName: 'Ah Beng', status: 'PENDING',
        items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, unitPrice: 8, grossUnitPrice: 8, category: 'DRINK' }],
        totalAmount: 8, grossAmount: 8, discountOffset: 0, discountType: 'NONE',
      },
    }).mockResolvedValue({});

    const res = await handleOrders(getEvent('n1'));
    const b = JSON.parse(res.body);

    expect(b.isPreOrder).toBe(false);
    expect(b.preorderCode).toBeNull();
    expect(b.totalAmount).toBe(8);
  });
});

// ─── GAP 5 ───────────────────────────────────────────────────────────

/**
 * MUTATION KILLED (two of them): delete the admin daily-report's third bucket
 * entirely, or drop its `if (o.isPreOrder !== true) continue;` filter
 * (`admin.ts`, `/admin/reports/daily`).
 *
 * The bucket exists because a pre-order created before today is now PENDING, so
 * it falls outside bucket 1 (`createdAt` begins_with today) and bucket 2
 * (PREPARING/READY). The filter exists so stale ordinary PENDING orders from
 * previous days do not start appearing on the dashboard. Both directions were
 * covered only by the live integration suite. This must agree with
 * `getShiftSummary` in pos.ts — the two dashboards show the same day.
 */
describe('admin daily report includes out-of-range PENDING pre-orders only (gap: previously untested)', () => {
  /**
   * Scan(today) → Query(PREPARING) → Query(READY) → Query(PENDING, unbounded).
   */
  function stageDaily(todayItems: any[], preparing: any[], ready: any[], pending: any[]) {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Items: todayItems })
      .mockResolvedValueOnce({ Items: preparing })
      .mockResolvedValueOnce({ Items: ready })
      .mockResolvedValueOnce({ Items: pending })
      .mockResolvedValue({});
  }

  function dailyEvent() {
    return {
      httpMethod: 'GET', path: '/api/admin/reports/daily',
      body: null, headers: {}, queryStringParameters: { date: '2099-12-25' },
      pathParameters: null,
    } as any;
  }

  it('surfaces a pre-order created on an earlier day and omits a stale ordinary PENDING', async () => {
    stageDaily([], [], [], [
      preOrder({ PK: 'ORDER#pre', orderId: 'pre', createdAt: '2026-08-12T01:00:00.000Z' }),
      {
        PK: 'ORDER#stale', SK: 'META', orderId: 'stale', status: 'PENDING',
        createdAt: '2026-08-12T01:00:00.000Z', items: [], totalAmount: 9,
      },
    ]);

    const res = await handleAdmin(dailyEvent());
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);

    expect(b.orders.map((o: any) => o.orderId)).toEqual(['pre']);
    // PENDING is pre-approval, so it is in `orders` but not in the revenue
    // bucket (ARCHIVED + READY only).
    expect(b.totalOrders).toBe(0);
    expect(b.totalRevenue).toBe(0);
  });

  it('does not double-count a pre-order that bucket 2 already returned', async () => {
    // A released pre-order is PREPARING and comes back from bucket 2; the same
    // record must not be added again by bucket 3. Dedupe is by orderId.
    const released = preOrder({ PK: 'ORDER#pre', orderId: 'pre', status: 'PREPARING' });
    stageDaily([], [released], [], [released]);

    const res = await handleAdmin(dailyEvent());
    const b = JSON.parse(res.body);
    expect(b.orders.filter((o: any) => o.orderId === 'pre')).toHaveLength(1);
  });

  it('agrees with getShiftSummary on the same rows', async () => {
    // The two dashboards are read side by side during service; a pre-order
    // visible in one and missing from the other is a support call.
    const pre = preOrder({ PK: 'ORDER#pre', orderId: 'pre', createdAt: '2026-08-12T01:00:00.000Z' });
    const stale = {
      PK: 'ORDER#stale', SK: 'META', orderId: 'stale', status: 'PENDING',
      createdAt: '2026-08-12T01:00:00.000Z', items: [], totalAmount: 9,
    };

    stageDaily([], [], [], [pre, stale]);
    const adminBody = JSON.parse((await handleAdmin(dailyEvent())).body);

    // getShiftSummary: PENDING-today, ARCHIVED-today, PREPARING, READY, then
    // the unbounded PENDING bucket.
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [pre, stale] })
      .mockResolvedValue({});
    const shiftBody = JSON.parse((await handlePos({
      httpMethod: 'GET', path: '/api/pos/shift-summary',
      body: null, headers: {}, queryStringParameters: null, pathParameters: null,
    } as any, 'Sarah', 'ADMIN')).body);

    expect(adminBody.orders.map((o: any) => o.orderId)).toEqual(['pre']);
    expect(shiftBody.pendingOrders).toBe(1);
    expect(shiftBody.totalOrders).toBe(1);
  });
});
