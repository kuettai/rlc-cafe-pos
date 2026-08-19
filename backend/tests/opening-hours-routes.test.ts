/**
 * Opening times over the wire — the two routes that read and write them.
 *
 *  - `GET /api/cafe/status`  (`backend/src/routes/cafe.ts`) — PUBLIC, and now the
 *    single source of truth the customer closed screen reads its times from.
 *  - `PUT /api/admin/settings` (`backend/src/routes/admin.ts`) — the write path,
 *    which must validate BEFORE its `UpdateCommand` and persist the NORMALISED
 *    value.
 *
 * Neither route had a suite of its own, so this is a new feature-named suite in
 * the style of `item-notes.test.ts` / `preorder-collection-time.test.ts` rather
 * than a `cafe.test.ts` / `admin.test.ts` split. No new endpoint was added, so
 * `router.test.ts` needs no new dispatch case — both paths were already
 * registered and covered there.
 *
 * Every assertion is on what the HANDLER produced: the parsed response body it
 * returned, or the `ExpressionAttributeValues` of the `UpdateCommand` it built.
 * Never on the fixture object the test itself constructed.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked; the S3 client `admin.ts` constructs at import time is mocked too.
 * No network, no credentials, nothing written to production — so no `ZZTEST_`
 * marker applies (that rule covers suites that create real records).
 *
 * The clock is pinned with `jest.setSystemTime` for the cafe route, because
 * `handleCafe` calls `describeOpeningState(openingHours)` with no `now` — a
 * request handler's "now" genuinely is the wall clock, so the test has to own the
 * wall clock.
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
const { handleCafe } = require('../src/routes/cafe');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleAdmin } = require('../src/routes/admin');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEFAULT_OPENING_HOURS } = require('../src/lib/opening-hours');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** 09:50 Sunday MYT — 25 minutes before the first session opens. */
const SUNDAY_0950_MYT = new Date('2026-08-16T01:50:00Z');
/** 15:00 Sunday MYT — past the last session of the day. */
const SUNDAY_1500_MYT = new Date('2026-08-16T07:00:00Z');
/** 12:00 Wednesday MYT — not a service day at all. */
const WEDNESDAY_NOON_MYT = new Date('2026-08-19T04:00:00Z');

const STORED_HOURS = {
  serviceDays: [0],
  sessions: [
    { label: 'After 1st service', opensAt: '09:30', closesAt: '10:30' },
    { label: 'After 2nd service', opensAt: '11:45', closesAt: '12:30' },
  ],
};

const LATTE = {
  PK: 'MENU#latte-001', SK: 'META', menuItemId: 'latte-001', name: 'Latte',
  category: 'DRINK', basePrice: 8, imageUrl: 'https://example.invalid/latte.png',
};

/**
 * Answer every read from a described world, keyed on the actual `TableName` and
 * command the handler asked for — not a `mockResolvedValueOnce` queue, which
 * would let a fixture silently fill the wrong slot (`invariants`, Test teeth).
 * `handleCafe` issues up to three reads: settings Get, PREPARING Query, menu Get.
 */
function stage(world: {
  settings?: Record<string, unknown> | undefined;
  preparingCount?: number;
  menu?: Record<string, unknown>;
}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Get' && cmd.TableName === 'test-settings') {
      return world.settings === undefined ? {} : { Item: world.settings };
    }
    if (cmd.__cmd === 'Query' && cmd.TableName === 'test-orders') {
      const count = world.preparingCount ?? 0;
      return { Items: new Array(count).fill({ status: 'PREPARING' }), Count: count };
    }
    if (cmd.__cmd === 'Get' && cmd.TableName === 'test-menu') {
      const rec = world.menu?.[String(cmd.Key?.PK || '')];
      return rec ? { Item: rec } : {};
    }
    return {};
  });
}

function cafeEvent(): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET', path: '/api/cafe/status', body: null,
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
  } as unknown as APIGatewayProxyEvent;
}

function settingsPutEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'PUT', path: '/api/admin/settings', body: JSON.stringify(body),
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
  } as unknown as APIGatewayProxyEvent;
}

