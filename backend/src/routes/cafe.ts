import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { docClient, SETTINGS_TABLE, ORDERS_TABLE, MENU_TABLE, GetCommand, QueryCommand } from '../lib/db';

export async function handleCafe(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod === 'GET' && event.path === '/api/cafe/status') {
    const settings = await docClient.send(new GetCommand({
      TableName: SETTINGS_TABLE,
      Key: { PK: 'SETTINGS', SK: 'CONFIG' },
    }));

    const today = new Date().toISOString().slice(0, 10);
    const orders = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': 'PREPARING' },
    }));

    const cafeStatus = settings.Item?.cafeStatus || 'CLOSED';
    const celebrationMode = settings.Item?.celebrationMode || false;
    const celebrationPrice = settings.Item?.celebrationPrice || 5;
    const queueSize = orders.Count || 0;

    // Featured drink lookup
    let featuredDrink = null;
    const featuredId = settings.Item?.featuredDrinkId;
    if (featuredId) {
      const menuResult = await docClient.send(new GetCommand({
        TableName: MENU_TABLE,
        Key: { PK: `MENU#${featuredId}`, SK: 'META' },
      }));
      if (menuResult.Item) {
        featuredDrink = { menuItemId: featuredId, name: menuResult.Item.name, basePrice: menuResult.Item.basePrice, imageUrl: menuResult.Item.imageUrl || null, category: menuResult.Item.category };
      }
    }

    return { statusCode: 200, headers: {}, body: JSON.stringify({ cafeStatus, queueSize, celebrationMode, celebrationPrice, featuredDrink }) };
  }

  return { statusCode: 404, headers: {}, body: JSON.stringify({ error: 'Not found' }) };
}
