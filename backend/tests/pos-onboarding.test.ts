/**
 * `PUT /api/pos/onboarding-progress` — the cashier tutorial's progress store.
 * `backend/src/routes/pos.ts:1480-1532`.
 *
 * Three things here are load-bearing and all three are pinned below:
 *
 * 1. **The user is found by NAME, not id.** The JWT carries the display name, so
 *    the handler `Scan`s USERS_TABLE filtering on `#n = :name` with the `actor`
 *    argument. The Scan's own shape is therefore part of the contract — a wrong
 *    attribute name silently 404s every cashier.
 * 2. **`step: '__reset__'` is a sentinel, not a step.** It clears the record
 *    (`onboardingProgress = []`, `onboardingComplete = false`) so the tutorial
 *    replays; it must never be appended to the progress list.
 * 3. **`ALL_STEPS` is a hardcoded copy of the step ids in
 *    `frontend/js/training-config.json`.** The source comment says to keep the
 *    two in sync. That obligation is only real if something checks it, so the
 *    drift guard below drives the handler once per config step, in both
 *    directions: every config id must be *required* for completion, and the full
 *    config must *achieve* completion.
 *
 * Fully mocked — `lib/db` is the backend's only DynamoDB client, so this suite
 * makes no network call, needs no credentials, and creates no production record.
 * Hence no `ZZTEST_` marker: the prefix rule covers suites that write for real.
 */

import { readFileSync } from 'fs';
import * as path from 'path';

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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePos } = require('../src/routes/pos');

// ─── Fixtures ────────────────────────────────────────────────────────

/** The step ids the frontend tutorial actually walks, read from the real file. */
const CONFIG_STEP_IDS: string[] = (() => {
  const file = path.join(__dirname, '../../frontend/js/training-config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  return config.steps.map((s: any) => s.id);
})();

const CASHIER = 'Mei Yii';

function userRecord(overrides: Record<string, any> = {}) {
  return {
    PK: 'USER#u-7', SK: 'META', userId: 'u-7', name: CASHIER,
    role: 'CASHIER', pinHash: 'x', isActive: true,
    ...overrides,
  };
}

function progressEvent(body: Record<string, any> | string | null) {
  return {
    httpMethod: 'PUT', path: '/api/pos/onboarding-progress',
    body: typeof body === 'string' || body === null ? body : JSON.stringify(body),
    headers: {}, queryStringParameters: null, pathParameters: null,
  } as any;
}

/** Every command issued, unwrapped, in order. */
function sent() {
  return mockDbSend.mock.calls.map(c => c[0]);
}

/** The user-lookup Scan. */
function userScan() {
  return sent().find(c => c.__cmd === 'Scan');
}

/** The Update issued against the users table — the record actually written. */
function userUpdate() {
  return sent().find(c => c.__cmd === 'Update' && c.TableName === 'test-users');
}

/** Stage: user found (or not), then a successful write. */
function stageUser(user: any) {
  mockDbSend
    .mockResolvedValueOnce({ Items: user ? [user] : [] })
    .mockResolvedValue({});
}

beforeEach(() => { mockDbSend.mockReset(); });

// ─── The user lookup ─────────────────────────────────────────────────

describe('onboarding-progress — user lookup', () => {
  it('scans USERS_TABLE filtering on the name attribute with the actor', async () => {
    stageUser(userRecord());
    const res = await handlePos(progressEvent({ step: 'welcome' }), CASHIER);
    expect(res.statusCode).toBe(200);

    const scan = userScan();
    expect(scan.TableName).toBe('test-users');
    expect(scan.FilterExpression).toBe('#n = :name');
    // `name` is a DynamoDB reserved word, so it MUST come through the alias.
    expect(scan.ExpressionAttributeNames).toEqual({ '#n': 'name' });
    expect(scan.ExpressionAttributeValues).toEqual({ ':name': CASHIER });
  });

  it('404s and writes nothing when no user matches the actor', async () => {
    stageUser(null);
    const res = await handlePos(progressEvent({ step: 'welcome' }), 'Nobody');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'User not found' });
    expect(userUpdate()).toBeUndefined();
  });

  it('404s when the Scan returns no Items key at all', async () => {
    mockDbSend.mockResolvedValue({});
    const res = await handlePos(progressEvent({ step: 'welcome' }), CASHIER);
    expect(res.statusCode).toBe(404);
    expect(userUpdate()).toBeUndefined();
  });

  it('404s on the default empty actor rather than matching a nameless record', async () => {
    // handlePos's `actor` defaults to ''. A token with no display name must not
    // land on some arbitrary user's progress record.
    stageUser(null);
    const res = await handlePos(progressEvent({ step: 'welcome' }));
    expect(res.statusCode).toBe(404);
    expect(userScan().ExpressionAttributeValues).toEqual({ ':name': '' });
  });

  it('writes to the found record’s own PK/SK, not a reconstructed key', async () => {
    stageUser(userRecord({ PK: 'USER#other-id', SK: 'META' }));
    await handlePos(progressEvent({ step: 'welcome' }), CASHIER);
    expect(userUpdate().Key).toEqual({ PK: 'USER#other-id', SK: 'META' });
  });
});

