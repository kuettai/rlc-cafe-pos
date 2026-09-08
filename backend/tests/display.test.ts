/**
 * TV display screen endpoints — `backend/src/routes/display.ts`.
 *
 *  - `GET /api/display/orders` — READY orders only, newest-ready first, capped
 *    at 13 (3 hero + 10 compact grid).
 *  - `GET /api/display/slides` — promo slides active for today's UTC date,
 *    ordered by `sortOrder`, each with a short-lived signed S3 GET URL, plus the
 *    admin's `displayMode` / `displayFallbackVideoUrl` so the display page does
 *    not need a second call.
 *
 * Every assertion is on what the HANDLER produced — the parsed response body, or
 * the command objects it handed to `docClient.send` / `getSignedUrl`. Never on
 * the fixture the test itself built.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked; the S3 client and the presigner are mocked too, so no AWS call
 * is made and no URL is really signed. No network, no credentials, nothing
 * written to production — so no `ZZTEST_` marker applies (that rule covers
 * suites that create real records).
 *
 * `FRONTEND_BUCKET` is read ONCE at module load (`const BUCKET = …`), so the
 * unconfigured-bucket case cannot be simulated by poking `process.env` mid-test:
 * it needs its own `jest.resetModules()` + re-`require`. That is the last
 * describe block.
 */

const mockDbSend = jest.fn();
const mockGetSignedUrl = jest.fn();
const mockGetObjectCommand = jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'GetObject' }));

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
  S3Client: jest.fn().mockImplementation(() => ({ __s3: true })),
  GetObjectCommand: mockGetObjectCommand,
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

const BUCKET_NAME = 'test-frontend-bucket';
process.env.FRONTEND_BUCKET = BUCKET_NAME;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleDisplay } = require('../src/routes/display');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Record<string, any> = {}): any {
  return {
    httpMethod: 'GET', path: '/api/display/orders', body: null,
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...overrides,
  };
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }

/** Today in the same UTC-date form the handler computes for its date window. */
function utcToday() { return new Date().toISOString().split('T')[0]; }

function slide(overrides: Record<string, any> = {}) {
  return {
    PK: `DISPLAY_SLIDE#${overrides.slideId || 'slide-1'}`, SK: 'META',
    slideId: 'slide-1', title: 'Free refills',
    imageUrl: '/display-slides/refills.png',
    startDate: '2000-01-01', expiryDate: '2099-12-31',
    sortOrder: 0,
    ...overrides,
  };
}

/**
 * Answer each read from a described world keyed on the command + table the
 * handler actually asked for, rather than a `mockResolvedValueOnce` queue that
 * would let a fixture silently fill the wrong slot (`invariants`, Test teeth).
 * The slides route issues a settings Scan AND a settings Get; they must be
 * staged distinctly or the settings fallback is untested.
 */
function stage(world: {
  readyOrders?: Record<string, unknown>[];
  slides?: Record<string, unknown>[];
  settings?: Record<string, unknown> | undefined;
  settingsThrows?: boolean;
}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Query' && cmd.TableName === 'test-orders') {
      return { Items: world.readyOrders };
    }
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-settings') {
      return { Items: world.slides };
    }
    if (cmd.__cmd === 'Get' && cmd.TableName === 'test-settings') {
      if (world.settingsThrows) throw new Error('settings unavailable');
      return world.settings === undefined ? {} : { Item: world.settings };
    }
    return {};
  });
}

