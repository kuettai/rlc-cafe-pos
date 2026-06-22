import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { verifyToken, TokenPayload } from './lib/auth';
import { handleAuth } from './routes/auth';
import { handleMenu } from './routes/menu';
import { handleCafe } from './routes/cafe';
import { handleOrders } from './routes/orders';
import { handlePos } from './routes/pos';
import { handleAdmin } from './routes/admin';
import { handleChecklist } from './routes/checklist';
import { handleReceipt } from './routes/receipt';
import { handlePlanogram } from './routes/planogram';
import { handleCustomers } from './routes/customers';
import { handleVouchers } from './routes/vouchers';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

function getToken(event: APIGatewayProxyEvent): TokenPayload | null {
  const header = event.headers?.Authorization || event.headers?.authorization || '';
  const token = header.replace('Bearer ', '');
  if (!token) return null;
  try { return verifyToken(token); } catch { return null; }
}

function respond(statusCode: number, body: object): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const path = event.path;

  // Public routes
  if (path.startsWith('/api/auth')) {
    const res = await handleAuth(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }
  if (path.startsWith('/api/menu')) {
    const res = await handleMenu(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }
  if (path.startsWith('/api/cafe')) {
    const res = await handleCafe(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }
  if (path.match(/\/api\/orders\/[^/]+\/receipt/)) {
    const res = await handleReceipt(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }
  if (path.startsWith('/api/customers')) {
    const res = await handleCustomers(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }
  if (path.startsWith('/api/orders')) {
    const res = await handleOrders(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }

  // Authenticated routes
  const user = getToken(event);
  if (!user) return respond(401, { error: 'Unauthorized' });

  if (path.startsWith('/api/admin/checklist')) {
    if (user.role !== 'ADMIN') return respond(403, { error: 'Forbidden' });
    const res = await handleChecklist(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }

  if (path.startsWith('/api/admin/planogram')) {
    if (user.role !== 'ADMIN') return respond(403, { error: 'Forbidden' });
    const res = await handlePlanogram(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }

  if (path.startsWith('/api/admin/vouchers')) {
    if (user.role !== 'ADMIN') return respond(403, { error: 'Forbidden' });
    const res = await handleVouchers(event, user.name);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }

  if (path.startsWith('/api/admin')) {
    if (user.role !== 'ADMIN') return respond(403, { error: 'Forbidden' });
    const res = await handleAdmin(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }

  if (path.startsWith('/api/pos/checklist')) {
    const res = await handleChecklist(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }

  if (path.startsWith('/api/pos/planogram')) {
    const res = await handlePlanogram(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }

  if (path.startsWith('/api/pos/vouchers')) {
    const res = await handleVouchers(event, user.name);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }

  if (path.startsWith('/api/pos')) {
    const res = await handlePos(event);
    res.headers = { ...CORS_HEADERS, ...res.headers };
    return res;
  }

  return respond(404, { error: 'Not found' });
}