// ─── Normal step progress ────────────────────────────────────────────

describe('onboarding-progress — recording a step', () => {
  it('appends the step and writes progress + incomplete flag', async () => {
    stageUser(userRecord());
    const res = await handlePos(progressEvent({ step: 'welcome' }), CASHIER);
    expect(res.statusCode).toBe(200);

    const update = userUpdate();
    expect(update.UpdateExpression).toBe('SET onboardingProgress = :p, onboardingComplete = :c');
    expect(update.ExpressionAttributeValues[':p']).toEqual(['welcome']);
    expect(update.ExpressionAttributeValues[':c']).toBe(false);

    // The response must mirror what was persisted, not a locally built value.
    expect(JSON.parse(res.body)).toEqual({ progress: ['welcome'], onboardingComplete: false });
  });

  it('appends to existing progress, preserving order', async () => {
    stageUser(userRecord({ onboardingProgress: ['welcome', 'overview-board'] }));
    await handlePos(progressEvent({ step: 'approve-explain' }), CASHIER);
    expect(userUpdate().ExpressionAttributeValues[':p'])
      .toEqual(['welcome', 'overview-board', 'approve-explain']);
  });

  it('is idempotent — re-sending a recorded step does not duplicate it', async () => {
    stageUser(userRecord({ onboardingProgress: ['welcome', 'overview-board'] }));
    const res = await handlePos(progressEvent({ step: 'welcome' }), CASHIER);
    expect(userUpdate().ExpressionAttributeValues[':p']).toEqual(['welcome', 'overview-board']);
    expect(JSON.parse(res.body).progress).toEqual(['welcome', 'overview-board']);
  });

  it('does not mutate the stored array it read (it copies)', async () => {
    const stored = ['welcome'];
    stageUser(userRecord({ onboardingProgress: stored }));
    await handlePos(progressEvent({ step: 'overview-board' }), CASHIER);
    // If the handler pushed into the record's own array, a retry or any later
    // read of the same object would see a value that was never written.
    expect(stored).toEqual(['welcome']);
    expect(userUpdate().ExpressionAttributeValues[':p']).toEqual(['welcome', 'overview-board']);
  });

  it('treats a non-array onboardingProgress as empty', async () => {
    // Legacy/corrupt records: a string, a number, or null must not throw.
    for (const bad of ['welcome', 42, null, {}]) {
      mockDbSend.mockReset();
      stageUser(userRecord({ onboardingProgress: bad }));
      const res = await handlePos(progressEvent({ step: 'welcome' }), CASHIER);
      expect(res.statusCode).toBe(200);
      expect(userUpdate().ExpressionAttributeValues[':p']).toEqual(['welcome']);
    }
  });

  it('issues exactly one Scan and one Update — no read-back', async () => {
    stageUser(userRecord());
    await handlePos(progressEvent({ step: 'welcome' }), CASHIER);
    expect(sent().map(c => c.__cmd)).toEqual(['Scan', 'Update']);
  });
});

// ─── The `__reset__` sentinel ────────────────────────────────────────

describe('onboarding-progress — the __reset__ sentinel', () => {
  it('clears progress and the complete flag', async () => {
    stageUser(userRecord({
      onboardingProgress: [...CONFIG_STEP_IDS],
      onboardingComplete: true,
    }));
    const res = await handlePos(progressEvent({ step: '__reset__' }), CASHIER);
    expect(res.statusCode).toBe(200);

    const update = userUpdate();
    expect(update.TableName).toBe('test-users');
    expect(update.UpdateExpression).toBe('SET onboardingProgress = :p, onboardingComplete = :c');
    expect(update.ExpressionAttributeValues).toEqual({ ':p': [], ':c': false });
    expect(JSON.parse(res.body)).toEqual({ progress: [], onboardingComplete: false });
  });

  it('never records __reset__ itself as a completed step', async () => {
    // The sentinel must not leak into the list, or the tutorial's own progress
    // display gains a phantom step and a reset becomes non-idempotent.
    stageUser(userRecord({ onboardingProgress: ['welcome'] }));
    await handlePos(progressEvent({ step: '__reset__' }), CASHIER);
    expect(userUpdate().ExpressionAttributeValues[':p']).toEqual([]);
    expect(userUpdate().ExpressionAttributeValues[':p']).not.toContain('__reset__');
  });

  it('resets an already-empty record without error', async () => {
    stageUser(userRecord());
    const res = await handlePos(progressEvent({ step: '__reset__' }), CASHIER);
    expect(res.statusCode).toBe(200);
    expect(userUpdate().ExpressionAttributeValues[':p']).toEqual([]);
  });

  it('still requires the user to exist — 404 and no write', async () => {
    stageUser(null);
    const res = await handlePos(progressEvent({ step: '__reset__' }), 'Nobody');
    expect(res.statusCode).toBe(404);
    expect(userUpdate()).toBeUndefined();
  });

  it('is exact — a near-miss sentinel is stored as an ordinary step', async () => {
    for (const near of ['__RESET__', '_reset_', 'reset', '__reset']) {
      mockDbSend.mockReset();
      stageUser(userRecord());
      const res = await handlePos(progressEvent({ step: near }), CASHIER);
      expect(res.statusCode).toBe(200);
      expect(userUpdate().ExpressionAttributeValues[':p']).toEqual([near]);
    }
  });
});

