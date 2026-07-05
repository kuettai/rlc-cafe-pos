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

/**
 * Called when a FOOD-containing order reaches a terminal "the food was
 * actually made" state — currently ARCHIVED (collected) and post-completion
 * CANCELLED coming out of READY. Decrements *both* `foodReserved` (release
 * the slot) and `foodQuantityToday` (the food is out of inventory whether
 * it got handed over or not; the kitchen already used it up).
 *
 * Drift note: counters may go negative if reservations have already drifted
 * from historical bugs. That's tolerated — the periodic
 * `scripts/reset-food-reserved.mjs` clean-up is the correct fix, not
 * clamping here (clamping could hide real accounting errors).
 */
async function consumeFoodOnCollection(items: any[]) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || item.category !== 'FOOD' || !item.menuItemId) continue;
    const qty = Number(item.quantity || item.qty || 1);
    if (!isFinite(qty) || qty <= 0) continue;
    try {
      await docClient.send(new UpdateCommand({
        TableName: MENU_TABLE,
        Key: { PK: `MENU#${item.menuItemId}`, SK: 'META' },
        UpdateExpression: 'SET foodReserved = foodReserved - :q, foodQuantityToday = foodQuantityToday - :q',
        ExpressionAttributeValues: { ':q': qty },
      }));
    } catch (e: any) {
      // Menu item deleted or attributes missing — log & keep going. Don't
      // fail the customer-facing state transition just because a legacy
      // record lacks the counter attribute.
      console.error('consumeFoodOnCollection failed for', item.menuItemId, e?.name || e);
    }
  }
}

async function getShiftSummary(): Promise<APIGatewayProxyResult> {
  const today = new Date().toISOString().slice(0, 10);
  // "Today's stats" spans two buckets:
  //   1. Orders created today across any status (normal customer + walk-up flow).
  //   2. Every currently-active order (PREPARING/READY) regardless of date —
  //      catches ministry pre-orders that were created yesterday for today's
  //      service and would otherwise be invisible in the dashboard.
  // Deduped by orderId so a today-created PREPARING order counts once.
  const todayStatuses  = ['PENDING', 'ARCHIVED'];
  const activeStatuses = ['PREPARING', 'READY'];
  const byId = new Map<string, any>();

  for (const status of todayStatuses) {
    const r = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s AND createdAt >= :today',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':today': today },
    }));
    for (const o of r.Items || []) {
      const key = String(o.orderId || o.PK);
      if (!byId.has(key)) byId.set(key, o);
    }
  }
  for (const status of activeStatuses) {
    const r = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
    }));
    for (const o of r.Items || []) {
      const key = String(o.orderId || o.PK);
      if (!byId.has(key)) byId.set(key, o);
    }
  }
  const allOrders = [...byId.values()];

  // Bucket by status for the granular dashboard. Revenue is over completed
  // states only (ARCHIVED + READY), and pre-orders are excluded from the
  // sale figures since MINISTRY_PREORDER always nets to zero.
  const pendingOrders   = allOrders.filter(o => o.status === 'PENDING').length;
  const preparingOrders = allOrders.filter(o => o.status === 'PREPARING').length;
  const readyOrders     = allOrders.filter(o => o.status === 'READY').length;
  const archivedOrders  = allOrders.filter(o => o.status === 'ARCHIVED').length;

  const paidCompleted = allOrders.filter(o =>
    o.status === 'ARCHIVED' || o.status === 'READY'
  );
  const completedOrders = paidCompleted.length;
  // `totalAmount` is already stored as net (post-discount) by approveOrder /
  // createWalkUp / createOrder. Sum directly for the real revenue collected.
  // Pre-orders contribute RM 0 (net), so including them in the completed
  // set inflates the count but not the revenue.
  const totalRevenue = paidCompleted.reduce((s, o) => s + Number(o.totalAmount || 0), 0);

  const totalOrders = allOrders.length; // includes pre-orders + PENDING/CANCELLED etc.
  const newcomersServed = allOrders.filter(o => o.discountType === 'NEWCOMER').length;

  const itemCount: Record<string, number> = {};
  for (const o of allOrders) {
    for (const i of o.items || []) {
      itemCount[i.name] = (itemCount[i.name] || 0) + (i.quantity || 1);
    }
  }
  const peakItem = Object.entries(itemCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

  return res(200, {
    totalOrders,
    totalRevenue,
    completedOrders,
    pendingOrders,
    preparingOrders,
    readyOrders,
    archivedOrders,
    newcomersServed,
    peakItem,
    closedAt: new Date().toISOString(),
  });
}