/** The parsed body the handler actually returned. */
async function getCafeStatus(): Promise<any> {
  const res = await handleCafe(cafeEvent());
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function settingsUpdates() {
  return cmds().filter((c) => c.__cmd === 'Update' && c.TableName === 'test-settings');
}

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.setSystemTime(SUNDAY_0950_MYT);
  mockDbSend.mockReset();
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/cafe/status — the read
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/cafe/status — openingHours from the stored record', () => {
  it('returns the STORED opening hours and the state derived from them', async () => {
    stage({
      settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN', openingHours: STORED_HOURS },
    });

    const body = await getCafeStatus();

    expect(body.openingHours).toEqual(STORED_HOURS);
    // Derived from the STORED 09:30–10:30 session, not the default 10:15 — at
    // 09:50 MYT the default would say "opens in 25 minutes"; the stored schedule
    // says the first session is in progress and 11:45 is the next opening.
    expect(body.openingState.phase).toBe('WITHIN_SESSION');
    expect(body.openingState.currentSessionLabel).toBe('After 1st service');
    expect(body.openingState.currentSessionClosesLabel).toBe('10:30 AM');
    expect(body.openingState.nextOpenTimeLabel).toBe('11:45 AM');
    expect(body.openingState.nextOpenAt).toBe('2026-08-16T03:45:00.000Z');
    expect(body.openingState.opensLaterToday).toBe(true);
  });

  it('NORMALISES the stored value in the response (days sorted, labels trimmed)', async () => {
    stage({
      settings: {
        PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'CLOSED',
        openingHours: {
          serviceDays: [3, 0],
          sessions: [{ label: '  After 1st service  ', opensAt: '10:15', closesAt: '11:30' }],
        },
      },
    });

    const body = await getCafeStatus();

    expect(body.openingHours).toEqual({
      serviceDays: [0, 3],
      sessions: [{ label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' }],
    });
    expect(body.openingState.serviceDaysLabel).toBe('Sundays & Wednesdays');
  });

  it('falls back to DEFAULT_OPENING_HOURS when the attribute is ABSENT', async () => {
    // This is the state of EVERY settings record in production today — the
    // attribute is new and no admin has saved one — so it is the case that has
    // to work, not an edge case.
    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'CLOSED', celebrationMode: true } });

    const body = await getCafeStatus();

    expect(body.openingHours).toEqual(DEFAULT_OPENING_HOURS);
    expect(body.openingState).toEqual({
      phase: 'BEFORE_FIRST_TODAY',
      opensLaterToday: true,
      nextOpenAt: '2026-08-16T02:15:00.000Z',
      minutesUntilNextOpen: 25,
      nextOpenTimeLabel: '10:15 AM',
      nextOpenDayLabel: 'today',
      nextServiceSessionsLabel: '10:15 AM & 12:45 PM, after each service',
      serviceDaysLabel: 'Sundays',
      currentSessionLabel: null,
      currentSessionClosesLabel: null,
    });
  });

  it('falls back to the default when there is no settings record at all', async () => {
    stage({ settings: undefined });
    const body = await getCafeStatus();
    expect(body.openingHours).toEqual(DEFAULT_OPENING_HOURS);
    expect(body.openingState.nextOpenTimeLabel).toBe('10:15 AM');
  });

  it('falls back to the default LOUDLY when the stored value is invalid', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      stage({
        settings: {
          PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN',
          openingHours: { serviceDays: [0], sessions: [{ label: 'Broken', opensAt: '10:15', closesAt: '09:00' }] },
        },
      });

      const body = await getCafeStatus();

      expect(body.openingHours).toEqual(DEFAULT_OPENING_HOURS);
      expect(body.openingState.nextOpenTimeLabel).toBe('10:15 AM');
      // A silently-degrading feature is a defect; the customer-facing response
      // stays minimal but the log has to name the problem.
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain('closesAt (09:00) must be after opensAt (10:15)');
      expect(body.error).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the MYT day-of-week: 00:30 Sunday MYT (Saturday in UTC) still opens today', async () => {
    jest.setSystemTime(new Date('2026-08-15T16:30:00Z'));
    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'CLOSED' } });

    const body = await getCafeStatus();

    expect(body.openingState.phase).toBe('BEFORE_FIRST_TODAY');
    expect(body.openingState.opensLaterToday).toBe(true);
    expect(body.openingState.nextOpenDayLabel).toBe('today');
  });
});

