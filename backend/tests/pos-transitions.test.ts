/**
 * `backend/src/routes/pos.ts` — the ORDER-STATUS TRANSITION sub-actions only.
 *
 *   PUT  /api/pos/orders/{id}/approve          (money path + pre-order delegation)
 *   PUT  /api/pos/orders/{id}/ready            (PREPARING → READY, food consumed)
 *   PUT  /api/pos/orders/{id}/undo-ready       (READY → PREPARING, food restored)
 *   PUT  /api/pos/orders/{id}/undo             (PREPARING → PENDING)
 *   PUT  /api/pos/orders/{id}/archive          (READY → ARCHIVED)
 *   PUT  /api/pos/orders/{id}/reject           (PENDING → CANCELLED)
 *   POST /api/pos/orders/{id}/cancel-completed (READY|ARCHIVED → CANCELLED)
 *   PUT  /api/pos/preorders/release-all        (bulk release — accountability only)
 *   GET  /api/pos/orders                       (queue + ?all=true history)
 *   POST /api/pos/orders                       (createWalkUp)
 *
 * What is pinned here, and why (all three have already produced production bugs
 * in this repo — see the `invariants` skill):
 *
 *  1. **Every status flip is race-guarded and answers 409 on a stale status.**
 *     Asserted on the `ConditionExpression` the handler actually sent, and by
 *     driving a `ConditionalCheckFailedException` out of the mocked client.
 *     `undo` and `reject` used to fail this — `undo` let the exception escape
 *     (a 502 with no CORS headers, since `index.ts` has no top-level catch) and
 *     `reject` sent no guard at all while releasing food BEFORE the flip. Both
 *     are fixed; the tests that pinned them as bugs now pin the fix.
 *  2. **A numeric `expiresAt` is a live DynamoDB TTL and exists on PENDING
 *     orders only.** Every money-path transition out of PENDING must carry
 *     `REMOVE expiresAt`; nothing may ever WRITE one outside PENDING.
 *  3. **The food counters balance.** `foodReserved` / `foodQuantityToday` are
 *     decremented exactly once, at `ready`, and `undo-ready` is their exact
 *     inverse. `archive` and `cancel-completed` must not touch them again.
 *
 * Fully mocked (`lib/db`, `lib/audit`, `lib/push`) — no network, no credentials,
 * nothing written to production, so no `ZZTEST_` marker applies. `lib/pricing` is
 * deliberately NOT mocked: it is pure, and it is the single source of truth for
 * every number asserted below.
 */

import { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbSend = jest.fn();
const mockLogOrder = jest.fn();
const mockSendOrderPush = jest.fn().mockResolvedValue(undefined);

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

// Audit is mocked (rather than sniffed off console) so each transition's payload
// can be asserted field by field — `staffPriceGranted` in particular.
jest.mock('../src/lib/audit', () => ({
  logOrder: (...args: any[]) => mockLogOrder(...args),
  summarizeItems: (items: any) =>
    (Array.isArray(items) ? items : []).map((i: any) => `${i.quantity}x ${i.name}`).join(', '),
}));

// Push is a no-op spy: which transitions notify the customer is itself part of
// the contract, so it is asserted both ways below.
jest.mock('../src/lib/push', () => ({
  sendOrderPush: (...args: any[]) => mockSendOrderPush(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePos } = require('../src/routes/pos');

// ─── Helpers ─────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'PUT',
    path: '/api/pos/orders/order-1/approve',
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

function conditionalCheckFailed() {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

/** Every command object handed to the mocked docClient, in call order. */
function cmds() {
  return mockDbSend.mock.calls.map((c) => c[0]);
}
function orderUpdates() {
  return cmds().filter((c) => c.__cmd === 'Update' && c.TableName === 'test-orders');
}
function menuUpdates() {
  return cmds().filter((c) => c.__cmd === 'Update' && c.TableName === 'test-menu');
}
function orderPuts() {
  return cmds().filter((c) => c.__cmd === 'Put' && c.TableName === 'test-orders');
}
/** Audit calls for one action, as `[action, orderId, payload]`. */
function audit(action: string) {
  return mockLogOrder.mock.calls.filter((c) => c[0] === action);
}

/** First call resolves to `first`, every later call resolves to `{}`. */
function stageFirst(first: any) {
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValueOnce(first).mockResolvedValue({});
}

// ─── Fixtures ────────────────────────────────────────────────────────

const DRINK = {
  menuItemId: 'latte', name: 'Latte', variant: 'Hot',
  quantity: 1, unitPrice: 8, grossUnitPrice: 8, category: 'DRINK',
};
const FOOD = {
  menuItemId: 'cookie', name: 'Cookie', variant: null,
  quantity: 2, unitPrice: 3, grossUnitPrice: 3, category: 'FOOD',
};
/** Legacy shape: line count in `qty`, no `quantity`. */
const FOOD_LEGACY_QTY = {
  menuItemId: 'muffin', name: 'Muffin', variant: null,
  qty: 3, unitPrice: 4, grossUnitPrice: 4, category: 'FOOD',
};

function order(overrides: Record<string, any> = {}) {
  return {
    PK: 'ORDER#order-1', SK: 'META', orderId: 'order-1',
    customerName: 'Mei Yii', status: 'PENDING',
    items: [DRINK], totalAmount: 8, grossAmount: 8,
    expiresAt: 1893456000,           // numeric — a LIVE DynamoDB TTL
    createdAt: '2026-09-01T01:00:00.000Z',
    ...overrides,
  };
}

const LATTE_MENU = {
  PK: 'MENU#latte', SK: 'META', menuItemId: 'latte', name: 'Latte',
  category: 'DRINK', basePrice: 8, isActive: true, isEnabledToday: true,
};
const COOKIE_MENU = {
  PK: 'MENU#cookie', SK: 'META', menuItemId: 'cookie', name: 'Cookie',
  category: 'FOOD', basePrice: 3, isActive: true, isEnabledToday: true,
  foodQuantityToday: 10, foodReserved: 0,
};
const OPEN_SETTINGS = {
  cafeStatus: 'OPEN', celebrationMode: false, celebrationPrice: 5, orderExpiryMinutes: 30,
};

// Per-transition request descriptors, reused by the cross-cutting suites at the
// bottom so a new transition cannot be added without them noticing.
const APPROVE = { method: 'PUT', path: '/api/pos/orders/order-1/approve' };
const READY = { method: 'PUT', path: '/api/pos/orders/order-1/ready' };
const UNDO_READY = { method: 'PUT', path: '/api/pos/orders/order-1/undo-ready' };
const UNDO = { method: 'PUT', path: '/api/pos/orders/order-1/undo' };
const ARCHIVE = { method: 'PUT', path: '/api/pos/orders/order-1/archive' };
const REJECT = { method: 'PUT', path: '/api/pos/orders/order-1/reject' };
const CANCEL_DONE = { method: 'POST', path: '/api/pos/orders/order-1/cancel-completed' };

function call(
  route: { method: string; path: string },
  body: Record<string, any> | null = null,
  actor = 'Sarah',
) {
  return handlePos(
    makeEvent({ httpMethod: route.method, path: route.path, body: body ? JSON.stringify(body) : null }),
    actor,
  );
}

beforeEach(() => {
  mockDbSend.mockReset();
  mockLogOrder.mockReset();
  mockSendOrderPush.mockClear();
});

// ═════════════════════════════════════════════════════════════════════
// approve — PENDING → PREPARING (money path)
// ═════════════════════════════════════════════════════════════════════

describe('approve — PENDING → PREPARING (money path)', () => {
  it('happy path: flips PREPARING, reprices, and REMOVEs the numeric TTL', async () => {
    stageFirst({ Item: order() });

    const res = await call(APPROVE, { approvedBy: 'Sarah' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      orderId: 'order-1', status: 'PREPARING', totalAmount: 8, discountOffset: 0,
    });

    const u = orderUpdates()[0];
    expect(u.Key).toEqual({ PK: 'ORDER#order-1', SK: 'META' });
    expect(u.ConditionExpression).toBe('#s = :pending');
    expect(u.ExpressionAttributeValues[':pending']).toBe('PENDING');
    expect(u.ExpressionAttributeValues[':s']).toBe('PREPARING');
    // `items` and `status` are DynamoDB reserved keywords — unaliased, the whole
    // request fails with ValidationException and no order can be approved.
    expect(u.UpdateExpression).toContain('#items = :items');
    expect(u.ExpressionAttributeNames).toEqual({ '#s': 'status', '#items': 'items' });
    // Invariant: a numeric expiresAt is a live TTL. It must go on the way out of
    // PENDING, or DynamoDB deletes a real in-service order with no error or log.
    expect(u.UpdateExpression).toContain('REMOVE expiresAt');
    expect(u.ExpressionAttributeValues).not.toHaveProperty(':ea');
  });

  it('writes the NET/GROSS/OFFSET triple consistently (totalAmount is net)', async () => {
    stageFirst({ Item: order({ items: [{ ...DRINK, unitPrice: 5, grossUnitPrice: 8 }] }) });

    await call(APPROVE, { approvedBy: 'Sarah' });

    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':t']).toBe(5);                       // NET, as collected
    expect(v[':ga']).toBe(8);                      // undiscounted
    expect(v[':do']).toBe(3);                      // grossAmount - totalAmount
    expect(v[':do']).toBe(v[':ga'] - v[':t']);
    expect(v[':dt']).toBe('CELEBRATION');
  });

  it('a cashier class does not STACK on the stored celebration price', async () => {
    // RM5 celebration already stored; STAFF is also RM5. Cheapest wins, once.
    stageFirst({ Item: order({ items: [{ ...DRINK, unitPrice: 5, grossUnitPrice: 8 }] }) });

    await call(APPROVE, { approvedBy: 'Sarah', discountType: 'STAFF' });

    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':t']).toBe(5);
    expect(v[':do']).toBe(3);
    expect(v[':cc']).toBe('STAFF');
  });

  it('deducts ingredients, audits APPROVE and pushes — in that order, after the flip', async () => {
    stageFirst({ Item: order() });

    await call(APPROVE, { approvedBy: 'Sarah' });

    const recipeQueries = cmds().filter(
      (c) => c.__cmd === 'Query' && c.TableName === 'test-ingredients',
    );
    expect(recipeQueries.length).toBeGreaterThan(0);
    // The conditional flip commits BEFORE any side effect.
    const flipIdx = cmds().findIndex((c) => c.__cmd === 'Update' && c.TableName === 'test-orders');
    const recipeIdx = cmds().findIndex((c) => c.__cmd === 'Query' && c.TableName === 'test-ingredients');
    expect(flipIdx).toBeLessThan(recipeIdx);

    expect(audit('APPROVE')).toHaveLength(1);
    expect(audit('APPROVE')[0][1]).toBe('order-1');
    expect(audit('APPROVE')[0][2]).toMatchObject({
      customer: 'Mei Yii', by: 'Sarah', discount: 'NONE', offset: 0, total: 8, status: 'PREPARING',
    });
    expect(mockSendOrderPush).toHaveBeenCalledWith(
      'order-1', '☕ Order Confirmed', 'Your order is being prepared!',
    );
  });

  it('409 on a stale status, with no deduction, no audit and no push', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: order() })          // Get
      .mockRejectedValueOnce(conditionalCheckFailed());  // conditional Update

    const res = await call(APPROVE, { approvedBy: 'Sarah' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/cancelled or modified/i);

    expect(cmds().filter((c) => c.__cmd === 'Query' && c.TableName === 'test-ingredients')).toHaveLength(0);
    expect(audit('APPROVE')).toHaveLength(0);
    expect(mockSendOrderPush).not.toHaveBeenCalled();
  });

  it('404 when the order is gone, writing nothing', async () => {
    stageFirst({});
    const res = await call(APPROVE, { approvedBy: 'Sarah' });
    expect(res.statusCode).toBe(404);
    expect(orderUpdates()).toHaveLength(0);
    expect(mockSendOrderPush).not.toHaveBeenCalled();
  });

  it('rethrows a non-conditional failure rather than reporting 409', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: order() })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' }));

    await expect(call(APPROVE, { approvedBy: 'Sarah' })).rejects.toThrow('boom');
  });

  it('moves NO food counter — reservation was taken at create, consumption is at ready', async () => {
    stageFirst({ Item: order({ items: [FOOD] }) });
    await call(APPROVE, { approvedBy: 'Sarah' });
    expect(menuUpdates()).toHaveLength(0);
  });

  it('stamps approvedBy from the JWT actor, not from the body', async () => {
    // FIXED (was pinned as a FINDING). The money path wrote `body.approvedBy`
    // verbatim while the bulk pre-order route preferred the JWT identity. Both
    // now resolve `actor || body.approvedBy || ''`: `approvedBy` is the
    // accountability record for a repricing decision, so a client cannot
    // attribute it to somebody else.
    stageFirst({ Item: order() });

    await call(APPROVE, { approvedBy: 'Someone Else' }, 'Sarah');

    expect(orderUpdates()[0].ExpressionAttributeValues[':a']).toBe('Sarah');
    expect(audit('APPROVE')[0][2].by).toBe('Sarah');
  });

  it('falls back to body.approvedBy only when there is no actor', async () => {
    stageFirst({ Item: order() });
    await call(APPROVE, { approvedBy: 'Kiosk' }, '');
    expect(orderUpdates()[0].ExpressionAttributeValues[':a']).toBe('Kiosk');
    expect(audit('APPROVE')[0][2].by).toBe('Kiosk');
  });

  it('never sends approvedBy undefined — an empty string, not a marshalling failure', async () => {
    // FIXED (was pinned as a FINDING). With neither an actor nor a body field
    // `:a` used to be `undefined`; `lib/db.ts` builds the document client with no
    // `marshallOptions`, so `removeUndefinedValues` is false and the real client
    // THROWS ("Pass options.removeUndefinedValues=true …") — a 502 on approve.
    stageFirst({ Item: order() });

    await call(APPROVE, {}, '');

    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':a']).toBe('');
    expect(v[':a']).not.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// approve — the customer-REQUESTED staff price
