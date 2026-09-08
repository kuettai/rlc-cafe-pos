/**
 * The admin CATALOGUE routes in `backend/src/routes/admin.ts` — menu items,
 * ingredients, and recipes. Users / settings / reports / the misc tail of that
 * file are deliberately out of scope here; `admin.ts` is ~1030 lines and is
 * being covered by one suite per sub-resource.
 *
 * Four things are load-bearing and each is the reason a test below exists:
 *
 * 1. **Path-matching order is the hazard.** These branches pair a method with an
 *    UNANCHORED regex (`/\/admin\/menu\/[^/]+$/`), so the only thing keeping
 *    `PUT /admin/menu/{id}/toggle-active` out of the generic `PUT
 *    /admin/menu/{id}` handler is the ORDER of the `if`s and the fact that
 *    `[^/]+$` cannot cross a slash. Both directions are pinned, and so is
 *    `PUT /admin/menu/bulk-toggle` — a literal that the generic per-id regex
 *    matches perfectly, and which is safe only because it is tested first.
 *    The teeth are the SHAPE of the command sent: the toggle routes READ before
 *    they write (`GetCommand`, then `SET isActive = :a`), the generic ones never
 *    read and build `SET #k = :k` from the body. Those are impossible to confuse,
 *    so an assertion on them cannot pass for the wrong branch.
 *
 * 2. **`isActive` is read with two DIFFERENT rules, on purpose.** Menu:
 *    `!(isActive === true)` — a record MISSING the field is off the menu, which
 *    matches `admin-menu.js`'s `onTheMenu = item => item.isActive === true` and
 *    the public `GET /api/menu` filter (`isActive = :active`). Ingredients:
 *    `isActive !== false` — missing means ACTIVE, for legacy rows written before
 *    the field existed. The divergence is commented in the source; it is pinned
 *    here so nobody "harmonises" one of them and silently changes what a toggle
 *    click does to a legacy row.
 *
 * 3. **The recipe write is a DELETE-then-PUT replace, and it is not atomic.**
 *    Every existing row under `RECIPE#{menuItemId}#{variantId}` is deleted before
 *    the first new row is written, so a failure after the deletes leaves NO
 *    recipe. Both failure shapes are pinned as the behaviour they currently are.
 *
 * 4. **Assertions are on what the handler produced** — the `Item`, the
 *    `UpdateExpression`, the `Key`, the parsed response — never on the fixture
 *    this file constructed. Where a staged value IS the assertion (the `ALL_NEW`
 *    passthrough) the fixture carries a field the handler never names, so the
 *    passthrough is what is being proven rather than the round trip.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked; the S3 client `admin.ts` builds at import time is mocked too. No
 * network, no credentials, nothing written to production — so no `ZZTEST_` marker
 * applies (that rule covers suites that create real records).
 */

import { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbSend = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  SETTINGS_TABLE: 'test-settings',
  INGREDIENTS_TABLE: 'test-ingredients',
  USERS_TABLE: 'test-users',
  CUSTOMERS_TABLE: 'test-customers',
  VOUCHERS_TABLE: 'test-vouchers',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
  DeleteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Delete' })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Put' })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://example.invalid/presigned'),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleAdmin } = require('../src/routes/admin');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LATTE = {
  PK: 'MENU#latte-001', SK: 'META', menuItemId: 'latte-001', name: 'Latte',
  category: 'DRINK', basePrice: 8, sortOrder: 1, isActive: true, isEnabledToday: true,
};

const MOCHA_OFF = {
  PK: 'MENU#mocha-002', SK: 'META', menuItemId: 'mocha-002', name: 'Mocha',
  category: 'DRINK', basePrice: 9, sortOrder: 2, isActive: false, isEnabledToday: false,
};

/** A pre-`isActive` record. Both toggle handlers treat this shape differently. */
const LEGACY_TEA = {
  PK: 'MENU#tea-003', SK: 'META', menuItemId: 'tea-003', name: 'Tea',
  category: 'DRINK', basePrice: 5,
};

const COOKIE = {
  PK: 'MENU#cookie-004', SK: 'META', menuItemId: 'cookie-004', name: 'Cookie',
  category: 'FOOD', basePrice: 3, sortOrder: 5,
  isActive: true, isEnabledToday: false, foodQuantityToday: 12, foodReserved: 4,
};

const MUFFIN = {
  PK: 'MENU#muffin-005', SK: 'META', menuItemId: 'muffin-005', name: 'Muffin',
  category: 'FOOD', basePrice: 4, sortOrder: 6, isActive: true, isEnabledToday: false,
};

const MILK = {
  PK: 'INGREDIENT#milk-001', SK: 'META', ingredientId: 'milk-001', name: 'Fresh Milk',
  unit: 'L', currentStock: 6, lowStockThreshold: 4, storageLocation: 'Fridge', isActive: true,
};

const SYRUP_OFF = {
  PK: 'INGREDIENT#syrup-002', SK: 'META', ingredientId: 'syrup-002', name: 'Vanilla Syrup',
  unit: 'bottle', currentStock: 1, lowStockThreshold: 2, storageLocation: 'Shelf', isActive: false,
};

/** A pre-`isActive` ingredient row — "missing means active" per the source. */
const LEGACY_BEANS = {
  PK: 'INGREDIENT#beans-003', SK: 'META', ingredientId: 'beans-003', name: 'Beans',
  unit: 'kg', currentStock: 3, lowStockThreshold: 2, storageLocation: 'Shelf',
};

// ─── Staging ──────────────────────────────────────────────────────────────────

interface World {
  /** Rows the MENU_TABLE Scan returns. */
  menuRows?: Record<string, unknown>[];
  /** Rows the INGREDIENTS_TABLE Scan returns. */
  ingredientRows?: Record<string, unknown>[];
  /** Rows a `PK = RECIPE#…` Query returns. */
  recipeRows?: Record<string, unknown>[];
  /** Records a GetCommand can find, keyed by PK. */
  records?: Record<string, Record<string, unknown>>;
  /** What an UpdateCommand's `ALL_NEW` returns. Omit for no `Attributes`. */
  updateAttributes?: Record<string, unknown>;
  /** Truncate the Scan — a second page exists that nothing asks for. */
  scanLastKey?: Record<string, unknown>;
  /** Make every PutCommand reject, to probe mid-replace failure. */
  failPut?: string;
}

/**
 * Answer every read from a described world, keyed on the `TableName` and command
 * the handler actually asked for — not a `mockResolvedValueOnce` queue, which
 * lets a fixture silently fill the wrong slot (`invariants`, Test teeth). Several
 * of these handlers issue a Scan AND a Get AND a Query against the same table.
 */
