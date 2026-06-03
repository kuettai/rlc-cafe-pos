import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { docClient, USERS_TABLE, ScanCommand } from '../lib/db';
import { comparePin, signToken } from '../lib/auth';

export async function handleAuth(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod === 'POST' && event.path === '/api/auth/login') {
    const body = JSON.parse(event.body || '{}');
    const { userId, pin } = body;
    if (!userId || !pin) {
      return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'userId and pin required' }) };
    }

    const result = await docClient.send(new ScanCommand({
      TableName: USERS_TABLE,
      FilterExpression: '(userId = :uid OR #n = :uid) AND isActive = :active',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: { ':uid': userId, ':active': true },
    }));

    const user = result.Items?.[0];
    if (!user || !comparePin(pin, user.pinHash)) {
      return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }

    const token = signToken({ userId: user.userId, name: user.name, role: user.role });
    return { statusCode: 200, headers: {}, body: JSON.stringify({ token, userId: user.userId, name: user.name, role: user.role }) };
  }

  return { statusCode: 404, headers: {}, body: JSON.stringify({ error: 'Not found' }) };
}
