/**
 * Staff link (`?code=<CODE>`) — customer-facing ordering at the staff price.
 *
 * Two things are load-bearing and both are pinned here:
 *
 * 1. A staff link is NOT a pre-order link. It keeps every rule an ordinary
 *    customer order has — café must be OPEN, food allowed, status PENDING with
 *    a NUMERIC `expiresAt` TTL — and only the pricing class differs.
 * 2. The staff price is a customer REQUEST, not an approval. `approveOrder`
 *    must revert it unless the cashier explicitly confirms `discountType:
 *    'STAFF'`, otherwise a self-granted discount lands in the books with
 *    nobody accountable in `approvedBy` — and (because the stored net is below
 *    gross) gets mislabelled CELEBRATION on the way out.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleOrders } = require('../src/routes/orders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePos } = require('../src/routes/pos');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validateStaffCode, malaysiaToday, handleValidateStaffCode } = require('../src/routes/staffcode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { revertRequestedClassPricing } = require('../src/lib/pricing');

// ─── Fixtures ────────────────────────────────────────────────────────

const LATTE = {
  PK: 'MENU#latte', SK: 'META', menuItemId: 'latte', name: 'Latte',
  category: 'DRINK', basePrice: 8, isActive: true, isEnabledToday: true,
};

const CELEBRATION_LATTE = { ...LATTE, celebrationEligible: true };

const COOKIE = {
  PK: 'MENU#cookie', SK: 'META', menuItemId: 'cookie', name: 'Cookie',
  category: 'FOOD', basePrice: 3, isActive: true, isEnabledToday: true,
  foodQuantityToday: 10, foodReserved: 0,
};

const OPEN_SETTINGS = { cafeStatus: 'OPEN', celebrationMode: false, celebrationPrice: 5, orderExpiryMinutes: 30 };

function staffCodeRecord(overrides: Record<string, any> = {}) {
  return {
    PK: 'STAFF_CODE#STAFF', SK: 'META', code: 'STAFF', label: 'Staff price',
    isActive: true, startDate: '', endDate: '',
    createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'Admin',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function orderEvent(body: Record<string, any>) {
  return {
    httpMethod: 'POST', path: '/api/orders',
    body: JSON.stringify(body),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

function approveEvent(body: Record<string, any>) {
  return {
    httpMethod: 'PUT', path: '/api/pos/orders/order-1/approve',
    body: JSON.stringify(body),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

/** All Put commands issued, unwrapped. */
function puts() {
  return mockDbSend.mock.calls.map(c => c[0]).filter(c => c.__cmd === 'Put');
}

/** The order record that would have been written. */
function writtenOrder() {
  return puts().find(c => c.TableName === 'test-orders')?.Item;
}

/** The conditional Update issued against the orders table. */
function orderUpdate() {
  return mockDbSend.mock.calls.map(c => c[0])
    .find(c => c.__cmd === 'Update' && c.TableName === 'test-orders');
}

beforeEach(() => { mockDbSend.mockReset(); });

// ─── createOrder with a staff code ───────────────────────────────────

