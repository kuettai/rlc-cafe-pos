import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { docClient, CUSTOMERS_TABLE, ORDERS_TABLE, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '../lib/db';

const res = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode, headers: {}, body: JSON.stringify(body),
});

async function registerCustomer(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { phone, name, birthday } = body;

  if (!phone || !name) return res(400, { error: 'phone and name required' });

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  if (cleanPhone.length < 9 || cleanPhone.length > 12) return res(400, { error: 'Invalid phone number' });

  if (birthday && !/^\d{2}-\d{2}$/.test(birthday)) return res(400, { error: 'Birthday must be MM-DD format' });

  const existing = await docClient.send(new GetCommand({
    TableName: CUSTOMERS_TABLE,
    Key: { PK: `CUSTOMER#${cleanPhone}`, SK: 'META' },
  }));

  if (existing.Item) {
    await docClient.send(new UpdateCommand({
      TableName: CUSTOMERS_TABLE,
      Key: { PK: `CUSTOMER#${cleanPhone}`, SK: 'META' },
      UpdateExpression: 'SET #n = :name, birthday = :birthday, updatedAt = :now',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: { ':name': name, ':birthday': birthday || null, ':now': new Date().toISOString() },
    }));
    return res(200, { message: 'Profile updated', phone: cleanPhone, name });
  }

  const now = new Date().toISOString();
  await docClient.send(new PutCommand({
    TableName: CUSTOMERS_TABLE,
    Item: {
      PK: `CUSTOMER#${cleanPhone}`,
      SK: 'META',
      phone: cleanPhone,
      name,
      birthday: birthday || null,
      orderCount: 0,
      totalSpent: 0,
      lastOrderAt: null,
      createdAt: now,
      updatedAt: now,
    },
  }));

  return res(201, { message: 'Profile created', phone: cleanPhone, name });
}

async function lookupCustomer(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const phone = event.pathParameters?.phone || event.queryStringParameters?.phone;
  if (!phone) return res(400, { error: 'phone required' });

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const r = await docClient.send(new GetCommand({
    TableName: CUSTOMERS_TABLE,
    Key: { PK: `CUSTOMER#${cleanPhone}`, SK: 'META' },
  }));

  if (!r.Item) return res(404, { error: 'Customer not found' });

  const c = r.Item;
  return res(200, {
    phone: c.phone,
    name: c.name,
    birthday: c.birthday,
    orderCount: c.orderCount || 0,
    totalSpent: c.totalSpent || 0,
    lastOrderAt: c.lastOrderAt,
    createdAt: c.createdAt,
  });
}

async function linkOrderToCustomer(phone: string, orderId: string, totalAmount: number): Promise<void> {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  try {
    await docClient.send(new UpdateCommand({
      TableName: CUSTOMERS_TABLE,
      Key: { PK: `CUSTOMER#${cleanPhone}`, SK: 'META' },
      UpdateExpression: 'SET orderCount = orderCount + :one, totalSpent = totalSpent + :amount, lastOrderAt = :now, updatedAt = :now',
      ExpressionAttributeValues: { ':one': 1, ':amount': totalAmount, ':now': new Date().toISOString() },
      ConditionExpression: 'attribute_exists(PK)',
    }));
  } catch (e: any) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
  }
}

async function getCustomerOrders(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const phone = event.pathParameters?.phone;
  if (!phone) return res(400, { error: 'phone required' });

  const cleanPhone = phone.replace(/[^0-9]/g, '');

  const customer = await docClient.send(new GetCommand({
    TableName: CUSTOMERS_TABLE,
    Key: { PK: `CUSTOMER#${cleanPhone}`, SK: 'META' },
  }));
  if (!customer.Item) return res(404, { error: 'Customer not found' });

  const r = await docClient.send(new QueryCommand({
    TableName: ORDERS_TABLE,
    IndexName: 'customerId-createdAt-index',
    KeyConditionExpression: 'customerId = :phone',
    ExpressionAttributeValues: { ':phone': cleanPhone },
    ScanIndexForward: false,
    Limit: 20,
  }));

  const orders = (r.Items || []).map(o => ({
    orderId: o.orderId,
    totalAmount: o.totalAmount,
    status: o.status,
    items: o.items,
    createdAt: o.createdAt,
  }));

  return res(200, { orders });
}

function extractPhone(path: string): string | null {
  const match = path.match(/\/api\/customers\/([^/]+)/);
  return match ? match[1] : null;
}

export async function handleCustomers(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  if (method === 'POST' && path === '/api/customers') return registerCustomer(event);

  const phone = extractPhone(path);

  if (method === 'GET' && phone && path.endsWith('/orders')) {
    event.pathParameters = { phone };
    return getCustomerOrders(event);
  }

  if (method === 'GET' && phone) {
    event.pathParameters = { phone };
    return lookupCustomer(event);
  }

  return res(404, { error: 'Not found' });
}

export { linkOrderToCustomer };
