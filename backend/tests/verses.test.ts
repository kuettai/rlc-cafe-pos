/**
 * `GET /api/verses/random` (`backend/src/routes/verses.ts`) — the daily Bible
 * verse the customer screen shows.
 *
 * Small handler, three things worth pinning:
 *
 * 1. **An empty pool is a 200, not a 404 or a throw.** The customer screen calls
 *    this on every load; a café that has no verses configured (or has
 *    deactivated all of them) must get `{ verse: null }` so the screen simply
 *    omits the panel. A 4xx/5xx here would surface as an error toast on a
 *    working café.
 * 2. **The Scan is filtered to ACTIVE verses only** — `isActive = :active`, with
 *    the `BIBLE_VERSE#` PK prefix. A deactivated verse is an admin's decision to
 *    stop showing something; if the filter were dropped it would keep appearing.
 * 3. **Only `text` and `reference` are projected.** The stored record carries
 *    `PK`/`SK`/`isActive`/`createdBy`; this is a PUBLIC unauthenticated
 *    endpoint, so the response is built field by field rather than spread.
 *
 * The random pick is made deterministic with `jest.spyOn(Math, 'random')` — the
 * handler's own index arithmetic is then asserted, rather than "some verse came
 * back", which would pass for an off-by-one that never reaches the last verse.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked here: no network, no credentials, nothing written to production,
 * so no `ZZTEST_` marker applies (that rule covers suites that create real
 * records).
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleVerses } = require('../src/routes/verses');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Shape as stored: more attributes than the response is allowed to carry. */
function verseRecord(id: string, text: string, reference: string) {
  return {
    PK: `BIBLE_VERSE#${id}`, SK: 'META', verseId: id,
    text, reference, isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'Admin',
  };
}

const JOHN = verseRecord('v1', 'For God so loved the world.', 'John 3:16');
const PSALM = verseRecord('v2', 'The Lord is my shepherd.', 'Psalm 23:1');
const PHIL = verseRecord('v3', 'I can do all things through Christ.', 'Philippians 4:13');

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET', path: '/api/verses/random', body: null,
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

/**
 * Answer the Scan from a described world, keyed on the command and table the
 * handler actually asked for — not a `mockResolvedValueOnce` queue, which would
 * let a fixture fill the wrong slot (`invariants`, Test teeth).
 */
function stage(world: { verses?: Record<string, unknown>[] }) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-settings') {
      // `verses: undefined` means "the SDK returned no Items key at all".
      return world.verses === undefined ? {} : { Items: world.verses };
    }
    return {};
  });
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }

beforeEach(() => {
  mockDbSend.mockReset();
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/verses/random — the empty pool
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/verses/random — no verses to show', () => {
  it('returns 200 with verse: null when the scan finds nothing', async () => {
    stage({ verses: [] });

    const result = await handleVerses(makeEvent());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ verse: null });
  });

  it('returns 200 with verse: null when the scan returns no Items key at all', async () => {
    // `result.Items || []` — the right-hand side. A DocumentClient Scan that
    // matches nothing may omit `Items` entirely, and `.length` on undefined
    // would be a 500 on the public customer screen.
    stage({ verses: undefined });

    const result = await handleVerses(makeEvent());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ verse: null });
  });

  it('sets a JSON content type on the empty response too', async () => {
    stage({ verses: [] });
    const result = await handleVerses(makeEvent());
    expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/verses/random — the populated pool
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/verses/random — picking a verse', () => {
  it('returns the only verse when the pool has one', async () => {
    stage({ verses: [JOHN] });

    const result = await handleVerses(makeEvent());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      verse: { text: 'For God so loved the world.', reference: 'John 3:16' },
    });
  });

  it('projects ONLY text and reference — no PK, SK, isActive or createdBy leaks', async () => {
    // Public unauthenticated endpoint: the response shape is the contract.
    stage({ verses: [PSALM] });

    const result = await handleVerses(makeEvent());
    const body = JSON.parse(result.body);

    expect(Object.keys(body)).toEqual(['verse']);
    expect(Object.keys(body.verse).sort()).toEqual(['reference', 'text']);
  });

  it.each([
    ['0 picks the FIRST verse', 0, 'John 3:16'],
    ['0.32 is still inside the first third', 0.32, 'John 3:16'],
    ['0.34 has crossed into the second third', 0.34, 'Psalm 23:1'],
    ['0.5 picks the MIDDLE verse', 0.5, 'Psalm 23:1'],
    ['0.67 has crossed into the last third', 0.67, 'Philippians 4:13'],
    ['0.999 picks the LAST verse — the last entry is reachable', 0.999, 'Philippians 4:13'],
  ])('Math.random() = %s', async (_name, roll, expectedReference) => {
    // Pinning the roll asserts the handler's own index arithmetic. Without the
    // 0.999 case an off-by-one that can never return the last verse — the exact
    // shape of `Math.floor(r * len) - 1` or a `len - 1` cap — would still pass.
    const random = jest.spyOn(Math, 'random').mockReturnValue(roll as number);
    try {
      stage({ verses: [JOHN, PSALM, PHIL] });

      const result = await handleVerses(makeEvent());

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).verse.reference).toBe(expectedReference);
    } finally {
      random.mockRestore();
    }
  });

  it('scans the SETTINGS table filtered to ACTIVE BIBLE_VERSE# records', async () => {
    // The filter is the whole reason an admin can deactivate a verse.
    stage({ verses: [JOHN] });

    await handleVerses(makeEvent());

    const scans = cmds().filter((c) => c.__cmd === 'Scan');
    expect(scans).toHaveLength(1);
    expect(scans[0].TableName).toBe('test-settings');
    expect(scans[0].FilterExpression).toBe('begins_with(PK, :prefix) AND isActive = :active');
    expect(scans[0].ExpressionAttributeValues).toEqual({
      ':prefix': 'BIBLE_VERSE#', ':active': true,
    });
  });

  it('does not write anything — reading a verse is a read', async () => {
    stage({ verses: [JOHN, PSALM] });

    await handleVerses(makeEvent());

    expect(cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd))).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Everything else on /api/verses is a 404
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/verses/random — the 404 branch', () => {
  it.each([
    ['a wrong method on the right path', { httpMethod: 'POST' }],
    ['a wrong method that would otherwise write', { httpMethod: 'DELETE' }],
    ['the collection path', { path: '/api/verses' }],
    ['a trailing slash', { path: '/api/verses/random/' }],
    ['an unknown sub-path', { path: '/api/verses/next' }],
    // `index.ts:108` dispatches on `startsWith('/api/verses')`, so a
    // near-miss prefix reaches this handler rather than the router's own 404.
    ['a near-miss prefix', { path: '/api/versess/random' }],
  ])('404s on %s, and issues no query', async (_name, overrides) => {
    mockDbSend.mockResolvedValue({});

    const result = await handleVerses(makeEvent(overrides as Partial<APIGatewayProxyEvent>));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: 'Not found' });
    // A 404 that still scanned would be a wasted read on every stray request.
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});