describe('createOrder — staff code', () => {
  it('prices DRINKs at RM5 and FOOD at full price, PENDING with a numeric TTL', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })       // settings
      .mockResolvedValueOnce({ Item: staffCodeRecord() })   // staff code
      .mockResolvedValueOnce({ Item: LATTE })               // menu — drink
      .mockResolvedValueOnce({ Item: COOKIE })              // menu — food
      .mockResolvedValue({});                               // food reserve + put

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF',
      items: [
        { menuItemId: 'latte', quantity: 1 },
        { menuItemId: 'cookie', quantity: 2 },
      ],
    }));
    expect(res.statusCode).toBe(201);

    const order = writtenOrder();

    // Drink at the staff rate, food untouched. FOOD is never discounted.
    const drink = order.items.find((i: any) => i.menuItemId === 'latte');
    const food = order.items.find((i: any) => i.menuItemId === 'cookie');
    expect(drink.unitPrice).toBe(5);
    expect(drink.grossUnitPrice).toBe(8);
    expect(food.unitPrice).toBe(3);

    // Money storage convention: totalAmount NET, grossAmount undiscounted.
    expect(order.totalAmount).toBe(5 + 6);   // 11 net
    expect(order.grossAmount).toBe(8 + 6);   // 14 gross
    expect(order.discountOffset).toBe(order.grossAmount - order.totalAmount);
    expect(order.discountOffset).toBe(3);

    expect(order.discountType).toBe('STAFF');
    expect(order.customerClass).toBe('STAFF');
    expect(order.staffCode).toBe('STAFF');

    // Status/TTL discipline: PENDING carries a NUMERIC expiresAt (a real TTL).
    // Pre-orders use an ISO string on purpose; a staff order must not.
    expect(order.status).toBe('PENDING');
    expect(typeof order.expiresAt).toBe('number');
    expect(order.isPreOrder).toBeUndefined();
  });

  it('reserves food stock — staff orders may include food (pre-orders may not)', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: staffCodeRecord() })
      .mockResolvedValueOnce({ Item: COOKIE })
      .mockResolvedValue({});

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF',
      items: [{ menuItemId: 'cookie', quantity: 2 }],
    }));
    expect(res.statusCode).toBe(201);

    const reserve = mockDbSend.mock.calls.map(c => c[0])
      .find(c => c.__cmd === 'Update' && c.TableName === 'test-menu');
    expect(reserve.UpdateExpression).toContain('foodReserved = foodReserved + :q');
    expect(reserve.ExpressionAttributeValues[':q']).toBe(2);
  });

  it('rejects with 403 when the café is CLOSED, even with a valid code', async () => {
    // Pre-orders bypass the café-open check. Staff orders are live orders and
    // must not.
    mockDbSend
      .mockResolvedValueOnce({ Item: { ...OPEN_SETTINGS, cafeStatus: 'CLOSED' } })
      .mockResolvedValue({ Item: staffCodeRecord() });

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Cafe is not open');
    expect(puts()).toHaveLength(0);
  });

  it('rejects a deactivated code with 400 and writes nothing', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: staffCodeRecord({ isActive: false }) })
      .mockResolvedValue({});

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Staff code invalid');
    expect(puts()).toHaveLength(0);
  });

  // The three guard tests above (café CLOSED, deactivated, date-gated) stage no
  // menu item, so if the guard were removed the request would still die at
  // "Item latte not found" and still write nothing — their teeth rest entirely
  // on the error-message string. These two stage a VALID menu item so that
  // dropping the guard produces a real 201 with a real RM5 order, and the
  // failure is the discount itself rather than an incidental mock miss.
  it('a deactivated code cannot write an RM5 order even with the menu staged', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: staffCodeRecord({ isActive: false }) })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(writtenOrder()).toBeUndefined();
  });

  it('a CLOSED café cannot write an RM5 order even with the menu staged', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { ...OPEN_SETTINGS, cafeStatus: 'CLOSED' } })
      .mockResolvedValueOnce({ Item: staffCodeRecord() })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(403);
    expect(writtenOrder()).toBeUndefined();
  });

  it('an expired code cannot write an RM5 order even with the menu staged', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: staffCodeRecord({ endDate: '2000-01-01' }) })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(writtenOrder()).toBeUndefined();
  });

  it('rejects a code whose startDate is still in the future (not_yet)', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: staffCodeRecord({ startDate: '2099-01-01' }) })
      .mockResolvedValue({});

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Staff code not_yet');
    expect(puts()).toHaveLength(0);
  });

  it('rejects a code whose endDate has passed (expired)', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: staffCodeRecord({ endDate: '2000-01-01' }) })
      .mockResolvedValue({});

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Staff code expired');
    expect(puts()).toHaveLength(0);
  });

  it('resolves a lowercase code against the uppercased key', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: staffCodeRecord() })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: '  staff  ',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(201);

    // The lookup Key itself is the assertion: trim + uppercase on read must
    // match trim + uppercase on write, or a hand-typed code silently misses.
    const lookup = mockDbSend.mock.calls.map(c => c[0])
      .find(c => c.__cmd === 'Get' && String(c.Key?.PK || '').startsWith('STAFF_CODE#'));
    expect(lookup.Key).toEqual({ PK: 'STAFF_CODE#STAFF', SK: 'META' });
    expect(lookup.TableName).toBe('test-settings');
  });

  it('refuses a staff code combined with a pre-order code', async () => {
    const res = await handleOrders(orderEvent({
      customerName: 'Mei Yii', staffCode: 'STAFF', preorderCode: 'ABC123',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/cannot be combined/i);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('leaves an ordinary order with no code completely unaffected', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders(orderEvent({
      customerName: 'Walk-in',
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(201);

    const order = writtenOrder();
    expect(order.items[0].unitPrice).toBe(8);          // full price
    expect(order.items[0].baseUnitPrice).toBeUndefined(); // shape unchanged
    expect(order.totalAmount).toBe(8);
    expect(order.discountType).toBe('NONE');
    expect(order.discountOffset).toBe(0);
    expect(order.staffCode).toBeUndefined();
    expect(order.customerClass).toBeUndefined();
  });
});

// ─── modifyOrder on a staff order ────────────────────────────────────

describe('modifyOrder — staff order keeps the staff price', () => {
  it('reprices a PENDING staff order at RM5, not full price', async () => {
    const existing = {
      PK: 'ORDER#order-1', SK: 'META', orderId: 'order-1', status: 'PENDING',
      items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, unitPrice: 5, grossUnitPrice: 8, baseUnitPrice: 8, category: 'DRINK' }],
      totalAmount: 5, staffCode: 'STAFF', customerClass: 'STAFF',
    };
    mockDbSend
      .mockResolvedValueOnce({ Item: existing })          // Get(order)
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })     // settings
      .mockResolvedValueOnce({ Item: LATTE })             // menu
      .mockResolvedValue({});

    const res = await handleOrders({
      httpMethod: 'PUT', path: '/api/orders/order-1',
      body: JSON.stringify({ action: 'update', items: [{ menuItemId: 'latte', quantity: 2 }] }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(200);

    const update = orderUpdate();
    expect(update.ExpressionAttributeValues[':t']).toBe(10);   // 2 × RM5, not 2 × RM8
    expect(update.ExpressionAttributeValues[':ga']).toBe(16);
    expect(update.ExpressionAttributeValues[':dt']).toBe('STAFF');
    expect(update.ExpressionAttributeValues[':items'][0].baseUnitPrice).toBe(8);
  });

  it('leaves a non-staff order editing at full price', async () => {
    const existing = {
      PK: 'ORDER#order-2', SK: 'META', orderId: 'order-2', status: 'PENDING',
      items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, unitPrice: 8, grossUnitPrice: 8, category: 'DRINK' }],
      totalAmount: 8,
    };
    mockDbSend
      .mockResolvedValueOnce({ Item: existing })
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders({
      httpMethod: 'PUT', path: '/api/orders/order-2',
      body: JSON.stringify({ action: 'update', items: [{ menuItemId: 'latte', quantity: 2 }] }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(200);

    const update = orderUpdate();
    expect(update.ExpressionAttributeValues[':t']).toBe(16);
    expect(update.ExpressionAttributeValues[':dt']).toBe('NONE');
    expect(update.ExpressionAttributeValues[':items'][0].baseUnitPrice).toBeUndefined();
  });
});

// ─── approveOrder — the cashier's confirmation ───────────────────────

/** A PENDING staff order as `createOrder` would have written it. */
function staffOrder(itemOverrides: Record<string, any> = {}) {
  return {
    PK: 'ORDER#order-1', SK: 'META', orderId: 'order-1', customerName: 'Mei Yii',
    status: 'PENDING', staffCode: 'STAFF', customerClass: 'STAFF',
    items: [{
      menuItemId: 'latte', name: 'Latte', variant: null, quantity: 1,
      unitPrice: 5, grossUnitPrice: 8, baseUnitPrice: 8, category: 'DRINK',
      ...itemOverrides,
    }],
    totalAmount: 5, grossAmount: 8, discountOffset: 3, discountType: 'STAFF',
    expiresAt: 1_800_000_000,
  };
}

describe('approveOrder — staff price requires cashier confirmation', () => {
  it('CONFIRMED: discountType STAFF keeps drinks at RM5', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: staffOrder() })
      .mockResolvedValue({});

    const res = await handlePos(approveEvent({ approvedBy: 'Sarah', discountType: 'STAFF' }), 'Sarah');
    expect(res.statusCode).toBe(200);

    const update = orderUpdate();
    const v = update.ExpressionAttributeValues;
    expect(v[':items'][0].unitPrice).toBe(5);
    expect(v[':t']).toBe(5);
    expect(v[':ga']).toBe(8);
    expect(v[':do']).toBe(3);
    expect(v[':dt']).toBe('STAFF');
    expect(v[':a']).toBe('Sarah');

    // Leaving PENDING must drop the TTL or DynamoDB deletes the live order.
    expect(update.UpdateExpression).toContain('REMOVE expiresAt');
  });

  it('DECLINED: approving with no class reprices the drink to full price', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: staffOrder() })
      .mockResolvedValue({});

    const res = await handlePos(approveEvent({ approvedBy: 'Sarah' }), 'Sarah');
    expect(res.statusCode).toBe(200);

    const v = orderUpdate().ExpressionAttributeValues;
    // Without revertRequestedClassPricing the stored RM5 would survive as the
    // cheaper incumbent candidate AND be relabelled CELEBRATION.
    expect(v[':items'][0].unitPrice).toBe(8);
    expect(v[':t']).toBe(8);
    expect(v[':ga']).toBe(8);
    expect(v[':do']).toBe(0);
    expect(v[':dt']).toBe('NONE');
    expect(v[':a']).toBe('Sarah');       // still accountable
  });

  it('DECLINED also drops the PENDING TTL', async () => {
    // Asserted on the confirm path already. The decline path leaves PENDING
    // too, so it must drop expiresAt as well or DynamoDB TTL deletes the live
    // order out from under the kitchen.
    mockDbSend
      .mockResolvedValueOnce({ Item: staffOrder() })
      .mockResolvedValue({});

    const res = await handlePos(approveEvent({ approvedBy: 'Sarah' }), 'Sarah');
    expect(res.statusCode).toBe(200);
    expect(orderUpdate().UpdateExpression).toContain('REMOVE expiresAt');
  });

  it('DECLINED with an explicit NONE behaves the same way', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: staffOrder() })
      .mockResolvedValue({});

    const res = await handlePos(approveEvent({ approvedBy: 'Sarah', discountType: 'NONE' }), 'Sarah');
    expect(res.statusCode).toBe(200);

    const v = orderUpdate().ExpressionAttributeValues;
    expect(v[':items'][0].unitPrice).toBe(8);
    expect(v[':dt']).toBe('NONE');
  });

  it('DECLINED on a celebration-eligible drink keeps the CELEBRATION price', async () => {
    // baseUnitPrice, not grossUnitPrice: declining the staff request must not
    // also throw away a discount the customer was entitled to anyway.
    // Celebration RM6 here so it is distinguishable from both RM5 and RM8.
    mockDbSend
      .mockResolvedValueOnce({ Item: staffOrder({ baseUnitPrice: 6 }) })
      .mockResolvedValue({});

    const res = await handlePos(approveEvent({ approvedBy: 'Sarah' }), 'Sarah');
    expect(res.statusCode).toBe(200);

    const v = orderUpdate().ExpressionAttributeValues;
    expect(v[':items'][0].unitPrice).toBe(6);
    expect(v[':t']).toBe(6);
    expect(v[':do']).toBe(2);
    expect(v[':dt']).toBe('CELEBRATION');
  });

  it('does not touch a non-staff order: STAFF stays a normal cashier decision', async () => {
    const plain = {
      PK: 'ORDER#order-1', SK: 'META', orderId: 'order-1', customerName: 'Walk-in',
      status: 'PENDING',
      items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, unitPrice: 8, grossUnitPrice: 8, category: 'DRINK' }],
      totalAmount: 8,
    };
    mockDbSend
      .mockResolvedValueOnce({ Item: plain })
      .mockResolvedValue({});

    const res = await handlePos(approveEvent({ approvedBy: 'Sarah', discountType: 'STAFF' }), 'Sarah');
    expect(res.statusCode).toBe(200);

    const v = orderUpdate().ExpressionAttributeValues;
    expect(v[':items'][0].unitPrice).toBe(5);
    expect(v[':dt']).toBe('STAFF');
  });
});