// ═════════════════════════════════════════════════════════════════════

describe('approve — a requested STAFF price is reverted unless the cashier confirms', () => {
  function staffOrder() {
    return order({
      staffCode: 'STAFF',
      items: [{ ...DRINK, unitPrice: 5, grossUnitPrice: 8, baseUnitPrice: 8 }],
    });
  }

  it('DECLINED (no class): reverts to baseUnitPrice and reports no discount', async () => {
    stageFirst({ Item: staffOrder() });

    await call(APPROVE, { approvedBy: 'Sarah' });

    const v = orderUpdates()[0].ExpressionAttributeValues;
    // Without revertRequestedClassPricing the stored RM5 would survive as the
    // cheaper incumbent and come back out labelled CELEBRATION — a discount
    // with nobody accountable in approvedBy.
    expect(v[':t']).toBe(8);
    expect(v[':do']).toBe(0);
    expect(v[':dt']).toBe('NONE');
    expect(v[':items'][0].unitPrice).toBe(8);
  });

  it('DECLINED: the audit line records the request and that it was NOT granted', async () => {
    stageFirst({ Item: staffOrder() });
    await call(APPROVE, { approvedBy: 'Sarah' });
    expect(audit('APPROVE')[0][2]).toMatchObject({ staffCode: 'STAFF', staffPriceGranted: false });
  });

  it('CONFIRMED: keeps RM5, reports STAFF and records staffPriceGranted true', async () => {
    stageFirst({ Item: staffOrder() });

    await call(APPROVE, { approvedBy: 'Sarah', discountType: 'STAFF' });

    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':t']).toBe(5);
    expect(v[':dt']).toBe('STAFF');
    expect(v[':do']).toBe(3);
    expect(audit('APPROVE')[0][2]).toMatchObject({ staffCode: 'STAFF', staffPriceGranted: true });
  });

  it('a non-staff order carries neither staff audit field', async () => {
    stageFirst({ Item: order() });
    await call(APPROVE, { approvedBy: 'Sarah' });
    const payload = audit('APPROVE')[0][2];
    expect(payload.staffCode).toBeUndefined();
    expect(payload.staffPriceGranted).toBeUndefined();
  });

  it('cannot be zeroed by a crafted discountType PREORDER in the body', async () => {
    stageFirst({ Item: order() });
    await call(APPROVE, { approvedBy: 'Sarah', discountType: 'PREORDER' });
    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':t']).toBe(8);
    expect(v[':cc']).toBeNull();
    expect(v[':dt']).toBe('NONE');
  });
});

// ═════════════════════════════════════════════════════════════════════
// approve — pre-order delegation
// ═════════════════════════════════════════════════════════════════════

