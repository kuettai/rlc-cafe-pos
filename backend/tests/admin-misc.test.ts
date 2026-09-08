/**
 * The MISCELLANEOUS tail of `backend/src/routes/admin.ts` — everything that is
 * neither catalogue (menu / ingredients / recipes, see `admin-catalog.test.ts`),
 * nor users / settings, nor reports. `admin.ts` is ~1030 lines and is covered by
 * one suite per sub-resource; this one owns:
 *
 *   - `GET/PUT  /api/admin/settings/preorder-templates`
 *   - `GET/POST/PUT/DELETE /api/admin/verses`   (ADMIN-side Bible-verse CRUD —
 *     distinct from `tests/verses.test.ts`, which covers the PUBLIC
 *     `GET /api/verses/random` in `src/routes/verses.ts`)
 *   - `GET/POST/DELETE /api/admin/display/slides` + `GET /api/admin/display/upload-url`
 *   - `GET /api/admin/stock-history` and `GET /api/admin/stock-history/snapshots`
 *   - `GET /api/admin/activity-log`   (a stub)
 *   - `GET /api/admin/featured-drink/audit`
 *   - `GET /api/admin/customers`
 *
 * Four things are load-bearing, and each is why a test below exists:
 *
 * 1. **Path matching in this tail is `endsWith`, not an unanchored regex.** The
 *    source carries a NOTE that `/stock-history/snapshots` "must be matched
 *    before the generic /stock-history". Both directions are pinned here, and the
 *    teeth are the SHAPE of the command each branch sends — snapshots does a
 *    prefix `Scan` and needs no `date`, the generic does a `PK = :pk` `Query` and
 *    400s without one. Those two are impossible to confuse, so an assertion on
 *    one cannot pass for the other. (The three `verses`/`slides` per-id branches
 *    ARE unanchored regexes, so the collection vs per-id split is pinned too.)
 *
 * 2. **`FRONTEND_BUCKET` is read INSIDE the handler here**
 *    (`process.env.FRONTEND_BUCKET` at the top of the upload-url branch), unlike
 *    `routes/display.ts` which captures it once at module load. So the
 *    unconfigured-bucket 500 needs nothing more than deleting the env var — no
 *    `jest.resetModules()` + re-`require`, which is what `display.test.ts` has to
 *    do. Do not "harmonise" the two: caching it here would make this test lie.
 *
 * 3. **The pre-order template GET and PUT are deliberately ASYMMETRIC on empty.**
 *    GET substitutes defaults for an empty `eligibleItemKeywords` /
 *    `collectionOptions`, but returns an empty `excludedOptions` verbatim, because
 *    "block nothing" has to survive a reload. PUT writes what it is given. The
 *    round trip is pinned in both shapes.
 *
 * 4. **Assertions are on what the HANDLER produced** — the `Item`, the
 *    `UpdateExpression`, the `Key`, the S3 command handed to `getSignedUrl`, the
 *    parsed response — never on the fixture this file constructed.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and it
 * is mocked; the S3 client and the presigner are mocked too, so no AWS call is
 * made and no URL is really signed. No network, no credentials, nothing written to
 * production — so no `ZZTEST_` marker applies (that rule covers suites that create
 * real records).
 *
 * The clock is pinned with `jest.setSystemTime`, because three of these branches
 * default a query param to "today" (`new Date().toISOString().split('T')[0]`) and
 * one stamps `updatedAt`.
 */

import { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbSend = jest.fn();
const mockGetSignedUrl = jest.fn();
const mockPutObjectCommand = jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Put' }));

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

/** The same S3 mock shape `display.test.ts` established — one client object we
 *  can assert `getSignedUrl` was handed, and a tagged command factory. */
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ __s3: 'mock-client' })),
  PutObjectCommand: mockPutObjectCommand,
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

const BUCKET_NAME = 'test-frontend-bucket';
process.env.FRONTEND_BUCKET = BUCKET_NAME;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleAdmin } = require('../src/routes/admin');

// ─── Clock ────────────────────────────────────────────────────────────────────

/** 10:30 Sunday MYT — a real service slot. UTC date is 2026-08-16. */
const SUNDAY_1030_MYT = new Date('2026-08-16T02:30:00.000Z');
const TODAY_UTC = '2026-08-16';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORED_TEMPLATES = {
  PK: 'SETTINGS#PREORDER_TEMPLATES', SK: 'META',
  bannerMessage: 'Worship team pre-order — one drink each',
  eligibleItemKeywords: ['latte', 'tea'],
  collectionOptions: ['After 1st Service'],
  excludedOptions: ['Milk:Oat Milk', 'Syrup:Hazelnut'],
  updatedAt: '2026-08-09T01:00:00.000Z',
};

/** The exact defaults the GET branch substitutes when nothing is stored. */
const TEMPLATE_DEFAULTS = {
  bannerMessage:
    'Ministry Pre-Order — Kindly select one drink\n{$SUNDAY} Service · Collect {$SUNDAY}',
  eligibleItemKeywords: ['latte', 'long black', 'decaf', 'soda', 'tea', 'mineral water'],
  collectionOptions: ['After 1st Service', 'After 2nd Service'],
  excludedOptions: ['Milk:Oat Milk'],
  updatedAt: null,
};

const VERSE_A = {
  PK: 'BIBLE_VERSE#verse-a', SK: 'META', verseId: 'verse-a',
  text: 'For God so loved the world', reference: 'John 3:16',
  isActive: true, createdAt: '2026-08-01T00:00:00.000Z',
};

const VERSE_B = {
  PK: 'BIBLE_VERSE#verse-b', SK: 'META', verseId: 'verse-b',
  text: 'The Lord is my shepherd', reference: 'Psalm 23:1',
  isActive: false, createdAt: '2026-08-02T00:00:00.000Z',
};

/** A row written before `createdAt` existed — the `|| ''` arm of the sort. */
const VERSE_LEGACY = {
  PK: 'BIBLE_VERSE#verse-legacy', SK: 'META', verseId: 'verse-legacy',
  text: 'Be still', reference: 'Psalm 46:10', isActive: true,
};

const SLIDE_A = {
  PK: 'DISPLAY_SLIDE#slide-a', SK: 'META', slideId: 'slide-a',
  imageUrl: '/display-slides/a.png', title: 'Free refills',
  startDate: '2026-08-01', expiryDate: '2026-12-31', sortOrder: 2,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const SLIDE_B = {
  PK: 'DISPLAY_SLIDE#slide-b', SK: 'META', slideId: 'slide-b',
  imageUrl: '/display-slides/b.png', title: 'Newcomers welcome',
  startDate: '2026-08-01', expiryDate: '2026-12-31', sortOrder: 1,
  createdAt: '2026-08-02T00:00:00.000Z',
};

/** No `sortOrder` at all — the `|| 0` arm, and every pre-field record. */
const SLIDE_LEGACY = {
  PK: 'DISPLAY_SLIDE#slide-legacy', SK: 'META', slideId: 'slide-legacy',
  imageUrl: '/display-slides/legacy.png', title: 'Old',
  startDate: '2026-08-01', expiryDate: '2026-12-31',
};

const CUSTOMER_BIG = {
  PK: 'CUSTOMER#0123456789', SK: 'META', phone: '0123456789', name: 'Mei Yii',
  birthday: '03-14', orderCount: 12, totalSpent: 96.5,
  lastOrderAt: '2026-08-09T02:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z',
  // Deliberately not in the projection — the response must drop it.
  pinHash: 'nope', notes: 'internal',
};

const CUSTOMER_SMALL = {
  PK: 'CUSTOMER#0129876543', SK: 'META', phone: '0129876543', name: 'Ah Seng',
  orderCount: 2, totalSpent: 14, lastOrderAt: '2026-08-02T02:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
};

/** A brand-new customer: every optional field absent, so all five `||` arms. */
const CUSTOMER_BARE = {
  PK: 'CUSTOMER#0111111111', SK: 'META', phone: '0111111111', name: 'New Face',
};

// ─── Staging ──────────────────────────────────────────────────────────────────

interface World {
  /** A record a `GetCommand` can find, keyed by PK. */
  records?: Record<string, Record<string, unknown>>;
  /** Rows a settings-table prefix `Scan` returns. */
  settingsRows?: Record<string, unknown>[];
  /** Rows the customers-table `Scan` returns. */
  customerRows?: Record<string, unknown>[];
  /** Rows a `PK = :pk` settings `Query` returns. */
  queryRows?: Record<string, unknown>[];
  /** Return no `Items` key at all from the Scan, rather than an empty array. */
  scanItemsAbsent?: boolean;
  /** Return no `Items` key at all from the Query. */
  queryItemsAbsent?: boolean;
  /** Make every write reject with this message. */
  failWrite?: string;
}

/**
 * Answer every read from a described world keyed on the command + table the
 * handler actually asked for, rather than a `mockResolvedValueOnce` queue that
 * would let a fixture silently fill the wrong slot (`invariants`, Test teeth).
 * Several branches here hit the SAME table with a Get, a Scan and a Query, so
 * they have to be staged distinctly or a guard goes untested.
 */
function stage(world: World = {}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Get') {
      const rec = world.records?.[String(cmd.Key?.PK || '')];
      return rec ? { Item: rec } : {};
    }
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-settings') {
      return world.scanItemsAbsent ? {} : { Items: world.settingsRows || [] };
    }
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-customers') {
      return world.scanItemsAbsent ? {} : { Items: world.customerRows || [] };
    }
    if (cmd.__cmd === 'Query') {
      return world.queryItemsAbsent ? {} : { Items: world.queryRows || [] };
    }
    if (['Put', 'Update', 'Delete'].includes(cmd.__cmd) && world.failWrite) {
      throw new Error(world.failWrite);
    }
    return {};
  });
}

