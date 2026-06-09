import { APIGatewayProxyEvent } from 'aws-lambda';

// ---------------------------------------------------------------------------
// Module mocks (mock-prefixed names so jest.mock factories may reference them)
// ---------------------------------------------------------------------------

const mockDbSend = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  INGREDIENTS_TABLE: 'test-ingredients',
  USERS_TABLE: 'test-users',
  SETTINGS_TABLE: 'test-settings',
  CUSTOMERS_TABLE: 'test-customers',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
  DeleteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Delete' })),
}));

// orders.ts imports linkOrderToCustomer from ./customers — the customer
// registration helpers don't matter for these tests; stub them.
jest.mock('../src/routes/customers', () => ({
  linkOrderToCustomer: jest.fn().mockResolvedValue(undefined),
  handleCustomers: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleOrders } = require('../src/routes/orders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePos } = require('../src/routes/pos');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'PUT',
    path: '/api/orders/order-123',
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    body: null,
    isBase64Encoded: false,
    ...overrides,
  };
}

function conditionalCheckFailed() {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

const drinkItem = {
  menuItemId: 'menu-latte',
  name: 'Latte',
  variant: 'Hot',
  quantity: 1,
  unitPrice: 8,
  category: 'DRINK',
};
const foodItem = {
  menuItemId: 'menu-cookie',
  name: 'Cookie',
  variant: null,
  quantity: 2,
  unitPrice: 3,
  category: 'FOOD',
};

const settingsRecord = {
  cafeStatus: 'OPEN',
  celebrationMode: false,
  celebrationPrice: 5,
  orderExpiryMinutes: 60,
};

beforeEach(() => {
  mockDbSend.mockReset();
});

// ---------------------------------------------------------------------------
// modifyOrder — UPDATE branch
// ---------------------------------------------------------------------------

describe('modifyOrder — update', () => {
  it('returns 200 and writes new items + modifiedAt on the happy path', async () => {
    const existingOrder = {
      PK: 'ORDER#order-123',
      SK: 'META',
      orderId: 'order-123',
      status: 'PENDING',
      items: [drinkItem],
      totalAmount: 8,
    };
    mockDbSend
      .mockResolvedValueOnce({ Item: existingOrder })          // 1. Get(order)
      .mockResolvedValueOnce({ Item: settingsRecord })         // 2. Get(settings)
      .mockResolvedValueOnce({                                 // 3. Get(menu — drink)
        Item: { menuItemId: 'menu-latte', name: 'Latte', basePrice: 8, category: 'DRINK', isActive: true, isEnabledToday: true },
      })
      .mockResolvedValueOnce({});                              // 4. Update(order)

    const event = makeEvent({
      body: JSON.stringify({
        action: 'update',
        items: [{ menuItemId: 'menu-latte', variant: 'Iced', quantity: 2 }],
      }),
    });

    const result = await handleOrders(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.orderId).toBe('order-123');
    expect(body.status).toBe('PENDING');
    expect(body.totalAmount).toBe(16); // 2 × 8
    expect(body.modifiedAt).toBeTruthy();

    // Final call must be the conditional Update on the order.
    const updateCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    )?.[0];
    expect(updateCall).toBeDefined();
    expect(updateCall.UpdateExpression).toContain('items = :items');
    expect(updateCall.UpdateExpression).toContain('totalAmount = :t');
    expect(updateCall.UpdateExpression).toContain('modifiedAt = :u');
    expect(updateCall.ConditionExpression).toBe('#s = :pending');
    expect(updateCall.ExpressionAttributeValues[':pending']).toBe('PENDING');
    expect(updateCall.ExpressionAttributeValues[':items'][0]).toMatchObject({
      menuItemId: 'menu-latte',
      quantity: 2,
    });
  });

  it('saves notes when provided', async () => {
    const existingOrder = {
      PK: 'ORDER#order-123', SK: 'META', orderId: 'order-123',
      status: 'PENDING', items: [drinkItem], totalAmount: 8,
    };
    const notes = 'less sugar, oat milk';
    mockDbSend
      .mockResolvedValueOnce({ Item: existingOrder })
      .mockResolvedValueOnce({ Item: settingsRecord })
      .mockResolvedValueOnce({
        Item: { menuItemId: 'menu-latte', basePrice: 8, name: 'Latte', category: 'DRINK', isActive: true, isEnabledToday: true },
      })
      .mockResolvedValueOnce({});

    const event = makeEvent({
      body: JSON.stringify({
        action: 'update',
        items: [{ menuItemId: 'menu-latte', variant: 'Hot', quantity: 1 }],
        notes,
      }),
    });

    const result = await handleOrders(event);
    expect(result.statusCode).toBe(200);

    const updateCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    )?.[0];
    expect(updateCall.UpdateExpression).toContain('notes = :n');
    expect(updateCall.ExpressionAttributeValues[':n']).toBe(notes);
  });

  it('accepts notes at the 200-character boundary', async () => {
    const existingOrder = {
      PK: 'ORDER#order-123', SK: 'META', orderId: 'order-123',
      status: 'PENDING', items: [drinkItem], totalAmount: 8,
    };
    const notes = 'a'.repeat(200);
    mockDbSend
      .mockResolvedValueOnce({ Item: existingOrder })
      .mockResolvedValueOnce({ Item: settingsRecord })
      .mockResolvedValueOnce({
        Item: { menuItemId: 'menu-latte', basePrice: 8, name: 'Latte', category: 'DRINK', isActive: true, isEnabledToday: true },
      })
      .mockResolvedValueOnce({});

    const event = makeEvent({
      body: JSON.stringify({
        action: 'update',
        items: [{ menuItemId: 'menu-latte', variant: 'Hot', quantity: 1 }],
        notes,
      }),
    });

    const result = await handleOrders(event);
    expect(result.statusCode).toBe(200);
  });

  it('rejects notes longer than 200 characters with 400', async () => {
    const existingOrder = {
      PK: 'ORDER#order-123', SK: 'META', orderId: 'order-123',
      status: 'PENDING', items: [drinkItem], totalAmount: 8,
    };
    mockDbSend.mockResolvedValueOnce({ Item: existingOrder });

    const event = makeEvent({
      body: JSON.stringify({
        action: 'update',
        items: [{ menuItemId: 'menu-latte', variant: 'Hot', quantity: 1 }],
        notes: 'a'.repeat(201),
      }),
    });

    const result = await handleOrders(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/200/);

    // No Update should have been issued — only the initial Get.
    const updates = mockDbSend.mock.calls.filter((c) => c[0].__cmd === 'Update');
    expect(updates).toHaveLength(0);
  });

  it('returns 409 when the order was approved between read and write', async () => {
    const existingOrder = {
      PK: 'ORDER#order-123', SK: 'META', orderId: 'order-123',
      status: 'PENDING', items: [drinkItem], totalAmount: 8,
    };
    mockDbSend
      .mockResolvedValueOnce({ Item: existingOrder })   // initial Get sees PENDING
      .mockResolvedValueOnce({ Item: settingsRecord })  // settings
      .mockResolvedValueOnce({                          // menu lookup
        Item: { menuItemId: 'menu-latte', basePrice: 8, name: 'Latte', category: 'DRINK', isActive: true, isEnabledToday: true },
      })
      .mockRejectedValueOnce(conditionalCheckFailed()); // conditional Update fails — cashier just approved

    const event = makeEvent({
      body: JSON.stringify({
        action: 'update',
        items: [{ menuItemId: 'menu-latte', variant: 'Hot', quantity: 1 }],
      }),
    });

    const result = await handleOrders(event);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toMatch(/no longer modifiable/i);
  });

  it('on a successful update, releases old food reservations and reserves new food', async () => {
    const existingOrder = {
      PK: 'ORDER#order-123', SK: 'META', orderId: 'order-123',
      status: 'PENDING',
      items: [foodItem],         // existing: 2 cookies reserved
      totalAmount: 6,
    };
    mockDbSend
      .mockResolvedValueOnce({ Item: existingOrder })   // 1. Get(order)
      .mockResolvedValueOnce({ Item: settingsRecord })  // 2. Get(settings)
      .mockResolvedValueOnce({                          // 3. Get(menu — cookie)
        Item: {
          menuItemId: 'menu-cookie', name: 'Cookie', basePrice: 3, category: 'FOOD',
          isActive: true, isEnabledToday: true,
          foodQuantityToday: 10, foodReserved: 2,
        },
      })
      .mockResolvedValueOnce({})   // 4. Update(order — conditional)
      .mockResolvedValueOnce({})   // 5. Update(menu — release old: foodReserved -= 2)
      .mockResolvedValueOnce({});  // 6. Update(menu — reserve new: foodReserved += 5)

    const event = makeEvent({
      body: JSON.stringify({
        action: 'update',
        items: [{ menuItemId: 'menu-cookie', variant: null, quantity: 5 }],
      }),
    });

    const result = await handleOrders(event);
    expect(result.statusCode).toBe(200);

    const menuUpdates = mockDbSend.mock.calls
      .filter((c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-menu')
      .map((c) => c[0]);

    // Two updates against the menu table: one decrement (release old) then
    // one increment (reserve new). Both target the same menu item.
    expect(menuUpdates).toHaveLength(2);

    const release = menuUpdates[0];
    expect(release.Key.PK).toBe('MENU#menu-cookie');
    expect(release.UpdateExpression).toContain('foodReserved = foodReserved - :q');
    expect(release.ExpressionAttributeValues[':q']).toBe(2);

    const reserve = menuUpdates[1];
    expect(reserve.Key.PK).toBe('MENU#menu-cookie');
    expect(reserve.UpdateExpression).toContain('foodReserved = foodReserved + :q');
    expect(reserve.ExpressionAttributeValues[':q']).toBe(5);

    // The order Update must commit BEFORE the food adjustments — otherwise a
    // failed conditional update would leave food reservations inconsistent.
    const orderUpdateIdx = mockDbSend.mock.calls.findIndex(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    );
    const firstMenuUpdateIdx = mockDbSend.mock.calls.findIndex(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-menu'
    );
    expect(orderUpdateIdx).toBeLessThan(firstMenuUpdateIdx);
  });
});

// ---------------------------------------------------------------------------
// modifyOrder — CANCEL branch
// ---------------------------------------------------------------------------

describe('modifyOrder — cancel', () => {
  it('flips status to CANCELLED and releases food on the happy path', async () => {
    const existingOrder = {
      PK: 'ORDER#order-123', SK: 'META', orderId: 'order-123',
      status: 'PENDING', items: [foodItem], totalAmount: 6,
    };
    mockDbSend
      .mockResolvedValueOnce({ Item: existingOrder })  // 1. Get(order)
      .mockResolvedValueOnce({})                       // 2. Update(order — conditional)
      .mockResolvedValueOnce({});                      // 3. Update(menu — release food)

    const event = makeEvent({
      body: JSON.stringify({ action: 'cancel' }),
    });

    const result = await handleOrders(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.status).toBe('CANCELLED');
    expect(body.orderId).toBe('order-123');

    const orderUpdate = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    )?.[0];
    expect(orderUpdate.ConditionExpression).toBe('#s = :pending');
    expect(orderUpdate.ExpressionAttributeValues[':s']).toBe('CANCELLED');

    const foodUpdate = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-menu'
    )?.[0];
    expect(foodUpdate).toBeDefined();
    expect(foodUpdate.UpdateExpression).toContain('foodReserved = foodReserved - :q');
    expect(foodUpdate.ExpressionAttributeValues[':q']).toBe(2);
  });

  it('returns 409 when the order was approved between read and write', async () => {
    const existingOrder = {
      PK: 'ORDER#order-123', SK: 'META', orderId: 'order-123',
      status: 'PENDING', items: [drinkItem], totalAmount: 8,
    };
    mockDbSend
      .mockResolvedValueOnce({ Item: existingOrder })
      .mockRejectedValueOnce(conditionalCheckFailed());

    const event = makeEvent({
      body: JSON.stringify({ action: 'cancel' }),
    });

    const result = await handleOrders(event);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toMatch(/no longer modifiable/i);

    // No food release should happen if the order didn't actually flip.
    const menuUpdates = mockDbSend.mock.calls.filter(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-menu'
    );
    expect(menuUpdates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// approveOrder — race protection
// ---------------------------------------------------------------------------

describe('approveOrder — race', () => {
  it('returns 409 when the customer cancelled between read and write', async () => {
    const existingOrder = {
      PK: 'ORDER#order-123', SK: 'META', orderId: 'order-123',
      status: 'PENDING', items: [drinkItem], totalAmount: 8,
    };
    mockDbSend
      .mockResolvedValueOnce({ Item: existingOrder })   // 1. Get(order)
      .mockRejectedValueOnce(conditionalCheckFailed()); // 2. Update — customer just cancelled

    const event = makeEvent({
      httpMethod: 'PUT',
      path: '/api/pos/orders/order-123/approve',
      body: JSON.stringify({ approvedBy: 'cashier-name' }),
    });

    const result = await handlePos(event);
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).error).toMatch(/cancelled or modified/i);

    // deductIngredients runs only on success — confirm we never queried recipes.
    const recipeQueries = mockDbSend.mock.calls.filter(
      (c) => c[0].__cmd === 'Query' && c[0].TableName === 'test-ingredients'
    );
    expect(recipeQueries).toHaveLength(0);
  });
});