describe('approve — a pre-order delegates to releasePreOrderToPreparing', () => {
  const ISO_SERVICE_END = '2026-09-06T07:00:00.000Z';

  function preOrder(overrides: Record<string, any> = {}) {
    return order({
      isPreOrder: true, preorderCode: 'MINISTRY1', expiresAt: ISO_SERVICE_END,
      totalAmount: 0, grossAmount: 8,
      items: [{ ...DRINK, unitPrice: 8, grossUnitPrice: 8 }],
      ...overrides,
    });
  }

  it('forces the PREORDER class, so the order stays free and MINISTRY_PREORDER', async () => {
    stageFirst({ Item: preOrder() });

    const res = await call(APPROVE, { approvedBy: 'Sarah' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      orderId: 'order-1', status: 'PREPARING', totalAmount: 0, discountOffset: 8,
    });

    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':t']).toBe(0);
    expect(v[':ga']).toBe(8);
    expect(v[':dt']).toBe('MINISTRY_PREORDER');
    expect(v[':cc']).toBe('PREORDER');
  });

  it('PRESERVES the ISO expiresAt — nothing else would ever expire the order', async () => {
    stageFirst({ Item: preOrder() });
    await call(APPROVE, { approvedBy: 'Sarah' });
    expect(orderUpdates()[0].UpdateExpression).not.toContain('expiresAt');
  });

  it('but still REMOVEs a NUMERIC expiresAt — that one is a live armed TTL', async () => {
    stageFirst({ Item: preOrder({ expiresAt: 1893456000 }) });
    await call(APPROVE, { approvedBy: 'Sarah' });
    expect(orderUpdates()[0].UpdateExpression).toContain('REMOVE expiresAt');
  });

  it('audits the preorderCode and pushes, exactly like the money path', async () => {
    stageFirst({ Item: preOrder() });
    await call(APPROVE, { approvedBy: 'Sarah' });
    expect(audit('APPROVE')[0][2]).toMatchObject({
      preorderCode: 'MINISTRY1', discount: 'MINISTRY_PREORDER', total: 0, status: 'PREPARING',
    });
    expect(mockSendOrderPush).toHaveBeenCalledTimes(1);
  });

  it('409 on a stale status, with no ingredient deduction, audit or push', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: preOrder() })
      .mockRejectedValueOnce(conditionalCheckFailed());

    const res = await call(APPROVE, { approvedBy: 'Sarah' });
    expect(res.statusCode).toBe(409);
    expect(cmds().filter((c) => c.__cmd === 'Query' && c.TableName === 'test-ingredients')).toHaveLength(0);
    expect(audit('APPROVE')).toHaveLength(0);
    expect(mockSendOrderPush).not.toHaveBeenCalled();
  });

  it('records the JWT actor over body.approvedBy — the same precedence as the bulk route', async () => {
    // FIXED (was pinned as a FINDING). `approveOrder` used to call
    // `releasePreOrderToPreparing(order, body.approvedBy)`, discarding the
    // `actor` it was handed, while `releaseAllPreOrders` used
    // `actor || body.approvedBy`. So the two paths diverged on the one field the
    // shared helper exists to keep identical: releasing four pre-orders
    // individually stamped whatever name the client typed, releasing all four
    // stamped the signed-in cashier. `approvedBy` is the accountability record
    // for a money decision, so the authenticated identity wins.
    stageFirst({ Item: preOrder() });

    await call(APPROVE, { approvedBy: 'Someone Else' }, 'Sarah');

    expect(orderUpdates()[0].ExpressionAttributeValues[':a']).toBe('Sarah');
  });

  it('falls back to body.approvedBy on the pre-order path only when there is no actor', async () => {
    stageFirst({ Item: preOrder() });
    await call(APPROVE, { approvedBy: 'Kiosk' }, '');
    expect(orderUpdates()[0].ExpressionAttributeValues[':a']).toBe('Kiosk');
  });
});

// ═════════════════════════════════════════════════════════════════════
// ready — PREPARING → READY, food consumed
// ═════════════════════════════════════════════════════════════════════

describe('ready — PREPARING → READY', () => {
  it('happy path: guarded flip, readyAt stamped, ALL_OLD requested', async () => {
    stageFirst({ Attributes: order({ status: 'PREPARING', expiresAt: undefined }) });

    const res = await call(READY);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.orderId).toBe('order-1');
    expect(body.status).toBe('READY');
    expect(body.readyAt).toBeTruthy();

    const u = orderUpdates()[0];
    expect(u.UpdateExpression).toBe('SET #s = :s, updatedAt = :u, readyAt = :u');
    expect(u.ConditionExpression).toBe('#s = :prev');
    expect(u.ExpressionAttributeValues[':prev']).toBe('PREPARING');
    expect(u.ExpressionAttributeValues[':s']).toBe('READY');
    expect(u.ExpressionAttributeValues[':u']).toBe(body.readyAt);
    // ALL_OLD is what supplies the items array the food consumption needs.
    expect(u.ReturnValues).toBe('ALL_OLD');
    // Never write an expiresAt outside PENDING.
    expect(u.UpdateExpression).not.toContain('expiresAt');
  });

  it('consumes BOTH food counters, once, by the line quantity', async () => {
    stageFirst({ Attributes: order({ status: 'PREPARING', items: [FOOD] }) });

    await call(READY);

    expect(menuUpdates()).toHaveLength(1);
    const m = menuUpdates()[0];
    expect(m.Key).toEqual({ PK: 'MENU#cookie', SK: 'META' });
    expect(m.UpdateExpression).toBe(
      'SET foodReserved = foodReserved - :q, foodQuantityToday = foodQuantityToday - :q',
    );
    expect(m.ExpressionAttributeValues[':q']).toBe(2);
  });

  it('a DRINK moves no counter', async () => {
    stageFirst({ Attributes: order({ status: 'PREPARING', items: [DRINK] }) });
    await call(READY);
    expect(menuUpdates()).toHaveLength(0);
  });

  it('honours the legacy `qty` field on a food line', async () => {
    stageFirst({ Attributes: order({ status: 'PREPARING', items: [FOOD_LEGACY_QTY] }) });
    await call(READY);
    expect(menuUpdates()[0].ExpressionAttributeValues[':q']).toBe(3);
  });

  it('skips a malformed food line rather than writing NaN into a counter', async () => {
    stageFirst({
      Attributes: order({
        status: 'PREPARING',
        items: [
          null,
          { category: 'FOOD', quantity: 1 },                              // no menuItemId
          { category: 'FOOD', menuItemId: 'y', quantity: -2 },            // negative
          { category: 'FOOD', menuItemId: 'z', quantity: 'abc' },         // NaN
          { category: 'FOOD', menuItemId: 'w', quantity: Infinity },      // not finite
          FOOD,
        ],
      }),
    });

    await call(READY);
    expect(menuUpdates()).toHaveLength(1);
    expect(menuUpdates()[0].Key.PK).toBe('MENU#cookie');
  });

  it('SKIPS a zero-quantity food line instead of burning one unit of stock', async () => {
    // FIXED (was pinned as current behaviour). `Number(item.quantity || item.qty
    // || 1)` treated an explicit 0 as falsy and fell through to the legacy "no
    // quantity means one" default, so the `qty <= 0` guard on the next line never
    // saw it and a 0-quantity line decremented one unit of real stock. Now `??`,
    // so an explicit 0 reaches the guard.
    stageFirst({ Attributes: order({ status: 'PREPARING', items: [{ ...FOOD, quantity: 0 }] }) });

    await call(READY);
    expect(menuUpdates()).toHaveLength(0);
  });

  it('still defaults a line with NEITHER quantity nor qty to 1', async () => {
    // The legacy default is deliberately kept — `??` only stops an EXPLICIT 0
    // from being rewritten.
    stageFirst({
      Attributes: order({
        status: 'PREPARING',
        items: [{ menuItemId: 'cookie', name: 'Cookie', category: 'FOOD' }],
      }),
    });

    await call(READY);
    expect(menuUpdates()).toHaveLength(1);
    expect(menuUpdates()[0].ExpressionAttributeValues[':q']).toBe(1);
  });

  it('falls through a null quantity to the legacy qty field', async () => {
    stageFirst({
      Attributes: order({
        status: 'PREPARING',
        items: [{ menuItemId: 'cookie', name: 'Cookie', category: 'FOOD', quantity: null, qty: 4 }],
      }),
    });

    await call(READY);
    expect(menuUpdates()[0].ExpressionAttributeValues[':q']).toBe(4);
  });

  it('skips an explicit qty of 0 on a legacy line too', async () => {
    stageFirst({
      Attributes: order({
        status: 'PREPARING',
        items: [{ menuItemId: 'muffin', name: 'Muffin', category: 'FOOD', qty: 0 }],
      }),
    });

    await call(READY);
    expect(menuUpdates()).toHaveLength(0);
  });

  it('one failing counter write does not fail the transition or stop the next line', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Attributes: order({ status: 'PREPARING', items: [FOOD, FOOD_LEGACY_QTY] }) })
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'ValidationException' }))
      .mockResolvedValue({});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await call(READY);
      expect(res.statusCode).toBe(200);
      expect(menuUpdates()).toHaveLength(2);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('audits READY with the actor and pushes the customer', async () => {
    stageFirst({ Attributes: order({ status: 'PREPARING' }) });
    await call(READY, null, 'Sarah');
    expect(audit('READY')).toHaveLength(1);
    expect(audit('READY')[0][2]).toEqual({ by: 'Sarah' });
    expect(mockSendOrderPush).toHaveBeenCalledWith(
      'order-1', '✅ Order Ready!', 'Your order is ready for collection!',
    );
  });

  it('409 on a stale status — and a duplicate click cannot double-decrement', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValueOnce(conditionalCheckFailed());

    const res = await call(READY);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/not in PREPARING state/i);
    expect(menuUpdates()).toHaveLength(0);
    expect(audit('READY')).toHaveLength(0);
    expect(mockSendOrderPush).not.toHaveBeenCalled();
  });

  it('rethrows a non-conditional failure', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    await expect(call(READY)).rejects.toThrow('throttled');
  });
});

