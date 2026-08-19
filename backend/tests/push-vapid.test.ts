/**
 * Web push VAPID configuration.
 *
 * Production state before this suite existed: `GET /api/push/vapid-public-key`
 * returned `500 {"error":"VAPID not configured"}` and had done for weeks. The
 * Lambda had `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` set to EMPTY STRINGS —
 * `infra/lib/infra-stack.ts` defaulted them to `''`, so any `cdk deploy` from a
 * shell that had not exported them wiped the keys. `lib/push.ts` then did
 *
 *     if (!VAPID_PUBLIC || !VAPID_PRIVATE) return; // VAPID not configured, skip silently
 *
 * so nothing was logged either. Customer-visible effect: the notifications banner
 * on `track.html` asked for browser permission, the customer granted it, and then
 * received nothing, forever.
 *
 * The config now comes from SSM (`/rlc-cafe/VAPID_*`), like the email
 * credentials, and a missing or malformed config is LOUD. These tests pin both
 * halves: that the keys are read from SSM and cached, and that the failure path
 * logs instead of returning quietly.
 *
 * Everything is mocked — no SSM call, no DynamoDB call, no push is sent.
 */

const mockSsmSend = jest.fn();
const mockSetVapidDetails = jest.fn();
const mockSendNotification = jest.fn();
const mockDbSend = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParametersByPathCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'GetParametersByPath' })),
}));

jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: (...args: any[]) => mockSetVapidDetails(...args),
    sendNotification: (...args: any[]) => mockSendNotification(...args),
  },
}));

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

/* eslint-disable @typescript-eslint/no-var-requires */
const { sendOrderPush, ensureVapidConfigured, resetVapidState } = require('../src/lib/push');
const { getEmailConfig, getVapidConfig, resetSsmConfigCache } = require('../src/lib/ssm-config');
const { handler } = require('../src/index');
/* eslint-enable @typescript-eslint/no-var-requires */

/** A well-formed VAPID triple, in the shape GetParametersByPath returns. */
const VAPID_PARAMS = [
  { Name: '/rlc-cafe/VAPID_PUBLIC_KEY', Value: 'test-public-key' },
  { Name: '/rlc-cafe/VAPID_PRIVATE_KEY', Value: 'test-private-key' },
  { Name: '/rlc-cafe/VAPID_SUBJECT', Value: 'https://153.oasisofcare.org' },
];

/** Stage one SSM page containing exactly these parameters. */
function stageSsm(parameters: { Name: string; Value: string }[]) {
  mockSsmSend.mockResolvedValue({ Parameters: parameters });
}

function errorLines(): string[] {
  return (console.error as jest.Mock).mock.calls.map((c) => c.map(String).join(' '));
}

function dbCommands(): any[] {
  return mockDbSend.mock.calls.map((c) => c[0]);
}

function pushEvent(path = '/api/push/vapid-public-key') {
  return {
    httpMethod: 'GET',
    path,
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    body: null,
    isBase64Encoded: false,
  } as any;
}

const savedEnv = { ...process.env };

