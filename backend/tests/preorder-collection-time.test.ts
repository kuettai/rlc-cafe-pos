/**
 * Pre-order collection time — `backend/src/routes/orders.ts`.
 *
 * A pre-order's collection time exists ONLY inside the `notes` string, as the
 * `[PRE-ORDER: <CODE>] Collect: <time>` prefix. There is no `collectionTime`
 * attribute on the order record. Two consequences drive everything below:
 *
 *  1. The prefix is BACKEND-OWNED. `modifyOrder` used to write `notes` verbatim
 *     from the request body, which made preserving it the CLIENT's job — a stale
 *     PWA shell or a replayed request silently deleted the collection time, which
 *     is unrecoverable (the café has to ask the customer again).
 *  2. The customer may now CHANGE the time, so the value is untrusted input and
 *     must be checked against the list the LINK offers. The code in the rebuilt
 *     prefix always comes from the STORED order, never from the body.
 *
 * Fully offline: `docClient` is mocked, so this suite needs no credentials, makes
 * no network call and writes nothing to production — hence no `ZZTEST_` marker is
 * required (the only `Put`/`Update` objects here are mock call arguments that the
 * assertions read and discard).
 *
 * Every assertion is on what the handler PRODUCED — the exact `:n` string in the
 * `UpdateCommand`, the `Item` of the `PutCommand`, the response body, the number
 * of reads issued — never on the fixture the test built.
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
const {
  handleOrders,
  resolveCollectionTime,
  parsePreorderCollectionTime,
  preorderNotesPrefix,
  composePreorderNotes,
} = require('../src/routes/orders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEFAULT_COLLECTION_OPTIONS } = require('../src/routes/preorder');

// ─── Fixtures ────────────────────────────────────────────────────────

const LATTE = {
  PK: 'MENU#latte', SK: 'META', menuItemId: 'latte', name: 'Latte',
  category: 'DRINK', basePrice: 8, isActive: true, isEnabledToday: true,
};

const COOKIE = {
  PK: 'MENU#cookie', SK: 'META', menuItemId: 'cookie', name: 'Cookie',
  category: 'FOOD', basePrice: 3, isActive: true, isEnabledToday: true,
  foodQuantityToday: 10, foodReserved: 0,
};

const OPEN_SETTINGS = { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN', celebrationMode: false };

const FUTURE_END = '2099-12-25T07:00:00.000Z';

const PREFIX_1ST = '[PRE-ORDER: ABC123] Collect: After 1st Service';
const PREFIX_2ND = '[PRE-ORDER: ABC123] Collect: After 2nd Service';

function codeRecord(overrides: Record<string, any> = {}) {
  return {
    PK: 'PREORDER_CODE#ABC123', SK: 'META', code: 'ABC123', name: 'Music team',
    opensAt: '2000-01-01T00:00:00.000Z',
    expiresAt: '2099-12-31T00:00:00.000Z',
    serviceDate: '2099-12-25', serviceEndTime: FUTURE_END,
    isActive: true, eligibleItems: [],
    ...overrides,
  };
}

function preOrder(overrides: Record<string, any> = {}) {
  return {
    PK: 'ORDER#p1', SK: 'META', orderId: 'p1', customerName: 'Grace',
    status: 'PENDING', isPreOrder: true, preorderCode: 'ABC123',
    customerClass: 'PREORDER', discountType: 'MINISTRY_PREORDER',
    items: [{
      menuItemId: 'latte', name: 'Latte', variant: null, quantity: 2,
      unitPrice: 8, grossUnitPrice: 8, category: 'DRINK',
    }],
    totalAmount: 0, grossAmount: 16, discountOffset: 16,
    notes: `${PREFIX_1ST} | extra hot`,
    expiresAt: FUTURE_END,
    ...overrides,
  };
}

function plainOrder(overrides: Record<string, any> = {}) {
  return {
    PK: 'ORDER#n1', SK: 'META', orderId: 'n1', customerName: 'Ah Beng',
    status: 'PENDING', isPreOrder: false,
    items: [{
      menuItemId: 'latte', name: 'Latte', variant: null, quantity: 1,
      unitPrice: 8, grossUnitPrice: 8, category: 'DRINK',
    }],
    totalAmount: 8, grossAmount: 8, discountOffset: 0, discountType: 'NONE',
    notes: 'no ice',
    expiresAt: 1_800_000_000,
    ...overrides,
  };
}

/**
 * Answer reads from a described world, keyed on the real `TableName` + `Key.PK`.
 *
 * A dispatcher rather than a `mockResolvedValueOnce` queue on purpose: the read
 * COUNT is load-bearing in this suite (`getOrder`'s extra pre-order lookup must
 * not fire for an ordinary order), and a queue cannot tell which slot a fixture
 * answered. `codes: { ABC123: null }` models a hard-deleted link, which is a
 * different thing from a code that was never asked for.
 */
