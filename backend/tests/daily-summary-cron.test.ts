/**
 * The end-of-day revenue summary is a CRON job, not a side effect of Close Café.
 *
 * It used to be `sendDailySummaryEmail().catch(() => {})` at the end of
 * `closeCafe` — un-awaited, fired after the handler had already returned its
 * 200. Lambda freezes the execution environment at that point, so the promise
 * only advanced if that same sandbox was thawed by a later request. Proven from
 * production CloudWatch:
 *
 *   2026-08-02  close 06:40:17Z  → [EMAIL] Sent 06:41:07Z  (+50s)
 *   2026-08-09  close 05:39:50Z  → [EMAIL] Sent 05:44:30Z  (+4m39s)
 *   2026-08-16  close 06:00:56Z  → nothing, ever. Sandbox reaped 0.78s later.
 *
 * On both surviving days the `[EMAIL] Sent` line was attributed to a DIFFERENT
 * request id than the close and timestamped after that request's REPORT.
 *
 * These tests pin the replacement: the cron sends it, exactly once per service
 * date, only after the café is closed, and it never fails silently.
 */

const mockDbSend = jest.fn();
const mockSendEndOfDaySummary = jest.fn();
const mockSendLowStockAlert = jest.fn();

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
  TransactWriteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'TransactWrite' })),
}));

jest.mock('../src/lib/email', () => ({
  sendEndOfDaySummary: (...args: any[]) => mockSendEndOfDaySummary(...args),
  sendLowStockAlert: (...args: any[]) => mockSendLowStockAlert(...args),
}));

jest.mock('../src/routes/customers', () => ({
  linkOrderToCustomer: jest.fn().mockResolvedValue(undefined),
  handleCustomers: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../src/expiry');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePos } = require('../src/routes/pos');

// ---------------------------------------------------------------------------
// Time. 2026-08-16T06:00:00Z is 2pm MYT on a Sunday — the real instant the café
// closed on the Sunday the email went missing (production logs for that run
// recorded `[checkLowStock] day=0 hour=14`), so the gates see a genuine service.
// ---------------------------------------------------------------------------
const SUNDAY_2PM_MYT = new Date('2026-08-16T06:00:00.000Z');
const SUNDAY_1PM_MYT = new Date('2026-08-16T05:00:00.000Z');
const WEDNESDAY_NOON_MYT = new Date('2026-08-19T04:00:00.000Z');
// A non-Sunday instant that is PAST 2pm MYT, so it clears the hour gate and can
// only be stopped by the day-of-week gate. Without this the Wednesday case was
// caught by `hour < 14` and the Sunday gate was never actually exercised.
const WEDNESDAY_3PM_MYT = new Date('2026-08-19T07:00:00.000Z');
const TODAY_MYT = '2026-08-16';

const event = {} as any;

interface World {
  cafeStatus?: string;
  /** Persisted DAILY_SUMMARY#<date> marker, keyed by PK. */
  markers: Record<string, any>;
  soldOrders: any[];
  ingredients: any[];
}

let world: World;

/**
 * A shape-routing DynamoDB mock rather than a positional
 * `mockResolvedValueOnce` chain: the handler makes a dozen calls across four
 * sub-tasks, and positional staging silently mis-aligns the moment any of them
 * changes. This also PERSISTS the summary marker, so "the second run does not
 * re-send" exercises the real Put → Get round trip.
 */
function installWorld(overrides: Partial<World> = {}) {
  world = {
    cafeStatus: 'CLOSED',
    markers: {},
    soldOrders: [],
    ingredients: [],
    ...overrides,
  };

  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Get' && cmd.TableName === 'test-settings') {
      const pk = cmd.Key.PK;
      const sk = cmd.Key.SK;
      if (pk === 'SETTINGS' && sk === 'CONFIG') return { Item: { cafeStatus: world.cafeStatus, archiveAfterMinutes: 15 } };
      // SK is honoured, not ignored: a real Get with the wrong sort key finds
      // nothing, and a mock that shrugged that off would let a broken marker
      // key through as though dedup still worked.
      if (pk.startsWith('DAILY_SUMMARY#')) return sk === 'META' ? { Item: world.markers[pk] } : {};
      // Keep checkLowStock out of the way: it sees "already sent today" and
      // returns before its own ingredient Scan, so the only Scan below is the
      // summary's.
      if (pk.startsWith('LOW_STOCK_ALERT#')) return { Item: { lastSent: '2026-08-16T05:00:00.000Z' } };
      return {};
    }
    if (cmd.__cmd === 'Put' && cmd.TableName === 'test-settings') {
      world.markers[cmd.Item.PK] = cmd.Item;
      return {};
    }
    // Only the summary's order queries are date-bounded; every other Query in
    // the handler (order expiry, auto-archive, pre-order sweep) gets nothing.
    if (cmd.__cmd === 'Query') {
      if (cmd.KeyConditionExpression?.includes('createdAt >= :today')) {
        const status = cmd.ExpressionAttributeValues[':s'];
        return { Items: world.soldOrders.filter((o: any) => o.status === status) };
      }
      return { Items: [] };
    }
    if (cmd.__cmd === 'Scan' && cmd.TableName === 'test-ingredients') {
      return { Items: world.ingredients };
    }
    return {};
  });
}

