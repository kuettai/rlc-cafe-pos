/**
 * POS menu-toggle / inventory / ingredients sub-actions of
 * `backend/src/routes/pos.ts`.
 *
 * Scope, deliberately narrow (three other suites cover order transitions,
 * cafe/shift-summary and onboarding-progress):
 *
 *   PUT  /api/pos/menu/{id}/toggle           toggleMenuItem
 *   PUT  /api/pos/menu/{id}/quantity         setFoodQuantity + checkSoldOut
 *   PUT  /api/pos/menu/{id}/pin              togglePin
 *   GET  /api/pos/menu                       listCashierMenu
 *   GET  /api/pos/inventory                  getInventory
 *   PUT  /api/pos/inventory/{id}             adjustStock
 *   GET  /api/pos/ingredients                listIngredientsForCount
 *   PUT  /api/pos/ingredients/bulk-update    bulkUpdateStock
 *   GET  /api/pos/usage                      getUsageToday
 *
 * Everything is asserted against the command the handler actually handed to
 * `docClient.send` — the `UpdateExpression`, the `Key`, the `Item`, the
 * `FilterExpression` — never against a fixture built here.
 *
 * Fully mocked: `../src/lib/db` is the only DynamoDB client in the backend, so
 * nothing here touches the live café and no `ZZTEST_` marker is required.
 */

const mockDbSend = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  INGREDIENTS_TABLE: 'test-ingredients',
  USERS_TABLE: 'test-users',
  SETTINGS_TABLE: 'test-settings',
  CUSTOMERS_TABLE: 'test-customers',
  VOUCHERS_TABLE: 'test-vouchers',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
  DeleteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Delete' })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePos } = require('../src/routes/pos');

// ─── Helpers ─────────────────────────────────────────────────────────

function makeEvent(overrides: Record<string, any> = {}): any {
  return {
    httpMethod: 'PUT',
    path: '/api/pos/menu/cookie/toggle',
    headers: {},
    queryStringParameters: null,
    pathParameters: null,
    body: null,
    ...overrides,
  };
}

/** Every command handed to docClient.send, in call order. */
const sent = () => mockDbSend.mock.calls.map((c) => c[0]);
const sentOfKind = (kind: string) => sent().filter((c) => c.__cmd === kind);

// ─── Fixtures ────────────────────────────────────────────────────────

const COOKIE = {
  PK: 'MENU#cookie', SK: 'META', menuItemId: 'cookie', name: 'Cookie',
  category: 'FOOD', basePrice: 3, isActive: true, isEnabledToday: true,
  foodQuantityToday: 10, foodReserved: 0, sortOrder: 1,
};

const LATTE_ITEM = {
  PK: 'MENU#latte', SK: 'META', menuItemId: 'latte', name: 'Latte',
  category: 'DRINK', basePrice: 8, isActive: true, isEnabledToday: true,
  sortOrder: 2,
};