function makeEvent(overrides: Record<string, unknown> = {}): APIGatewayProxyEvent {
  const { body, ...rest } = overrides as any;
  return {
    httpMethod: 'GET',
    path: '/api/admin/activity-log',
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
function writes() {
  return cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd));
}

/** Call the handler and return `[statusCode, parsedBody]`. */
async function call(event: APIGatewayProxyEvent): Promise<[number, any]> {
  const r = await handleAdmin(event);
  expect(r.headers).toEqual({ 'Content-Type': 'application/json' });
  return [r.statusCode, JSON.parse(r.body)];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.setSystemTime(SUNDAY_1030_MYT);
  stage();
  mockGetSignedUrl.mockReset();
  mockGetSignedUrl.mockResolvedValue('https://s3.example.invalid/presigned-put');
  mockPutObjectCommand.mockClear();
  process.env.FRONTEND_BUCKET = BUCKET_NAME;
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/settings/preorder-templates
// ══════════════════════════════════════════════════════════════════════════════

const TEMPLATES_PATH = '/api/admin/settings/preorder-templates';

describe('GET /api/admin/settings/preorder-templates', () => {
  it('reads the single SETTINGS#PREORDER_TEMPLATES record', async () => {
    const [status] = await call(makeEvent({ path: TEMPLATES_PATH }));

    expect(status).toBe(200);
    const gets = sent('Get', 'test-settings');
    expect(gets).toHaveLength(1);
    expect(gets[0].Key).toEqual({ PK: 'SETTINGS#PREORDER_TEMPLATES', SK: 'META' });
    expect(writes()).toHaveLength(0);
  });

  it('does NOT collide with GET /api/admin/settings — the CONFIG record is untouched', async () => {
    // Both branches are `endsWith` guards and `/admin/settings/preorder-templates`
    // does not end with `/admin/settings`, so the generic settings read can never
    // swallow this path. Pinned on the Key actually requested.
    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));

    expect(sent('Get')[0].Key).not.toEqual({ PK: 'SETTINGS', SK: 'CONFIG' });
    // And the payload is the template shape, not a raw settings record.
    expect(Object.keys(body).sort()).toEqual([
      'bannerMessage', 'collectionOptions', 'eligibleItemKeywords',
      'excludedOptions', 'updatedAt',
    ]);
  });

  it('returns every default when the record does not exist yet', async () => {
    // The state of production until an admin first saves the form, so this is
    // the common case rather than an edge case.
    const [status, body] = await call(makeEvent({ path: TEMPLATES_PATH }));

    expect(status).toBe(200);
    expect(body).toEqual(TEMPLATE_DEFAULTS);
    // The banner default carries the unresolved token on purpose: the pre-order
    // route substitutes `{$SUNDAY}` at view time, not at template-read time.
    expect(body.bannerMessage).toContain('{$SUNDAY}');
  });

  it('returns the stored values when the record exists', async () => {
    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': STORED_TEMPLATES } });

    const [status, body] = await call(makeEvent({ path: TEMPLATES_PATH }));

    expect(status).toBe(200);
    expect(body).toEqual({
      bannerMessage: 'Worship team pre-order — one drink each',
      eligibleItemKeywords: ['latte', 'tea'],
      collectionOptions: ['After 1st Service'],
      excludedOptions: ['Milk:Oat Milk', 'Syrup:Hazelnut'],
      updatedAt: '2026-08-09T01:00:00.000Z',
    });
    // The DynamoDB keys are not leaked into the API shape.
    expect(body.PK).toBeUndefined();
    expect(body.SK).toBeUndefined();
  });

  it('keeps an EMPTY bannerMessage — only a non-string falls back', async () => {
    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': { ...STORED_TEMPLATES, bannerMessage: '' } } });
    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));
    expect(body.bannerMessage).toBe('');
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['absent', undefined],
  ])('falls back to the default bannerMessage when it is %s', async (_n, bannerMessage) => {
    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': { ...STORED_TEMPLATES, bannerMessage } } });
    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));
    expect(body.bannerMessage).toBe(TEMPLATE_DEFAULTS.bannerMessage);
  });

  it.each([
    ['an EMPTY array', []],
    ['not an array', 'latte,tea'],
    ['absent', undefined],
  ])('falls back to the default eligibleItemKeywords when stored as %s', async (_n, eligibleItemKeywords) => {
    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': { ...STORED_TEMPLATES, eligibleItemKeywords } } });
    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));
    expect(body.eligibleItemKeywords).toEqual(TEMPLATE_DEFAULTS.eligibleItemKeywords);
  });

  it.each([
    ['an EMPTY array', []],
    ['not an array', 'After 1st Service'],
    ['absent', undefined],
  ])('falls back to the default collectionOptions when stored as %s', async (_n, collectionOptions) => {
    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': { ...STORED_TEMPLATES, collectionOptions } } });
    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));
    expect(body.collectionOptions).toEqual(TEMPLATE_DEFAULTS.collectionOptions);
  });

  it('returns an EMPTY excludedOptions verbatim — "block nothing" survives a reload', async () => {
    // The deliberate asymmetry: the other two lists get a non-empty fallback, this
    // one does not, because an admin who cleared the list meant it. If this ever
    // starts returning ['Milk:Oat Milk'] again, Oat Milk silently comes back on
    // every newly created pre-order link.
    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': { ...STORED_TEMPLATES, excludedOptions: [] } } });

    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));

    expect(body.excludedOptions).toEqual([]);
  });

  it('falls back to Milk:Oat Milk only when excludedOptions is NOT an array', async () => {
    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': { ...STORED_TEMPLATES, excludedOptions: undefined } } });
    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));
    expect(body.excludedOptions).toEqual(['Milk:Oat Milk']);
  });

  it('reports updatedAt as null rather than undefined when never saved', async () => {
    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': { ...STORED_TEMPLATES, updatedAt: undefined } } });
    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));
    // JSON.stringify drops an undefined value entirely; null survives the wire so
    // the admin form can distinguish "never saved" from "key missing".
    expect(body.updatedAt).toBeNull();
    expect('updatedAt' in body).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/admin/settings/preorder-templates
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/admin/settings/preorder-templates — the happy path', () => {
  function putTemplates(body: unknown) {
    return makeEvent({ httpMethod: 'PUT', path: TEMPLATES_PATH, body });
  }

  it('writes ONE Put with exactly the seven attributes, and echoes five of them', async () => {
    const [status, body] = await call(putTemplates({
      bannerMessage: 'Pick one drink',
      eligibleItemKeywords: ['Latte', 'Tea'],
      collectionOptions: ['After 1st Service', 'After 2nd Service'],
      excludedOptions: ['Milk:Oat Milk'],
    }));

    expect(status).toBe(200);
    const puts = sent('Put', 'test-settings');
    expect(puts).toHaveLength(1);
    expect(Object.keys(puts[0].Item).sort()).toEqual([
      'PK', 'SK', 'bannerMessage', 'collectionOptions', 'eligibleItemKeywords',
      'excludedOptions', 'updatedAt',
    ]);
    expect(puts[0].Item.PK).toBe('SETTINGS#PREORDER_TEMPLATES');
    expect(puts[0].Item.SK).toBe('META');
    expect(puts[0].Item.updatedAt).toBe('2026-08-16T02:30:00.000Z');
    // The response mirrors the Item, minus the keys.
    expect(body).toEqual({
      bannerMessage: 'Pick one drink',
      eligibleItemKeywords: ['latte', 'tea'],
      collectionOptions: ['After 1st Service', 'After 2nd Service'],
      excludedOptions: ['Milk:Oat Milk'],
      updatedAt: '2026-08-16T02:30:00.000Z',
    });
  });

  it('is a whole-record Put, not a partial Update — unsent keys are ERASED', async () => {
    // Worth pinning because every other admin write path here builds a
    // `SET #k = :k` UpdateCommand from the body. A form that omits
    // `excludedOptions` does not leave the stored value alone, it clears it.
    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': STORED_TEMPLATES } });

    await call(putTemplates({ collectionOptions: ['After 1st Service'] }));

    expect(sent('Update')).toHaveLength(0);
    const item = sent('Put')[0].Item;
    expect(item.bannerMessage).toBe('');
    expect(item.eligibleItemKeywords).toEqual([]);
    expect(item.excludedOptions).toEqual([]);
  });

  it('lower-cases, trims and DEDUPES eligibleItemKeywords', async () => {
    const [, body] = await call(putTemplates({
      collectionOptions: ['After 1st Service'],
      eligibleItemKeywords: ['  LATTE  ', 'latte', 'Long Black', 'LONG BLACK', 'Tea'],
    }));

    expect(sent('Put')[0].Item.eligibleItemKeywords).toEqual(['latte', 'long black', 'tea']);
    expect(body.eligibleItemKeywords).toEqual(['latte', 'long black', 'tea']);
  });

  it('drops non-string and blank keywords rather than storing them', async () => {
    await call(putTemplates({
      collectionOptions: ['After 1st Service'],
      eligibleItemKeywords: ['latte', '', '   ', 7, null, undefined, { name: 'tea' }, ['soda']],
    }));

    expect(sent('Put')[0].Item.eligibleItemKeywords).toEqual(['latte']);
  });

  it('trims collectionOptions and caps each at 60 characters, WITHOUT deduping or lower-casing', async () => {
    // The asymmetry against keywords is real: collection options are shown to
    // customers verbatim, so their case is preserved — and two identical options
    // are the admin's problem, not silently merged.
    const long = 'x'.repeat(75);

    await call(putTemplates({
      collectionOptions: ['  After 1st Service  ', 'After 1st Service', 'AFTER 2ND SERVICE', long],
    }));

    const stored = sent('Put')[0].Item.collectionOptions;
    expect(stored).toEqual([
      'After 1st Service', 'After 1st Service', 'AFTER 2ND SERVICE', 'x'.repeat(60),
    ]);
    expect(stored[3]).toHaveLength(60);
  });

  it('drops blank and non-string collectionOptions before the emptiness check', async () => {
    await call(putTemplates({ collectionOptions: ['After 1st Service', '  ', 3, null] }));
    expect(sent('Put')[0].Item.collectionOptions).toEqual(['After 1st Service']);
  });

  it('normalises excludedOptions through the shared pre-order normaliser', async () => {
    // Delegation is the point (one definition of a valid "Group:Option" key), so
    // the assertion is that the shared rules were applied: trimmed halves, an
    // entry missing either half dropped, duplicates collapsed.
    await call(putTemplates({
      collectionOptions: ['After 1st Service'],
      excludedOptions: ['  Milk : Oat Milk  ', 'Milk:Oat Milk', 'Syrup:', ':Hazelnut', 'NoColonAtAll', 7],
    }));

    expect(sent('Put')[0].Item.excludedOptions).toEqual(['Milk:Oat Milk']);
  });

  it('accepts an EMPTY excludedOptions and stores it as empty', async () => {
    await call(putTemplates({ collectionOptions: ['After 1st Service'], excludedOptions: [] }));
    expect(sent('Put')[0].Item.excludedOptions).toEqual([]);
  });

  it('coerces a non-string bannerMessage to "" instead of rejecting it', async () => {
    const [status] = await call(putTemplates({ collectionOptions: ['After 1st Service'], bannerMessage: 42 }));
    expect(status).toBe(200);
    expect(sent('Put')[0].Item.bannerMessage).toBe('');
  });

  it('accepts a bannerMessage of exactly 500 characters', async () => {
    const [status] = await call(putTemplates({
      collectionOptions: ['After 1st Service'], bannerMessage: 'b'.repeat(500),
    }));
    expect(status).toBe(200);
    expect(sent('Put')[0].Item.bannerMessage).toHaveLength(500);
  });

  it('round-trips: the stored Item read back by GET returns exactly what was written', async () => {
    await call(putTemplates({
      bannerMessage: 'Pick one',
      eligibleItemKeywords: ['Latte'],
      collectionOptions: ['After 1st Service'],
      excludedOptions: ['Milk:Oat Milk'],
    }));
    const persisted = sent('Put')[0].Item;

    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': persisted } });
    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));

    expect(body).toEqual({
      bannerMessage: 'Pick one',
      eligibleItemKeywords: ['latte'],
      collectionOptions: ['After 1st Service'],
      excludedOptions: ['Milk:Oat Milk'],
      updatedAt: '2026-08-16T02:30:00.000Z',
    });
  });

  it('does NOT round-trip an emptied keyword list — GET hands back the defaults', async () => {
    // Characterisation, not endorsement: PUT stores `[]` happily, GET reads `[]`
    // as "unset" and substitutes six defaults. An admin who clears every keyword
    // sees them all reappear on reload. Only `excludedOptions` is exempt.
    await call(putTemplates({ collectionOptions: ['After 1st Service'], eligibleItemKeywords: [] }));
    const persisted = sent('Put')[0].Item;
    expect(persisted.eligibleItemKeywords).toEqual([]);

    stage({ records: { 'SETTINGS#PREORDER_TEMPLATES': persisted } });
    const [, body] = await call(makeEvent({ path: TEMPLATES_PATH }));

    expect(body.eligibleItemKeywords).toEqual(TEMPLATE_DEFAULTS.eligibleItemKeywords);
  });
});