// ═════════════════════════════════════════════════════════════════════
// undo-ready — READY → PREPARING, food restored
// ═════════════════════════════════════════════════════════════════════

describe('undo-ready — READY → PREPARING', () => {
  it('happy path: guarded flip back with ALL_OLD, no expiresAt touched', async () => {
    stageFirst({ Attributes: order({ status: 'READY' }) });

    const res = await call(UNDO_READY);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ orderId: 'order-1', status: 'PREPARING' });

    const u = orderUpdates()[0];
    expect(u.UpdateExpression).toBe('SET #s = :s, updatedAt = :u');
    expect(u.ConditionExpression).toBe('#s = :prev');
    expect(u.ExpressionAttributeValues[':prev']).toBe('READY');
    expect(u.ExpressionAttributeValues[':s']).toBe('PREPARING');
    expect(u.ReturnValues).toBe('ALL_OLD');
    expect(u.UpdateExpression).not.toContain('expiresAt');
  });

  it('restores BOTH food counters by the same quantity ready consumed', async () => {
    stageFirst({ Attributes: order({ status: 'READY', items: [FOOD] }) });

    await call(UNDO_READY);

    expect(menuUpdates()).toHaveLength(1);
    const m = menuUpdates()[0];
    expect(m.Key).toEqual({ PK: 'MENU#cookie', SK: 'META' });
    expect(m.UpdateExpression).toBe(
      'SET foodReserved = foodReserved + :q, foodQuantityToday = foodQuantityToday + :q',
    );
    expect(m.ExpressionAttributeValues[':q']).toBe(2);
  });

  it('ready then undo-ready nets to zero — the two expressions are exact inverses', async () => {
    stageFirst({ Attributes: order({ status: 'PREPARING', items: [FOOD, FOOD_LEGACY_QTY] }) });
    await call(READY);
    const consumed = menuUpdates().map((m) => [m.Key.PK, m.UpdateExpression, m.ExpressionAttributeValues[':q']]);

    stageFirst({ Attributes: order({ status: 'READY', items: [FOOD, FOOD_LEGACY_QTY] }) });
    await call(UNDO_READY);
    const restored = menuUpdates().map((m) => [m.Key.PK, m.UpdateExpression, m.ExpressionAttributeValues[':q']]);

    expect(restored).toHaveLength(consumed.length);
    for (let i = 0; i < consumed.length; i++) {
      expect(restored[i][0]).toBe(consumed[i][0]);                      // same item
      expect(restored[i][2]).toBe(consumed[i][2]);                      // same quantity
      expect(String(restored[i][1]).replace(/\+/g, '-')).toBe(consumed[i][1]); // + mirrors -
    }
  });

  it('skips a zero-quantity line exactly as ready does — the inverse holds at 0 too', async () => {
    // Both helpers coerce with `??`. If only one had been fixed, ready would skip
    // the line and undo-ready would ADD 1, permanently inflating both counters.
    const zeroLine = { ...FOOD, quantity: 0 };

    stageFirst({ Attributes: order({ status: 'PREPARING', items: [zeroLine] }) });
    await call(READY);
    expect(menuUpdates()).toHaveLength(0);

    stageFirst({ Attributes: order({ status: 'READY', items: [zeroLine] }) });
    await call(UNDO_READY);
    expect(menuUpdates()).toHaveLength(0);
  });

  it('audits UNDO_PREPARING and sends NO push (the customer was never told)', async () => {
    stageFirst({ Attributes: order({ status: 'READY' }) });
    await call(UNDO_READY, null, 'Sarah');
    expect(audit('UNDO_PREPARING')).toHaveLength(1);
    expect(audit('UNDO_PREPARING')[0][2]).toEqual({ by: 'Sarah' });
    expect(mockSendOrderPush).not.toHaveBeenCalled();
  });

  it('409 on a stale status, restoring no counter (an archived order stays archived)', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValueOnce(conditionalCheckFailed());

    const res = await call(UNDO_READY);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/no longer in READY state/i);
    expect(menuUpdates()).toHaveLength(0);
    expect(audit('UNDO_PREPARING')).toHaveLength(0);
  });

  it('rethrows a non-conditional failure', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'InternalServerError' }));
    await expect(call(UNDO_READY)).rejects.toThrow('nope');
  });
});

// ═════════════════════════════════════════════════════════════════════
// undo — PREPARING → PENDING
// ═════════════════════════════════════════════════════════════════════

describe('undo — PREPARING → PENDING', () => {
  it('happy path: guarded flip, and writes only status + updatedAt', async () => {
    stageFirst({});

    const res = await call(UNDO);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ orderId: 'order-1', status: 'PENDING' });

    const u = orderUpdates()[0];
    expect(u.UpdateExpression).toBe('SET #s = :s, updatedAt = :u');
    expect(u.ConditionExpression).toBe('#s = :prev');
    expect(u.ExpressionAttributeValues[':prev']).toBe('PREPARING');
    expect(u.ExpressionAttributeValues[':s']).toBe('PENDING');
  });

  it('does NOT re-arm a numeric expiresAt, and moves no food counter', async () => {
    stageFirst({});
    await call(UNDO);
    // Money fields and the TTL are both left alone: approve stripped the TTL and
    // undo does not invent a new one. A numeric value written here would be a
    // live TTL again — correct for PENDING, but this handler has no expiry input,
    // so writing a guessed one is what must not happen.
    expect(orderUpdates()[0].UpdateExpression).not.toContain('expiresAt');
    expect(orderUpdates()[0].ExpressionAttributeValues).not.toHaveProperty(':ea');
    expect(menuUpdates()).toHaveLength(0);
  });

  it('audits UNDO_PENDING and sends no push', async () => {
    stageFirst({});
    await call(UNDO, null, 'Sarah');
    expect(audit('UNDO_PENDING')).toHaveLength(1);
    expect(audit('UNDO_PENDING')[0][2]).toEqual({ by: 'Sarah' });
    expect(mockSendOrderPush).not.toHaveBeenCalled();
  });

  it('409 on a stale status, with no audit line', async () => {
    // FIXED (was pinned as a FINDING). `undoToPending` was the only transition in
    // this file whose conditional Update had no try/catch, so a
    // ConditionalCheckFailedException propagated out of `handlePos` — and
    // `backend/src/index.ts` has NO top-level try/catch, so API Gateway answered
    // 502 with NO CORS headers, which the POS reads as a network failure rather
    // than "that order already moved on". Reachable in one tap: Undo on an order
    // the customer just cancelled, or a double-tapped Undo.
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValueOnce(conditionalCheckFailed());

    const res = await call(UNDO);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/no longer in PREPARING state/i);
    expect(audit('UNDO_PENDING')).toHaveLength(0);
  });

  it('rethrows a non-conditional failure rather than reporting 409', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'InternalServerError' }));
    await expect(call(UNDO)).rejects.toThrow('boom');
    expect(audit('UNDO_PENDING')).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// archive — READY → ARCHIVED
// ═════════════════════════════════════════════════════════════════════