beforeEach(() => {
  mockDbSend.mockReset();
  mockGetSignedUrl.mockReset();
  mockGetSignedUrl.mockResolvedValue('https://signed.example/url');
  mockGetObjectCommand.mockClear();
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/display/orders
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/display/orders', () => {
  it('queries the status index for READY only', async () => {
    stage({ readyOrders: [] });

    const res = await handleDisplay(makeEvent());

    expect(res.statusCode).toBe(200);
    const query = cmds()[0];
    expect(query.__cmd).toBe('Query');
    expect(query.TableName).toBe('test-orders');
    expect(query.IndexName).toBe('status-createdAt-index');
    expect(query.KeyConditionExpression).toBe('#s = :status');
    expect(query.ExpressionAttributeNames).toEqual({ '#s': 'status' });
    expect(query.ExpressionAttributeValues).toEqual({ ':status': 'READY' });
  });

  it('returns an empty array when nothing is READY', async () => {
    stage({ readyOrders: [] });
    const res = await handleDisplay(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ orders: [] });
  });

  it('returns an empty array when the query returns no Items key at all', async () => {
    // `Items` is absent, not empty — the `|| []` guard. A DynamoDB response
    // without it must not throw a 500 onto the TV.
    stage({ readyOrders: undefined });
    const res = await handleDisplay(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ orders: [] });
  });

  it('projects only orderId, customerName and readyAt — nothing sensitive', async () => {
    stage({
      readyOrders: [{
        orderId: 'order-1', customerName: 'Mei Yii',
        readyAt: '2026-08-16T02:10:00.000Z',
        // Everything below is deliberately NOT for a shoulder-surfer at the TV.
        phone: '0123456789', totalAmount: 11, items: [{ menuItemId: 'latte' }],
        notes: 'extra hot', status: 'READY',
      }],
    });

    const body = JSON.parse((await handleDisplay(makeEvent())).body);

    expect(body.orders).toHaveLength(1);
    expect(Object.keys(body.orders[0]).sort()).toEqual(['customerName', 'orderId', 'readyAt']);
    expect(body.orders[0]).toEqual({
      orderId: 'order-1', customerName: 'Mei Yii', readyAt: '2026-08-16T02:10:00.000Z',
    });
  });

  it('sorts newest-ready first', async () => {
    stage({
      readyOrders: [
        { orderId: 'mid', customerName: 'B', readyAt: '2026-08-16T02:05:00.000Z' },
        { orderId: 'oldest', customerName: 'C', readyAt: '2026-08-16T01:00:00.000Z' },
        { orderId: 'newest', customerName: 'A', readyAt: '2026-08-16T03:00:00.000Z' },
      ],
    });

    const body = JSON.parse((await handleDisplay(makeEvent())).body);
    expect(body.orders.map((o: any) => o.orderId)).toEqual(['newest', 'mid', 'oldest']);
  });

  it('falls back readyAt → updatedAt → createdAt, and tolerates none of the three', async () => {
    stage({
      readyOrders: [
        { orderId: 'has-ready', customerName: 'A', readyAt: '2026-08-16T03:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z', createdAt: '2026-08-15T00:00:00.000Z' },
        { orderId: 'has-updated', customerName: 'B', updatedAt: '2026-08-16T02:00:00.000Z', createdAt: '2026-08-15T00:00:00.000Z' },
        { orderId: 'has-created', customerName: 'C', createdAt: '2026-08-16T01:00:00.000Z' },
        // Two of them, so BOTH sides of the comparator's `|| ''` guard are
        // exercised — one undefined operand only covers one arm.
        { orderId: 'has-none', customerName: 'D' },
        { orderId: 'has-none-too', customerName: 'E' },
      ],
    });

    const body = JSON.parse((await handleDisplay(makeEvent())).body);

    // The timestamp each order was ranked by, taken from the response.
    expect(body.orders.map((o: any) => [o.orderId, o.readyAt])).toEqual([
      ['has-ready', '2026-08-16T03:00:00.000Z'],
      ['has-updated', '2026-08-16T02:00:00.000Z'],
      ['has-created', '2026-08-16T01:00:00.000Z'],
      // No timestamp at all sorts last on the `|| ''` comparator rather than
      // throwing on a `localeCompare` of undefined.
      ['has-none', undefined],
      ['has-none-too', undefined],
    ]);
  });

  it('caps the list at 13 = 3 hero + 10 compact grid, keeping the newest', async () => {
    stage({
      readyOrders: Array.from({ length: 20 }, (_, i) => ({
        orderId: `order-${String(i).padStart(2, '0')}`,
        customerName: `Customer ${i}`,
        // i ascending = later ready time, so 19 is the newest.
        readyAt: `2026-08-16T${String(i).padStart(2, '0')}:00:00.000Z`,
      })),
    });

    const body = JSON.parse((await handleDisplay(makeEvent())).body);

    expect(body.orders).toHaveLength(13);
    expect(body.orders[0].orderId).toBe('order-19');
    expect(body.orders[12].orderId).toBe('order-07');
  });

  it('does not write anything — a display read is a read', async () => {
    stage({ readyOrders: [{ orderId: 'o1', customerName: 'A', readyAt: 'x' }] });
    await handleDisplay(makeEvent());
    expect(cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd))).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/display/slides
