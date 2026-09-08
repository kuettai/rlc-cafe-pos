/**
 * `POST` / `DELETE /api/push/subscribe` — the subscription STORE.
 *
 * Scope note: `push-vapid.test.ts` owns `lib/push.ts` (VAPID config, the actual
 * web-push send) and `GET /api/push/vapid-public-key`. This file owns the other
 * two branches of `routes/push.ts` — the handler that writes and deletes the
 * `PUSH_SUB#<orderId>` rows that a later `sendOrderPush()` reads. `lib/push` is
 * mocked here so nothing in this file can reach SSM or web-push: the subscribe
 * and unsubscribe paths must not need VAPID at all, and mocking it proves that
 * as a side effect.
 *
 * What is load-bearing:
 *
 * 1. `SK` is a hash of the endpoint, not the order. Two devices tracking one
 *    order are two rows; the same device subscribing twice is an upsert of one
 *    row. Get that wrong and a customer either loses a device's notification or
 *    accumulates duplicates that each get sent to.
 * 2. Subscribe and unsubscribe must derive the SAME `SK` from the same endpoint,
 *    or unsubscribe silently deletes nothing and the browser keeps being pushed
 *    to after the customer opted out.
 * 3. `expiresAt` here is a NUMERIC unix-seconds TTL on a settings-table
 *    `PUSH_SUB#` row — the invariant that restricts `expiresAt` to PENDING
 *    applies to ORDER records, not to these. It must stay numeric: DynamoDB TTL
 *    ignores a string, and the subscriptions would never be reaped.
 * 4. A rejected body returns 400 BEFORE any write.
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

const mockEnsureVapidConfigured = jest.fn();
jest.mock('../src/lib/push', () => ({
  ensureVapidConfigured: (...args: any[]) => mockEnsureVapidConfigured(...args),
  sendOrderPush: jest.fn(),
  resetVapidState: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { handlePush } = require('../src/routes/push');
/* eslint-enable @typescript-eslint/no-var-requires */

// ─── Fixtures ────────────────────────────────────────────────────────

/**
 * Golden hashes: the first 16 hex chars of sha256(endpoint), recorded as
 * literals rather than recomputed with crypto in the test, so this asserts the
 * stored key rather than re-deriving the handler's own arithmetic.
 */
const ENDPOINT_A = 'https://fcm.googleapis.com/fcm/send/abc123';
const HASH_A = 'd395ac524dac9139';
const ENDPOINT_B = 'https://fcm.googleapis.com/fcm/send/zzz999';
const HASH_B = '7c11879cadea541d';

const SUBSCRIPTION_A = {
  endpoint: ENDPOINT_A,
  keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
};

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    httpMethod: 'POST',
    path: '/api/push/subscribe',
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
  } as any;
}

function subscribeEvent(body: Record<string, any> | null) {
  return makeEvent({ body: body === null ? null : JSON.stringify(body) });
}

function unsubscribeEvent(body: Record<string, any> | null) {
  return makeEvent({
    httpMethod: 'DELETE',
    body: body === null ? null : JSON.stringify(body),
  });
}

function dbCommands(): any[] {
  return mockDbSend.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
  mockEnsureVapidConfigured.mockReset();
});

