import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuid } from 'uuid';
import { docClient, ORDERS_TABLE, MENU_TABLE, SETTINGS_TABLE, GetCommand, PutCommand, UpdateCommand, ScanCommand } from '../lib/db';

const res = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode, headers: {}, body: JSON.stringify(body),
});

async function getSettings() {
  const r = await docClient.send(new GetCommand({ TableName: SETTINGS_TABLE, Key: { PK: 'SETTINGS', SK: 'CONFIG' } }));
  return r.Item;
}

async function getMenuItem(menuItemId: string) {
  const r = await docClient.send(new GetCommand({ TableName: MENU_TABLE, Key: { PK: `MENU#${menuItemId}`, SK: 'META' } }));
  return r.Item;
}

async function releaseFood(items: { menuItemId: string; quantity: number; category?: string }[]) {
  for (const item of items) {
    if (item.category === 'FOOD') {
      await docClient.send(new UpdateCommand({
        TableName: MENU_TABLE,
        Key: { PK: `MENU#${item.menuItemId}`, SK: 'META' },
        UpdateExpression: 'SET foodReserved = foodReserved - :q',
        ExpressionAttributeValues: { ':q': item.quantity },
      }));
    }
  }
}

async function createOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { customerName, items, notes } = body;
  if (!customerName || !items?.length) return res(400, { error: 'customerName and items required' });

  const settings = await getSettings();
  if (!settings || settings.cafeStatus !== 'OPEN') return res(403, { error: 'Cafe is not open' });

  const orderItems: any[] = [];
  let totalAmount = 0;

  for (const item of items) {
    const menu = await getMenuItem(item.menuItemId);
    if (!menu || !menu.isActive || !menu.isEnabledToday) return res(400, { error: `Item ${item.menuItemId} unavailable` });

    if (menu.category === 'FOOD') {
      const available = (menu.foodQuantityToday || 0) - (menu.foodReserved || 0);
      if (available < item.quantity) return res(400, { error: `Insufficient stock for ${menu.name}` });
    }

    let unitPrice = menu.basePrice;
    let variantLabel = null;
    if (item.selectedVariants?.length) {
      for (const sv of item.selectedVariants) unitPrice += (sv.price || 0);
      variantLabel = item.selectedVariants.map((sv: any) => sv.option).join(', ');
    } else if (item.variant) {
      const variant = menu.variants?.find((v: any) => v.id === item.variant || v.name === item.variant);
      if (variant) unitPrice += (variant.priceModifier || 0);
      variantLabel = item.variant;
    }
    if (settings.celebrationMode && menu.category === 'DRINK') unitPrice = settings.celebrationPrice;

    orderItems.push({ menuItemId: item.menuItemId, name: menu.name, variant: variantLabel, quantity: item.quantity, unitPrice, category: menu.category });
    totalAmount += unitPrice * item.quantity;
  }

  // Reserve food
  for (const oi of orderItems) {
    if (oi.category === 'FOOD') {
      await docClient.send(new UpdateCommand({
        TableName: MENU_TABLE,
        Key: { PK: `MENU#${oi.menuItemId}`, SK: 'META' },
        UpdateExpression: 'SET foodReserved = foodReserved + :q',
        ExpressionAttributeValues: { ':q': oi.quantity },
      }));
    }
  }

  const orderId = uuid();
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + (settings.orderExpiryMinutes || 30) * 60;

  await docClient.send(new PutCommand({
    TableName: ORDERS_TABLE,
    Item: {
      PK: `ORDER#${orderId}`, SK: 'META', orderId, customerName,
      items: orderItems, totalAmount, status: 'PENDING',
      notes: notes || '',
      discountType: 'NONE', discountOffset: 0,
      createdAt: now, updatedAt: now, expiresAt,
      isWalkUp: false, flaggedItems: [],
    },
  }));

  return res(201, { orderId, totalAmount, status: 'PENDING' });
}

