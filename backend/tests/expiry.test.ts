import { ScheduledEvent } from 'aws-lambda';

// ---------------------------------------------------------------------------
// Module mocks (mock-prefixed names so jest.mock factories may reference them)
// ---------------------------------------------------------------------------

const mockDbSend = jest.fn();
const mockSendLowStockAlert = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  INGREDIENTS_TABLE: 'test-ingredients',
  SETTINGS_TABLE: 'test-settings',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
}));

jest.mock('../src/lib/email', () => ({
  sendLowStockAlert: (...args: any[]) => mockSendLowStockAlert(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../src/expiry');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-06-09T05:00:00.000Z'); // 1pm MYT, mid-Sunday-service

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FIXED_NOW);
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  mockDbSend.mockReset();
  mockSendLowStockAlert.mockReset();
});

const event = {} as ScheduledEvent;

function isoMinutesAgo(min: number): string {
  return new Date(FIXED_NOW.getTime() - min * 60 * 1000).toISOString();
}

/**
 * Stage the typical sequence of DB calls in handler():
 *   1. Query — PENDING expiry candidates
 *   2. (no PENDING for these tests, so no UpdateCommand)
 *   3. Get — Settings record (archiveAfterMinutes)
 *   4. Query — current READY orders
 *   5. Update — per archive eligible order
 *   6. Get — last alert record (lowStock alert dedup)
 *   7. Scan — ingredients
 *
 * Tests typically only set the first 4 and let the low-stock branch fall
 * through with empty data.
 */
function stagePendingThenSettings(settings: any, readyItems: any[]) {
  mockDbSend.mockReset();
  mockDbSend
    .mockResolvedValueOnce({ Items: [] })          // 1. PENDING expiry query — none
    .mockResolvedValueOnce({ Item: settings })     // 2. Get settings (autoArchiveReadyOrders)
    .mockResolvedValueOnce({ Items: readyItems }); // 3. READY query
}

