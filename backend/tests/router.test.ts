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

/**
 * The dispatch table itself — one case per branch of `src/index.ts`.
 *
 * These do NOT test handler behaviour (every handler has its own suite). They
 * prove two things the handler suites cannot, because they call the handler
 * directly and never go through `handler(event)`:
 *
 *  1. the branch is REACHED — asserted on something only that handler can
 *     produce, so a dispatch miss (the router's own `{ error: 'Not found' }`
 *     404, with no DB call at all) is distinguishable from the handler's own
 *     not-found response;
 *  2. `res.headers = { ...CORS_HEADERS, ...res.headers }` ran, i.e. the CORS
 *     headers are merged by the router and not re-declared per route
 *     (`invariants` → Backend shape).
 *
 * DynamoDB is mocked to a bare `{}` throughout, which is enough for every
 * handler below to return a response without throwing.
 */
describe('Router — dispatch table', () => {
  const { signToken } = require('../src/lib/auth');

  function tokenFor(role: 'ADMIN' | 'CASHIER') {
    return signToken({ userId: role.toLowerCase() + '-1', name: 'Sarah', role });
  }

  function authed(role: 'ADMIN' | 'CASHIER', overrides: Partial<APIGatewayProxyEvent> = {}) {
    return makeEvent({ ...overrides, headers: { Authorization: `Bearer ${tokenFor(role)}` } });
  }

  /** Every dispatched response carries all three CORS headers, merged. */
  function expectCors(res: { headers?: Record<string, any> | null }) {
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers?.['Access-Control-Allow-Headers']).toBe('Content-Type,Authorization');
    expect(res.headers?.['Access-Control-Allow-Methods']).toBe('GET,POST,PUT,DELETE,OPTIONS');
  }

  function cmds() { return mockDbSend.mock.calls.map(c => c[0]); }

  beforeEach(() => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
  });

  // ─── Public routes ────────────────────────────────────────────────────

  it('/api/auth → handleAuth', async () => {
    const res = await handler(makeEvent({ httpMethod: 'POST', path: '/api/auth/login', body: '{}' }));
    // handleAuth's own field validation, not the router's 404.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('userId and pin required');
    expectCors(res);
  });

  it('/api/menu → handleMenu', async () => {
    const res = await handler(makeEvent({ path: '/api/menu' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [] });
    // Only handleMenu scans the menu table with the customer-visible filter.
    const scan = cmds().find(c => c.__cmd === 'Scan' && c.TableName === 'test-menu');
    expect(scan?.ExpressionAttributeValues).toEqual({ ':active': true, ':enabled': true });
    expectCors(res);
  });

  it('/api/cafe → handleCafe', async () => {
    const res = await handler(makeEvent({ path: '/api/cafe/status' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.cafeStatus).toBe('CLOSED');
    // openingHours/openingState are handleCafe's contract alone.
    expect(body.openingHours).toBeDefined();
    expect(body.openingState).toBeDefined();
    expectCors(res);
  });

  it('/api/orders/{id}/receipt → handleReceipt (regex branch, ahead of /api/orders)', async () => {
    const res = await handler(makeEvent({ path: '/api/orders/abc-123/receipt' }));
    // "No receipt found" is handleReceipt's; a dispatch miss would say "Not found".
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('No receipt found');
    const get = cmds().find(c => c.__cmd === 'Get');
    expect(get?.Key).toEqual({ PK: 'ORDER#abc-123', SK: 'META' });
    expectCors(res);
  });

  it('/api/customers → handleCustomers', async () => {
    const res = await handler(makeEvent({ path: '/api/customers/0119900000' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('Customer not found');
    const get = cmds().find(c => c.__cmd === 'Get' && c.TableName === 'test-customers');
    expect(get?.Key).toEqual({ PK: 'CUSTOMER#0119900000', SK: 'META' });
    expectCors(res);
  });

  it('/api/preorder → handleValidatePreorder, with NO auth', async () => {
    const res = await handler(makeEvent({
      path: '/api/preorder/validate',
      queryStringParameters: { code: 'PRE123' },
    }));
    // Public on purpose — a 401 here would break the customer pre-order page.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ valid: false, reason: 'invalid' });
    const get = cmds().find(c => c.__cmd === 'Get');
    expect(get?.Key).toEqual({ PK: 'PREORDER_CODE#PRE123', SK: 'META' });
    expectCors(res);
  });

  it('/api/staff-code → handleValidateStaffCode, with NO auth', async () => {
    const res = await handler(makeEvent({
      path: '/api/staff-code/validate',
      queryStringParameters: { code: 'STAFF9' },
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ valid: false, reason: 'invalid' });
    // Proves it reached handleValidateStaffCode and NOT handleAdminStaffCode
    // (which scans the prefix) — the two share a path root.
    const get = cmds().find(c => c.__cmd === 'Get');
    expect(get?.Key).toEqual({ PK: 'STAFF_CODE#STAFF9', SK: 'META' });
    expectCors(res);
  });

  it('/api/orders → handleOrders', async () => {
    const event = makeEvent({ path: '/api/orders/abc-123' });
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('Order not found');
    // Invariant 6: the per-route dispatcher assigns pathParameters itself.
    expect(event.pathParameters).toEqual({ id: 'abc-123' });
    expectCors(res);
  });

  it('/api/push → handlePush', async () => {
    // Deliberately the subscribe branch, not vapid-public-key: that one calls
    // ensureVapidConfigured(), which reads SSM. Dispatch is what is under test
    // here, so take the path that needs no network.
    const res = await handler(makeEvent({ httpMethod: 'POST', path: '/api/push/subscribe', body: '{}' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('orderId and subscription required');
    expectCors(res);
  });

  it('/api/verses → handleVerses', async () => {
    const res = await handler(makeEvent({ path: '/api/verses/random' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ verse: null });
    // The handler's own Content-Type survives the merge; CORS is added around it.
    expect(res.headers?.['Content-Type']).toBe('application/json');
    expectCors(res);
  });

  // ─── Authenticated routes ─────────────────────────────────────────────

  it('/api/display → handleDisplay, any authenticated role', async () => {
    const res = await handler(authed('CASHIER', { path: '/api/display/orders' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).orders).toEqual([]);
    const q = cmds().find(c => c.__cmd === 'Query');
    expect(q?.ExpressionAttributeValues?.[':status']).toBe('READY');
    expectCors(res);
  });

  it('/api/admin/checklist → handleChecklist', async () => {
    const res = await handler(authed('ADMIN', { path: '/api/admin/checklist' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // config + log is handleChecklist's shape and nothing else's.
    expect(body.config.open.length).toBeGreaterThan(0);
    expect(body.log.open).toEqual({ items: {}, allCompleted: false });
    expectCors(res);
  });

  it('/api/admin/planogram → handlePlanogram', async () => {
    const res = await handler(authed('ADMIN', { path: '/api/admin/planogram/reference/fridge' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('No reference photo');
    const get = cmds().find(c => c.__cmd === 'Get');
    expect(get?.Key).toEqual({ PK: 'PLANOGRAM_REF#fridge', SK: 'META' });
    expectCors(res);
  });

  it('/api/admin/vouchers → handleVouchers, passed the actor name', async () => {
    const res = await handler(authed('ADMIN', { path: '/api/admin/vouchers/campaigns' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ campaigns: [] });
    const scan = cmds().find(c => c.__cmd === 'Scan' && c.TableName === 'test-vouchers');
    expect(scan).toBeDefined();
    expectCors(res);
  });

  it('/api/admin/preorder-codes → handleAdminPreorder', async () => {
    const res = await handler(authed('ADMIN', { path: '/api/admin/preorder-codes' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ codes: [] });
    const scan = cmds().find(c => c.__cmd === 'Scan');
    expect(scan?.ExpressionAttributeValues).toEqual({ ':prefix': 'PREORDER_CODE#' });
    expectCors(res);
  });

  it('/api/admin/staff-code → handleAdminStaffCode for an ADMIN', async () => {
    // The 403 for a CASHIER is pinned above; this is the pass-through half.
    const res = await handler(authed('ADMIN', { path: '/api/admin/staff-code' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ staffCode: null });
    // handleAdminStaffCode SCANS the prefix — the public validate route GETs a
    // single key. Distinguishes the two halves of the same path root.
    const scan = cmds().find(c => c.__cmd === 'Scan');
    expect(scan?.ExpressionAttributeValues).toEqual({ ':prefix': 'STAFF_CODE#' });
    expectCors(res);
  });

  it('/api/admin/customers (exact match) → handleAdmin customers branch', async () => {
    const res = await handler(authed('ADMIN', { path: '/api/admin/customers' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ customers: [] });
    const scan = cmds().find(c => c.__cmd === 'Scan');
    expect(scan?.TableName).toBe('test-customers');
    expectCors(res);
  });

  it('/api/admin/... (generic catch-all) → handleAdmin', async () => {
    const res = await handler(authed('ADMIN', { path: '/api/admin/menu' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [] });
    // The generic branch reached a DIFFERENT handleAdmin branch — the menu
    // table, not the customers table above.
    const scan = cmds().find(c => c.__cmd === 'Scan');
    expect(scan?.TableName).toBe('test-menu');
    expectCors(res);
  });

  it('/api/pos/checklist → handleChecklist (no ADMIN gate)', async () => {
    const res = await handler(authed('CASHIER', { path: '/api/pos/checklist' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).log.handover).toEqual({ items: {}, allCompleted: false });
    expectCors(res);
  });

  it('/api/pos/planogram → handlePlanogram (no ADMIN gate)', async () => {
    const res = await handler(authed('CASHIER', { path: '/api/pos/planogram/reference/storeroom' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('No reference photo');
    const get = cmds().find(c => c.__cmd === 'Get');
    expect(get?.Key).toEqual({ PK: 'PLANOGRAM_REF#storeroom', SK: 'META' });
    expectCors(res);
  });

  it('/api/pos/vouchers → handleVouchers (no ADMIN gate)', async () => {
    const res = await handler(authed('CASHIER', { path: '/api/pos/vouchers/0119900000' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.eligible).toEqual([]);
    const q = cmds().find(c => c.__cmd === 'Query' && c.TableName === 'test-vouchers');
    expect(q?.ExpressionAttributeValues?.[':pk']).toBe('VOUCHER#0119900000');
    expectCors(res);
  });

  it('/api/pos/... (generic) → handlePos', async () => {
    const res = await handler(authed('CASHIER', { path: '/api/pos/usage' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).usage).toEqual({});
    expectCors(res);
  });

  // ─── The role gate on every ADMIN-only branch ─────────────────────────
  // Each admin sub-path carries its OWN `user.role !== 'ADMIN'` check rather
  // than inheriting one, so each has to be pinned separately — the generic
  // catch-all's gate is no protection for the branches registered above it.
  it.each([
    '/api/admin/checklist',
    '/api/admin/planogram/reference/fridge',
    '/api/admin/vouchers/campaigns',
    '/api/admin/preorder-codes',
    '/api/admin/customers',
  ])('403s a CASHIER on %s, before reaching the handler', async (path) => {
    const res = await handler(authed('CASHIER', { path }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Forbidden');
    expect(mockDbSend).not.toHaveBeenCalled();
    expectCors(res);
  });

  // ─── getToken() ───────────────────────────────────────────────────────

  it('accepts a lowercase `authorization` header', async () => {
    // API Gateway does not normalise header casing, so both spellings reach
    // the Lambda and both must work.
    const res = await handler(makeEvent({
      path: '/api/display/orders',
      headers: { authorization: `Bearer ${tokenFor('CASHIER')}` },
    }));
    expect(res.statusCode).toBe(200);
  });

  it('treats a malformed token as unauthenticated rather than throwing', async () => {
    const res = await handler(makeEvent({
      path: '/api/display/orders',
      headers: { Authorization: 'Bearer not-a-jwt' },
    }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('Unauthorized');
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

/**
 * `ENFORCE_ORIGIN_HEADER` — the CloudFront shared-secret gate.
 *
 * Off by default, so the branch ships unexercised unless it is switched on
 * here. It runs BEFORE any route dispatch, so a failure is total: no handler is
 * reached and no DB call is made.
 */
describe('Router — ENFORCE_ORIGIN_HEADER', () => {
  const savedFlag = process.env.ENFORCE_ORIGIN_HEADER;
  const savedSecret = process.env.ORIGIN_VERIFY_SECRET;

  beforeEach(() => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
    process.env.ENFORCE_ORIGIN_HEADER = 'true';
    process.env.ORIGIN_VERIFY_SECRET = 'shared-secret-for-test';
  });

  afterAll(() => {
    // Restore, or every later suite in the process runs with the gate armed.
    if (savedFlag === undefined) delete process.env.ENFORCE_ORIGIN_HEADER;
    else process.env.ENFORCE_ORIGIN_HEADER = savedFlag;
    if (savedSecret === undefined) delete process.env.ORIGIN_VERIFY_SECRET;
    else process.env.ORIGIN_VERIFY_SECRET = savedSecret;
  });

  it('rejects a request with no x-origin-verify header, before any dispatch', async () => {
    const res = await handler(makeEvent({ path: '/api/menu' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Forbidden');
    // The gate must run ahead of the route table — handleMenu never ran.
    expect(mockDbSend).not.toHaveBeenCalled();
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe('*');
  });

  it('rejects a wrong secret', async () => {
    const res = await handler(makeEvent({
      path: '/api/menu',
      headers: { 'x-origin-verify': 'not-the-secret' },
    }));
    expect(res.statusCode).toBe(403);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the flag is on but no secret is configured', async () => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    const res = await handler(makeEvent({
      path: '/api/menu',
      headers: { 'x-origin-verify': 'anything' },
    }));
    expect(res.statusCode).toBe(403);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('passes a matching x-origin-verify through to the route table', async () => {
    const res = await handler(makeEvent({
      path: '/api/menu',
      headers: { 'x-origin-verify': 'shared-secret-for-test' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ items: [] });
    expect(mockDbSend).toHaveBeenCalled();
  });

  it('accepts the canonical X-Origin-Verify casing too', async () => {
    const res = await handler(makeEvent({
      path: '/api/menu',
      headers: { 'X-Origin-Verify': 'shared-secret-for-test' },
    }));
    expect(res.statusCode).toBe(200);
  });

  it('does NOT gate an OPTIONS preflight — the early return runs first', async () => {
    const res = await handler(makeEvent({ httpMethod: 'OPTIONS', path: '/api/menu' }));
    expect(res.statusCode).toBe(200);
  });
});
