import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { docClient, USERS_TABLE, ScanCommand, UpdateCommand } from '../lib/db';
import { comparePin, signToken, hashPin, verifyToken } from '../lib/auth';

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
    await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { PK: user.PK, SK: user.SK },
      UpdateExpression: 'SET lastLoginAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));
    return { statusCode: 200, headers: {}, body: JSON.stringify({ token, userId: user.userId, name: user.name, role: user.role, forceUpdatePin: !!user.forceUpdatePin }) };
  }

  if (event.httpMethod === 'POST' && event.path === '/api/auth/update-pin') {
    const authHeader = event.headers?.Authorization || event.headers?.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    let payload;
    try { payload = verifyToken(token); } catch { return { statusCode: 401, headers: {}, body: JSON.stringify({ error: 'Unauthorized' }) }; }
    const body = JSON.parse(event.body || '{}');
    if (!body.newPin || body.newPin.length < 4) return { statusCode: 400, headers: {}, body: JSON.stringify({ error: 'newPin required (min 4 digits)' }) };
    await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { PK: `USER#${payload.userId}`, SK: 'META' },
      UpdateExpression: 'SET pinHash = :ph, forceUpdatePin = :f',
      ExpressionAttributeValues: { ':ph': hashPin(body.newPin), ':f': false },
    }));
    return { statusCode: 200, headers: {}, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 404, headers: {}, body: JSON.stringify({ error: 'Not found' }) };
}