// Tail responses for the low-stock branch — runs after archive logic:
//   - Get(alertKey) → already sent
//   - (no scan, no put)
function stubLowStockNoop() {
  mockDbSend.mockResolvedValueOnce({ Item: { lastSent: '2026-06-09T01:00:00.000Z' } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoArchiveReadyOrders', () => {
  it('archives a READY order whose readyAt is older than the threshold', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        {
          PK: 'ORDER#abc',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(20),     // 20 min ago — past 15 min threshold
          updatedAt: isoMinutesAgo(20),
        },
      ]
    );
    mockDbSend.mockResolvedValueOnce({}); // archive update
    stubLowStockNoop();

    await handler(event);

    // Find the archive Update among the calls.
    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    )?.[0];
    expect(archiveCall).toBeDefined();
    expect(archiveCall.Key.PK).toBe('ORDER#abc');
    expect(archiveCall.UpdateExpression).toContain(':archived');
    expect(archiveCall.ExpressionAttributeValues[':archived']).toBe('ARCHIVED');
    expect(archiveCall.ConditionExpression).toBe('#s = :prev');
    expect(archiveCall.ExpressionAttributeValues[':prev']).toBe('READY');
    // Already had readyAt, so no backfill assignment in the SET clause.
    expect(archiveCall.UpdateExpression).not.toContain('readyAt = :readyAt');
  });

  it('does NOT archive a READY order whose readyAt is within the threshold', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        {
          PK: 'ORDER#fresh',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(8), // only 8 min ready — well within window
          updatedAt: isoMinutesAgo(8),
        },
      ]
    );
    stubLowStockNoop();

    await handler(event);

    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    );
    expect(archiveCall).toBeUndefined();
  });

  it('falls back to updatedAt and backfills readyAt for legacy orders', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        {
          PK: 'ORDER#legacy',
          SK: 'META',
          status: 'READY',
          // no readyAt — this is a record from before the feature shipped
          updatedAt: isoMinutesAgo(30),
        },
      ]
    );
    mockDbSend.mockResolvedValueOnce({}); // archive update
    stubLowStockNoop();

    await handler(event);

    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    )?.[0];
    expect(archiveCall).toBeDefined();
    // Backfill: SET clause must include readyAt = :readyAt with the legacy updatedAt value.
    expect(archiveCall.UpdateExpression).toContain('readyAt = :readyAt');
    expect(archiveCall.ExpressionAttributeValues[':readyAt']).toBe(isoMinutesAgo(30));
  });

  it('reads archiveAfterMinutes from the Settings record', async () => {
    // Threshold of 30 min — a 20-min-ready order should NOT archive.
    stagePendingThenSettings(
      { archiveAfterMinutes: 30 },
      [
        {
          PK: 'ORDER#twentymin',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(20),
          updatedAt: isoMinutesAgo(20),
        },
      ]
    );
    stubLowStockNoop();

    await handler(event);

    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    );
    expect(archiveCall).toBeUndefined();

    // Confirm the Settings Get was actually queried.
    const settingsGet = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Get' && c[0].TableName === 'test-settings' && c[0].Key.PK === 'SETTINGS'
    );
    expect(settingsGet).toBeDefined();
  });

  it('falls back to 15 min when archiveAfterMinutes is missing from settings', async () => {
    stagePendingThenSettings(
      { /* no archiveAfterMinutes */ },
      [
        {
          PK: 'ORDER#default',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(16),
          updatedAt: isoMinutesAgo(16),
        },
      ]
    );
    mockDbSend.mockResolvedValueOnce({}); // archive update
    stubLowStockNoop();

    await handler(event);

    // 16 min > default 15 min → archived
    const archiveCall = mockDbSend.mock.calls.find(
      (c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders'
    );
    expect(archiveCall).toBeDefined();
  });

  it('silently no-ops when status changed mid-cron (race with cashier undo)', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        {
          PK: 'ORDER#raced',
          SK: 'META',
          status: 'READY',
          readyAt: isoMinutesAgo(20),
          updatedAt: isoMinutesAgo(20),
        },
      ]
    );

    // Simulate the conditional check failing — DynamoDB throws when status
    // is no longer READY (e.g. cashier just undid back to PREPARING).
    const conditional = Object.assign(new Error('conditional fail'), {
      name: 'ConditionalCheckFailedException',
    });
    mockDbSend.mockRejectedValueOnce(conditional);
    stubLowStockNoop();

    // Must not throw.
    await expect(handler(event)).resolves.toBeUndefined();
  });

  it('processes multiple orders and only archives the eligible ones', async () => {
    stagePendingThenSettings(
      { archiveAfterMinutes: 15 },
      [
        { PK: 'ORDER#a', SK: 'META', status: 'READY', readyAt: isoMinutesAgo(2),  updatedAt: isoMinutesAgo(2) },
        { PK: 'ORDER#b', SK: 'META', status: 'READY', readyAt: isoMinutesAgo(20), updatedAt: isoMinutesAgo(20) },
        { PK: 'ORDER#c', SK: 'META', status: 'READY', readyAt: isoMinutesAgo(8),  updatedAt: isoMinutesAgo(8) },
        { PK: 'ORDER#d', SK: 'META', status: 'READY', readyAt: isoMinutesAgo(45), updatedAt: isoMinutesAgo(45) },
      ]
    );
    mockDbSend.mockResolvedValueOnce({}); // archive b
    mockDbSend.mockResolvedValueOnce({}); // archive d
    stubLowStockNoop();

    await handler(event);

    const archived = mockDbSend.mock.calls
      .filter((c) => c[0].__cmd === 'Update' && c[0].TableName === 'test-orders')
      .map((c) => c[0].Key.PK);
    expect(archived.sort()).toEqual(['ORDER#b', 'ORDER#d']);
  });
});