function stage(world: {
  settings?: any;
  menu?: Record<string, any>;
  orders?: Record<string, any>;
  codes?: Record<string, any>;
}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd !== 'Get') return {};
    const pk = String(cmd.Key?.PK || '');
    if (cmd.TableName === 'test-settings' && pk === 'SETTINGS') {
      return { Item: world.settings === undefined ? OPEN_SETTINGS : world.settings };
    }
    if (cmd.TableName === 'test-settings' && pk.startsWith('PREORDER_CODE#')) {
      const rec = world.codes?.[pk.replace('PREORDER_CODE#', '')];
      return rec ? { Item: rec } : {};
    }
    if (cmd.TableName === 'test-menu') {
      const rec = world.menu?.[pk.replace('MENU#', '')];
      return rec ? { Item: rec } : {};
    }
    if (cmd.TableName === 'test-orders') {
      const rec = world.orders?.[pk.replace('ORDER#', '')];
      return rec ? { Item: rec } : {};
    }
    return {};
  });
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function gets() { return cmds().filter((c) => c.__cmd === 'Get'); }
function codeReads() { return gets().filter((c) => String(c.Key?.PK || '').startsWith('PREORDER_CODE#')); }
function orderPuts() { return cmds().filter((c) => c.__cmd === 'Put' && c.TableName === 'test-orders'); }
function orderUpdates() { return cmds().filter((c) => c.__cmd === 'Update' && c.TableName === 'test-orders'); }
function menuUpdates() { return cmds().filter((c) => c.__cmd === 'Update' && c.TableName === 'test-menu'); }
/** The exact `notes` string the handler wrote, or `undefined` if it wrote none. */
function writtenNotes() { return orderUpdates()[0]?.ExpressionAttributeValues?.[':n']; }

