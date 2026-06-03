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
      const item = {
        PK: `MENU#${menuItemId}`, SK: 'META', menuItemId,
        name: body.name, category: body.category, basePrice: body.basePrice,
        variants: body.variants || [], imageUrl: body.imageUrl || null,
        sortOrder: body.sortOrder || 0, isActive: true, isEnabledToday: true
      };
      await docClient.send(new PutCommand({ TableName: MENU_TABLE, Item: item }));
      return res(201, item);
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

    // Recipes
    if (method === 'POST' && path.endsWith('/admin/recipes')) {
      const { menuItemId, variantId, ingredients } = body;
      const recipeKey = `RECIPE#${menuItemId}#${variantId || 'default'}`;
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
      const users = (r.Items || []).map(u => ({ userId: u.userId, name: u.name, role: u.role, isActive: u.isActive }));
      return res(200, { users });
    }

    if (method === 'POST' && path.endsWith('/admin/users')) {
      const userId = uuid();
      const item = {
        PK: `USER#${userId}`, SK: 'META', userId,
        name: body.name, pinHash: hashPin(body.pin), role: body.role, isActive: true
      };
      await docClient.send(new PutCommand({ TableName: USERS_TABLE, Item: item }));
      return res(201, { userId, name: body.name, role: body.role });
    }

    if (method === 'PUT' && /\/admin\/users\/[^/]+$/.test(path)) {
      const id = extractId(path, 'users');
      const updates = { ...body };
      if (updates.pin) {
        updates.pinHash = hashPin(updates.pin);
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
      const result = await docClient.send(new GetCommand({ TableName: SETTINGS_TABLE, Key: { PK: 'SETTINGS', SK: 'META' } }));
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
        TableName: SETTINGS_TABLE, Key: { PK: 'SETTINGS', SK: 'META' },
        UpdateExpression: `SET ${fields.join(', ')}`,
        ExpressionAttributeNames: names, ExpressionAttributeValues: values
      }));
      return res(200, { updated: Object.keys(body) });
    }

    // Reports
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
      return res(200, { message: 'Coming soon' });
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
