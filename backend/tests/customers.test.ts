/**
 * Customer profiles — `backend/src/routes/customers.ts`.
 *
 * Three routes plus one helper other routes import:
 *
 *  - `POST /api/customers`                     register / update a profile
 *  - `GET  /api/customers/{phone}`             lookup
 *  - `GET  /api/customers/{phone}/orders`      recent order history
 *  - `linkOrderToCustomer(phone, orderId, totalAmount)` — exported, called by
 *    `orders.ts` on create; it must be a **no-op** for an unusable phone and
 *    must swallow `ConditionalCheckFailedException` (an order from someone with
 *    no profile is normal) while letting every other error through, so a real
 *    DynamoDB failure is not silently converted into lost revenue figures.
 *
 * Two things this suite pins that are easy to break:
 *
 * 1. **Phone numbers are stored CANONICAL.** Every key, every response field and
 *    every `customerId` written onto an order is the `normalizePhone` output, not
 *    what the caller typed — otherwise `GET /{phone}/orders` (which queries the
 *    index on the canonical form) silently returns an empty history.
 * 2. **`totalSpent` accumulates GROSS.** `totalAmount` is NET (invariant 5), so
 *    the registration link path adds `totalAmount + discountOffset`. A customer's
 *    lifetime spend must not shrink because they used a discount.
 *
 * Assertions are on what the handler produced — the parsed response body, or the
 * `Item` / `UpdateExpression` / `ExpressionAttributeValues` of the command it
 * built — never on a fixture this file constructed.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked; `../src/lib/phone` is deliberately NOT mocked, because the
 * canonical-form claim above is only meaningful against the real normaliser. No
 * network, no credentials, nothing written to production — so no `ZZTEST_` marker
 * applies (that rule covers suites that create real records).
 *
 * The clock is pinned with `jest.setSystemTime`: the handler stamps
 * `createdAt` / `updatedAt` / `lastOrderAt` from the wall clock.
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
const { handleCustomers, linkOrderToCustomer } = require('../src/routes/customers');

// ─── Fixtures ────────────────────────────────────────────────────────

const NOW = new Date('2026-08-16T02:30:00.000Z');
const NOW_ISO = '2026-08-16T02:30:00.000Z';

/** Typed in every plausible way; all four normalise to the same canonical form. */
const PHONE = '0168089999';
const PHONE_INTL = '+60168089999';
const PHONE_DASHED = '016-808-9999';

/** digits → '0123456' → 7 long → normalizePhone returns null. */
const PHONE_UNUSABLE = '12345';

const EXISTING_CUSTOMER = {
  PK: `CUSTOMER#${PHONE}`, SK: 'META',
  phone: PHONE, name: 'Mei Ling', birthday: '03-14',
  orderCount: 4, totalSpent: 42.5,
  lastOrderAt: '2026-08-09T03:00:00.000Z',
  createdAt: '2026-06-01T01:00:00.000Z',
  updatedAt: '2026-08-09T03:00:00.000Z',
};

function orderRecord(overrides: Record<string, any> = {}) {
  return {
    PK: 'ORDER#ord-1', SK: 'META', orderId: 'ord-1',
    status: 'PENDING', totalAmount: 7, discountOffset: 0,
    items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1 }],
    createdAt: '2026-08-16T02:00:00.000Z',
    ...overrides,
  };
}

/**
 * Answer every read from a described world, keyed on the `TableName` and command
 * the handler actually asked for — not a `mockResolvedValueOnce` queue, which
 * would let a fixture fill the wrong slot (`invariants`, Test teeth). Registration
 * with an `orderId` issues reads against BOTH tables, so the two must be staged
 * distinctly or a guard cannot be shown to be reached.
 */
