/**
 * Opening / closing / handover checklists — `backend/src/routes/checklist.ts`.
 *
 * One handler serves five routes across two roles, and `backend/src/index.ts`
 * dispatches on the PREFIX (`/api/admin/checklist`, `/api/pos/checklist`) while
 * the handler itself dispatches on `path.endsWith(...)`. So the paths used here
 * are the real ones the router forwards, not simplified stand-ins: a POS path
 * that also ends in `/checklist/config` would be answered by the admin branch.
 *
 * `handleChecklist(event)` takes ONE argument — no `actor` string, unlike the
 * admin handlers in `staffcode.ts` / `vouchers.ts`. Nothing in a checklist write
 * is attributed from the token; `completedBy` comes from the request body and
 * defaults to `'Unknown'`. That is pinned below because it is a trust boundary,
 * not an accident to be tidied up silently.
 *
 * Every assertion is on what the HANDLER produced: the parsed response body, or
 * the `Item` of the `PutCommand` it built. Never on the fixture the test made.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked, so there is no network, no credentials, and nothing written to
 * production — hence no `ZZTEST_` marker (that rule covers suites creating real
 * records).
 *
 * The clock is pinned with `jest.setSystemTime`, because the handler derives
 * `today` from `new Date()` with no injection point: the log PK it reads and
 * writes (`CHECKLIST_LOG#<date>#<phase>`) and the `completedAt` it stamps are
 * both wall-clock, so the test has to own the wall clock to assert either.
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
const { handleChecklist } = require('../src/routes/checklist');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** 10:00 Sunday MYT = 02:00 UTC. The handler's date is UTC (`toISOString`). */
const SUNDAY_1000_MYT = new Date('2026-08-16T02:00:00Z');
const TODAY = '2026-08-16';
const NOW_ISO = '2026-08-16T02:00:00.000Z';

const CONFIG_KEY = 'CHECKLIST_CONFIG';
const logPK = (phase: string, date: string = TODAY) => `CHECKLIST_LOG#${date}#${phase}`;

/** A stored config with one disabled row in each phase. */
const STORED_CONFIG = {
  PK: CONFIG_KEY, SK: 'META',
  open: [
    { id: 'open-1', label: 'Turn on coffee machine', type: 'checkbox', enabled: true },
    { id: 'open-2', label: 'Fill ice container', type: 'checkbox' },          // no `enabled` — legacy
    { id: 'open-3', label: 'Retired step', type: 'checkbox', enabled: false },
  ],
  close: [
    { id: 'close-1', label: 'Clean up', type: 'checkbox', enabled: true },
    { id: 'close-2', label: 'Retired step', type: 'checkbox', enabled: false },
  ],
  handover: [
    { id: 'handover-1', label: 'Wipe counters', type: 'checkbox', enabled: true },
    { id: 'handover-2', label: 'Retired step', type: 'checkbox', enabled: false },
  ],
};

function checkedItem(overrides: Record<string, unknown> = {}) {
  return {
    checked: true, value: null, completedBy: 'Mei Yii',
    completedAt: '2026-08-16T01:00:00.000Z', ...overrides,
  };
}

/**
 * Answer every read from a described world, keyed on the command and the actual
 * `Key.PK` the handler asked for — not a `mockResolvedValueOnce` queue, which
 * would let a fixture silently fill the wrong slot (`invariants`, Test teeth).
 * `GET /checklist` alone issues four Gets: the config plus one per phase log.
 */
function stage(world: {
  config?: Record<string, unknown>;
  logs?: Record<string, Record<string, unknown>>;
  scan?: { Items?: unknown[] };
} = {}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Get' && cmd.Key?.PK === CONFIG_KEY) {
      return world.config ? { Item: world.config } : {};
    }
    if (cmd.__cmd === 'Get' && String(cmd.Key?.PK || '').startsWith('CHECKLIST_LOG#')) {
      const rec = world.logs?.[String(cmd.Key.PK)];
      return rec ? { Item: rec } : {};
    }
    if (cmd.__cmd === 'Scan') return world.scan ?? { Items: [] };
    return {};
  });
}

function event(method: string, path: string, body?: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: method, path,
    body: body === undefined ? null : JSON.stringify(body),
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
  } as unknown as APIGatewayProxyEvent;
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function puts() { return cmds().filter((c) => c.__cmd === 'Put'); }
/** The single log record the handler would have written. */
function writtenLog() { return puts()[0]?.Item; }

