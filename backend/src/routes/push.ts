import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { docClient, SETTINGS_TABLE, GetCommand, PutCommand, QueryCommand, DeleteCommand } from '../lib/db';
import * as crypto from 'crypto';

const res = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function endpointHash(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

export async function handlePush(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  // GET /api/push/vapid-public-key
  if (method === 'GET' && path === '/api/push/vapid-public-key') {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    if (!publicKey) return res(500, { error: 'VAPID not configured' });
    return res(200, { publicKey });
  }

  // POST /api/push/subscribe
  if (method === 'POST' && path === '/api/push/subscribe') {
    const body = event.body ? JSON.parse(event.body) : {};
    const { orderId, subscription, customerName } = body;
    if (!orderId || !subscription?.endpoint) {
      return res(400, { error: 'orderId and subscription required' });
    }

    const hash = endpointHash(subscription.endpoint);
    const now = new Date();
    const expiresAt = Math.floor(now.getTime() / 1000) + 86400; // 24h TTL

    await docClient.send(new PutCommand({
      TableName: SETTINGS_TABLE,
      Item: {
        PK: `PUSH_SUB#${orderId}`,
        SK: hash,
        subscription,
        customerName: customerName || '',
        createdAt: now.toISOString(),
        expiresAt,
      },
    }));

    return res(201, { subscribed: true });
  }

  // DELETE /api/push/subscribe
  if (method === 'DELETE' && path === '/api/push/subscribe') {
    const body = event.body ? JSON.parse(event.body) : {};
    const { orderId, endpoint } = body;
    if (!orderId || !endpoint) return res(400, { error: 'orderId and endpoint required' });

    const hash = endpointHash(endpoint);
    await docClient.send(new DeleteCommand({
      TableName: SETTINGS_TABLE,
      Key: { PK: `PUSH_SUB#${orderId}`, SK: hash },
    }));

    return res(200, { unsubscribed: true });
  }

  return res(404, { error: 'Not found' });
}