// ══════════════════════════════════════════════════════════════════════════════

const SLIDES_EVENT = { path: '/api/display/slides' };

describe('GET /api/display/slides — the scan and the date window', () => {
  it('scans the settings table for the DISPLAY_SLIDE# prefix', async () => {
    stage({ slides: [], settings: undefined });

    const res = await handleDisplay(makeEvent(SLIDES_EVENT));

    expect(res.statusCode).toBe(200);
    const scan = cmds().find((c) => c.__cmd === 'Scan');
    expect(scan.TableName).toBe('test-settings');
    expect(scan.FilterExpression).toBe('begins_with(PK, :prefix)');
    expect(scan.ExpressionAttributeValues).toEqual({ ':prefix': 'DISPLAY_SLIDE#' });
  });

  it('returns an empty slide list when the scan finds none', async () => {
    stage({ slides: [], settings: undefined });
    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);
    expect(body.slides).toEqual([]);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns an empty slide list when the scan has no Items key at all', async () => {
    stage({ slides: undefined, settings: undefined });
    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);
    expect(body.slides).toEqual([]);
  });

  it('drops slides outside [startDate, expiryDate] and keeps both edges (inclusive)', async () => {
    const today = utcToday();
    stage({
      slides: [
        slide({ slideId: 'starts-tomorrow', startDate: '2099-01-01', expiryDate: '2099-12-31' }),
        slide({ slideId: 'already-expired', startDate: '2000-01-01', expiryDate: '2000-12-31' }),
        slide({ slideId: 'starts-today', startDate: today, expiryDate: '2099-12-31' }),
        slide({ slideId: 'expires-today', startDate: '2000-01-01', expiryDate: today }),
      ],
      settings: undefined,
    });

    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);
    expect(body.slides.map((s: any) => s.slideId)).toEqual(['starts-today', 'expires-today']);
  });

  it('sorts by sortOrder ascending, treating a missing sortOrder as 0', async () => {
    stage({
      slides: [
        slide({ slideId: 'third', sortOrder: 5 }),
        slide({ slideId: 'second', sortOrder: 1 }),
        slide({ slideId: 'first-no-order', sortOrder: undefined }),
      ],
      settings: undefined,
    });

    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);
    expect(body.slides.map((s: any) => s.slideId)).toEqual(['first-no-order', 'second', 'third']);
  });

  it('defaults a missing title to an empty string', async () => {
    stage({ slides: [slide({ title: undefined })], settings: undefined });
    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);
    expect(body.slides[0].title).toBe('');
  });
});

