/**
 * Pre-order links can block individual variant options, e.g. no Oat Milk on a
 * ministry link.
 *
 * `eligibleItems` only gates whole menu items, so a ministry pre-order could
 * pick a Latte and then add Oat Milk freely. Pre-orders are free — totalAmount 0
 * with the entire gross recorded as discountOffset — so the +RM1 surcharge was
 * never recovered and the café absorbed the cost with no price signal.
 *
 * The customer page hides excluded options, but that is only a courtesy: these
 * tests pin the SERVER-side refusal, which is what a reused link with a crafted
 * payload has to hit.
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

jest.mock('../src/routes/customers', () => ({
  linkOrderToCustomer: jest.fn().mockResolvedValue(undefined),
  handleCustomers: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleOrders } = require('../src/routes/orders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { optionKey, normalizeExcludedOptions } = require('../src/routes/preorder');

const LATTE = {
  PK: 'MENU#latte', SK: 'META', menuItemId: 'latte', name: 'Latte',
  category: 'DRINK', basePrice: 7, isActive: true, isEnabledToday: true,
  variantGroups: [
    { group: 'Temperature', type: 'single', options: [{ name: 'Hot', price: 0 }, { name: 'Iced', price: 1 }] },
    { group: 'Milk', type: 'optional', options: [{ name: 'Oat Milk', price: 1 }] },
  ],
};

/** A valid, currently-open pre-order code. */
function codeRecord(overrides: Record<string, any> = {}) {
  const now = Date.now();
  return {
    PK: 'PREORDER#ABC123', SK: 'META', code: 'ABC123', name: 'Ministry',
    opensAt: new Date(now - 3600_000).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(),
    serviceDate: '2026-08-16',
    serviceEndTime: new Date(now + 7200_000).toISOString(),
    isActive: true,
    eligibleItems: [],
    ...overrides,
  };
}

function orderEvent(items: any[]) {
  return {
    httpMethod: 'POST',
    path: '/api/orders',
    body: JSON.stringify({ customerName: 'Grace', preorderCode: 'ABC123', collectionTime: 'After 1st Service', items }),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

/**
 * Stage the real call order: createOrder reads settings FIRST, then validates the
 * pre-order code, then looks up each menu item.
 */
function stage(code: any) {
  mockDbSend.mockReset();
  mockDbSend
    .mockResolvedValueOnce({ Item: { cafeStatus: 'CLOSED' } })   // settings
    .mockResolvedValueOnce({ Item: code })                       // preorder code
    .mockResolvedValueOnce({ Item: LATTE })                      // menu item
    .mockResolvedValue({});                                      // puts/updates
}

describe('optionKey / normalizeExcludedOptions', () => {
  it('builds a Group:Option key and trims', () => {
    expect(optionKey(' Milk ', ' Oat Milk ')).toBe('Milk:Oat Milk');
  });

  it('drops entries missing either half', () => {
    // A half-formed key would silently never match anything.
    expect(normalizeExcludedOptions(['Milk:Oat Milk', 'Milk:', ':Oat Milk', 'NoColon', ''])).toEqual(['Milk:Oat Milk']);
  });

  it('deduplicates and tolerates non-arrays', () => {
    expect(normalizeExcludedOptions(['Milk:Oat Milk', 'Milk:Oat Milk'])).toEqual(['Milk:Oat Milk']);
    expect(normalizeExcludedOptions(undefined)).toEqual([]);
    expect(normalizeExcludedOptions('nope')).toEqual([]);
  });

  it('keeps an option name that itself contains a colon', () => {
    // Split on the FIRST colon only.
    expect(normalizeExcludedOptions(['Milk:Oat: Barista'])).toEqual(['Milk:Oat: Barista']);
  });
});

describe('createOrder — pre-order excluded options', () => {
  it('rejects an excluded option sent in selectedVariants', async () => {
    stage(codeRecord({ excludedOptions: ['Milk:Oat Milk'] }));
    const res = await handleOrders(orderEvent([{
      menuItemId: 'latte', quantity: 1,
      selectedVariants: [{ group: 'Temperature', option: 'Iced', price: 1 }, { group: 'Milk', option: 'Oat Milk', price: 1 }],
    }]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Oat Milk is not available on this pre-order link/i);
    // Nothing was written.
    expect(mockDbSend.mock.calls.filter(c => c[0].__cmd === 'Put')).toHaveLength(0);
  });

  it('allows a non-excluded option on the same link', async () => {
    stage(codeRecord({ excludedOptions: ['Milk:Oat Milk'] }));
    const res = await handleOrders(orderEvent([{
      menuItemId: 'latte', quantity: 1,
      selectedVariants: [{ group: 'Temperature', option: 'Iced', price: 1 }],
    }]));
    expect(res.statusCode).toBe(201);
  });

  it('is unaffected when nothing is excluded', async () => {
    stage(codeRecord({ excludedOptions: [] }));
    const res = await handleOrders(orderEvent([{
      menuItemId: 'latte', quantity: 1,
      selectedVariants: [{ group: 'Milk', option: 'Oat Milk', price: 1 }],
    }]));
    expect(res.statusCode).toBe(201);
  });

  it('is unaffected when the field is absent entirely (existing links)', async () => {
    // Links created before this feature have no excludedOptions attribute.
    stage(codeRecord());
    const res = await handleOrders(orderEvent([{
      menuItemId: 'latte', quantity: 1,
      selectedVariants: [{ group: 'Milk', option: 'Oat Milk', price: 1 }],
    }]));
    expect(res.statusCode).toBe(201);
  });

  it('blocks a legacy single-variant payload carrying only the option name', async () => {
    // An older client sends `variant: "Oat Milk"` with no group; it must not
    // slip past a check that only looks at selectedVariants.
    stage(codeRecord({ excludedOptions: ['Milk:Oat Milk'] }));
    const res = await handleOrders(orderEvent([{ menuItemId: 'latte', quantity: 1, variant: 'Oat Milk' }]));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not available on this pre-order link/i);
  });

  it('matches the group too — same option name in a different group is allowed', async () => {
    // Excluding "Milk:Oat Milk" must not block a hypothetical "Syrup:Oat Milk".
    stage(codeRecord({ excludedOptions: ['Syrup:Oat Milk'] }));
    const res = await handleOrders(orderEvent([{
      menuItemId: 'latte', quantity: 1,
      selectedVariants: [{ group: 'Milk', option: 'Oat Milk', price: 1 }],
    }]));
    expect(res.statusCode).toBe(201);
  });

  it('does not restrict a normal (non pre-order) customer order', async () => {
    // Paying customers keep the choice — the exclusion is per pre-order link.
    mockDbSend.mockReset();
    mockDbSend
      .mockResolvedValueOnce({ Item: { cafeStatus: 'OPEN' } })   // settings
      .mockResolvedValueOnce({ Item: LATTE })                    // menu item
      .mockResolvedValue({});
    const res = await handleOrders({
      httpMethod: 'POST', path: '/api/orders',
      body: JSON.stringify({
        customerName: 'Walk-in',
        items: [{ menuItemId: 'latte', quantity: 1, selectedVariants: [{ group: 'Milk', option: 'Oat Milk', price: 1 }] }],
      }),
      headers: {}, queryStringParameters: null, pathParameters: null,
    } as any);
    expect(res.statusCode).toBe(201);
  });
});