describe('archive — READY → ARCHIVED', () => {
  it('happy path: guarded flip and REMOVE expiresAt', async () => {
    stageFirst({ Attributes: order({ status: 'READY', totalAmount: 8, discountType: 'NONE' }) });

    const res = await call(ARCHIVE);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ orderId: 'order-1', status: 'ARCHIVED' });

    const u = orderUpdates()[0];
    expect(u.UpdateExpression).toBe('SET #s = :s, updatedAt = :u REMOVE expiresAt');
    expect(u.ConditionExpression).toBe('#s = :prev');
    expect(u.ExpressionAttributeValues[':prev']).toBe('READY');
    expect(u.ExpressionAttributeValues[':s']).toBe('ARCHIVED');
    expect(u.ReturnValues).toBe('ALL_OLD');
  });

  it('audits from the ALL_OLD attributes, not from the request', async () => {
    stageFirst({
      Attributes: order({ status: 'READY', customerName: 'Mei Yii', totalAmount: 5, discountType: 'CELEBRATION' }),
    });
    await call(ARCHIVE, null, 'Sarah');
    expect(audit('ARCHIVE')[0][2]).toEqual({
      customer: 'Mei Yii', by: 'Sarah', total: 5, discount: 'CELEBRATION',
    });
  });

  it('moves NO food counter — ready already consumed it (no double-count)', async () => {
    stageFirst({ Attributes: order({ status: 'READY', items: [FOOD] }) });
    await call(ARCHIVE);
    expect(menuUpdates()).toHaveLength(0);
  });

  it('sends no push', async () => {
    stageFirst({ Attributes: order({ status: 'READY' }) });
    await call(ARCHIVE);
    expect(mockSendOrderPush).not.toHaveBeenCalled();
  });

  it('409 on a stale status, with no audit line', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValueOnce(conditionalCheckFailed());

    const res = await call(ARCHIVE);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/not in READY state/i);
    expect(audit('ARCHIVE')).toHaveLength(0);
  });

  it('tolerates an ALL_OLD response with no Attributes', async () => {
    stageFirst({});
    const res = await call(ARCHIVE);
    expect(res.statusCode).toBe(200);
    expect(audit('ARCHIVE')[0][2]).toMatchObject({ customer: undefined, by: 'Sarah' });
  });

  it('rethrows a non-conditional failure', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValueOnce(Object.assign(new Error('bad'), { name: 'ValidationException' }));
    await expect(call(ARCHIVE)).rejects.toThrow('bad');
  });
});

// ═════════════════════════════════════════════════════════════════════
// reject — PENDING → CANCELLED
// ═════════════════════════════════════════════════════════════════════

describe('reject — PENDING → CANCELLED', () => {
  it('happy path: CANCELLED with the reason, and REMOVE expiresAt', async () => {
    stageFirst({ Item: order({ items: [DRINK] }) });

    const res = await call(REJECT, { reason: 'No payment received' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ orderId: 'order-1', status: 'CANCELLED' });

    const u = orderUpdates()[0];
    expect(u.UpdateExpression).toBe(
      'SET #s = :s, rejectionReason = :r, updatedAt = :u REMOVE expiresAt',
    );
    expect(u.ExpressionAttributeValues[':s']).toBe('CANCELLED');
    expect(u.ExpressionAttributeValues[':r']).toBe('No payment received');
  });

  it('releases the food reservation, FOOD lines only', async () => {
    stageFirst({ Item: order({ items: [DRINK, FOOD] }) });

    await call(REJECT, { reason: 'wrong order' });

    expect(menuUpdates()).toHaveLength(1);
    const m = menuUpdates()[0];
    expect(m.Key).toEqual({ PK: 'MENU#cookie', SK: 'META' });
    // Only foodReserved — foodQuantityToday was never decremented for a PENDING
    // order, so the stock returns to the shelf untouched.
    expect(m.UpdateExpression).toBe('SET foodReserved = foodReserved - :q');
    expect(m.ExpressionAttributeValues[':q']).toBe(2);
  });

  it('audits REJECT with the reason and the actor, and sends no push', async () => {
    stageFirst({ Item: order() });
    await call(REJECT, { reason: 'duplicate' }, 'Sarah');
    expect(audit('REJECT')[0][2]).toEqual({ customer: 'Mei Yii', by: 'Sarah', reason: 'duplicate' });
    expect(mockSendOrderPush).not.toHaveBeenCalled();
  });

  it('404 when the order is gone, writing nothing', async () => {
    stageFirst({});
    const res = await call(REJECT, { reason: 'x' });
    expect(res.statusCode).toBe(404);
    expect(orderUpdates()).toHaveLength(0);
    expect(menuUpdates()).toHaveLength(0);
  });

  it.each(['PREPARING', 'READY', 'ARCHIVED', 'CANCELLED', 'EXPIRED'])(
    '400 for a %s order, releasing no food',
    async (status) => {
      stageFirst({ Item: order({ status, items: [FOOD] }) });
      const res = await call(REJECT, { reason: 'x' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/Only PENDING orders can be rejected/);
      expect(menuUpdates()).toHaveLength(0);
      expect(orderUpdates()).toHaveLength(0);
    },
  );

  it('guards the flip on #s = :prev, so a double-tap cannot double-release food', async () => {
    // FIXED (was pinned as a FINDING). Reject used to read the status then write
    // unconditionally — a read-then-write race in which a customer cancelling (or
    // the 1-hour cron expiring the order) between the Get and the Update was
    // overwritten, and a double-tapped reject ran `releaseFood` TWICE, drifting
    // `foodReserved` DOWN by the line quantity each time. That is exactly the
    // drift `scripts/reset-food-reserved.mjs` exists to mop up.
    stageFirst({ Item: order({ items: [FOOD] }) });
    await call(REJECT, { reason: 'x' });

    const u = orderUpdates()[0];
    expect(u.ConditionExpression).toBe('#s = :prev');
    expect(u.ExpressionAttributeValues[':prev']).toBe('PENDING');
  });

  it('409 on a stale status, releasing NO food and writing no audit line', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ items: [FOOD] }) })   // Get — still PENDING
      .mockRejectedValueOnce(conditionalCheckFailed());            // the guarded flip loses the race

    const res = await call(REJECT, { reason: 'x' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/no longer in PENDING state/i);
    // The counter is untouched, which is the whole point of the guard.
    expect(menuUpdates()).toHaveLength(0);
    expect(audit('REJECT')).toHaveLength(0);
  });

  it('releases food only AFTER the flip commits', async () => {
    // FIXED (was pinned as a FINDING). `releaseFood` ran BEFORE the status flip,
    // the inverse of the customer cancel path in `routes/orders.ts`, whose test
    // pins "the order Update must commit BEFORE the food adjustments — otherwise
    // a failed conditional update would leave food reservations inconsistent".
    stageFirst({ Item: order({ items: [FOOD] }) });
    await call(REJECT, { reason: 'x' });

    const all = cmds();
    const flipIdx = all.findIndex((c) => c.__cmd === 'Update' && c.TableName === 'test-orders');
    const foodIdx = all.findIndex((c) => c.__cmd === 'Update' && c.TableName === 'test-menu');
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(foodIdx).toBeGreaterThan(flipIdx);
  });

  it('a failing flip leaves the food reservation untouched', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ items: [FOOD] }) })                                // Get
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ValidationException' })); // the flip fails

    await expect(call(REJECT, { reason: 'x' })).rejects.toThrow('nope');
    expect(menuUpdates()).toHaveLength(0);
  });

  it('defaults a missing `reason` to an empty string, never undefined', async () => {
    // FIXED (was pinned as a FINDING). `':r': body.reason` had no default, and
    // `lib/db.ts` builds the document client with no `marshallOptions`, so
    // `removeUndefinedValues` is false and the real client THROWS on an undefined
    // member ("Pass options.removeUndefinedValues=true …"). With no try/catch here
    // and none in `index.ts` that was a 502 — and the food reservation had
    // ALREADY been released by then, leaving the order PENDING with its counter
    // decremented.
    stageFirst({ Item: order() });

    const res = await call(REJECT, {});
    expect(res.statusCode).toBe(200);
    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':r']).toBe('');
    expect(v[':r']).not.toBeUndefined();
    expect(audit('REJECT')[0][2].reason).toBe('');
  });

  it.each([
    ['a non-string reason', 42, ''],
    ['null', null, ''],
    ['whitespace only', '   ', ''],
    ['a padded reason', '  no payment  ', 'no payment'],
  ])('normalises %s', async (_label, reason, expected) => {
    stageFirst({ Item: order() });
    const res = await call(REJECT, { reason });
    expect(res.statusCode).toBe(200);
    expect(orderUpdates()[0].ExpressionAttributeValues[':r']).toBe(expected);
  });
});