// ─── Input validation ────────────────────────────────────────────────

describe('onboarding-progress — input validation', () => {
  it('400s on a missing/empty step before touching DynamoDB', async () => {
    for (const body of [{}, { step: '' }, { step: null }, { step: 0 }, { step: false }, { notStep: 'welcome' }]) {
      mockDbSend.mockReset();
      const res = await handlePos(progressEvent(body), CASHIER);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'step required' });
      // Cheapest possible rejection: the guard sits above the Scan.
      expect(mockDbSend).not.toHaveBeenCalled();
    }
  });

  it('400s on an absent body', async () => {
    const res = await handlePos(progressEvent(null), CASHIER);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'step required' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('DOCUMENTED GAP: a malformed JSON body throws instead of returning 400', async () => {
    // pos.ts:1481 does a bare `JSON.parse(event.body || '{}')`, and neither
    // handlePos nor index.ts's handler wraps it — so a truncated body escapes as
    // an exception, which API Gateway turns into a 502 with NO CORS headers,
    // rather than the 400 every other branch here returns. Asserted so the
    // behaviour is visible; the fix belongs in pos.ts, not in a test.
    await expect(handlePos(progressEvent('{"step":'), CASHIER)).rejects.toThrow(SyntaxError);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('DOCUMENTED GAP: a non-string step is stored verbatim, not rejected', async () => {
    // The only check is truthiness, so any truthy JSON value becomes a member of
    // onboardingProgress. A number or object in that list can never satisfy
    // ALL_STEPS, so the user is stuck one step short forever with no error.
    for (const weird of [42, true, { id: 'welcome' }, ['welcome']]) {
      mockDbSend.mockReset();
      stageUser(userRecord());
      const res = await handlePos(progressEvent({ step: weird }), CASHIER);
      expect(res.statusCode).toBe(200);
      expect(userUpdate().ExpressionAttributeValues[':p']).toEqual([weird]);
      expect(userUpdate().ExpressionAttributeValues[':c']).toBe(false);
    }
  });

  it('an unknown step id is accepted and never blocks completion', async () => {
    stageUser(userRecord({ onboardingProgress: [...CONFIG_STEP_IDS] }));
    const res = await handlePos(progressEvent({ step: 'no-such-step' }), CASHIER);
    expect(res.statusCode).toBe(200);
    const v = userUpdate().ExpressionAttributeValues;
    expect(v[':p']).toContain('no-such-step');
    expect(v[':c']).toBe(true);
  });
});

// ─── Dispatch — exact method + path ──────────────────────────────────

describe('onboarding-progress — dispatch', () => {
  it('is PUT-only on an exact path; anything else falls through to 404', async () => {
    const cases = [
      { httpMethod: 'GET', path: '/api/pos/onboarding-progress' },
      { httpMethod: 'POST', path: '/api/pos/onboarding-progress' },
      { httpMethod: 'DELETE', path: '/api/pos/onboarding-progress' },
      { httpMethod: 'PUT', path: '/api/pos/onboarding-progress/' },
      { httpMethod: 'PUT', path: '/api/pos/onboarding-progress/welcome' },
      { httpMethod: 'PUT', path: '/api/pos/onboarding' },
    ];
    for (const c of cases) {
      mockDbSend.mockReset();
      const res = await handlePos({
        ...c, body: JSON.stringify({ step: 'welcome' }),
        headers: {}, queryStringParameters: null, pathParameters: null,
      } as any, CASHIER);
      expect([res.statusCode, c.httpMethod + ' ' + c.path])
        .toEqual([404, c.httpMethod + ' ' + c.path]);
      expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
      expect(mockDbSend).not.toHaveBeenCalled();
    }
  });

  it('does not set event.pathParameters — the route takes no path param', async () => {
    const event = progressEvent({ step: 'welcome' });
    stageUser(userRecord());
    await handlePos(event, CASHIER);
    expect(event.pathParameters).toBeNull();
  });
});

// ─── ALL_STEPS completion ────────────────────────────────────────────

describe('onboarding-progress — completion calculation', () => {
  it('flags complete when the final missing step arrives', async () => {
    const allButLast = CONFIG_STEP_IDS.slice(0, -1);
    const last = CONFIG_STEP_IDS[CONFIG_STEP_IDS.length - 1];
    stageUser(userRecord({ onboardingProgress: allButLast }));

    const res = await handlePos(progressEvent({ step: last }), CASHIER);
    expect(res.statusCode).toBe(200);

    const v = userUpdate().ExpressionAttributeValues;
    expect(v[':p']).toEqual(CONFIG_STEP_IDS);
    expect(v[':c']).toBe(true);
    expect(JSON.parse(res.body).onboardingComplete).toBe(true);
  });

  it('does NOT flag complete while one step is outstanding', async () => {
    // Second-to-last recorded, last one still missing.
    stageUser(userRecord({ onboardingProgress: CONFIG_STEP_IDS.slice(0, -2) }));
    const res = await handlePos(progressEvent({ step: CONFIG_STEP_IDS[CONFIG_STEP_IDS.length - 2] }), CASHIER);
    expect(userUpdate().ExpressionAttributeValues[':c']).toBe(false);
    expect(JSON.parse(res.body).onboardingComplete).toBe(false);
  });

  it('order of completion does not matter — reversed progress still completes', async () => {
    const reversed = [...CONFIG_STEP_IDS].reverse();
    stageUser(userRecord({ onboardingProgress: reversed.slice(0, -1) }));
    const res = await handlePos(progressEvent({ step: reversed[reversed.length - 1] }), CASHIER);
    expect(userUpdate().ExpressionAttributeValues[':c']).toBe(true);
    expect(JSON.parse(res.body).onboardingComplete).toBe(true);
  });

  it('a first step on an empty record is never complete', async () => {
    stageUser(userRecord());
    await handlePos(progressEvent({ step: CONFIG_STEP_IDS[0] }), CASHIER);
    expect(userUpdate().ExpressionAttributeValues[':c']).toBe(false);
  });

  it('recomputes from stored progress, not from a stored flag', async () => {
    // A record wrongly marked complete but missing steps must be corrected
    // downwards, not trusted.
    stageUser(userRecord({
      onboardingProgress: ['welcome'],
      onboardingComplete: true,
    }));
    await handlePos(progressEvent({ step: 'overview-board' }), CASHIER);
    expect(userUpdate().ExpressionAttributeValues[':c']).toBe(false);
  });
});

// ─── ALL_STEPS vs training-config.json — the drift guard ─────────────

describe('ALL_STEPS is in sync with frontend/js/training-config.json', () => {
  it('the config itself has 22 unique, non-empty step ids', async () => {
    // Sanity floor for the two loops below: if the config were empty they would
    // both pass vacuously.
    expect(CONFIG_STEP_IDS.length).toBe(22);
    expect(new Set(CONFIG_STEP_IDS).size).toBe(CONFIG_STEP_IDS.length);
    expect(CONFIG_STEP_IDS.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('the full set of config steps ACHIEVES completion (ALL_STEPS ⊆ config)', async () => {
    // If ALL_STEPS names a step the config no longer emits, no cashier can ever
    // finish the tutorial — the backend waits forever for a step nothing sends.
    stageUser(userRecord({ onboardingProgress: CONFIG_STEP_IDS.slice(0, -1) }));
    const res = await handlePos(
      progressEvent({ step: CONFIG_STEP_IDS[CONFIG_STEP_IDS.length - 1] }), CASHIER);
    expect(JSON.parse(res.body).onboardingComplete).toBe(true);
  });

  it('every config step is REQUIRED for completion (config ⊆ ALL_STEPS)', async () => {
    // The other direction: a step added to the config but not to ALL_STEPS is
    // not required, so the user is flagged complete before actually finishing.
    // Drive the handler once per step, each time with exactly that one absent.
    const notComplete: string[] = [];
    for (const missing of CONFIG_STEP_IDS) {
      const staged = CONFIG_STEP_IDS.filter(id => id !== missing);
      // Re-send a step already present so `progress` is unchanged by the call.
      const echo = staged[0];
      mockDbSend.mockReset();
      stageUser(userRecord({ onboardingProgress: staged }));
      const res = await handlePos(progressEvent({ step: echo }), CASHIER);
      expect(res.statusCode).toBe(200);
      expect(userUpdate().ExpressionAttributeValues[':p']).toEqual(staged);
      if (JSON.parse(res.body).onboardingComplete === false) notComplete.push(missing);
    }
    // Naming the whole set makes a drift failure readable: the diff lists the
    // step ids ALL_STEPS has stopped requiring.
    expect(notComplete).toEqual(CONFIG_STEP_IDS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