function stage(world: World = {}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-menu') {
      return { Items: world.menuRows || [], LastEvaluatedKey: world.scanLastKey };
    }
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-ingredients') {
      return { Items: world.ingredientRows || [], LastEvaluatedKey: world.scanLastKey };
    }
    if (cmd.__cmd === 'Query' && cmd.TableName === 'test-ingredients') {
      return { Items: world.recipeRows || [] };
    }
    if (cmd.__cmd === 'Get') {
      const rec = world.records?.[String(cmd.Key?.PK || '')];
      return rec ? { Item: rec } : {};
    }
    if (cmd.__cmd === 'Put' && world.failPut) {
      throw new Error(world.failPut);
    }
    if (cmd.__cmd === 'Update') {
      return world.updateAttributes ? { Attributes: world.updateAttributes } : {};
    }
    return {};
  });
}

function makeEvent(overrides: Record<string, unknown> = {}): APIGatewayProxyEvent {
  const { body, ...rest } = overrides as any;
  return {
    httpMethod: 'GET',
    path: '/api/admin/menu',
    body: body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...rest,
  } as unknown as APIGatewayProxyEvent;
}

/** Every command the handler sent, in order. */
function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function sent(kind: string, table?: string) {
  return cmds().filter((c) => c.__cmd === kind && (table === undefined || c.TableName === table));
}