async function listOrders(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const search = event.queryStringParameters?.search?.toLowerCase();
  const includeAll = event.queryStringParameters?.all === 'true';
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

  // History view (?all=true) also needs completed/terminal states. Bound
  // the range to the last 7 days so we don't drag in months of records.
  if (includeAll) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    for (const status of ['ARCHIVED', 'CANCELLED', 'EXPIRED']) {
      const r = await docClient.send(new QueryCommand({
        TableName: ORDERS_TABLE,
        IndexName: 'status-createdAt-index',
        KeyConditionExpression: '#s = :s AND createdAt >= :cutoff',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status, ':cutoff': sevenDaysAgo },
        ScanIndexForward: false,
      }));
      allOrders.push(...(r.Items || []));
    }
  }

  if (search) {
    allOrders = allOrders.filter(o => o.customerName?.toLowerCase().includes(search));
  }

  if (includeAll) {
    // Sort newest first when returning the merged history view.
    allOrders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } else {
    // Live queue ordering: PENDING → PREPARING → READY, newest within each.
    const priority: Record<string, number> = { PENDING: 0, PREPARING: 1, READY: 2 };
    allOrders.sort((a, b) => (priority[a.status] ?? 3) - (priority[b.status] ?? 3));
  }

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

  // Celebration takes precedence: if the order was already priced under
  // celebration at create-time (discountType=CELEBRATION carried by
  // createOrder), a cashier-side STAFF/PASTOR/NEWCOMER discount is a no-op.
  // Preserve the CELEBRATION discountType + existing offset so reports keep
  // attributing the reduction correctly.
  const alreadyCelebrated = order.discountType === 'CELEBRATION';
  if (alreadyCelebrated) {
    discountType = 'CELEBRATION';
    discountOffset = Number(order.discountOffset || 0);
    // totalAmount already reflects the celebration price — leave it.
  } else if (body.discountType && body.discountType !== 'NONE') {
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
      UpdateExpression: 'SET #s = :s, approvedBy = :a, discountType = :dt, discountOffset = :do, totalAmount = :t, updatedAt = :u REMOVE expiresAt',
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

// Roll a READY order back to PREPARING — for when a cashier accidentally
// hit "Ready" too soon. Guarded so an already-archived/cancelled order
// isn't resurrected.
async function undoToPreparingFromReady(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  try {
    await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: `ORDER#${id}`, SK: 'META' },
      UpdateExpression: 'SET #s = :s, updatedAt = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'PREPARING', ':u': new Date().toISOString(), ':prev': 'READY' },
      ConditionExpression: '#s = :prev',
    }));
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') {
      return res(409, { error: 'Order is no longer in READY state' });
    }
    throw e;
  }

  return res(200, { orderId: id, status: 'PREPARING' });
}

async function archiveOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  // Race-safe status flip; ReturnValues=ALL_OLD gives us the items array
  // so we can consume the food after the transition commits.
  let old: any;
  try {
    const r = await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: `ORDER#${id}`, SK: 'META' },
      UpdateExpression: 'SET #s = :s, updatedAt = :u REMOVE expiresAt',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'ARCHIVED', ':u': new Date().toISOString(), ':prev': 'READY' },
      ConditionExpression: '#s = :prev',
      ReturnValues: 'ALL_OLD',
    }));
    old = r.Attributes;
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') {
      return res(409, { error: 'Order is not in READY state' });
    }
    throw e;
  }

  // Food was prepared and (presumably) served — release the reservation
  // AND deduct from today's quantity. Drinks/pre-orders naturally no-op
  // inside the helper (category filter).
  if (old && Array.isArray(old.items)) {
    await consumeFoodOnCollection(old.items);
  }

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
    UpdateExpression: 'SET #s = :s, rejectionReason = :r, updatedAt = :u REMOVE expiresAt',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'CANCELLED', ':r': body.reason, ':u': new Date().toISOString() },
  }));

  return res(200, { orderId: id, status: 'CANCELLED' });
}