/**
 * Flatten a console spy's calls the way the runtime would render them —
 * `console.log('x: %s', true)` reaches CloudWatch as `x: true`, so asserting on
 * the raw args would miss the substitution.
 */
function rendered(spy: jest.SpyInstance): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { format } = require('util');
  return spy.mock.calls.map((c: any[]) => format(...c)).join('\n');
}

/** PKs of every DAILY_SUMMARY marker written during the test. */
function markerPuts(): string[] {
  return mockDbSend.mock.calls
    .filter((c) => c[0].__cmd === 'Put' && String(c[0].Item?.PK || '').startsWith('DAILY_SUMMARY#'))
    .map((c) => c[0].Item.PK);
}

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  jest.setSystemTime(SUNDAY_2PM_MYT);
  mockSendEndOfDaySummary.mockReset();
  mockSendEndOfDaySummary.mockResolvedValue(true);
  mockSendLowStockAlert.mockReset();
  mockSendLowStockAlert.mockResolvedValue(true);
  installWorld();
});

// ---------------------------------------------------------------------------

describe('sendDailySummary — the happy path', () => {
  it('sends the summary once the café is CLOSED and records the marker', async () => {
    installWorld({
      cafeStatus: 'CLOSED',
      soldOrders: [
        { status: 'ARCHIVED', totalAmount: 8, discountOffset: 0, items: [{ name: 'Latte', quantity: 2 }] },
        { status: 'ARCHIVED', totalAmount: 5, discountOffset: 3, items: [{ name: 'Curry Puff', quantity: 1 }] },
      ],
    });

    await handler(event);

    expect(mockSendEndOfDaySummary).toHaveBeenCalledTimes(1);
    const payload = mockSendEndOfDaySummary.mock.calls[0][0];
    // The MALAYSIAN date, not the UTC one.
    expect(payload.date).toBe(TODAY_MYT);
    expect(payload.totalOrders).toBe(2);
    expect(payload.totalRevenue).toBe(13);
    expect(payload.totalOffsets).toBe(3);
    // Marker written so no later run repeats it.
    expect(markerPuts()).toEqual([`DAILY_SUMMARY#${TODAY_MYT}`]);
  });

  it('bounds the day at MYT midnight expressed in UTC, not at the bare date', async () => {
    // `createdAt` is stored as a UTC ISO string. Malaysian Sunday 2026-08-16
    // began at 2026-08-15T16:00:00Z, so that is the only correct cutoff. Using
    // the bare '2026-08-16' would silently drop every order taken before 08:00
    // MYT — their createdAt still reads '2026-08-15T…'.
    installWorld({ cafeStatus: 'CLOSED' });

    await handler(event);

    const summaryQueries = mockDbSend.mock.calls
      .filter((c) => c[0].__cmd === 'Query' && c[0].KeyConditionExpression?.includes('createdAt >= :today'));
    expect(summaryQueries).toHaveLength(6); // one per status
    for (const c of summaryQueries) {
      expect(c[0].ExpressionAttributeValues[':today']).toBe('2026-08-15T16:00:00.000Z');
    }

    // An order placed at 07:30 MYT that Sunday sorts AFTER the cutoff, so it
    // is counted. Under the old bare-date cutoff it did not.
    expect('2026-08-15T23:30:00.000Z' >= '2026-08-15T16:00:00.000Z').toBe(true);
    // ...while late Saturday MYT still sorts before it.
    expect('2026-08-15T15:30:00.000Z' >= '2026-08-15T16:00:00.000Z').toBe(false);
  });
});

