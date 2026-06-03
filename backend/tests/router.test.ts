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
