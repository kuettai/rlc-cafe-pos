/**
 * Top-level router (`src/index.ts`) behaviour.
 *
 * DynamoDB is mocked so the dispatch tests at the bottom can follow a request all
 * the way to the handler that should own it and assert on the calls it makes. The
 * auth/404 tests above never reach a handler, so the mock is inert for them.
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

import { handler } from '../src/index';
import { APIGatewayProxyEvent } from 'aws-lambda';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/',
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
  };
}

describe('Main Router', () => {
  it('should handle OPTIONS with CORS headers', async () => {
    const res = await handler(makeEvent({ httpMethod: 'OPTIONS', path: '/api/anything' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers?.['Access-Control-Allow-Methods']).toContain('GET');
  });

  it('should return 401 for unauthenticated POS requests', async () => {
    const res = await handler(makeEvent({ path: '/api/pos/orders' }));
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Unauthorized');
  });

  it('should return 401 for unauthenticated admin requests', async () => {
    const res = await handler(makeEvent({ path: '/api/admin/settings' }));
    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for unknown authenticated routes', async () => {
    const res = await handler(makeEvent({ path: '/api/unknown' }));
    expect(res.statusCode).toBe(401);
  });

  it('should return 404 for unknown routes when authenticated', async () => {
    const { signToken } = require('../src/lib/auth');
    const token = signToken({ userId: 'u1', name: 'N', role: 'ADMIN' });
    const res = await handler(makeEvent({ path: '/api/unknown', headers: { Authorization: `Bearer ${token}` } }));
    expect(res.statusCode).toBe(404);
  });

  it('should return 401 for unauthenticated /api/admin/staff-code', async () => {
    const res = await handler(makeEvent({ path: '/api/admin/staff-code' }));
    expect(res.statusCode).toBe(401);
  });

  it('should return 403 for a CASHIER hitting /api/admin/staff-code', async () => {
    // Registered ABOVE the generic /api/admin catch-all, so it must still be
    // ADMIN-gated in its own right.
    const { signToken } = require('../src/lib/auth');
    const token = signToken({ userId: 'cashier-1', name: 'Sarah', role: 'CASHIER' });
    const res = await handler(makeEvent({
      path: '/api/admin/staff-code',
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Forbidden');
  });

  it('should return 403 for non-admin accessing admin routes', async () => {
    const { signToken } = require('../src/lib/auth');
    const token = signToken({ userId: 'cashier-1', name: 'Sarah', role: 'CASHIER' });
    const res = await handler(makeEvent({
      path: '/api/admin/settings',
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Forbidden');
  });
});

/**
 * `PUT /api/pos/preorders/release-all` — bulk pre-order release.
 *
 * The route lives OUTSIDE the `/api/pos/orders/{id}/<verb>` family on purpose.
 * That family is dispatched by `path.endsWith(verb)` guarded by UNANCHORED
 * regexes (`/\/api\/pos\/orders\/([^/]+)\/approve/` and friends), so a collection
 * path under `/api/pos/orders/` would be safe only by accident — it survives
 * merely by not ending in one of today's verbs. These tests pin the separation in
 * both directions so neither can start shadowing the other.
 */
describe('Router — POS bulk pre-order release dispatch', () => {
  const { signToken } = require('../src/lib/auth');

  function cashierToken() {
    return signToken({ userId: 'cashier-1', name: 'Sarah', role: 'CASHIER' });
  }

  function cmds() { return mockDbSend.mock.calls.map(c => c[0]); }
  function orderGets() {
    return cmds().filter(c => c.__cmd === 'Get' && String(c.Key?.PK || '').startsWith('ORDER#'));
  }

  beforeEach(() => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});   // no rows, no settings — enough to dispatch
  });

  it('dispatches the exact path to the bulk handler', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'PUT',
      path: '/api/pos/preorders/release-all',
      body: '{}',
      headers: { Authorization: `Bearer ${cashierToken()}` },
    }));

    expect(res.statusCode).toBe(200);
    // The bulk handler's contract — the frontend button reads these names.
    expect(JSON.parse(res.body)).toEqual({ released: 0, skipped: 0, total: 0 });

    // It queried the PENDING bucket, which is what only the bulk handler does.
    const pendingQuery = cmds().find(c => c.__cmd === 'Query' && c.ExpressionAttributeValues?.[':s'] === 'PENDING');
    expect(pendingQuery).toBeDefined();
    expect(pendingQuery.IndexName).toBe('status-createdAt-index');
  });

  it('does NOT fall into any per-id route — no order is fetched by id', async () => {
    // approveOrder / rejectOrder / archiveOrder all begin with a Get on
    // ORDER#<id>. If the path were captured by one of the endsWith families,
    // `release-all` would be treated as an order id.
    await handler(makeEvent({
      httpMethod: 'PUT',
      path: '/api/pos/preorders/release-all',
      body: '{}',
      headers: { Authorization: `Bearer ${cashierToken()}` },
    }));

    expect(orderGets()).toHaveLength(0);
  });

  it('assigns no pathParameters — the route takes no path parameter', async () => {
    // Invariant 6: each dispatcher assigns `event.pathParameters` itself for
    // id-bearing routes. A collection route must leave it alone rather than
    // inventing an id from the last path segment.
    const event = makeEvent({
      httpMethod: 'PUT',
      path: '/api/pos/preorders/release-all',
      body: '{}',
      headers: { Authorization: `Bearer ${cashierToken()}` },
    });
    await handler(event);
    expect(event.pathParameters).toBeNull();
  });

  it('leaves the per-id approve route working unchanged', async () => {
    // The mirror direction: adding the collection route must not shadow the
    // id-capture family it was moved away from.
    const event = makeEvent({
      httpMethod: 'PUT',
      path: '/api/pos/orders/abc-123/approve',
      body: JSON.stringify({ approvedBy: 'Sarah' }),
      headers: { Authorization: `Bearer ${cashierToken()}` },
    });
    const res = await handler(event);

    // Reached approveOrder: it Gets the order by id, and the mocked empty
    // response makes it a clean 404 rather than a dispatch miss (which would be
    // the router's own 404 with no DB call at all).
    const get = orderGets()[0];
    expect(get).toBeDefined();
    expect(get.Key).toEqual({ PK: 'ORDER#abc-123', SK: 'META' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('Order not found');
    // The per-id dispatcher parses the id off event.path itself.
    expect(event.pathParameters).toEqual({ id: 'abc-123' });
  });

  it('a GET on the bulk path is not dispatched (PUT only)', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'GET',
      path: '/api/pos/preorders/release-all',
      headers: { Authorization: `Bearer ${cashierToken()}` },
    }));
    expect(res.statusCode).toBe(404);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const res = await handler(makeEvent({
      httpMethod: 'PUT', path: '/api/pos/preorders/release-all', body: '{}',
    }));
    expect(res.statusCode).toBe(401);
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});
