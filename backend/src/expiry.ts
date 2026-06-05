import { ScheduledEvent } from 'aws-lambda';
import { docClient, ORDERS_TABLE, MENU_TABLE, QueryCommand, UpdateCommand } from './lib/db';

export async function handler(_event: ScheduledEvent): Promise<void> {
  // Expire PENDING orders older than 1 hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const pendingResult = await docClient.send(new QueryCommand({
    TableName: ORDERS_TABLE,
    IndexName: 'status-createdAt-index',
    KeyConditionExpression: '#s = :status AND createdAt < :cutoff',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': 'PENDING', ':cutoff': oneHourAgo },
  }));

  for (const order of pendingResult.Items || []) {
    await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: order.PK, SK: 'META' },
      UpdateExpression: 'SET #s = :expired, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':expired': 'EXPIRED', ':now': new Date().toISOString() },
    }));

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

  // Auto-archive READY orders older than 15 minutes
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const readyResult = await docClient.send(new QueryCommand({
    TableName: ORDERS_TABLE,
    IndexName: 'status-createdAt-index',
    KeyConditionExpression: '#s = :status AND createdAt < :cutoff',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': 'READY', ':cutoff': fifteenMinAgo },
  }));

  for (const order of readyResult.Items || []) {
    await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: order.PK, SK: 'META' },
      UpdateExpression: 'SET #s = :archived, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':archived': 'ARCHIVED', ':now': new Date().toISOString() },
    }));
  }
}