describe('PUT /api/admin/settings/preorder-templates — the 400s write NOTHING', () => {
  function putTemplates(body: unknown) {
    return makeEvent({ httpMethod: 'PUT', path: TEMPLATES_PATH, body });
  }

  it('rejects a bannerMessage over 500 characters', async () => {
    const [status, body] = await call(putTemplates({
      bannerMessage: 'b'.repeat(501),
      collectionOptions: ['After 1st Service'],
    }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bannerMessage cannot exceed 500 characters' });
    // "No error thrown" is not an assertion — the record must be untouched.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty array', []],
    ['an array of blanks only', ['   ', '']],
    ['an array of non-strings only', [1, null, {}]],
    ['not an array', 'After 1st Service'],
    ['absent', undefined],
  ])('rejects collectionOptions given as %s', async (_n, collectionOptions) => {
    const [status, body] = await call(putTemplates({ bannerMessage: 'ok', collectionOptions }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'At least one collectionOption is required' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('checks the banner BEFORE collectionOptions when both are bad', async () => {
    const [, body] = await call(putTemplates({ bannerMessage: 'b'.repeat(501), collectionOptions: [] }));
    expect(body.error).toBe('bannerMessage cannot exceed 500 characters');
  });

  it('rejects an entirely empty body — collectionOptions is the one required field', async () => {
    const [status, body] = await call(putTemplates({}));
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'At least one collectionOption is required' });
  });

  it('returns 500 with the message when the Put fails', async () => {
    stage({ failWrite: 'ProvisionedThroughputExceeded' });
    const [status, body] = await call(putTemplates({ collectionOptions: ['After 1st Service'] }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'ProvisionedThroughputExceeded' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Bible verses — ADMIN-side CRUD (not routes/verses.ts)
// ══════════════════════════════════════════════════════════════════════════════

const VERSES_PATH = '/api/admin/verses';

describe('GET /api/admin/verses', () => {
  it('scans the settings table on the BIBLE_VERSE# prefix', async () => {
    const [status] = await call(makeEvent({ path: VERSES_PATH }));

    expect(status).toBe(200);
    const scans = sent('Scan', 'test-settings');
    expect(scans).toHaveLength(1);
    expect(scans[0].FilterExpression).toBe('begins_with(PK, :prefix)');
    expect(scans[0].ExpressionAttributeValues).toEqual({ ':prefix': 'BIBLE_VERSE#' });
    expect(writes()).toHaveLength(0);
  });

  it('returns INACTIVE verses too — unlike the public GET /api/verses/random', async () => {
    // The teeth: `routes/verses.ts` filters `isActive = :active` on its Scan. If
    // that filter were ever copied here, an admin could no longer see or
    // re-enable a verse they had switched off.
    stage({ settingsRows: [VERSE_A, VERSE_B] });

    const [, body] = await call(makeEvent({ path: VERSES_PATH }));

    expect(body.verses.map((v: any) => v.verseId)).toEqual(['verse-a', 'verse-b']);
    expect(body.verses.map((v: any) => v.isActive)).toEqual([true, false]);
    expect(sent('Scan')[0].FilterExpression).not.toContain('isActive');
  });

  it('sorts by createdAt ascending, treating a MISSING createdAt as earliest', async () => {
    stage({ settingsRows: [VERSE_B, VERSE_LEGACY, VERSE_A] });

    const [, body] = await call(makeEvent({ path: VERSES_PATH }));

    expect(body.verses.map((v: any) => v.verseId)).toEqual(['verse-legacy', 'verse-a', 'verse-b']);
  });

  it('tolerates TWO rows with no createdAt — both arms of the `|| ""` comparator', async () => {
    stage({
      settingsRows: [
        { ...VERSE_LEGACY, verseId: 'legacy-1', createdAt: undefined },
        { ...VERSE_LEGACY, verseId: 'legacy-2', createdAt: undefined },
      ],
    });

    const [status, body] = await call(makeEvent({ path: VERSES_PATH }));

    expect(status).toBe(200);
    expect(body.verses.map((v: any) => v.verseId)).toEqual(['legacy-1', 'legacy-2']);
  });

  it('returns an empty list when the Scan has no Items key at all', async () => {
    stage({ scanItemsAbsent: true });
    const [status, body] = await call(makeEvent({ path: VERSES_PATH }));
    expect(status).toBe(200);
    expect(body).toEqual({ verses: [] });
  });
});

describe('POST /api/admin/verses', () => {
  function postVerse(body: unknown) {
    return makeEvent({ httpMethod: 'POST', path: VERSES_PATH, body });
  }

  it('creates the record with a generated uuid, isActive true and a createdAt', async () => {
    const [status, body] = await call(postVerse({ text: 'Be still', reference: 'Psalm 46:10' }));

    expect(status).toBe(201);
    const puts = sent('Put', 'test-settings');
    expect(puts).toHaveLength(1);
    expect(puts[0].Item.verseId).toMatch(UUID_V4);
    expect(puts[0].Item.PK).toBe(`BIBLE_VERSE#${puts[0].Item.verseId}`);
    expect(puts[0].Item.SK).toBe('META');
    expect(puts[0].Item.isActive).toBe(true);
    expect(puts[0].Item.createdAt).toBe('2026-08-16T02:30:00.000Z');
    // The created record is echoed verbatim, keys included.
    expect(body).toEqual(puts[0].Item);
  });

  it('stores exactly six attributes — no other body key is smuggled in', async () => {
    const [, body] = await call(postVerse({
      text: 'Be still', reference: 'Psalm 46:10',
      isActive: false, verseId: 'attacker-chosen', PK: 'SETTINGS', createdAt: '1999-01-01',
    }));

    expect(Object.keys(body).sort()).toEqual(['PK', 'SK', 'createdAt', 'isActive', 'reference', 'text', 'verseId']);
    // A client cannot pick its own id, pre-date the record, or create it disabled.
    expect(body.verseId).not.toBe('attacker-chosen');
    expect(body.isActive).toBe(true);
    expect(body.createdAt).toBe('2026-08-16T02:30:00.000Z');
    expect(body.PK).toBe(`BIBLE_VERSE#${body.verseId}`);
  });

  it.each([
    ['both missing', {}],
    ['text missing', { reference: 'John 3:16' }],
    ['reference missing', { text: 'For God so loved the world' }],
    ['an empty text', { text: '', reference: 'John 3:16' }],
    ['an empty reference', { text: 'For God so loved the world', reference: '' }],
    ['a null text', { text: null, reference: 'John 3:16' }],
  ])('rejects %s with 400 and writes nothing', async (_n, body) => {
    const [status, parsed] = await call(postVerse(body));

    expect(status).toBe(400);
    expect(parsed).toEqual({ error: 'text and reference required' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('accepts a whitespace-only text — the guard is falsiness, not emptiness', async () => {
    // Characterisation. `!text` passes for '   ', so a blank verse can be created
    // and will be picked by the public random endpoint.
    const [status] = await call(postVerse({ text: '   ', reference: '   ' }));
    expect(status).toBe(201);
    expect(sent('Put')[0].Item.text).toBe('   ');
  });

  it('returns 500 when the Put fails', async () => {
    stage({ failWrite: 'table gone' });
    const [status, body] = await call(postVerse({ text: 'x', reference: 'y' }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'table gone' });
  });
});

describe('PUT /api/admin/verses/{id}', () => {
  function putVerse(id: string, body: unknown) {
    return makeEvent({ httpMethod: 'PUT', path: `/api/admin/verses/${id}`, body });
  }

  it('updates all three fields with aliased names and the right Key', async () => {
    const [status, body] = await call(putVerse('verse-a', {
      text: 'Updated text', reference: 'John 3:17', isActive: false,
    }));

    expect(status).toBe(200);
    expect(body).toEqual({ updated: 'verse-a' });
    const updates = sent('Update', 'test-settings');
    expect(updates).toHaveLength(1);
    expect(updates[0].Key).toEqual({ PK: 'BIBLE_VERSE#verse-a', SK: 'META' });
    expect(updates[0].UpdateExpression).toBe('SET #t = :t, #r = :r, #a = :a');
    expect(updates[0].ExpressionAttributeNames).toEqual({ '#t': 'text', '#r': 'reference', '#a': 'isActive' });
    expect(updates[0].ExpressionAttributeValues).toEqual({
      ':t': 'Updated text', ':r': 'John 3:17', ':a': false,
    });
  });

  it('emits only the clauses for the fields present in the body', async () => {
    await call(putVerse('verse-a', { isActive: true }));

    const update = sent('Update')[0];
    expect(update.UpdateExpression).toBe('SET #a = :a');
    expect(update.ExpressionAttributeNames).toEqual({ '#a': 'isActive' });
    expect(update.ExpressionAttributeValues).toEqual({ ':a': true });
  });

  it('updates an EMPTY text — the guard is `!== undefined`, not truthiness', async () => {
    // Distinct from POST, which refuses a falsy text. Pinned so the two are not
    // "harmonised" into rejecting a deliberate clear.
    await call(putVerse('verse-a', { text: '', isActive: false }));

    const update = sent('Update')[0];
    expect(update.ExpressionAttributeValues[':t']).toBe('');
    expect(update.UpdateExpression).toBe('SET #t = :t, #a = :a');
  });

  it('ignores unknown body keys entirely — only three fields are writable', async () => {
    await call(putVerse('verse-a', { text: 'x', createdAt: '1999-01-01', verseId: 'other', PK: 'SETTINGS' }));

    const update = sent('Update')[0];
    expect(update.UpdateExpression).toBe('SET #t = :t');
    expect(Object.values(update.ExpressionAttributeNames)).toEqual(['text']);
    expect(update.Key).toEqual({ PK: 'BIBLE_VERSE#verse-a', SK: 'META' });
  });

  it('rejects a body with none of the three fields, before any write', async () => {
    const [status, body] = await call(putVerse('verse-a', { nonsense: true }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'No fields to update' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects an empty body with 400', async () => {
    const [status] = await call(putVerse('verse-a', {}));
    expect(status).toBe(400);
  });

  it('does NOT check the verse exists — an UpdateCommand on an unknown id UPSERTS a ghost row', async () => {
    // Characterisation of a real hazard, not endorsement. DynamoDB's UpdateItem
    // creates the item when the key is absent, and there is no
    // ConditionExpression here, so PUT to a stale/typo id writes a NEW
    // BIBLE_VERSE# record carrying only `text` — no `verseId`, no `isActive`, no
    // `createdAt`. GET /api/admin/verses (prefix scan, no isActive filter) then
    // lists it forever, while the public random endpoint (`isActive = :active`)
    // never shows it.
    const [status, body] = await call(putVerse('does-not-exist', { text: 'ghost' }));

    expect(status).toBe(200);
    expect(body).toEqual({ updated: 'does-not-exist' });
    expect(sent('Get')).toHaveLength(0); // no existence read at all
    const update = sent('Update')[0];
    expect(update.Key).toEqual({ PK: 'BIBLE_VERSE#does-not-exist', SK: 'META' });
    expect(update.ConditionExpression).toBeUndefined();
    expect(Object.values(update.ExpressionAttributeNames)).not.toContain('verseId');
  });

  it('returns 500 when the Update fails', async () => {
    stage({ failWrite: 'conditional check failed' });
    const [status, body] = await call(putVerse('verse-a', { text: 'x' }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'conditional check failed' });
  });
});

describe('DELETE /api/admin/verses/{id}', () => {
  it('deletes the keyed record and reports the id', async () => {
    const [status, body] = await call(makeEvent({
      httpMethod: 'DELETE', path: '/api/admin/verses/verse-a',
    }));

    expect(status).toBe(200);
    expect(body).toEqual({ deleted: 'verse-a' });
    const deletes = sent('Delete', 'test-settings');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Key).toEqual({ PK: 'BIBLE_VERSE#verse-a', SK: 'META' });
  });

  it('is idempotent — deleting an unknown id still reports 200', async () => {
    const [status, body] = await call(makeEvent({
      httpMethod: 'DELETE', path: '/api/admin/verses/never-existed',
    }));
    expect(status).toBe(200);
    expect(body).toEqual({ deleted: 'never-existed' });
  });

  it('returns 500 when the Delete fails', async () => {
    stage({ failWrite: 'access denied' });
    const [status, body] = await call(makeEvent({
      httpMethod: 'DELETE', path: '/api/admin/verses/verse-a',
    }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'access denied' });
  });
});

describe('verses — the collection path and the per-id regex do not cross', () => {
  it('DELETE on the bare collection path is a 404, not a delete of everything', async () => {
    // `/\/admin\/verses\/[^/]+$/` needs a non-empty non-slash id, so the bare
    // collection cannot match. There is no DELETE-collection branch.
    const [status, body] = await call(makeEvent({ httpMethod: 'DELETE', path: VERSES_PATH }));

    expect(status).toBe(404);
    expect(body.path).toBe(VERSES_PATH);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('a trailing slash matches neither branch', async () => {
    const [status] = await call(makeEvent({ httpMethod: 'DELETE', path: '/api/admin/verses/' }));
    expect(status).toBe(404);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('POST to a per-id path is a 404 — the collection POST is endsWith-anchored', async () => {
    const [status] = await call(makeEvent({
      httpMethod: 'POST', path: '/api/admin/verses/verse-a', body: { text: 'x', reference: 'y' },
    }));
    expect(status).toBe(404);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('PUT to the bare collection path is a 404', async () => {
    const [status] = await call(makeEvent({ httpMethod: 'PUT', path: VERSES_PATH, body: { text: 'x' } }));
    expect(status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Display slides
// ══════════════════════════════════════════════════════════════════════════════

const SLIDES_PATH = '/api/admin/display/slides';

describe('GET /api/admin/display/slides', () => {
  it('scans on the DISPLAY_SLIDE# prefix and writes nothing', async () => {
    const [status] = await call(makeEvent({ path: SLIDES_PATH }));

    expect(status).toBe(200);
    const scans = sent('Scan', 'test-settings');
    expect(scans).toHaveLength(1);
    expect(scans[0].FilterExpression).toBe('begins_with(PK, :prefix)');
    expect(scans[0].ExpressionAttributeValues).toEqual({ ':prefix': 'DISPLAY_SLIDE#' });
    expect(writes()).toHaveLength(0);
  });

  it('returns EXPIRED and NOT-YET-STARTED slides too — the admin list is unfiltered', async () => {
    // The public `GET /api/display/slides` narrows to today's window; the admin UI
    // needs the whole list so it can show a status badge and let an expired slide
    // be edited back into range.
    stage({
      settingsRows: [
        { ...SLIDE_A, slideId: 'expired', startDate: '2000-01-01', expiryDate: '2000-12-31', sortOrder: 1 },
        { ...SLIDE_A, slideId: 'future', startDate: '2099-01-01', expiryDate: '2099-12-31', sortOrder: 2 },
      ],
    });

    const [, body] = await call(makeEvent({ path: SLIDES_PATH }));

    expect(body.slides.map((s: any) => s.slideId)).toEqual(['expired', 'future']);
    const scan = sent('Scan')[0];
    expect(scan.FilterExpression).not.toContain('startDate');
    expect(scan.FilterExpression).not.toContain('expiryDate');
  });

  it('returns the RAW imageUrl, unsigned — signing belongs to the public read path', async () => {
    // The admin list must not consume a presign per slide. `routes/display.ts`
    // signs a short-lived GET at read time instead.
    stage({ settingsRows: [SLIDE_A] });

    const [, body] = await call(makeEvent({ path: SLIDES_PATH }));

    expect(body.slides[0].imageUrl).toBe('/display-slides/a.png');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('sorts by sortOrder ascending, treating a MISSING sortOrder as 0', async () => {
    stage({ settingsRows: [SLIDE_A, SLIDE_LEGACY, SLIDE_B] });

    const [, body] = await call(makeEvent({ path: SLIDES_PATH }));

    expect(body.slides.map((s: any) => s.slideId)).toEqual(['slide-legacy', 'slide-b', 'slide-a']);
  });

  it('returns whole records — the admin UI reads the dates and createdAt', async () => {
    stage({ settingsRows: [SLIDE_A] });
    const [, body] = await call(makeEvent({ path: SLIDES_PATH }));
    expect(body.slides[0]).toEqual(SLIDE_A);
  });

  it('returns an empty list when the Scan has no Items key at all', async () => {
    stage({ scanItemsAbsent: true });
    const [status, body] = await call(makeEvent({ path: SLIDES_PATH }));
    expect(status).toBe(200);
    expect(body).toEqual({ slides: [] });
  });
});

describe('POST /api/admin/display/slides', () => {
  function postSlide(body: unknown) {
    return makeEvent({ httpMethod: 'POST', path: SLIDES_PATH, body });
  }

  const VALID = {
    imageUrl: '/display-slides/promo.png',
    title: 'Promo',
    startDate: '2026-08-16',
    expiryDate: '2026-09-30',
    sortOrder: 3,
  };

  it('creates the record with a generated uuid and a createdAt stamp', async () => {
    const [status, body] = await call(postSlide(VALID));

    expect(status).toBe(201);
    const puts = sent('Put', 'test-settings');
    expect(puts).toHaveLength(1);
    expect(puts[0].Item.slideId).toMatch(UUID_V4);
    expect(puts[0].Item.PK).toBe(`DISPLAY_SLIDE#${puts[0].Item.slideId}`);
    expect(puts[0].Item.SK).toBe('META');
    expect(puts[0].Item.createdAt).toBe('2026-08-16T02:30:00.000Z');
    expect(body).toEqual(puts[0].Item);
  });

  it('stores exactly nine attributes — no other body key survives', async () => {
    const [, body] = await call(postSlide({ ...VALID, slideId: 'chosen', PK: 'SETTINGS', evil: true }));

    expect(Object.keys(body).sort()).toEqual([
      'PK', 'SK', 'createdAt', 'expiryDate', 'imageUrl', 'slideId', 'sortOrder', 'startDate', 'title',
    ]);
    expect(body.evil).toBeUndefined();
    // A client cannot pick its own id or overwrite the settings record.
    expect(body.slideId).not.toBe('chosen');
    expect(body.PK).toBe(`DISPLAY_SLIDE#${body.slideId}`);
  });

  it('defaults a missing title to "" and a missing sortOrder to 0', async () => {
    const [, body] = await call(postSlide({
      imageUrl: '/display-slides/x.png', startDate: '2026-08-16', expiryDate: '2026-09-30',
    }));

    expect(sent('Put')[0].Item.title).toBe('');
    expect(sent('Put')[0].Item.sortOrder).toBe(0);
    expect(body.title).toBe('');
    expect(body.sortOrder).toBe(0);
  });

  it('keeps an explicit sortOrder of 0 and a negative sortOrder', async () => {
    await call(postSlide({ ...VALID, sortOrder: 0 }));
    expect(sent('Put')[0].Item.sortOrder).toBe(0);

    stage();
    await call(postSlide({ ...VALID, sortOrder: -5 }));
    expect(sent('Put')[0].Item.sortOrder).toBe(-5);
  });

  it.each([
    ['imageUrl', { title: 'x', startDate: '2026-08-16', expiryDate: '2026-09-30' }],
    ['startDate', { imageUrl: '/x.png', expiryDate: '2026-09-30' }],
    ['expiryDate', { imageUrl: '/x.png', startDate: '2026-08-16' }],
    ['everything', {}],
  ])('rejects a body missing %s with 400 and writes nothing', async (_n, body) => {
    const [status, parsed] = await call(postSlide(body));

    expect(status).toBe(400);
    expect(parsed).toEqual({ error: 'imageUrl, startDate, expiryDate required' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects empty strings for the three required fields', async () => {
    const [status] = await call(postSlide({ imageUrl: '', startDate: '', expiryDate: '' }));
    expect(status).toBe(400);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('does NOT validate the date FORMAT, nor that expiry follows start', async () => {
    // Characterisation of a real gap. `routes/display.ts` decides visibility with
    // a LEXICOGRAPHIC string compare (`startDate <= today && today <= expiryDate`)
    // against a `YYYY-MM-DD`, so a free-text date here is not rejected, it is
    // silently mis-compared: '16/08/2026' sorts after '2026-08-16' and the slide
    // never appears. An inverted range is accepted too, producing a slide that can
    // never be shown on any date.
    const [status] = await call(postSlide({
      imageUrl: '/x.png', startDate: '16/08/2026', expiryDate: 'next Sunday',
    }));
    expect(status).toBe(201);
    expect(sent('Put')[0].Item.startDate).toBe('16/08/2026');

    stage();
    const [inverted] = await call(postSlide({
      imageUrl: '/x.png', startDate: '2026-12-31', expiryDate: '2026-01-01',
    }));
    expect(inverted).toBe(201);
  });

  it('returns 500 when the Put fails', async () => {
    stage({ failWrite: 'throttled' });
    const [status, body] = await call(postSlide(VALID));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'throttled' });
  });
});

describe('DELETE /api/admin/display/slides/{id}', () => {
  it('deletes only the DynamoDB record — the S3 object is deliberately orphaned', async () => {
    const [status, body] = await call(makeEvent({
      httpMethod: 'DELETE', path: `${SLIDES_PATH}/slide-a`,
    }));

    expect(status).toBe(200);
    expect(body).toEqual({ deleted: 'slide-a' });
    const deletes = sent('Delete', 'test-settings');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Key).toEqual({ PK: 'DISPLAY_SLIDE#slide-a', SK: 'META' });
    // No S3 command of any kind — removing the image mid-slideshow is the thing
    // the source explicitly refuses to risk.
    expect(mockPutObjectCommand).not.toHaveBeenCalled();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('extracts the id after the "slides" segment, not from the tail blindly', async () => {
    const [, body] = await call(makeEvent({
      httpMethod: 'DELETE', path: `${SLIDES_PATH}/slide-with-dashes-123`,
    }));
    expect(body).toEqual({ deleted: 'slide-with-dashes-123' });
    expect(sent('Delete')[0].Key.PK).toBe('DISPLAY_SLIDE#slide-with-dashes-123');
  });

  it('DELETE on the bare collection path is a 404', async () => {
    const [status] = await call(makeEvent({ httpMethod: 'DELETE', path: SLIDES_PATH }));
    expect(status).toBe(404);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('returns 500 when the Delete fails', async () => {
    stage({ failWrite: 'network' });
    const [status, body] = await call(makeEvent({
      httpMethod: 'DELETE', path: `${SLIDES_PATH}/slide-a`,
    }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'network' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/display/upload-url — presigned S3 PUT
// ══════════════════════════════════════════════════════════════════════════════

const UPLOAD_PATH = '/api/admin/display/upload-url';

describe('GET /api/admin/display/upload-url', () => {
  it('signs a 5-minute PUT against the configured bucket under display-slides/', async () => {
    const [status, body] = await call(makeEvent({
      path: UPLOAD_PATH,
      queryStringParameters: { filename: 'promo.png', contentType: 'image/png' },
    }));

    expect(status).toBe(200);
    expect(mockPutObjectCommand).toHaveBeenCalledTimes(1);
    expect(mockPutObjectCommand).toHaveBeenCalledWith({
      Bucket: BUCKET_NAME, Key: 'display-slides/promo.png', ContentType: 'image/png',
    });
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [client, command, options] = mockGetSignedUrl.mock.calls[0];
    expect(client).toEqual({ __s3: 'mock-client' });
    expect(command).toEqual({
      Bucket: BUCKET_NAME, Key: 'display-slides/promo.png', ContentType: 'image/png', __cmd: 'S3Put',
    });
    // 300s: long enough for a phone on café wifi, short enough that a leaked URL
    // is worthless by the time anyone finds it.
    expect(options).toEqual({ expiresIn: 300 });
    expect(body.uploadUrl).toBe('https://s3.example.invalid/presigned-put');
  });

  it('returns a bucket-agnostic RELATIVE imageUrl for the slide record', async () => {
    // The bucket stays private; `routes/display.ts` signs a GET per slide from
    // this path at read time. A absolute S3 URL stored here would 403 on the TV.
    const [, body] = await call(makeEvent({
      path: UPLOAD_PATH, queryStringParameters: { filename: 'promo.png' },
    }));

    expect(body.imageUrl).toBe('/display-slides/promo.png');
    expect(body.imageUrl).not.toContain(BUCKET_NAME);
    expect(body.imageUrl).not.toContain('http');
  });

  it('returns exactly the two keys the admin uploader reads', async () => {
    const [, body] = await call(makeEvent({ path: UPLOAD_PATH, queryStringParameters: { filename: 'a.jpg' } }));
    expect(Object.keys(body).sort()).toEqual(['imageUrl', 'uploadUrl']);
  });

  it('touches DynamoDB not at all — presigning is not a write', async () => {
    await call(makeEvent({ path: UPLOAD_PATH, queryStringParameters: { filename: 'a.jpg' } }));
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('defaults contentType to image/jpeg', async () => {
    await call(makeEvent({ path: UPLOAD_PATH, queryStringParameters: { filename: 'a.jpg' } }));
    expect(mockPutObjectCommand.mock.calls[0][0].ContentType).toBe('image/jpeg');
  });

  it('defaults the filename to slide-<epoch-ms>.jpg', async () => {
    // The clock is pinned, so the expected value is derived from the same faked
    // `Date.now()` the handler used rather than matched loosely.
    await call(makeEvent({ path: UPLOAD_PATH }));

    const key = mockPutObjectCommand.mock.calls[0][0].Key;
    expect(key).toBe(`display-slides/slide-${Date.now()}.jpg`);
    expect(key).toMatch(/^display-slides\/slide-\d+\.jpg$/);
  });

  it('defaults the filename when the query param is present but EMPTY', async () => {
    await call(makeEvent({ path: UPLOAD_PATH, queryStringParameters: { filename: '' } }));
    expect(mockPutObjectCommand.mock.calls[0][0].Key)
      .toBe(`display-slides/slide-${Date.now()}.jpg`);
  });

  it('defuses path traversal by REPLACING separators, not by taking the leaf', async () => {
    // Worth being precise about, because the source comment says "only keep the
    // leaf filename" and that is not what the code does: every character outside
    // [A-Za-z0-9._-] becomes '_'. The security property still holds — the key
    // cannot escape the display-slides/ prefix — but the resulting name keeps the
    // whole mangled path, so do not "simplify" this to a basename() later and
    // assume the tests still cover it.
    const [status, body] = await call(makeEvent({
      path: UPLOAD_PATH, queryStringParameters: { filename: '../../etc/passwd' },
    }));

    expect(status).toBe(200);
    const key = mockPutObjectCommand.mock.calls[0][0].Key;
    expect(key).toBe('display-slides/.._.._etc_passwd');
    expect(key.startsWith('display-slides/')).toBe(true);
    expect(key).not.toContain('/etc/');
    expect(body.imageUrl).toBe('/display-slides/.._.._etc_passwd');
  });

  it.each([
    ['spaces', 'my promo shot.png', 'my_promo_shot.png'],
    ['a leading slash', '/absolute.png', '_absolute.png'],
    ['a query string', 'a.png?x=1', 'a.png_x_1'],
    // One '_' per CODE UNIT: 'é' is a single NFC char here, so a single
    // underscore. An NFD 'é' would produce two.
    ['unicode', 'café.png', 'caf_.png'],
    ['a null byte', 'a\u0000.png', 'a_.png'],
    ['a backslash', 'C:\\Users\\a.png', 'C__Users_a.png'],
  ])('sanitises %s out of the filename', async (_n, filename, expected) => {
    await call(makeEvent({ path: UPLOAD_PATH, queryStringParameters: { filename } }));
    expect(mockPutObjectCommand.mock.calls[0][0].Key).toBe(`display-slides/${expected}`);
  });

  it('caps the filename at its LAST 100 characters, keeping the extension', async () => {
    // `slice(-100)` not `slice(0, 100)`: truncating the head would strip the
    // extension, and the extension is what the display page's <img> needs.
    const filename = `${'a'.repeat(200)}.png`;

    await call(makeEvent({ path: UPLOAD_PATH, queryStringParameters: { filename } }));

    const name = mockPutObjectCommand.mock.calls[0][0].Key.replace('display-slides/', '');
    expect(name).toHaveLength(100);
    expect(name.endsWith('.png')).toBe(true);
    expect(name).toBe(`${'a'.repeat(96)}.png`);
  });

  it('passes contentType through UNVALIDATED — an admin can presign a non-image', async () => {
    // Characterisation. The route is ADMIN-only (see `src/index.ts`), so this is a
    // note rather than a hole, but nothing here restricts the type to image/*.
    await call(makeEvent({
      path: UPLOAD_PATH, queryStringParameters: { filename: 'x.html', contentType: 'text/html' },
    }));

    expect(mockPutObjectCommand.mock.calls[0][0].ContentType).toBe('text/html');
  });

  it('returns 500 when the presigner throws — the error is not swallowed', async () => {
    mockGetSignedUrl.mockRejectedValue(new Error('no credentials'));

    const [status, body] = await call(makeEvent({
      path: UPLOAD_PATH, queryStringParameters: { filename: 'a.jpg' },
    }));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'no credentials' });
  });

  it('does not match POST — the branch is GET-only', async () => {
    const [status] = await call(makeEvent({ httpMethod: 'POST', path: UPLOAD_PATH }));
    expect(status).toBe(404);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/display/upload-url — FRONTEND_BUCKET not configured', () => {
  // No `jest.resetModules()` here on purpose: `admin.ts` reads
  // `process.env.FRONTEND_BUCKET` INSIDE the handler, unlike `routes/display.ts`
  // which captures it once at module load and needs a fresh module instance to
  // test this. If someone hoists it to a module-level `const` here, this test
  // starts passing for the wrong reason — it would read the value set at the top
  // of the file. The `expect` on the 500 body is what keeps that honest.

  it('returns 500 and signs nothing when the variable is absent', async () => {
    delete process.env.FRONTEND_BUCKET;

    const [status, body] = await call(makeEvent({
      path: UPLOAD_PATH, queryStringParameters: { filename: 'a.jpg' },
    }));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'FRONTEND_BUCKET not configured' });
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(mockPutObjectCommand).not.toHaveBeenCalled();
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('returns 500 for an EMPTY-STRING bucket too — the guard is falsiness', async () => {
    // A CDK misconfiguration produces '' rather than an absent var; an empty
    // Bucket would otherwise be handed to S3 and fail much later, opaquely.
    process.env.FRONTEND_BUCKET = '';

    const [status, body] = await call(makeEvent({
      path: UPLOAD_PATH, queryStringParameters: { filename: 'a.jpg' },
    }));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'FRONTEND_BUCKET not configured' });
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('leaves the other display routes working — only upload-url needs the bucket', async () => {
    delete process.env.FRONTEND_BUCKET;
    stage({ settingsRows: [SLIDE_A] });

    const [status, body] = await call(makeEvent({ path: SLIDES_PATH }));

    expect(status).toBe(200);
    expect(body.slides).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Stock history — the /snapshots vs generic path-ordering hazard
// ══════════════════════════════════════════════════════════════════════════════

const HISTORY_PATH = '/api/admin/stock-history';
const SNAPSHOTS_PATH = '/api/admin/stock-history/snapshots';

describe('stock-history — /snapshots and the generic route never swallow each other', () => {
  // The source carries a NOTE that /snapshots must be matched FIRST. Both
  // branches are `endsWith` guards, so neither predicate can match the other's
  // path and the ordering is belt-and-braces rather than load-bearing — unlike the
  // unanchored per-id regexes in the catalogue routes. Pinned in BOTH directions,
  // with teeth: the two branches send structurally different commands and disagree
  // about whether `date` is required, so an assertion on one cannot pass for the
  // other.

  it('/snapshots takes the Scan branch and needs NO date param', async () => {
    // The sharp test. If the generic branch swallowed this path it would 400 for
    // the missing `date` instead.
    const [status, body] = await call(makeEvent({ path: SNAPSHOTS_PATH }));

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['dates', 'totalSnapshots']);
    expect(sent('Scan', 'test-settings')).toHaveLength(1);
    expect(sent('Query')).toHaveLength(0);
  });

  it('the generic route takes the Query branch and DOES require a date', async () => {
    // The mirror. If /snapshots' predicate were loosened to a prefix match it
    // would answer 200 with `{dates, totalSnapshots}` here.
    const [status, body] = await call(makeEvent({ path: HISTORY_PATH }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'date query param required (YYYY-MM-DD)' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('/snapshots IGNORES a date param — it is a whole-table index, not a filter', async () => {
    await call(makeEvent({ path: SNAPSHOTS_PATH, queryStringParameters: { date: TODAY_UTC } }));

    const scan = sent('Scan')[0];
    expect(scan.ExpressionAttributeValues).toEqual({ ':prefix': 'STOCK_SNAPSHOT#' });
    expect(JSON.stringify(scan)).not.toContain(TODAY_UTC);
  });
});

describe('GET /api/admin/stock-history/snapshots', () => {
  it('scans the settings table on the STOCK_SNAPSHOT# prefix', async () => {
    await call(makeEvent({ path: SNAPSHOTS_PATH }));

    const scan = sent('Scan', 'test-settings')[0];
    expect(scan.FilterExpression).toBe('begins_with(PK, :prefix)');
    expect(scan.ExpressionAttributeValues).toEqual({ ':prefix': 'STOCK_SNAPSHOT#' });
    expect(writes()).toHaveLength(0);
  });

  it('buckets by date, counts each, and orders dates NEWEST first', async () => {
    stage({
      settingsRows: [
        { PK: 'STOCK_SNAPSHOT#2026-08-02', SK: 'T1', date: '2026-08-02' },
        { PK: 'STOCK_SNAPSHOT#2026-08-16', SK: 'T1', date: '2026-08-16' },
        { PK: 'STOCK_SNAPSHOT#2026-08-16', SK: 'T2', date: '2026-08-16' },
        { PK: 'STOCK_SNAPSHOT#2026-08-09', SK: 'T1', date: '2026-08-09' },
      ],
    });

    const [status, body] = await call(makeEvent({ path: SNAPSHOTS_PATH }));

    expect(status).toBe(200);
    expect(body.dates).toEqual([
      { date: '2026-08-16', count: 2 },
      { date: '2026-08-09', count: 1 },
      { date: '2026-08-02', count: 1 },
    ]);
    expect(body.totalSnapshots).toBe(4);
  });

  it('derives the date from the PK when the row has no date attribute', async () => {
    stage({ settingsRows: [{ PK: 'STOCK_SNAPSHOT#2026-07-26', SK: 'T1' }] });

    const [, body] = await call(makeEvent({ path: SNAPSHOTS_PATH }));

    expect(body.dates).toEqual([{ date: '2026-07-26', count: 1 }]);
  });

  it('prefers the date attribute over the PK when the two disagree', async () => {
    stage({ settingsRows: [{ PK: 'STOCK_SNAPSHOT#2026-07-26', SK: 'T1', date: '2026-08-16' }] });
    const [, body] = await call(makeEvent({ path: SNAPSHOTS_PATH }));
    expect(body.dates).toEqual([{ date: '2026-08-16', count: 1 }]);
  });

  it('counts an undatable row in totalSnapshots but not in dates — the two can disagree', async () => {
    // Characterisation of a live invariant break: the picker's counts sum to LESS
    // than `totalSnapshots`, so a snapshot can exist that no date bucket offers.
    // Pinned rather than "fixed" here, because a UI that shows 3 while the counts
    // add to 2 is the symptom to look for.
    stage({
      settingsRows: [
        { PK: 'STOCK_SNAPSHOT#2026-08-16', SK: 'T1', date: '2026-08-16' },
        { PK: 'STOCK_SNAPSHOT#2026-08-16', SK: 'T2', date: '2026-08-16' },
        { PK: 12345, SK: 'T3' }, // neither a date nor a string PK
      ],
    });

    const [, body] = await call(makeEvent({ path: SNAPSHOTS_PATH }));

    expect(body.dates).toEqual([{ date: '2026-08-16', count: 2 }]);
    expect(body.totalSnapshots).toBe(3);
    const bucketed = body.dates.reduce((s: number, d: any) => s + d.count, 0);
    expect(bucketed).toBe(2);
    expect(bucketed).toBeLessThan(body.totalSnapshots);
  });

  it('returns an empty picker when nothing has been counted yet', async () => {
    const [status, body] = await call(makeEvent({ path: SNAPSHOTS_PATH }));
    expect(status).toBe(200);
    expect(body).toEqual({ dates: [], totalSnapshots: 0 });
  });

  it('returns an empty picker when the Scan has no Items key at all', async () => {
    stage({ scanItemsAbsent: true });
    const [, body] = await call(makeEvent({ path: SNAPSHOTS_PATH }));
    expect(body).toEqual({ dates: [], totalSnapshots: 0 });
  });

  it('returns 500 when the Scan fails', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue(new Error('scan exploded'));
    const [status, body] = await call(makeEvent({ path: SNAPSHOTS_PATH }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'scan exploded' });
  });
});

describe('GET /api/admin/stock-history', () => {
  it('queries the single date partition, newest snapshot first', async () => {
    stage({ queryRows: [{ PK: `STOCK_SNAPSHOT#${TODAY_UTC}`, SK: '2026-08-16T05:00:00.000Z' }] });

    const [status, body] = await call(makeEvent({
      path: HISTORY_PATH, queryStringParameters: { date: TODAY_UTC },
    }));

    expect(status).toBe(200);
    const queries = sent('Query', 'test-settings');
    expect(queries).toHaveLength(1);
    expect(queries[0].KeyConditionExpression).toBe('PK = :pk');
    expect(queries[0].ExpressionAttributeValues).toEqual({ ':pk': `STOCK_SNAPSHOT#${TODAY_UTC}` });
    // SK is an ISO timestamp, so descending = newest first.
    expect(queries[0].ScanIndexForward).toBe(false);
    expect(body.date).toBe(TODAY_UTC);
    expect(body.snapshots).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it('echoes the requested date back and returns the rows verbatim', async () => {
    const row = { PK: 'STOCK_SNAPSHOT#2026-08-09', SK: 'T1', countedBy: 'Ah Seng', lines: [{ name: 'Milk', qty: 3 }] };
    stage({ queryRows: [row] });

    const [, body] = await call(makeEvent({
      path: HISTORY_PATH, queryStringParameters: { date: '2026-08-09' },
    }));

    expect(body).toEqual({ date: '2026-08-09', snapshots: [row] });
  });

  it('returns an empty list for a date with no snapshots', async () => {
    const [status, body] = await call(makeEvent({
      path: HISTORY_PATH, queryStringParameters: { date: '2026-01-01' },
    }));
    expect(status).toBe(200);
    expect(body).toEqual({ date: '2026-01-01', snapshots: [] });
  });

  it('returns an empty list when the Query has no Items key at all', async () => {
    stage({ queryItemsAbsent: true });
    const [, body] = await call(makeEvent({
      path: HISTORY_PATH, queryStringParameters: { date: TODAY_UTC },
    }));
    expect(body.snapshots).toEqual([]);
  });

  it.each([
    ['absent', null],
    ['an empty string', { date: '' }],
    ['a slashed date', { date: '16/08/2026' }],
    ['a short year', { date: '26-08-16' }],
    ['a single-digit month', { date: '2026-8-16' }],
    ['an ISO timestamp', { date: '2026-08-16T00:00:00Z' }],
    ['a word', { date: 'today' }],
  ])('rejects a date query param that is %s, before any read', async (_n, queryStringParameters) => {
    const [status, body] = await call(makeEvent({ path: HISTORY_PATH, queryStringParameters }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'date query param required (YYYY-MM-DD)' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('accepts a well-FORMED but impossible date — the check is shape only', async () => {
    // Characterisation: `/^\d{4}-\d{2}-\d{2}$/` says nothing about calendars, so
    // 2026-99-99 is queried and simply finds nothing. Harmless here because the
    // value is only ever a partition key, and worth pinning so nobody assumes the
    // regex validates a real date.
    const [status, body] = await call(makeEvent({
      path: HISTORY_PATH, queryStringParameters: { date: '2026-99-99' },
    }));

    expect(status).toBe(200);
    expect(sent('Query')[0].ExpressionAttributeValues[':pk']).toBe('STOCK_SNAPSHOT#2026-99-99');
    expect(body.snapshots).toEqual([]);
  });

  it('does not match POST', async () => {
    const [status] = await call(makeEvent({
      httpMethod: 'POST', path: HISTORY_PATH, queryStringParameters: { date: TODAY_UTC },
    }));
    expect(status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/activity-log — a stub
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/activity-log', () => {
  it('is a 200 stub that touches no table', async () => {
    // Pinned because the admin UI treats a 200 as "endpoint exists". Whoever
    // implements it must keep the 200 and replace the body; a 404 or 501 here
    // changes the frontend's behaviour, not just the payload.
    const [status, body] = await call(makeEvent({ path: '/api/admin/activity-log' }));

    expect(status).toBe(200);
    expect(body).toEqual({ message: 'Coming soon' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('is GET-only', async () => {
    const [status] = await call(makeEvent({ httpMethod: 'POST', path: '/api/admin/activity-log' }));
    expect(status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/featured-drink/audit
// ══════════════════════════════════════════════════════════════════════════════

const AUDIT_PATH = '/api/admin/featured-drink/audit';

describe('GET /api/admin/featured-drink/audit', () => {
  it('queries the FEATURED_AUDIT# partition for the requested date, newest first', async () => {
    stage({ queryRows: [{ PK: 'FEATURED_AUDIT#2026-08-09', SK: 'T2', action: 'CLOSE' }] });

    const [status, body] = await call(makeEvent({
      path: AUDIT_PATH, queryStringParameters: { date: '2026-08-09' },
    }));

    expect(status).toBe(200);
    const queries = sent('Query', 'test-settings');
    expect(queries).toHaveLength(1);
    expect(queries[0].KeyConditionExpression).toBe('PK = :pk');
    expect(queries[0].ExpressionAttributeValues).toEqual({ ':pk': 'FEATURED_AUDIT#2026-08-09' });
    expect(queries[0].ScanIndexForward).toBe(false);
    expect(body.date).toBe('2026-08-09');
    expect(body.entries).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it('defaults to TODAY in UTC when no date is given', async () => {
    // The clock is pinned to 10:30 Sunday MYT = 02:30 UTC on the same calendar
    // day, so the UTC and MYT dates agree here. The value is derived from the
    // handler's own convention (`toISOString().split('T')[0]`).
    const [, body] = await call(makeEvent({ path: AUDIT_PATH }));

    expect(body.date).toBe(TODAY_UTC);
    expect(sent('Query')[0].ExpressionAttributeValues[':pk']).toBe(`FEATURED_AUDIT#${TODAY_UTC}`);
  });

  it('defaults to TODAY IN MALAYSIA TIME, not the previous UTC day, on a MYT morning', async () => {
    // 07:00 Sunday MYT is still Saturday in UTC. Fixed: the audit rows are now
    // written and read with a Malaysia-day key (`malaysiaToday()`), so an admin
    // opening the tab before 08:00 MYT sees Sunday's own partition, matching
    // what pos.ts's FEATURE/UNFEATURE writers use.
    jest.setSystemTime(new Date('2026-08-15T23:00:00.000Z')); // 07:00 Sun 16 Aug MYT

    const [, body] = await call(makeEvent({ path: AUDIT_PATH }));

    expect(body.date).toBe('2026-08-16');
  });

  it('returns an empty entries list for a date with no audit rows', async () => {
    const [status, body] = await call(makeEvent({
      path: AUDIT_PATH, queryStringParameters: { date: '2026-01-01' },
    }));
    expect(status).toBe(200);
    expect(body).toEqual({ date: '2026-01-01', entries: [] });
  });

  it('returns an empty entries list when the Query has no Items key at all', async () => {
    stage({ queryItemsAbsent: true });
    const [, body] = await call(makeEvent({ path: AUDIT_PATH }));
    expect(body.entries).toEqual([]);
  });

  it('returns the audit rows verbatim — nothing is projected away', async () => {
    const row = {
      PK: `FEATURED_AUDIT#${TODAY_UTC}`, SK: '2026-08-16T02:00:00.000Z',
      previousDrinkId: 'latte-001', newDrinkId: 'mocha-002', changedBy: 'Admin',
    };
    stage({ queryRows: [row] });

    const [, body] = await call(makeEvent({ path: AUDIT_PATH }));

    expect(body.entries).toEqual([row]);
  });

  it('does NOT validate the date format — it is only a partition key', async () => {
    const [status] = await call(makeEvent({
      path: AUDIT_PATH, queryStringParameters: { date: 'not-a-date' },
    }));
    expect(status).toBe(200);
    expect(sent('Query')[0].ExpressionAttributeValues[':pk']).toBe('FEATURED_AUDIT#not-a-date');
  });

  it('returns 500 when the Query fails', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue(new Error('index missing'));
    const [status, body] = await call(makeEvent({ path: AUDIT_PATH }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'index missing' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/customers
// ══════════════════════════════════════════════════════════════════════════════

const CUSTOMERS_PATH = '/api/admin/customers';

describe('GET /api/admin/customers', () => {
  it('scans the customers table for META rows only', async () => {
    const [status] = await call(makeEvent({ path: CUSTOMERS_PATH }));

    expect(status).toBe(200);
    const scans = sent('Scan', 'test-customers');
    expect(scans).toHaveLength(1);
    expect(scans[0].FilterExpression).toBe('SK = :sk');
    expect(scans[0].ExpressionAttributeValues).toEqual({ ':sk': 'META' });
    expect(writes()).toHaveLength(0);
  });

  it('projects exactly seven fields and drops everything else', async () => {
    // The projection is the privacy boundary for this list, so it is asserted as
    // an exact key set rather than a "contains" — a new attribute on the customer
    // record must not start appearing here by accident.
    stage({ customerRows: [CUSTOMER_BIG] });

    const [, body] = await call(makeEvent({ path: CUSTOMERS_PATH }));

    expect(Object.keys(body.customers[0]).sort()).toEqual([
      'birthday', 'createdAt', 'lastOrderAt', 'name', 'orderCount', 'phone', 'totalSpent',
    ]);
    expect(body.customers[0]).toEqual({
      phone: '0123456789', name: 'Mei Yii', birthday: '03-14',
      orderCount: 12, totalSpent: 96.5,
      lastOrderAt: '2026-08-09T02:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z',
    });
    expect(JSON.stringify(body)).not.toContain('nope');
    expect(JSON.stringify(body)).not.toContain('internal');
    expect(JSON.stringify(body)).not.toContain('CUSTOMER#');
  });

  it('sorts by totalSpent DESCENDING', async () => {
    stage({ customerRows: [CUSTOMER_SMALL, CUSTOMER_BIG] });

    const [, body] = await call(makeEvent({ path: CUSTOMERS_PATH }));

    expect(body.customers.map((c: any) => c.name)).toEqual(['Mei Yii', 'Ah Seng']);
    expect(body.customers.map((c: any) => c.totalSpent)).toEqual([96.5, 14]);
  });

  it('treats a brand-new customer as 0 spent, and sorts it last', async () => {
    stage({ customerRows: [CUSTOMER_BARE, CUSTOMER_SMALL] });

    const [, body] = await call(makeEvent({ path: CUSTOMERS_PATH }));

    expect(body.customers.map((c: any) => c.name)).toEqual(['Ah Seng', 'New Face']);
    expect(body.customers[1]).toEqual({
      phone: '0111111111', name: 'New Face', birthday: null,
      orderCount: 0, totalSpent: 0, lastOrderAt: null, createdAt: null,
    });
  });

  it('nulls the four optional fields rather than omitting them', async () => {
    // `undefined` would be dropped by JSON.stringify and the admin table would
    // render blank cells with no way to tell "never ordered" from "field missing".
    stage({ customerRows: [CUSTOMER_BARE] });

    const [, body] = await call(makeEvent({ path: CUSTOMERS_PATH }));

    for (const key of ['birthday', 'lastOrderAt', 'createdAt']) {
      expect(key in body.customers[0]).toBe(true);
      expect(body.customers[0][key]).toBeNull();
    }
  });

  it('returns an empty list when there are no customers', async () => {
    const [status, body] = await call(makeEvent({ path: CUSTOMERS_PATH }));
    expect(status).toBe(200);
    expect(body).toEqual({ customers: [] });
  });

  it('returns an empty list when the Scan has no Items key at all', async () => {
    stage({ scanItemsAbsent: true });
    const [, body] = await call(makeEvent({ path: CUSTOMERS_PATH }));
    expect(body).toEqual({ customers: [] });
  });

  it('does NOT paginate the Scan — a LastEvaluatedKey is ignored', async () => {
    // Characterisation of a real limit. `GET /api/admin/reports` explicitly loops
    // on `ExclusiveStartKey` because a single read caps at 1MB; this branch issues
    // exactly ONE Scan and never asks for page two, so the customer list silently
    // truncates once the table outgrows 1MB. No ExclusiveStartKey is ever sent.
    mockDbSend.mockReset();
    mockDbSend.mockImplementation(async () => ({
      Items: [CUSTOMER_BIG],
      LastEvaluatedKey: { PK: 'CUSTOMER#0123456789', SK: 'META' },
    }));

    const [status, body] = await call(makeEvent({ path: CUSTOMERS_PATH }));

    expect(status).toBe(200);
    expect(body.customers).toHaveLength(1);
    expect(sent('Scan')).toHaveLength(1);
    expect(sent('Scan')[0].ExclusiveStartKey).toBeUndefined();
  });

  it('is GET-only — no admin write path to a customer record lives here', async () => {
    for (const httpMethod of ['POST', 'PUT', 'DELETE']) {
      stage();
      const [status] = await call(makeEvent({ httpMethod, path: CUSTOMERS_PATH, body: {} }));
      expect(status).toBe(404);
      expect(mockDbSend).not.toHaveBeenCalled();
    }
  });

  it('returns 500 when the Scan fails', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue(new Error('customers table throttled'));
    const [status, body] = await call(makeEvent({ path: CUSTOMERS_PATH }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'customers table throttled' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Shared tail behaviour for these branches
// ══════════════════════════════════════════════════════════════════════════════

describe('handleAdmin — the 404 and 500 tails, for the misc paths', () => {
  it.each([
    ['an unknown admin path', { path: '/api/admin/nonsense' }],
    ['a misspelled snapshots path', { path: '/api/admin/stock-history/snapshot' }],
    ['a plural verses typo', { path: '/api/admin/verse' }],
    ['upload-url with a trailing slash', { path: '/api/admin/display/upload-url/' }],
    ['slides with a trailing slash', { path: `${SLIDES_PATH}/` }],
    ['templates with a trailing slash', { path: `${TEMPLATES_PATH}/` }],
  ])('404s on %s and touches nothing', async (_n, overrides) => {
    const [status, body] = await call(makeEvent(overrides));

    expect(status).toBe(404);
    expect(body.error).toBe('Not found');
    expect(mockDbSend).not.toHaveBeenCalled();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('echoes the path and method in the 404 body', async () => {
    const [, body] = await call(makeEvent({ httpMethod: 'PATCH', path: '/api/admin/nope' }));
    expect(body).toEqual({ error: 'Not found', path: '/api/admin/nope', method: 'PATCH' });
  });

  it('500s with a generic message when the thrown value is not an Error', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue('a bare string');

    const [status, body] = await call(makeEvent({ path: CUSTOMERS_PATH }));

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal error' });
  });

  // Regression. The body parse used to sit ABOVE the handler's `try {`, so an
  // unparseable body never became a response at all: it REJECTED out of
  // `handleAdmin`. `src/index.ts` has no top-level try/catch around the dispatch
  // either, so the Lambda invocation failed and API Gateway answered 502 with NO
  // CORS headers — the admin PWA saw an opaque network/CORS error rather than a
  // 400 it could show the volunteer, on every write path under /api/admin.
  // The same shape still exists at `checklist.ts:11` and `planogram.ts:27`.
  it('answers 400 when the body is unparseable JSON, and writes nothing', async () => {
    const event = makeEvent({ httpMethod: 'PUT', path: TEMPLATES_PATH, body: '{not json' });

    const [status, body] = await call(event);

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid JSON body' });
    // The guard runs before any route matches, so the PUT never reached its write.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('the 400 carries the JSON content type, so the PWA can read the error', async () => {
    // The whole point of the fix: a response the browser can parse, rather than
    // a raw gateway 502. The router merges CORS headers onto whatever comes back.
    const res = await handleAdmin(makeEvent({
      httpMethod: 'POST', path: '/api/admin/verses', body: '[1,2,',
    }));

    expect(res.statusCode).toBe(400);
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('a WELL-FORMED but non-object body does not throw — only bad syntax does', async () => {
    // Narrows the defect above: `JSON.parse('"a string"')` succeeds, so the branch
    // is reached and answers normally. The failure mode is strictly a parse error.
    const [status, body] = await call(makeEvent({
      httpMethod: 'PUT', path: TEMPLATES_PATH, body: '"just a string"',
    }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'At least one collectionOption is required' });
  });

  it('treats a null body as {} for the branches that read one', async () => {
    const [status, body] = await call(makeEvent({ httpMethod: 'PUT', path: TEMPLATES_PATH }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'At least one collectionOption is required' });
  });

  it('always answers with a JSON content type', async () => {
    const ok = await handleAdmin(makeEvent({ path: '/api/admin/activity-log' }));
    const missing = await handleAdmin(makeEvent({ path: '/api/admin/nope' }));
    expect(ok.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(missing.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without a top-level import/export TypeScript
// treats it as a global script and its top-level `const`s collide with the other
// script-mode suites (`TS2451: Cannot redeclare block-scoped variable`), failing
// on a cold ts-jest cache while a warm local run passes. See tests/README.md and
// the `test-suites` skill.
// ─────────────────────────────────────────────────────────────────────────────
export {};
