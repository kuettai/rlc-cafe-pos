/**
 * Pre-orders live in PENDING (v1.71) — the lifecycle consequences.
 *
 * Pre-orders used to be created `status: 'PREPARING'`, which meant a customer
 * could never edit one: `track.js` only offers Edit/Cancel on PENDING, and
 * `modifyOrder` is gated by `ConditionExpression: '#s = :pending'`. Creating them
 * PENDING reuses the whole existing Edit Order feature, and the cashier's normal
 * PENDING → PREPARING approve becomes the lock.
 *
 * That moves a pre-order through code paths it had never touched, and this file
 * pins the three that can lose or over-expire a real order:
 *
 *   1. `approveOrder` must not BILL it, and must PRESERVE the ISO `expiresAt`.
 *   2. `closeCafe` must not expire it — the query is unbounded by date, so
 *      closing tonight would otherwise kill every future pre-order.
 *   3. `expirePreOrders` must sweep PENDING, and must self-heal an order that
 *      has lost `expiresAt` — otherwise that order is immortal, since the
 *      1-hour PENDING sweep skips all pre-orders by design.
 *
 * The `expiresAt` on a pre-order is an ISO STRING throughout, deliberately: it is
 * inert as a DynamoDB TTL (which only acts on numbers) and is instead compared
 * string-wise by expiry.ts. Numeric would arm a real TTL on a record meant to
 * live for days and DynamoDB would silently delete it.
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
const { handler: expiryHandler } = require('../src/expiry');

// ─── Fixtures ────────────────────────────────────────────────────────

const LATTE = {
  PK: 'MENU#latte', SK: 'META', menuItemId: 'latte', name: 'Latte',
  category: 'DRINK', basePrice: 8, isActive: true, isEnabledToday: true,
};

const PAST_END   = '2000-01-01T00:00:00.000Z';
const FUTURE_END = '2099-12-25T07:00:00.000Z';

/** A pre-order link record as `createPreorderCode` writes it. */
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

/** A PENDING pre-order as `createOrder` writes it. */
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
function orderUpdate() { return orderUpdates()[0]; }
function expiryUpdates() {
  return orderUpdates().filter(u => u.ExpressionAttributeValues?.[':expired'] === 'EXPIRED');
}

function approveEvent(id: string, body: Record<string, any> = { approvedBy: 'Sarah' }) {
  return {
    httpMethod: 'PUT', path: `/api/pos/orders/${id}/approve`,
    body: JSON.stringify(body),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

function undoEvent(id: string) {
  return {
    httpMethod: 'PUT', path: `/api/pos/orders/${id}/undo`,
    body: '{}', headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

function modifyEvent(id: string, items: any[]) {
  return {
    httpMethod: 'PUT', path: `/api/orders/${id}`,
    body: JSON.stringify({ action: 'update', items }),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

beforeEach(() => { mockDbSend.mockReset(); });

// ─── createOrder ─────────────────────────────────────────────────────

describe('createOrder — a pre-order is born PENDING and free', () => {
  it('writes PENDING, RM0 net, full item unitPrice and an ISO expiresAt', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { cafeStatus: 'CLOSED', celebrationMode: false } }) // pre-orders bypass café-open
      .mockResolvedValueOnce({ Item: codeRecord() })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders({
      httpMethod: 'POST', path: '/api/orders',
      body: JSON.stringify({
        customerName: 'Grace', preorderCode: 'ABC123',
        collectionTime: 'After 1st Service',
        items: [{ menuItemId: 'latte', quantity: 2 }],
      }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(201);

    const o = cmds().find(c => c.__cmd === 'Put' && c.TableName === 'test-orders').Item;

    // PENDING is what makes the order editable — this is the whole fix.
    expect(o.status).toBe('PENDING');

    // Money: NET 0, gross recorded, offset = the whole gross.
    expect(o.totalAmount).toBe(0);
    expect(o.grossAmount).toBe(16);
    expect(o.discountOffset).toBe(16);
    // Reports switch on discountType against a fixed list; 'PREORDER' is not in
    // it and would drop the order out of every discount table.
    expect(o.discountType).toBe('MINISTRY_PREORDER');
    expect(o.customerClass).toBe('PREORDER');

    // Items keep the FULL unit price — free-ness lives at order level. Every
    // pre-order record already in production has this shape; nothing is
    // backfilled.
    expect(o.items[0].unitPrice).toBe(8);
    expect(o.items[0].grossUnitPrice).toBe(8);

    // ISO string, never a number: a number here is a live TTL.
    expect(typeof o.expiresAt).toBe('string');
    expect(o.expiresAt).toBe(FUTURE_END);
  });
});

// ─── approveOrder ────────────────────────────────────────────────────

describe('approveOrder — a pre-order must not be billed', () => {
  it('stays RM0 / MINISTRY_PREORDER even though the cashier sends no class', async () => {
    // The cashier's dropdown has no PREORDER entry and parseCustomerClass
    // refuses one, so body.discountType cannot supply it. With a null class
    // repriceStoredItems keeps the stored FULL unitPrice as the incumbent
    // candidate and the order comes out billed at RM16.
    mockDbSend.mockResolvedValueOnce({ Item: preOrder() }).mockResolvedValue({});

    const res = await handlePos(approveEvent('p1'), 'Sarah');
    expect(res.statusCode).toBe(200);

    const v = orderUpdate().ExpressionAttributeValues;
    expect(v[':t']).toBe(0);
    expect(v[':ga']).toBe(16);
    expect(v[':do']).toBe(16);
    expect(v[':dt']).toBe('MINISTRY_PREORDER');
    expect(v[':cc']).toBe('PREORDER');
    expect(v[':s']).toBe('PREPARING');
    expect(orderUpdate().ConditionExpression).toBe('#s = :pending');
  });

  it('PRESERVES the ISO expiresAt — nothing else would ever expire the order', async () => {
    // The general rule is "every transition out of PENDING must REMOVE
    // expiresAt", because a NUMERIC expiresAt is a live TTL. An ISO string is
    // inert to TTL and is the ONLY input to expirePreOrders(), so stripping it
    // leaves an approved-but-uncollected pre-order in PREPARING forever.
    mockDbSend.mockResolvedValueOnce({ Item: preOrder() }).mockResolvedValue({});

    await handlePos(approveEvent('p1'), 'Sarah');
    expect(orderUpdate().UpdateExpression).not.toContain('expiresAt');
  });

  it('a NUMERIC expiresAt on a pre-order is still REMOVEd (never leave a live TTL)', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: preOrder({ expiresAt: 1_800_000_000 }) }).mockResolvedValue({});
    await handlePos(approveEvent('p1'), 'Sarah');
    expect(orderUpdate().UpdateExpression).toContain('REMOVE expiresAt');
  });

  it('an ordinary order still REMOVEs its numeric TTL', async () => {
    mockDbSend.mockResolvedValueOnce({
      Item: {
        PK: 'ORDER#n1', SK: 'META', orderId: 'n1', status: 'PENDING',
        items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, unitPrice: 8, grossUnitPrice: 8, category: 'DRINK' }],
        totalAmount: 8, expiresAt: 1_800_000_000,
      },
    }).mockResolvedValue({});

    const res = await handlePos(approveEvent('n1'), 'Sarah');
    expect(res.statusCode).toBe(200);
    expect(orderUpdate().UpdateExpression).toContain('REMOVE expiresAt');
    expect(orderUpdate().ExpressionAttributeValues[':t']).toBe(8);
  });

  it('cannot be zeroed by passing discountType PREORDER in the body', async () => {
    // parseCustomerClass refuses 'PREORDER' precisely so a cashier or a crafted
    // request cannot make any order free and have it reported as a ministry
    // pre-order. The class may only be derived from the record's isPreOrder.
    mockDbSend.mockResolvedValueOnce({
      Item: {
        PK: 'ORDER#n1', SK: 'META', orderId: 'n1', status: 'PENDING',
        items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, unitPrice: 8, grossUnitPrice: 8, category: 'DRINK' }],
        totalAmount: 8, expiresAt: 1_800_000_000,
      },
    }).mockResolvedValue({});

    await handlePos(approveEvent('n1', { approvedBy: 'Sarah', discountType: 'PREORDER' }), 'Sarah');
    const v = orderUpdate().ExpressionAttributeValues;
    expect(v[':t']).toBe(8);
    expect(v[':dt']).toBe('NONE');
  });
});

