/**
 * Per-item special requests (`item.note`) — `backend/src/routes/orders.ts`.
 *
 * `notes` has always been a single per-ORDER string, so a customer ordering
 * three drinks had no way to say "less sugar" about one cup. Each entry of
 * `items` may now carry its own `note`, capped at `ITEM_NOTE_MAX_LENGTH` (80) and
 * validated by ONE helper shared by `createOrder` and `modifyOrder` — the
 * create/edit parity rule, which exists because `modifyOrder` once enforced none
 * of the restrictions `createOrder` did and was a straight bypass of all of them.
 *
 * Fully offline: `docClient` is mocked, nothing is read or written for real, so
 * this suite needs no credentials and no `ZZTEST_` marker (it creates no
 * production record at all — the only `PutCommand` in it is a mock call object
 * that is asserted on and thrown away).
 *
 * Style mirrors `preorder-pending.test.ts` / `preorder-pending-gaps.test.ts`.
 * Every assertion is on what the HANDLER produced — the `Item` of the
 * `PutCommand` it issued, or the `ExpressionAttributeValues` of its
 * `UpdateCommand` — never on the fixture object the test itself built.
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
const { handleOrders, validateItemNote, ITEM_NOTE_MAX_LENGTH } = require('../src/routes/orders');

// ─── Fixtures ────────────────────────────────────────────────────────

const LATTE = {
  PK: 'MENU#latte', SK: 'META', menuItemId: 'latte', name: 'Latte',
  category: 'DRINK', basePrice: 8, isActive: true, isEnabledToday: true,
};

const MOCHA = {
  PK: 'MENU#mocha', SK: 'META', menuItemId: 'mocha', name: 'Mocha',
  category: 'DRINK', basePrice: 9, isActive: true, isEnabledToday: true,
};

const COOKIE = {
  PK: 'MENU#cookie', SK: 'META', menuItemId: 'cookie', name: 'Cookie',
  category: 'FOOD', basePrice: 3, isActive: true, isEnabledToday: true,
  foodQuantityToday: 10, foodReserved: 0,
};

const OPEN_SETTINGS = { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN', celebrationMode: false };

/** A PENDING ordinary customer order, editable via `PUT /api/orders/{id}`. */
function plainOrder(overrides: Record<string, any> = {}) {
  return {
    PK: 'ORDER#n1', SK: 'META', orderId: 'n1', customerName: 'Ah Beng',
    status: 'PENDING', isPreOrder: false,
    items: [{
      menuItemId: 'latte', name: 'Latte', variant: null, quantity: 1,
      unitPrice: 8, grossUnitPrice: 8, category: 'DRINK',
    }],
    totalAmount: 8, grossAmount: 8, discountOffset: 0, discountType: 'NONE',
    notes: '',
    expiresAt: 1_800_000_000,
    ...overrides,
  };
}

/**
 * Answer every DynamoDB read from a described world, keyed on the actual
 * `TableName` + `Key.PK` the handler asked for.
 *
 * Deliberately a dispatcher rather than a `mockResolvedValueOnce` queue: a queue
 * lets a fixture silently fill the WRONG read slot (the trap named under **Test
 * teeth** in the `invariants` skill), and the read-count assertions below would
 * be meaningless if reads were not distinguishable. Writes fall through to `{}`
 * and are asserted on via `cmds()`.
 */
function stage(world: {
  settings?: any;
  menu?: Record<string, any>;
  orders?: Record<string, any>;
}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd !== 'Get') return {};
    const pk = String(cmd.Key?.PK || '');
    if (cmd.TableName === 'test-settings' && pk === 'SETTINGS') {
      return { Item: world.settings === undefined ? OPEN_SETTINGS : world.settings };
    }
    if (cmd.TableName === 'test-menu') {
      const rec = world.menu?.[pk.replace('MENU#', '')];
      return rec ? { Item: rec } : {};
    }
    if (cmd.TableName === 'test-orders') {
      const rec = world.orders?.[pk.replace('ORDER#', '')];
      return rec ? { Item: rec } : {};
    }
    return {};
  });
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function orderPuts() { return cmds().filter((c) => c.__cmd === 'Put' && c.TableName === 'test-orders'); }
function orderUpdates() { return cmds().filter((c) => c.__cmd === 'Update' && c.TableName === 'test-orders'); }
function menuUpdates() { return cmds().filter((c) => c.__cmd === 'Update' && c.TableName === 'test-menu'); }