// ═════════════════════════════════════════════════════════════════════
// cancel-completed — READY | ARCHIVED → CANCELLED
// ═════════════════════════════════════════════════════════════════════

describe('cancel-completed — READY | ARCHIVED → CANCELLED', () => {
  it.each(['READY', 'ARCHIVED'])('happy path from %s', async (status) => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status, totalAmount: 8 }) })                   // Get (pre)
      .mockResolvedValueOnce({})                                                            // Update
      .mockResolvedValueOnce({ Item: order({ status: 'CANCELLED', cancelReason: 'spilled' }) }); // Get (fresh)

    const res = await call(CANCEL_DONE, { reason: 'spilled' });
    expect(res.statusCode).toBe(200);
    // The response is the FRESH record, not the pre-image.
    expect(JSON.parse(res.body).status).toBe('CANCELLED');
    expect(JSON.parse(res.body).cancelReason).toBe('spilled');

    const u = orderUpdates()[0];
    expect(u.ConditionExpression).toBe('#s = :ready OR #s = :archived');
    expect(u.ExpressionAttributeValues[':ready']).toBe('READY');
    expect(u.ExpressionAttributeValues[':archived']).toBe('ARCHIVED');
    expect(u.ExpressionAttributeValues[':cancelled']).toBe('CANCELLED');
    expect(u.ExpressionAttributeValues[':reason']).toBe('spilled');
    expect(u.ExpressionAttributeValues[':actor']).toBe('Sarah');
    expect(u.ExpressionAttributeValues[':true']).toBe(true);
    expect(u.UpdateExpression).toContain('postCompletionCancel = :true');
    expect(u.UpdateExpression).toContain('REMOVE expiresAt');
  });

  it('stamps cancelledAt, updatedAt and cancelledBy from the JWT actor', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY' }) })
      .mockResolvedValue({ Item: order({ status: 'CANCELLED' }) });

    await call(CANCEL_DONE, { reason: 'r', actor: 'Forged Name' }, 'Sarah');

    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':actor']).toBe('Sarah');           // the body cannot forge it
    expect(v[':now']).toBeTruthy();
    expect(orderUpdates()[0].UpdateExpression).toContain('cancelledAt = :now');
    expect(orderUpdates()[0].UpdateExpression).toContain('updatedAt = :now');
  });

  it('trims the reason and stores the trimmed value', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY' }) })
      .mockResolvedValue({ Item: order({ status: 'CANCELLED' }) });

    await call(CANCEL_DONE, { reason: '   customer left   ' });
    expect(orderUpdates()[0].ExpressionAttributeValues[':reason']).toBe('customer left');
  });

  it.each([
    ['missing', {}],
    ['empty', { reason: '' }],
    ['whitespace only', { reason: '    ' }],
    ['not a string', { reason: 42 }],
  ])('400 when the reason is %s — before any read or write', async (_label, body) => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});

    const res = await call(CANCEL_DONE, body as any);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('reason is required');
    // Nothing at all was sent to DynamoDB — not even the Get.
    expect(cmds()).toHaveLength(0);
  });

  it('accepts a reason at the 200-character boundary and rejects 201', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY' }) })
      .mockResolvedValue({ Item: order({ status: 'CANCELLED' }) });
    const ok = await call(CANCEL_DONE, { reason: 'a'.repeat(200) });
    expect(ok.statusCode).toBe(200);

    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
    const tooLong = await call(CANCEL_DONE, { reason: 'a'.repeat(201) });
    expect(tooLong.statusCode).toBe(400);
    expect(JSON.parse(tooLong.body).error).toMatch(/200 characters/);
    expect(cmds()).toHaveLength(0);
  });

  it('404 when the order is gone', async () => {
    stageFirst({});
    const res = await call(CANCEL_DONE, { reason: 'x' });
    expect(res.statusCode).toBe(404);
    expect(orderUpdates()).toHaveLength(0);
  });

  it.each(['PENDING', 'PREPARING', 'CANCELLED', 'EXPIRED'])(
    '400 for a %s order, naming the current status and writing nothing',
    async (status) => {
      stageFirst({ Item: order({ status }) });
      const res = await call(CANCEL_DONE, { reason: 'x' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain(`current: ${status}`);
      expect(orderUpdates()).toHaveLength(0);
    },
  );

  it('moves NO food counter — ready already consumed it', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY', items: [FOOD] }) })
      .mockResolvedValue({ Item: order({ status: 'CANCELLED', items: [FOOD] }) });

    await call(CANCEL_DONE, { reason: 'x' });
    expect(menuUpdates()).toHaveLength(0);
  });

  it('audits CANCEL_COMPLETED with the previous status, and sends no push', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'ARCHIVED', totalAmount: 8 }) })
      .mockResolvedValue({ Item: order({ status: 'CANCELLED' }) });

    await call(CANCEL_DONE, { reason: 'refunded' }, 'Sarah');

    expect(audit('CANCEL_COMPLETED')[0][2]).toEqual({
      customer: 'Mei Yii', by: 'Sarah', prevStatus: 'ARCHIVED', total: 8, reason: 'refunded',
    });
    expect(mockSendOrderPush).not.toHaveBeenCalled();
  });

  it('409 on a stale status, with no audit line and no fresh read', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY' }) })
      .mockRejectedValueOnce(conditionalCheckFailed());

    const res = await call(CANCEL_DONE, { reason: 'x' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/no longer in a cancellable state/i);
    expect(audit('CANCEL_COMPLETED')).toHaveLength(0);
    expect(cmds().filter((c) => c.__cmd === 'Get')).toHaveLength(1);
  });

  it('falls back to a minimal body when the fresh read comes back empty', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY' }) })
      .mockResolvedValueOnce({})   // Update
      .mockResolvedValueOnce({});  // fresh Get — TTL deleted it, say
    const res = await call(CANCEL_DONE, { reason: 'x' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ orderId: 'order-1', status: 'CANCELLED' });
  });

  it('rethrows a non-conditional failure', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY' }) })
      .mockRejectedValueOnce(Object.assign(new Error('kaboom'), { name: 'InternalServerError' }));
    await expect(call(CANCEL_DONE, { reason: 'x' })).rejects.toThrow('kaboom');
  });
});

// ═════════════════════════════════════════════════════════════════════
// release-all — accountability + the counting identity
// (the two safety filters and pagination are pinned in preorder-pending.test.ts)
// ═════════════════════════════════════════════════════════════════════