// ─── The release → undo round trip ───────────────────────────────────

describe('undo after an early release — the pre-order stays free and editable', () => {
  it('approve → undo leaves PENDING with the money fields untouched', async () => {
    // A volunteer taps "Release to barista" on Wednesday by mistake; swipe-left
    // (undoToPending) is the recovery path. It writes only #s and updatedAt — no
    // reprice — so whatever approve wrote has to already be correct.
    mockDbSend.mockResolvedValueOnce({ Item: preOrder() }).mockResolvedValue({});
    await handlePos(approveEvent('p1'), 'Sarah');

    const approved = orderUpdate().ExpressionAttributeValues;
    expect(approved[':t']).toBe(0);
    expect(approved[':dt']).toBe('MINISTRY_PREORDER');
    expect(approved[':cc']).toBe('PREORDER');
    // The fixture's ISO expiresAt survives because approve omitted the REMOVE —
    // asserted on the write, not on the fixture.
    expect(orderUpdate().UpdateExpression).not.toContain('expiresAt');

    // The record as it now stands in DynamoDB: approve's values applied, and
    // the ISO expiresAt preserved.
    const released = preOrder({
      status: 'PREPARING',
      totalAmount: approved[':t'],
      grossAmount: approved[':ga'],
      discountOffset: approved[':do'],
      discountType: approved[':dt'],
      customerClass: approved[':cc'],
      items: approved[':items'],
      approvedBy: 'Sarah',
    });

    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
    const undo = await handlePos(undoEvent('p1'), 'Sarah');
    expect(undo.statusCode).toBe(200);
    expect(JSON.parse(undo.body).status).toBe('PENDING');

    const u = orderUpdate();
    expect(u.ExpressionAttributeValues[':s']).toBe('PENDING');
    expect(u.ExpressionAttributeValues[':prev']).toBe('PREPARING');
    expect(u.ConditionExpression).toBe('#s = :prev');
    // Undo touches neither the money fields nor expiresAt, which is why the
    // order comes back still free and still sweepable.
    expect(u.UpdateExpression).toBe('SET #s = :s, updatedAt = :u');
    // Asserted against the command undo actually produced, not against a
    // locally-built object: no money field and no expiresAt is even present in
    // the write, so the approve-time values checked above are still what stands.
    for (const k of [':t', ':ga', ':do', ':dt', ':cc', ':ea']) {
      expect(u.ExpressionAttributeValues).not.toHaveProperty(k);
    }
    expect(u.UpdateExpression).not.toContain('expiresAt');

    // The record as it therefore stands, back in PENDING — the staging fixture
    // for the edit below, built from approve's captured values.
    const back = { ...released, status: 'PENDING' };

    // ...and the customer can edit it again: the '#s = :pending' gate passes.
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: back })                    // Get(order)
      .mockResolvedValueOnce({ Item: { cafeStatus: 'OPEN' } })  // settings
      .mockResolvedValueOnce({ Item: codeRecord() })            // getPreorderCode
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const edit = await handleOrders(modifyEvent('p1', [{ menuItemId: 'latte', quantity: 3 }]));
    expect(edit.statusCode).toBe(200);

    const e = orderUpdate();
    expect(e.ConditionExpression).toBe('#s = :pending');
    expect(e.ExpressionAttributeValues[':t']).toBe(0);              // still free
    expect(e.ExpressionAttributeValues[':dt']).toBe('MINISTRY_PREORDER');
    expect(e.ExpressionAttributeValues[':items'][0].unitPrice).toBe(8); // full, as created
    // The edit must not touch expiresAt — the ISO string has to survive.
    expect(e.UpdateExpression).not.toContain('expiresAt');
  });
});

// ─── modifyOrder ─────────────────────────────────────────────────────

/**
 * `createOrder` enforced the three pre-order restrictions and `modifyOrder` did
 * not — it never loaded the link record, so the edit path was a straight bypass
 * of all three. That was harmless only because a pre-order could never be edited;
 * making them PENDING opens it. Both paths now share
 * `preorderItemRejection()` in orders.ts.
 *
 * `preorder-excluded-options.test.ts` pins the same rules on the CREATE path.
 */