function ingredient(overrides: Record<string, any> = {}) {
  return {
    PK: 'INGREDIENT#oat-milk', SK: 'META', ingredientId: 'oat-milk',
    name: 'Oat Milk', unit: 'carton', currentStock: 4,
    storageLocation: 'FRIDGE', lowStockThreshold: 2, isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockDbSend.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── PUT /api/pos/menu/{id}/toggle ───────────────────────────────────

describe('toggleMenuItem — PUT /api/pos/menu/{id}/toggle', () => {
  it('flips isEnabledToday ON (not isActive) and does not walk the PENDING queue', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { ...COOKIE, isEnabledToday: false } }) // Get menu
      .mockResolvedValueOnce({});                                            // Update

    const result = await handlePos(makeEvent({ path: '/api/pos/menu/cookie/toggle' }), 'Cashier');

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ menuItemId: 'cookie', isEnabledToday: true });

    const update = sentOfKind('Update')[0];
    expect(update.TableName).toBe('test-menu');
    expect(update.Key).toEqual({ PK: 'MENU#cookie', SK: 'META' });
    // The day flag, never the permanent catalogue flag.
    expect(update.UpdateExpression).toBe('SET isEnabledToday = :e');
    expect(update.ExpressionAttributeValues[':e']).toBe(true);
    expect(update.UpdateExpression).not.toContain('isActive');

    // Enabling must not query PENDING orders at all.
    expect(sentOfKind('Query')).toHaveLength(0);
    expect(mockDbSend).toHaveBeenCalledTimes(2);
  });

  it('flips OFF and flags only the PENDING orders that contain the item', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { ...COOKIE, isEnabledToday: true } })
      .mockResolvedValueOnce({}) // menu update
      .mockResolvedValueOnce({
        Items: [
          { orderId: 'order-1', items: [{ menuItemId: 'cookie' }], flaggedItems: [] },
          { orderId: 'order-2', items: [{ menuItemId: 'latte' }], flaggedItems: [] },
          { orderId: 'order-3', items: [{ menuItemId: 'cookie' }], flaggedItems: ['latte'] },
        ],
      })
      .mockResolvedValue({}); // the flag updates

    const result = await handlePos(makeEvent({ path: '/api/pos/menu/cookie/toggle' }), 'Cashier');

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ menuItemId: 'cookie', isEnabledToday: false });
    expect(sentOfKind('Update')[0].ExpressionAttributeValues[':e']).toBe(false);

    // The PENDING sweep is a GSI query on status.
    const query = sentOfKind('Query')[0];
    expect(query.TableName).toBe('test-orders');
    expect(query.IndexName).toBe('status-createdAt-index');
    expect(query.ExpressionAttributeValues[':s']).toBe('PENDING');

    // Two flag writes: order-1 and order-3. order-2 does not contain the item.
    const flagWrites = sentOfKind('Update').slice(1);
    expect(flagWrites).toHaveLength(2);
    expect(flagWrites[0].Key).toEqual({ PK: 'ORDER#order-1', SK: 'META' });
    expect(flagWrites[0].UpdateExpression).toBe('SET flaggedItems = :f');
    expect(flagWrites[0].ExpressionAttributeValues[':f']).toEqual(['cookie']);
    // Appends to whatever was already flagged rather than replacing it.
    expect(flagWrites[1].Key).toEqual({ PK: 'ORDER#order-3', SK: 'META' });
    expect(flagWrites[1].ExpressionAttributeValues[':f']).toEqual(['latte', 'cookie']);
    expect(flagWrites.map((w) => w.Key.PK)).not.toContain('ORDER#order-2');
  });

  it('tolerates a PENDING order with no items array', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { ...COOKIE, isEnabledToday: true } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [{ orderId: 'order-9' }] })
      .mockResolvedValue({});

    const result = await handlePos(makeEvent({ path: '/api/pos/menu/cookie/toggle' }));

    expect(result.statusCode).toBe(200);
    expect(sentOfKind('Update')).toHaveLength(1); // menu only, no flag write
  });

  it('returns 404 for an unknown menu item and writes nothing', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: undefined });

    const result = await handlePos(makeEvent({ path: '/api/pos/menu/ghost/toggle' }));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error).toMatch(/not found/i);
    expect(sentOfKind('Update')).toHaveLength(0);
  });

  it('does not dispatch a path that only looks like /toggle', async () => {
    const result = await handlePos(makeEvent({ path: '/api/pos/menu/cookie/toggle-all' }));
    expect(result.statusCode).toBe(404);
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

// ─── PUT /api/pos/menu/{id}/quantity ─────────────────────────────────

describe('setFoodQuantity — PUT /api/pos/menu/{id}/quantity', () => {
  it('sets foodQuantityToday ABSOLUTELY (not as a delta)', async () => {
    mockDbSend
      .mockResolvedValueOnce({})                                                   // Update
      .mockResolvedValueOnce({ Item: { ...COOKIE, foodQuantityToday: 12 } });      // checkSoldOut Get

    const result = await handlePos(makeEvent({
      path: '/api/pos/menu/cookie/quantity',
      body: JSON.stringify({ foodQuantityToday: 12 }),
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ menuItemId: 'cookie', foodQuantityToday: 12 });

    const update = sentOfKind('Update')[0];
    expect(update.Key).toEqual({ PK: 'MENU#cookie', SK: 'META' });
    expect(update.UpdateExpression).toBe('SET foodQuantityToday = :q');
    expect(update.ExpressionAttributeValues[':q']).toBe(12);
    // Absolute set: no arithmetic on the stored value.
    expect(update.UpdateExpression).not.toMatch(/[+-]/);

    // Stock still available → no soldOutAt stamp.
    expect(sentOfKind('Update')).toHaveLength(1);
  });

  it('stamps soldOutAt when the new quantity leaves nothing available', async () => {
    mockDbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { ...COOKIE, foodQuantityToday: 0, foodReserved: 0 } })
      .mockResolvedValueOnce({});

    const result = await handlePos(makeEvent({
      path: '/api/pos/menu/cookie/quantity',
      body: JSON.stringify({ foodQuantityToday: 0 }),
    }));

    expect(result.statusCode).toBe(200);
    const soldOut = sentOfKind('Update')[1];
    expect(soldOut.Key).toEqual({ PK: 'MENU#cookie', SK: 'META' });
    expect(soldOut.UpdateExpression).toBe('SET soldOutAt = :now');
    expect(typeof soldOut.ExpressionAttributeValues[':now']).toBe('string');
  });

  it('counts reservations as unavailable — quantity above 0 can still be sold out', async () => {
    mockDbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { ...COOKIE, foodQuantityToday: 3, foodReserved: 3 } })
      .mockResolvedValueOnce({});

    await handlePos(makeEvent({
      path: '/api/pos/menu/cookie/quantity',
      body: JSON.stringify({ foodQuantityToday: 3 }),
    }));

    expect(sentOfKind('Update')[1].UpdateExpression).toBe('SET soldOutAt = :now');
  });

  it('does not re-stamp soldOutAt when it is already set', async () => {
    mockDbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: { ...COOKIE, foodQuantityToday: 0, foodReserved: 0, soldOutAt: '2026-09-02T02:00:00.000Z' },
      });

    await handlePos(makeEvent({
      path: '/api/pos/menu/cookie/quantity',
      body: JSON.stringify({ foodQuantityToday: 0 }),
    }));

    expect(sentOfKind('Update')).toHaveLength(1); // the quantity write only
  });

  it('DOES NOT clear soldOutAt when an item is restocked (current behaviour — see report)', async () => {
    // checkSoldOut only ever SETS the stamp; there is no branch that clears it.
    mockDbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: { ...COOKIE, foodQuantityToday: 20, foodReserved: 0, soldOutAt: '2026-09-02T02:00:00.000Z' },
      });

    const result = await handlePos(makeEvent({
      path: '/api/pos/menu/cookie/quantity',
      body: JSON.stringify({ foodQuantityToday: 20 }),
    }));

    expect(result.statusCode).toBe(200);
    expect(sentOfKind('Update')).toHaveLength(1);
    expect(
      sent().some((c) => typeof c.UpdateExpression === 'string' && c.UpdateExpression.includes('soldOutAt'))
    ).toBe(false);
  });

  it('rejects a negative quantity with 400 before any write', async () => {
    const result = await handlePos(makeEvent({
      path: '/api/pos/menu/cookie/quantity',
      body: JSON.stringify({ foodQuantityToday: -1 }),
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/Invalid quantity/);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric quantity with 400', async () => {
    const result = await handlePos(makeEvent({
      path: '/api/pos/menu/cookie/quantity',
      body: JSON.stringify({ foodQuantityToday: '12' }),
    }));

    expect(result.statusCode).toBe(400);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects a missing quantity with 400', async () => {
    const result = await handlePos(makeEvent({
      path: '/api/pos/menu/cookie/quantity',
      body: JSON.stringify({}),
    }));

    expect(result.statusCode).toBe(400);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('accepts 0 as a real value rather than treating it as missing', async () => {
    mockDbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { ...COOKIE, foodQuantityToday: 0, foodReserved: 0 } })
      .mockResolvedValueOnce({});

    const result = await handlePos(makeEvent({
      path: '/api/pos/menu/cookie/quantity',
      body: JSON.stringify({ foodQuantityToday: 0 }),
    }));

    expect(result.statusCode).toBe(200);
    expect(sentOfKind('Update')[0].ExpressionAttributeValues[':q']).toBe(0);
  });
});