// ─── validateStaffCode — the date gate ───────────────────────────────

describe('validateStaffCode date gate (Malaysia time, inclusive)', () => {
  function stage(record: any) {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({ Item: record });
  }

  it('derives today from MYT (UTC+8), not UTC', () => {
    // 16:00Z is already the next calendar day in Malaysia.
    expect(malaysiaToday(new Date('2026-08-17T15:59:59Z'))).toBe('2026-08-17');
    expect(malaysiaToday(new Date('2026-08-17T16:00:00Z'))).toBe('2026-08-18');
  });

  it('is valid ON the startDate (inclusive)', async () => {
    stage(staffCodeRecord({ startDate: '2026-08-17' }));
    // MYT today = 2026-08-17
    const v = await validateStaffCode('STAFF', new Date('2026-08-16T16:00:00Z'));
    expect(v.valid).toBe(true);
  });

  it('is not_yet the MYT day before startDate', async () => {
    stage(staffCodeRecord({ startDate: '2026-08-17' }));
    // MYT today = 2026-08-16
    const v = await validateStaffCode('STAFF', new Date('2026-08-16T15:59:59Z'));
    expect(v).toEqual({ valid: false, reason: 'not_yet' });
  });

  it('is valid ON the endDate (inclusive)', async () => {
    stage(staffCodeRecord({ endDate: '2026-08-17' }));
    // MYT today = 2026-08-17, right up to local midnight
    const v = await validateStaffCode('STAFF', new Date('2026-08-17T15:59:59Z'));
    expect(v.valid).toBe(true);
  });

  it('is expired the MYT day after endDate', async () => {
    stage(staffCodeRecord({ endDate: '2026-08-17' }));
    // MYT today = 2026-08-18
    const v = await validateStaffCode('STAFF', new Date('2026-08-17T16:00:00Z'));
    expect(v).toEqual({ valid: false, reason: 'expired' });
  });

  it('treats empty startDate/endDate as unbounded on that side', async () => {
    stage(staffCodeRecord({ startDate: '', endDate: '' }));
    expect((await validateStaffCode('STAFF', new Date('1999-01-01T00:00:00Z'))).valid).toBe(true);
    expect((await validateStaffCode('STAFF', new Date('2099-01-01T00:00:00Z'))).valid).toBe(true);
  });

  it('treats an absent date field as unbounded too (records written before the gate)', async () => {
    const { startDate, endDate, ...noDates } = staffCodeRecord();
    stage(noDates);
    expect((await validateStaffCode('STAFF', new Date('2099-01-01T00:00:00Z'))).valid).toBe(true);
  });

  it('rejects a malformed code without hitting the table', async () => {
    mockDbSend.mockReset();
    // 0/O/1/I/L are not in the alphabet; too-short is out of range.
    for (const bad of ['', '   ', 'AB', 'STAFF0', 'STAFF-1', 'A'.repeat(17)]) {
      expect(await validateStaffCode(bad)).toEqual({ valid: false, reason: 'invalid' });
    }
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('reports invalid when no record exists', async () => {
    stage(undefined);
    expect(await validateStaffCode('STAFF')).toEqual({ valid: false, reason: 'invalid' });
  });
});

// ─── Public validate endpoint contract ───────────────────────────────

describe('GET /api/staff-code/validate', () => {
  it('returns 200 with the uppercased code and label', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({ Item: staffCodeRecord() });
    const res = await handleValidateStaffCode({
      httpMethod: 'GET', path: '/api/staff-code/validate',
      queryStringParameters: { code: 'staff' }, headers: {}, body: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ valid: true, code: 'STAFF', label: 'Staff price' });
  });

  it('returns an empty-string label when the record has none', async () => {
    mockDbSend.mockReset();
    const { label, ...noLabel } = staffCodeRecord();
    mockDbSend.mockResolvedValue({ Item: noLabel });
    const res = await handleValidateStaffCode({
      httpMethod: 'GET', path: '/api/staff-code/validate',
      queryStringParameters: { code: 'STAFF' }, headers: {}, body: null, pathParameters: null,
    } as any);
    expect(JSON.parse(res.body)).toEqual({ valid: true, code: 'STAFF', label: '' });
  });

  it('returns 400 with a reason for a bad code', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({ Item: staffCodeRecord({ isActive: false }) });
    const res = await handleValidateStaffCode({
      httpMethod: 'GET', path: '/api/staff-code/validate',
      queryStringParameters: { code: 'STAFF' }, headers: {}, body: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ valid: false, reason: 'invalid' });
  });
});