/** The `items` array the handler actually wrote on create. */
function writtenItemsOnCreate() { return orderPuts()[0].Item.items; }
/** The `:items` value the handler actually wrote on edit. */
function writtenItemsOnEdit() { return orderUpdates()[0].ExpressionAttributeValues[':items']; }

function createEvent(body: Record<string, any>) {
  return {
    httpMethod: 'POST', path: '/api/orders',
    body: JSON.stringify(body),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

function editEvent(id: string, body: Record<string, any>) {
  return {
    httpMethod: 'PUT', path: `/api/orders/${id}`,
    body: JSON.stringify({ action: 'update', ...body }),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

const ALL_MENU = { latte: LATTE, mocha: MOCHA, cookie: COOKIE };

beforeEach(() => { mockDbSend.mockReset(); });

// ─── The helper, as a specification ──────────────────────────────────

describe('validateItemNote — the shared rule', () => {
  it('caps at 80 characters', () => {
    // Pinned as a named export so the frontend `maxlength` and the barista card
    // layout have one number to agree with.
    expect(ITEM_NOTE_MAX_LENGTH).toBe(80);
  });

  it('treats absent as no note rather than as an error', () => {
    expect(validateItemNote(undefined)).toEqual({ note: '' });
    expect(validateItemNote(null)).toEqual({ note: '' });
  });

  it('collapses a whitespace-only note to no note', () => {
    expect(validateItemNote('   \n\t ')).toEqual({ note: '' });
  });

  it('trims, and measures the cap on the TRIMMED value', () => {
    expect(validateItemNote('  less sugar  ')).toEqual({ note: 'less sugar' });
    // Trailing whitespace from a textarea must not push a legal note over.
    expect(validateItemNote(`${'x'.repeat(80)}   `)).toEqual({ note: 'x'.repeat(80) });
  });

  it('accepts exactly 80 and rejects 81', () => {
    expect(validateItemNote('x'.repeat(80))).toEqual({ note: 'x'.repeat(80) });
    expect(validateItemNote('x'.repeat(81)))
      .toEqual({ error: 'Item note cannot exceed 80 characters' });
  });

  it('rejects a non-string', () => {
    expect(validateItemNote(42)).toEqual({ error: 'Item note must be a string' });
    expect(validateItemNote({ note: 'x' })).toEqual({ error: 'Item note must be a string' });
    expect(validateItemNote(['x'])).toEqual({ error: 'Item note must be a string' });
  });
});

// ─── 1. Round trip through create ────────────────────────────────────

describe('createOrder stores a per-item note', () => {
  it('writes the note on the item that carried it and on no other', async () => {
    stage({ menu: ALL_MENU });

    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [
        { menuItemId: 'latte', quantity: 1, note: '  less sugar  ' },
        { menuItemId: 'mocha', quantity: 1 },
      ],
    }));
    expect(res.statusCode).toBe(201);

    const items = writtenItemsOnCreate();
    expect(items).toHaveLength(2);
    // Trimmed on the way in.
    expect(items[0].note).toBe('less sugar');
    // An item with no note keeps the exact shape it had before this feature —
    // the key is ABSENT, not `''`. That is what makes a record with no item
    // notes byte-identical to what shipped before, so nothing needs backfilling.
    expect(items[1]).not.toHaveProperty('note');
    // The note rides alongside the priced fields, it does not replace them.
    expect(items[0].menuItemId).toBe('latte');
    expect(items[0].unitPrice).toBe(8);
    expect(items[0].grossUnitPrice).toBe(8);
  });

  it('stores a whitespace-only note as absent, not as an empty string', async () => {
    stage({ menu: ALL_MENU });

    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [{ menuItemId: 'latte', quantity: 1, note: '    ' }],
    }));
    expect(res.statusCode).toBe(201);

    const item = writtenItemsOnCreate()[0];
    expect(item).not.toHaveProperty('note');
    expect(Object.keys(item)).not.toContain('note');
  });

  it('carries a note on a pre-order item too', async () => {
    // Pre-order items go through a SECOND `priceLine(..., null)` call and a
    // different `toOrderItem` branch, so the note has to be attached there as
    // well — an easy branch to miss.
    const code = {
      PK: 'PREORDER_CODE#ABC123', SK: 'META', code: 'ABC123', name: 'Music team',
      opensAt: '2000-01-01T00:00:00.000Z', expiresAt: '2099-12-31T00:00:00.000Z',
      serviceDate: '2099-12-25', serviceEndTime: '2099-12-25T07:00:00.000Z',
      isActive: true, eligibleItems: [], collectionOptions: ['After 1st Service'],
    };
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: OPEN_SETTINGS })
      .mockResolvedValueOnce({ Item: code })
      .mockResolvedValueOnce({ Item: LATTE })
      .mockResolvedValue({});

    const res = await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'ABC123',
      collectionTime: 'After 1st Service',
      items: [{ menuItemId: 'latte', quantity: 2, note: 'one decaf please' }],
    }));
    expect(res.statusCode).toBe(201);

    const items = writtenItemsOnCreate();
    expect(items[0].note).toBe('one decaf please');
    // …and the pre-order shape is unchanged: FULL item unitPrice, free at order
    // level.
    expect(items[0].unitPrice).toBe(8);
    expect(orderPuts()[0].Item.totalAmount).toBe(0);
  });
});