// ─── PUT /api/pos/menu/{id}/pin ──────────────────────────────────────

describe('togglePin — PUT /api/pos/menu/{id}/pin', () => {
  it('pins an unpinned item', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: LATTE_ITEM }) // no isPinned attribute at all
      .mockResolvedValueOnce({});

    const result = await handlePos(makeEvent({ path: '/api/pos/menu/latte/pin' }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ menuItemId: 'latte', isPinned: true });

    const update = sentOfKind('Update')[0];
    expect(update.TableName).toBe('test-menu');
    expect(update.Key).toEqual({ PK: 'MENU#latte', SK: 'META' });
    expect(update.UpdateExpression).toBe('SET isPinned = :p');
    expect(update.ExpressionAttributeValues[':p']).toBe(true);
  });

  it('unpins a pinned item', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { ...LATTE_ITEM, isPinned: true } })
      .mockResolvedValueOnce({});

    const result = await handlePos(makeEvent({ path: '/api/pos/menu/latte/pin' }));

    expect(JSON.parse(result.body)).toEqual({ menuItemId: 'latte', isPinned: false });
    expect(sentOfKind('Update')[0].ExpressionAttributeValues[':p']).toBe(false);
  });

  it('pinning is independent of the day flag — it never writes isEnabledToday', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: { ...LATTE_ITEM, isEnabledToday: false } })
      .mockResolvedValueOnce({});

    await handlePos(makeEvent({ path: '/api/pos/menu/latte/pin' }));

    expect(sentOfKind('Update')[0].UpdateExpression).not.toContain('isEnabledToday');
  });

  it('returns 404 for an unknown menu item and writes nothing', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: undefined });

    const result = await handlePos(makeEvent({ path: '/api/pos/menu/ghost/pin' }));

    expect(result.statusCode).toBe(404);
    expect(sentOfKind('Update')).toHaveLength(0);
  });
});