function createEvent(body: Record<string, any>) {
  return {
    httpMethod: 'POST', path: '/api/orders',
    body: JSON.stringify(body),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

function editEvent(id: string, body: Record<string, any>) {
  return {
    httpMethod: 'PUT', path: `/api/orders/${id}`,
    body: JSON.stringify({ action: 'update', ...body }),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

function getEvent(id: string) {
  return {
    httpMethod: 'GET', path: `/api/orders/${id}`,
    body: null, headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

const ONE_LATTE = [{ menuItemId: 'latte', quantity: 1 }];

/** Pre-order edit world: the order, the link, the menu. */
function preOrderWorld(order: any = preOrder(), code: any = codeRecord()) {
  return { orders: { p1: order }, codes: { ABC123: code }, menu: { latte: LATTE, cookie: COOKIE } };
}

beforeEach(() => { mockDbSend.mockReset(); });

// ─── The helpers, as a specification ─────────────────────────────────

describe('resolveCollectionTime — the shared allowlist rule', () => {
  const LINK_OPTIONS = { collectionOptions: ['Before Service', 'After Combined Service'] };

  it('treats absent / empty / whitespace as "keep whatever is stored"', () => {
    expect(resolveCollectionTime(codeRecord(), undefined)).toEqual({ time: '' });
    expect(resolveCollectionTime(codeRecord(), null)).toEqual({ time: '' });
    expect(resolveCollectionTime(codeRecord(), '')).toEqual({ time: '' });
    expect(resolveCollectionTime(codeRecord(), '   ')).toEqual({ time: '' });
  });

  it('rejects a non-string', () => {
    expect(resolveCollectionTime(codeRecord(), 3)).toEqual({ error: 'collectionTime must be a string' });
    expect(resolveCollectionTime(codeRecord(), { t: 'x' })).toEqual({ error: 'collectionTime must be a string' });
  });

  it('accepts a default option when the link declares none', () => {
    expect(resolveCollectionTime(codeRecord(), 'After 1st Service')).toEqual({ time: 'After 1st Service' });
    expect(DEFAULT_COLLECTION_OPTIONS).toContain('After 1st Service');
  });

  it('trims both sides but does not fold case or fuzzy-match', () => {
    // The value is echoed verbatim onto the card the cashier collects against, so
    // "after 1st service" must not become a second spelling of the slot.
    expect(resolveCollectionTime(codeRecord(), '  After 1st Service  ')).toEqual({ time: 'After 1st Service' });
    expect(resolveCollectionTime(codeRecord(), 'after 1st service')).toEqual({ error: 'Invalid collection time' });
    expect(resolveCollectionTime(codeRecord(), 'After 1st')).toEqual({ error: 'Invalid collection time' });
  });

  it("uses the LINK's own options in preference to the defaults", () => {
    expect(resolveCollectionTime(codeRecord(LINK_OPTIONS), 'Before Service')).toEqual({ time: 'Before Service' });
    expect(resolveCollectionTime(codeRecord(LINK_OPTIONS), 'After 1st Service'))
      .toEqual({ error: 'Invalid collection time' });
  });

  it('falls back to the defaults for a null record (link hard-deleted)', () => {
    // Fail closed: the customer can still change their time, but only to a
    // default slot — never to free text of their own.
    expect(resolveCollectionTime(null, 'After 1st Service')).toEqual({ time: 'After 1st Service' });
    expect(resolveCollectionTime(null, 'Before Service')).toEqual({ error: 'Invalid collection time' });
    expect(resolveCollectionTime(undefined, '9:99 XM')).toEqual({ error: 'Invalid collection time' });
  });

  it('ignores a malformed collectionOptions and uses the defaults', () => {
    for (const bad of [[], ['ok', 7], 'After 1st Service', {}, null]) {
      expect(resolveCollectionTime(codeRecord({ collectionOptions: bad }), 'After 1st Service'))
        .toEqual({ time: 'After 1st Service' });
    }
  });
});

describe('parsePreorderCollectionTime — reading the time back out', () => {
  it('returns the time from a prefix, with and without a customer portion', () => {
    expect(parsePreorderCollectionTime(`${PREFIX_1ST} | extra hot`)).toBe('After 1st Service');
    expect(parsePreorderCollectionTime(PREFIX_1ST)).toBe('After 1st Service');
  });

  it("returns '' when there is no prefix at all", () => {
    expect(parsePreorderCollectionTime('just a customer note')).toBe('');
    expect(parsePreorderCollectionTime('')).toBe('');
    expect(parsePreorderCollectionTime(undefined)).toBe('');
    expect(parsePreorderCollectionTime(null)).toBe('');
    expect(parsePreorderCollectionTime(123)).toBe('');
  });

  it('round-trips whatever the writer composed', () => {
    // One format string, so the reader and the writer cannot drift apart.
    const composed = composePreorderNotes(preorderNotesPrefix('ABC123', 'After 2nd Service'), 'no sugar');
    expect(parsePreorderCollectionTime(composed)).toBe('After 2nd Service');
  });
});

// ─── 7. A customer cannot set an arbitrary collection time ───────────

describe('an arbitrary collection time is refused on create AND edit', () => {
  const GARBAGE = '9:99 XM';
  const PLAUSIBLE = 'After 3rd Service';   // off-list, but looks like a real slot

  it('create: 400 Invalid collection time for garbage, and no order is Put', async () => {
    stage({ codes: { ABC123: codeRecord() }, menu: { latte: LATTE } });

    const res = await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'ABC123',
      collectionTime: GARBAGE, items: ONE_LATTE,
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid collection time' });
    expect(orderPuts()).toHaveLength(0);
    expect(menuUpdates()).toHaveLength(0);
  });

  it('create: 400 for a plausible-but-off-list slot too', async () => {
    stage({ codes: { ABC123: codeRecord() }, menu: { latte: LATTE } });

    const res = await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'ABC123',
      collectionTime: PLAUSIBLE, items: ONE_LATTE,
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid collection time');
    expect(orderPuts()).toHaveLength(0);
  });

  it('create: a non-string collectionTime is refused', async () => {
    stage({ codes: { ABC123: codeRecord() }, menu: { latte: LATTE } });

    const res = await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'ABC123',
      collectionTime: { evil: true }, items: ONE_LATTE,
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('collectionTime must be a string');
    expect(orderPuts()).toHaveLength(0);
  });

  it('create: the control case is accepted and stamps the prefix', async () => {
    // Without this the 400s above could be passing for an unrelated reason.
    stage({ codes: { ABC123: codeRecord() }, menu: { latte: LATTE } });

    const res = await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'ABC123',
      collectionTime: 'After 1st Service', notes: 'no sugar', items: ONE_LATTE,
    }));

    expect(res.statusCode).toBe(201);
    expect(orderPuts()[0].Item.notes).toBe(`${PREFIX_1ST} | no sugar`);
  });

  it('edit: 400 Invalid collection time for garbage, and no order Update', async () => {
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: GARBAGE,
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid collection time' });
    expect(orderUpdates()).toHaveLength(0);
    expect(menuUpdates()).toHaveLength(0);
  });

  it('edit: 400 for a plausible-but-off-list slot too', async () => {
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: PLAUSIBLE, notes: 'and no sugar',
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid collection time');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('edit: a non-string collectionTime is refused', async () => {
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: ['After 1st Service'],
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('collectionTime must be a string');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('the refusal is byte-identical on both paths', async () => {
    stage({ codes: { ABC123: codeRecord() }, menu: { latte: LATTE } });
    const onCreate = (await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'ABC123', collectionTime: GARBAGE, items: ONE_LATTE,
    })));

    stage(preOrderWorld());
    const onEdit = (await handleOrders(editEvent('p1', { items: ONE_LATTE, collectionTime: GARBAGE })));

    expect(onEdit.statusCode).toBe(onCreate.statusCode);
    expect(onEdit.body).toBe(onCreate.body);
  });
});

// ─── 8. A legitimate change rebuilds the prefix ──────────────────────

describe('a legitimate collection-time change rebuilds the prefix', () => {
  it('with body.notes supplied: prefix rebuilt, customer text taken from the body', async () => {
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'After 2nd Service', notes: 'less ice',
    }));

    expect(res.statusCode).toBe(200);
    expect(orderUpdates()[0].UpdateExpression).toContain('notes = :n');
    expect(writtenNotes()).toBe(`${PREFIX_2ND} | less ice`);
  });

  it('with body.notes ABSENT: the stored customer portion is preserved', async () => {
    // The client may change nothing but the time. The stored notes carry
    // "extra hot"; blanking it while rewriting the prefix around it would be a
    // silent data loss of the same kind the prefix ownership was introduced to
    // stop.
    stage(preOrderWorld(preOrder({ notes: `${PREFIX_1ST} | extra hot` })));

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'After 2nd Service',
    }));

    expect(res.statusCode).toBe(200);
    // The `notes = :n` clause has to be emitted at all — the time lives INSIDE
    // notes, so a request that changes only the time writes nothing otherwise.
    expect(orderUpdates()[0].UpdateExpression).toContain('notes = :n');
    expect(writtenNotes()).toBe(`${PREFIX_2ND} | extra hot`);
  });

  it('trims the submitted time before composing', async () => {
    stage(preOrderWorld());
    await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: '  After 2nd Service  ',
    }));
    expect(writtenNotes()).toBe(`${PREFIX_2ND} | extra hot`);
  });

  it('with no collectionTime, the STORED prefix is preserved across a notes change', async () => {
    // Nothing is invented when the customer does not change the time: the stored
    // prefix is re-prepended to whatever text they sent.
    stage(preOrderWorld(preOrder({ notes: `${PREFIX_1ST} | extra hot` })));

    const res = await handleOrders(editEvent('p1', { items: ONE_LATTE, notes: 'no sugar' }));

    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX_1ST} | no sugar`);
  });

  it('a client that re-attaches the prefix does not get it twice', async () => {
    stage(preOrderWorld());

    await handleOrders(editEvent('p1', {
      items: ONE_LATTE, notes: `${PREFIX_1ST} | no sugar`, collectionTime: 'After 2nd Service',
    }));

    expect(writtenNotes()).toBe(`${PREFIX_2ND} | no sugar`);
    expect(String(writtenNotes()).match(/PRE-ORDER/g)).toHaveLength(1);
  });

  it('a time change with an empty customer portion writes the prefix alone', async () => {
    stage(preOrderWorld(preOrder({ notes: PREFIX_1ST })));

    await handleOrders(editEvent('p1', { items: ONE_LATTE, collectionTime: 'After 2nd Service' }));

    // No trailing separator.
    expect(writtenNotes()).toBe(PREFIX_2ND);
  });

  it('records the changed time on the MODIFY audit line, and only when changed', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      stage(preOrderWorld());
      await handleOrders(editEvent('p1', { items: ONE_LATTE, collectionTime: 'After 2nd Service' }));
      const withChange = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('MODIFY'));
      expect(withChange).toContain('collectionTime=After 2nd Service');

      logSpy.mockClear();
      stage(preOrderWorld());
      await handleOrders(editEvent('p1', { items: ONE_LATTE, notes: 'no sugar' }));
      const noChange = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('MODIFY'));
      expect(noChange).not.toContain('collectionTime');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('emits no notes clause when the client sent neither notes nor a time', async () => {
    stage(preOrderWorld());
    const res = await handleOrders(editEvent('p1', { items: ONE_LATTE }));
    expect(res.statusCode).toBe(200);
    expect(orderUpdates()[0].UpdateExpression).not.toContain('notes');
    expect(orderUpdates()[0].ExpressionAttributeValues).not.toHaveProperty(':n');
  });
});

// ─── 9. The CODE comes from the stored order, never the body ─────────

describe('the rebuilt prefix takes its code from the stored order', () => {
  it('ignores a forged [PRE-ORDER: EVIL] prefix in the body', async () => {
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE,
      notes: '[PRE-ORDER: EVIL] Collect: 3am | forged',
      collectionTime: 'After 2nd Service',
    }));

    expect(res.statusCode).toBe(200);
    // Stored code ABC123, validated time, and the customer's own text kept.
    expect(writtenNotes()).toBe(`${PREFIX_2ND} | forged`);
    expect(writtenNotes()).not.toContain('EVIL');
    expect(writtenNotes()).not.toContain('3am');
  });

  it('ignores a forged prefix even when no collectionTime is sent', async () => {
    // Then the STORED prefix is re-prepended, so the forged code and time are
    // still both discarded.
    stage(preOrderWorld(preOrder({ notes: `${PREFIX_1ST} | extra hot` })));

    await handleOrders(editEvent('p1', {
      items: ONE_LATTE, notes: '[PRE-ORDER: EVIL] Collect: 3am | forged',
    }));

    expect(writtenNotes()).toBe(`${PREFIX_1ST} | forged`);
    expect(writtenNotes()).not.toContain('EVIL');
  });

  it('ignores a preorderCode in the edit body', async () => {
    // The edit endpoint takes no code; the record's own is authoritative.
    stage({
      orders: { p1: preOrder() },
      codes: { ABC123: codeRecord(), EVIL: codeRecord({ code: 'EVIL', collectionOptions: ['3am'] }) },
      menu: { latte: LATTE },
    });

    await handleOrders(editEvent('p1', {
      items: ONE_LATTE, preorderCode: 'EVIL', collectionTime: 'After 2nd Service',
    }));

    expect(writtenNotes()).toBe(`${PREFIX_2ND} | extra hot`);
    // Only the stored link was read.
    expect(codeReads().map((c) => c.Key.PK)).toEqual(['PREORDER_CODE#ABC123']);
  });

  it('create takes the code from the validated link record, not the body casing', async () => {
    stage({ codes: { ABC123: codeRecord() }, menu: { latte: LATTE } });

    await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'abc123',
      collectionTime: 'After 1st Service', items: ONE_LATTE,
    }));

    expect(orderPuts()[0].Item.notes).toBe(PREFIX_1ST);
    expect(orderPuts()[0].Item.preorderCode).toBe('ABC123');
  });
});

// ─── 10. The link's own options, and a hard-deleted link ─────────────

describe("a link's own collectionOptions are what is enforced", () => {
  const OWN = codeRecord({ collectionOptions: ['Before Service', 'After Combined Service'] });

  it('create: accepts one of ITS options', async () => {
    stage({ codes: { ABC123: OWN }, menu: { latte: LATTE } });

    const res = await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'ABC123',
      collectionTime: 'After Combined Service', items: ONE_LATTE,
    }));

    expect(res.statusCode).toBe(201);
    expect(orderPuts()[0].Item.notes).toBe('[PRE-ORDER: ABC123] Collect: After Combined Service');
  });

  it('create: refuses a DEFAULT option that is not in its list', async () => {
    stage({ codes: { ABC123: OWN }, menu: { latte: LATTE } });

    const res = await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'ABC123',
      collectionTime: 'After 1st Service', items: ONE_LATTE,
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid collection time');
    expect(orderPuts()).toHaveLength(0);
  });

  it('edit: accepts one of ITS options and refuses a default', async () => {
    stage(preOrderWorld(preOrder(), OWN));
    const ok = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'Before Service',
    }));
    expect(ok.statusCode).toBe(200);
    expect(writtenNotes()).toBe('[PRE-ORDER: ABC123] Collect: Before Service | extra hot');

    stage(preOrderWorld(preOrder(), OWN));
    const bad = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'After 1st Service',
    }));
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('Invalid collection time');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('edit: a hard-deleted link falls back to DEFAULT_COLLECTION_OPTIONS', async () => {
    // `getPreorderCode` → null. Fail closed: a default slot is still accepted so
    // the customer is not locked out of their own order, but free text is not.
    stage({ orders: { p1: preOrder() }, codes: {}, menu: { latte: LATTE } });
    const ok = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: DEFAULT_COLLECTION_OPTIONS[1],
    }));
    expect(ok.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`[PRE-ORDER: ABC123] Collect: ${DEFAULT_COLLECTION_OPTIONS[1]} | extra hot`);

    stage({ orders: { p1: preOrder() }, codes: {}, menu: { latte: LATTE } });
    const bad = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'Before Service',
    }));
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('Invalid collection time');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('edit: a link with a malformed collectionOptions also falls back to the defaults', async () => {
    stage(preOrderWorld(preOrder(), codeRecord({ collectionOptions: [] })));
    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'After 2nd Service',
    }));
    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX_2ND} | extra hot`);
  });
});