beforeEach(() => {
  mockSsmSend.mockReset();
  mockSetVapidDetails.mockReset();
  mockSendNotification.mockReset();
  mockDbSend.mockReset();
  mockDbSend.mockResolvedValue({});
  // Module-level caches in ssm-config / push must not leak between cases.
  resetSsmConfigCache();
  resetVapidState();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe('VAPID config comes from SSM', () => {
  it('reads the keys from /rlc-cafe/ and applies them to web-push', async () => {
    stageSsm(VAPID_PARAMS);

    const publicKey = await ensureVapidConfigured();

    expect(publicKey).toBe('test-public-key');
    // Asserted on what the code under test produced, not on the fixture: the
    // exact triple handed to web-push, in order (subject, public, private).
    expect(mockSetVapidDetails).toHaveBeenCalledWith(
      'https://153.oasisofcare.org', 'test-public-key', 'test-private-key',
    );
    const sent = mockSsmSend.mock.calls[0][0];
    expect(sent.Path).toBe('/rlc-cafe/');
    expect(sent.WithDecryption).toBe(true); // the private key is a SecureString
  });

  it('defaults the subject to the live site when VAPID_SUBJECT is absent', async () => {
    // Never `mailto:admin@rlccafe.com` — a domain this project does not own, which
    // some push services reject as the operator contact.
    stageSsm(VAPID_PARAMS.filter((p) => !p.Name.endsWith('VAPID_SUBJECT')));

    await ensureVapidConfigured();

    expect(mockSetVapidDetails).toHaveBeenCalledWith(
      'https://153.oasisofcare.org', 'test-public-key', 'test-private-key',
    );
  });

  it('CACHES the parameter fetch — three pushes, one SSM call', async () => {
    stageSsm(VAPID_PARAMS);
    mockDbSend.mockResolvedValue({ Items: [] });

    await sendOrderPush('order-1', 'T', 'B');
    await sendOrderPush('order-2', 'T', 'B');
    await sendOrderPush('order-3', 'T', 'B');

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    // And the keys are only pushed into the web-push singleton once, since the
    // public key did not change.
    expect(mockSetVapidDetails).toHaveBeenCalledTimes(1);
    // All three still reached the subscription query.
    expect(dbCommands().filter((c) => c.__cmd === 'Query')).toHaveLength(3);
  });

  it('shares one cached fetch with the email config', async () => {
    stageSsm([
      ...VAPID_PARAMS,
      { Name: '/rlc-cafe/GMAIL_USER', Value: 'cafe@example.com' },
      { Name: '/rlc-cafe/GMAIL_APP_PASSWORD', Value: 'app-password' },
      { Name: '/rlc-cafe/NOTIFICATION_EMAIL', Value: 'treasurer@example.com' },
    ]);

    const vapid = await getVapidConfig();
    const email = await getEmailConfig();

    expect(vapid.publicKey).toBe('test-public-key');
    expect(email.gmailUser).toBe('cafe@example.com');
    expect(email.notificationEmail).toBe('treasurer@example.com');
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });

  it('PAGINATES — keys on the second page are still found', async () => {
    // GetParametersByPath returns at most 10 parameters per call and /rlc-cafe/
    // already holds 7. A truncated read is indistinguishable from "never
    // configured", which is the exact failure this module exists to prevent.
    mockSsmSend
      .mockResolvedValueOnce({
        Parameters: [{ Name: '/rlc-cafe/GMAIL_USER', Value: 'cafe@example.com' }],
        NextToken: 'page-2',
      })
      .mockResolvedValueOnce({ Parameters: VAPID_PARAMS });

    const publicKey = await ensureVapidConfigured();

    expect(publicKey).toBe('test-public-key');
    expect(mockSsmSend).toHaveBeenCalledTimes(2);
    expect(mockSsmSend.mock.calls[1][0].NextToken).toBe('page-2');
  });

  it('falls back to process.env for local dev when SSM has no VAPID params', async () => {
    stageSsm([{ Name: '/rlc-cafe/GMAIL_USER', Value: 'cafe@example.com' }]);
    process.env.VAPID_PUBLIC_KEY = 'env-public';
    process.env.VAPID_PRIVATE_KEY = 'env-private';

    const publicKey = await ensureVapidConfigured();

    expect(publicKey).toBe('env-public');
    expect(mockSetVapidDetails).toHaveBeenCalledWith(
      'https://153.oasisofcare.org', 'env-public', 'env-private',
    );
  });
});

describe('a missing VAPID config is LOUD, not silent', () => {
  it('sendOrderPush LOGS and names the missing parameters', async () => {
    stageSsm([]); // nothing configured anywhere

    await sendOrderPush('order-1', '✅ Order Ready!', 'Your order is ready!');

    const lines = errorLines();
    expect(lines.some((l) => l.includes('[PUSH]') && l.includes('VAPID not configured'))).toBe(true);
    // Enough detail to diagnose: which values, and where they were looked for.
    const diagnostic = lines.find((l) => l.includes('VAPID not configured')) as string;
    expect(diagnostic).toContain('VAPID_PUBLIC_KEY');
    expect(diagnostic).toContain('VAPID_PRIVATE_KEY');
    expect(diagnostic).toContain('/rlc-cafe/');
    // And the order it gave up on is identifiable.
    expect(lines.some((l) => l.includes('order-1'))).toBe(true);
  });

  it('does not fall through to the subscription query when unconfigured', async () => {
    stageSsm([]);

    await sendOrderPush('order-1', 'T', 'B');

    expect(dbCommands()).toHaveLength(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(mockSetVapidDetails).not.toHaveBeenCalled();
  });

  it('names ONLY the half that is missing — public key present, private key blank', async () => {
    // The partial case is the dangerous one: it used to serve a public key with
    // no working private counterpart, so the browser subscribed happily and no
    // notification was ever delivered.
    stageSsm([{ Name: '/rlc-cafe/VAPID_PUBLIC_KEY', Value: 'test-public-key' }]);
    process.env.VAPID_PUBLIC_KEY = 'env-public';

    const publicKey = await ensureVapidConfigured();

    expect(publicKey).toBeNull();
    const diagnostic = errorLines().find((l) => l.includes('VAPID not configured')) as string;
    expect(diagnostic).toContain('VAPID_PRIVATE_KEY');
    expect(diagnostic).not.toContain('VAPID_PUBLIC_KEY,');
  });

  it('LOGS when web-push rejects a malformed config', async () => {
    stageSsm(VAPID_PARAMS);
    mockSetVapidDetails.mockImplementation(() => {
      throw new Error('Vapid subject is not a url or mailto url.');
    });

    const publicKey = await ensureVapidConfigured();

    expect(publicKey).toBeNull();
    const line = errorLines().find((l) => l.includes('REJECTED')) as string;
    expect(line).toBeDefined();
    // The message from web-push must survive to the log, plus the subject that
    // caused it — otherwise this is undiagnosable from CloudWatch.
    expect(line).toContain('not a url or mailto url');
    expect(line).toContain('https://153.oasisofcare.org');
  });

  it('sendOrderPush sends nothing when the config is malformed', async () => {
    stageSsm(VAPID_PARAMS);
    mockSetVapidDetails.mockImplementation(() => { throw new Error('invalid key'); });

    await sendOrderPush('order-1', 'T', 'B');

    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(dbCommands()).toHaveLength(0);
  });
});

describe('sendOrderPush with a working config', () => {
  it('delivers to every stored subscription for the order', async () => {
    stageSsm(VAPID_PARAMS);
    mockDbSend.mockResolvedValue({
      Items: [
        { PK: 'PUSH_SUB#order-1', SK: 'aaaa', subscription: { endpoint: 'https://fcm.example/a' } },
        { PK: 'PUSH_SUB#order-1', SK: 'bbbb', subscription: { endpoint: 'https://fcm.example/b' } },
      ],
    });
    mockSendNotification.mockResolvedValue({});

    await sendOrderPush('order-1', '✅ Order Ready!', 'Your order is ready for collection!');

    const query = dbCommands().find((c) => c.__cmd === 'Query');
    expect(query.TableName).toBe('test-settings');
    expect(query.ExpressionAttributeValues[':pk']).toBe('PUSH_SUB#order-1');

    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    expect(mockSendNotification.mock.calls[0][0]).toEqual({ endpoint: 'https://fcm.example/a' });
    expect(JSON.parse(mockSendNotification.mock.calls[0][1])).toEqual({
      title: '✅ Order Ready!',
      body: 'Your order is ready for collection!',
      orderId: 'order-1',
    });
  });

  it('deletes a subscription the push service reports as gone (410)', async () => {
    stageSsm(VAPID_PARAMS);
    mockDbSend.mockResolvedValue({
      Items: [{ PK: 'PUSH_SUB#order-1', SK: 'aaaa', subscription: { endpoint: 'https://fcm.example/a' } }],
    });
    mockSendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));

    await sendOrderPush('order-1', 'T', 'B');

    const del = dbCommands().find((c) => c.__cmd === 'Delete');
    expect(del).toBeDefined();
    expect(del.Key).toEqual({ PK: 'PUSH_SUB#order-1', SK: 'aaaa' });
  });
});

describe('GET /api/push/vapid-public-key', () => {
  it('dispatches through the router and returns the configured key', async () => {
    stageSsm(VAPID_PARAMS);

    const res = await handler(pushEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ publicKey: 'test-public-key' });
    // Public route — no Authorization header was sent.
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('returns 500 with a minimal body when nothing is configured', async () => {
    stageSsm([]);

    const res = await handler(pushEvent());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'VAPID not configured' });
  });

  it('refuses to serve a public key whose private key is missing', async () => {
    // Before the fix the route read process.env.VAPID_PUBLIC_KEY directly, so a
    // half-configured deploy returned 200 and every subscriber was silently
    // undeliverable. It must now fail the same way a push would.
    stageSsm([{ Name: '/rlc-cafe/VAPID_PUBLIC_KEY', Value: 'test-public-key' }]);

    const res = await handler(pushEvent());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'VAPID not configured' });
    expect(errorLines().some((l) => l.includes('VAPID_PRIVATE_KEY'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