// ─── GET /api/pos/menu ───────────────────────────────────────────────

describe('listCashierMenu — GET /api/pos/menu', () => {
  it('filters on isActive ONLY, so a disabled-today item is still returned', async () => {
    // This is the load-bearing difference from the public GET /api/menu, which
    // filters 'isActive = :active AND isEnabledToday = :enabled'. Cashiers must
    // see today-disabled items in order to toggle them back on.
    mockDbSend.mockResolvedValueOnce({
      Items: [{ ...COOKIE, isEnabledToday: false }, LATTE_ITEM],
    });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/menu' }));

    expect(result.statusCode).toBe(200);
    const scan = sentOfKind('Scan')[0];
    expect(scan.TableName).toBe('test-menu');
    expect(scan.FilterExpression).toBe('isActive = :active');
    expect(scan.FilterExpression).not.toContain('isEnabledToday');
    expect(scan.ExpressionAttributeValues).toEqual({ ':active': true });

    const ids = JSON.parse(result.body).items.map((i: any) => i.menuItemId);
    expect(ids).toContain('cookie');
  });

  it('drops non-META rows and sorts by category then sortOrder', async () => {
    mockDbSend.mockResolvedValueOnce({
      Items: [
        { ...LATTE_ITEM, menuItemId: 'mocha', category: 'DRINK', sortOrder: 5 },
        { PK: 'MENU#latte', SK: 'VARIANT#iced', menuItemId: 'latte-iced' }, // not META
        { ...COOKIE, menuItemId: 'muffin', category: 'FOOD', sortOrder: 1 },
        { ...LATTE_ITEM, menuItemId: 'latte', category: 'DRINK', sortOrder: 2 },
        { ...COOKIE, menuItemId: 'scone', category: 'FOOD', sortOrder: 0 },
      ],
    });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/menu' }));

    const ids = JSON.parse(result.body).items.map((i: any) => i.menuItemId);
    expect(ids).toEqual(['latte', 'mocha', 'scone', 'muffin']); // DRINK < FOOD
    expect(ids).not.toContain('latte-iced');
  });

  it('returns an empty list when the scan yields nothing', async () => {
    mockDbSend.mockResolvedValueOnce({});

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/menu' }));

    expect(JSON.parse(result.body)).toEqual({ items: [] });
  });
});

// ─── GET /api/pos/inventory ──────────────────────────────────────────

describe('getInventory — GET /api/pos/inventory', () => {
  it('scans the whole ingredients table with NO filter and returns rows verbatim', async () => {
    mockDbSend.mockResolvedValueOnce({
      Items: [
        ingredient(),
        // Recipes share INGREDIENTS_TABLE (see deductIngredients), and this
        // unfiltered scan therefore returns them alongside real ingredients.
        { PK: 'RECIPE#latte#default', SK: 'ING#oat-milk', ingredientId: 'oat-milk', quantity: 150 },
      ],
    });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/inventory' }));

    expect(result.statusCode).toBe(200);
    const scan = sentOfKind('Scan')[0];
    expect(scan.TableName).toBe('test-ingredients');
    expect(scan.FilterExpression).toBeUndefined();

    const body = JSON.parse(result.body);
    expect(body.ingredients).toHaveLength(2);
    // Pass-through, not the slim shape /api/pos/ingredients returns.
    expect(body.ingredients[0].lowStockThreshold).toBe(2);
    expect(body.ingredients.map((i: any) => i.PK)).toContain('RECIPE#latte#default');
  });

  it('returns an empty array when the table scan yields nothing', async () => {
    mockDbSend.mockResolvedValueOnce({});

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/inventory' }));

    expect(JSON.parse(result.body)).toEqual({ ingredients: [] });
  });
});

// ─── PUT /api/pos/inventory/{id} ─────────────────────────────────────