describe('modifyOrder — a pre-order edit obeys the same link restrictions', () => {
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

  const COOKIE = {
    PK: 'MENU#cookie', SK: 'META', menuItemId: 'cookie', name: 'Cookie',
    category: 'FOOD', basePrice: 3, isActive: true, isEnabledToday: true,
    foodQuantityToday: 10, foodReserved: 0,
  };

  it('refuses FOOD, and writes nothing', async () => {
    stageEdit(preOrder(), codeRecord(), COOKIE);
    const res = await handleOrders(modifyEvent('p1', [{ menuItemId: 'cookie', quantity: 1 }]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/can only include drinks/i);
    expect(orderUpdates()).toHaveLength(0);
  });

  it('refuses a drink outside eligibleItems', async () => {
    stageEdit(preOrder(), codeRecord({ eligibleItems: ['mocha'] }), LATTE);
    const res = await handleOrders(modifyEvent('p1', [{ menuItemId: 'latte', quantity: 1 }]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not available on this pre-order link/i);
    expect(orderUpdates()).toHaveLength(0);
  });

  it('refuses an excludedOptions variant', async () => {
    stageEdit(preOrder(), codeRecord({ excludedOptions: ['Milk:Oat Milk'] }), LATTE);
    const res = await handleOrders(modifyEvent('p1', [{
      menuItemId: 'latte', quantity: 1,
      selectedVariants: [{ group: 'Milk', option: 'Oat Milk', price: 1 }],
    }]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Oat Milk is not available/i);
  });

  it('refuses an excluded option sent as a legacy single-variant string', async () => {
    stageEdit(preOrder(), codeRecord({ excludedOptions: ['Milk:Oat Milk'] }), LATTE);
    const res = await handleOrders(modifyEvent('p1', [{ menuItemId: 'latte', quantity: 1, variant: 'Oat Milk' }]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not available on this pre-order link/i);
  });

  it('still enforces drinks-only when the link record has been deleted (fail closed)', async () => {
    stageEdit(preOrder(), null, COOKIE);
    const res = await handleOrders(modifyEvent('p1', [{ menuItemId: 'cookie', quantity: 1 }]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/can only include drinks/i);
  });

  it('uses a plain lookup, so a closed ordering window does not block the edit', async () => {
    // validatePreorderCode would refuse this link on its opensAt/expiresAt
    // window. The editable window is the ORDER's PENDING status, not the link's.
    stageEdit(preOrder(), codeRecord({
      opensAt: '1999-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:00.000Z',
    }), LATTE);
    const res = await handleOrders(modifyEvent('p1', [{ menuItemId: 'latte', quantity: 1 }]));
    expect(res.statusCode).toBe(200);
  });

  it('a permitted edit stays free, keeps full item unitPrice, and moves no food counter', async () => {
    stageEdit(preOrder(), codeRecord(), LATTE);
    const res = await handleOrders(modifyEvent('p1', [{ menuItemId: 'latte', quantity: 3 }]));
    expect(res.statusCode).toBe(200);

    const v = orderUpdate().ExpressionAttributeValues;
    expect(v[':t']).toBe(0);
    expect(v[':ga']).toBe(24);
    expect(v[':do']).toBe(24);
    expect(v[':dt']).toBe('MINISTRY_PREORDER');
    expect(v[':items'][0].unitPrice).toBe(8);
    // Drinks-only on both paths ⇒ releaseFood and the re-reserve loop are
    // category-filtered no-ops, so foodReserved cannot be driven negative.
    expect(cmds().filter(c => c.__cmd === 'Update' && c.TableName === 'test-menu')).toHaveLength(0);
  });
});

// ─── notes prefix ────────────────────────────────────────────────────

/**
 * The pre-order collection time lives ONLY inside the `notes` string, as a
 * `[PRE-ORDER: <CODE>] Collect: <time>` prefix — there is no `collectionTime`
 * attribute on the order record. Losing it is unrecoverable: the café has to ring
 * the ministry back and ask.
 *
 * `modifyOrder` used to write `notes` verbatim from the request body, which made
 * preserving that prefix the CLIENT's responsibility. A stale cached PWA shell, a
 * replayed request or a future page that did not re-attach it would silently
 * delete the collection time. The backend owns it now.
 */
describe('modifyOrder — the pre-order notes prefix is backend-owned', () => {
  const PREFIX = '[PRE-ORDER: ABC123] Collect: After 1st Service';

  function stageEdit(order: any, code: any = codeRecord(), menu: any = LATTE) {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: order })
      .mockResolvedValueOnce({ Item: { cafeStatus: 'OPEN', celebrationMode: false } })
      .mockResolvedValueOnce({ Item: code })
      .mockResolvedValueOnce({ Item: menu })
      .mockResolvedValue({});
  }

  function editWithNotes(notes: string, order: any = preOrder({ notes: `${PREFIX} | less sugar` })) {
    stageEdit(order);
    return handleOrders({
      httpMethod: 'PUT', path: '/api/orders/p1',
      body: JSON.stringify({ action: 'update', items: [{ menuItemId: 'latte', quantity: 1 }], notes }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
  }

  function writtenNotes() { return orderUpdate().ExpressionAttributeValues[':n']; }

  it('does NOT double the prefix when the client re-attaches it', async () => {
    // What the current frontend does: strips the prefix for the edit box, then
    // re-attaches on save. Must round-trip to exactly one prefix.
    const res = await editWithNotes(`${PREFIX} | extra hot`);
    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX} | extra hot`);
    // Belt and braces: exactly one occurrence.
    expect(writtenNotes().match(/\[PRE-ORDER:/g)).toHaveLength(1);
  });

  it('keeps the collection time when the client sends notes WITHOUT it', async () => {
    // The data-loss path. A client that does not re-attach the prefix used to
    // wipe the collection time outright.
    const res = await editWithNotes('extra hot');
    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX} | extra hot`);
  });

  it('keeps the prefix when the client clears its notes entirely', async () => {
    const res = await editWithNotes('');
    expect(res.statusCode).toBe(200);
    // Prefix alone, no dangling separator.
    expect(writtenNotes()).toBe(PREFIX);
  });

  it('the client cannot forge a different code or collection time', async () => {
    const res = await editWithNotes('[PRE-ORDER: HACKED] Collect: Right Now | extra hot');
    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX} | extra hot`);
    expect(writtenNotes()).not.toContain('HACKED');
    expect(writtenNotes()).not.toContain('Right Now');
  });

  it('invents no prefix when the stored order never had one', async () => {
    // A pre-order placed with no collectionTime, or one predating the convention.
    const res = await editWithNotes('extra hot', preOrder({ notes: 'original note' }));
    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe('extra hot');
    expect(writtenNotes()).not.toContain('[PRE-ORDER:');
  });

  it('strips a forged prefix even when the stored order has none', async () => {
    // The client must never be able to CREATE a collection time either.
    const res = await editWithNotes('[PRE-ORDER: FAKE] Collect: Whenever | extra hot', preOrder({ notes: '' }));
    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe('extra hot');
  });

  it('preserves a customer note that itself contains the separator', async () => {
    const res = await editWithNotes('less ice | more syrup');
    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX} | less ice | more syrup`);
  });

  it('leaves a NON pre-order edit byte-for-byte unaffected', async () => {
    // NOTE: this passes even if the composition is wrongly applied to ordinary
    // orders, because stripping a prefix-free note is a no-op. The test below
    // ("looks like a prefix") is the one that actually pins the isPreOrder gate —
    // do not delete it as a duplicate of this one.
    const plain = {
      PK: 'ORDER#n1', SK: 'META', orderId: 'n1', customerName: 'Ah Beng', status: 'PENDING',
      items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, unitPrice: 8, grossUnitPrice: 8, category: 'DRINK' }],
      totalAmount: 8, notes: 'no sugar',
    };
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: plain })
      .mockResolvedValueOnce({ Item: { cafeStatus: 'OPEN', celebrationMode: false } })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders({
      httpMethod: 'PUT', path: '/api/orders/n1',
      body: JSON.stringify({ action: 'update', items: [{ menuItemId: 'latte', quantity: 1 }], notes: 'extra hot' }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(200);
    // Verbatim — no composition, no stripping, for an ordinary order.
    expect(writtenNotes()).toBe('extra hot');
  });

  it('a non-pre-order can still store text that merely looks like a prefix', async () => {
    // The composition is gated on isPreOrder, so an ordinary order is not
    // silently rewritten just because its note resembles the format.
    const plain = {
      PK: 'ORDER#n1', SK: 'META', orderId: 'n1', status: 'PENDING',
      items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, unitPrice: 8, grossUnitPrice: 8, category: 'DRINK' }],
      totalAmount: 8,
    };
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: plain })
      .mockResolvedValueOnce({ Item: { cafeStatus: 'OPEN', celebrationMode: false } })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders({
      httpMethod: 'PUT', path: '/api/orders/n1',
      body: JSON.stringify({
        action: 'update', items: [{ menuItemId: 'latte', quantity: 1 }],
        notes: '[PRE-ORDER: X] Collect: Y | hi',
      }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe('[PRE-ORDER: X] Collect: Y | hi');
  });

  it('measures the 200-char limit against the CUSTOMER portion, not the composed value', async () => {
    // The prefix is the café's text. Counting it would make an edit reject notes
    // that createOrder accepted — createOrder lets the COMPOSED value exceed 200.
    const res = await editWithNotes('x'.repeat(200));
    expect(res.statusCode).toBe(200);
    expect(writtenNotes().length).toBeGreaterThan(200);
    expect(writtenNotes()).toBe(`${PREFIX} | ${'x'.repeat(200)}`);
  });

  it('still rejects a customer portion over 200 chars', async () => {
    const res = await editWithNotes('x'.repeat(201));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('notes cannot exceed 200 characters');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('a client re-attaching the prefix does not consume the customer budget', async () => {
    // 200 chars of customer text PLUS the prefix the frontend re-attaches. If the
    // limit were applied to the raw body this would be a spurious 400.
    const res = await editWithNotes(`${PREFIX} | ${'x'.repeat(200)}`);
    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX} | ${'x'.repeat(200)}`);
  });

  it('an edit that omits notes entirely leaves the stored notes alone', async () => {
    stageEdit(preOrder({ notes: `${PREFIX} | less sugar` }));
    const res = await handleOrders({
      httpMethod: 'PUT', path: '/api/orders/p1',
      body: JSON.stringify({ action: 'update', items: [{ menuItemId: 'latte', quantity: 1 }] }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(200);
    // notes is absent from the UpdateExpression, so the stored value survives.
    expect(orderUpdate().UpdateExpression).not.toContain('notes');
    expect(orderUpdate().ExpressionAttributeValues[':n']).toBeUndefined();
  });
});

describe('createOrder — the notes prefix is unchanged by the refactor', () => {
  function createPreorder(body: Record<string, any>) {
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: { cafeStatus: 'CLOSED', celebrationMode: false } })
      .mockResolvedValueOnce({ Item: codeRecord() })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});
    return handleOrders({
      httpMethod: 'POST', path: '/api/orders',
      body: JSON.stringify({
        customerName: 'Grace', preorderCode: 'ABC123',
        items: [{ menuItemId: 'latte', quantity: 1 }], ...body,
      }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
  }
  function written() { return cmds().find(c => c.__cmd === 'Put' && c.TableName === 'test-orders').Item; }

  it('composes prefix + separator + customer note, exactly as before', async () => {
    await createPreorder({ collectionTime: 'After 1st Service', notes: 'less sugar' });
    expect(written().notes).toBe('[PRE-ORDER: ABC123] Collect: After 1st Service | less sugar');
  });

  it('omits the separator when there is no customer note', async () => {
    await createPreorder({ collectionTime: 'After 1st Service' });
    expect(written().notes).toBe('[PRE-ORDER: ABC123] Collect: After 1st Service');
  });

  it('writes no prefix when no collection time was chosen', async () => {
    await createPreorder({ notes: 'less sugar' });
    expect(written().notes).toBe('less sugar');
  });

  it('lets the COMPOSED value exceed 200 chars (create is not tightened)', async () => {
    await createPreorder({ collectionTime: 'After 1st Service', notes: 'x'.repeat(200) });
    expect(written().notes.length).toBeGreaterThan(200);
  });

  it('round-trips through the edit path unchanged', async () => {
    // The property that matters: what create writes, edit reproduces.
    await createPreorder({ collectionTime: 'After 1st Service', notes: 'less sugar' });
    const created = written().notes;

    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: preOrder({ notes: created }) })
      .mockResolvedValueOnce({ Item: { cafeStatus: 'OPEN', celebrationMode: false } })
      .mockResolvedValueOnce({ Item: codeRecord() })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders({
      httpMethod: 'PUT', path: '/api/orders/p1',
      body: JSON.stringify({ action: 'update', items: [{ menuItemId: 'latte', quantity: 1 }], notes: 'less sugar' }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(200);
    expect(orderUpdate().ExpressionAttributeValues[':n']).toBe(created);
  });
});

// ─── receipt upload ──────────────────────────────────────────────────

describe('receipt upload — refused on a pre-order', () => {
  it('rejects with 400 and never reaches S3 or Bedrock', async () => {
    // A pre-order is free, so there is no payment to evidence. This used to be
    // implicit: pre-orders were PREPARING and so failed the `status !== PENDING`
    // check. Now they ARE pending, and an extracted receiptAmount against a RM0
    // total makes the POS card show a permanent "⚠️ expected RM0.00" mismatch
    // badge (frontend/js/pos.js:694) for the rest of the service.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handleReceipt } = require('../src/routes/receipt');

    mockDbSend.mockReset();
    mockDbSend.mockResolvedValueOnce({ Item: preOrder() }).mockResolvedValue({});

    const res = await handleReceipt({
      httpMethod: 'POST', path: '/api/orders/p1/receipt',
      body: JSON.stringify({ image: 'aGVsbG8=' }),
      headers: { 'Content-Type': 'application/json' },
      queryStringParameters: null, pathParameters: null,
    } as any);

    expect(res.statusCode).toBe(400);
    // Minimal message, no internal detail.
    expect(JSON.parse(res.body).error).toBe('Pre-orders do not require payment');
    // Nothing was written to the order.
    expect(orderUpdates()).toHaveLength(0);
  });

  it('an ordinary PENDING order is unaffected by the guard', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handleReceipt } = require('../src/routes/receipt');

    mockDbSend.mockReset();
    mockDbSend.mockResolvedValueOnce({
      Item: { PK: 'ORDER#n1', SK: 'META', orderId: 'n1', status: 'PENDING', totalAmount: 8 },
    }).mockResolvedValue({});

    const res = await handleReceipt({
      httpMethod: 'POST', path: '/api/orders/n1/receipt',
      body: JSON.stringify({ image: 'aGVsbG8=' }),
      headers: { 'Content-Type': 'application/json' },
      queryStringParameters: null, pathParameters: null,
    } as any);

    // It gets PAST the pre-order guard. It then fails downstream (S3/Bedrock are
    // not mocked here), which is fine — the assertion is that the rejection is
    // NOT the pre-order one.
    expect(JSON.parse(res.body).error).not.toBe('Pre-orders do not require payment');
  });
});

// ─── closeCafe ───────────────────────────────────────────────────────

describe('closeCafe — pre-orders are not expired at end of day', () => {
  it('expires an ordinary PENDING order and skips the pre-order', async () => {
    // This query is unbounded by date. Pre-orders are placed days ahead, so
    // without the isPreOrder guard, closing the café once would EXPIRE every
    // outstanding pre-order for future services.
    mockDbSend
      .mockResolvedValueOnce({})                       // settings update
      .mockResolvedValueOnce({})                       // featured-audit put
      .mockResolvedValueOnce({ Items: [                // PENDING query
        { PK: 'ORDER#normal', SK: 'META', orderId: 'normal', status: 'PENDING', items: [] },
        { PK: 'ORDER#pre', SK: 'META', orderId: 'pre', status: 'PENDING', isPreOrder: true, items: [] },
      ] })
      .mockResolvedValue({});

    const res = await handlePos({
      httpMethod: 'PUT', path: '/api/pos/cafe/close',
      body: '{}', headers: {}, queryStringParameters: null, pathParameters: null,
    } as any, 'Sarah', 'ADMIN');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).expiredOrders).toBe(1);
    expect(expiryUpdates().map(u => u.Key.PK)).toEqual(['ORDER#normal']);
  });
});

// ─── Bulk release ────────────────────────────────────────────────────

/**
 * `PUT /api/pos/preorders/release-all` — cashier-triggered bulk release.
 *
 * Cashier-TRIGGERED only: there is deliberately no scheduled equivalent, because
 * an automatic release would close the customer's edit window behind their back.
 *
 * Two safety filters, each with its own harm:
 *   1. `isPreOrder === true` — the PENDING bucket is mostly ordinary UNPAID
 *      orders awaiting a payment check. Releasing those marks unpaid orders as
 *      paid and sends them to the barista.
 *   2. Service-end date is TODAY in MYT — a link can span services, so the
 *      PENDING set can hold orders for a LATER service date. Releasing those
 *      closes the edit window for customers who ordered for next week.
 *
 * Both share `releasePreOrderToPreparing` with the per-order approve path, so
 * "release four individually" and "release all four" cannot diverge.
 */
describe('releaseAllPreOrders — the bulk POS action', () => {
  const MYT_OFFSET = 8 * 60 * 60 * 1000;

  /** An ISO service-end instant whose MYT calendar date is `daysFromNow` away. */
  function serviceEndDaysAway(daysFromNow: number): string {
    const mytNow = new Date(Date.now() + MYT_OFFSET);
    const y = mytNow.getUTCFullYear();
    const m = mytNow.getUTCMonth();
    const d = mytNow.getUTCDate() + daysFromNow;
    // 15:00 MYT == 07:00 UTC on the same calendar date — the same rule as
    // computeServiceEndTime in preorder.ts.
    return new Date(Date.UTC(y, m, d, 7, 0, 0)).toISOString();
  }

  const releaseAllEvent = {
    httpMethod: 'PUT', path: '/api/pos/preorders/release-all',
    body: '{}', headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;

  /** Stage the unbounded PENDING query the bulk handler runs first. */
  function stagePending(items: any[]) {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValueOnce({ Items: items }).mockResolvedValue({});
  }

  function releaseUpdates() {
    return orderUpdates().filter(u => u.ExpressionAttributeValues?.[':s'] === 'PREPARING');
  }

  it('releases today\'s pre-orders and reports counts', async () => {
    stagePending([
      preOrder({ PK: 'ORDER#a', orderId: 'a', expiresAt: serviceEndDaysAway(0) }),
      preOrder({ PK: 'ORDER#b', orderId: 'b', expiresAt: serviceEndDaysAway(0) }),
    ]);

    const res = await handlePos(releaseAllEvent, 'Sarah');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ released: 2, skipped: 0, total: 2 });

    const updates = releaseUpdates();
    expect(updates.map(u => u.Key.PK).sort()).toEqual(['ORDER#a', 'ORDER#b']);
    for (const u of updates) {
      const v = u.ExpressionAttributeValues;
      // The PREORDER class is preserved, so the order stays free.
      expect(v[':t']).toBe(0);
      expect(v[':dt']).toBe('MINISTRY_PREORDER');
      expect(v[':cc']).toBe('PREORDER');
      expect(v[':ga']).toBe(16);
      expect(v[':do']).toBe(16);
      // Accountability: the acting cashier, on every order in the batch.
      expect(v[':a']).toBe('Sarah');
      // Guarded per order.
      expect(u.ConditionExpression).toBe('#s = :pending');
      // ISO expiresAt PRESERVED — it is inert as a TTL and is the only input to
      // expirePreOrders. Removing it here (while the single path keeps it) would
      // also make "release all" behave differently from "release each".
      expect(u.UpdateExpression).not.toContain('expiresAt');
    }
  });

  it('NEVER touches an unpaid non-pre-order PENDING order', async () => {
    // The filter-bug blast radius: mass-approving unpaid walk-in orders. The
    // ordinary order is staged with a service-end-shaped expiresAt for TODAY, so
    // removing the isPreOrder filter releases it rather than skipping it for the
    // unrelated reason of failing the date check.
    const unpaid = {
      PK: 'ORDER#walkin', SK: 'META', orderId: 'walkin', customerName: 'Ah Beng',
      status: 'PENDING',
      items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1, unitPrice: 8, grossUnitPrice: 8, category: 'DRINK' }],
      totalAmount: 8, grossAmount: 8, discountOffset: 0, discountType: 'NONE',
      expiresAt: serviceEndDaysAway(0),
    };
    stagePending([unpaid, preOrder({ expiresAt: serviceEndDaysAway(0) })]);

    const res = await handlePos(releaseAllEvent, 'Sarah');
    expect(JSON.parse(res.body)).toEqual({ released: 1, skipped: 0, total: 1 });

    // Only the pre-order moved. The unpaid order was not even considered part of
    // the batch, hence total 1.
    const updates = releaseUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].Key.PK).toBe('ORDER#p1');
    expect(updates.map(u => u.Key.PK)).not.toContain('ORDER#walkin');

    // Nothing at all was written against the walk-in order.
    expect(orderUpdates().filter(u => u.Key.PK === 'ORDER#walkin')).toHaveLength(0);
    // Its record is therefore untouched: still PENDING, still RM8, no approvedBy.
    expect(unpaid.status).toBe('PENDING');
    expect(unpaid.totalAmount).toBe(8);
    expect(unpaid.discountType).toBe('NONE');
    expect((unpaid as any).approvedBy).toBeUndefined();
  });

  it('leaves a pre-order for a LATER service date at PENDING', async () => {
    // A link can stay open across services. Releasing next Sunday's order today
    // closes that customer's edit window — the harm the user rejected when they
    // refused a time-based auto-release.
    stagePending([
      preOrder({ PK: 'ORDER#today', orderId: 'today', expiresAt: serviceEndDaysAway(0) }),
      preOrder({ PK: 'ORDER#next', orderId: 'next', expiresAt: serviceEndDaysAway(7) }),
    ]);

    const res = await handlePos(releaseAllEvent, 'Sarah');
    expect(JSON.parse(res.body)).toEqual({ released: 1, skipped: 1, total: 2 });

    const updates = releaseUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].Key.PK).toBe('ORDER#today');
  });

  it('skips a pre-order for a PAST service date too', async () => {
    // Not today either — it belongs to expirePreOrders, not to a release.
    stagePending([preOrder({ expiresAt: serviceEndDaysAway(-7) })]);
    const res = await handlePos(releaseAllEvent, 'Sarah');
    expect(JSON.parse(res.body)).toEqual({ released: 0, skipped: 1, total: 1 });
    expect(releaseUpdates()).toHaveLength(0);
  });

  it('skips — never guesses — a pre-order with no usable expiresAt', async () => {
    // Guessing here means releasing an order that might be for a future service.
    stagePending([
      preOrder({ PK: 'ORDER#none', orderId: 'none', expiresAt: undefined }),
      preOrder({ PK: 'ORDER#num', orderId: 'num', expiresAt: 1_800_000_000 }),
      preOrder({ PK: 'ORDER#junk', orderId: 'junk', expiresAt: 'not-a-date' }),
    ]);

    const res = await handlePos(releaseAllEvent, 'Sarah');
    expect(JSON.parse(res.body)).toEqual({ released: 0, skipped: 3, total: 3 });
    expect(releaseUpdates()).toHaveLength(0);
  });

  it('a per-order conflict skips that order and does not fail the batch', async () => {
    // The customer cancelled or edited mid-batch. The cashier must still get a
    // truthful tally rather than a 500 and an unknown partial result.
    //
    // The mock dispatches on the COMMAND SHAPE (`__cmd` + `Key.PK`), never on
    // call position. An earlier version chained mockImplementationOnce against
    // an exact call sequence that included the ingredient-recipe query, so any
    // change to the order of DB calls inside `releasePreOrderToPreparing` shifted
    // the conflict onto the wrong command and this test failed for a reason that
    // has nothing to do with conflict handling. Ingredient deduction has its own
    // test below; this one asserts conflict handling and nothing else.
    const conflict = Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockDbSend.mockReset();
      mockDbSend.mockImplementation(async (c: any) => {
        // The unbounded PENDING candidate query (one page, no cursor).
        if (c.__cmd === 'Query' && c.ExpressionAttributeValues?.[':s'] === 'PENDING') {
          return { Items: [
            preOrder({ PK: 'ORDER#ok1', orderId: 'ok1', expiresAt: serviceEndDaysAway(0) }),
            preOrder({ PK: 'ORDER#gone', orderId: 'gone', expiresAt: serviceEndDaysAway(0) }),
            preOrder({ PK: 'ORDER#ok2', orderId: 'ok2', expiresAt: serviceEndDaysAway(0) }),
          ] };
        }
        // The guarded release write for the order that moved under us.
        if (c.__cmd === 'Update' && c.Key?.PK === 'ORDER#gone') throw conflict;
        return {};
      });

      const res = await handlePos(releaseAllEvent, 'Sarah');
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ released: 2, skipped: 1, total: 3 });
      expect(body.released + body.skipped).toBe(body.total);

      // All three were attempted — the conflicting one is not filtered out
      // earlier, it genuinely loses its `#s = :pending` race.
      expect(releaseUpdates().map(u => u.Key.PK).sort()).toEqual(['ORDER#gone', 'ORDER#ok1', 'ORDER#ok2']);

      // "Skips that order" means its side effects are skipped too: the audit
      // line is written only after the guarded write succeeds, so a conflicted
      // order must leave no APPROVE trace claiming it was released.
      const approved = logSpy.mock.calls
        .map(c => String(c[0]))
        .filter(l => l.includes('[ORDER] APPROVE'));
      expect(approved).toHaveLength(2);
      expect(approved.some(l => l.includes('orderId=gone'))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('writes one audit line per order, not one per batch', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      stagePending([
        preOrder({ PK: 'ORDER#a', orderId: 'a', preorderCode: 'ABC123', expiresAt: serviceEndDaysAway(0) }),
        preOrder({ PK: 'ORDER#b', orderId: 'b', preorderCode: 'ABC123', expiresAt: serviceEndDaysAway(0) }),
      ]);
      await handlePos(releaseAllEvent, 'Sarah');

      const approveLines = logSpy.mock.calls
        .map(c => String(c[0]))
        .filter(l => l.includes('[ORDER] APPROVE'));
      expect(approveLines).toHaveLength(2);
      expect(approveLines[0]).toContain('orderId=a');
      expect(approveLines[1]).toContain('orderId=b');
      // preorderCode is in the audit trail, per order.
      for (const l of approveLines) expect(l).toContain('preorderCode=ABC123');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('deducts ingredients per released order, exactly like the single path', async () => {
    // Same helper for both, so this cannot diverge — the assertion is that the
    // recipe lookups happen at all from the bulk path.
    stagePending([preOrder({ expiresAt: serviceEndDaysAway(0) })]);
    await handlePos(releaseAllEvent, 'Sarah');

    const recipeQueries = cmds().filter(
      c => c.__cmd === 'Query' && String(c.ExpressionAttributeValues?.[':pk'] || '').startsWith('RECIPE#'),
    );
    expect(recipeQueries.length).toBeGreaterThan(0);
  });

  it('is a no-op with an empty queue', async () => {
    stagePending([]);
    const res = await handlePos(releaseAllEvent, 'Sarah');
    expect(JSON.parse(res.body)).toEqual({ released: 0, skipped: 0, total: 0 });
    expect(orderUpdates()).toHaveLength(0);
  });

  it('paginates, so a >1MB PENDING queue is not silently truncated', async () => {
    // Silent truncation in a MUTATING batch tells the cashier "released 1" and
    // leaves real pre-orders stranded in PENDING with the queue looking done.
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({
        Items: [preOrder({ PK: 'ORDER#page1', orderId: 'page1', expiresAt: serviceEndDaysAway(0) })],
        LastEvaluatedKey: { status: 'PENDING', createdAt: 'cursor' },
      })
      .mockResolvedValueOnce({
        Items: [preOrder({ PK: 'ORDER#page2', orderId: 'page2', expiresAt: serviceEndDaysAway(0) })],
      })
      .mockResolvedValue({});

    const res = await handlePos(releaseAllEvent, 'Sarah');
    expect(JSON.parse(res.body)).toEqual({ released: 2, skipped: 0, total: 2 });
    expect(releaseUpdates().map(u => u.Key.PK).sort()).toEqual(['ORDER#page1', 'ORDER#page2']);

    // The second page was requested with the cursor from the first.
    const pageTwo = cmds().filter(c => c.__cmd === 'Query' && c.ExpressionAttributeValues?.[':s'] === 'PENDING')[1];
    expect(pageTwo.ExclusiveStartKey).toEqual({ status: 'PENDING', createdAt: 'cursor' });
  });

  it('writes the SAME update as the per-order approve path (shared helper)', async () => {
    // The anti-divergence assertion. Releasing one order via the bulk route and
    // via PUT /api/pos/orders/{id}/approve must produce byte-identical writes,
    // because both go through releasePreOrderToPreparing. If someone
    // re-implements either side, this fails.
    const order = preOrder({ expiresAt: serviceEndDaysAway(0) });

    stagePending([order]);
    await handlePos(releaseAllEvent, 'Sarah');
    const bulk = releaseUpdates()[0];

    mockDbSend.mockReset();
    mockDbSend.mockResolvedValueOnce({ Item: order }).mockResolvedValue({});
    await handlePos(approveEvent('p1', { approvedBy: 'Sarah' }), 'Sarah');
    const single = releaseUpdates()[0];

    expect(bulk.UpdateExpression).toBe(single.UpdateExpression);
    expect(bulk.ConditionExpression).toBe(single.ConditionExpression);
    expect(bulk.ExpressionAttributeNames).toEqual(single.ExpressionAttributeNames);
    expect(bulk.Key).toEqual(single.Key);

    // Every value except the timestamp.
    const strip = (v: Record<string, any>) => { const { ':u': _u, ...rest } = v; return rest; };
    expect(strip(bulk.ExpressionAttributeValues)).toEqual(strip(single.ExpressionAttributeValues));
  });

  it('bulk release → undo one order leaves it PENDING, free, and still sweepable', async () => {
    stagePending([preOrder({ expiresAt: serviceEndDaysAway(0) })]);
    await handlePos(releaseAllEvent, 'Sarah');

    const released = releaseUpdates()[0].ExpressionAttributeValues;
    expect(released[':t']).toBe(0);
    expect(released[':dt']).toBe('MINISTRY_PREORDER');
    expect(released[':cc']).toBe('PREORDER');
    // Preserved, so the record still carries its ISO service-end time.
    expect(releaseUpdates()[0].UpdateExpression).not.toContain('expiresAt');

    // Undo the one order (swipe-left on the PREPARING card).
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
    const undo = await handlePos(undoEvent('p1'), 'Sarah');
    expect(undo.statusCode).toBe(200);
    expect(JSON.parse(undo.body).status).toBe('PENDING');
    // Undo writes only the status — no money fields, no expiresAt.
    expect(orderUpdate().UpdateExpression).toBe('SET #s = :s, updatedAt = :u');
    for (const k of [':t', ':ga', ':do', ':dt', ':cc', ':ea']) {
      expect(orderUpdate().ExpressionAttributeValues).not.toHaveProperty(k);
    }

    // So the record back in PENDING carries the release's own values (asserted
    // above) and still has an ISO expiresAt — staged here, past-due, to show
    // expirePreOrders can still reach it. Not immortal.
    const back = preOrder({
      status: 'PENDING',
      totalAmount: released[':t'],
      discountType: released[':dt'],
      customerClass: released[':cc'],
      expiresAt: PAST_END,
      approvedBy: 'Sarah',
    });

    stageExpiry([back]);
    await expiryHandler({} as any);
    const swept = expiryUpdates();
    expect(swept).toHaveLength(1);
    expect(swept[0].Key.PK).toBe('ORDER#p1');
    expect(swept[0].ExpressionAttributeValues[':prev']).toBe('PENDING');
  });
});

// ─── expirePreOrders ─────────────────────────────────────────────────

/**
 * Stage `handler()` up to expirePreOrders' first query:
 *   1. Query — PENDING candidates for the 1-hour sweep
 *   2. Get   — settings (autoArchiveReadyOrders)
 *   3. Query — READY orders (autoArchiveReadyOrders)
 *   4. Query — expirePreOrders, status PENDING     ← the rows under test
 * Everything after falls through to the `{}` default, which yields no rows.
 */
function stageExpiry(pendingPreOrders: any[]) {
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
  mockDbSend
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Item: { archiveAfterMinutes: 15 } })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Items: pendingPreOrders });
}

describe('expirePreOrders — PENDING is swept', () => {
  it('expires a PENDING pre-order past its ISO service end, and only that one', async () => {
    // Without PENDING in the status list nothing expires a PENDING pre-order:
    // the 1-hour sweep skips all pre-orders and closeCafe now skips them too.
    stageExpiry([
      { PK: 'ORDER#past', SK: 'META', orderId: 'past', status: 'PENDING', isPreOrder: true, expiresAt: PAST_END },
      { PK: 'ORDER#future', SK: 'META', orderId: 'future', status: 'PENDING', isPreOrder: true, expiresAt: FUTURE_END },
      { PK: 'ORDER#normal', SK: 'META', orderId: 'normal', status: 'PENDING', expiresAt: 1_800_000_000 },
    ]);

    await expiryHandler({} as any);

    const expired = expiryUpdates();
    expect(expired).toHaveLength(1);
    expect(expired[0].Key.PK).toBe('ORDER#past');
    expect(expired[0].ExpressionAttributeValues[':prev']).toBe('PENDING');
    expect(expired[0].ConditionExpression).toBe('#s = :prev');
    // EXPIRED is terminal, so the attribute goes.
    expect(expired[0].UpdateExpression).toContain('REMOVE expiresAt');
  });

  it('expires nothing for a bare PENDING order with no pre-order fields at all', async () => {
    // Deliberately narrow: this order carries neither `isPreOrder` NOR a
    // `preorderCode`, so it is unreachable by this sweep on two independent
    // counts and cannot pin either one. It only says the sweep does not expire a
    // row it has nothing to work from — the `isPreOrder` gate itself is pinned by
    // 'never touches a NON pre-order, even one carrying a resolvable
    // preorderCode' below, which stages a resolvable PAST serviceEndTime.
    stageExpiry([
      { PK: 'ORDER#normal', SK: 'META', orderId: 'normal', status: 'PENDING', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await expiryHandler({} as any);
    expect(expiryUpdates()).toHaveLength(0);
  });
});

describe('expirePreOrders — recovering an order that lost its expiresAt', () => {
  /**
   * `undoToPending` writes only `#s` and `updatedAt`, so it cannot restore a
   * missing attribute; and a pre-order with no usable (string) `expiresAt` is
   * skipped by this sweep AND by the 1-hour sweep, i.e. immortal. The repair is
   * here rather than in the hot swipe path so it self-heals however the field
   * was lost.
   */
  it('resolves serviceEndTime from the link record and EXPIRES a past-due order with no expiresAt', async () => {
    stageExpiry([
      { PK: 'ORDER#lost', SK: 'META', orderId: 'lost', status: 'PENDING', isPreOrder: true, preorderCode: 'ABC123' },
    ]);
    // getPreorderCode → link record whose service end has passed.
    mockDbSend.mockResolvedValueOnce({ Item: codeRecord({ serviceEndTime: PAST_END }) });

    await expiryHandler({} as any);

    const expired = expiryUpdates();
    expect(expired).toHaveLength(1);
    expect(expired[0].Key.PK).toBe('ORDER#lost');
    expect(expired[0].ExpressionAttributeValues[':prev']).toBe('PENDING');

    // The lookup went to the PREORDER_CODE# key on the settings table.
    const lookup = cmds().find(c => c.__cmd === 'Get' && String(c.Key?.PK || '').startsWith('PREORDER_CODE#'));
    expect(lookup.Key).toEqual({ PK: 'PREORDER_CODE#ABC123', SK: 'META' });
    expect(lookup.TableName).toBe('test-settings');
  });

  it('backfills the ISO expiresAt (never numeric) when the service end is still future', async () => {
    stageExpiry([
      { PK: 'ORDER#lost', SK: 'META', orderId: 'lost', status: 'PENDING', isPreOrder: true, preorderCode: 'ABC123' },
    ]);
    mockDbSend.mockResolvedValueOnce({ Item: codeRecord({ serviceEndTime: FUTURE_END }) });

    await expiryHandler({} as any);

    // Not due — must NOT be expired.
    expect(expiryUpdates()).toHaveLength(0);

    const backfill = orderUpdates().find(u => u.ExpressionAttributeValues?.[':ea'] !== undefined);
    expect(backfill).toBeDefined();
    expect(backfill.Key.PK).toBe('ORDER#lost');
    expect(backfill.ExpressionAttributeValues[':ea']).toBe(FUTURE_END);
    // ISO STRING. A number here would arm a live DynamoDB TTL on an order that
    // is meant to survive until Sunday.
    expect(typeof backfill.ExpressionAttributeValues[':ea']).toBe('string');
    // Guarded, so a concurrent approve/cancel wins the race.
    expect(backfill.ConditionExpression).toBe('#s = :prev');
    expect(backfill.ExpressionAttributeValues[':prev']).toBe('PENDING');
  });

  it('overwrites a stray NUMERIC expiresAt with the ISO string, disarming the TTL', async () => {
    // A numeric value on a pre-order is a live TTL that would delete the row.
    // It also reads as "no usable cutoff", so it lands on the recovery branch.
    stageExpiry([
      { PK: 'ORDER#numeric', SK: 'META', orderId: 'numeric', status: 'PENDING', isPreOrder: true, preorderCode: 'ABC123', expiresAt: 1_800_000_000 },
    ]);
    mockDbSend.mockResolvedValueOnce({ Item: codeRecord({ serviceEndTime: FUTURE_END }) });

    await expiryHandler({} as any);

    const backfill = orderUpdates().find(u => u.ExpressionAttributeValues?.[':ea'] !== undefined);
    expect(backfill).toBeDefined();
    expect(backfill.ExpressionAttributeValues[':ea']).toBe(FUTURE_END);
  });

  it('skips (does not guess a cutoff) when the link record is gone', async () => {
    stageExpiry([
      { PK: 'ORDER#orphan', SK: 'META', orderId: 'orphan', status: 'PENDING', isPreOrder: true, preorderCode: 'GONE' },
    ]);
    mockDbSend.mockResolvedValueOnce({});   // getPreorderCode → null

    await expiryHandler({} as any);

    expect(expiryUpdates()).toHaveLength(0);
    expect(orderUpdates().find(u => u.ExpressionAttributeValues?.[':ea'] !== undefined)).toBeUndefined();
  });

  it('skips when the link record carries no serviceEndTime', async () => {
    stageExpiry([
      { PK: 'ORDER#nosvc', SK: 'META', orderId: 'nosvc', status: 'PENDING', isPreOrder: true, preorderCode: 'ABC123' },
    ]);
    mockDbSend.mockResolvedValueOnce({ Item: codeRecord({ serviceEndTime: undefined }) });

    await expiryHandler({} as any);
    expect(expiryUpdates()).toHaveLength(0);
  });

  it('skips when the order carries no preorderCode at all', async () => {
    stageExpiry([
      { PK: 'ORDER#nocode', SK: 'META', orderId: 'nocode', status: 'PENDING', isPreOrder: true },
    ]);
    await expiryHandler({} as any);
    expect(expiryUpdates()).toHaveLength(0);
  });

  it('never touches a NON pre-order, even one carrying a resolvable preorderCode', async () => {
    // The recovery path is gated on isPreOrder — an ordinary order belongs to the
    // date-bounded 1-hour sweep. A PAST serviceEndTime is staged deliberately:
    // drop the isPreOrder gate and this order gets EXPIRED by the wrong sweep,
    // which is exactly the mutation this test exists to catch.
    stageExpiry([
      { PK: 'ORDER#plain', SK: 'META', orderId: 'plain', status: 'PENDING', preorderCode: 'ABC123' },
    ]);
    mockDbSend.mockResolvedValueOnce({ Item: codeRecord({ serviceEndTime: PAST_END }) });

    await expiryHandler({} as any);
    expect(expiryUpdates()).toHaveLength(0);
    expect(orderUpdates()).toHaveLength(0);
    // The gate short-circuits before any lookup, so no code record is even read.
    expect(cmds().find(c => c.__cmd === 'Get' && String(c.Key?.PK || '').startsWith('PREORDER_CODE#'))).toBeUndefined();
  });
});

// ─── getShiftSummary ─────────────────────────────────────────────────

describe('getShiftSummary — a pre-order created before today is still visible', () => {
  it('includes an out-of-range PENDING pre-order but not a stale ordinary PENDING', async () => {
    // Bucket 1 is bounded by `createdAt >= today` and bucket 2 is PREPARING/READY,
    // so a Wednesday pre-order for Sunday fell through both once pre-orders
    // stopped being created PREPARING.
    mockDbSend
      .mockResolvedValueOnce({ Items: [] })   // PENDING, today
      .mockResolvedValueOnce({ Items: [] })   // ARCHIVED, today
      .mockResolvedValueOnce({ Items: [] })   // PREPARING
      .mockResolvedValueOnce({ Items: [] })   // READY
      .mockResolvedValueOnce({ Items: [      // unbounded PENDING
        { orderId: 'pre', status: 'PENDING', isPreOrder: true, createdAt: '2026-08-12T01:00:00.000Z', items: [{ name: 'Latte', quantity: 1 }], totalAmount: 0 },
        { orderId: 'stale', status: 'PENDING', createdAt: '2026-08-12T01:00:00.000Z', items: [], totalAmount: 9 },
      ] })
      .mockResolvedValue({});

    const res = await handlePos({
      httpMethod: 'GET', path: '/api/pos/shift-summary',
      body: null, headers: {}, queryStringParameters: null, pathParameters: null,
    } as any, 'Sarah', 'ADMIN');
    expect(res.statusCode).toBe(200);

    const b = JSON.parse(res.body);
    expect(b.totalOrders).toBe(1);      // the pre-order only
    expect(b.pendingOrders).toBe(1);
    expect(b.totalRevenue).toBe(0);     // pre-orders are RM0 net
  });
});