describe('the MYT date helpers the summary is built on', () => {
  // Honest scope note: within the cron's own gate (Malaysian Sunday, 2pm
  // onwards) the UTC and Malaysian dates are ALWAYS equal — MYT Sun 14:00–23:59
  // is UTC Sun 06:00–15:59 — so swapping `malaysiaToday()` for
  // `toISOString().split('T')[0]` inside `sendDailySummary` is unobservable
  // through the handler and no handler-level test can catch it. What is
  // observable, and what actually carried the bug, is the day boundary. Pin the
  // helpers directly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { malaysiaToday, malaysiaDayStartUtc } = require('../src/lib/date');

  it('rolls the Malaysian date over at 16:00Z, not at midnight UTC', () => {
    expect(malaysiaToday(new Date('2026-08-16T15:59:59Z'))).toBe('2026-08-16');
    expect(malaysiaToday(new Date('2026-08-16T16:00:00Z'))).toBe('2026-08-17');
  });

  it('starts a Malaysian day at 16:00Z the previous calendar day', () => {
    expect(malaysiaDayStartUtc('2026-08-16')).toBe('2026-08-15T16:00:00.000Z');
    expect(malaysiaDayStartUtc('2027-01-01')).toBe('2026-12-31T16:00:00.000Z');
  });

  it('composes so a late-evening MYT instant still bounds its own day', () => {
    // 2026-08-16T17:00Z is already Monday 01:00 MYT: the Malaysian day is the
    // 17th and it began at 16:00Z on the 16th.
    const t = new Date('2026-08-16T17:00:00Z');
    expect(malaysiaToday(t)).toBe('2026-08-17');
    expect(malaysiaDayStartUtc(malaysiaToday(t))).toBe('2026-08-16T16:00:00.000Z');
  });
});

describe('sendDailySummary — the gates', () => {
  it('does NOT send while cafeStatus is OPEN', async () => {
    installWorld({ cafeStatus: 'OPEN' });

    await handler(event);

    expect(mockSendEndOfDaySummary).not.toHaveBeenCalled();
    expect(markerPuts()).toEqual([]);
  });

  it('does NOT send when cafeStatus is missing entirely', async () => {
    installWorld({ cafeStatus: undefined });

    await handler(event);

    expect(mockSendEndOfDaySummary).not.toHaveBeenCalled();
  });

  it('does NOT send on a Wednesday — the midweek stock rule shares this handler', async () => {
    jest.setSystemTime(WEDNESDAY_NOON_MYT);
    installWorld({ cafeStatus: 'CLOSED' });

    await handler(event);

    // The café is CLOSED all week; without a day-of-week gate an empty RM0
    // report would go out after every midweek stock check.
    expect(mockSendEndOfDaySummary).not.toHaveBeenCalled();
    expect(markerPuts()).toEqual([]);
  });

  it('does NOT send on a non-Sunday even past 2pm MYT (isolates the day gate)', async () => {
    // The midweek rule fires at noon MYT, which the hour gate would also catch —
    // so that case alone cannot prove the day gate exists. This one can.
    jest.setSystemTime(WEDNESDAY_3PM_MYT);
    installWorld({ cafeStatus: 'CLOSED' });

    await handler(event);

    expect(mockSendEndOfDaySummary).not.toHaveBeenCalled();
    expect(markerPuts()).toEqual([]);
  });

  it('does NOT send on Sunday before 2pm MYT', async () => {
    // Protects the single per-date send from an accidental mid-morning close.
    jest.setSystemTime(SUNDAY_1PM_MYT);
    installWorld({ cafeStatus: 'CLOSED' });

    await handler(event);

    expect(mockSendEndOfDaySummary).not.toHaveBeenCalled();
    expect(markerPuts()).toEqual([]);
  });
});