describe('GET /api/cafe/status — the five pre-existing fields still ship', () => {
  // This endpoint is PUBLIC and `frontend/js/app.js` reads all five. Adding two
  // attributes must not drop or rename any of them.
  it('returns cafeStatus, queueSize, celebrationMode, celebrationPrice and featuredDrink', async () => {
    stage({
      settings: {
        PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN',
        celebrationMode: true, celebrationPrice: 6,
        featuredDrinkId: 'latte-001',
        openingHours: STORED_HOURS,
      },
      preparingCount: 3,
      menu: { 'MENU#latte-001': LATTE },
    });

    const body = await getCafeStatus();

    expect(Object.keys(body).sort()).toEqual([
      'cafeStatus', 'celebrationMode', 'celebrationPrice', 'featuredDrink',
      'openingHours', 'openingState', 'queueSize',
    ]);
    expect(body.cafeStatus).toBe('OPEN');
    expect(body.queueSize).toBe(3);
    expect(body.celebrationMode).toBe(true);
    expect(body.celebrationPrice).toBe(6);
    expect(body.featuredDrink).toEqual({
      menuItemId: 'latte-001', name: 'Latte', basePrice: 8,
      imageUrl: 'https://example.invalid/latte.png', category: 'DRINK',
    });
  });

  it('keeps the pre-existing defaults when the settings record is empty', async () => {
    stage({ settings: undefined, preparingCount: 0 });
    const body = await getCafeStatus();
    expect(body.cafeStatus).toBe('CLOSED');
    expect(body.celebrationMode).toBe(false);
    expect(body.celebrationPrice).toBe(5);
    expect(body.featuredDrink).toBeNull();
    expect(body.queueSize).toBe(0);
  });

  it('does not look up a featured drink when none is configured', async () => {
    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN' } });
    await getCafeStatus();
    expect(cmds().filter((c) => c.TableName === 'test-menu')).toHaveLength(0);
  });

  it('does not write anything — the status read is a read', async () => {
    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN' } });
    await getCafeStatus();
    expect(cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd))).toHaveLength(0);
  });
});

