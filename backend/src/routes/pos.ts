import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuid } from 'uuid';
import { docClient, ORDERS_TABLE, MENU_TABLE, SETTINGS_TABLE, INGREDIENTS_TABLE, GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand } from '../lib/db';
import { sendEndOfDaySummary } from '../lib/email';

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

async function getShiftSummary(): Promise<APIGatewayProxyResult> {
  const today = new Date().toISOString().slice(0, 10);
  const statuses = ['PENDING', 'PREPARING', 'READY', 'ARCHIVED'];
  let allOrders: any[] = [];

  for (const status of statuses) {
    const r = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s AND createdAt >= :today',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':today': today },
    }));
    allOrders.push(...(r.Items || []));
  }

  const totalOrders = allOrders.length;
  const totalRevenue = allOrders.reduce((s, o) => s + (o.totalAmount || 0), 0);
  const newcomersServed = allOrders.filter(o => o.discountType === 'NEWCOMER').length;

  const itemCount: Record<string, number> = {};
  for (const o of allOrders) {
    for (const i of o.items || []) {
      itemCount[i.name] = (itemCount[i.name] || 0) + (i.quantity || 1);
    }
  }
  const peakItem = Object.entries(itemCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

  return res(200, { totalOrders, totalRevenue, newcomersServed, peakItem, closedAt: new Date().toISOString() });
}

async function listOrders(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const search = event.queryStringParameters?.search?.toLowerCase();
  const statuses = ['PENDING', 'PREPARING', 'READY'];
  let allOrders: any[] = [];

  for (const status of statuses) {
    const r = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
      ScanIndexForward: false,
    }));
    allOrders.push(...(r.Items || []));
  }

  if (search) {
    allOrders = allOrders.filter(o => o.customerName?.toLowerCase().includes(search));
  }

  // Sort: PENDING newest first, then PREPARING, then READY
  const priority: Record<string, number> = { PENDING: 0, PREPARING: 1, READY: 2 };
  allOrders.sort((a, b) => (priority[a.status] ?? 3) - (priority[b.status] ?? 3));

  return res(200, { orders: allOrders });
}

async function approveOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const body = JSON.parse(event.body || '{}');
  const r = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));
  if (!r.Item) return res(404, { error: 'Order not found' });

  const order = r.Item;
  let totalAmount = order.totalAmount;
  let discountType = body.discountType || 'NONE';
  let discountOffset = 0;

  if (body.discountType && body.discountType !== 'NONE') {
    let newTotal = 0;
    for (const item of order.items) {
      if (item.category === 'DRINK') {
        const discountedPrice = body.discountType === 'STAFF' ? 5 : 0;
        newTotal += discountedPrice * item.quantity;
      } else {
        newTotal += item.unitPrice * item.quantity;
      }
    }
    discountOffset = totalAmount - newTotal;
    totalAmount = newTotal;
  }

  try {
    await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: `ORDER#${id}`, SK: 'META' },
      UpdateExpression: 'SET #s = :s, approvedBy = :a, discountType = :dt, discountOffset = :do, totalAmount = :t, updatedAt = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'PREPARING', ':a': body.approvedBy, ':dt': discountType, ':do': discountOffset, ':t': totalAmount, ':u': new Date().toISOString(), ':pending': 'PENDING' },
      ConditionExpression: '#s = :pending',
    }));
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') {
      return res(409, { error: 'Order was just cancelled or modified by the customer' });
    }
    throw e;
  }

  // Deduct ingredients based on recipes
  await deductIngredients(order.items);

  return res(200, { orderId: id, status: 'PREPARING', totalAmount, discountOffset });
}

function normalizeVariantKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '-');
}