describe('GET /api/display/slides — signing', () => {
  it('signs a 12-hour GET URL against the configured bucket, stripping the leading slash', async () => {
    stage({ slides: [slide({ imageUrl: '/display-slides/refills.png' })], settings: undefined });

    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);

    expect(body.slides[0].imageUrl).toBe('https://signed.example/url');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    const [, command, options] = mockGetSignedUrl.mock.calls[0];
    expect(command).toEqual({ Bucket: BUCKET_NAME, Key: 'display-slides/refills.png', __cmd: 'GetObject' });
    // 43200s = 12h: longer than a service window, shorter than the 30-minute
    // refresh cycle can outlive.
    expect(options).toEqual({ expiresIn: 43200 });
  });

  it('leaves a key with no leading slash alone', async () => {
    stage({ slides: [slide({ imageUrl: 'display-slides/no-slash.png' })], settings: undefined });

    await handleDisplay(makeEvent(SLIDES_EVENT));

    expect(mockGetObjectCommand).toHaveBeenCalledWith({
      Bucket: BUCKET_NAME, Key: 'display-slides/no-slash.png',
    });
  });

  it('returns an empty imageUrl and signs nothing when the record has no imageUrl', async () => {
    // The display page hides slides with a falsy imageUrl; the alternative is a
    // signed URL for the key "" and a broken <img> on the TV.
    stage({ slides: [slide({ imageUrl: undefined })], settings: undefined });

    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);

    expect(body.slides[0].imageUrl).toBe('');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('signs every active slide independently', async () => {
    mockGetSignedUrl
      .mockResolvedValueOnce('https://signed.example/one')
      .mockResolvedValueOnce('https://signed.example/two');
    stage({
      slides: [
        slide({ slideId: 'a', sortOrder: 0, imageUrl: '/display-slides/a.png' }),
        slide({ slideId: 'b', sortOrder: 1, imageUrl: '/display-slides/b.png' }),
      ],
      settings: undefined,
    });

    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
    expect(body.slides.map((s: any) => s.imageUrl)).toEqual([
      'https://signed.example/one', 'https://signed.example/two',
    ]);
    expect(mockGetSignedUrl.mock.calls.map((c) => c[1].Key))
      .toEqual(['display-slides/a.png', 'display-slides/b.png']);
  });

  it('returns only slideId, imageUrl and title', async () => {
    stage({ slides: [slide({ createdBy: 'Admin', PK: 'DISPLAY_SLIDE#slide-1' })], settings: undefined });
    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);
    expect(Object.keys(body.slides[0]).sort()).toEqual(['imageUrl', 'slideId', 'title']);
  });
});