async function getOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const r = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));
  if (!r.Item) return res(404, { error: 'Order not found' });

  const o = r.Item;
  return res(200, { orderId: o.orderId, customerName: o.customerName, items: o.items, totalAmount: o.totalAmount, status: o.status, notes: o.notes || '', flaggedItems: o.flaggedItems, createdAt: o.createdAt, receiptUrl: o.receiptUrl, receiptAmount: o.receiptAmount });
}

async function modifyOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const body = JSON.parse(event.body || '{}');
  const r = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));
  if (!r.Item) return res(404, { error: 'Order not found' });
  if (r.Item.status !== 'PENDING') return res(400, { error: 'Order cannot be modified' });

  const order = r.Item;

  if (body.action === 'cancel') {
    await releaseFood(order.items);
    await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: `ORDER#${id}`, SK: 'META' },
      UpdateExpression: 'SET #s = :s, updatedAt = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'CANCELLED', ':u': new Date().toISOString() },
    }));
    return res(200, { orderId: id, status: 'CANCELLED' });
  }

  if (body.action === 'update' && body.items?.length) {
    // Release old food reservations
    await releaseFood(order.items);

    const settings = await getSettings();
    const newItems: any[] = [];
    let totalAmount = 0;

    for (const item of body.items) {
      const menu = await getMenuItem(item.menuItemId);
      if (!menu || !menu.isActive || !menu.isEnabledToday) return res(400, { error: `Item ${item.menuItemId} unavailable` });

      if (menu.category === 'FOOD') {
        const available = (menu.foodQuantityToday || 0) - (menu.foodReserved || 0);
        if (available < item.quantity) return res(400, { error: `Insufficient stock for ${menu.name}` });
      }

      let unitPrice = menu.basePrice;
      let variantLabel = null;
      if (item.selectedVariants?.length) {
        for (const sv of item.selectedVariants) unitPrice += (sv.price || 0);
        variantLabel = item.selectedVariants.map((sv: any) => sv.option).join(', ');
      } else if (item.variant) {
        const variant = menu.variants?.find((v: any) => v.name === item.variant);
        if (variant) unitPrice += (variant.priceModifier || 0);
        variantLabel = item.variant;
      }
      if (settings?.celebrationMode && menu.category === 'DRINK') unitPrice = settings.celebrationPrice;

      newItems.push({ menuItemId: item.menuItemId, name: menu.name, variant: variantLabel, quantity: item.quantity, unitPrice, category: menu.category });
      totalAmount += unitPrice * item.quantity;
    }

    // Reserve new food
    for (const oi of newItems) {
      if (oi.category === 'FOOD') {
        await docClient.send(new UpdateCommand({
          TableName: MENU_TABLE,
          Key: { PK: `MENU#${oi.menuItemId}`, SK: 'META' },
          UpdateExpression: 'SET foodReserved = foodReserved + :q',
          ExpressionAttributeValues: { ':q': oi.quantity },
        }));
      }
    }

    await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: `ORDER#${id}`, SK: 'META' },
      UpdateExpression: 'SET items = :items, totalAmount = :t, updatedAt = :u',
      ExpressionAttributeValues: { ':items': newItems, ':t': totalAmount, ':u': new Date().toISOString() },
    }));

    return res(200, { orderId: id, totalAmount, status: 'PENDING' });
  }

  return res(400, { error: 'Invalid action' });
}

function extractId(path: string, prefix: string): string | null {
  const rest = path.replace(prefix, '');
  if (!rest || rest === '/') return null;
  return rest.startsWith('/') ? rest.slice(1).split('/')[0] : rest.split('/')[0];
}

export async function handleOrders(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const id = extractId(event.path, '/api/orders');

  if (method === 'POST' && !id) return createOrder(event);
  if (method === 'GET' && id) { event.pathParameters = { id }; return getOrder(event); }
  if (method === 'PUT' && id) { event.pathParameters = { id }; return modifyOrder(event); }

  return res(404, { error: 'Not found' });
}