async function deductIngredients(items: any[]) {
  const usage: Record<string, number> = {};

  for (const item of items) {
    const menuItemId = item.menuItemId;
    const variantStr = item.variant || 'default';
    const qty = item.quantity || item.qty || 1;

    // Always start with default/base recipe
    const defaultKey = `RECIPE#${menuItemId}#default`;
    const defaultResult = await docClient.send(new QueryCommand({
      TableName: INGREDIENTS_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': defaultKey },
    }));
    const baseRecipe: Record<string, number> = {};
    for (const ri of defaultResult.Items || []) {
      if (ri.ingredientId) baseRecipe[ri.ingredientId] = ri.quantity || 0;
    }

    // Parse variant string — could be "Iced, Oat Milk" (multi-group) or "iced" (legacy)
    if (variantStr !== 'default') {
      const variantParts = variantStr.includes(',') ? variantStr.split(',') : [variantStr];
      for (const part of variantParts) {
        const normalized = normalizeVariantKey(part);
        const variantKey = `RECIPE#${menuItemId}#${normalized}`;
        const variantResult = await docClient.send(new QueryCommand({
          TableName: INGREDIENTS_TABLE,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': variantKey },
        }));
        for (const ri of variantResult.Items || []) {
          if (ri.ingredientId) baseRecipe[ri.ingredientId] = ri.quantity || 0;
        }
      }
    }

    for (const [ingId, amount] of Object.entries(baseRecipe)) {
      usage[ingId] = (usage[ingId] || 0) + amount * qty;
    }
  }

  // Deduct from ingredient stock (convert usage units to stock units is TODO — for now just track raw usage)
  // Store usage log for the day
  if (Object.keys(usage).length > 0) {
    const today = new Date().toISOString().split('T')[0];
    const logKey = `USAGE_LOG#${today}`;

    const existing = await docClient.send(new GetCommand({
      TableName: SETTINGS_TABLE,
      Key: { PK: logKey, SK: 'META' },
    }));

    const currentUsage = existing.Item?.usage || {};
    for (const [ingId, amount] of Object.entries(usage)) {
      currentUsage[ingId] = (currentUsage[ingId] || 0) + amount;
    }

    await docClient.send(new PutCommand({
      TableName: SETTINGS_TABLE,
      Item: {
        PK: logKey,
        SK: 'META',
        date: today,
        usage: currentUsage,
        lastUpdated: new Date().toISOString(),
      },
    }));
  }
}

async function markReady(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const now = new Date().toISOString();
  await docClient.send(new UpdateCommand({
    TableName: ORDERS_TABLE,
    Key: { PK: `ORDER#${id}`, SK: 'META' },
    UpdateExpression: 'SET #s = :s, updatedAt = :u, readyAt = :u',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'READY', ':u': now, ':prev': 'PREPARING' },
    ConditionExpression: '#s = :prev',
  }));

  return res(200, { orderId: id, status: 'READY', readyAt: now });
}

async function undoToPending(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  await docClient.send(new UpdateCommand({
    TableName: ORDERS_TABLE,
    Key: { PK: `ORDER#${id}`, SK: 'META' },
    UpdateExpression: 'SET #s = :s, updatedAt = :u',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'PENDING', ':u': new Date().toISOString(), ':prev': 'PREPARING' },
    ConditionExpression: '#s = :prev',
  }));

  return res(200, { orderId: id, status: 'PENDING' });
}

async function archiveOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  await docClient.send(new UpdateCommand({
    TableName: ORDERS_TABLE,
    Key: { PK: `ORDER#${id}`, SK: 'META' },
    UpdateExpression: 'SET #s = :s, updatedAt = :u',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'ARCHIVED', ':u': new Date().toISOString(), ':prev': 'READY' },
    ConditionExpression: '#s = :prev',
  }));

  return res(200, { orderId: id, status: 'ARCHIVED' });
}

async function rejectOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const body = JSON.parse(event.body || '{}');
  const r = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));
  if (!r.Item) return res(404, { error: 'Order not found' });
  if (r.Item.status !== 'PENDING') return res(400, { error: 'Only PENDING orders can be rejected' });

  await releaseFood(r.Item.items);

  await docClient.send(new UpdateCommand({
    TableName: ORDERS_TABLE,
    Key: { PK: `ORDER#${id}`, SK: 'META' },
    UpdateExpression: 'SET #s = :s, rejectionReason = :r, updatedAt = :u',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'CANCELLED', ':r': body.reason, ':u': new Date().toISOString() },
  }));

  return res(200, { orderId: id, status: 'CANCELLED' });
}