describe('adjustStock — PUT /api/pos/inventory/{id}', () => {
  it('SETS currentStock absolutely when increasing', async () => {
    mockDbSend.mockResolvedValueOnce({});

    const result = await handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: JSON.stringify({ currentStock: 12 }),
    }), 'Cashier');

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ingredientId: 'oat-milk', currentStock: 12 });

    const update = sentOfKind('Update')[0];
    expect(update.TableName).toBe('test-ingredients');
    expect(update.Key).toEqual({ PK: 'INGREDIENT#oat-milk', SK: 'META' });
    // Absolute assignment, NOT a delta — no ADD, no arithmetic on the stored value.
    expect(update.UpdateExpression).toBe('SET currentStock = :s');
    expect(update.ExpressionAttributeValues).toEqual({ ':s': 12 });
  });

  it('SETS currentStock absolutely when decreasing', async () => {
    mockDbSend.mockResolvedValueOnce({});

    const result = await handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: JSON.stringify({ currentStock: 2 }),
    }));

    expect(result.statusCode).toBe(200);
    const update = sentOfKind('Update')[0];
    expect(update.UpdateExpression).toBe('SET currentStock = :s');
    expect(update.ExpressionAttributeValues[':s']).toBe(2);
    // Decrement of 10 → 2 is expressed as the new value, not `- :s`.
    expect(update.UpdateExpression).not.toContain('-');
  });

  it('404s on a missing ingredient via attribute_exists, never upserting a phantom row', async () => {
    // FIXED (was pinned as "no existence guard"). A bare Update is an UPSERT, so
    // a typo'd id used to create a phantom INGREDIENT# row that then appeared in
    // the stock-count list forever. Guarded as a condition rather than a
    // preceding Get: one round trip, and no read-then-write race with a delete.
    mockDbSend.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }),
    );

    const result = await handlePos(makeEvent({
      path: '/api/pos/inventory/does-not-exist',
      body: JSON.stringify({ currentStock: 5 }),
    }));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: 'Ingredient not found' });
    expect(sentOfKind('Update')[0].ConditionExpression).toBe('attribute_exists(PK)');
    expect(sentOfKind('Update')[0].Key.PK).toBe('INGREDIENT#does-not-exist');
  });

  it('sends attribute_exists on the happy path too, not only when it fails', async () => {
    mockDbSend.mockResolvedValueOnce({});
    await handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: JSON.stringify({ currentStock: 3 }),
    }));
    expect(sentOfKind('Update')[0].ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('rethrows a NON-conditional DynamoDB failure rather than reporting 404', async () => {
    mockDbSend.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'ValidationException' }),
    );
    await expect(handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: JSON.stringify({ currentStock: 3 }),
    }))).rejects.toThrow('boom');
  });

  it('400s on a NEGATIVE stock level, writing nothing', async () => {
    // FIXED (was pinned as BUG). setFoodQuantity rejects `qty < 0` with 400 and
    // bulkUpdateStock rejects `cnt < 0` per row; this sibling validated nothing,
    // so -50 cartons of oat milk was written.
    const result = await handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: JSON.stringify({ currentStock: -50 }),
    }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/currentStock must be a number >= 0/);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('accepts exactly 0 — a genuinely empty ingredient is not a validation error', async () => {
    mockDbSend.mockResolvedValueOnce({});
    const result = await handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: JSON.stringify({ currentStock: 0 }),
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ingredientId: 'oat-milk', currentStock: 0 });
    expect(sentOfKind('Update')[0].ExpressionAttributeValues[':s']).toBe(0);
  });

  it.each([
    ['a non-numeric string', 'plenty'],
    ['NaN', Number.NaN],
    ['Infinity', 'Infinity'],
    ['null', null],
    ['a boolean', true],
    ['an object', { n: 1 }],
  ])('400s on %s, writing nothing', async (_label, currentStock) => {
    const result = await handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: JSON.stringify({ currentStock }),
    }));

    expect(result.statusCode).toBe(400);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('coerces a NUMERIC string, matching bulkUpdateStock\'s Number() coercion', async () => {
    mockDbSend.mockResolvedValueOnce({});
    const result = await handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: JSON.stringify({ currentStock: '7.5' }),
    }));

    expect(result.statusCode).toBe(200);
    // A NUMBER reaches DynamoDB, never the string — every reader of
    // `currentStock` treats it as numeric.
    expect(sentOfKind('Update')[0].ExpressionAttributeValues[':s']).toBe(7.5);
    expect(JSON.parse(result.body).currentStock).toBe(7.5);
  });

  it('400s on an empty body instead of writing :s undefined', async () => {
    // FIXED (was pinned as BUG). `lib/db.ts` builds the document client with no
    // `removeUndefinedValues`, so against real DynamoDB the undefined value
    // failed the whole request and surfaced to the cashier as a 502.
    const result = await handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: JSON.stringify({}),
    }));

    expect(result.statusCode).toBe(400);
    expect(sentOfKind('Update')).toHaveLength(0);
  });

  it('400s when the request has no body at all', async () => {
    const result = await handlePos(makeEvent({
      path: '/api/pos/inventory/oat-milk',
      body: null,
    }));

    expect(result.statusCode).toBe(400);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('does not capture the bulk-update collection route', async () => {
    // PUT /api/pos/ingredients/bulk-update must reach bulkUpdateStock, and the
    // inventory-id regex must not swallow anything under /ingredients/.
    mockDbSend.mockResolvedValue({});

    await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: [{ ingredientId: 'oat-milk', count: 1 }] }),
    }), 'Cashier');

    // bulkUpdateStock reads before it writes; adjustStock never reads.
    expect(sentOfKind('Get')).toHaveLength(1);
  });
});