// ─── 11. Creating a prefix on an order that had none ─────────────────

describe('a pre-order placed with no collection time can be given one', () => {
  it('creates the prefix from the stored code plus the validated time (notes absent)', async () => {
    stage(preOrderWorld(preOrder({ notes: 'no ice please' })));

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'After 1st Service',
    }));

    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX_1ST} | no ice please`);
  });

  it('creates the prefix when the stored notes are empty', async () => {
    stage(preOrderWorld(preOrder({ notes: '' })));

    await handleOrders(editEvent('p1', { items: ONE_LATTE, collectionTime: 'After 1st Service' }));

    expect(writtenNotes()).toBe(PREFIX_1ST);
  });

  it('creates the prefix alongside new notes in the same edit', async () => {
    stage(preOrderWorld(preOrder({ notes: '' })));

    await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'After 1st Service', notes: 'oat milk on both',
    }));

    expect(writtenNotes()).toBe(`${PREFIX_1ST} | oat milk on both`);
  });

  it('creates none when no collectionTime is supplied (nothing is invented)', async () => {
    stage(preOrderWorld(preOrder({ notes: 'no ice please' })));

    await handleOrders(editEvent('p1', { items: ONE_LATTE, notes: 'no ice please' }));

    // No prefix in the stored notes and none supplied → the customer's text is
    // stored alone. A prefix with an empty time would look like a collection
    // time the cashier could act on.
    expect(writtenNotes()).toBe('no ice please');
    expect(writtenNotes()).not.toContain('PRE-ORDER');
  });

  it('create: a pre-order placed with no collectionTime gets no prefix', async () => {
    stage({ codes: { ABC123: codeRecord() }, menu: { latte: LATTE } });

    const res = await handleOrders(createEvent({
      customerName: 'Grace', preorderCode: 'ABC123', notes: 'no ice', items: ONE_LATTE,
    }));

    expect(res.statusCode).toBe(201);
    expect(orderPuts()[0].Item.notes).toBe('no ice');
  });
});

// ─── 12. collectionTime is ignored on an ordinary order ─────────────

/**
 * The `else` arm of the `notes = :n` composition. It is reachable ONLY when
 * `body.notes !== undefined` on a non-pre-order (`appliedCollectionTime` is set
 * only for a pre-order), so it is the branch with the least natural coverage —
 * pinned here on the exact `:n` written, not merely on the absence of an error.
 */
describe('collectionTime is ignored on an ordinary (non-pre-order) order', () => {
  it('edit: writes body.notes VERBATIM and invents no prefix', async () => {
    stage({ orders: { n1: plainOrder() }, menu: { latte: LATTE } });

    const res = await handleOrders(editEvent('n1', {
      items: ONE_LATTE, notes: 'ring the bell twice', collectionTime: 'After 1st Service',
    }));

    expect(res.statusCode).toBe(200);
    expect(orderUpdates()[0].UpdateExpression).toContain('notes = :n');
    expect(writtenNotes()).toBe('ring the bell twice');
    expect(writtenNotes()).not.toContain('PRE-ORDER');
    expect(writtenNotes()).not.toContain('After 1st Service');
  });

  it('edit: keeps a body.notes value that LOOKS like a prefix exactly as sent', async () => {
    // An ordinary order's notes are the customer's own string, so nothing is
    // stripped from them — that stripping is a pre-order-only behaviour.
    stage({ orders: { n1: plainOrder() }, menu: { latte: LATTE } });

    await handleOrders(editEvent('n1', {
      items: ONE_LATTE, notes: '[PRE-ORDER: EVIL] Collect: 3am | text',
      collectionTime: 'After 1st Service',
    }));

    expect(writtenNotes()).toBe('[PRE-ORDER: EVIL] Collect: 3am | text');
  });

  it('edit: an empty body.notes still writes an empty string', async () => {
    stage({ orders: { n1: plainOrder({ notes: 'no ice' }) }, menu: { latte: LATTE } });

    await handleOrders(editEvent('n1', { items: ONE_LATTE, notes: '' }));

    expect(orderUpdates()[0].UpdateExpression).toContain('notes = :n');
    expect(writtenNotes()).toBe('');
  });

  it('edit: collectionTime alone emits no notes clause at all', async () => {
    stage({ orders: { n1: plainOrder() }, menu: { latte: LATTE } });

    const res = await handleOrders(editEvent('n1', {
      items: ONE_LATTE, collectionTime: 'After 1st Service',
    }));

    expect(res.statusCode).toBe(200);
    // `appliedCollectionTime` is never set on a non-pre-order, so the stored
    // notes are left completely alone.
    expect(orderUpdates()[0].UpdateExpression).not.toContain('notes');
    expect(orderUpdates()[0].ExpressionAttributeValues).not.toHaveProperty(':n');
  });

  it('edit: reads no PREORDER_CODE record for an ordinary order', async () => {
    stage({ orders: { n1: plainOrder() }, menu: { latte: LATTE } });

    await handleOrders(editEvent('n1', {
      items: ONE_LATTE, notes: 'x', collectionTime: 'After 1st Service',
    }));

    expect(codeReads()).toHaveLength(0);
  });

  it('create: an ordinary order ignores collectionTime and stores notes verbatim', async () => {
    stage({ menu: { latte: LATTE } });

    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng', notes: 'ring the bell', collectionTime: 'After 1st Service',
      items: ONE_LATTE,
    }));

    expect(res.statusCode).toBe(201);
    expect(orderPuts()[0].Item.notes).toBe('ring the bell');
    expect(orderPuts()[0].Item.isPreOrder).toBeUndefined();
  });

  it('create: an ordinary order is NOT refused for an off-list collectionTime', async () => {
    // The field has nowhere to be stored on a non-pre-order, so it is ignored
    // rather than validated — validating it would break every walk-in order that
    // happens to carry a stale field from a cached shell.
    stage({ menu: { latte: LATTE } });

    const res = await handleOrders(createEvent({
      customerName: 'Ah Beng', collectionTime: '9:99 XM', items: ONE_LATTE,
    }));

    expect(res.statusCode).toBe(201);
    expect(orderPuts()[0].Item.notes).toBe('');
  });
});

// ─── 13. The pre-order edit restrictions still hold ─────────────────

/**
 * Regression guard: `preorderItemRejection()` must still be called from
 * `modifyOrder`. The whole create/edit parity class of bug was that it was not —
 * a compliant pre-order could be edited into FOOD or into an ineligible drink,
 * with the pre-order zeroing the entire gross.
 */
describe('the pre-order edit restrictions survive the notes/collection-time work', () => {
  it('still refuses FOOD on a pre-order edit', async () => {
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: [{ menuItemId: 'cookie', quantity: 1 }],
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Pre-orders can only include drinks (Cookie is FOOD)');
    expect(orderUpdates()).toHaveLength(0);
    // And nothing moved the food counters on the way out.
    expect(menuUpdates()).toHaveLength(0);
  });

  it('still refuses FOOD even with a perfectly valid note and collection time', async () => {
    // The rejection must not be reachable-past by supplying the new fields.
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: [{ menuItemId: 'cookie', quantity: 1, note: 'warm please' }],
      collectionTime: 'After 2nd Service', notes: 'thanks',
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/can only include drinks/);
    expect(orderUpdates()).toHaveLength(0);
  });

  it('still refuses a drink outside eligibleItems on a pre-order edit', async () => {
    stage(preOrderWorld(preOrder(), codeRecord({ eligibleItems: ['mocha'] })));

    const res = await handleOrders(editEvent('p1', {
      items: [{ menuItemId: 'latte', quantity: 1, note: 'less sugar' }],
      collectionTime: 'After 2nd Service',
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Latte is not available on this pre-order link');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('still refuses an excludedOptions variant on a pre-order edit', async () => {
    stage(preOrderWorld(preOrder(), codeRecord({ excludedOptions: ['Milk:Oat Milk'] })));

    const res = await handleOrders(editEvent('p1', {
      items: [{
        menuItemId: 'latte', quantity: 1, note: 'thanks',
        selectedVariants: [{ group: 'Milk', option: 'Oat Milk', price: 1 }],
      }],
      collectionTime: 'After 2nd Service',
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Oat Milk is not available on this pre-order link');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('a hard-deleted link still gets drinks-only enforced (fail closed)', async () => {
    stage({ orders: { p1: preOrder() }, codes: {}, menu: { cookie: COOKIE } });

    const res = await handleOrders(editEvent('p1', {
      items: [{ menuItemId: 'cookie', quantity: 1 }],
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/can only include drinks/);
    expect(orderUpdates()).toHaveLength(0);
  });

  it('and the edit stays free: an accepted pre-order edit is still RM0 / MINISTRY_PREORDER', async () => {
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: [{ menuItemId: 'latte', quantity: 3, note: 'all decaf' }],
      collectionTime: 'After 2nd Service',
    }));

    expect(res.statusCode).toBe(200);
    const v = orderUpdates()[0].ExpressionAttributeValues;
    expect(v[':t']).toBe(0);
    expect(v[':ga']).toBe(24);
    expect(v[':do']).toBe(24);
    expect(v[':dt']).toBe('MINISTRY_PREORDER');
    // Items keep the FULL unitPrice; free-ness is order-level.
    expect(v[':items'][0].unitPrice).toBe(8);
    expect(v[':items'][0].quantity).toBe(3);
    expect(v[':items'][0].note).toBe('all decaf');
  });
});

// ─── 14. getOrder exposes the picker only for a pre-order ───────────

describe('getOrder serves the collection-time picker for pre-orders only', () => {
  it('returns collectionTime and collectionOptions for a pre-order', async () => {
    stage({ orders: { p1: preOrder() }, codes: { ABC123: codeRecord() } });

    const res = await handleOrders(getEvent('p1'));
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);

    expect(b.collectionTime).toBe('After 1st Service');
    expect(b.collectionOptions).toEqual(DEFAULT_COLLECTION_OPTIONS);
    expect(b.isPreOrder).toBe(true);
  });

  it("serves the LINK's own options when it has them", async () => {
    // A picker offering an option the validator rejects is a 400 the customer
    // cannot act on, so this must be the same list `resolveCollectionTime` uses.
    stage({
      orders: { p1: preOrder() },
      codes: { ABC123: codeRecord({ collectionOptions: ['Before Service', 'After Combined Service'] }) },
    });

    const b = JSON.parse((await handleOrders(getEvent('p1'))).body);
    expect(b.collectionOptions).toEqual(['Before Service', 'After Combined Service']);
  });

  it("returns collectionTime '' for a pre-order with no prefix, still with options", async () => {
    stage({ orders: { p1: preOrder({ notes: 'no ice' }) }, codes: { ABC123: codeRecord() } });

    const b = JSON.parse((await handleOrders(getEvent('p1'))).body);
    expect(b.collectionTime).toBe('');
    expect(b.collectionOptions).toEqual(DEFAULT_COLLECTION_OPTIONS);
  });

  it('falls back to the defaults for a hard-deleted link rather than failing the poll', async () => {
    stage({ orders: { p1: preOrder() }, codes: {} });

    const res = await handleOrders(getEvent('p1'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).collectionOptions).toEqual(DEFAULT_COLLECTION_OPTIONS);
  });

  it('OMITS both fields for an ordinary order and issues NO second read', async () => {
    // This handler is polled every 7s by track.html. The extra lookup is guarded
    // on `isPreOrder`, and a guard is untested unless a fixture reaches it — so
    // assert the read COUNT, not just the response shape.
    stage({ orders: { n1: plainOrder() }, codes: { ABC123: codeRecord() } });

    const res = await handleOrders(getEvent('n1'));
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);

    expect(b).not.toHaveProperty('collectionTime');
    expect(b).not.toHaveProperty('collectionOptions');
    expect(b.isPreOrder).toBe(false);

    expect(gets()).toHaveLength(1);
    expect(gets()[0].Key).toEqual({ PK: 'ORDER#n1', SK: 'META' });
    expect(codeReads()).toHaveLength(0);
  });

  it('omits them, and reads no link, for a record with a stray preorderCode but isPreOrder not true', async () => {
    // The guard is `o.isPreOrder === true`, not a truthy check on the code — so
    // this fixture is what actually REACHES the read guard rather than being
    // filtered out earlier by having no code to look up. Without the guard this
    // order pays for a second DynamoDB read on every 7s poll.
    stage({
      orders: { n1: plainOrder({ preorderCode: 'ABC123', isPreOrder: false }) },
      codes: { ABC123: codeRecord() },
    });

    const b = JSON.parse((await handleOrders(getEvent('n1'))).body);

    expect(b.isPreOrder).toBe(false);
    expect(b).not.toHaveProperty('collectionTime');
    expect(b).not.toHaveProperty('collectionOptions');
    expect(gets()).toHaveLength(1);
    expect(codeReads()).toHaveLength(0);
    // The code is still echoed back — that field was never guarded.
    expect(b.preorderCode).toBe('ABC123');
  });

  it('the pre-order control issues exactly TWO reads', async () => {
    // The counterpart to the assertion above: 1 (order) vs 2 (order + link) is
    // what makes "no second read" meaningful rather than vacuous.
    stage({ orders: { p1: preOrder() }, codes: { ABC123: codeRecord() } });

    await handleOrders(getEvent('p1'));

    expect(gets()).toHaveLength(2);
    expect(codeReads().map((c) => c.Key.PK)).toEqual(['PREORDER_CODE#ABC123']);
  });

  it('issues no second read for a pre-order with no code on the record', async () => {
    stage({ orders: { p1: preOrder({ preorderCode: null }) } });

    const b = JSON.parse((await handleOrders(getEvent('p1'))).body);
    expect(codeReads()).toHaveLength(0);
    // …but the picker still renders, off the defaults.
    expect(b.collectionOptions).toEqual(DEFAULT_COLLECTION_OPTIONS);
  });
});

// ─── 15. The 200-char budget is the CUSTOMER's portion ──────────────

describe('the 200-character notes budget measures the customer portion only', () => {
  const AT = 'n'.repeat(200);
  const OVER = 'n'.repeat(201);

  it('accepts 200 customer characters even though the composed value is longer', async () => {
    // The prefix is the CAFÉ's text. `createOrder` lets the composed value exceed
    // 200 for exactly that reason, so validating the composed string on edit
    // would reject notes that create accepted.
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, notes: `${PREFIX_1ST} | ${AT}`,
    }));

    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX_1ST} | ${AT}`);
    expect(String(writtenNotes()).length).toBeGreaterThan(200);
  });

  it('accepts 200 customer characters while ALSO changing the collection time', async () => {
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, notes: `${PREFIX_1ST} | ${AT}`, collectionTime: 'After 2nd Service',
    }));

    expect(res.statusCode).toBe(200);
    expect(writtenNotes()).toBe(`${PREFIX_2ND} | ${AT}`);
  });

  it('rejects 201 customer characters', async () => {
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, notes: `${PREFIX_1ST} | ${OVER}`,
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('notes cannot exceed 200 characters');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('measures the WHOLE string on an ordinary order', async () => {
    stage({ orders: { n1: plainOrder() }, menu: { latte: LATTE } });
    const ok = await handleOrders(editEvent('n1', { items: ONE_LATTE, notes: AT }));
    expect(ok.statusCode).toBe(200);

    stage({ orders: { n1: plainOrder() }, menu: { latte: LATTE } });
    const bad = await handleOrders(editEvent('n1', { items: ONE_LATTE, notes: OVER }));
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('notes cannot exceed 200 characters');
    expect(orderUpdates()).toHaveLength(0);
  });

  it('still rejects a non-string notes on both order kinds', async () => {
    stage(preOrderWorld());
    const pre = await handleOrders(editEvent('p1', { items: ONE_LATTE, notes: 5 }));
    expect(pre.statusCode).toBe(400);
    expect(JSON.parse(pre.body).error).toBe('notes must be a string');

    stage({ orders: { n1: plainOrder() }, menu: { latte: LATTE } });
    const plain = await handleOrders(editEvent('n1', { items: ONE_LATTE, notes: 5 }));
    expect(plain.statusCode).toBe(400);
    expect(JSON.parse(plain.body).error).toBe('notes must be a string');
  });
});