async function createWalkUp(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { customerName, items, discountType, notes } = body;
  if (!customerName || !items?.length) return res(400, { error: 'customerName and items required' });

  const settings = await getSettings();
  const orderItems: any[] = [];
  let totalAmount = 0;

  for (const item of items) {
    const menu = await getMenuItem(item.menuItemId);
    if (!menu || !menu.isActive || !menu.isEnabledToday) return res(400, { error: `Item ${item.menuItemId} unavailable` });

    if (menu.category === 'FOOD') {
      const available = (menu.foodQuantityToday || 0) - (menu.foodReserved || 0);
      if (available < (item.quantity || item.qty || 1)) return res(400, { error: `Insufficient stock for ${menu.name}` });
    }

    let unitPrice = menu.basePrice;
    let variantLabel = null;
    if (item.selectedVariants?.length) {
      for (const sv of item.selectedVariants) unitPrice += (sv.price || 0);
      variantLabel = item.selectedVariants.map((sv: any) => sv.option).join(', ');
    } else if (item.variant) {
      const variant = menu.variants?.find((v: any) => v.name === item.variant || v.id === item.variant);
      if (variant) unitPrice = menu.basePrice + (variant.priceModifier || 0);
      variantLabel = item.variant;
    }
    if (settings?.celebrationMode && menu.category === 'DRINK') unitPrice = settings.celebrationPrice;

    const qty = item.quantity || item.qty || 1;
    orderItems.push({ menuItemId: item.menuItemId, name: menu.name, variant: variantLabel, quantity: qty, unitPrice, category: menu.category });
    totalAmount += unitPrice * qty;
  }

  // Apply discount
  let discountOffset = 0;
  if (discountType && discountType !== 'NONE') {
    const originalTotal = totalAmount;
    totalAmount = 0;
    for (const oi of orderItems) {
      if (oi.category === 'DRINK') {
        const dp = discountType === 'STAFF' ? 5 : 0;
        totalAmount += dp * oi.quantity;
      } else {
        totalAmount += oi.unitPrice * oi.quantity;
      }
    }
    discountOffset = originalTotal - totalAmount;
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
      await checkSoldOut(oi.menuItemId);
    }
  }

  const orderId = uuid();
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + (settings?.orderExpiryMinutes || 30) * 60;

  await docClient.send(new PutCommand({
    TableName: ORDERS_TABLE,
    Item: {
      PK: `ORDER#${orderId}`, SK: 'META', orderId, customerName,
      items: orderItems, totalAmount, status: 'PREPARING',
      discountType: discountType || 'NONE', discountOffset,
      notes: notes || '',
      createdAt: now, updatedAt: now, expiresAt,
      isWalkUp: true, flaggedItems: [],
    },
  }));

  return res(201, { orderId, totalAmount, status: 'PREPARING' });
}

async function openCafe(): Promise<APIGatewayProxyResult> {
  await docClient.send(new UpdateCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: 'SETTINGS', SK: 'CONFIG' },
    UpdateExpression: 'SET cafeStatus = :s',
    ExpressionAttributeValues: { ':s': 'OPEN' },
  }));
  return res(200, { cafeStatus: 'OPEN' });
}

async function closeCafe(): Promise<APIGatewayProxyResult> {
  await docClient.send(new UpdateCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: 'SETTINGS', SK: 'CONFIG' },
    UpdateExpression: 'SET cafeStatus = :s',
    ExpressionAttributeValues: { ':s': 'CLOSED' },
  }));

  // Auto-expire all active orders on close
  const statuses = ['PENDING', 'PREPARING'];
  let expired = 0;
  for (const status of statuses) {
    const r = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
    }));
    for (const order of r.Items || []) {
      await docClient.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: order.PK, SK: order.SK },
        UpdateExpression: 'SET #s = :expired, updatedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':expired': 'EXPIRED', ':now': new Date().toISOString() },
      }));
      expired++;
    }
  }

  // Reset all food quantities for the day
  const menuItems = await docClient.send(new ScanCommand({
    TableName: MENU_TABLE,
    FilterExpression: 'category = :food',
    ExpressionAttributeValues: { ':food': 'FOOD' },
  }));
  for (const item of menuItems.Items || []) {
    await docClient.send(new UpdateCommand({
      TableName: MENU_TABLE,
      Key: { PK: item.PK, SK: item.SK },
      UpdateExpression: 'SET foodQuantityToday = :z, foodReserved = :z, isEnabledToday = :f',
      ExpressionAttributeValues: { ':z': 0, ':f': false },
    }));
  }

  // Send end-of-day summary email (fire and forget)
  sendDailySummaryEmail().catch(() => {});

  return res(200, { cafeStatus: 'CLOSED', expiredOrders: expired });
}