describe('POST /api/push/subscribe', () => {
  it('stores the subscription under PUSH_SUB#<orderId> / endpoint hash', async () => {
    const res = await handlePush(subscribeEvent({
      orderId: 'order-1',
      subscription: SUBSCRIPTION_A,
      customerName: 'Grace',
    }));

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ subscribed: true });

    const put = dbCommands().find((c) => c.__cmd === 'Put');
    expect(put.TableName).toBe('test-settings');
    expect(put.Item.PK).toBe('PUSH_SUB#order-1');
    expect(put.Item.SK).toBe(HASH_A);
    // The whole subscription object survives — a stripped `keys` pair makes the
    // row unusable at send time, and nothing else validates it.
    expect(put.Item.subscription).toEqual(SUBSCRIPTION_A);
    expect(put.Item.customerName).toBe('Grace');
  });

  it('writes a NUMERIC 24h expiresAt TTL and an ISO createdAt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-06T01:30:00.000Z'));
    try {
      await handlePush(subscribeEvent({ orderId: 'order-1', subscription: SUBSCRIPTION_A }));

      const put = dbCommands().find((c) => c.__cmd === 'Put');
      // A string here would be ignored by DynamoDB TTL and the row would live
      // forever; assert the type as well as the value.
      expect(typeof put.Item.expiresAt).toBe('number');
      expect(put.Item.expiresAt).toBe(Math.floor(Date.parse('2026-09-06T01:30:00.000Z') / 1000) + 86400);
      expect(put.Item.createdAt).toBe('2026-09-06T01:30:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('defaults customerName to an empty string when the body omits it', async () => {
    await handlePush(subscribeEvent({ orderId: 'order-1', subscription: SUBSCRIPTION_A }));

    const put = dbCommands().find((c) => c.__cmd === 'Put');
    expect(put.Item.customerName).toBe('');
    expect('customerName' in put.Item).toBe(true);
  });

  it('keeps two devices on one order as two rows', async () => {
    await handlePush(subscribeEvent({ orderId: 'order-1', subscription: { endpoint: ENDPOINT_A } }));
    await handlePush(subscribeEvent({ orderId: 'order-1', subscription: { endpoint: ENDPOINT_B } }));

    const puts = dbCommands().filter((c) => c.__cmd === 'Put');
    expect(puts).toHaveLength(2);
    expect(puts.map((p) => p.Item.SK)).toEqual([HASH_A, HASH_B]);
    expect(puts[0].Item.PK).toBe(puts[1].Item.PK);
  });

  it('is an UPSERT for the same device — same endpoint, same SK', async () => {
    await handlePush(subscribeEvent({ orderId: 'order-1', subscription: { endpoint: ENDPOINT_A } }));
    await handlePush(subscribeEvent({ orderId: 'order-1', subscription: SUBSCRIPTION_A }));

    const puts = dbCommands().filter((c) => c.__cmd === 'Put');
    expect(puts[0].Item.SK).toBe(puts[1].Item.SK);
  });

  it('scopes the row to the order — same device, two orders, two partitions', async () => {
    await handlePush(subscribeEvent({ orderId: 'order-1', subscription: SUBSCRIPTION_A }));
    await handlePush(subscribeEvent({ orderId: 'order-2', subscription: SUBSCRIPTION_A }));

    const puts = dbCommands().filter((c) => c.__cmd === 'Put');
    expect(puts.map((p) => p.Item.PK)).toEqual(['PUSH_SUB#order-1', 'PUSH_SUB#order-2']);
    expect(puts.map((p) => p.Item.SK)).toEqual([HASH_A, HASH_A]);
  });

  it('never consults the VAPID config — subscribing does not need keys', async () => {
    await handlePush(subscribeEvent({ orderId: 'order-1', subscription: SUBSCRIPTION_A }));

    expect(mockEnsureVapidConfigured).not.toHaveBeenCalled();
  });

  describe('rejects a bad body with 400 and writes nothing', () => {
    const cases: [string, Record<string, any> | null][] = [
      ['no body at all', null],
      ['empty body', {}],
      ['orderId missing', { subscription: SUBSCRIPTION_A }],
      ['orderId empty string', { orderId: '', subscription: SUBSCRIPTION_A }],
      ['subscription missing', { orderId: 'order-1' }],
      ['subscription null', { orderId: 'order-1', subscription: null }],
      ['subscription without endpoint', { orderId: 'order-1', subscription: { keys: {} } }],
      ['endpoint empty string', { orderId: 'order-1', subscription: { endpoint: '' } }],
    ];

    it.each(cases)('%s', async (_label, body) => {
      const res = await handlePush(subscribeEvent(body));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'orderId and subscription required' });
      expect(mockDbSend).not.toHaveBeenCalled();
    });
  });
});

describe('DELETE /api/push/subscribe', () => {
  it('deletes exactly the key subscribe wrote', async () => {
    await handlePush(subscribeEvent({ orderId: 'order-1', subscription: SUBSCRIPTION_A }));
    const written = dbCommands().find((c) => c.__cmd === 'Put').Item;
    mockDbSend.mockClear();

    const res = await handlePush(unsubscribeEvent({ orderId: 'order-1', endpoint: ENDPOINT_A }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ unsubscribed: true });

    const del = dbCommands().find((c) => c.__cmd === 'Delete');
    expect(del.TableName).toBe('test-settings');
    // The round-trip is the point: an unsubscribe that derives a different SK
    // deletes nothing and the customer keeps being pushed to.
    expect(del.Key).toEqual({ PK: written.PK, SK: written.SK });
    expect(del.Key).toEqual({ PK: 'PUSH_SUB#order-1', SK: HASH_A });
  });

  it('removes only the device that asked — the other row keeps its key', async () => {
    const res = await handlePush(unsubscribeEvent({ orderId: 'order-1', endpoint: ENDPOINT_B }));

    expect(res.statusCode).toBe(200);
    const del = dbCommands().find((c) => c.__cmd === 'Delete');
    expect(del.Key).toEqual({ PK: 'PUSH_SUB#order-1', SK: HASH_B });
    expect(del.Key.SK).not.toBe(HASH_A);
  });

  describe('rejects a bad body with 400 and writes nothing', () => {
    const cases: [string, Record<string, any> | null][] = [
      ['no body at all', null],
      ['empty body', {}],
      ['orderId missing', { endpoint: ENDPOINT_A }],
      ['endpoint missing', { orderId: 'order-1' }],
      ['endpoint empty string', { orderId: 'order-1', endpoint: '' }],
      ['orderId empty string', { orderId: '', endpoint: ENDPOINT_A }],
    ];

    it.each(cases)('%s', async (_label, body) => {
      const res = await handlePush(unsubscribeEvent(body));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'orderId and endpoint required' });
      expect(mockDbSend).not.toHaveBeenCalled();
    });
  });
});

describe('anything else under /api/push is 404', () => {
  const cases: [string, string][] = [
    ['GET', '/api/push/subscribe'],          // method/path mismatch
    ['PUT', '/api/push/subscribe'],
    ['POST', '/api/push/vapid-public-key'],  // the key endpoint is GET-only
    ['GET', '/api/push'],
    ['GET', '/api/push/subscribe/extra'],    // no prefix matching — exact paths only
    ['GET', '/api/push/vapid-public-key/'],  // trailing slash is not the same route
  ];

  it.each(cases)('%s %s', async (httpMethod, path) => {
    const res = await handlePush(makeEvent({ httpMethod, path, body: null }));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(mockDbSend).not.toHaveBeenCalled();
    // A 404 must not have gone looking for VAPID either.
    expect(mockEnsureVapidConfigured).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE — without it TypeScript treats it as a global
// script and its top-level `const`s (mockDbSend, …) collide with the other
// script-mode suites on a cold ts-jest cache. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