function stage(world: {
  /** `undefined` → no customer record (a Get with no `Item`). */
  customer?: Record<string, unknown>;
  /** Keyed by order PK, e.g. `'ORDER#ord-1'`. */
  orders?: Record<string, Record<string, unknown>>;
  /** Result of the history Query. `undefined` → a response with NO `Items` key. */
  history?: Record<string, unknown>[];
  /** Throw instead of answering, for the error paths. */
  failOn?: (cmd: any) => Error | undefined;
} = {}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    const failure = world.failOn?.(cmd);
    if (failure) throw failure;

    if (cmd.__cmd === 'Get' && cmd.TableName === 'test-customers') {
      return world.customer === undefined ? {} : { Item: world.customer };
    }
    if (cmd.__cmd === 'Get' && cmd.TableName === 'test-orders') {
      const rec = world.orders?.[String(cmd.Key?.PK || '')];
      return rec ? { Item: rec } : {};
    }
    if (cmd.__cmd === 'Query' && cmd.TableName === 'test-orders') {
      return world.history === undefined ? {} : { Items: world.history };
    }
    return {};
  });
}

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET', path: '/api/customers', body: null,
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function registerEvent(body: unknown): APIGatewayProxyEvent {
  return makeEvent({
    httpMethod: 'POST', path: '/api/customers',
    body: body === undefined ? null : JSON.stringify(body),
  });
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function of(kind: string, table: string) {
  return cmds().filter((c) => c.__cmd === kind && c.TableName === table);
}
function writes() {
  return cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd));
}
async function call(event: APIGatewayProxyEvent): Promise<{ statusCode: number; body: any }> {
  const res = await handleCustomers(event);
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.setSystemTime(NOW);
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/customers — validation
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/customers — a rejected body writes NOTHING', () => {
  it.each([
    ['no body at all', undefined, 'phone and name required'],
    ['an empty object', {}, 'phone and name required'],
    ['phone missing', { name: 'Mei Ling' }, 'phone and name required'],
    ['name missing', { phone: PHONE }, 'phone and name required'],
    ['an empty-string name', { phone: PHONE, name: '' }, 'phone and name required'],
    ['an unusable phone', { phone: PHONE_UNUSABLE, name: 'Mei Ling' }, 'Invalid phone number'],
    ['a non-numeric phone', { phone: 'call me', name: 'Mei Ling' }, 'Invalid phone number'],
  ])('rejects %s with 400', async (_name, body, expected) => {
    stage();
    const res = await call(registerEvent(body));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: expected });
    // "No error thrown" is not an assertion — validation sits before the read, so
    // a rejected registration must not have touched DynamoDB at all.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it.each(['14-03-1990', '3-14', 'March 14', '13/14'])(
    'rejects the birthday %p with 400 and no write',
    async (birthday) => {
      stage({ customer: EXISTING_CUSTOMER });
      const res = await call(registerEvent({ phone: PHONE, name: 'Mei Ling', birthday }));

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Birthday must be MM-DD format' });
      expect(mockDbSend).not.toHaveBeenCalled();
    },
  );

  it('accepts a well-formed MM-DD birthday', async () => {
    stage();
    const res = await call(registerEvent({ phone: PHONE, name: 'Mei Ling', birthday: '12-25' }));

    expect(res.statusCode).toBe(201);
    expect(of('Put', 'test-customers')[0].Item.birthday).toBe('12-25');
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/customers — create
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/customers — a new customer is CREATED at 201', () => {
  it('writes the full initial record with zeroed counters', async () => {
    stage({ customer: undefined });

    const res = await call(registerEvent({ phone: PHONE, name: 'Mei Ling' }));

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ message: 'Profile created', phone: PHONE, name: 'Mei Ling' });

    const puts = of('Put', 'test-customers');
    expect(puts).toHaveLength(1);
    // The Item the handler BUILT, key by key — a new customer starts at zero, and
    // `linkOrderToCustomer` does `orderCount + :one`, which fails on a missing
    // attribute. The zeros are load-bearing, not decoration.
    expect(puts[0].Item).toEqual({
      PK: `CUSTOMER#${PHONE}`, SK: 'META',
      phone: PHONE, name: 'Mei Ling', birthday: null,
      orderCount: 0, totalSpent: 0, lastOrderAt: null,
      createdAt: NOW_ISO, updatedAt: NOW_ISO,
    });
    // Read-before-write, on the canonical key.
    expect(of('Get', 'test-customers')[0].Key).toEqual({ PK: `CUSTOMER#${PHONE}`, SK: 'META' });
    expect(of('Update', 'test-customers')).toHaveLength(0);
  });

  it.each([
    ['the intl form', PHONE_INTL],
    ['the dashed form', PHONE_DASHED],
    ['a bare 60-prefixed form', '60168089999'],
  ])('stores the CANONICAL phone when given %s', async (_name, typed) => {
    stage({ customer: undefined });

    const res = await call(registerEvent({ phone: typed, name: 'Mei Ling' }));

    expect(res.statusCode).toBe(201);
    // Both the response and the key: a profile keyed on the typed form would be
    // invisible to every later lookup, which queries the canonical one.
    expect(res.body.phone).toBe(PHONE);
    expect(of('Put', 'test-customers')[0].Item.PK).toBe(`CUSTOMER#${PHONE}`);
    expect(of('Put', 'test-customers')[0].Item.phone).toBe(PHONE);
  });

  it('does not attempt any order link when no orderId is supplied', async () => {
    stage({ customer: undefined });
    await call(registerEvent({ phone: PHONE, name: 'Mei Ling' }));

    expect(cmds().filter((c) => c.TableName === 'test-orders')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/customers — update
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/customers — an existing customer is UPDATED at 200', () => {
  it('updates name and birthday and leaves the counters alone', async () => {
    stage({ customer: EXISTING_CUSTOMER });

    const res = await call(registerEvent({ phone: PHONE, name: 'Mei Ling Tan', birthday: '03-14' }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ message: 'Profile updated', phone: PHONE, name: 'Mei Ling Tan' });

    const updates = of('Update', 'test-customers');
    expect(updates).toHaveLength(1);
    expect(updates[0].Key).toEqual({ PK: `CUSTOMER#${PHONE}`, SK: 'META' });
    expect(updates[0].UpdateExpression)
      .toBe('SET #n = :name, birthday = :birthday, updatedAt = :now');
    expect(updates[0].ExpressionAttributeNames).toEqual({ '#n': 'name' });
    expect(updates[0].ExpressionAttributeValues).toEqual({
      ':name': 'Mei Ling Tan', ':birthday': '03-14', ':now': NOW_ISO,
    });
    // No counter clause: re-registering must not reset orderCount / totalSpent.
    expect(updates[0].UpdateExpression).not.toContain('orderCount');
    expect(updates[0].UpdateExpression).not.toContain('totalSpent');
    expect(of('Put', 'test-customers')).toHaveLength(0);
  });

  it('PRESERVES a stored birthday when the update omits one (fixed)', async () => {
    // Fixed: the birthday clause is now conditional on the submission actually
    // carrying a birthday, so a re-register from a shorter form that doesn't
    // ask for it no longer wipes the stored '03-14'. `customers.ts`.
    stage({ customer: EXISTING_CUSTOMER });

    const res = await call(registerEvent({ phone: PHONE, name: 'Mei Ling' }));

    expect(res.statusCode).toBe(200);
    const update = of('Update', 'test-customers')[0];
    expect(update.UpdateExpression).toBe('SET #n = :name, updatedAt = :now');
    expect(update.ExpressionAttributeValues).not.toHaveProperty(':birthday');
  });

  it('matches an existing record typed in a non-canonical form', async () => {
    stage({ customer: EXISTING_CUSTOMER });

    const res = await call(registerEvent({ phone: PHONE_DASHED, name: 'Mei Ling' }));

    expect(res.statusCode).toBe(200);
    expect(res.body.phone).toBe(PHONE);
    expect(of('Get', 'test-customers')[0].Key.PK).toBe(`CUSTOMER#${PHONE}`);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/customers?orderId — linking the order that triggered registration
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/customers with orderId — the order link', () => {
  it('links the order and increments the counters (NEW customer)', async () => {
    stage({ customer: undefined, orders: { 'ORDER#ord-1': orderRecord({ totalAmount: 7, discountOffset: 0 }) } });

    const res = await call(registerEvent({ phone: PHONE, name: 'Mei Ling', orderId: 'ord-1' }));

    expect(res.statusCode).toBe(201);

    const orderUpdates = of('Update', 'test-orders');
    expect(orderUpdates).toHaveLength(1);
    expect(orderUpdates[0].Key).toEqual({ PK: 'ORDER#ord-1', SK: 'META' });
    expect(orderUpdates[0].UpdateExpression).toBe('SET customerId = :phone');
    // The CANONICAL phone lands on the order — `getCustomerOrders` queries the
    // index on exactly that, so a raw value here loses the history.
    expect(orderUpdates[0].ExpressionAttributeValues).toEqual({ ':phone': PHONE });

    const custUpdates = of('Update', 'test-customers');
    expect(custUpdates).toHaveLength(1);
    expect(custUpdates[0].UpdateExpression).toBe(
      'SET orderCount = orderCount + :one, totalSpent = totalSpent + :amount, lastOrderAt = :now, updatedAt = :now',
    );
    expect(custUpdates[0].ExpressionAttributeValues)
      .toEqual({ ':one': 1, ':amount': 7, ':now': NOW_ISO });
    expect(custUpdates[0].ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('links the order for a RETURNING customer too, alongside the profile update', async () => {
    stage({ customer: EXISTING_CUSTOMER, orders: { 'ORDER#ord-1': orderRecord() } });

    const res = await call(registerEvent({ phone: PHONE_INTL, name: 'Mei Ling', orderId: 'ord-1' }));

    expect(res.statusCode).toBe(200);
    expect(of('Update', 'test-orders')).toHaveLength(1);
    // Two customer Updates: the profile edit, then the counter increment.
    const custUpdates = of('Update', 'test-customers');
    expect(custUpdates).toHaveLength(2);
    expect(custUpdates[0].UpdateExpression).toContain('#n = :name');
    expect(custUpdates[1].UpdateExpression).toContain('orderCount = orderCount + :one');
    expect(of('Update', 'test-orders')[0].ExpressionAttributeValues[':phone']).toBe(PHONE);
  });

  it('adds GROSS to totalSpent — net plus the discount offset', async () => {
    // Invariant 5: `totalAmount` is NET, `discountOffset` is the reduction. A
    // customer who used a discount must not have their lifetime spend understated,
    // so the counter takes 8 + 3, not 8.
    stage({ customer: undefined, orders: { 'ORDER#ord-1': orderRecord({ totalAmount: 8, discountOffset: 3 }) } });

    await call(registerEvent({ phone: PHONE, name: 'Mei Ling', orderId: 'ord-1' }));

    expect(of('Update', 'test-customers')[0].ExpressionAttributeValues[':amount']).toBe(11);
  });

  it('treats absent totalAmount / discountOffset as 0 rather than NaN', async () => {
    // A NaN here does not fail the request — it poisons `totalSpent` permanently.
    stage({
      customer: undefined,
      orders: { 'ORDER#ord-1': { PK: 'ORDER#ord-1', SK: 'META', orderId: 'ord-1' } },
    });

    await call(registerEvent({ phone: PHONE, name: 'Mei Ling', orderId: 'ord-1' }));

    const amount = of('Update', 'test-customers')[0].ExpressionAttributeValues[':amount'];
    expect(amount).toBe(0);
    expect(Number.isNaN(amount)).toBe(false);
  });

  it('SKIPS the link when the order does not exist, and still registers', async () => {
    stage({ customer: undefined, orders: {} });

    const res = await call(registerEvent({ phone: PHONE, name: 'Mei Ling', orderId: 'ghost' }));

    expect(res.statusCode).toBe(201);
    expect(of('Get', 'test-orders')[0].Key).toEqual({ PK: 'ORDER#ghost', SK: 'META' });
    // The guard is only proven if the fixture reached it: the order Get happened
    // and returned nothing, and no write followed.
    expect(of('Update', 'test-orders')).toHaveLength(0);
    expect(of('Update', 'test-customers')).toHaveLength(0);
    expect(of('Put', 'test-customers')).toHaveLength(1);
  });

  it('SKIPS the link when the order is ALREADY owned by a customer', async () => {
    // Re-linking would double-count that order's value on the new profile and
    // silently move the order off the customer who placed it.
    stage({
      customer: undefined,
      orders: { 'ORDER#ord-1': orderRecord({ customerId: '0129998888' }) },
    });

    const res = await call(registerEvent({ phone: PHONE, name: 'Mei Ling', orderId: 'ord-1' }));

    expect(res.statusCode).toBe(201);
    expect(of('Update', 'test-orders')).toHaveLength(0);
    expect(of('Update', 'test-customers')).toHaveLength(0);
  });

  it('registration still SUCCEEDS when the link throws — logged, not fatal', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      stage({
        customer: undefined,
        orders: { 'ORDER#ord-1': orderRecord() },
        failOn: (cmd) => (cmd.__cmd === 'Update' && cmd.TableName === 'test-orders'
          ? new Error('orders table on fire') : undefined),
      });

      const res = await call(registerEvent({ phone: PHONE, name: 'Mei Ling', orderId: 'ord-1' }));

      // The profile is the thing the customer asked for; a failed link must not
      // cost them the registration. But it must not vanish either.
      expect(res.statusCode).toBe(201);
      expect(res.body.message).toBe('Profile created');
      expect(err).toHaveBeenCalled();
      expect(String(err.mock.calls[0][0])).toContain('linkOrderAfterRegistration failed');
      expect(err.mock.calls[0][1]).toBe('ord-1');
    } finally {
      err.mockRestore();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/customers/{phone} — lookup
// ══════════════════════════════════════════════════════════════════════

describe('GET /api/customers/{phone} — lookup', () => {
  it('returns the profile projection, not the raw record', async () => {
    stage({ customer: EXISTING_CUSTOMER });

    const res = await call(makeEvent({ httpMethod: 'GET', path: `/api/customers/${PHONE}` }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      phone: PHONE, name: 'Mei Ling', birthday: '03-14',
      orderCount: 4, totalSpent: 42.5,
      lastOrderAt: '2026-08-09T03:00:00.000Z',
      createdAt: '2026-06-01T01:00:00.000Z',
    });
    // `updatedAt` / PK / SK are internal and must not leak to a public endpoint.
    expect(Object.keys(res.body).sort()).toEqual([
      'birthday', 'createdAt', 'lastOrderAt', 'name', 'orderCount', 'phone', 'totalSpent',
    ]);
    expect(writes()).toHaveLength(0);
  });

  it('defaults absent counters to 0 (a profile created before they existed)', async () => {
    stage({
      customer: { PK: `CUSTOMER#${PHONE}`, SK: 'META', phone: PHONE, name: 'Mei Ling' },
    });

    const res = await call(makeEvent({ httpMethod: 'GET', path: `/api/customers/${PHONE}` }));

    expect(res.statusCode).toBe(200);
    expect(res.body.orderCount).toBe(0);
    expect(res.body.totalSpent).toBe(0);
    expect(res.body.birthday).toBeUndefined();
  });

  it('looks up on the CANONICAL key when the path carries a dashed number', async () => {
    stage({ customer: EXISTING_CUSTOMER });

    const res = await call(makeEvent({ httpMethod: 'GET', path: `/api/customers/${PHONE_DASHED}` }));

    expect(res.statusCode).toBe(200);
    expect(of('Get', 'test-customers')[0].Key).toEqual({ PK: `CUSTOMER#${PHONE}`, SK: 'META' });
  });

  it('returns 404 when there is no profile', async () => {
    stage({ customer: undefined });

    const res = await call(makeEvent({ httpMethod: 'GET', path: `/api/customers/${PHONE}` }));

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
  });

  it('returns 400 for an unusable phone, before any read', async () => {
    stage({ customer: EXISTING_CUSTOMER });

    const res = await call(makeEvent({ httpMethod: 'GET', path: `/api/customers/${PHONE_UNUSABLE}` }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid phone number' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/customers/{phone}/orders — history
// ══════════════════════════════════════════════════════════════════════

describe('GET /api/customers/{phone}/orders — history', () => {
  const historyPath = `/api/customers/${PHONE}/orders`;

  it('queries the customerId index on the canonical phone, newest first, capped at 20', async () => {
    stage({
      customer: EXISTING_CUSTOMER,
      history: [
        { ...orderRecord({ orderId: 'ord-2', totalAmount: 12, status: 'READY' }), customerId: PHONE, secret: 'internal' },
      ],
    });

    const res = await call(makeEvent({ httpMethod: 'GET', path: `/api/customers/${PHONE_DASHED}/orders` }));

    expect(res.statusCode).toBe(200);
    const queries = of('Query', 'test-orders');
    expect(queries).toHaveLength(1);
    expect(queries[0].IndexName).toBe('customerId-createdAt-index');
    expect(queries[0].KeyConditionExpression).toBe('customerId = :phone');
    expect(queries[0].ExpressionAttributeValues).toEqual({ ':phone': PHONE });
    expect(queries[0].ScanIndexForward).toBe(false);
    expect(queries[0].Limit).toBe(20);

    // The five-field projection, and nothing else.
    expect(res.body.orders).toEqual([{
      orderId: 'ord-2', totalAmount: 12, status: 'READY',
      items: [{ menuItemId: 'latte', name: 'Latte', quantity: 1 }],
      createdAt: '2026-08-16T02:00:00.000Z',
    }]);
    expect(writes()).toHaveLength(0);
  });

  it('returns an empty list when the index answers with no Items key at all', async () => {
    stage({ customer: EXISTING_CUSTOMER, history: undefined });

    const res = await call(makeEvent({ httpMethod: 'GET', path: historyPath }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ orders: [] });
  });

  it('returns 404 when the customer does not exist, WITHOUT querying orders', async () => {
    stage({ customer: undefined, history: [orderRecord()] });

    const res = await call(makeEvent({ httpMethod: 'GET', path: historyPath }));

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
    // The guard has teeth only if the query it precedes was staged with data and
    // still never ran.
    expect(of('Query', 'test-orders')).toHaveLength(0);
  });

  it('returns 400 for an unusable phone, before any read', async () => {
    stage({ customer: EXISTING_CUSTOMER });

    const res = await call(makeEvent({ httpMethod: 'GET', path: `/api/customers/${PHONE_UNUSABLE}/orders` }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid phone number' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
// handleCustomers — dispatch
// ══════════════════════════════════════════════════════════════════════

describe('handleCustomers — dispatch', () => {
  it('assigns pathParameters itself (API Gateway proxy does not)', async () => {
    stage({ customer: EXISTING_CUSTOMER });
    const event = makeEvent({ httpMethod: 'GET', path: `/api/customers/${PHONE}` });

    await handleCustomers(event);

    expect(event.pathParameters).toEqual({ phone: PHONE });
  });

  it.each([
    ['DELETE', `/api/customers/${PHONE}`],
    ['PUT', `/api/customers/${PHONE}`],
    ['POST', `/api/customers/${PHONE}`],
    ['POST', `/api/customers/${PHONE}/orders`],
    ['GET', '/api/customers'],
    ['GET', '/api/customers/'],
    ['POST', '/api/customers/'],
    ['GET', '/api/customers-archive'],
  ])('%s %s → 404 with no DynamoDB access', async (httpMethod, path) => {
    stage({ customer: EXISTING_CUSTOMER });

    const res = await call(makeEvent({ httpMethod, path, body: JSON.stringify({ phone: PHONE, name: 'x' }) }));

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('routes /orders to the history handler, not the lookup handler', async () => {
    stage({ customer: EXISTING_CUSTOMER, history: [] });

    const res = await call(makeEvent({ httpMethod: 'GET', path: `/api/customers/${PHONE}/orders` }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ orders: [] });          // history shape
    expect(res.body.name).toBeUndefined();             // not the profile shape
    expect(of('Query', 'test-orders')).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// linkOrderToCustomer — the exported helper `orders.ts` calls on create
// ══════════════════════════════════════════════════════════════════════

describe('linkOrderToCustomer', () => {
  it('increments the counters conditionally on the profile existing', async () => {
    stage();

    await linkOrderToCustomer(PHONE_INTL, 'ord-9', 13.5);

    const updates = of('Update', 'test-customers');
    expect(updates).toHaveLength(1);
    expect(updates[0].Key).toEqual({ PK: `CUSTOMER#${PHONE}`, SK: 'META' });
    expect(updates[0].UpdateExpression).toBe(
      'SET orderCount = orderCount + :one, totalSpent = totalSpent + :amount, lastOrderAt = :now, updatedAt = :now',
    );
    expect(updates[0].ExpressionAttributeValues)
      .toEqual({ ':one': 1, ':amount': 13.5, ':now': NOW_ISO });
    // Without this, an order from a phone with no profile would CREATE a partial
    // record with no name and no createdAt.
    expect(updates[0].ConditionExpression).toBe('attribute_exists(PK)');
  });

  it.each([
    ['an unusable number', PHONE_UNUSABLE],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('is a silent NO-OP for %s — no DynamoDB call at all', async (_name, phone) => {
    stage();

    await expect(linkOrderToCustomer(phone, 'ord-9', 7)).resolves.toBeUndefined();

    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('SWALLOWS ConditionalCheckFailedException — a guest with no profile is normal', async () => {
    const missing: any = new Error('The conditional request failed');
    missing.name = 'ConditionalCheckFailedException';
    stage({ failOn: () => missing });

    await expect(linkOrderToCustomer(PHONE, 'ord-9', 7)).resolves.toBeUndefined();

    expect(of('Update', 'test-customers')).toHaveLength(1);   // it was attempted
  });

  it('RETHROWS any other error — a throttle must not be mistaken for "no profile"', async () => {
    const boom: any = new Error('Requested resource not found');
    boom.name = 'ResourceNotFoundException';
    stage({ failOn: () => boom });

    await expect(linkOrderToCustomer(PHONE, 'ord-9', 7))
      .rejects.toThrow('Requested resource not found');
  });
});