async function sendDailySummaryEmail() {
  const today = new Date().toISOString().split('T')[0];
  const statuses = ['PENDING', 'PREPARING', 'READY', 'ARCHIVED', 'EXPIRED', 'CANCELLED'];
  let allOrders: any[] = [];

  for (const status of statuses) {
    const r = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s AND createdAt >= :today',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':today': today },
    }));
    allOrders.push(...(r.Items || []));
  }

  const totalOrders = allOrders.length;
  const totalRevenue = allOrders.reduce((s, o) => s + (o.totalAmount || 0), 0);
  const totalOffsets = allOrders.reduce((s, o) => s + (o.discountOffset || 0), 0);
  const netExpected = totalRevenue - totalOffsets;
  const newcomersServed = allOrders.filter(o => o.discountType === 'NEWCOMER').length;

  const itemCounts: Record<string, number> = {};
  for (const o of allOrders) {
    for (const i of o.items || []) {
      const key = i.name + (i.variant ? ` (${i.variant})` : '');
      itemCounts[key] = (itemCounts[key] || 0) + (i.quantity || 1);
    }
  }
  const topItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, qty]) => ({ name, qty }));

  const ingredientResult = await docClient.send(new ScanCommand({
    TableName: INGREDIENTS_TABLE,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
    ExpressionAttributeValues: { ':prefix': 'INGREDIENT#', ':sk': 'META' },
  }));
  const lowStockItems = (ingredientResult.Items || [])
    .filter((i: any) => i.currentStock <= (i.lowStockThreshold || 0) && i.lowStockThreshold > 0)
    .map((i: any) => ({ name: i.name, currentStock: i.currentStock, unit: i.unit }));

  await sendEndOfDaySummary({ date: today, totalOrders, totalRevenue, totalOffsets, netExpected, newcomersServed, topItems, lowStockItems });
}

async function toggleCelebration(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  await docClient.send(new UpdateCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: 'SETTINGS', SK: 'CONFIG' },
    UpdateExpression: 'SET celebrationMode = :m',
    ExpressionAttributeValues: { ':m': body.enabled },
  }));
  return res(200, { celebrationMode: body.enabled });
}

async function toggleMenuItem(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing menu item id' });

  const menu = await getMenuItem(id);
  if (!menu) return res(404, { error: 'Menu item not found' });

  const newEnabled = !menu.isEnabledToday;
  await docClient.send(new UpdateCommand({
    TableName: MENU_TABLE,
    Key: { PK: `MENU#${id}`, SK: 'META' },
    UpdateExpression: 'SET isEnabledToday = :e',
    ExpressionAttributeValues: { ':e': newEnabled },
  }));

  // If disabling, flag pending orders containing this item
  if (!newEnabled) {
    const r = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'PENDING' },
    }));

    for (const order of r.Items || []) {
      const hasItem = order.items?.some((i: any) => i.menuItemId === id);
      if (hasItem) {
        const flagged = [...(order.flaggedItems || []), id];
        await docClient.send(new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { PK: `ORDER#${order.orderId}`, SK: 'META' },
          UpdateExpression: 'SET flaggedItems = :f',
          ExpressionAttributeValues: { ':f': flagged },
        }));
      }
    }
  }

  return res(200, { menuItemId: id, isEnabledToday: newEnabled });
}