/** Call the handler and return `[statusCode, parsedBody]`. */
async function call(event: APIGatewayProxyEvent): Promise<[number, any]> {
  const r = await handleAdmin(event);
  expect(r.headers).toEqual({ 'Content-Type': 'application/json' });
  return [r.statusCode, JSON.parse(r.body)];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  stage();
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/menu
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/menu', () => {
  it('returns INACTIVE items too — the admin list is deliberately unfiltered', async () => {
    // The teeth: the public `GET /api/menu` enforces isActive/isEnabledToday with
    // a FilterExpression on its Scan. If that filter were ever copied here the
    // admin could no longer see, or re-enable, anything it had switched off.
    stage({ menuRows: [LATTE, MOCHA_OFF] });

    const [status, body] = await call(makeEvent({ path: '/api/admin/menu' }));

    expect(status).toBe(200);
    expect(body.items.map((i: any) => i.menuItemId)).toEqual(['latte-001', 'mocha-002']);
    const scans = sent('Scan', 'test-menu');
    expect(scans).toHaveLength(1);
    expect(scans[0].FilterExpression).toBeUndefined();
    expect(Object.keys(scans[0])).toEqual(['TableName', '__cmd']);
  });

  it('sorts by sortOrder and treats a MISSING sortOrder as 0', async () => {
    // Every legacy menu record has no sortOrder at all, so the `|| 0` is the
    // common case and not an edge case. The sort is the handler's, in JS.
    stage({ menuRows: [COOKIE, LEGACY_TEA, LATTE] });

    const [, body] = await call(makeEvent({ path: '/api/admin/menu' }));

    expect(body.items.map((i: any) => i.name)).toEqual(['Tea', 'Latte', 'Cookie']);
  });

  it('drops rows whose SK is not META', async () => {
    stage({ menuRows: [LATTE, { PK: 'MENU#latte-001', SK: 'STATS#2026-08-16', sold: 4 }] });

    const [, body] = await call(makeEvent({ path: '/api/admin/menu' }));

    expect(body.items).toHaveLength(1);
    expect(body.items[0].SK).toBe('META');
  });

  it('returns an empty list, not an error, for an empty table', async () => {
    stage({ menuRows: [] });
    expect(await call(makeEvent({ path: '/api/admin/menu' }))).toEqual([200, { items: [] }]);
  });

  it('writes nothing — a list is a read', async () => {
    stage({ menuRows: [LATTE, MOCHA_OFF] });
    await call(makeEvent({ path: '/api/admin/menu' }));
    expect(cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd))).toHaveLength(0);
  });

  it('returns 500 with the message when the Scan throws', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));

    const [status, body] = await call(makeEvent({ path: '/api/admin/menu' }));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'ProvisionedThroughputExceeded' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/admin/menu
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/menu', () => {
  const create = (body: unknown) =>
    call(makeEvent({ httpMethod: 'POST', path: '/api/admin/menu', body }));

  it('writes the item it returns, with a generated id used for BOTH PK and menuItemId', async () => {
    const [status, body] = await create({ name: 'Flat White', category: 'DRINK', basePrice: 9 });

    expect(status).toBe(201);
    const puts = sent('Put', 'test-menu');
    expect(puts).toHaveLength(1);
    const item = puts[0].Item;
    expect(item.menuItemId).toMatch(UUID_V4);
    expect(item.PK).toBe(`MENU#${item.menuItemId}`);
    expect(item.SK).toBe('META');
    // The 201 body is the record that was stored, not a re-derivation of it.
    expect(body).toEqual(item);
  });

  it('defaults variants, variantGroups, imageUrl, sortOrder and both flags', async () => {
    await create({ name: 'Flat White', category: 'DRINK', basePrice: 9 });

    const item = sent('Put', 'test-menu')[0].Item;
    expect(item.variants).toEqual([]);
    expect(item.variantGroups).toEqual([]);
    expect(item.imageUrl).toBeNull();
    expect(item.sortOrder).toBe(0);
    // A new item is on the menu AND serving today.
    expect(item.isActive).toBe(true);
    expect(item.isEnabledToday).toBe(true);
  });

  it('forces isActive/isEnabledToday true even when the body says otherwise', async () => {
    await create({ name: 'Flat White', category: 'DRINK', basePrice: 9, isActive: false, isEnabledToday: false });

    const item = sent('Put', 'test-menu')[0].Item;
    expect(item.isActive).toBe(true);
    expect(item.isEnabledToday).toBe(true);
  });

  it('omits celebrationEligible entirely when the body omits it', async () => {
    await create({ name: 'Flat White', category: 'DRINK', basePrice: 9 });
    expect('celebrationEligible' in sent('Put', 'test-menu')[0].Item).toBe(false);
  });

  it('stores celebrationEligible FALSE when explicitly sent — the guard is presence-gated', async () => {
    // `!== undefined`, not truthiness: an admin turning celebration eligibility
    // off must produce a stored `false`, not an absent attribute.
    await create({ name: 'Flat White', category: 'DRINK', basePrice: 9, celebrationEligible: false });
    expect(sent('Put', 'test-menu')[0].Item.celebrationEligible).toBe(false);
  });

  it('gives two creates two different ids', async () => {
    await create({ name: 'A', category: 'DRINK', basePrice: 1 });
    const first = sent('Put', 'test-menu')[0].Item.menuItemId;
    stage();
    await create({ name: 'B', category: 'DRINK', basePrice: 2 });
    expect(sent('Put', 'test-menu')[0].Item.menuItemId).not.toBe(first);
  });

  it('passes sortOrder 0 through rather than treating it as missing', async () => {
    await create({ name: 'First', category: 'DRINK', basePrice: 9, sortOrder: 0 });
    expect(sent('Put', 'test-menu')[0].Item.sortOrder).toBe(0);
  });

  it('DEFECT: validates nothing — a bodiless POST writes name/category/basePrice undefined', async () => {
    // Pinned as current behaviour, not endorsed. `docClient` is built with
    // `DynamoDBDocumentClient.from(client)` and no `removeUndefinedValues`, so in
    // production this Put is rejected by the marshaller and the admin sees a bare
    // 500 rather than a message naming the missing field.
    const [status] = await create({});

    expect(status).toBe(201);
    const item = sent('Put', 'test-menu')[0].Item;
    expect(item.name).toBeUndefined();
    expect(item.category).toBeUndefined();
    expect(item.basePrice).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/admin/menu/bulk-toggle
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/admin/menu/bulk-toggle', () => {
  const bulk = (body: unknown) =>
    call(makeEvent({ httpMethod: 'PUT', path: '/api/admin/menu/bulk-toggle', body }));

  it('PATH ORDER: "bulk-toggle" is NOT swallowed by the generic PUT /admin/menu/{id}', async () => {
    // `/\/admin\/menu\/[^/]+$/` matches this path exactly as well as it matches a
    // real id, so the ONLY thing keeping the collection route intact is that it is
    // tested first. If the two `if`s were reordered, this request would write a
    // record at `PK: MENU#bulk-toggle` with attributes `enable` and `category`,
    // and every menu item would stay as it was.
    stage({ menuRows: [LATTE, MOCHA_OFF] });

    const [status, body] = await bulk({ enable: true, category: 'DRINK' });

    expect(status).toBe(200);
    expect(body).toEqual({ updated: 2 });
    for (const u of sent('Update', 'test-menu')) {
      expect(u.Key.PK).not.toBe('MENU#bulk-toggle');
      expect(u.UpdateExpression).toBe('SET #e = :e');
    }
    expect(cmds().some((c) => c.__cmd === 'Scan')).toBe(true);
  });

  it('sets isEnabledToday on every META row and returns the count', async () => {
    stage({ menuRows: [LATTE, MOCHA_OFF, COOKIE] });

    const [status, body] = await bulk({ enable: false });

    expect(status).toBe(200);
    expect(body).toEqual({ updated: 3 });
    const updates = sent('Update', 'test-menu');
    expect(updates.map((u) => u.Key)).toEqual([
      { PK: 'MENU#latte-001', SK: 'META' },
      { PK: 'MENU#mocha-002', SK: 'META' },
      { PK: 'MENU#cookie-004', SK: 'META' },
    ]);
    for (const u of updates) {
      expect(u.UpdateExpression).toBe('SET #e = :e');
      expect(u.ExpressionAttributeNames).toEqual({ '#e': 'isEnabledToday' });
      expect(u.ExpressionAttributeValues).toEqual({ ':e': false });
    }
  });

  it('touches isEnabledToday ONLY — the permanent catalogue flag is untouched', async () => {
    // Two flags with two meanings: `isActive` is "on the menu" (survives the
    // day), `isEnabledToday` is "serving now". A bulk day-toggle that also wrote
    // isActive would quietly delist items from the catalogue.
    stage({ menuRows: [LATTE, MOCHA_OFF] });

    await bulk({ enable: true });

    for (const u of sent('Update', 'test-menu')) {
      expect(u.UpdateExpression).not.toContain('isActive');
      expect(JSON.stringify(u.ExpressionAttributeNames)).not.toContain('isActive');
    }
  });

  it('restricts to the requested category, and updates NOTHING outside it', async () => {
    stage({ menuRows: [LATTE, MOCHA_OFF, COOKIE, MUFFIN] });

    const [, body] = await bulk({ enable: true, category: 'FOOD' });

    expect(body).toEqual({ updated: 2 });
    expect(sent('Update', 'test-menu').map((u) => u.Key.PK))
      .toEqual(['MENU#cookie-004', 'MENU#muffin-005']);
  });

  it('an unknown category updates nothing and reports 0 — not an error', async () => {
    stage({ menuRows: [LATTE, COOKIE] });

    const [status, body] = await bulk({ enable: true, category: 'MERCH' });

    expect(status).toBe(200);
    expect(body).toEqual({ updated: 0 });
    expect(sent('Update', 'test-menu')).toHaveLength(0);
  });

  it('skips non-META rows', async () => {
    stage({ menuRows: [LATTE, { PK: 'MENU#latte-001', SK: 'STATS#2026-08-16', category: 'DRINK' }] });

    const [, body] = await bulk({ enable: true });

    expect(body).toEqual({ updated: 1 });
    expect(sent('Update', 'test-menu')[0].Key.SK).toBe('META');
  });

  it('the STRING "false" DISABLES — `enable` is not coerced with `!!`', async () => {
    // Regression: this was `!!enable`, and `!!'false' === true`. The admin UI
    // sends a real boolean, so it was latent rather than live — but a
    // query-string-ish or form-encoded caller asking to switch the whole menu
    // OFF switched it ON, on a Sunday morning, with a 200 and a plausible count.
    stage({ menuRows: [LATTE] });

    await bulk({ enable: 'false' });

    expect(sent('Update', 'test-menu')[0].ExpressionAttributeValues).toEqual({ ':e': false });
  });

  it('the STRING "true" enables, matching the `=== \'true\'` flags elsewhere', async () => {
    // The other side of the same parse: a form-encoded caller must still be able
    // to turn the menu ON, or the fix above would have made the route
    // unusable for exactly the caller it was fixed for.
    stage({ menuRows: [LATTE] });

    await bulk({ enable: 'true' });

    expect(sent('Update', 'test-menu')[0].ExpressionAttributeValues).toEqual({ ':e': true });
  });

  it.each([
    ['a missing `enable`', {}],
    ['an explicit null', { enable: null }],
    ['the number 1 — truthy, but not a boolean', { enable: 1 }],
    ['the string "yes"', { enable: 'yes' }],
  ])('%s disables: only `true` / "true" enable', async (_label, body) => {
    stage({ menuRows: [LATTE] });
    await bulk(body);
    expect(sent('Update', 'test-menu')[0].ExpressionAttributeValues).toEqual({ ':e': false });
  });

  it('DEFECT: the Scan is NOT paginated, so a truncated page under-reports a MUTATION', async () => {
    // `invariants` — "a BULK mutating route paginates on LastEvaluatedKey". This
    // one does not: one Scan, `LastEvaluatedKey` discarded. The count returned to
    // the admin then describes only the first page, so the UI says "updated 1"
    // and the untouched remainder looks like it was handled.
    stage({ menuRows: [LATTE], scanLastKey: { PK: 'MENU#latte-001', SK: 'META' } });

    const [, body] = await bulk({ enable: true });

    expect(sent('Scan', 'test-menu')).toHaveLength(1);
    expect(sent('Scan', 'test-menu')[0].ExclusiveStartKey).toBeUndefined();
    expect(body).toEqual({ updated: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/admin/menu/duplicate-food
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/menu/duplicate-food', () => {
  const duplicate = () =>
    call(makeEvent({ httpMethod: 'POST', path: '/api/admin/menu/duplicate-food', body: {} }));

  it('re-enables every FOOD row and RESETS foodReserved to 0', async () => {
    // The reserved counter is a per-service reservation against
    // foodQuantityToday. Carrying yesterday's value into a new service makes
    // stock look sold that never was.
    stage({ menuRows: [LATTE, COOKIE, MUFFIN] });

    const [status, body] = await duplicate();

    expect(status).toBe(200);
    expect(body.duplicated).toBe(2);
    const updates = sent('Update', 'test-menu');
    expect(updates.map((u) => u.Key.PK)).toEqual(['MENU#cookie-004', 'MENU#muffin-005']);
    for (const u of updates) {
      expect(u.UpdateExpression).toBe('SET #e = :e, #r = :r');
      expect(u.ExpressionAttributeNames).toEqual({ '#e': 'isEnabledToday', '#r': 'foodReserved' });
      expect(u.ExpressionAttributeValues).toEqual({ ':e': true, ':r': 0 });
    }
  });

  it('reports the PRIOR foodQuantityToday per item, defaulting a missing one to 0', async () => {
    stage({ menuRows: [COOKIE, MUFFIN] });

    const [, body] = await duplicate();

    // COOKIE carries 12; MUFFIN carries none.
    expect(body.items).toEqual([
      { name: 'Cookie', foodQuantityToday: 12 },
      { name: 'Muffin', foodQuantityToday: 0 },
    ]);
  });

  it('does NOT rewrite foodQuantityToday — the quantity carries over, only the reservation clears', async () => {
    stage({ menuRows: [COOKIE] });

    await duplicate();

    const u = sent('Update', 'test-menu')[0];
    expect(u.UpdateExpression).not.toContain('foodQuantityToday');
    expect(JSON.stringify(u.ExpressionAttributeNames)).not.toContain('foodQuantityToday');
  });

  it('leaves DRINK rows completely alone', async () => {
    stage({ menuRows: [LATTE, MOCHA_OFF] });

    const [, body] = await duplicate();

    expect(body).toEqual({ duplicated: 0, items: [] });
    expect(sent('Update', 'test-menu')).toHaveLength(0);
  });

  it('DEFECT: unpaginated Scan in a bulk MUTATING route, same as bulk-toggle', async () => {
    stage({ menuRows: [COOKIE], scanLastKey: { PK: 'MENU#cookie-004', SK: 'META' } });

    const [, body] = await duplicate();

    expect(sent('Scan', 'test-menu')).toHaveLength(1);
    expect(body.duplicated).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/admin/menu/{id}/toggle-active — the MORE SPECIFIC path
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/admin/menu/{id}/toggle-active', () => {
  const toggle = (id: string, body: unknown = {}) =>
    call(makeEvent({ httpMethod: 'PUT', path: `/api/admin/menu/${id}/toggle-active`, body }));

  it('PATH ORDER: the toggle wins over the generic PUT /admin/menu/{id}', async () => {
    // The decisive tell is the SHAPE of what was sent, not the status code. The
    // toggle branch READS first (`GetCommand`) and writes the fixed expression
    // `SET isActive = :a` with the value it COMPUTED. The generic branch never
    // reads and builds `SET #k = :k` from the body — with an empty body it would
    // emit the malformed `'SET '` and return 500 (see the generic group below).
    stage({ records: { 'MENU#latte-001': LATTE } });

    const [status] = await toggle('latte-001');

    expect(status).toBe(200);
    expect(sent('Get', 'test-menu')).toHaveLength(1);
    const u = sent('Update', 'test-menu')[0];
    expect(u.UpdateExpression).toBe('SET isActive = :a');
    expect(u.ExpressionAttributeNames).toBeUndefined();
  });

  it('flips true to false and reads the id from the SECOND-TO-LAST segment', async () => {
    stage({ records: { 'MENU#latte-001': LATTE } });

    await toggle('latte-001');

    expect(sent('Get', 'test-menu')[0].Key).toEqual({ PK: 'MENU#latte-001', SK: 'META' });
    const u = sent('Update', 'test-menu')[0];
    expect(u.Key).toEqual({ PK: 'MENU#latte-001', SK: 'META' });
    expect(u.ExpressionAttributeValues).toEqual({ ':a': false });
    expect(u.ReturnValues).toBe('ALL_NEW');
  });

  it('flips false to true', async () => {
    stage({ records: { 'MENU#mocha-002': MOCHA_OFF } });
    await toggle('mocha-002');
    expect(sent('Update', 'test-menu')[0].ExpressionAttributeValues).toEqual({ ':a': true });
  });

  it('a MISSING isActive is treated as OFF the menu, so the toggle turns it ON', async () => {
    // `!(isActive === true)`. This matches `admin-menu.js`'s
    // `onTheMenu = item => item.isActive === true` and the public menu filter
    // `isActive = :active`, both of which hide a record that lacks the field.
    // NOTE the opposite rule applies to ingredients — see that group.
    stage({ records: { 'MENU#tea-003': LEGACY_TEA } });

    await toggle('tea-003');

    expect(sent('Update', 'test-menu')[0].ExpressionAttributeValues).toEqual({ ':a': true });
  });

  it('touches isActive ONLY — isEnabledToday, price and name are not rewritten', async () => {
    stage({ records: { 'MENU#latte-001': LATTE } });

    await toggle('latte-001');

    const u = sent('Update', 'test-menu')[0];
    expect(u.UpdateExpression).toBe('SET isActive = :a');
    expect(Object.keys(u.ExpressionAttributeValues)).toEqual([':a']);
  });

  it('IGNORES the body — the next state comes from the STORED record', async () => {
    // A toggle is a read-modify-write, not an assignment. A caller cannot pin
    // isActive to a value, so two racing clicks cannot both "win" with a stale
    // idea of the current state.
    stage({ records: { 'MENU#latte-001': LATTE } });

    await toggle('latte-001', { isActive: true, name: 'Renamed' });

    const u = sent('Update', 'test-menu')[0];
    expect(u.ExpressionAttributeValues).toEqual({ ':a': false });
    expect(u.UpdateExpression).not.toContain('name');
  });

  it('404s when the item does not exist, and issues NO write', async () => {
    stage({ records: {} });

    const [status, body] = await toggle('ghost-999');

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Menu item not found' });
    expect(sent('Update', 'test-menu')).toHaveLength(0);
    expect(sent('Get', 'test-menu')).toHaveLength(1);
  });

  it('returns the STORED record from ALL_NEW, not a synthesised two-field object', async () => {
    // The staged Attributes carry `name`, which this branch never names — so what
    // is being proven is the passthrough, not a round trip through the fixture.
    stage({
      records: { 'MENU#latte-001': LATTE },
      updateAttributes: { ...LATTE, isActive: false, name: 'Latte' },
    });

    const [status, body] = await toggle('latte-001');

    expect(status).toBe(200);
    expect(body.name).toBe('Latte');
    expect(body.isEnabledToday).toBe(true);
    expect(body.isActive).toBe(false);
  });

  it('falls back to { menuItemId, isActive } when ALL_NEW returns no Attributes', async () => {
    stage({ records: { 'MENU#latte-001': LATTE } });
    expect(await toggle('latte-001')).toEqual([200, { menuItemId: 'latte-001', isActive: false }]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/admin/menu/{id} — the GENERIC update
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/admin/menu/{id}', () => {
  const update = (id: string, body: unknown) =>
    call(makeEvent({ httpMethod: 'PUT', path: `/api/admin/menu/${id}`, body }));

  it('builds one SET clause per body key and returns the keys it wrote', async () => {
    const [status, body] = await update('latte-001', { name: 'Latte (Large)', basePrice: 10 });

    expect(status).toBe(200);
    expect(body).toEqual({ menuItemId: 'latte-001', updated: ['name', 'basePrice'] });
    const u = sent('Update', 'test-menu')[0];
    expect(u.Key).toEqual({ PK: 'MENU#latte-001', SK: 'META' });
    expect(u.UpdateExpression).toBe('SET #name = :name, #basePrice = :basePrice');
    expect(u.ExpressionAttributeNames).toEqual({ '#name': 'name', '#basePrice': 'basePrice' });
    expect(u.ExpressionAttributeValues).toEqual({ ':name': 'Latte (Large)', ':basePrice': 10 });
  });

  it('PATH ORDER, the other direction: a plain id is NOT read-modify-flipped', async () => {
    // The mirror of the toggle test. `/\/admin\/menu\/[^/]+\/toggle-active$/`
    // must not match a bare id, or an ordinary field edit would silently become
    // an isActive flip — and would ignore the body entirely.
    stage({ records: { 'MENU#latte-001': LATTE } });

    const [status] = await update('latte-001', { basePrice: 10 });

    expect(status).toBe(200);
    expect(sent('Get', 'test-menu')).toHaveLength(0);
    expect(sent('Update', 'test-menu')[0].UpdateExpression).toBe('SET #basePrice = :basePrice');
    expect(sent('Update', 'test-menu')[0].ReturnValues).toBeUndefined();
  });

  it('sends isActive through the generic path when the URL asks for a plain update', async () => {
    // A path without `/toggle-active` writes exactly what the body says, even for
    // the same attribute the toggle owns.
    const [, body] = await update('mocha-002', { isActive: true });

    expect(body.updated).toEqual(['isActive']);
    expect(sent('Update', 'test-menu')[0].ExpressionAttributeValues).toEqual({ ':isActive': true });
    expect(sent('Get', 'test-menu')).toHaveLength(0);
  });

  it('does not verify the item exists — it upserts a record for an unknown id', async () => {
    stage({ records: {} });

    const [status] = await update('ghost-999', { name: 'Ghost' });

    // No ConditionExpression, no prior Get: DynamoDB creates the row.
    expect(status).toBe(200);
    expect(sent('Update', 'test-menu')[0].ConditionExpression).toBeUndefined();
  });

  it('writes nested and null values through unchanged', async () => {
    await update('latte-001', {
      variantGroups: [{ name: 'Milk', options: [{ name: 'Oat Milk', priceDelta: 1 }] }],
      imageUrl: null,
    });

    const v = sent('Update', 'test-menu')[0].ExpressionAttributeValues;
    expect(v[':variantGroups']).toEqual([{ name: 'Milk', options: [{ name: 'Oat Milk', priceDelta: 1 }] }]);
    expect(v[':imageUrl']).toBeNull();
  });

  it('DEFECT: an EMPTY body builds the malformed UpdateExpression "SET "', async () => {
    // `fields` is empty, so `SET ${fields.join(', ')}` is the string `'SET '`.
    // DynamoDB rejects it, the catch-all turns it into a 500, and the admin gets
    // a raw ValidationException instead of a 400. The verses branch in this very
    // file gets this right — `if (!updates.length) return res(400, …)` at
    // admin.ts:898 — so the fix already exists ten lines away.
    const [status, body] = await update('latte-001', {});

    expect(status).toBe(200);
    const u = sent('Update', 'test-menu')[0];
    expect(u.UpdateExpression).toBe('SET ');
    expect(u.ExpressionAttributeNames).toEqual({});
    expect(u.ExpressionAttributeValues).toEqual({});
    expect(body).toEqual({ menuItemId: 'latte-001', updated: [] });
  });

  it('DEFECT: a body key named PK is written as an update to a KEY attribute', async () => {
    // Nothing filters reserved attributes, so this reaches DynamoDB as
    // `SET #PK = :PK` on the partition key and fails with a 500.
    const [status] = await update('latte-001', { PK: 'MENU#hijacked' });

    expect(status).toBe(200);
    expect(sent('Update', 'test-menu')[0].UpdateExpression).toBe('SET #PK = :PK');
  });

  it('surfaces a failed write as 500 with the DynamoDB message', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue(new Error('ValidationException: Invalid UpdateExpression'));

    const [status, body] = await update('latte-001', { name: 'x' });

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'ValidationException: Invalid UpdateExpression' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/admin/menu/{id}
// ══════════════════════════════════════════════════════════════════════════════

describe('DELETE /api/admin/menu/{id}', () => {
  it('deletes the META record and echoes the id', async () => {
    const [status, body] = await call(
      makeEvent({ httpMethod: 'DELETE', path: '/api/admin/menu/latte-001' })
    );

    expect(status).toBe(200);
    expect(body).toEqual({ deleted: 'latte-001' });
    const deletes = sent('Delete', 'test-menu');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Key).toEqual({ PK: 'MENU#latte-001', SK: 'META' });
  });

  it('deletes unconditionally — no existence check, no Get', async () => {
    stage({ records: {} });

    const [status, body] = await call(
      makeEvent({ httpMethod: 'DELETE', path: '/api/admin/menu/ghost-999' })
    );

    expect(status).toBe(200);
    expect(body).toEqual({ deleted: 'ghost-999' });
    expect(sent('Get')).toHaveLength(0);
  });

  it('a DELETE on the COLLECTION is a 404 and destroys nothing', async () => {
    // There is no bulk delete, and the per-id regex cannot match the bare
    // collection path. Worth pinning: this is the request an over-eager UI or a
    // trimmed trailing segment would send.
    stage({ menuRows: [LATTE, COOKIE] });

    const [status, body] = await call(makeEvent({ httpMethod: 'DELETE', path: '/api/admin/menu' }));

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not found', path: '/api/admin/menu', method: 'DELETE' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('a DELETE on /menu/{id}/toggle-active is a 404, not a delete of the item', async () => {
    const [status, body] = await call(
      makeEvent({ httpMethod: 'DELETE', path: '/api/admin/menu/latte-001/toggle-active' })
    );

    expect(status).toBe(404);
    expect(body.path).toBe('/api/admin/menu/latte-001/toggle-active');
    expect(sent('Delete')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Ingredients
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/ingredients', () => {
  const create = (body: unknown) =>
    call(makeEvent({ httpMethod: 'POST', path: '/api/admin/ingredients', body }));

  it('writes the record it returns, with the id on PK and ingredientId', async () => {
    const [status, body] = await create({
      name: 'Oat Milk', unit: 'L', usageUnit: 'ml',
      currentStock: 6, lowStockThreshold: 2, storageLocation: 'Fridge',
    });

    expect(status).toBe(201);
    const puts = sent('Put', 'test-ingredients');
    expect(puts).toHaveLength(1);
    const item = puts[0].Item;
    expect(item.ingredientId).toMatch(UUID_V4);
    expect(item.PK).toBe(`INGREDIENT#${item.ingredientId}`);
    expect(item.SK).toBe('META');
    expect(item.name).toBe('Oat Milk');
    expect(item.usageUnit).toBe('ml');
    expect(item.isActive).toBe(true);
    expect(body).toEqual(item);
  });

  it('defaults usageUnit to null and forces isActive true', async () => {
    await create({ name: 'Sugar', unit: 'kg', currentStock: 2, lowStockThreshold: 1, storageLocation: 'Shelf', isActive: false });

    const item = sent('Put', 'test-ingredients')[0].Item;
    expect(item.usageUnit).toBeNull();
    expect(item.isActive).toBe(true);
  });

  it('does not invent stock numbers — a missing currentStock stays undefined', async () => {
    // Pinned deliberately: `|| 0` here would make an unspecified stock look
    // counted. It is absent, and the restock report's `currentStock <= threshold`
    // comparison has to cope with that.
    await create({ name: 'Sugar', unit: 'kg' });

    const item = sent('Put', 'test-ingredients')[0].Item;
    expect(item.currentStock).toBeUndefined();
    expect(item.lowStockThreshold).toBeUndefined();
  });

  it('writes to the INGREDIENTS table, never the MENU table', async () => {
    await create({ name: 'Sugar', unit: 'kg' });
    expect(sent('Put', 'test-menu')).toHaveLength(0);
    expect(sent('Put', 'test-ingredients')).toHaveLength(1);
  });
});

describe('PUT /api/admin/ingredients/{id}/toggle-active', () => {
  const toggle = (id: string, body: unknown = {}) =>
    call(makeEvent({ httpMethod: 'PUT', path: `/api/admin/ingredients/${id}/toggle-active`, body }));

  it('PATH ORDER: the toggle wins over the generic PUT /admin/ingredients/{id}', async () => {
    stage({ records: { 'INGREDIENT#milk-001': MILK } });

    const [status] = await toggle('milk-001');

    expect(status).toBe(200);
    expect(sent('Get', 'test-ingredients')).toHaveLength(1);
    const u = sent('Update', 'test-ingredients')[0];
    expect(u.UpdateExpression).toBe('SET isActive = :a');
    expect(u.ExpressionAttributeNames).toBeUndefined();
    expect(u.ReturnValues).toBe('ALL_NEW');
  });

  it('flips true to false', async () => {
    stage({ records: { 'INGREDIENT#milk-001': MILK } });

    await toggle('milk-001');

    const u = sent('Update', 'test-ingredients')[0];
    expect(u.Key).toEqual({ PK: 'INGREDIENT#milk-001', SK: 'META' });
    expect(u.ExpressionAttributeValues).toEqual({ ':a': false });
  });

  it('flips false to true', async () => {
    stage({ records: { 'INGREDIENT#syrup-002': SYRUP_OFF } });
    await toggle('syrup-002');
    expect(sent('Update', 'test-ingredients')[0].ExpressionAttributeValues).toEqual({ ':a': true });
  });

  it('a MISSING isActive counts as ACTIVE here — the OPPOSITE of the menu rule', async () => {
    // `isActive !== false`, because ingredient rows predate the field. The menu
    // toggle uses `isActive === true` and would turn the same shape ON. Both are
    // deliberate; this pair of tests is what stops one being "harmonised" into
    // the other, which would invert what a click does to every legacy row.
    stage({ records: { 'INGREDIENT#beans-003': LEGACY_BEANS } });

    await toggle('beans-003');

    expect(sent('Update', 'test-ingredients')[0].ExpressionAttributeValues).toEqual({ ':a': false });
  });

  it('404s with the INGREDIENT message and writes nothing', async () => {
    stage({ records: {} });

    const [status, body] = await toggle('ghost-999');

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Ingredient not found' });
    expect(sent('Update', 'test-ingredients')).toHaveLength(0);
  });

  it('ignores the body and returns the stored record from ALL_NEW', async () => {
    stage({
      records: { 'INGREDIENT#milk-001': MILK },
      updateAttributes: { ...MILK, isActive: false },
    });

    const [, body] = await toggle('milk-001', { isActive: true });

    expect(body.currentStock).toBe(6);
    expect(body.isActive).toBe(false);
    expect(sent('Update', 'test-ingredients')[0].ExpressionAttributeValues).toEqual({ ':a': false });
  });

  it('falls back to { ingredientId, isActive } when ALL_NEW returns no Attributes', async () => {
    stage({ records: { 'INGREDIENT#milk-001': MILK } });
    expect(await toggle('milk-001')).toEqual([200, { ingredientId: 'milk-001', isActive: false }]);
  });

  it('does not touch stock — disabling an ingredient is not a stock movement', async () => {
    stage({ records: { 'INGREDIENT#milk-001': MILK } });

    await toggle('milk-001');

    const u = sent('Update', 'test-ingredients')[0];
    expect(u.UpdateExpression).not.toContain('currentStock');
    expect(Object.keys(u.ExpressionAttributeValues)).toEqual([':a']);
  });
});

describe('PUT /api/admin/ingredients/{id}', () => {
  const update = (id: string, body: unknown) =>
    call(makeEvent({ httpMethod: 'PUT', path: `/api/admin/ingredients/${id}`, body }));

  it('builds SET clauses from the body against the INGREDIENT key', async () => {
    const [status, body] = await update('milk-001', { currentStock: 10, storageLocation: 'Fridge B' });

    expect(status).toBe(200);
    expect(body).toEqual({ ingredientId: 'milk-001', updated: ['currentStock', 'storageLocation'] });
    const u = sent('Update', 'test-ingredients')[0];
    expect(u.Key).toEqual({ PK: 'INGREDIENT#milk-001', SK: 'META' });
    expect(u.UpdateExpression).toBe('SET #currentStock = :currentStock, #storageLocation = :storageLocation');
    expect(u.ExpressionAttributeValues).toEqual({ ':currentStock': 10, ':storageLocation': 'Fridge B' });
  });

  it('PATH ORDER, the other direction: a plain id does not become an isActive flip', async () => {
    stage({ records: { 'INGREDIENT#milk-001': MILK } });

    await update('milk-001', { currentStock: 10 });

    expect(sent('Get', 'test-ingredients')).toHaveLength(0);
    expect(sent('Update', 'test-ingredients')[0].UpdateExpression).toBe('SET #currentStock = :currentStock');
  });

  it('DEFECT: an empty body builds "SET " here too — same shape as the menu route', async () => {
    const [status] = await update('milk-001', {});

    expect(status).toBe(200);
    expect(sent('Update', 'test-ingredients')[0].UpdateExpression).toBe('SET ');
  });

  it('writes to the INGREDIENTS table only', async () => {
    await update('milk-001', { currentStock: 1 });
    expect(sent('Update', 'test-menu')).toHaveLength(0);
  });
});

describe('DELETE /api/admin/ingredients/{id}', () => {
  it('deletes the META record and echoes the id', async () => {
    const [status, body] = await call(
      makeEvent({ httpMethod: 'DELETE', path: '/api/admin/ingredients/milk-001' })
    );

    expect(status).toBe(200);
    expect(body).toEqual({ deleted: 'milk-001' });
    const deletes = sent('Delete', 'test-ingredients');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Key).toEqual({ PK: 'INGREDIENT#milk-001', SK: 'META' });
  });

  it('does NOT remove the recipe rows that reference the ingredient', async () => {
    // Pinned as current behaviour: recipes key on RECIPE#… with an
    // `INGREDIENT#{id}` SK, and nothing sweeps them. A deleted ingredient leaves
    // dangling recipe lines. Recorded here rather than fixed, because the
    // ingredient-deduction path has to keep coping with them regardless.
    stage({ recipeRows: [{ PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#milk-001', quantity: 200 }] });

    await call(makeEvent({ httpMethod: 'DELETE', path: '/api/admin/ingredients/milk-001' }));

    expect(sent('Delete', 'test-ingredients')).toHaveLength(1);
    expect(sent('Query')).toHaveLength(0);
  });

  it('a DELETE on the collection is a 404 and destroys nothing', async () => {
    const [status] = await call(makeEvent({ httpMethod: 'DELETE', path: '/api/admin/ingredients' }));
    expect(status).toBe(404);
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Recipes
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/recipes', () => {
  const list = () => call(makeEvent({ path: '/api/admin/recipes' }));

  it('keeps only RECIPE# rows — the filter is the HANDLER\'s, not DynamoDB\'s', async () => {
    // Recipes and ingredients share one table, so this Scan sees both. There is
    // no FilterExpression: an assertion on the returned body alone would pass
    // even if the JS filter were deleted, so the absence of the FilterExpression
    // is asserted too. It is also why the read is charged for every ingredient
    // row in the table.
    const recipeRow = { PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#milk-001', quantity: 200 };
    stage({ ingredientRows: [MILK, recipeRow, SYRUP_OFF] });

    const [status, body] = await list();

    expect(status).toBe(200);
    expect(body.recipes).toHaveLength(1);
    expect(body.recipes[0].PK).toBe('RECIPE#latte-001#default');
    const scans = sent('Scan', 'test-ingredients');
    expect(scans).toHaveLength(1);
    expect(scans[0].FilterExpression).toBeUndefined();
  });

  it('tolerates a row with no PK at all', async () => {
    stage({ ingredientRows: [{ SK: 'META', orphan: true }] });
    expect(await list()).toEqual([200, { recipes: [] }]);
  });

  it('returns an empty list when nothing matches, and writes nothing', async () => {
    stage({ ingredientRows: [MILK] });

    const [status, body] = await list();

    expect(status).toBe(200);
    expect(body.recipes).toEqual([]);
    expect(cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd))).toHaveLength(0);
  });
});

describe('POST /api/admin/recipes — replace, then write', () => {
  const save = (body: unknown) =>
    call(makeEvent({ httpMethod: 'POST', path: '/api/admin/recipes', body }));

  it('deletes every existing row under the recipe key BEFORE writing the new set', async () => {
    // The replace semantics, exactly: Query `PK = recipeKey`, delete each row it
    // returned by that row's own PK/SK, then Put one row per ingredient. The
    // ordering assertion is the point — a Put-then-delete would erase what it
    // just wrote.
    stage({
      recipeRows: [
        { PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#milk-001', quantity: 150 },
        { PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#beans-003', quantity: 18 },
      ],
    });

    const [status, body] = await save({
      menuItemId: 'latte-001',
      ingredients: [{ ingredientId: 'milk-001', quantity: 200 }],
    });

    expect(status).toBe(201);
    expect(body).toEqual({
      recipeKey: 'RECIPE#latte-001#default',
      ingredients: [{ ingredientId: 'milk-001', quantity: 200 }],
    });

    const queries = sent('Query', 'test-ingredients');
    expect(queries).toHaveLength(1);
    expect(queries[0].KeyConditionExpression).toBe('PK = :pk');
    expect(queries[0].ExpressionAttributeValues).toEqual({ ':pk': 'RECIPE#latte-001#default' });

    expect(sent('Delete', 'test-ingredients').map((d) => d.Key)).toEqual([
      { PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#milk-001' },
      { PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#beans-003' },
    ]);

    const order = cmds().map((c) => c.__cmd);
    expect(order).toEqual(['Query', 'Delete', 'Delete', 'Put']);
  });

  it('writes one row per ingredient, keyed SK = INGREDIENT#{id}', async () => {
    stage({ recipeRows: [] });

    await save({
      menuItemId: 'latte-001',
      variantId: 'large',
      ingredients: [
        { ingredientId: 'milk-001', quantity: 250 },
        { ingredientId: 'beans-003', quantity: 20 },
      ],
    });

    expect(sent('Put', 'test-ingredients').map((p) => p.Item)).toEqual([
      { PK: 'RECIPE#latte-001#large', SK: 'INGREDIENT#milk-001', ingredientId: 'milk-001', quantity: 250 },
      { PK: 'RECIPE#latte-001#large', SK: 'INGREDIENT#beans-003', ingredientId: 'beans-003', quantity: 20 },
    ]);
  });

  it('a missing variantId becomes the literal "default" in the key', async () => {
    stage({ recipeRows: [] });

    const [, body] = await save({ menuItemId: 'latte-001', ingredients: [] });

    expect(body.recipeKey).toBe('RECIPE#latte-001#default');
    expect(sent('Query', 'test-ingredients')[0].ExpressionAttributeValues[':pk'])
      .toBe('RECIPE#latte-001#default');
  });

  it('an empty variantId also becomes "default" — `||` not `??`', async () => {
    stage({ recipeRows: [] });
    const [, body] = await save({ menuItemId: 'latte-001', variantId: '', ingredients: [] });
    expect(body.recipeKey).toBe('RECIPE#latte-001#default');
  });

  it('a variant recipe does not disturb the default one — different key, different Query', async () => {
    stage({ recipeRows: [] });

    await save({ menuItemId: 'latte-001', variantId: 'large', ingredients: [{ ingredientId: 'milk-001', quantity: 250 }] });

    expect(sent('Query', 'test-ingredients')[0].ExpressionAttributeValues[':pk'])
      .toBe('RECIPE#latte-001#large');
    for (const d of sent('Delete', 'test-ingredients')) {
      expect(d.Key.PK).toBe('RECIPE#latte-001#large');
    }
  });

  it('an empty ingredients array CLEARS the recipe — deletes issued, nothing written', async () => {
    stage({
      recipeRows: [{ PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#milk-001', quantity: 150 }],
    });

    const [status, body] = await save({ menuItemId: 'latte-001', ingredients: [] });

    expect(status).toBe(201);
    expect(body.ingredients).toEqual([]);
    expect(sent('Delete', 'test-ingredients')).toHaveLength(1);
    expect(sent('Put', 'test-ingredients')).toHaveLength(0);
  });

  it('a REMOVED ingredient does not survive the replace', async () => {
    // The teeth of "replace": the stale SK must be deleted and must not be
    // re-Put. A fixture with no pre-existing rows could not tell replace from
    // append.
    stage({
      recipeRows: [
        { PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#milk-001', quantity: 150 },
        { PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#syrup-002', quantity: 10 },
      ],
    });

    await save({
      menuItemId: 'latte-001',
      ingredients: [{ ingredientId: 'milk-001', quantity: 200 }],
    });

    const deletedSks = sent('Delete', 'test-ingredients').map((d) => d.Key.SK);
    const writtenSks = sent('Put', 'test-ingredients').map((p) => p.Item.SK);
    expect(deletedSks).toContain('INGREDIENT#syrup-002');
    expect(writtenSks).not.toContain('INGREDIENT#syrup-002');
    expect(writtenSks).toEqual(['INGREDIENT#milk-001']);
  });

  it('does not verify the menu item or the ingredients exist', async () => {
    stage({ recipeRows: [], records: {} });

    const [status] = await save({
      menuItemId: 'ghost-999',
      ingredients: [{ ingredientId: 'nonexistent', quantity: 1 }],
    });

    expect(status).toBe(201);
    expect(sent('Get')).toHaveLength(0);
  });

  it('DEFECT: a MISSING ingredients array wipes the recipe and THEN 500s', async () => {
    // The delete loop runs before `for (const ing of ingredients)` throws, so a
    // malformed request is destructive: the existing recipe is gone, the caller
    // gets an opaque 500, and the drink silently stops deducting stock. A
    // validation guard before the Query would cost one line.
    stage({
      recipeRows: [{ PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#milk-001', quantity: 150 }],
    });

    const [status, body] = await save({ menuItemId: 'latte-001' });

    expect(status).toBe(500);
    expect(body.error).toMatch(/not iterable|undefined/i);
    // The destruction already happened — this is the assertion that matters.
    expect(sent('Delete', 'test-ingredients')).toHaveLength(1);
    expect(sent('Put', 'test-ingredients')).toHaveLength(0);
  });

  it('DEFECT: a missing menuItemId is written into the key as the string "undefined"', async () => {
    stage({ recipeRows: [] });

    const [status, body] = await save({ ingredients: [{ ingredientId: 'milk-001', quantity: 1 }] });

    expect(status).toBe(201);
    expect(body.recipeKey).toBe('RECIPE#undefined#default');
    expect(sent('Put', 'test-ingredients')[0].Item.PK).toBe('RECIPE#undefined#default');
  });

  it('DEFECT: the replace is not atomic — a failed Put leaves NO recipe at all', async () => {
    // Same failure mode reached a different way. Once the deletes have committed
    // there is no rollback, so a throttled or failed write during a Sunday-morning
    // recipe edit removes the deduction rows entirely.
    stage({
      recipeRows: [{ PK: 'RECIPE#latte-001#default', SK: 'INGREDIENT#milk-001', quantity: 150 }],
      failPut: 'ProvisionedThroughputExceededException',
    });

    const [status, body] = await save({
      menuItemId: 'latte-001',
      ingredients: [{ ingredientId: 'milk-001', quantity: 200 }],
    });

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'ProvisionedThroughputExceededException' });
    expect(sent('Delete', 'test-ingredients')).toHaveLength(1);
  });

  it('a PUT to /admin/recipes is a 404 — the write is POST-only', async () => {
    const [status, body] = await call(
      makeEvent({ httpMethod: 'PUT', path: '/api/admin/recipes', body: { menuItemId: 'x', ingredients: [] } })
    );

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not found', path: '/api/admin/recipes', method: 'PUT' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Cross-resource: the unmatched tail
// ══════════════════════════════════════════════════════════════════════════════

describe('unmatched catalogue paths', () => {
  it.each([
    ['GET', '/api/admin/ingredients'],
    ['GET', '/api/admin/menu/latte-001'],
    ['POST', '/api/admin/menu/latte-001'],
    ['DELETE', '/api/admin/recipes/latte-001'],
    ['PATCH', '/api/admin/menu/latte-001'],
  ])('%s %s is a 404 that echoes the path and method, and touches nothing', async (method, path) => {
    const [status, body] = await call(makeEvent({ httpMethod: method, path }));

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not found', path, method });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('a malformed JSON body is a 400, not an unhandled rejection', async () => {
    // Regression: the parse used to sit ABOVE the handler's `try`, so it rejected
    // out of `handleAdmin` entirely. `index.ts` has no top-level try/catch, so
    // the Lambda invocation failed and API Gateway answered a raw 502 with no
    // JSON body and no CORS headers — the admin PWA saw an opaque network error.
    const event = makeEvent({ httpMethod: 'POST', path: '/api/admin/menu', body: '{"name": ' });

    const [status, body] = await call(event);

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid JSON body' });
    // Rejected before the route table is consulted, so nothing was written.
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});