// Cashier/admin-initiated cancel for orders that are already READY or
// ARCHIVED. Used as a "refund" mechanism when a wrong order was completed
// or never actually produced. Distinct from rejectOrder (which only acts
// on PENDING) and the customer-side cancel (also PENDING-only).
//
// Food reservations are intentionally NOT released — the items were
// physically prepared/consumed by the time the order reached READY, so
// returning them to inventory would double-count.
async function cancelCompletedOrder(event: APIGatewayProxyEvent, actor: string): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const body = JSON.parse(event.body || '{}');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return res(400, { error: 'reason is required' });
  if (reason.length > 200) return res(400, { error: 'reason cannot exceed 200 characters' });

  const existing = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));
  if (!existing.Item) return res(404, { error: 'Order not found' });
  if (existing.Item.status !== 'READY' && existing.Item.status !== 'ARCHIVED') {
    return res(400, { error: `Only READY or ARCHIVED orders can be cancelled here (current: ${existing.Item.status})` });
  }

  const now = new Date().toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: `ORDER#${id}`, SK: 'META' },
      UpdateExpression:
        'SET #s = :cancelled, cancelledAt = :now, cancelReason = :reason, ' +
        'cancelledBy = :actor, updatedAt = :now, postCompletionCancel = :true ' +
        'REMOVE expiresAt',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': 'CANCELLED',
        ':now': now,
        ':reason': reason,
        ':actor': actor,
        ':true': true,
        ':ready': 'READY',
        ':archived': 'ARCHIVED',
      },
      ConditionExpression: '#s = :ready OR #s = :archived',
    }));
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') {
      return res(409, { error: 'Order is no longer in a cancellable state' });
    }
    throw e;
  }

  const fresh = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));

  // Only consume food inventory if this was a READY → CANCELLED transition.
  // ARCHIVED orders already had their food deducted at collection time, so
  // cancelling them post-facto must NOT decrement again (would double-count).
  if (existing.Item.status === 'READY' && Array.isArray(existing.Item.items)) {
    await consumeFoodOnCollection(existing.Item.items);
  }

  return res(200, fresh.Item || { orderId: id, status: 'CANCELLED' });
}

