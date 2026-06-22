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
        lowStockThreshold: body.lowStockThreshold, storageLocation: body.storageLocation
      };
      await docClient.send(new PutCommand({ TableName: INGREDIENTS_TABLE, Item: item }));
      return res(201, item);
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
      const userId = uuid();
      const item = {
        PK: `USER#${userId}`, SK: 'META', userId,
        name: body.name, pinHash: hashPin(body.pin), role: body.role, isActive: true, forceUpdatePin: true
      };
      await docClient.send(new PutCommand({ TableName: USERS_TABLE, Item: item }));
      return res(201, { userId, name: body.name, role: body.role });
    }

    if (method === 'PUT' && /\/admin\/users\/[^/]+$/.test(path)) {
      const id = extractId(path, 'users');
      const updates = { ...body };
      if (updates.pin) {
        updates.pinHash = hashPin(updates.pin);
        updates.forceUpdatePin = true;
        delete updates.pin;
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

      const statuses = ['ARCHIVED', 'READY', 'CANCELLED'];
      const allOrders: any[] = [];
      for (const status of statuses) {
        const result = await docClient.send(new QueryCommand({
          TableName: ORDERS_TABLE,
          IndexName: 'status-createdAt-index',
          KeyConditionExpression: '#s = :s AND createdAt BETWEEN :start AND :end',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status, ':start': startIso, ':end': endIso },
        }));
        const items = result.Items || [];
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
      const result = await docClient.send(new ScanCommand({ TableName: ORDERS_TABLE }));
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
        const hour = parseInt(order.createdAt.split('T')[1].split(':')[0]);
        if (hour < 12) s1.push(order);
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
      const orders = (result.Items || []).filter(o => o.PK?.startsWith('ORDER#'));
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
      const result = await docClient.send(new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: 'begins_with(createdAt, :today)',
        ExpressionAttributeValues: { ':today': today },
      }));
      const orders = result.Items || [];
      const totalOrders = orders.length;
      const totalRevenue = orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
      const totalOffsets = orders.reduce((sum, o) => sum + (o.discountOffset || 0), 0);
      const netExpected = totalRevenue - totalOffsets;
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
      const orders = (result.Items || []).filter(o => o.PK?.startsWith('ORDER#'));
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

    return res(404, { error: 'Not found', path, method });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return res(500, { error: message });
  }
}