describe('GET /api/cafe/status — openingHours is DESCRIPTIVE and must NEVER gate ordering', () => {
  // ⚠️ THESE TESTS ARE MEANT TO SHOW THE TWO FIELDS DISAGREEING. That is the
  // invariant, not a bug: `cafeStatus` — flipped by a human in the POS — is the
  // ONLY thing that decides whether an order is accepted. If someone "improves"
  // the handler to report CLOSED outside the configured sessions, a service that
  // starts late, runs long, or is a one-off event locks real customers out of a
  // café whose door is open and whose volunteers are behind the counter.
  //
  // Do not "fix" these by aligning the two fields. See the header of
  // `backend/src/lib/opening-hours.ts`.

  it('stays OPEN on a WEDNESDAY, outside every configured session', async () => {
    jest.setSystemTime(WEDNESDAY_NOON_MYT);
    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN' } });

    const body = await getCafeStatus();

    expect(body.cafeStatus).toBe('OPEN');            // the human's decision
    expect(body.openingState.phase).toBe('NOT_SERVICE_DAY');
    expect(body.openingState.opensLaterToday).toBe(false); // the schedule's opinion
  });

  it('stays OPEN at 15:00 Sunday MYT, after the last session closed', async () => {
    jest.setSystemTime(SUNDAY_1500_MYT);
    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN' } });

    const body = await getCafeStatus();

    expect(body.cafeStatus).toBe('OPEN');
    expect(body.openingState.phase).toBe('AFTER_LAST_TODAY');
    expect(body.openingState.opensLaterToday).toBe(false);
  });

  it('stays OPEN at 09:50 Sunday MYT — the volunteer opened BEFORE the scheduled time', async () => {
    // The other direction, and the one that actually happens: the café opened
    // early. The schedule still says "opens in 25 minutes"; ordering is open
    // regardless, because a human said so.
    jest.setSystemTime(SUNDAY_0950_MYT);
    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN' } });

    const body = await getCafeStatus();

    expect(body.cafeStatus).toBe('OPEN');
    expect(body.openingState.opensLaterToday).toBe(true);
    expect(body.openingState.phase).toBe('BEFORE_FIRST_TODAY');
  });

  it('reports CLOSED while WITHIN_SESSION — volunteers late to open, or closed early', async () => {
    // The case `WITHIN_SESSION` was added for, and the sharpest illustration that
    // the two fields are independent: the schedule says the café should be
    // serving right now, and the counter is shut. The payload cannot tell
    // late-to-open from closed-early apart, which is exactly why it reports the
    // SCHEDULE (`currentSessionClosesLabel`) and leaves `cafeStatus` to say what
    // is actually true. Nothing may infer "running late" from this.
    jest.setSystemTime(new Date('2026-08-16T02:20:00Z')); // 10:20 Sunday MYT
    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'CLOSED' } });

    const body = await getCafeStatus();

    expect(body.cafeStatus).toBe('CLOSED');
    expect(body.openingState.phase).toBe('WITHIN_SESSION');
    expect(body.openingState.currentSessionLabel).toBe('After 1st service');
    expect(body.openingState.currentSessionClosesLabel).toBe('11:30 AM');
  });

  it('stays CLOSED at 09:50 Sunday MYT even though it opens in 25 minutes', async () => {
    // The mirror: the schedule says "opening soon", the human has not opened yet.
    // `cafeStatus` must not be promoted to OPEN by the clock either.
    jest.setSystemTime(SUNDAY_0950_MYT);
    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'CLOSED' } });

    const body = await getCafeStatus();

    expect(body.cafeStatus).toBe('CLOSED');
    expect(body.openingState.opensLaterToday).toBe(true);
    expect(body.openingState.minutesUntilNextOpen).toBe(25);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/admin/settings — the write
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/admin/settings — a malformed openingHours writes NOTHING', () => {
  beforeEach(() => {
    // Reads are irrelevant here; the point is whether a write is issued at all.
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
  });

  it.each([
    [
      'sessions missing',
      { serviceDays: [0] },
      'openingHours.sessions must be an array of sessions',
    ],
    [
      'an empty sessions array',
      { serviceDays: [0], sessions: [] },
      'openingHours.sessions must list at least one session',
    ],
    [
      'day 7',
      { serviceDays: [7], sessions: [{ label: 'x', opensAt: '10:15', closesAt: '11:30' }] },
      'openingHours.serviceDays values must be between 0 (Sunday) and 6 (Saturday)',
    ],
    [
      'a duplicated day',
      { serviceDays: [0, 0], sessions: [{ label: 'x', opensAt: '10:15', closesAt: '11:30' }] },
      'openingHours.serviceDays lists Sunday more than once',
    ],
    [
      'a badly formatted opensAt',
      { serviceDays: [0], sessions: [{ label: 'x', opensAt: '9:5', closesAt: '11:30' }] },
      'Session 1 ("x"): opensAt must be a 24-hour time like "10:15"',
    ],
    [
      'closesAt before opensAt',
      { serviceDays: [0], sessions: [{ label: 'x', opensAt: '11:30', closesAt: '10:15' }] },
      'Session 1 ("x"): closesAt (10:15) must be after opensAt (11:30)',
    ],
    [
      'an empty label',
      { serviceDays: [0], sessions: [{ label: '  ', opensAt: '10:15', closesAt: '11:30' }] },
      'Session 1: label cannot be empty',
    ],
    [
      'a 41-character label',
      { serviceDays: [0], sessions: [{ label: 'z'.repeat(41), opensAt: '10:15', closesAt: '11:30' }] },
      'Session 1: label cannot exceed 40 characters',
    ],
    ['not an object', 'Sundays 10:15am', 'openingHours must be an object'],
    ['an explicit null', null, 'openingHours must be an object'],
  ])('rejects %s with 400 and the validator\'s own message', async (_name, openingHours, expected) => {
    const res = await handleAdmin(settingsPutEvent({ openingHours }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: expected });
    // "No error thrown" is not an assertion. The write must not have happened —
    // validation sits BEFORE the UpdateCommand precisely so a rejected value
    // leaves the stored record untouched.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects the whole request, not just the bad key — good siblings are not written either', async () => {
    const res = await handleAdmin(settingsPutEvent({
      celebrationMode: true,
      celebrationPrice: 6,
      openingHours: { serviceDays: [0], sessions: [] },
    }));

    expect(res.statusCode).toBe(400);
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

describe('PUT /api/admin/settings — a valid openingHours is persisted NORMALISED', () => {
  beforeEach(() => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
  });

  it('writes sorted days, trimmed labels and only the three known session keys', async () => {
    const res = await handleAdmin(settingsPutEvent({
      openingHours: {
        serviceDays: [3, 0],
        sessions: [
          { label: '  After 1st service  ', opensAt: '10:15', closesAt: '11:30', colour: 'red' },
          { label: 'After 2nd service', opensAt: '12:45', closesAt: '13:30' },
        ],
      },
    }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ updated: ['openingHours'] });

    const updates = settingsUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].UpdateExpression).toContain('#openingHours = :openingHours');
    expect(updates[0].ExpressionAttributeNames['#openingHours']).toBe('openingHours');
    // The NORMALISED value, not the raw body — asserted on what the handler
    // built, not on the object this test passed in.
    expect(updates[0].ExpressionAttributeValues[':openingHours']).toEqual({
      serviceDays: [0, 3],
      sessions: [
        { label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' },
        { label: 'After 2nd service', opensAt: '12:45', closesAt: '13:30' },
      ],
    });
    expect(Object.keys(updates[0].ExpressionAttributeValues[':openingHours'].sessions[0]).sort())
      .toEqual(['closesAt', 'label', 'opensAt']);
    expect(updates[0].Key).toEqual({ PK: 'SETTINGS', SK: 'CONFIG' });
  });

  it('writes openingHours alongside the other settings keys in one UpdateCommand', async () => {
    const res = await handleAdmin(settingsPutEvent({
      cafeStatus: 'OPEN',
      celebrationMode: false,
      openingHours: { serviceDays: [0], sessions: [{ label: 'Only', opensAt: '10:15', closesAt: '11:30' }] },
    }));

    expect(res.statusCode).toBe(200);
    const updates = settingsUpdates();
    expect(updates).toHaveLength(1);
    for (const key of ['cafeStatus', 'celebrationMode', 'openingHours']) {
      expect(updates[0].UpdateExpression).toContain(`#${key} = :${key}`);
    }
    expect(updates[0].ExpressionAttributeValues[':cafeStatus']).toBe('OPEN');
    expect(updates[0].ExpressionAttributeValues[':openingHours'].sessions[0].label).toBe('Only');
  });

  it('leaves a body with NO openingHours completely alone (the guard is presence-gated)', async () => {
    const res = await handleAdmin(settingsPutEvent({ celebrationMode: true, celebrationPrice: 7 }));

    expect(res.statusCode).toBe(200);
    const updates = settingsUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].ExpressionAttributeValues).toEqual({
      ':celebrationMode': true, ':celebrationPrice': 7,
    });
    expect(updates[0].ExpressionAttributeValues[':openingHours']).toBeUndefined();
  });

  it('round-trips: what the write path stores is what the read path returns', async () => {
    // The single-source-of-truth claim, end to end. Persist a value through the
    // admin route, then hand exactly that stored attribute to the public route.
    await handleAdmin(settingsPutEvent({
      openingHours: {
        serviceDays: [6, 0],
        sessions: [{ label: '  Weekend brew  ', opensAt: '09:30', closesAt: '10:30' }],
      },
    }));
    const persisted = settingsUpdates()[0].ExpressionAttributeValues[':openingHours'];

    stage({ settings: { PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN', openingHours: persisted } });
    const body = await getCafeStatus();

    expect(body.openingHours).toEqual({
      serviceDays: [0, 6],
      sessions: [{ label: 'Weekend brew', opensAt: '09:30', closesAt: '10:30' }],
    });
    // And no warning: the stored value is already in the normalised shape the
    // reader expects, which is the reason the write path normalises at all.
    expect(body.openingState.serviceDaysLabel).toBe('Sundays & Saturdays');
  });
});
