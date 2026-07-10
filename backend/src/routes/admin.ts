import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuid } from 'uuid';
import {
  docClient, ORDERS_TABLE, MENU_TABLE, SETTINGS_TABLE, INGREDIENTS_TABLE, USERS_TABLE,
  GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand, DeleteCommand
} from '../lib/db';
import { hashPin } from '../lib/auth';

function extractId(path: string, segment: string): string {
  const parts = path.split('/');
  const idx = parts.indexOf(segment);
  return parts[idx + 1] || '';
}

function res(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function handleAdmin(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // Menu
    if (method === 'GET' && path.endsWith('/admin/menu')) {
      // Admin sees ALL items (active + inactive) — unlike GET /api/menu
      // which filters to isActive && isEnabledToday for customers.
      const scan = await docClient.send(new ScanCommand({ TableName: MENU_TABLE }));
      const items = (scan.Items || [])
        .filter(i => i.SK === 'META')
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      return res(200, { items });
    }

    if (method === 'POST' && path.endsWith('/admin/menu')) {
      const menuItemId = uuid();
      const item: any = {
        PK: `MENU#${menuItemId}`, SK: 'META', menuItemId,
        name: body.name, category: body.category, basePrice: body.basePrice,
        variants: body.variants || [], variantGroups: body.variantGroups || [],
        imageUrl: body.imageUrl || null,
        sortOrder: body.sortOrder || 0, isActive: true, isEnabledToday: true
      };
      if (body.celebrationEligible !== undefined) item.celebrationEligible = body.celebrationEligible;
      await docClient.send(new PutCommand({ TableName: MENU_TABLE, Item: item }));
      return res(201, item);
    }

    if (method === 'PUT' && path.endsWith('/admin/menu/bulk-toggle')) {
      const { enable, category } = body;
      const scan = await docClient.send(new ScanCommand({ TableName: MENU_TABLE }));
      const items = (scan.Items || []).filter(i => i.SK === 'META' && (!category || i.category === category));
      for (const item of items) {
        await docClient.send(new UpdateCommand({
          TableName: MENU_TABLE, Key: { PK: item.PK, SK: 'META' },
          UpdateExpression: 'SET #e = :e',
          ExpressionAttributeNames: { '#e': 'isEnabledToday' },
          ExpressionAttributeValues: { ':e': !!enable }
        }));
      }
      return res(200, { updated: items.length });
    }

    if (method === 'POST' && path.endsWith('/admin/menu/duplicate-food')) {
      const scan = await docClient.send(new ScanCommand({ TableName: MENU_TABLE }));
      const foods = (scan.Items || []).filter(i => i.SK === 'META' && i.category === 'FOOD');
      const duplicated: { name: string; foodQuantityToday: number }[] = [];
      for (const item of foods) {
        const qty = item.foodQuantityToday || 0;
        await docClient.send(new UpdateCommand({
          TableName: MENU_TABLE, Key: { PK: item.PK, SK: 'META' },
          UpdateExpression: 'SET #e = :e, #r = :r',
          ExpressionAttributeNames: { '#e': 'isEnabledToday', '#r': 'foodReserved' },
          ExpressionAttributeValues: { ':e': true, ':r': 0 }
        }));
        duplicated.push({ name: item.name, foodQuantityToday: qty });
      }
      return res(200, { duplicated: duplicated.length, items: duplicated });
    }

    if (method === 'PUT' && /\/admin\/menu\/[^/]+\/toggle-active$/.test(path)) {
      // Flip isActive on a single menu item. Must come BEFORE the generic
      // /admin/menu/{id} PUT so the path doesn't get swallowed.
      const parts = path.split('/');
      const id = parts[parts.length - 2]; // .../menu/{id}/toggle-active
      const existing = await docClient.send(new GetCommand({
        TableName: MENU_TABLE, Key: { PK: `MENU#${id}`, SK: 'META' }
      }));
      if (!existing.Item) return res(404, { error: 'Menu item not found' });
      const next = !(existing.Item.isActive === true);
      const updated = await docClient.send(new UpdateCommand({
        TableName: MENU_TABLE, Key: { PK: `MENU#${id}`, SK: 'META' },
        UpdateExpression: 'SET isActive = :a',
        ExpressionAttributeValues: { ':a': next },
        ReturnValues: 'ALL_NEW'
      }));
      return res(200, updated.Attributes || { menuItemId: id, isActive: next });
    }

    if (method === 'PUT' && /\/admin\/menu\/[^/]+$/.test(path)) {
      const id = extractId(path, 'menu');
      const fields: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        fields.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
      await docClient.send(new UpdateCommand({
        TableName: MENU_TABLE, Key: { PK: `MENU#${id}`, SK: 'META' },
        UpdateExpression: `SET ${fields.join(', ')}`,
        ExpressionAttributeNames: names, ExpressionAttributeValues: values
      }));
      return res(200, { menuItemId: id, updated: Object.keys(body) });
    }

    if (method === 'DELETE' && /\/admin\/menu\/[^/]+$/.test(path)) {
      const id = extractId(path, 'menu');
      await docClient.send(new DeleteCommand({ TableName: MENU_TABLE, Key: { PK: `MENU#${id}`, SK: 'META' } }));
      return res(200, { deleted: id });
    }

    // Ingredients
    if (method === 'POST' && path.endsWith('/admin/ingredients')) {
      const ingredientId = uuid();
      const item = {
        PK: `INGREDIENT#${ingredientId}`, SK: 'META', ingredientId,
        name: body.name, unit: body.unit, usageUnit: body.usageUnit || null,
        currentStock: body.currentStock,
        lowStockThreshold: body.lowStockThreshold, storageLocation: body.storageLocation,
        // isActive=false means the ingredient is temporarily disabled.
        // Drinks that use it should be manually toggled off from the Menu tab
        // (no automatic linkage — recipes → menu mapping isn't in the schema).
        isActive: true,
      };
      await docClient.send(new PutCommand({ TableName: INGREDIENTS_TABLE, Item: item }));
      return res(201, item);
    }

    if (method === 'PUT' && /\/admin\/ingredients\/[^/]+\/toggle-active$/.test(path)) {
      // Flip isActive on a single ingredient. Placed BEFORE the generic
      // /admin/ingredients/{id} PUT so path routing is unambiguous.
      const parts = path.split('/');
      const id = parts[parts.length - 2]; // .../ingredients/{id}/toggle-active
      const existing = await docClient.send(new GetCommand({
        TableName: INGREDIENTS_TABLE, Key: { PK: `INGREDIENT#${id}`, SK: 'META' }
      }));
      if (!existing.Item) return res(404, { error: 'Ingredient not found' });
      // Treat missing isActive as true (legacy rows before this field existed).
      const currentActive = existing.Item.isActive !== false;
      const next = !currentActive;
      const updated = await docClient.send(new UpdateCommand({
        TableName: INGREDIENTS_TABLE, Key: { PK: `INGREDIENT#${id}`, SK: 'META' },
        UpdateExpression: 'SET isActive = :a',
        ExpressionAttributeValues: { ':a': next },
        ReturnValues: 'ALL_NEW'
      }));
      return res(200, updated.Attributes || { ingredientId: id, isActive: next });
    }

    if (method === 'PUT' && /\/admin\/ingredients\/[^/]+$/.test(path)) {
      const id = extractId(path, 'ingredients');
      const fields: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        fields.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
      await docClient.send(new UpdateCommand({
        TableName: INGREDIENTS_TABLE, Key: { PK: `INGREDIENT#${id}`, SK: 'META' },
        UpdateExpression: `SET ${fields.join(', ')}`,
        ExpressionAttributeNames: names, ExpressionAttributeValues: values
      }));
      return res(200, { ingredientId: id, updated: Object.keys(body) });
    }

    if (method === 'DELETE' && /\/admin\/ingredients\/[^/]+$/.test(path)) {
      const id = extractId(path, 'ingredients');
      await docClient.send(new DeleteCommand({ TableName: INGREDIENTS_TABLE, Key: { PK: `INGREDIENT#${id}`, SK: 'META' } }));
      return res(200, { deleted: id });
    }

    // Recipes
    if (method === 'GET' && path.endsWith('/admin/recipes')) {
      const r = await docClient.send(new ScanCommand({ TableName: INGREDIENTS_TABLE }));
      const recipes = (r.Items || []).filter(i => i.PK?.startsWith('RECIPE#'));
      return res(200, { recipes });
    }

    if (method === 'POST' && path.endsWith('/admin/recipes')) {
      const { menuItemId, variantId, ingredients } = body;
      const recipeKey = `RECIPE#${menuItemId}#${variantId || 'default'}`;
      // Delete existing recipe entries first
      const existing = await docClient.send(new QueryCommand({
        TableName: INGREDIENTS_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': recipeKey },
      }));
      for (const item of (existing.Items || [])) {
        await docClient.send(new DeleteCommand({ TableName: INGREDIENTS_TABLE, Key: { PK: item.PK, SK: item.SK } }));
      }
      // Write new entries
      for (const ing of ingredients) {
        await docClient.send(new PutCommand({
          TableName: INGREDIENTS_TABLE,
          Item: { PK: recipeKey, SK: `INGREDIENT#${ing.ingredientId}`, ingredientId: ing.ingredientId, quantity: ing.quantity }
        }));
      }
      return res(201, { recipeKey, ingredients });
    }

    // Users
    if (method === 'GET' && path.endsWith('/admin/users')) {
      const r = await docClient.send(new ScanCommand({ TableName: USERS_TABLE }));
      const users = (r.Items || []).map(u => ({ userId: u.userId, name: u.name, role: u.role, isActive: u.isActive, lastLoginAt: u.lastLoginAt }));
      return res(200, { users });
    }

    if (method === 'POST' && path.endsWith('/admin/users')) {
      const pin = body.pin;
      if (!pin || String(pin).length < 6) {
        return res(400, { error: 'pin required (min 6 digits)' });
      }
      const userId = uuid();
      const item = {
        PK: `USER#${userId}`, SK: 'META', userId,
        name: body.name,
        nameLower: typeof body.name === 'string' ? body.name.toLowerCase().trim() : body.name,
        pinHash: hashPin(pin), role: body.role, isActive: true, forceUpdatePin: true
      };
      await docClient.send(new PutCommand({ TableName: USERS_TABLE, Item: item }));
      return res(201, { userId, name: body.name, role: body.role });
    }

    if (method === 'PUT' && /\/admin\/users\/[^/]+$/.test(path)) {
      const id = extractId(path, 'users');
      const updates = { ...body };
      if (updates.pin) {
        if (String(updates.pin).length < 6) {
          return res(400, { error: 'pin must be at least 6 digits' });
        }
        updates.pinHash = hashPin(updates.pin);
        updates.forceUpdatePin = true;
        delete updates.pin;
      }
      // Keep nameLower in sync with name so the login fallback scan can
      // match case-insensitively without touching every existing record.
      if (typeof updates.name === 'string') {
        updates.nameLower = updates.name.toLowerCase().trim();
      }
      const fields: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(updates)) {
        fields.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
      await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE, Key: { PK: `USER#${id}`, SK: 'META' },
        UpdateExpression: `SET ${fields.join(', ')}`,
        ExpressionAttributeNames: names, ExpressionAttributeValues: values
      }));
      return res(200, { userId: id, updated: Object.keys(updates) });
    }

    if (method === 'DELETE' && /\/admin\/users\/[^/]+$/.test(path)) {
      const id = extractId(path, 'users');
      await docClient.send(new DeleteCommand({ TableName: USERS_TABLE, Key: { PK: `USER#${id}`, SK: 'META' } }));
      return res(200, { deleted: id });
    }

    // Settings
    if (method === 'GET' && path.endsWith('/admin/settings')) {
      const result = await docClient.send(new GetCommand({ TableName: SETTINGS_TABLE, Key: { PK: 'SETTINGS', SK: 'CONFIG' } }));
      return res(200, result.Item || {});
    }

    if (method === 'PUT' && path.endsWith('/admin/settings')) {
      const fields: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        fields.push(`#${k} = :${k}`);
        names[`#${k}`] = k;
        values[`:${k}`] = v;
      }
      await docClient.send(new UpdateCommand({
        TableName: SETTINGS_TABLE, Key: { PK: 'SETTINGS', SK: 'CONFIG' },
        UpdateExpression: `SET ${fields.join(', ')}`,
        ExpressionAttributeNames: names, ExpressionAttributeValues: values
      }));
      return res(200, { updated: Object.keys(body) });
    }

    // Reports
    // Date-range report — returns the orders we treat as "completed activity"
    // for reconciliation: ARCHIVED + READY (sale lines) and post-completion
    // CANCELLED (refund lines). Pure PENDING / PREPARING orders are excluded
    // because they're not yet committed; PENDING-stage rejections are also
    // excluded because they never produced a real transaction.
    if (method === 'GET' && path === '/api/admin/reports') {
      const qs = event.queryStringParameters || {};
      const startDate = qs.startDate;
      const endDate = qs.endDate;
      if (!startDate || !endDate) {
        return res(400, { error: 'startDate and endDate query params required (YYYY-MM-DD)' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res(400, { error: 'startDate / endDate must be YYYY-MM-DD' });
      }
      if (endDate < startDate) {
        return res(400, { error: 'endDate must be on or after startDate' });
      }

      // Inclusive whole-day range. createdAt is stored as UTC ISO; the
      // YYYY-MM-DD prefix is treated as a UTC day boundary which matches
      // the rest of the reporting code (see /reports/daily).
      const startIso = `${startDate}T00:00:00.000Z`;
      const endIso   = `${endDate}T23:59:59.999Z`;

      // Include PREPARING alongside the completed statuses so the reports
      // detail view surfaces active orders (matches the Today's Stats
      // "active orders visible" behavior). PREPARING orders don't affect
      // reconciliation totals unless they're in the reporting window, but
      // showing them helps admins spot orders that never got closed out.
      const statuses = ['ARCHIVED', 'READY', 'PREPARING', 'CANCELLED'];
      const allOrders: any[] = [];
      for (const status of statuses) {
        // Paginate: a single Query returns at most 1MB; large windows can
        // silently truncate results without an ExclusiveStartKey loop.
        const items: any[] = [];
        let lastKey: Record<string, any> | undefined = undefined;
        do {
          const result: any = await docClient.send(new QueryCommand({
            TableName: ORDERS_TABLE,
            IndexName: 'status-createdAt-index',
            KeyConditionExpression: '#s = :s AND createdAt BETWEEN :start AND :end',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':s': status, ':start': startIso, ':end': endIso },
            ExclusiveStartKey: lastKey,
          }));
          items.push(...(result.Items || []));
          lastKey = result.LastEvaluatedKey;
        } while (lastKey);

        if (status === 'CANCELLED') {
          // Only post-completion cancels are reportable as refunds.
          // PENDING-stage rejections also land in CANCELLED but carry
          // rejectionReason instead of postCompletionCancel.
          for (const o of items) {
            if (o.postCompletionCancel === true) allOrders.push(o);
          }
        } else {
          allOrders.push(...items);
        }
      }

      allOrders.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      return res(200, { orders: allOrders, startDate, endDate });
    }

    if (method === 'GET' && path.endsWith('/admin/reports/discounts')) {
      // Scope to today's completed sales only, so the Discount & Offset
      // Summary reconciles with Today's Summary above it in the UI.
      // Previously scanned the entire table across all months / statuses
      // which led to numbers that couldn't be cross-checked with the
      // daily card.
      const today = new Date().toISOString().split('T')[0];
      const result = await docClient.send(new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: 'begins_with(createdAt, :today) AND #s IN (:s1, :s2)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':today': today, ':s1': 'ARCHIVED', ':s2': 'READY' },
      }));
      const orders = (result.Items || []).filter(o => o.discountType && o.discountType !== 'NONE');
      const summary: Record<string, { count: number; totalOffset: number }> = {};
      for (const o of orders) {
        if (!summary[o.discountType]) summary[o.discountType] = { count: 0, totalOffset: 0 };
        summary[o.discountType].count++;
        summary[o.discountType].totalOffset += o.discountOffset || 0;
      }
      const totalDiscountedOrders = orders.length;
      const totalOffset = orders.reduce((s, o) => s + (o.discountOffset || 0), 0);
      return res(200, { summary, totalDiscountedOrders, totalOffset });
    }

    if (method === 'GET' && path.endsWith('/admin/reports/sessions')) {
      const today = new Date().toISOString().split('T')[0];
      const result = await docClient.send(new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: 'begins_with(createdAt, :today)',
        ExpressionAttributeValues: { ':today': today },
      }));
      const orders = result.Items || [];
      const s1: any[] = [];
      const s2: any[] = [];
      for (const order of orders) {
        // createdAt is stored as UTC ISO. Café runs on MYT (UTC+8) with a
        // hard split between the two Sunday services:
        //   Session 1  = 08:00–11:30 MYT  (local minutes 480–690)
        //   Session 2  = 11:31–14:00 MYT  (local minutes 691–840)
        // Split threshold is 690 (11:30). Anything at/before that is S1;
        // anything after is S2. Orders outside the operational window
        // fall into the nearest session by the same rule.
        const [hStr, mStr] = order.createdAt.split('T')[1].split(':');
        const utcHour = parseInt(hStr, 10);
        const minutes = parseInt(mStr, 10);
        const localHour = (utcHour + 8) % 24;
        const localMinutes = localHour * 60 + minutes;
        if (localMinutes <= 690) s1.push(order);
        else s2.push(order);
      }
      function computeSession(sessionOrders: any[]) {
        const orderCount = sessionOrders.length;
        const revenue = sessionOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
        const avgOrderValue = orderCount ? Math.round((revenue / orderCount) * 100) / 100 : 0;
        const itemCounts: Record<string, number> = {};
        for (const o of sessionOrders) {
          for (const item of (o.items || [])) {
            itemCounts[item.name] = (itemCounts[item.name] || 0) + (item.quantity || 1);
          }
        }
        const topItems = Object.entries(itemCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name, count]) => ({ name, count }));
        return { orderCount, revenue, avgOrderValue, topItems };
      }
      return res(200, { date: today, session1: computeSession(s1), session2: computeSession(s2) });
    }

    if (method === 'GET' && path.endsWith('/admin/reports/monthly')) {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const result = await docClient.send(new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: 'createdAt >= :start',
        ExpressionAttributeValues: { ':start': thirtyDaysAgo.toISOString() },
      }));
      // Only completed sales count. Matches /reports/daily and /reports/weekly
      // so the three cards reconcile against each other.
      const orders = (result.Items || [])
        .filter(o => o.PK?.startsWith('ORDER#'))
        .filter(o => o.status === 'ARCHIVED' || o.status === 'READY');
      const totalOrders = orders.length;
      const totalRevenue = orders.reduce((s, o) => s + (o.totalAmount || 0), 0);
      const totalOffsets = orders.reduce((s, o) => s + (o.discountOffset || 0), 0);
      const netCollection = totalRevenue - totalOffsets;
      const newcomersServed = orders.filter(o => o.discountType === 'NEWCOMER').length;
      const dateSet = new Set(orders.map(o => (o.createdAt as string).split('T')[0]));
      const serviceDays = dateSet.size;
      const avgOrdersPerServiceDay = serviceDays ? Math.round(totalOrders / serviceDays) : 0;
      const itemCounts: Record<string, number> = {};
      for (const o of orders) {
        for (const item of (o.items || [])) {
          itemCounts[item.name] = (itemCounts[item.name] || 0) + (item.quantity || 1);
        }
      }
      const topItems = Object.entries(itemCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));
      const weekMap: Record<string, { orders: number; revenue: number }> = {};
      for (const o of orders) {
        const d = new Date(o.createdAt as string);
        const jan4 = new Date(d.getFullYear(), 0, 4);
        const weekNum = Math.ceil(((d.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7);
        const week = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        if (!weekMap[week]) weekMap[week] = { orders: 0, revenue: 0 };
        weekMap[week].orders++;
        weekMap[week].revenue += o.totalAmount || 0;
      }
      const weeklyBreakdown = Object.entries(weekMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([week, d]) => ({ week, orders: d.orders, revenue: d.revenue }));
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const period = `${months[now.getMonth()]} ${now.getFullYear()}`;
      return res(200, { period, totalOrders, totalRevenue, totalOffsets, netCollection, newcomersServed, serviceDays, avgOrdersPerServiceDay, topItems, weeklyBreakdown });
    }



    if (method === 'GET' && path.endsWith('/admin/reports/daily')) {
      const today = new Date().toISOString().split('T')[0];
      // Union of (orders created today, any status) + (all currently active
      // orders regardless of date). The second bucket catches ministry
      // pre-orders that were created before today for today's service and
      // would otherwise be invisible in the dashboard's "Today's Stats".
      // Dedupe by orderId so a today-created PREPARING order counts once.
      const todayResult = await docClient.send(new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: 'begins_with(createdAt, :today)',
        ExpressionAttributeValues: { ':today': today },
      }));
      const byId = new Map<string, any>();
      for (const o of todayResult.Items || []) {
        const key = String(o.orderId || o.PK);
        if (!byId.has(key)) byId.set(key, o);
      }
      for (const status of ['PREPARING', 'READY']) {
        const activeResult = await docClient.send(new QueryCommand({
          TableName: ORDERS_TABLE,
          IndexName: 'status-createdAt-index',
          KeyConditionExpression: '#s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status },
        }));
        for (const o of activeResult.Items || []) {
          const key = String(o.orderId || o.PK);
          if (!byId.has(key)) byId.set(key, o);
        }
      }
      const orders = [...byId.values()];
      // Revenue-relevant subset: completed sales (ARCHIVED + READY).
      // Pre-orders are included in the count (they represent completed
      // service for a ministry volunteer) but they contribute RM 0 to
      // revenue since `totalAmount` is already stored as net (0 for
      // MINISTRY_PREORDER). PENDING is pre-approval (not a committed sale);
      // CANCELLED/EXPIRED never collected — both excluded from this bucket.
      const paidCompleted = orders.filter(o =>
        o.status === 'ARCHIVED' || o.status === 'READY'
      );
      const totalOrders  = paidCompleted.length;
      const totalRevenue = paidCompleted.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);
      const totalOffsets = paidCompleted.reduce((sum, o) => sum + Number(o.discountOffset || 0), 0);
      const netExpected  = totalRevenue - totalOffsets;
      return res(200, { date: today, totalOrders, totalRevenue, totalOffsets, netExpected, orders });
    }

    if (method === 'GET' && path.endsWith('/admin/reports/weekly')) {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const startDate = sevenDaysAgo.toISOString().split('T')[0];
      const endDate = now.toISOString().split('T')[0];
      const result = await docClient.send(new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: 'createdAt >= :start',
        ExpressionAttributeValues: { ':start': sevenDaysAgo.toISOString() },
      }));
      // Only completed sales count toward the weekly totals. Matches the
      // convention used by /reports/daily so numbers reconcile across
      // the different report cards on the same dashboard page.
      const orders = (result.Items || [])
        .filter(o => o.PK?.startsWith('ORDER#'))
        .filter(o => o.status === 'ARCHIVED' || o.status === 'READY');
      const dayMap: Record<string, { orderCount: number; revenue: number; offsets: number }> = {};
      const itemCounts: Record<string, number> = {};
      for (const o of orders) {
        const date = (o.createdAt as string).split('T')[0];
        if (!dayMap[date]) dayMap[date] = { orderCount: 0, revenue: 0, offsets: 0 };
        dayMap[date].orderCount++;
        dayMap[date].revenue += o.totalAmount || 0;
        dayMap[date].offsets += o.discountOffset || 0;
        for (const item of (o.items || [])) {
          itemCounts[item.name] = (itemCounts[item.name] || 0) + (item.quantity || 1);
        }
      }
      const days = Object.entries(dayMap)
        .map(([date, d]) => ({ date, ...d }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const totalOrders = orders.length;
      const totalRevenue = orders.reduce((s, o) => s + (o.totalAmount || 0), 0);
      const totalOffsets = orders.reduce((s, o) => s + (o.discountOffset || 0), 0);
      const avgPerDay = days.length ? Math.round(totalOrders / days.length) : 0;
      const topItems = Object.entries(itemCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));
      return res(200, { startDate, endDate, days, totals: { totalOrders, totalRevenue, totalOffsets, avgPerDay }, topItems });
    }

    if (method === 'GET' && path.endsWith('/admin/reports/restock')) {
      const result = await docClient.send(new ScanCommand({
        TableName: INGREDIENTS_TABLE,
        FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
        ExpressionAttributeValues: { ':prefix': 'INGREDIENT#', ':sk': 'META' }
      }));
      const items = (result.Items || [])
        .filter(i => i.currentStock <= i.lowStockThreshold * 1.5)
        .map(i => ({
          name: i.name, unit: i.unit, currentStock: i.currentStock,
          lowStockThreshold: i.lowStockThreshold,
          suggestedRestock: i.lowStockThreshold * 2 - i.currentStock,
          storageLocation: i.storageLocation
        }));
      return res(200, { items });
    }

    if (method === 'GET' && path.endsWith('/admin/reports/inventory')) {
      const result = await docClient.send(new ScanCommand({
        TableName: INGREDIENTS_TABLE,
        FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
        ExpressionAttributeValues: { ':prefix': 'INGREDIENT#', ':sk': 'META' }
      }));
      const items = result.Items || [];
      const lowStock = items.filter(i => i.currentStock < i.lowStockThreshold);
      return res(200, { lowStock });
    }

    // Activity Log
    if (method === 'GET' && path.endsWith('/admin/activity-log')) {
      return res(200, { message: 'Coming soon' });
    }

    // ─── Pre-Order Templates (admin-editable defaults) ────────────────
    // Single record stored at PK=SETTINGS#PREORDER_TEMPLATES,SK=META.
    // When creating a new pre-order code, the admin form pre-fills from
    // these values. Existing codes are unaffected — they carry their own
    // independent copy of these fields on their own record.
    if (method === 'GET' && path.endsWith('/admin/settings/preorder-templates')) {
      const r = await docClient.send(new GetCommand({
        TableName: SETTINGS_TABLE,
        Key: { PK: 'SETTINGS#PREORDER_TEMPLATES', SK: 'META' },
      }));
      const stored = r.Item || {};
      // Defaults returned when the record hasn't been created yet.
      return res(200, {
        bannerMessage: typeof stored.bannerMessage === 'string'
          ? stored.bannerMessage
          : 'Ministry Pre-Order — Kindly select one drink\n{$SUNDAY} Service · Collect {$SUNDAY}',
        eligibleItemKeywords: Array.isArray(stored.eligibleItemKeywords) && stored.eligibleItemKeywords.length
          ? stored.eligibleItemKeywords
          : ['latte', 'long black', 'decaf', 'soda', 'tea', 'mineral water'],
        collectionOptions: Array.isArray(stored.collectionOptions) && stored.collectionOptions.length
          ? stored.collectionOptions
          : ['After 1st Service', 'After 2nd Service'],
        updatedAt: stored.updatedAt || null,
      });
    }

    if (method === 'PUT' && path.endsWith('/admin/settings/preorder-templates')) {
      // Normalize input; reject payloads that are dangerously large or
      // wrong-typed. Same shape as GET so the round-trip is symmetric.
      const banner = typeof body.bannerMessage === 'string' ? body.bannerMessage : '';
      if (banner.length > 500) return res(400, { error: 'bannerMessage cannot exceed 500 characters' });

      const rawKeywords: unknown[] = Array.isArray(body.eligibleItemKeywords) ? body.eligibleItemKeywords : [];
      const eligibleItemKeywords: string[] = Array.from(new Set(
        rawKeywords
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map((x) => x.trim().toLowerCase())
      ));

      const rawOpts: unknown[] = Array.isArray(body.collectionOptions) ? body.collectionOptions : [];
      const collectionOptions: string[] = rawOpts
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 60));

      if (!collectionOptions.length) return res(400, { error: 'At least one collectionOption is required' });

      const now = new Date().toISOString();
      await docClient.send(new PutCommand({
        TableName: SETTINGS_TABLE,
        Item: {
          PK: 'SETTINGS#PREORDER_TEMPLATES',
          SK: 'META',
          bannerMessage: banner,
          eligibleItemKeywords,
          collectionOptions,
          updatedAt: now,
        },
      }));

      return res(200, {
        bannerMessage: banner,
        eligibleItemKeywords,
        collectionOptions,
        updatedAt: now,
      });
    }

    // Stock History (from cashier stock-count snapshots)
    // NOTE: /snapshots must be matched before the generic /stock-history so
    // the more specific path wins.
    if (method === 'GET' && path.endsWith('/admin/stock-history/snapshots')) {
      const result = await docClient.send(new ScanCommand({
        TableName: SETTINGS_TABLE,
        FilterExpression: 'begins_with(PK, :prefix)',
        ExpressionAttributeValues: { ':prefix': 'STOCK_SNAPSHOT#' },
      }));
      const items = result.Items || [];
      // Bucket by date so the picker can show which dates have data + how many
      const byDate: Record<string, number> = {};
      for (const it of items) {
        const d = it.date || (typeof it.PK === 'string' ? it.PK.replace(/^STOCK_SNAPSHOT#/, '') : null);
        if (!d) continue;
        byDate[d] = (byDate[d] || 0) + 1;
      }
      const dates = Object.entries(byDate)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => b.date.localeCompare(a.date));
      return res(200, { dates, totalSnapshots: items.length });
    }

    if (method === 'GET' && path.endsWith('/admin/stock-history')) {
      const qs = event.queryStringParameters || {};
      const date = qs.date;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res(400, { error: 'date query param required (YYYY-MM-DD)' });
      }
      const result = await docClient.send(new QueryCommand({
        TableName: SETTINGS_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `STOCK_SNAPSHOT#${date}` },
        ScanIndexForward: false, // newest snapshot first (SK is ISO timestamp)
      }));
      return res(200, { date, snapshots: result.Items || [] });
    }

    return res(404, { error: 'Not found', path, method });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return res(500, { error: message });
  }
}