describe('release-all — accountability and the released+skipped=total identity', () => {
  const RELEASE_ALL = { method: 'PUT', path: '/api/pos/preorders/release-all' };
  const MYT_OFFSET = 8 * 60 * 60 * 1000;

  /** An ISO service-end instant whose MALAYSIA calendar date is `days` away. */
  function serviceEndDaysAway(days: number): string {
    const myt = new Date(Date.now() + MYT_OFFSET);
    return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate() + days, 7, 0, 0)).toISOString();
  }

  function preOrder(overrides: Record<string, any> = {}) {
    return order({ isPreOrder: true, preorderCode: 'MINISTRY1', expiresAt: serviceEndDaysAway(0), ...overrides });
  }

  it('prefers the JWT actor over body.approvedBy on every order in the batch', async () => {
    stageFirst({ Items: [preOrder({ PK: 'ORDER#a', orderId: 'a' }), preOrder({ PK: 'ORDER#b', orderId: 'b' })] });

    await call(RELEASE_ALL, { approvedBy: 'Someone Else' }, 'Sarah');

    const released = orderUpdates().filter((u) => u.ExpressionAttributeValues?.[':s'] === 'PREPARING');
    expect(released).toHaveLength(2);
    for (const u of released) expect(u.ExpressionAttributeValues[':a']).toBe('Sarah');
  });

  it('falls back to body.approvedBy only when there is no actor', async () => {
    stageFirst({ Items: [preOrder()] });
    await call(RELEASE_ALL, { approvedBy: 'Kiosk' }, '');
    expect(orderUpdates()[0].ExpressionAttributeValues[':a']).toBe('Kiosk');
  });

  it('released + skipped === total across a mixed batch, and non-pre-orders are not counted', async () => {
    stageFirst({
      Items: [
        preOrder({ PK: 'ORDER#today', orderId: 'today' }),                              // released
        preOrder({ PK: 'ORDER#later', orderId: 'later', expiresAt: serviceEndDaysAway(7) }), // skipped — later service
        preOrder({ PK: 'ORDER#noexp', orderId: 'noexp', expiresAt: undefined }),        // skipped — unusable
        order({ PK: 'ORDER#unpaid', orderId: 'unpaid', isPreOrder: undefined }),        // NOT in the batch at all
      ],
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await call(RELEASE_ALL, {}, 'Sarah');
      const body = JSON.parse(res.body);
      expect(body).toEqual({ released: 1, skipped: 2, total: 3 });
      expect(body.released + body.skipped).toBe(body.total);
      // The unpaid ordinary PENDING order was never touched — losing that filter
      // mass-approves the whole unpaid queue.
      expect(orderUpdates().map((u) => u.Key.PK)).toEqual(['ORDER#today']);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a per-order conflict counts as skipped and never fails the batch', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Items: [preOrder({ PK: 'ORDER#a', orderId: 'a' }), preOrder({ PK: 'ORDER#b', orderId: 'b' })] })
      .mockRejectedValueOnce(conditionalCheckFailed())   // order a moved under us
      .mockResolvedValue({});

    const res = await call(RELEASE_ALL, {}, 'Sarah');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ released: 1, skipped: 1, total: 2 });
    // Only the released order gets side effects.
    expect(audit('APPROVE')).toHaveLength(1);
    expect(mockSendOrderPush).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// GET /api/pos/orders — the live queue and the ?all=true history
// ═════════════════════════════════════════════════════════════════════

describe('GET /api/pos/orders', () => {
  function stageByStatus(byStatus: Record<string, any[]>) {
    mockDbSend.mockReset();
    mockDbSend.mockImplementation((cmd: any) => {
      if (cmd.__cmd === 'Query') {
        return Promise.resolve({ Items: byStatus[cmd.ExpressionAttributeValues[':s']] || [] });
      }
      return Promise.resolve({});
    });
  }

  function listEvent(qs: Record<string, string> | null = null) {
    return handlePos(
      makeEvent({ httpMethod: 'GET', path: '/api/pos/orders', queryStringParameters: qs }),
      'Sarah',
    );
  }

  it('queries exactly the three live statuses, newest first within each', async () => {
    stageByStatus({});
    const res = await listEvent();
    expect(res.statusCode).toBe(200);

    const queries = cmds().filter((c) => c.__cmd === 'Query');
    expect(queries.map((q) => q.ExpressionAttributeValues[':s'])).toEqual(['PENDING', 'PREPARING', 'READY']);
    for (const q of queries) {
      expect(q.IndexName).toBe('status-createdAt-index');
      expect(q.ScanIndexForward).toBe(false);
      expect(q.KeyConditionExpression).toBe('#s = :s');
    }
  });

  it('orders the queue PENDING → PREPARING → READY', async () => {
    stageByStatus({
      PENDING: [order({ orderId: 'p1' })],
      PREPARING: [order({ orderId: 'x1', status: 'PREPARING' })],
      READY: [order({ orderId: 'r1', status: 'READY' })],
    });
    const body = JSON.parse((await listEvent()).body);
    expect(body.orders.map((o: any) => o.orderId)).toEqual(['p1', 'x1', 'r1']);
  });

  it('?all=true adds the three terminal statuses bounded to the last 7 days', async () => {
    stageByStatus({});
    await listEvent({ all: 'true' });

    const queries = cmds().filter((c) => c.__cmd === 'Query');
    expect(queries.map((q) => q.ExpressionAttributeValues[':s'])).toEqual([
      'PENDING', 'PREPARING', 'READY', 'ARCHIVED', 'CANCELLED', 'EXPIRED',
    ]);
    const history = queries.slice(3);
    for (const q of history) {
      expect(q.KeyConditionExpression).toBe('#s = :s AND createdAt >= :cutoff');
      const cutoffMs = Date.parse(q.ExpressionAttributeValues[':cutoff']);
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(Date.now() - cutoffMs).toBeGreaterThanOrEqual(sevenDays - 5000);
      expect(Date.now() - cutoffMs).toBeLessThanOrEqual(sevenDays + 5000);
    }
  });

  it('?all=true sorts the merged view newest-created first', async () => {
    stageByStatus({
      PENDING: [order({ orderId: 'mid', createdAt: '2026-09-01T05:00:00.000Z' })],
      ARCHIVED: [
        order({ orderId: 'newest', status: 'ARCHIVED', createdAt: '2026-09-01T09:00:00.000Z' }),
        order({ orderId: 'oldest', status: 'ARCHIVED', createdAt: '2026-08-30T01:00:00.000Z' }),
      ],
    });
    const body = JSON.parse((await listEvent({ all: 'true' })).body);
    expect(body.orders.map((o: any) => o.orderId)).toEqual(['newest', 'mid', 'oldest']);
  });

  it('search filters on customerName, case-insensitively, and drops nameless rows', async () => {
    stageByStatus({
      PENDING: [
        order({ orderId: 'a', customerName: 'Mei Yii' }),
        order({ orderId: 'b', customerName: 'AHMAD' }),
        order({ orderId: 'c', customerName: undefined }),
      ],
    });
    const body = JSON.parse((await listEvent({ search: 'ahm' })).body);
    expect(body.orders.map((o: any) => o.orderId)).toEqual(['b']);
  });

  it('?all=true is exact — all=1 does not open the history view', async () => {
    stageByStatus({});
    await listEvent({ all: '1' });
    expect(cmds().filter((c) => c.__cmd === 'Query')).toHaveLength(3);
  });

  it('returns an empty array, never null, when every query is empty', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});   // no Items key at all
    const body = JSON.parse((await listEvent()).body);
    expect(body.orders).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// POST /api/pos/orders — createWalkUp
// ═════════════════════════════════════════════════════════════════════

describe('POST /api/pos/orders — createWalkUp', () => {
  function walkUp(body: Record<string, any>) {
    return handlePos(
      makeEvent({ httpMethod: 'POST', path: '/api/pos/orders', body: JSON.stringify(body) }),
      'Sarah',
    );
  }

  it('writes PREPARING with NO expiresAt — a walk-up must never carry a TTL', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: LATTE_MENU })
      .mockResolvedValue({});

    const res = await walkUp({ customerName: 'Walk-up', items: [{ menuItemId: 'latte', quantity: 2 }] });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      orderId: expect.any(String), totalAmount: 16, status: 'PREPARING',
    });

    const item = orderPuts()[0].Item;
    expect(item.status).toBe('PREPARING');
    // Invariant: only PENDING carries a numeric TTL. One here would let
    // DynamoDB silently delete an active — then archived — order.
    expect(item).not.toHaveProperty('expiresAt');
    expect(item.isWalkUp).toBe(true);
    expect(item.flaggedItems).toEqual([]);
  });

  it('stores the NET/GROSS/OFFSET triple from lib/pricing', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: { ...OPEN_SETTINGS, celebrationMode: true } })
      .mockResolvedValueOnce({ Item: { ...LATTE_MENU, celebrationEligible: true } })
      .mockResolvedValue({});

    await walkUp({ customerName: 'Walk-up', items: [{ menuItemId: 'latte', quantity: 2 }] });

    const item = orderPuts()[0].Item;
    expect(item.totalAmount).toBe(10);        // NET — 2 × RM5 celebration
    expect(item.grossAmount).toBe(16);
    expect(item.discountOffset).toBe(6);
    expect(item.discountOffset).toBe(item.grossAmount - item.totalAmount);
    expect(item.discountType).toBe('CELEBRATION');
  });

  it('frees a FOOD-only NEWCOMER walk-up and records the class', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: COOKIE_MENU })
      .mockResolvedValue({ Item: COOKIE_MENU });

    await walkUp({
      customerName: 'Walk-up', discountType: 'NEWCOMER',
      items: [{ menuItemId: 'cookie', quantity: 1 }],
    });

    const item = orderPuts()[0].Item;
    // PASTOR/NEWCOMER cover FOOD as well as DRINK, so the RM3 cookie is given —
    // NET 0, the whole gross as offset. (This test previously asserted RM3
    // collected and a zero offset, when the class was DRINK-only.) The
    // class-recording half of its original intent is kept below, and the
    // "discounted nothing" half now lives on the STAFF test that follows.
    expect(item.totalAmount).toBe(0);
    expect(item.grossAmount).toBe(3);
    expect(item.discountOffset).toBe(3);
    expect(item.customerClass).toBe('NEWCOMER');
  });

  it('records customerClass when the class discounted nothing (FOOD-only STAFF)', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: COOKIE_MENU })
      .mockResolvedValue({ Item: COOKIE_MENU });

    await walkUp({
      customerName: 'Walk-up', discountType: 'STAFF',
      items: [{ menuItemId: 'cookie', quantity: 1 }],
    });

    const item = orderPuts()[0].Item;
    // STAFF stays DRINK-only (the flat RM5 is a drink price), so this is now the
    // honest fixture for the original guard: a class that reduces nothing is still
    // RECORDED on the order, or newcomer/staff counting silently loses the order.
    expect(item.totalAmount).toBe(3);
    expect(item.discountOffset).toBe(0);
    expect(item.discountType).toBe('NONE');
    expect(item.customerClass).toBe('STAFF');
  });

  it('reserves food and checks sold-out before writing the order', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: COOKIE_MENU })                        // priceLine lookup
      .mockResolvedValueOnce({})                                           // reserve
      .mockResolvedValueOnce({ Item: { ...COOKIE_MENU, foodReserved: 2 } }) // checkSoldOut read
      .mockResolvedValue({});

    await walkUp({ customerName: 'Walk-up', items: [{ menuItemId: 'cookie', quantity: 2 }] });

    const reserve = menuUpdates()[0];
    expect(reserve.UpdateExpression).toBe('SET foodReserved = foodReserved + :q');
    expect(reserve.ExpressionAttributeValues[':q']).toBe(2);
    const reserveIdx = cmds().indexOf(reserve);
    const putIdx = cmds().findIndex((c) => c.__cmd === 'Put' && c.TableName === 'test-orders');
    expect(reserveIdx).toBeLessThan(putIdx);
  });

  it('400 when customerName or items are missing, touching nothing', async () => {
    for (const body of [{}, { customerName: 'X' }, { customerName: 'X', items: [] }, { items: [{ menuItemId: 'latte' }] }]) {
      mockDbSend.mockReset();
      mockDbSend.mockResolvedValue({});
      const res = await walkUp(body);
      expect(res.statusCode).toBe(400);
      expect(cmds()).toHaveLength(0);
    }
  });

  it('400 for an unavailable item, before any reservation or write', async () => {
    for (const menu of [null, { ...LATTE_MENU, isActive: false }, { ...LATTE_MENU, isEnabledToday: false }]) {
      mockDbSend.mockReset();
      mockDbSend
        .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
        .mockResolvedValueOnce(menu ? { Item: menu } : {})
        .mockResolvedValue({});
      const res = await walkUp({ customerName: 'X', items: [{ menuItemId: 'latte', quantity: 1 }] });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/unavailable/);
      expect(orderPuts()).toHaveLength(0);
      expect(menuUpdates()).toHaveLength(0);
    }
  });

  it('400 on insufficient food stock, reserving nothing', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: { ...COOKIE_MENU, foodQuantityToday: 3, foodReserved: 2 } })
      .mockResolvedValue({});

    const res = await walkUp({ customerName: 'X', items: [{ menuItemId: 'cookie', quantity: 2 }] });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Insufficient stock/);
    expect(menuUpdates()).toHaveLength(0);
    expect(orderPuts()).toHaveLength(0);
  });

  it('audits WALKUP with the item summary and the money fields', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: LATTE_MENU })
      .mockResolvedValue({});

    await walkUp({ customerName: 'Walk-up', items: [{ menuItemId: 'latte', quantity: 2 }], notes: 'no sugar' });

    expect(audit('WALKUP')).toHaveLength(1);
    expect(audit('WALKUP')[0][2]).toMatchObject({
      customer: 'Walk-up', items: '2x Latte', total: 16, discount: 'NONE', offset: 0,
    });
    expect(orderPuts()[0].Item.notes).toBe('no sugar');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Cross-cutting: every transition, one table