// ─── GET /api/pos/ingredients ────────────────────────────────────────

describe('listIngredientsForCount — GET /api/pos/ingredients', () => {
  it('scans only INGREDIENT#/META rows and returns the slim counting shape', async () => {
    mockDbSend.mockResolvedValueOnce({
      Items: [ingredient({ costPerUnit: 9.5, usageUnit: 'ml', lastCountedAt: '2026-08-31T01:00:00.000Z', lastCountedBy: 'Ann' })],
    });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/ingredients' }));

    expect(result.statusCode).toBe(200);
    const scan = sentOfKind('Scan')[0];
    expect(scan.TableName).toBe('test-ingredients');
    expect(scan.FilterExpression).toBe('begins_with(PK, :prefix) AND SK = :sk');
    expect(scan.ExpressionAttributeValues).toEqual({ ':prefix': 'INGREDIENT#', ':sk': 'META' });

    const [row] = JSON.parse(result.body).ingredients;
    expect(row).toEqual({
      ingredientId: 'oat-milk',
      name: 'Oat Milk',
      unit: 'carton',
      currentStock: 4,
      storageLocation: 'FRIDGE',
      lowStockThreshold: 2,
      isActive: true,
      lastCountedAt: '2026-08-31T01:00:00.000Z',
      lastCountedBy: 'Ann',
    });
    // Projected away, not merely absent from the fixture.
    expect(Object.keys(row)).not.toContain('costPerUnit');
    expect(Object.keys(row)).not.toContain('PK');
  });

  it('coerces currentStock and defaults the optional fields', async () => {
    mockDbSend.mockResolvedValueOnce({
      Items: [
        ingredient({ ingredientId: 'sugar', name: 'Sugar', currentStock: '3.5', storageLocation: undefined, lowStockThreshold: undefined, isActive: undefined }),
        ingredient({ ingredientId: 'cocoa', name: 'Cocoa', currentStock: 'lots' }),
        ingredient({ ingredientId: 'tea', name: 'Tea', isActive: false }),
      ],
    });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/ingredients' }));
    const byId: Record<string, any> = {};
    for (const r of JSON.parse(result.body).ingredients) byId[r.ingredientId] = r;

    expect(byId.sugar.currentStock).toBe(3.5);        // numeric string coerced
    expect(byId.cocoa.currentStock).toBe(0);          // unparseable → 0, never NaN
    expect(byId.sugar.storageLocation).toBeNull();
    expect(byId.sugar.lowStockThreshold).toBe(0);
    expect(byId.sugar.isActive).toBe(true);           // missing isActive = active
    expect(byId.tea.isActive).toBe(false);            // explicit false honoured
    expect(byId.sugar.lastCountedAt).toBeNull();
  });

  it('groups by storage location and sorts by name within a location', async () => {
    mockDbSend.mockResolvedValueOnce({
      Items: [
        ingredient({ ingredientId: 'z', name: 'Zest', storageLocation: 'STOREROOM' }),
        ingredient({ ingredientId: 'b', name: 'Butter', storageLocation: 'FRIDGE' }),
        ingredient({ ingredientId: 'a', name: 'Almond Milk', storageLocation: 'FRIDGE' }),
      ],
    });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/ingredients' }));

    expect(JSON.parse(result.body).ingredients.map((i: any) => i.name))
      .toEqual(['Almond Milk', 'Butter', 'Zest']);
  });

  it('puts UNLOCATED rows LAST, after every located group', async () => {
    // FIXED (was pinned as BUG). `(a.storageLocation || '~')` was a sentinel
    // picked so unlocated rows sort last — true for code-point comparison
    // (`'~' > 'FRIDGE'`), but the sort used `localeCompare`, and ICU collation
    // orders punctuation BEFORE letters (`'~'.localeCompare('FRIDGE') === -1`).
    // So the cashier's stock-count list opened with the ingredients that have no
    // storage location. Now handled explicitly, not by a sentinel.
    mockDbSend.mockResolvedValueOnce({
      Items: [
        ingredient({ ingredientId: 'b', name: 'Butter', storageLocation: 'FRIDGE' }),
        ingredient({ ingredientId: 'n', name: 'Nutmeg', storageLocation: undefined }),
        ingredient({ ingredientId: 'z', name: 'Zest', storageLocation: 'STOREROOM' }),
      ],
    });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/ingredients' }));

    expect(JSON.parse(result.body).ingredients.map((i: any) => i.name))
      .toEqual(['Butter', 'Zest', 'Nutmeg']);
  });

  it('demonstrates why the old sentinel failed — ICU sorts ~ before letters', async () => {
    // The mechanism, asserted directly so nobody "simplifies" the explicit
    // null-handling back into a sentinel string.
    expect('~'.localeCompare('FRIDGE')).toBe(-1);   // ICU: punctuation first
    expect('~' > 'FRIDGE').toBe(true);              // code point: after letters
  });

  it('sorts unlocated rows among THEMSELVES by name, still last', async () => {
    mockDbSend.mockResolvedValueOnce({
      Items: [
        ingredient({ ingredientId: 'y', name: 'Yeast', storageLocation: null }),
        ingredient({ ingredientId: 'b', name: 'Butter', storageLocation: 'FRIDGE' }),
        ingredient({ ingredientId: 'a', name: 'Anise', storageLocation: '' }),
      ],
    });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/ingredients' }));

    // Empty string is as unlocated as null — `listIngredientsForCount` already
    // maps a falsy storageLocation to null in the projection.
    expect(JSON.parse(result.body).ingredients.map((i: any) => i.name))
      .toEqual(['Butter', 'Anise', 'Yeast']);
  });

  it('is a total order — every unlocated row sorts after every located one', async () => {
    // A comparator that is not antisymmetric produces an input-order-dependent
    // result, which is how the sentinel bug hid. Same set, reversed input.
    const rows = [
      ingredient({ ingredientId: 'n', name: 'Nutmeg', storageLocation: undefined }),
      ingredient({ ingredientId: 'z', name: 'Zest', storageLocation: 'STOREROOM' }),
      ingredient({ ingredientId: 'b', name: 'Butter', storageLocation: 'FRIDGE' }),
    ];

    for (const items of [rows, [...rows].reverse()]) {
      mockDbSend.mockReset();
      mockDbSend.mockResolvedValueOnce({ Items: items });
      const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/ingredients' }));
      expect(JSON.parse(result.body).ingredients.map((i: any) => i.name))
        .toEqual(['Butter', 'Zest', 'Nutmeg']);
    }
  });
});