// ─── Admin single-entry upsert ───────────────────────────────────────

describe('handleAdminStaffCode', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handleAdminStaffCode } = require('../src/routes/staffcode');

  function adminEvent(method: string, body?: Record<string, any>) {
    return {
      httpMethod: method, path: '/api/admin/staff-code',
      body: body ? JSON.stringify(body) : null,
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any;
  }

  it('GET returns null when no code has been configured', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({ Items: [] });
    const res = await handleAdminStaffCode(adminEvent('GET'), 'Admin');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ staffCode: null });
  });

  it('GET scans the STAFF_CODE# prefix and returns the freshest record', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({ Items: [
      staffCodeRecord({ code: 'TEAM7', PK: 'STAFF_CODE#TEAM7', updatedAt: '2026-01-01T00:00:00.000Z' }),
      staffCodeRecord({ code: 'STAFF', PK: 'STAFF_CODE#STAFF', updatedAt: '2026-08-01T00:00:00.000Z' }),
    ] });
    const res = await handleAdminStaffCode(adminEvent('GET'), 'Admin');
    const scan = mockDbSend.mock.calls[0][0];
    expect(scan.__cmd).toBe('Scan');
    expect(scan.ExpressionAttributeValues[':prefix']).toBe('STAFF_CODE#');
    expect(JSON.parse(res.body).staffCode.code).toBe('STAFF');
  });

  it('PUT upserts and deletes every other STAFF_CODE# record (single entry)', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Items: [staffCodeRecord({ code: 'TEAM7', PK: 'STAFF_CODE#TEAM7' })] }) // load existing
      .mockResolvedValueOnce({})                                                                      // put new
      .mockResolvedValueOnce({ Items: [                                                               // sweep scan
        staffCodeRecord({ code: 'TEAM7', PK: 'STAFF_CODE#TEAM7' }),
        staffCodeRecord({ code: 'STAFF', PK: 'STAFF_CODE#STAFF' }),
      ] })
      .mockResolvedValue({});

    const res = await handleAdminStaffCode(adminEvent('PUT', { code: 'staff', label: 'Staff' }), 'Admin');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).staffCode.code).toBe('STAFF');

    const deletes = mockDbSend.mock.calls.map(c => c[0]).filter(c => c.__cmd === 'Delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Key.PK).toBe('STAFF_CODE#TEAM7');
  });

  it('PUT preserves createdAt/createdBy when the code is unchanged', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Items: [staffCodeRecord({ createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'Mei Yii' })] })
      .mockResolvedValue({ Items: [] });

    const res = await handleAdminStaffCode(adminEvent('PUT', { code: 'STAFF', isActive: false }), 'Admin');
    const saved = JSON.parse(res.body).staffCode;
    expect(saved.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(saved.createdBy).toBe('Mei Yii');
    expect(saved.isActive).toBe(false);
    expect(saved.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('PUT stamps a fresh createdBy when the code changes', async () => {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Items: [staffCodeRecord({ createdBy: 'Mei Yii' })] })
      .mockResolvedValue({ Items: [] });

    const res = await handleAdminStaffCode(adminEvent('PUT', { code: 'TEAM7' }), 'Admin');
    expect(JSON.parse(res.body).staffCode.createdBy).toBe('Admin');
  });

  it('PUT defaults isActive to true and stores the exact record shape', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({ Items: [] });
    const res = await handleAdminStaffCode(adminEvent('PUT', {
      code: 'STAFF', label: '  Staff price  ', startDate: '2026-08-01', endDate: '2026-12-31',
    }), 'Admin');
    const saved = JSON.parse(res.body).staffCode;
    expect(saved.isActive).toBe(true);
    expect(saved.label).toBe('Staff price');
    expect(Object.keys(saved).sort()).toEqual(
      ['PK', 'SK', 'code', 'createdAt', 'createdBy', 'endDate', 'isActive', 'label', 'startDate', 'updatedAt'].sort()
    );
  });

  it('PUT validates code, alphabet, length, label, dates', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({ Items: [] });

    const cases: [Record<string, any>, RegExp][] = [
      [{}, /code is required/i],
      [{ code: 'AB' }, /3-16 characters/],
      [{ code: 'A'.repeat(17) }, /3-16 characters/],
      [{ code: 'STAFF0' }, /may only use/i],          // 0 is ambiguous with O
      [{ code: 'ST AFF' }, /may only use/i],
      [{ code: 'STAFF', label: 'x'.repeat(61) }, /60 characters/],
      [{ code: 'STAFF', startDate: '01-08-2026' }, /startDate must be YYYY-MM-DD/],
      [{ code: 'STAFF', endDate: 'soon' }, /endDate must be YYYY-MM-DD/],
      [{ code: 'STAFF', startDate: '2026-08-10', endDate: '2026-08-09' }, /endDate cannot be before startDate/],
    ];
    for (const [body, expected] of cases) {
      const res = await handleAdminStaffCode(adminEvent('PUT', body), 'Admin');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(expected);
    }
    expect(mockDbSend.mock.calls.filter(c => c[0].__cmd === 'Put')).toHaveLength(0);
  });

  it('returns 404 for an unknown method and 500 on an unexpected failure', async () => {
    mockDbSend.mockReset();
    expect((await handleAdminStaffCode(adminEvent('DELETE'), 'Admin')).statusCode).toBe(404);
    mockDbSend.mockRejectedValue(new Error('boom'));
    const res = await handleAdminStaffCode(adminEvent('GET'), 'Admin');
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBeTruthy();
  });
});

