import { ScheduledEvent } from 'aws-lambda';
import { docClient, ORDERS_TABLE, MENU_TABLE, QueryCommand, UpdateCommand } from './lib/db';

export async function handler(_event: ScheduledEvent): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const result = await docClient.send(new QueryCommand({
    TableName: ORDERS_TABLE,
    IndexName: 'status-createdAt-index',
    KeyConditionExpression: '#s = :status AND createdAt < :cutoff',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': 'PENDING', ':cutoff': oneHourAgo },
  }));

  const orders = result.Items || [];

  for (const order of orders) {
    const today = order.createdAt.slice(0, 10);
    await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: `ORDER#${today}#${order.orderId}`, SK: 'META' },
      UpdateExpression: 'SET #s = :expired, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':expired': 'EXPIRED', ':now': new Date().toISOString() },
    }));

    // Release food reservations
    for (const item of order.items || []) {
      if (item.category === 'FOOD') {
        await docClient.send(new UpdateCommand({
          TableName: MENU_TABLE,
          Key: { PK: `MENU#${item.menuItemId}`, SK: 'META' },
          UpdateExpression: 'SET foodReserved = foodReserved - :qty',
          ExpressionAttributeValues: { ':qty': item.quantity || 1 },
        }));
      }
    }
  }
}