// ─── PUT /api/pos/ingredients/bulk-update ────────────────────────────

describe('bulkUpdateStock — PUT /api/pos/ingredients/bulk-update', () => {
  it('writes each count, stamps the actor, and appends one dated snapshot', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-02T03:15:00.000Z') });

    mockDbSend
      .mockResolvedValueOnce({ Item: ingredient({ currentStock: 4 }) })                                    // Get oat-milk
      .mockResolvedValueOnce({})                                                                            // Update oat-milk
      .mockResolvedValueOnce({ Item: ingredient({ ingredientId: 'sugar', name: 'Sugar', unit: 'kg', storageLocation: 'STOREROOM', currentStock: 1 }) })
      .mockResolvedValueOnce({})                                                                            // Update sugar
      .mockResolvedValueOnce({});                                                                           // snapshot Put

    const result = await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: [
        { ingredientId: 'oat-milk', count: 7 },
        { ingredientId: 'sugar', count: 0.5 },
      ] }),
    }), 'ZZTEST-unused-actor');

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.updated).toBe(2);
    expect(body.errors).toEqual([]);
    expect(body.timestamp).toBe('2026-09-02T03:15:00.000Z');

    const updates = sentOfKind('Update');
    expect(updates).toHaveLength(2);
    expect(updates[0].TableName).toBe('test-ingredients');
    expect(updates[0].Key).toEqual({ PK: 'INGREDIENT#oat-milk', SK: 'META' });
    expect(updates[0].UpdateExpression).toBe('SET currentStock = :s, lastCountedAt = :t, lastCountedBy = :u');
    expect(updates[0].ExpressionAttributeValues).toEqual({
      ':s': 7, ':t': '2026-09-02T03:15:00.000Z', ':u': 'ZZTEST-unused-actor',
    });
    expect(updates[1].ExpressionAttributeValues[':s']).toBe(0.5);

    const put = sentOfKind('Put')[0];
    expect(put.TableName).toBe('test-settings');
    expect(put.Item.PK).toBe('STOCK_SNAPSHOT#2026-09-02');
    expect(put.Item.SK).toBe('2026-09-02T03:15:00.000Z');
    expect(put.Item.submittedBy).toBe('ZZTEST-unused-actor');
    expect(put.Item.counts).toEqual([
      { ingredientId: 'oat-milk', name: 'Oat Milk', unit: 'carton', storageLocation: 'FRIDGE', count: 7, previousCount: 4 },
      { ingredientId: 'sugar', name: 'Sugar', unit: 'kg', storageLocation: 'STOREROOM', count: 0.5, previousCount: 1 },
    ]);
  });

  it('records the previous count as null when the stored value is not numeric', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: ingredient({ currentStock: 'unknown' }) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: [{ ingredientId: 'oat-milk', count: 3 }] }),
    }), 'Ann');

    expect(sentOfKind('Put')[0].Item.counts[0].previousCount).toBeNull();
  });

  it('coerces a numeric-string count', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: ingredient() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: [{ ingredientId: 'oat-milk', count: '7' }] }),
    }), 'Ann');

    expect(sentOfKind('Update')[0].ExpressionAttributeValues[':s']).toBe(7);
  });

  it('falls back to "Unknown" when there is no actor', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: ingredient() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: [{ ingredientId: 'oat-milk', count: 1 }] }),
    }), '');

    expect(sentOfKind('Update')[0].ExpressionAttributeValues[':u']).toBe('Unknown');
    expect(sentOfKind('Put')[0].Item.submittedBy).toBe('Unknown');
  });

  it('rejects an empty counts array with 400 before any read', async () => {
    const result = await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: [] }),
    }), 'Ann');

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/counts/);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects a non-array counts with 400', async () => {
    const result = await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: { 'oat-milk': 3 } }),
    }), 'Ann');

    expect(result.statusCode).toBe(400);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('reports per-row errors, keeps going, and writes no snapshot when nothing succeeded', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: undefined }); // the 'ghost' lookup

    const result = await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: [
        { count: 4 },                              // no ingredientId
        { ingredientId: 'sugar', count: -1 },      // negative
        { ingredientId: 'cocoa', count: 'lots' },  // unparseable
        { ingredientId: 'ghost', count: 2 },       // not found
      ] }),
    }), 'Ann');

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.updated).toBe(0);
    expect(body.errors).toEqual([
      { error: 'missing ingredientId' },
      { ingredientId: 'sugar', error: 'invalid count' },
      { ingredientId: 'cocoa', error: 'invalid count' },
      { ingredientId: 'ghost', error: 'not found' },
    ]);

    // Only the one existence check; no stock write, no snapshot.
    expect(sentOfKind('Get')).toHaveLength(1);
    expect(sentOfKind('Update')).toHaveLength(0);
    expect(sentOfKind('Put')).toHaveLength(0);
  });

  it('a bad row does not stop the good rows in the same batch', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: ingredient() }) // oat-milk Get
      .mockResolvedValueOnce({})                    // oat-milk Update
      .mockResolvedValueOnce({});                   // snapshot Put

    const result = await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: [
        { ingredientId: 'sugar', count: -3 },
        { ingredientId: 'oat-milk', count: 6 },
      ] }),
    }), 'Ann');

    const body = JSON.parse(result.body);
    expect(body.updated).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(sentOfKind('Put')[0].Item.counts.map((c: any) => c.ingredientId)).toEqual(['oat-milk']);
  });

  it('accepts a count of 0 — an emptied container is a real count', async () => {
    mockDbSend
      .mockResolvedValueOnce({ Item: ingredient({ currentStock: 4 }) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handlePos(makeEvent({
      path: '/api/pos/ingredients/bulk-update',
      body: JSON.stringify({ counts: [{ ingredientId: 'oat-milk', count: 0 }] }),
    }), 'Ann');

    expect(JSON.parse(result.body).updated).toBe(1);
    expect(sentOfKind('Update')[0].ExpressionAttributeValues[':s']).toBe(0);
  });
});

// ─── GET /api/pos/usage ──────────────────────────────────────────────

describe('getUsageToday — GET /api/pos/usage', () => {
  it("reads today's usage log by date-keyed PK", async () => {
    jest.useFakeTimers({ now: new Date('2026-09-02T03:15:00.000Z') });
    mockDbSend.mockResolvedValueOnce({ Item: { usage: { 'oat-milk': 450 } } });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/usage' }));

    expect(result.statusCode).toBe(200);
    const get = sentOfKind('Get')[0];
    expect(get.TableName).toBe('test-settings');
    expect(get.Key).toEqual({ PK: 'USAGE_LOG#2026-09-02', SK: 'META' });
    expect(JSON.parse(result.body)).toEqual({
      date: '2026-09-02',
      usage: { 'oat-milk': 450 },
    });
  });

  it('returns an empty usage map when no log exists yet', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: undefined });

    const result = await handlePos(makeEvent({ httpMethod: 'GET', path: '/api/pos/usage' }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).usage).toEqual({});
  });
});

export {};
