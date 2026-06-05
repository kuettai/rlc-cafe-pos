import { ScheduledEvent } from 'aws-lambda';
import { docClient, ORDERS_TABLE, MENU_TABLE, INGREDIENTS_TABLE, SETTINGS_TABLE, QueryCommand, UpdateCommand, ScanCommand, GetCommand, PutCommand } from './lib/db';
import { sendLowStockAlert } from './lib/email';

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

  // Check low stock and send alert (max once per hour)
  await checkLowStock();
}

async function checkLowStock() {
  // Only send alerts on Sunday after 5pm MYT and Wednesday at 12pm MYT
  const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8
  const day = nowMYT.getUTCDay(); // 0=Sun, 3=Wed
  const hour = nowMYT.getUTCHours();

  const isSundayEvening = day === 0 && hour >= 17 && hour < 18;
  const isWednesdayNoon = day === 3 && hour >= 12 && hour < 13;
  if (!isSundayEvening && !isWednesdayNoon) return;

  const today = new Date().toISOString().split('T')[0];
  const alertKey = `LOW_STOCK_ALERT#${today}`;

  const lastAlert = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: alertKey, SK: 'META' },
  }));

  // Only send once per day
  if (lastAlert.Item?.lastSent) return;

  const ingredientResult = await docClient.send(new ScanCommand({
    TableName: INGREDIENTS_TABLE,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
    ExpressionAttributeValues: { ':prefix': 'INGREDIENT#', ':sk': 'META' },
  }));

  const lowItems = (ingredientResult.Items || []).filter(
    (i: any) => i.currentStock <= (i.lowStockThreshold || 0) && i.lowStockThreshold > 0
  );

  if (lowItems.length === 0) return;

  const sent = await sendLowStockAlert(lowItems.map((i: any) => ({
    name: i.name,
    currentStock: i.currentStock,
    unit: i.unit,
    threshold: i.lowStockThreshold,
  })));

  if (sent) {
    await docClient.send(new PutCommand({
      TableName: SETTINGS_TABLE,
      Item: { PK: alertKey, SK: 'META', lastSent: new Date().toISOString(), itemCount: lowItems.length },
    }));
  }
}