async function createWalkUp(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { customerName, items, discountType, notes } = body;
  if (!customerName || !items?.length) return res(400, { error: 'customerName and items required' });

  const settings = await getSettings();
  const orderItems: any[] = [];
  let totalAmount = 0;

  let celebrationOffset = 0;

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
    const qty = item.quantity || item.qty || 1;
    // Celebration only applies to eligible drinks — matches createOrder /
    // frontend logic. Track the offset so we can tag the walk-up order as
    // discountType=CELEBRATION downstream.
    const grossUnit = unitPrice;
    if (
      settings?.celebrationMode &&
      menu.category === 'DRINK' &&
      menu.celebrationEligible === true
    ) {
      unitPrice = Number(settings.celebrationPrice) || 5;
      const perUnitDiscount = grossUnit - unitPrice;
      if (perUnitDiscount > 0) celebrationOffset += perUnitDiscount * qty;
    }

    orderItems.push({ menuItemId: item.menuItemId, name: menu.name, variant: variantLabel, quantity: qty, unitPrice, category: menu.category });
    totalAmount += unitPrice * qty;
  }

  // Apply cashier-selected discount, but only if celebration didn't already
  // reduce the price. STAFF/PASTOR/NEWCOMER on top of celebration is a no-op —
  // celebration is the final price (spec: fix-celebration-spec).
  let discountOffset = celebrationOffset;
  let effectiveDiscountType = discountType || 'NONE';
  if (celebrationOffset > 0) {
    effectiveDiscountType = 'CELEBRATION';
    // totalAmount already at celebration price; no further reduction.
  } else if (discountType && discountType !== 'NONE') {
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

  // Walk-ups start in PREPARING (skip PENDING). PENDING is the only status
  // that should carry a numeric TTL — writing one on a PREPARING record
  // would let DynamoDB TTL silently delete the order once the epoch passes,
  // wiping active/archived history. So: no expiresAt on walk-ups.
  await docClient.send(new PutCommand({
    TableName: ORDERS_TABLE,
    Item: {
      PK: `ORDER#${orderId}`, SK: 'META', orderId, customerName,
      items: orderItems, totalAmount, status: 'PREPARING',
      discountType: effectiveDiscountType, discountOffset,
      notes: notes || '',
      createdAt: now, updatedAt: now,
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

  const now = new Date().toISOString();

  // Expire PENDING orders — the cashier never approved them, so no sale
  // occurred. Pre-orders skip PENDING entirely so this doesn't affect them.
  // Guarded with a status precondition so a cashier approving mid-close
  // doesn't get their order silently flipped to EXPIRED.
  let expired = 0;
  const pendingResult = await docClient.send(new QueryCommand({
    TableName: ORDERS_TABLE,
    IndexName: 'status-createdAt-index',
    KeyConditionExpression: '#s = :s',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'PENDING' },
  }));
  for (const order of pendingResult.Items || []) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: order.PK, SK: order.SK },
        UpdateExpression: 'SET #s = :expired, updatedAt = :now REMOVE expiresAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':expired': 'EXPIRED', ':now': now, ':prev': 'PENDING' },
        ConditionExpression: '#s = :prev',
      }));
      expired++;
    } catch (e: any) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      // Order status changed under us — leave it alone.
    }
  }

  // Archive PREPARING + READY orders — the sale is already committed
  // (approved and/or prepared) so end-of-day should close them out cleanly.
  // Race-guarded so any cashier action mid-close is preserved.
  let archivedOrders = 0;
  for (const status of ['PREPARING', 'READY']) {
    const r = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
    }));
    for (const order of r.Items || []) {
      try {
        await docClient.send(new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { PK: order.PK, SK: order.SK },
          UpdateExpression: 'SET #s = :archived, updatedAt = :now REMOVE expiresAt',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':archived': 'ARCHIVED', ':now': now, ':prev': status },
          ConditionExpression: '#s = :prev',
        }));
        archivedOrders++;
      } catch (e: any) {
        if (e.name !== 'ConditionalCheckFailedException') throw e;
        // Status changed (cashier action) — silently skip.
      }
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

  return res(200, { cafeStatus: 'CLOSED', expiredOrders: expired, archivedOrders });
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

