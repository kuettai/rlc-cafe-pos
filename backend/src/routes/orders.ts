import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuid } from 'uuid';
import { docClient, ORDERS_TABLE, MENU_TABLE, SETTINGS_TABLE, GetCommand, PutCommand, UpdateCommand, ScanCommand } from '../lib/db';
import { linkOrderToCustomer } from './customers';
import { normalizePhone } from '../lib/phone';
import { validatePreorderCode } from './preorder';

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
  const { customerName, items, notes, customerId, preorderCode, collectionTime } = body;
  if (!customerName || !items?.length) return res(400, { error: 'customerName and items required' });

  // If a customerId (phone) is supplied, normalize it so the order's
  // GSI key matches the customer record's PK exactly. An invalid value
  // is dropped silently — anonymous orders are always allowed.
  const normalizedCustomerId = customerId ? normalizePhone(customerId) : null;

  const settings = await getSettings();

  // ─── Pre-order branch ────────────────────────────────────────────
  // Ministry pre-orders (link with a code) bypass the café-open check
  // and are always free. Drinks only — the workflow does not reserve
  // FOOD stock ahead of Sunday.
  let preorderRecord: any = null;
  if (preorderCode) {
    const v = await validatePreorderCode(String(preorderCode));
    if (!v.valid) return res(400, { error: `Pre-order code ${v.reason}` });
    preorderRecord = v.code;
  } else {
    if (!settings || settings.cafeStatus !== 'OPEN') return res(403, { error: 'Cafe is not open' });
  }

  const orderItems: any[] = [];
  let totalAmount = 0;
  // Celebration discount is applied per-eligible-drink at create time.
  // We track the offset so the order record carries `discountType=CELEBRATION`
  // + `discountOffset=<sum of grossUnit - celebrationPrice, per qty>` in the
  // same shape as other discount paths (STAFF/PASTOR/NEWCOMER via approveOrder).
  let celebrationOffset = 0;

  for (const item of items) {
    const menu = await getMenuItem(item.menuItemId);
    if (!menu) return res(400, { error: `Item ${item.menuItemId} not found` });
    if (!menu.isActive) return res(400, { error: `${menu.name} is not available` });
    if (!menu.isEnabledToday) return res(400, { error: `${menu.name} is not available today` });

    if (preorderRecord && menu.category !== 'DRINK') {
      return res(400, { error: `Pre-orders can only include drinks (${menu.name} is ${menu.category})` });
    }

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
    // Apply celebration price ONLY to celebration-eligible drinks (matches
    // the frontend's price-display logic). Previously this discounted
    // every DRINK category item, silently dropping non-eligible drinks
    // to the celebration price.
    const grossUnit = unitPrice;
    if (
      settings?.celebrationMode &&
      menu.category === 'DRINK' &&
      menu.celebrationEligible === true
    ) {
      unitPrice = Number(settings.celebrationPrice) || 5;
      const perUnitDiscount = grossUnit - unitPrice;
      if (perUnitDiscount > 0) {
        celebrationOffset += perUnitDiscount * item.quantity;
      }
    }

    orderItems.push({ menuItemId: item.menuItemId, name: menu.name, variant: variantLabel, quantity: item.quantity, unitPrice, category: menu.category });
    totalAmount += unitPrice * item.quantity;
  }

  // Reserve food (pre-orders are drinks-only so this loop is a no-op there)
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

  // Compose notes (prepend collection time for pre-orders so the cashier
  // sees it at a glance in the queue).
  const trimmedNotes = typeof notes === 'string' ? notes : '';
  const composedNotes = preorderRecord && collectionTime
    ? `Collect: ${collectionTime} | ${trimmedNotes}`.trim().replace(/\|\s*$/, '').trim()
    : trimmedNotes;

  const orderItem: any = preorderRecord
    ? {
        // ── Pre-order: PREPARING immediately, always free, expires at
        // serviceEndTime (ISO). DynamoDB TTL ignores non-numeric values
        // so the record persists through service.
        //
        // Storage convention (matches approveOrder / createWalkUp): `totalAmount`
        // is stored as NET (what's actually collected — RM 0 here) and
        // `discountOffset` records the discount applied (the full item price
        // sum). This keeps aggregation formulas across the codebase valid
        // without special-casing pre-orders.
        PK: `ORDER#${orderId}`, SK: 'META', orderId, customerName,
        items: orderItems,
        totalAmount: 0,
        status: 'PREPARING',
        notes: composedNotes,
        discountType: 'MINISTRY_PREORDER',
        discountOffset: totalAmount, // full gross → net 0
        grossAmount: totalAmount,    // kept for auditability / reports
        createdAt: now, updatedAt: now,
        expiresAt: preorderRecord.serviceEndTime,
        isPreOrder: true,
        preorderCode: preorderRecord.code,
        isWalkUp: false, flaggedItems: [],
      }
    : {
        // ── Regular customer order: PENDING with a short (30-min) TTL
        // for auto-cleanup if the cashier never approves. If celebration
        // mode reduced any eligible drink prices, tag the discount here
        // so reports can attribute the offset (matches STAFF/PASTOR/NEWCOMER
        // convention where discountType/discountOffset live on the order).
        PK: `ORDER#${orderId}`, SK: 'META', orderId, customerName,
        items: orderItems, totalAmount, status: 'PENDING',
        notes: composedNotes,
        discountType: celebrationOffset > 0 ? 'CELEBRATION' : 'NONE',
        discountOffset: celebrationOffset,
        createdAt: now, updatedAt: now,
        expiresAt: Math.floor(Date.now() / 1000) + ((settings?.orderExpiryMinutes || 30) * 60),
        isWalkUp: false, flaggedItems: [],
      };
  if (normalizedCustomerId) orderItem.customerId = normalizedCustomerId;

  await docClient.send(new PutCommand({ TableName: ORDERS_TABLE, Item: orderItem }));

  if (normalizedCustomerId) {
    await linkOrderToCustomer(normalizedCustomerId, orderId, totalAmount);
  }

  return res(201, {
    orderId,
    totalAmount: orderItem.totalAmount,
    status: orderItem.status,
    isPreOrder: !!preorderRecord,
  });
}