// ═════════════════════════════════════════════════════════════════════

describe('cross-cutting: every transition is race-guarded', () => {
  const TRANSITIONS: [string, { method: string; path: string }, any, string][] = [
    ['approve',          APPROVE,     { Item: order() },                              '#s = :pending'],
    ['ready',            READY,       { Attributes: order({ status: 'PREPARING' }) }, '#s = :prev'],
    ['undo-ready',       UNDO_READY,  { Attributes: order({ status: 'READY' }) },     '#s = :prev'],
    ['undo',             UNDO,        {},                                             '#s = :prev'],
    ['archive',          ARCHIVE,     { Attributes: order({ status: 'READY' }) },     '#s = :prev'],
    // reject was once the only unguarded flip in this file; it now matches its siblings.
    ['reject',           REJECT,      { Item: order() },                              '#s = :prev'],
  ];

  it.each(TRANSITIONS)('%s sends a ConditionExpression', async (_name, route, first, expr) => {
    stageFirst(first);
    await call(route, { approvedBy: 'Sarah' });
    expect(orderUpdates()[0].ConditionExpression).toBe(expr);
  });

  it('cancel-completed sends a two-status ConditionExpression', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY' }) })
      .mockResolvedValue({ Item: order({ status: 'CANCELLED' }) });
    await call(CANCEL_DONE, { reason: 'x' });
    expect(orderUpdates()[0].ConditionExpression).toBe('#s = :ready OR #s = :archived');
  });

});

describe('cross-cutting: expiresAt is only ever REMOVEd, never written', () => {
  const ALL: [string, { method: string; path: string }, any, boolean][] = [
    // name, route, first response, must contain REMOVE expiresAt
    ['approve (money)',   APPROVE,    { Item: order() },                              true],
    ['archive',           ARCHIVE,    { Attributes: order({ status: 'READY' }) },      true],
    ['ready',             READY,      { Attributes: order({ status: 'PREPARING' }) }, false],
    ['undo-ready',        UNDO_READY, { Attributes: order({ status: 'READY' }) },     false],
    ['undo',              UNDO,       {},                                             false],
  ];

  it.each(ALL)('%s', async (_name, route, first, mustRemove) => {
    stageFirst(first);
    await call(route, { approvedBy: 'Sarah' });
    const u = orderUpdates()[0];
    if (mustRemove) expect(u.UpdateExpression).toContain('REMOVE expiresAt');
    // Whatever the transition does, it must never SET one: a numeric expiresAt
    // outside PENDING is a live TTL that deletes a real order.
    expect(u.UpdateExpression).not.toMatch(/SET[^]*expiresAt\s*=/);
  });

  it('reject and cancel-completed also REMOVE it', async () => {
    stageFirst({ Item: order() });
    await call({ method: 'PUT', path: '/api/pos/orders/order-1/reject' }, { reason: 'x' });
    expect(orderUpdates()[0].UpdateExpression).toContain('REMOVE expiresAt');

    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY' }) })
      .mockResolvedValue({ Item: order({ status: 'CANCELLED' }) });
    await call(CANCEL_DONE, { reason: 'x' });
    expect(orderUpdates()[0].UpdateExpression).toContain('REMOVE expiresAt');
  });
});

describe('cross-cutting: which transitions notify the customer', () => {
  it('approve and ready push; undo, undo-ready, archive, reject and cancel-completed do not', async () => {
    const pushes: Record<string, number> = {};

    const cases: [string, { method: string; path: string }, any, any][] = [
      ['approve',          APPROVE,     { Item: order() },                              { approvedBy: 'Sarah' }],
      ['ready',            READY,       { Attributes: order({ status: 'PREPARING' }) }, null],
      ['undo',             UNDO,        {},                                             null],
      ['undo-ready',       UNDO_READY,  { Attributes: order({ status: 'READY' }) },     null],
      ['archive',          ARCHIVE,     { Attributes: order({ status: 'READY' }) },     null],
      ['reject',           { method: 'PUT', path: '/api/pos/orders/order-1/reject' }, { Item: order() }, { reason: 'x' }],
    ];

    for (const [name, route, first, body] of cases) {
      stageFirst(first);
      mockSendOrderPush.mockClear();
      await call(route, body);
      pushes[name] = mockSendOrderPush.mock.calls.length;
    }

    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order({ status: 'READY' }) })
      .mockResolvedValue({ Item: order({ status: 'CANCELLED' }) });
    mockSendOrderPush.mockClear();
    await call(CANCEL_DONE, { reason: 'x' });
    pushes['cancel-completed'] = mockSendOrderPush.mock.calls.length;

    expect(pushes).toEqual({
      approve: 1, ready: 1,
      undo: 0, 'undo-ready': 0, archive: 0, reject: 0, 'cancel-completed': 0,
    });
  });
});

export {};