// Cashier view of the menu: every item that's still admin-active
// (isActive = true), regardless of the day's isEnabledToday flag. Distinct
// from the public GET /api/menu which additionally filters by isEnabledToday
// — cashiers need to see disabled items so they can toggle them back on.
async function listCashierMenu(): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(new ScanCommand({
    TableName: MENU_TABLE,
    FilterExpression: 'isActive = :active',
    ExpressionAttributeValues: { ':active': true },
  }));
  const items = (result.Items || [])
    .filter((i: any) => i.SK === 'META')
    .sort((a: any, b: any) => {
      const ca = a.category || '';
      const cb = b.category || '';
      if (ca !== cb) return ca.localeCompare(cb);
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
  return res(200, { items });
}

// Slim ingredient list for the cashier stock-count GUI. Only the fields the
// counter UI needs, plus lastCountedAt for the "last updated" hint.
async function listIngredientsForCount(): Promise<APIGatewayProxyResult> {
  const r = await docClient.send(new ScanCommand({
    TableName: INGREDIENTS_TABLE,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
    ExpressionAttributeValues: { ':prefix': 'INGREDIENT#', ':sk': 'META' },
  }));
  const ingredients = (r.Items || []).map((i: any) => ({
    ingredientId: i.ingredientId,
    name: i.name,
    unit: i.unit,
    currentStock: typeof i.currentStock === 'number' ? i.currentStock : Number(i.currentStock) || 0,
    storageLocation: i.storageLocation || null,
    lowStockThreshold: i.lowStockThreshold || 0,
    lastCountedAt: i.lastCountedAt || null,
    lastCountedBy: i.lastCountedBy || null,
  }));
  // Sort: by location then by name for deterministic UI ordering
  ingredients.sort((a: any, b: any) => {
    const la = (a.storageLocation || '~').toString();
    const lb = (b.storageLocation || '~').toString();
    if (la !== lb) return la.localeCompare(lb);
    return (a.name || '').localeCompare(b.name || '');
  });
  return res(200, { ingredients });
}

// Bulk stock-count update from the cashier UI. Writes each new
// currentStock and appends a snapshot record so admins can backtrace
// end-of-day counts. Snapshots live in SETTINGS_TABLE under a new PK
// pattern (STOCK_SNAPSHOT#<date>) with the ISO timestamp as SK.
async function bulkUpdateStock(event: APIGatewayProxyEvent, actor: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const counts: any[] = Array.isArray(body.counts) ? body.counts : [];
  if (counts.length === 0) return res(400, { error: 'counts array required' });

  const now = new Date().toISOString();
  const today = now.split('T')[0];
  const snapshotEntries: any[] = [];
  const errors: any[] = [];

  for (const c of counts) {
    if (!c || !c.ingredientId) { errors.push({ ingredientId: c?.ingredientId, error: 'missing ingredientId' }); continue; }
    const cnt = typeof c.count === 'number' ? c.count : Number(c.count);
    if (!isFinite(cnt) || cnt < 0) { errors.push({ ingredientId: c.ingredientId, error: 'invalid count' }); continue; }

    const existing = await docClient.send(new GetCommand({
      TableName: INGREDIENTS_TABLE,
      Key: { PK: `INGREDIENT#${c.ingredientId}`, SK: 'META' },
    }));
    if (!existing.Item) { errors.push({ ingredientId: c.ingredientId, error: 'not found' }); continue; }

    await docClient.send(new UpdateCommand({
      TableName: INGREDIENTS_TABLE,
      Key: { PK: `INGREDIENT#${c.ingredientId}`, SK: 'META' },
      UpdateExpression: 'SET currentStock = :s, lastCountedAt = :t, lastCountedBy = :u',
      ExpressionAttributeValues: { ':s': cnt, ':t': now, ':u': actor || 'Unknown' },
    }));

    snapshotEntries.push({
      ingredientId: c.ingredientId,
      name: existing.Item.name,
      unit: existing.Item.unit,
      storageLocation: existing.Item.storageLocation || null,
      count: cnt,
      previousCount: typeof existing.Item.currentStock === 'number' ? existing.Item.currentStock : null,
    });
  }

  if (snapshotEntries.length > 0) {
    await docClient.send(new PutCommand({
      TableName: SETTINGS_TABLE,
      Item: {
        PK: `STOCK_SNAPSHOT#${today}`,
        SK: now,
        date: today,
        timestamp: now,
        submittedBy: actor || 'Unknown',
        counts: snapshotEntries,
      },
    }));
  }

  return res(200, { updated: snapshotEntries.length, timestamp: now, errors });
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

export async function handlePos(event: APIGatewayProxyEvent, actor: string = ''): Promise<APIGatewayProxyResult> {
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
  if (method === 'PUT' && path.endsWith('/undo-ready')) {
    // Rollback for a cashier mis-tap of "Ready" — flips READY → PREPARING.
    const id = extractSegment(path, /\/api\/pos\/orders\/([^/]+)\/undo-ready/, 1);
    if (id) { event.pathParameters = { id }; return undoToPreparingFromReady(event); }
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
  if (method === 'POST' && path.endsWith('/cancel-completed')) {
    const id = extractSegment(path, /\/api\/pos\/orders\/([^/]+)\/cancel-completed/, 1);
    if (id) { event.pathParameters = { id }; return cancelCompletedOrder(event, actor); }
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
  if (method === 'GET' && path === '/api/pos/menu') return listCashierMenu();
  if (method === 'GET' && path === '/api/pos/ingredients') return listIngredientsForCount();
  if (method === 'PUT' && path === '/api/pos/ingredients/bulk-update') return bulkUpdateStock(event, actor);
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