async function checkSoldOut(menuItemId: string) {
  const item = await getMenuItem(menuItemId);
  if (!item) return;
  const available = (item.foodQuantityToday || 0) - (item.foodReserved || 0);
  if (available <= 0 && !item.soldOutAt) {
    await docClient.send(new UpdateCommand({
      TableName: MENU_TABLE,
      Key: { PK: `MENU#${menuItemId}`, SK: 'META' },
      UpdateExpression: 'SET soldOutAt = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));
  }
}

async function setFoodQuantity(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing menu item id' });

  const body = JSON.parse(event.body || '{}');
  const qty = typeof body.foodQuantityToday === 'number' ? body.foodQuantityToday : null;
  if (qty === null || qty < 0) return res(400, { error: 'Invalid quantity' });

  await docClient.send(new UpdateCommand({
    TableName: MENU_TABLE,
    Key: { PK: `MENU#${id}`, SK: 'META' },
    UpdateExpression: 'SET foodQuantityToday = :q',
    ExpressionAttributeValues: { ':q': qty },
  }));

  await checkSoldOut(id);
  return res(200, { menuItemId: id, foodQuantityToday: qty });
}

async function togglePin(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing menu item id' });

  const item = await getMenuItem(id);
  if (!item) return res(404, { error: 'Menu item not found' });

  const newPinned = !item.isPinned;
  await docClient.send(new UpdateCommand({
    TableName: MENU_TABLE,
    Key: { PK: `MENU#${id}`, SK: 'META' },
    UpdateExpression: 'SET isPinned = :p',
    ExpressionAttributeValues: { ':p': newPinned },
  }));

  return res(200, { menuItemId: id, isPinned: newPinned });
}

async function getInventory(): Promise<APIGatewayProxyResult> {
  const r = await docClient.send(new ScanCommand({ TableName: INGREDIENTS_TABLE }));
  return res(200, { ingredients: r.Items || [] });
}

async function adjustStock(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing ingredient id' });

  const body = JSON.parse(event.body || '{}');
  await docClient.send(new UpdateCommand({
    TableName: INGREDIENTS_TABLE,
    Key: { PK: `INGREDIENT#${id}`, SK: 'META' },
    UpdateExpression: 'SET currentStock = :s',
    ExpressionAttributeValues: { ':s': body.currentStock },
  }));

  return res(200, { ingredientId: id, currentStock: body.currentStock });
}

function extractSegment(path: string, pattern: RegExp, index: number): string | null {
  const match = path.match(pattern);
  return match ? match[index] : null;
}

export async function handlePos(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  if (method === 'GET' && path.endsWith('/pos/shift-summary')) return getShiftSummary();
  if (method === 'GET' && path === '/api/pos/orders') return listOrders(event);
  if (method === 'POST' && path === '/api/pos/orders') return createWalkUp(event);
  if (method === 'PUT' && path.endsWith('/approve')) {
    const id = extractSegment(path, /\/api\/pos\/orders\/([^/]+)\/approve/, 1);
    if (id) { event.pathParameters = { id }; return approveOrder(event); }
  }
  if (method === 'PUT' && path.endsWith('/ready')) {
    const id = extractSegment(path, /\/api\/pos\/orders\/([^/]+)\/ready/, 1);
    if (id) { event.pathParameters = { id }; return markReady(event); }
  }
  if (method === 'PUT' && path.endsWith('/undo')) {
    const id = extractSegment(path, /\/api\/pos\/orders\/([^/]+)\/undo/, 1);
    if (id) { event.pathParameters = { id }; return undoToPending(event); }
  }
  if (method === 'PUT' && path.endsWith('/archive')) {
    const id = extractSegment(path, /\/api\/pos\/orders\/([^/]+)\/archive/, 1);
    if (id) { event.pathParameters = { id }; return archiveOrder(event); }
  }
  if (method === 'PUT' && path.endsWith('/reject')) {
    const id = extractSegment(path, /\/api\/pos\/orders\/([^/]+)\/reject/, 1);
    if (id) { event.pathParameters = { id }; return rejectOrder(event); }
  }
  if (method === 'PUT' && path === '/api/pos/cafe/open') return openCafe();
  if (method === 'PUT' && path === '/api/pos/cafe/close') return closeCafe();
  if (method === 'PUT' && path === '/api/pos/cafe/celebration') return toggleCelebration(event);
  if (method === 'PUT' && path.match(/\/api\/pos\/menu\/[^/]+\/toggle$/)) {
    const id = extractSegment(path, /\/api\/pos\/menu\/([^/]+)\/toggle/, 1);
    if (id) { event.pathParameters = { id }; return toggleMenuItem(event); }
  }
  if (method === 'PUT' && path.match(/\/api\/pos\/menu\/[^/]+\/quantity$/)) {
    const id = extractSegment(path, /\/api\/pos\/menu\/([^/]+)\/quantity/, 1);
    if (id) { event.pathParameters = { id }; return setFoodQuantity(event); }
  }
  if (method === 'PUT' && path.match(/\/api\/pos\/menu\/[^/]+\/pin$/)) {
    const id = extractSegment(path, /\/api\/pos\/menu\/([^/]+)\/pin/, 1);
    if (id) { event.pathParameters = { id }; return togglePin(event); }
  }
  if (method === 'GET' && path === '/api/pos/inventory') return getInventory();
  if (method === 'GET' && path === '/api/pos/usage') return getUsageToday();
  if (method === 'PUT' && path.match(/\/api\/pos\/inventory\/[^/]+$/)) {
    const id = extractSegment(path, /\/api\/pos\/inventory\/([^/]+)/, 1);
    if (id) { event.pathParameters = { id }; return adjustStock(event); }
  }

  return res(404, { error: 'Not found' });
}

async function getUsageToday(): Promise<APIGatewayProxyResult> {
  const today = new Date().toISOString().split('T')[0];
  const logResult = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: `USAGE_LOG#${today}`, SK: 'META' },
  }));
  return res(200, { date: today, usage: logResult.Item?.usage || {} });
}