async function getOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const r = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));
  if (!r.Item) return res(404, { error: 'Order not found' });

  const o = r.Item;
  return res(200, { orderId: o.orderId, customerName: o.customerName, items: o.items, totalAmount: o.totalAmount, status: o.status, notes: o.notes || '', flaggedItems: o.flaggedItems, createdAt: o.createdAt, updatedAt: o.updatedAt, modifiedAt: o.modifiedAt, receiptUrl: o.receiptUrl, receiptAmount: o.receiptAmount });
}

async function modifyOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const body = JSON.parse(event.body || '{}');
  const r = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));
  if (!r.Item) return res(404, { error: 'Order not found' });
  if (r.Item.status !== 'PENDING') return res(400, { error: 'Order cannot be modified' });

  const order = r.Item;
  const now = new Date().toISOString();

  // ─── CANCEL ────────────────────────────────────────────────────────
  if (body.action === 'cancel') {
    // Atomic status flip first; only release food if the flip succeeds.
    // ConditionExpression catches the race where a cashier just approved.
    try {
      await docClient.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: `ORDER#${id}`, SK: 'META' },
        UpdateExpression: 'SET #s = :s, updatedAt = :u REMOVE expiresAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'CANCELLED', ':u': now, ':pending': 'PENDING' },
        ConditionExpression: '#s = :pending',
      }));
    } catch (e: any) {
      if (e.name === 'ConditionalCheckFailedException') {
        return res(409, { error: 'Order is no longer modifiable' });
      }
      throw e;
    }
    await releaseFood(order.items);
    return res(200, { orderId: id, status: 'CANCELLED' });
  }

  // ─── UPDATE ────────────────────────────────────────────────────────
  if (body.action === 'update' && body.items?.length) {
    // Validate optional notes (max 200 chars, must be string).
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string') return res(400, { error: 'notes must be a string' });
      if (body.notes.length > 200) return res(400, { error: 'notes cannot exceed 200 characters' });
    }

    // Validate new items + compute new total. No DB writes yet.
    const settings = await getSettings();
    const newItems: any[] = [];
    let totalAmount = 0;
    let celebrationOffset = 0;

    for (const item of body.items) {
      const menu = await getMenuItem(item.menuItemId);
      if (!menu) return res(400, { error: `Item ${item.menuItemId} not found` });
      if (!menu.isActive) return res(400, { error: `${menu.name} is not available` });
      if (!menu.isEnabledToday) return res(400, { error: `${menu.name} is not available today` });

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
      const grossUnit = unitPrice;
      if (
        settings?.celebrationMode &&
        menu.category === 'DRINK' &&
        menu.celebrationEligible === true
      ) {
        unitPrice = Number(settings.celebrationPrice) || 5;
        const perUnitDiscount = grossUnit - unitPrice;
        if (perUnitDiscount > 0) {
          celebrationOffset += perUnitDiscount * item.quantity;
        }
      }

      newItems.push({ menuItemId: item.menuItemId, name: menu.name, variant: variantLabel, quantity: item.quantity, unitPrice, category: menu.category });
      totalAmount += unitPrice * item.quantity;
    }

    // Build the conditional update. modifiedAt is stamped so the cashier UI
    // can show a "modified moments ago" indicator + approve guard. Include
    // the recomputed celebration offset so the discount tracking on the
    // modified order stays consistent with a freshly-created one.
    const exprValues: Record<string, any> = {
      ':items': newItems,
      ':t': totalAmount,
      ':u': now,
      ':pending': 'PENDING',
      ':dt': celebrationOffset > 0 ? 'CELEBRATION' : 'NONE',
      ':do': celebrationOffset,
    };
    let updateExpr = 'SET items = :items, totalAmount = :t, updatedAt = :u, modifiedAt = :u, discountType = :dt, discountOffset = :do';
    if (body.notes !== undefined) {
      updateExpr += ', notes = :n';
      exprValues[':n'] = body.notes;
    }

    try {
      await docClient.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: `ORDER#${id}`, SK: 'META' },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: exprValues,
        ConditionExpression: '#s = :pending',
      }));
    } catch (e: any) {
      if (e.name === 'ConditionalCheckFailedException') {
        return res(409, { error: 'Order is no longer modifiable' });
      }
      throw e;
    }

    // Adjust food reservations only after the order update committed.
    // If a foodReserved write fails partway, we accept the inconsistency
    // — the cron will release stale reservations on EXPIRED orders, and
    // the alternative (rolling back the order update) is worse.
    await releaseFood(order.items);
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

    return res(200, { orderId: id, totalAmount, status: 'PENDING', modifiedAt: now });
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