// ─── revertRequestedClassPricing — fallback chain ────────────────────

describe('revertRequestedClassPricing', () => {
  it('prefers baseUnitPrice', () => {
    const out = revertRequestedClassPricing([
      { menuItemId: 'a', quantity: 1, unitPrice: 5, grossUnitPrice: 8, baseUnitPrice: 6, category: 'DRINK' },
    ]);
    expect(out[0].unitPrice).toBe(6);
  });

  it('falls back to grossUnitPrice on a legacy record with no baseUnitPrice', () => {
    const out = revertRequestedClassPricing([
      { menuItemId: 'a', quantity: 1, unitPrice: 5, grossUnitPrice: 8, category: 'DRINK' },
    ]);
    expect(out[0].unitPrice).toBe(8);
  });

  it('leaves unitPrice alone when neither field is present', () => {
    const out = revertRequestedClassPricing([
      { menuItemId: 'a', quantity: 1, unitPrice: 5, category: 'DRINK' },
    ]);
    expect(out[0].unitPrice).toBe(5);
  });

  it('does not mutate the input and preserves every other attribute', () => {
    const input = [{ menuItemId: 'a', name: 'Latte', quantity: 2, unitPrice: 5, grossUnitPrice: 8, baseUnitPrice: 8, category: 'DRINK' }];
    const out = revertRequestedClassPricing(input);
    expect(input[0].unitPrice).toBe(5);
    expect(out[0]).toMatchObject({ menuItemId: 'a', name: 'Latte', quantity: 2, category: 'DRINK', grossUnitPrice: 8 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