// ─── 16. modifyOrder never touches expiresAt ────────────────────────

describe('modifyOrder leaves expiresAt completely alone', () => {
  it("does not mention expiresAt or REMOVE on a pre-order's UpdateExpression", async () => {
    // A pre-order's `expiresAt` is the link's ISO `serviceEndTime` and is the
    // ONLY input to `expirePreOrders()`. Removing or renumbering it here leaves
    // the order with nothing able to expire it — or, if renumbered, arms a live
    // DynamoDB TTL on a record meant to live for days.
    stage(preOrderWorld());

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'After 2nd Service', notes: 'less ice',
    }));

    expect(res.statusCode).toBe(200);
    const expr = orderUpdates()[0].UpdateExpression;
    expect(expr).not.toContain('expiresAt');
    expect(expr).not.toContain('REMOVE');
    expect(orderUpdates()[0].ExpressionAttributeValues).not.toHaveProperty(':e');
  });

  it('does not mention expiresAt on an ordinary order either', async () => {
    // The order stays PENDING, so there is no transition to strip a TTL for.
    stage({ orders: { n1: plainOrder() }, menu: { latte: LATTE } });

    const res = await handleOrders(editEvent('n1', { items: ONE_LATTE, notes: 'x' }));

    expect(res.statusCode).toBe(200);
    const expr = orderUpdates()[0].UpdateExpression;
    expect(expr).not.toContain('expiresAt');
    expect(expr).not.toContain('REMOVE');
  });

  it('still guards on the PENDING status and 409s on a stale one', async () => {
    // The edit is a conditional write; the collection-time work must not have
    // loosened it.
    stage(preOrderWorld());
    expect(orderUpdates()).toHaveLength(0);
    await handleOrders(editEvent('p1', { items: ONE_LATTE, collectionTime: 'After 2nd Service' }));
    expect(orderUpdates()[0].ConditionExpression).toBe('#s = :pending');

    mockDbSend.mockReset();
    mockDbSend.mockImplementation(async (cmd: any) => {
      if (cmd.__cmd === 'Get' && cmd.TableName === 'test-orders') return { Item: preOrder() };
      if (cmd.__cmd === 'Get' && cmd.TableName === 'test-settings' && String(cmd.Key.PK).startsWith('PREORDER_CODE#')) {
        return { Item: codeRecord() };
      }
      if (cmd.__cmd === 'Get' && cmd.TableName === 'test-settings') return { Item: OPEN_SETTINGS };
      if (cmd.__cmd === 'Get' && cmd.TableName === 'test-menu') return { Item: LATTE };
      if (cmd.__cmd === 'Update' && cmd.TableName === 'test-orders') {
        throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
      }
      return {};
    });

    const res = await handleOrders(editEvent('p1', { items: ONE_LATTE, collectionTime: 'After 2nd Service' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('Order is no longer modifiable');
    // No food movement after a failed guard.
    expect(menuUpdates()).toHaveLength(0);
  });

  it('refuses to edit an order that is no longer PENDING', async () => {
    stage(preOrderWorld(preOrder({ status: 'PREPARING' })));

    const res = await handleOrders(editEvent('p1', {
      items: ONE_LATTE, collectionTime: 'After 2nd Service',
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Order cannot be modified');
    expect(orderUpdates()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