async function call(method: string, path: string, body?: unknown) {
  const res = await handleChecklist(event(method, path, body));
  return { statusCode: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.setSystemTime(SUNDAY_1000_MYT);
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/pos/checklist — config (enabled only) + today's completion
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/pos/checklist', () => {
  it('hides `enabled: false` rows from the POS and keeps rows with no `enabled` key', async () => {
    // The legacy row matters: `enabled` was added later, so `undefined` must read
    // as enabled. Filtering on truthiness instead of `!== false` would empty the
    // volunteers' checklist for every pre-feature record.
    stage({ config: STORED_CONFIG });

    const res = await call('GET', '/api/pos/checklist');

    expect(res.statusCode).toBe(200);
    expect(res.body.config.open.map((i: any) => i.id)).toEqual(['open-1', 'open-2']);
    expect(res.body.config.close.map((i: any) => i.id)).toEqual(['close-1']);
    expect(res.body.config.handover.map((i: any) => i.id)).toEqual(['handover-1']);
  });

  it('reads the three phase logs for TODAY and returns them under their phases', async () => {
    stage({
      config: STORED_CONFIG,
      logs: {
        [logPK('open')]: {
          PK: logPK('open'), SK: 'META', date: TODAY, phase: 'open',
          items: { 'open-1': checkedItem() }, allCompleted: false,
        },
      },
    });

    const res = await call('GET', '/api/pos/checklist');

    expect(res.body.log.open.items['open-1'].completedBy).toBe('Mei Yii');
    expect(res.body.log.open.allCompleted).toBe(false);
    // Absent phases fall back to an empty, incomplete log rather than undefined —
    // the POS renders `log[phase].items` unguarded.
    expect(res.body.log.close).toEqual({ items: {}, allCompleted: false });
    expect(res.body.log.handover).toEqual({ items: {}, allCompleted: false });

    // The date in the keys is the assertion: a wrong date silently shows an empty
    // checklist while yesterday's ticks sit in the table.
    const gets = cmds().filter((c) => c.__cmd === 'Get').map((c) => c.Key.PK);
    expect(gets).toEqual([CONFIG_KEY, logPK('open'), logPK('close'), logPK('handover')]);
    expect(cmds().every((c) => c.TableName === 'test-settings')).toBe(true);
  });

  it('serves the seeded default checklist when no config record exists', async () => {
    stage({ config: undefined });

    const res = await call('GET', '/api/pos/checklist');

    expect(res.statusCode).toBe(200);
    expect(res.body.config.open).toHaveLength(9);
    expect(res.body.config.close).toHaveLength(8);
    expect(res.body.config.handover).toHaveLength(3);
    // Every seeded row is enabled, so the filter must not remove any of them.
    expect(res.body.config.open[0].id).toBe('open-1');
    expect(res.body.config.open.filter((i: any) => i.type === 'image')).toHaveLength(2);
  });

  it('reads only — the status fetch writes nothing', async () => {
    stage({ config: STORED_CONFIG });
    await call('GET', '/api/pos/checklist');
    expect(cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd))).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/pos/checklist/check
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/pos/checklist/check — validation', () => {
  it.each([
    ['no body at all', undefined],
    ['an empty body', {}],
    ['a missing phase', { itemId: 'open-1' }],
    ['a missing itemId', { phase: 'open' }],
  ])('rejects %s with 400 and writes nothing', async (_name, body) => {
    stage({ config: STORED_CONFIG });

    const res = await call('PUT', '/api/pos/checklist/check', body);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'phase and itemId required' });
    // Validation sits before the Get/Put pair, so a rejected request must not
    // have touched the table at all.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects a phase outside open/close/handover with 400 and writes nothing', async () => {
    stage({ config: STORED_CONFIG });

    const res = await call('PUT', '/api/pos/checklist/check', { phase: 'stocktake', itemId: 'open-1' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid phase' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

describe('PUT /api/pos/checklist/check — the write', () => {
  it('merges the tick into the existing items and writes the whole log record', async () => {
    stage({
      config: STORED_CONFIG,
      logs: {
        [logPK('open')]: {
          PK: logPK('open'), SK: 'META', date: TODAY, phase: 'open',
          items: { 'open-1': checkedItem() }, allCompleted: false,
        },
      },
    });

    const res = await call('PUT', '/api/pos/checklist/check', {
      phase: 'open', itemId: 'open-2', value: 's3://fridge.jpg', completedBy: 'Sarah',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ itemId: 'open-2', checked: true, allCompleted: true });

    const item = writtenLog();
    expect(item.PK).toBe(logPK('open'));
    expect(item.SK).toBe('META');
    expect(item.date).toBe(TODAY);
    expect(item.phase).toBe('open');
    expect(item.lastUpdated).toBe(NOW_ISO);
    // The pre-existing tick survives — a Put replaces the whole record, so a
    // handler that forgot to merge would silently wipe the rest of the phase.
    expect(Object.keys(item.items).sort()).toEqual(['open-1', 'open-2']);
    expect(item.items['open-1'].completedBy).toBe('Mei Yii');
    expect(item.items['open-2']).toEqual({
      checked: true, value: 's3://fridge.jpg', completedBy: 'Sarah', completedAt: NOW_ISO,
    });
    expect(puts()[0].TableName).toBe('test-settings');
  });

  it('defaults value to null and completedBy to "Unknown"', async () => {
    stage({ config: STORED_CONFIG });

    const res = await call('PUT', '/api/pos/checklist/check', { phase: 'open', itemId: 'open-1' });

    expect(res.statusCode).toBe(200);
    expect(writtenLog().items['open-1']).toEqual({
      checked: true, value: null, completedBy: 'Unknown', completedAt: NOW_ISO,
    });
  });

  it('starts a fresh items map when no log record exists yet for today', async () => {
    stage({ config: STORED_CONFIG, logs: {} });

    const res = await call('PUT', '/api/pos/checklist/check', { phase: 'close', itemId: 'close-1' });

    expect(res.statusCode).toBe(200);
    // close-1 is the ONLY enabled close row, so ticking it completes the phase.
    expect(res.body.allCompleted).toBe(true);
    expect(writtenLog().items).toEqual({
      'close-1': { checked: true, value: null, completedBy: 'Unknown', completedAt: NOW_ISO },
    });
    expect(writtenLog().allCompleted).toBe(true);
  });

  it('recomputes allCompleted as false while an enabled row is still unticked', async () => {
    stage({ config: STORED_CONFIG });

    const res = await call('PUT', '/api/pos/checklist/check', { phase: 'open', itemId: 'open-1' });

    // open-2 (legacy, no `enabled`) is still outstanding.
    expect(res.body.allCompleted).toBe(false);
    expect(writtenLog().allCompleted).toBe(false);
  });

  it('ignores DISABLED rows when deciding allCompleted', async () => {
    // The reason this matters: an admin who disables a step must not leave the
    // phase permanently incompletable, because the disabled row can never be
    // ticked from a POS that does not render it (see the GET filter above).
    stage({
      config: STORED_CONFIG,
      logs: {
        [logPK('handover')]: {
          PK: logPK('handover'), SK: 'META', date: TODAY, phase: 'handover',
          items: {}, allCompleted: false,
        },
      },
    });

    const res = await call('PUT', '/api/pos/checklist/check', {
      phase: 'handover', itemId: 'handover-1', completedBy: 'Sarah',
    });

    expect(res.body.allCompleted).toBe(true);
    expect(writtenLog().items['handover-2']).toBeUndefined();
  });

  it('computes allCompleted against the SEEDED phase when no config is stored', async () => {
    // The default-seed path has to reach the recompute too: with 9 default open
    // rows, one tick cannot complete the phase.
    stage({ config: undefined });

    const res = await call('PUT', '/api/pos/checklist/check', { phase: 'open', itemId: 'open-1' });

    expect(res.body.allCompleted).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/pos/checklist/uncheck
// ══════════════════════════════════════════════════════════════════════════════

describe('PUT /api/pos/checklist/uncheck', () => {
  it.each([
    ['an empty body', {}, 'phase and itemId required'],
    ['a missing itemId', { phase: 'close' }, 'phase and itemId required'],
    ['a missing phase', { itemId: 'close-1' }, 'phase and itemId required'],
    ['an invalid phase', { phase: 'restock', itemId: 'close-1' }, 'invalid phase'],
  ])('rejects %s with 400 and writes nothing', async (_name, body, expected) => {
    stage({ config: STORED_CONFIG });

    const res = await call('PUT', '/api/pos/checklist/uncheck', body);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: expected });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('removes only the named item and forces allCompleted false', async () => {
    stage({
      logs: {
        [logPK('open')]: {
          PK: logPK('open'), SK: 'META', date: TODAY, phase: 'open',
          items: { 'open-1': checkedItem(), 'open-2': checkedItem() },
          allCompleted: true,
        },
      },
    });

    const res = await call('PUT', '/api/pos/checklist/uncheck', { phase: 'open', itemId: 'open-1' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ itemId: 'open-1', checked: false, allCompleted: false });

    const item = writtenLog();
    expect(Object.keys(item.items)).toEqual(['open-2']);
    // A previously-complete phase must not stay flagged complete: the stored
    // `allCompleted: true` above is exactly the value that has to be overwritten.
    expect(item.allCompleted).toBe(false);
    expect(item.PK).toBe(logPK('open'));
    expect(item.phase).toBe('open');
    expect(item.date).toBe(TODAY);
    expect(item.lastUpdated).toBe(NOW_ISO);
  });

  it('is idempotent when the item was never ticked, and reads no config', async () => {
    stage({ logs: {} });

    const res = await call('PUT', '/api/pos/checklist/uncheck', { phase: 'handover', itemId: 'handover-1' });

    expect(res.statusCode).toBe(200);
    expect(writtenLog().items).toEqual({});
    // Unchecking needs no recompute, so it must not read the config record.
    expect(cmds().filter((c) => c.__cmd === 'Get' && c.Key.PK === CONFIG_KEY)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Admin — GET/PUT /api/admin/checklist/config
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/checklist/config', () => {
  it('returns the stored config UNFILTERED — the admin must see disabled rows', async () => {
    // The mirror of the POS filter: if the admin screen were filtered too, a
    // disabled row could never be re-enabled.
    stage({ config: STORED_CONFIG });

    const res = await call('GET', '/api/admin/checklist/config');

    expect(res.statusCode).toBe(200);
    expect(res.body.open.map((i: any) => i.id)).toEqual(['open-1', 'open-2', 'open-3']);
    expect(res.body.open[2].enabled).toBe(false);
    expect(Object.keys(res.body).sort()).toEqual(['close', 'handover', 'open']);
  });

  it('seeds the full default set when there is no record at all', async () => {
    stage({ config: undefined });

    const res = await call('GET', '/api/admin/checklist/config');

    expect(res.body.open).toHaveLength(9);
    expect(res.body.close).toHaveLength(8);
    expect(res.body.handover.map((i: any) => i.id)).toEqual(['handover-1', 'handover-2', 'handover-3']);
    expect(res.body.open[7]).toEqual({
      id: 'open-8', label: 'Capture fridge photo (stock count)', type: 'image', enabled: true,
    });
  });

  it('falls back to the default handover when a stored record has none', async () => {
    // Records written before the handover phase existed have no `handover` key.
    // open/close fall back to [] but handover falls back to the DEFAULTS, which
    // is deliberate and asymmetric — pinned so it is not "tidied" into [].
    stage({ config: { PK: CONFIG_KEY, SK: 'META', open: [{ id: 'open-1', label: 'x' }] } });

    const res = await call('GET', '/api/admin/checklist/config');

    expect(res.body.open).toEqual([{ id: 'open-1', label: 'x' }]);
    expect(res.body.close).toEqual([]);
    expect(res.body.handover).toHaveLength(3);
    expect(res.body.handover[1].label).toBe('Tally 1st service orders');
  });

  it('falls back to [] for a stored record missing open AND close', async () => {
    // The other half of the asymmetry above: open and close do NOT seed. A record
    // holding only a handover list must not resurrect the nine default open rows,
    // or an admin who deleted them all sees them return next Sunday.
    stage({ config: { PK: CONFIG_KEY, SK: 'META', handover: [{ id: 'handover-1', label: 'y' }] } });

    const res = await call('GET', '/api/admin/checklist/config');

    expect(res.body.open).toEqual([]);
    expect(res.body.close).toEqual([]);
    expect(res.body.handover).toEqual([{ id: 'handover-1', label: 'y' }]);
  });

  it('keeps an explicitly EMPTY stored handover empty (only absence seeds)', async () => {
    stage({ config: { PK: CONFIG_KEY, SK: 'META', open: [], close: [], handover: [] } });

    const res = await call('GET', '/api/admin/checklist/config');

    expect(res.body.handover).toEqual([]);
  });
});

describe('PUT /api/admin/checklist/config', () => {
  it('persists the three phases verbatim under a fixed key', async () => {
    stage({});

    const res = await call('PUT', '/api/admin/checklist/config', {
      open: [{ id: 'open-1', label: 'Turn on coffee machine', type: 'checkbox', enabled: true }],
      close: [{ id: 'close-1', label: 'Clean up', type: 'checkbox', enabled: false }],
      handover: [{ id: 'handover-1', label: 'Wipe counters', type: 'checkbox', enabled: true }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ updated: true });

    const item = writtenLog();
    expect(item.PK).toBe(CONFIG_KEY);
    expect(item.SK).toBe('META');
    expect(item.updatedAt).toBe(NOW_ISO);
    expect(item.open[0].label).toBe('Turn on coffee machine');
    expect(item.close[0].enabled).toBe(false);   // a disabled row is STORED, not dropped
    expect(item.handover).toHaveLength(1);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].TableName).toBe('test-settings');
  });

  it('stores empty arrays for phases the body omits — never undefined', async () => {
    // A DynamoDB attribute set to `undefined` is rejected outright, and the
    // reader's `|| []` would not save a write that never landed.
    stage({});

    const res = await call('PUT', '/api/admin/checklist/config', { open: [{ id: 'open-1', label: 'x' }] });

    expect(res.statusCode).toBe(200);
    expect(writtenLog().close).toEqual([]);
    expect(writtenLog().handover).toEqual([]);
  });

  it('accepts a completely empty body and writes three empty phases', async () => {
    stage({});

    const res = await call('PUT', '/api/admin/checklist/config', {});

    expect(res.statusCode).toBe(200);
    expect(writtenLog()).toEqual({
      PK: CONFIG_KEY, SK: 'META', open: [], close: [], handover: [], updatedAt: NOW_ISO,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Admin — GET /api/admin/checklist/logs
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/checklist/logs', () => {
  it('scans the CHECKLIST_LOG# prefix and returns newest date first', async () => {
    stage({
      scan: {
        Items: [
          { PK: logPK('open', '2026-08-02'), date: '2026-08-02', phase: 'open' },
          { PK: logPK('close', '2026-08-16'), date: '2026-08-16', phase: 'close' },
          { PK: logPK('open', '2026-08-09'), date: '2026-08-09', phase: 'open' },
        ],
      },
    });

    const res = await call('GET', '/api/admin/checklist/logs');

    expect(res.statusCode).toBe(200);
    expect(res.body.logs.map((l: any) => l.date)).toEqual(['2026-08-16', '2026-08-09', '2026-08-02']);

    const scan = cmds().find((c) => c.__cmd === 'Scan');
    expect(scan.TableName).toBe('test-settings');
    expect(scan.FilterExpression).toBe('begins_with(PK, :prefix)');
    expect(scan.ExpressionAttributeValues).toEqual({ ':prefix': 'CHECKLIST_LOG#' });
  });

  it('returns an empty list when the scan yields no Items attribute', async () => {
    stage({ scan: {} });

    const res = await call('GET', '/api/admin/checklist/logs');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ logs: [] });
  });

  it('does not throw when a legacy row has no date attribute', async () => {
    stage({ scan: { Items: [{ PK: logPK('open', '2026-08-09'), date: '2026-08-09' }, { PK: 'CHECKLIST_LOG#legacy' }] } });

    const res = await call('GET', '/api/admin/checklist/logs');

    expect(res.statusCode).toBe(200);
    expect(res.body.logs).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Dispatch misses and failures
// ══════════════════════════════════════════════════════════════════════════════

describe('handleChecklist — 404 and 500', () => {
  it.each([
    ['an unknown sub-path', 'GET', '/api/pos/checklist/history'],
    ['a POST to the check route', 'POST', '/api/pos/checklist/check'],
    ['a DELETE on the config route', 'DELETE', '/api/admin/checklist/config'],
    ['a PUT on the logs route', 'PUT', '/api/admin/checklist/logs'],
  ])('returns 404 for %s', async (_name, method, path) => {
    stage({ config: STORED_CONFIG });

    const res = await call(method, path, {});

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(puts()).toHaveLength(0);
  });

  it('returns 500 with the error message when DynamoDB fails', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));

    const res = await call('GET', '/api/pos/checklist');

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'ProvisionedThroughputExceeded' });
  });

  it('returns 500 with a generic message when the failure is not an Error', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue('a bare string');

    const res = await call('PUT', '/api/admin/checklist/config', { open: [] });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error' });
  });

  it('returns JSON content-type on every response', async () => {
    stage({ config: STORED_CONFIG });
    const ok = await call('GET', '/api/pos/checklist');
    const missing = await call('GET', '/api/pos/checklist/nope');
    expect(ok.headers['Content-Type']).toBe('application/json');
    expect(missing.headers['Content-Type']).toBe('application/json');
  });
});