describe('GET /api/display/slides — displayMode and the fallback video', () => {
  it('reads both from the SETTINGS/CONFIG record', async () => {
    stage({
      slides: [],
      settings: {
        PK: 'SETTINGS', SK: 'CONFIG',
        displayMode: 'video',
        displayFallbackVideoUrl: 'https://youtube.example/watch?v=abc',
      },
    });

    const res = await handleDisplay(makeEvent(SLIDES_EVENT));
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.displayMode).toBe('video');
    expect(body.fallbackVideoUrl).toBe('https://youtube.example/watch?v=abc');

    const get = cmds().find((c) => c.__cmd === 'Get');
    expect(get.TableName).toBe('test-settings');
    expect(get.Key).toEqual({ PK: 'SETTINGS', SK: 'CONFIG' });
  });

  it('defaults to slides mode and an empty video URL when the record has neither field', async () => {
    stage({ slides: [], settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN' } });
    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);
    expect(body.displayMode).toBe('slides');
    expect(body.fallbackVideoUrl).toBe('');
  });

  it('defaults when there is no settings record at all', async () => {
    // `Item` absent entirely — the optional-chain arm, distinct from a record
    // that exists but carries neither display field.
    stage({ slides: [], settings: undefined });
    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);
    expect(body.displayMode).toBe('slides');
    expect(body.fallbackVideoUrl).toBe('');
  });

  it('still returns 200 with defaults when the settings read FAILS', async () => {
    // The settings read is non-critical and caught locally. A settings blip must
    // degrade to slides mode, not blank the TV with a 500.
    stage({ slides: [slide()], settingsThrows: true });

    const res = await handleDisplay(makeEvent(SLIDES_EVENT));
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.displayMode).toBe('slides');
    expect(body.fallbackVideoUrl).toBe('');
    // The slides themselves survived — the failure was after they were built.
    expect(body.slides).toHaveLength(1);
    expect(body.slides[0].imageUrl).toBe('https://signed.example/url');
  });

  it('returns exactly the three top-level keys the display page reads', async () => {
    stage({ slides: [], settings: undefined });
    const body = JSON.parse((await handleDisplay(makeEvent(SLIDES_EVENT))).body);
    expect(Object.keys(body).sort()).toEqual(['displayMode', 'fallbackVideoUrl', 'slides']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Dispatch misses and failures
// ══════════════════════════════════════════════════════════════════════════════

describe('handleDisplay — 404 and 500', () => {
  it.each([
    ['an unknown display path', { path: '/api/display/nonsense' }],
    ['POST to the orders path', { httpMethod: 'POST', path: '/api/display/orders' }],
    ['PUT to the slides path', { httpMethod: 'PUT', path: '/api/display/slides' }],
    ['a trailing slash', { path: '/api/display/orders/' }],
  ])('returns 404 for %s and touches the database not at all', async (_name, overrides) => {
    stage({});
    const res = await handleDisplay(makeEvent(overrides));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('returns 500 with the error message when the orders query fails', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));

    const res = await handleDisplay(makeEvent());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'ProvisionedThroughputExceeded' });
  });

  it('returns 500 when the slides scan fails', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockImplementation(async (cmd: any) => {
      if (cmd.__cmd === 'Scan') throw new Error('scan exploded');
      return {};
    });

    const res = await handleDisplay(makeEvent(SLIDES_EVENT));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('scan exploded');
  });

  it('returns 500 when signing fails — a presigner error is not swallowed', async () => {
    stage({ slides: [slide()], settings: undefined });
    mockGetSignedUrl.mockRejectedValue(new Error('no credentials'));

    const res = await handleDisplay(makeEvent(SLIDES_EVENT));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('no credentials');
  });

  it('falls back to a generic message when the thrown value is not an Error', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue('a bare string');

    const res = await handleDisplay(makeEvent());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal error' });
  });

  it('always answers with a JSON content type', async () => {
    stage({ readyOrders: [] });
    const ok = await handleDisplay(makeEvent());
    const missing = await handleDisplay(makeEvent({ path: '/api/display/nope' }));
    expect(ok.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(missing.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// FRONTEND_BUCKET unconfigured — needs its own module instance
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/display/slides — FRONTEND_BUCKET not configured', () => {
  let handleDisplayNoBucket: (event: any) => Promise<any>;

  beforeAll(() => {
    // `BUCKET` is captured at import time, so the env change only takes effect
    // for a freshly loaded copy of the module.
    jest.resetModules();
    delete process.env.FRONTEND_BUCKET;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    handleDisplayNoBucket = require('../src/routes/display').handleDisplay;
  });

  afterAll(() => {
    process.env.FRONTEND_BUCKET = BUCKET_NAME;
    jest.resetModules();
  });

  it('returns a null-ish (empty) imageUrl and signs nothing', async () => {
    stage({ slides: [slide()], settings: undefined });

    const res = await handleDisplayNoBucket(makeEvent(SLIDES_EVENT));
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.slides).toHaveLength(1);
    expect(body.slides[0].imageUrl).toBe('');
    expect(body.slides[0].slideId).toBe('slide-1');
    expect(body.slides[0].title).toBe('Free refills');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('still reports displayMode and the fallback video — the video path needs no bucket', async () => {
    stage({
      slides: [slide()],
      settings: { PK: 'SETTINGS', SK: 'CONFIG', displayMode: 'video', displayFallbackVideoUrl: 'https://youtube.example/v' },
    });

    const body = JSON.parse((await handleDisplayNoBucket(makeEvent(SLIDES_EVENT))).body);

    expect(body.displayMode).toBe('video');
    expect(body.fallbackVideoUrl).toBe('https://youtube.example/v');
  });

  it('still serves the orders route normally', async () => {
    stage({ readyOrders: [{ orderId: 'o1', customerName: 'A', readyAt: '2026-08-16T02:00:00.000Z' }] });
    const res = await handleDisplayNoBucket(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).orders).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