// ─── 2. Round trip through edit ──────────────────────────────────────

describe('modifyOrder stores a per-item note', () => {
  it('writes the note into the :items value of the UpdateCommand', async () => {
    stage({ menu: ALL_MENU, orders: { n1: plainOrder() } });

    const res = await handleOrders(editEvent('n1', {
      items: [
        { menuItemId: 'latte', quantity: 1, note: ' extra hot ' },
        { menuItemId: 'mocha', quantity: 1 },
      ],
    }));
    expect(res.statusCode).toBe(200);

    const items = writtenItemsOnEdit();
    expect(items).toHaveLength(2);
    expect(items[0].note).toBe('extra hot');
    expect(items[1]).not.toHaveProperty('note');
  });

  it('drops a note the customer cleared on an edit', async () => {
    // The stored record already has a note; the edit sends the line with none.
    // `items` is overwritten wholesale, so the absent key is the removal — there
    // is no separate "clear the note" path to get wrong.
    stage({
      menu: ALL_MENU,
      orders: {
        n1: plainOrder({
          items: [{
            menuItemId: 'latte', name: 'Latte', variant: null, quantity: 1,
            unitPrice: 8, grossUnitPrice: 8, category: 'DRINK', note: 'less sugar',
          }],
        }),
      },
    });

    const res = await handleOrders(editEvent('n1', {
      items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    expect(res.statusCode).toBe(200);
    expect(writtenItemsOnEdit()[0]).not.toHaveProperty('note');
  });

  it('stores a whitespace-only note as absent on the edit path too', async () => {
    stage({ menu: ALL_MENU, orders: { n1: plainOrder() } });

    const res = await handleOrders(editEvent('n1', {
      items: [{ menuItemId: 'latte', quantity: 1, note: ' \t ' }],
    }));
    expect(res.statusCode).toBe(200);
    expect(writtenItemsOnEdit()[0]).not.toHaveProperty('note');
  });
});

// ─── 3. Length validation, BOTH paths ────────────────────────────────

describe('the 80-character cap is enforced on create AND edit (parity)', () => {
  const AT_CAP = 'a'.repeat(80);
  const OVER_CAP = 'a'.repeat(81);

  it('create accepts exactly 80 characters', async () => {
    stage({ menu: ALL_MENU });
    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [{ menuItemId: 'latte', quantity: 1, note: AT_CAP }],
    }));
    expect(res.statusCode).toBe(201);
    expect(writtenItemsOnCreate()[0].note).toBe(AT_CAP);
  });

  it('create rejects 81 characters with 400 and writes nothing', async () => {
    stage({ menu: ALL_MENU });
    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [{ menuItemId: 'latte', quantity: 1, note: OVER_CAP }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Item note cannot exceed 80 characters');
    expect(orderPuts()).toHaveLength(0);
  });

  it('create rejects a non-string note with 400', async () => {
    stage({ menu: ALL_MENU });
    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [{ menuItemId: 'latte', quantity: 1, note: { evil: true } }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Item note must be a string');
    expect(orderPuts()).toHaveLength(0);
  });

  it('edit accepts exactly 80 characters', async () => {
    stage({ menu: ALL_MENU, orders: { n1: plainOrder() } });
    const res = await handleOrders(editEvent('n1', {
      items: [{ menuItemId: 'latte', quantity: 1, note: AT_CAP }],
    }));
    expect(res.statusCode).toBe(200);
    expect(writtenItemsOnEdit()[0].note).toBe(AT_CAP);
  });

  it('edit rejects 81 characters with 400 and writes nothing', async () => {
    stage({ menu: ALL_MENU, orders: { n1: plainOrder() } });
    const res = await handleOrders(editEvent('n1', {
      items: [{ menuItemId: 'latte', quantity: 1, note: OVER_CAP }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Item note cannot exceed 80 characters');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('edit rejects a non-string note with 400', async () => {
    stage({ menu: ALL_MENU, orders: { n1: plainOrder() } });
    const res = await handleOrders(editEvent('n1', {
      items: [{ menuItemId: 'latte', quantity: 1, note: 7 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Item note must be a string');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('rejects with the SAME message on both paths', async () => {
    // Divergent messages are how the two copies of a rule are discovered to have
    // drifted — after the fact, from a support call.
    stage({ menu: ALL_MENU });
    const onCreate = JSON.parse((await handleOrders(createEvent({
      customerName: 'Ah Beng', items: [{ menuItemId: 'latte', quantity: 1, note: OVER_CAP }],
    }))).body).error;

    stage({ menu: ALL_MENU, orders: { n1: plainOrder() } });
    const onEdit = JSON.parse((await handleOrders(editEvent('n1', {
      items: [{ menuItemId: 'latte', quantity: 1, note: OVER_CAP }],
    }))).body).error;

    expect(onEdit).toBe(onCreate);
  });
});

// ─── 4. A rejected note leaves no write behind ───────────────────────

/**
 * This is the property that makes the "validate everything before any write"
 * ordering real, rather than an accident of where the lines happen to sit.
 *
 * On create the note is validated inside the item loop, which runs entirely
 * before the `foodReserved` reservation loop and the `PutCommand`. On edit it is
 * validated before the `UpdateCommand` and before the `releaseFood` /
 * re-reserve pair. Move either validation after its writes and a 400 leaves the
 * food counters permanently drifted for an order that does not exist.
 */
describe('a rejected note leaves no half-applied write', () => {
  it('create: foodReserved is not moved and no order is Put', async () => {
    stage({ menu: ALL_MENU });

    // FOOD first, with a legal note, so the reservation for it is genuinely
    // pending when the second item is refused. A fixture with no FOOD line
    // could not tell a correct ordering from a broken one.
    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [
        { menuItemId: 'cookie', quantity: 2, note: 'warm please' },
        { menuItemId: 'latte', quantity: 1, note: 'a'.repeat(81) },
      ],
    }));

    expect(res.statusCode).toBe(400);
    expect(menuUpdates()).toHaveLength(0);
    expect(orderPuts()).toHaveLength(0);
    expect(orderUpdates()).toHaveLength(0);
  });

  it('create: the control case DOES move foodReserved, so the assertion above has teeth', async () => {
    // Without this, "no menu Update" could be true for an unrelated reason.
    stage({ menu: ALL_MENU });

    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [
        { menuItemId: 'cookie', quantity: 2, note: 'warm please' },
        { menuItemId: 'latte', quantity: 1, note: 'a'.repeat(80) },
      ],
    }));

    expect(res.statusCode).toBe(201);
    const reserve = menuUpdates();
    expect(reserve).toHaveLength(1);
    expect(reserve[0].Key).toEqual({ PK: 'MENU#cookie', SK: 'META' });
    expect(reserve[0].UpdateExpression).toBe('SET foodReserved = foodReserved + :q');
    expect(reserve[0].ExpressionAttributeValues).toEqual({ ':q': 2 });
  });

  it('edit: no order Update and no foodReserved movement', async () => {
    stage({
      menu: ALL_MENU,
      orders: {
        n1: plainOrder({
          items: [{
            menuItemId: 'cookie', name: 'Cookie', variant: null, quantity: 1,
            unitPrice: 3, grossUnitPrice: 3, category: 'FOOD',
          }],
          totalAmount: 3, grossAmount: 3,
        }),
      },
    });

    const res = await handleOrders(editEvent('n1', {
      items: [
        { menuItemId: 'cookie', quantity: 2 },
        { menuItemId: 'latte', quantity: 1, note: 'a'.repeat(81) },
      ],
    }));

    expect(res.statusCode).toBe(400);
    expect(orderUpdates()).toHaveLength(0);
    // Neither the release of the OLD reservation nor the reserve of the new one.
    expect(menuUpdates()).toHaveLength(0);
  });

  it('edit: the control case DOES move foodReserved both ways', async () => {
    stage({
      menu: ALL_MENU,
      orders: {
        n1: plainOrder({
          items: [{
            menuItemId: 'cookie', name: 'Cookie', variant: null, quantity: 1,
            unitPrice: 3, grossUnitPrice: 3, category: 'FOOD',
          }],
          totalAmount: 3, grossAmount: 3,
        }),
      },
    });

    const res = await handleOrders(editEvent('n1', {
      items: [
        { menuItemId: 'cookie', quantity: 2 },
        { menuItemId: 'latte', quantity: 1, note: 'a'.repeat(80) },
      ],
    }));

    expect(res.statusCode).toBe(200);
    const moves = menuUpdates();
    // release the old 1, reserve the new 2 — no clamping, per the food-counter
    // accounting table.
    expect(moves.map((m) => [m.Key.PK, m.UpdateExpression, m.ExpressionAttributeValues[':q']]))
      .toEqual([
        ['MENU#cookie', 'SET foodReserved = foodReserved - :q', 1],
        ['MENU#cookie', 'SET foodReserved = foodReserved + :q', 2],
      ]);
  });
});

// ─── 5. A note is not a price ────────────────────────────────────────

/**
 * A note must never reach `priceLine`, `summarizeOrderDiscount`, `totalAmount`,
 * `grossAmount` or `discountOffset`. `pricing.ts` is the single source of truth
 * for money and knows nothing about notes; `withItemNote` attaches the note
 * outside it, deliberately.
 */
describe('a note does not affect price', () => {
  const ITEMS_PLAIN = [
    { menuItemId: 'latte', quantity: 2 },
    { menuItemId: 'cookie', quantity: 1 },
  ];
  const ITEMS_NOTED = [
    { menuItemId: 'latte', quantity: 2, note: 'one with oat, one without' },
    { menuItemId: 'cookie', quantity: 1, note: 'warm' },
  ];

  it('create: identical order money and identical per-item prices', async () => {
    stage({ menu: ALL_MENU });
    await handleOrders(createEvent({ customerName: 'Ah Beng', items: ITEMS_PLAIN }));
    const plain = orderPuts()[0].Item;

    stage({ menu: ALL_MENU });
    await handleOrders(createEvent({ customerName: 'Ah Beng', items: ITEMS_NOTED }));
    const noted = orderPuts()[0].Item;

    expect(noted.totalAmount).toBe(plain.totalAmount);
    expect(noted.grossAmount).toBe(plain.grossAmount);
    expect(noted.discountOffset).toBe(plain.discountOffset);
    expect(noted.discountType).toBe(plain.discountType);
    // 2×8 + 1×3
    expect(plain.totalAmount).toBe(19);

    expect(noted.items.map((i: any) => [i.menuItemId, i.unitPrice, i.grossUnitPrice, i.quantity]))
      .toEqual(plain.items.map((i: any) => [i.menuItemId, i.unitPrice, i.grossUnitPrice, i.quantity]));

    // The ONLY difference between the two written records is the note key.
    expect(noted.items.map((i: any) => i.note)).toEqual(['one with oat, one without', 'warm']);
    expect(plain.items.every((i: any) => !('note' in i))).toBe(true);
  });

  it('edit: identical :t / :ga / :do and identical per-item prices', async () => {
    stage({ menu: ALL_MENU, orders: { n1: plainOrder() } });
    await handleOrders(editEvent('n1', { items: ITEMS_PLAIN }));
    const plain = orderUpdates()[0].ExpressionAttributeValues;

    stage({ menu: ALL_MENU, orders: { n1: plainOrder() } });
    await handleOrders(editEvent('n1', { items: ITEMS_NOTED }));
    const noted = orderUpdates()[0].ExpressionAttributeValues;

    expect(noted[':t']).toBe(plain[':t']);
    expect(noted[':ga']).toBe(plain[':ga']);
    expect(noted[':do']).toBe(plain[':do']);
    expect(noted[':dt']).toBe(plain[':dt']);
    expect(plain[':t']).toBe(19);

    expect(noted[':items'].map((i: any) => [i.unitPrice, i.grossUnitPrice]))
      .toEqual(plain[':items'].map((i: any) => [i.unitPrice, i.grossUnitPrice]));
  });

  it('a note on a celebration-eligible drink does not disturb the discount', async () => {
    // The one place a note could plausibly leak into pricing is the celebration
    // candidate, since that is the only rule a customer order applies itself.
    const CELEBRATION_SETTINGS = {
      PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN',
      celebrationMode: true, celebrationPrice: 5,
    };
    const ELIGIBLE = { ...LATTE, celebrationEligible: true };

    stage({ settings: CELEBRATION_SETTINGS, menu: { latte: ELIGIBLE } });
    await handleOrders(createEvent({
      customerName: 'Ah Beng', items: [{ menuItemId: 'latte', quantity: 1 }],
    }));
    const plain = orderPuts()[0].Item;

    stage({ settings: CELEBRATION_SETTINGS, menu: { latte: ELIGIBLE } });
    await handleOrders(createEvent({
      customerName: 'Ah Beng', items: [{ menuItemId: 'latte', quantity: 1, note: 'no foam' }],
    }));
    const noted = orderPuts()[0].Item;

    // NET 5, gross 8, offset 3 — the storage convention, unchanged by the note.
    expect(plain.totalAmount).toBe(5);
    expect(noted.totalAmount).toBe(5);
    expect(noted.grossAmount).toBe(8);
    expect(noted.discountOffset).toBe(3);
    expect(noted.discountType).toBe(plain.discountType);
    expect(noted.discountType).toBe('CELEBRATION');
  });
});

// ─── 6. quantity > 1 still works ─────────────────────────────────────

/**
 * Walk-up carts and every historical order carry MERGED lines — only the
 * customer cart stopped merging. A `quantity: 3` line has to keep pricing as
 * three, on both paths, with and without a note.
 */
describe('quantity > 1 still prices as N', () => {
  it('create: a quantity 3 noted line is priced three times', async () => {
    stage({ menu: ALL_MENU });
    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [{ menuItemId: 'latte', quantity: 3, note: 'all decaf' }],
    }));
    expect(res.statusCode).toBe(201);

    const o = orderPuts()[0].Item;
    expect(o.items[0].quantity).toBe(3);
    expect(o.items[0].unitPrice).toBe(8);
    expect(o.totalAmount).toBe(24);
    expect(o.grossAmount).toBe(24);
    expect(o.items[0].note).toBe('all decaf');
  });

  it('create: a quantity 3 FOOD line reserves 3 and is stock-checked as 3', async () => {
    stage({ menu: { cookie: { ...COOKIE, foodQuantityToday: 3, foodReserved: 0 } } });
    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [{ menuItemId: 'cookie', quantity: 3, note: 'warm' }],
    }));
    expect(res.statusCode).toBe(201);
    expect(menuUpdates()[0].ExpressionAttributeValues).toEqual({ ':q': 3 });
    expect(orderPuts()[0].Item.totalAmount).toBe(9);
  });

  it('create: a quantity 3 FOOD line is refused when only 2 are available', async () => {
    stage({ menu: { cookie: { ...COOKIE, foodQuantityToday: 3, foodReserved: 1 } } });
    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng',
      items: [{ menuItemId: 'cookie', quantity: 3 }],
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Insufficient stock/);
    expect(menuUpdates()).toHaveLength(0);
  });

  it('edit: a quantity 3 noted line is priced three times', async () => {
    stage({ menu: ALL_MENU, orders: { n1: plainOrder() } });
    const res = await handleOrders(editEvent('n1', {
      items: [{ menuItemId: 'latte', quantity: 3, note: 'all decaf' }],
    }));
    expect(res.statusCode).toBe(200);

    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':items'][0].quantity).toBe(3);
    expect(v[':items'][0].note).toBe('all decaf');
    expect(v[':t']).toBe(24);
    expect(v[':ga']).toBe(24);
  });

  it('accepts the walk-up spelling `qty` as well as `quantity`', async () => {
    // `resolveQuantity` exists because the walk-up cart sends `qty`; a note must
    // not change which key wins.
    stage({ menu: ALL_MENU });
    await handleOrders(createEvent({
      customerName: 'Ah Beng', items: [{ menuItemId: 'latte', qty: 3, note: 'all decaf' }],
    }));
    expect(orderPuts()[0].Item.items[0].quantity).toBe(3);
    expect(orderPuts()[0].Item.totalAmount).toBe(24);
  });
});