describe('sendDailySummary — exactly once', () => {
  it('does not re-send when a marker for the date already exists', async () => {
    installWorld({
      cafeStatus: 'CLOSED',
      markers: { [`DAILY_SUMMARY#${TODAY_MYT}`]: { lastSent: '2026-08-16T06:05:00.000Z' } },
    });

    await handler(event);

    expect(mockSendEndOfDaySummary).not.toHaveBeenCalled();
  });

  it('sends once and only once across three cron runs in the same window', async () => {
    installWorld({ cafeStatus: 'CLOSED' });

    // 2pm, 2:30pm, 3pm — the marker persists in `world` between runs.
    await handler(event);
    jest.setSystemTime(new Date('2026-08-16T06:30:00.000Z'));
    await handler(event);
    jest.setSystemTime(new Date('2026-08-16T07:00:00.000Z'));
    await handler(event);

    expect(mockSendEndOfDaySummary).toHaveBeenCalledTimes(1);
    expect(markerPuts()).toEqual([`DAILY_SUMMARY#${TODAY_MYT}`]);
  });

  it('sends again on the NEXT service date', async () => {
    installWorld({
      cafeStatus: 'CLOSED',
      markers: { 'DAILY_SUMMARY#2026-08-16': { lastSent: '2026-08-16T06:05:00.000Z' } },
    });

    // The following Sunday, 2pm MYT.
    jest.setSystemTime(new Date('2026-08-23T06:00:00.000Z'));
    await handler(event);

    expect(mockSendEndOfDaySummary).toHaveBeenCalledTimes(1);
    expect(mockSendEndOfDaySummary.mock.calls[0][0].date).toBe('2026-08-23');
  });
});

describe('sendDailySummary — failures are visible and retried', () => {
  it('writes NO marker when the email reports failure, so the next run retries', async () => {
    installWorld({ cafeStatus: 'CLOSED' });
    mockSendEndOfDaySummary.mockResolvedValue(false);

    await handler(event);

    expect(mockSendEndOfDaySummary).toHaveBeenCalledTimes(1);
    // The whole point: a false must not be treated as sent.
    expect(markerPuts()).toEqual([]);

    // Next run in the window tries again and succeeds.
    mockSendEndOfDaySummary.mockResolvedValue(true);
    jest.setSystemTime(new Date('2026-08-16T06:30:00.000Z'));
    await handler(event);

    expect(mockSendEndOfDaySummary).toHaveBeenCalledTimes(2);
    expect(markerPuts()).toEqual([`DAILY_SUMMARY#${TODAY_MYT}`]);
  });

  it('logs a failed send instead of swallowing it', async () => {
    installWorld({ cafeStatus: 'CLOSED' });
    mockSendEndOfDaySummary.mockResolvedValue(false);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await handler(event);

    // A silent failure is what hid this bug for a week; there must be a line.
    const logged = rendered(errorSpy);
    expect(logged).toContain('[dailySummary]');
    expect(logged).toContain('NOT SENT');
    errorSpy.mockRestore();
  });

  it('logs and survives a throw from the summary build, without a marker', async () => {
    installWorld({ cafeStatus: 'CLOSED' });
    mockSendEndOfDaySummary.mockRejectedValue(new Error('SMTP exploded'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Must not fail the cron — order expiry has already run by this point.
    await expect(handler(event)).resolves.toBeUndefined();

    const logged = rendered(errorSpy);
    expect(logged).toContain('[dailySummary]');
    expect(logged).toContain('ERROR');
    expect(markerPuts()).toEqual([]);
    errorSpy.mockRestore();
  });

  it('logs the boolean the email returned on the success path too', async () => {
    installWorld({ cafeStatus: 'CLOSED' });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await handler(event);

    const logged = rendered(logSpy);
    expect(logged).toContain('sendDailySummaryEmail returned: true');
    logSpy.mockRestore();
  });
});

describe('closeCafe no longer sends the summary', () => {
  it('closes the café without attempting any email', async () => {
    installWorld({ cafeStatus: 'OPEN' });

    const res = await handlePos(
      { httpMethod: 'PUT', path: '/api/pos/cafe/close', headers: {}, body: null } as any,
      'Shini8207',
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cafeStatus).toBe('CLOSED');

    // The fire-and-forget send is gone. If it comes back, this goes red.
    expect(mockSendEndOfDaySummary).not.toHaveBeenCalled();
    // And it must not have gone looking for the summary's data either.
    const summaryQueries = mockDbSend.mock.calls
      .filter((c) => c[0].__cmd === 'Query' && c[0].KeyConditionExpression?.includes('createdAt >= :today'));
    expect(summaryQueries).toEqual([]);
  });

  it('still flips cafeStatus to CLOSED so the cron can pick the summary up', async () => {
    installWorld({ cafeStatus: 'OPEN' });

    await handlePos(
      { httpMethod: 'PUT', path: '/api/pos/cafe/close', headers: {}, body: null } as any,
      'Shini8207',
    );

    const statusWrite = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-settings' && c[0].Key?.PK === 'SETTINGS',
    )?.[0];
    expect(statusWrite).toBeDefined();
    expect(statusWrite.ExpressionAttributeValues[':s']).toBe('CLOSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
