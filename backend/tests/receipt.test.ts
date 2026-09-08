/**
 * Receipt upload and retrieval — `backend/src/routes/receipt.ts`.
 *
 *  - `POST /api/orders/{id}/receipt`            — customer uploads a DuitNow/bank
 *    transfer screenshot. Guards, then S3 put, then a Bedrock extraction, then
 *    amount / timestamp / duplicate validation, then the order update.
 *  - `GET  /api/orders/{id}/receipt`            — presigned GET for the cashier.
 *  - `POST /api/orders/{id}/receipt/upload-url` — presigned PUT for direct upload.
 *
 * Every assertion is on what the HANDLER produced — the parsed response body, or
 * the command objects it handed to `docClient.send` / `s3.send` /
 * `bedrock.send` / `getSignedUrl`. Never on the fixture the test itself built.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked; the S3 client, the presigner and the Bedrock Runtime client are
 * mocked too, so no AWS call is made, no URL is really signed and no model is
 * really invoked. No network, no credentials, nothing written to production — so
 * no `ZZTEST_` marker applies (that rule covers suites that create real records).
 *
 * `extractReceiptAmount` is NOT exported, so its branches (png vs jpeg
 * `media_type`, regex match vs no match, the `JSON.parse` try/catch) are driven
 * through the upload route and asserted on the payload handed to
 * `InvokeModelCommand` — which is the contract that actually ships.
 *
 * One line is deliberately uncovered: the `if (!orderId)` 400 at
 * `receipt.ts:24` is DEAD CODE. The route only runs when `event.path` matched
 * `/\/api\/orders\/[^/]+\/receipt$/`, and `[^/]+` requires at least one
 * non-slash character, so the segment after `orders` is never empty. There is no
 * event that reaches that return.
 *
 * The clock is pinned with `jest.setSystemTime` for EVERY test, not just the
 * timestamp ones: the handler's three time windows, the `Date.now()` in the S3
 * key and the `receiptUploadedAt` it writes are all wall-clock reads, so the test
 * has to own the wall clock or the assertions drift.
 */

const mockDbSend = jest.fn();
const mockS3Send = jest.fn();
const mockBedrockSend = jest.fn();
const mockGetSignedUrl = jest.fn();
const mockPutObjectCommand = jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Put' }));
const mockGetObjectCommand = jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Get' }));
const mockBedrockClient = jest.fn().mockImplementation(() => ({ send: mockBedrockSend }));

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
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: mockPutObjectCommand,
  GetObjectCommand: mockGetObjectCommand,
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: mockBedrockClient,
  InvokeModelCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'InvokeModel' })),
}));

const BUCKET = 'test-receipts-bucket';
process.env.RECEIPTS_BUCKET = BUCKET;
// The module falls back to 'ap-southeast-5' when AWS_REGION is unset; assert that
// rather than inherit whatever the shell happens to export.
delete process.env.AWS_REGION;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleReceipt } = require('../src/routes/receipt');

// ─── The pinned clock ─────────────────────────────────────────────────────────

/** 12:00 MYT = 04:00 UTC. Everything below is expressed relative to this. */
const NOW = new Date('2026-08-16T04:00:00.000Z');
const NOW_MS = NOW.getTime();
/** 11:50 MYT — the order was placed ten minutes ago. */
const ORDER_CREATED = '2026-08-16T03:50:00.000Z';
/** 11:55 MYT, no timezone suffix — the shape a bank app screenshot yields. */
const RECEIPT_LOCAL = '2026-08-16 11:55';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Record<string, any> = {}): any {
  return {
    httpMethod: 'POST', path: '/api/orders/order-1/receipt',
    body: null, headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...overrides,
  };
}

/** A JSON upload carrying a base64 data-URI, the customer PWA's actual shape. */
function jsonUpload(image: string, overrides: Record<string, any> = {}) {
  return makeEvent({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image }),
    ...overrides,
  });
}

const PNG_BYTES = Buffer.from('fake-png-bytes');
const PNG_B64 = PNG_BYTES.toString('base64');

function pendingOrder(overrides: Record<string, any> = {}) {
  return {
    PK: 'ORDER#order-1', SK: 'META', orderId: 'order-1',
    status: 'PENDING', totalAmount: 12, createdAt: ORDER_CREATED,
    ...overrides,
  };
}

/**
 * Answer each read from a described world keyed on the command the handler
 * actually issued, rather than a `mockResolvedValueOnce` queue that would let a
 * fixture silently fill the wrong slot (`invariants`, Test teeth). The upload
 * path issues up to SIX reads — one Get, three reference-number dup Queries and
 * three amount+timestamp dup Queries — and the reference and amount queries must
 * be staged distinctly or the fallback duplicate check is untested.
 */
function stage(world: {
  order?: Record<string, any>;
  refDups?: Record<string, Record<string, any>[]>;
  amountDups?: Record<string, Record<string, any>[]>;
  getThrows?: boolean;
  updateThrows?: boolean;
} = {}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd === 'Get') {
      if (world.getThrows) throw new Error('order read failed');
      return world.order ? { Item: world.order } : {};
    }
    if (cmd.__cmd === 'Query') {
      const status = cmd.ExpressionAttributeValues[':s'];
      const byRef = String(cmd.FilterExpression).includes('receiptRef');
      const table = byRef ? world.refDups : world.amountDups;
      return { Items: (table || {})[status] || [] };
    }
    if (cmd.__cmd === 'Update') {
      if (world.updateThrows) throw new Error('conditional check failed');
      return {};
    }
    return {};
  });
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function dbQueries() { return cmds().filter((c) => c.__cmd === 'Query'); }
function updates() { return cmds().filter((c) => c.__cmd === 'Update'); }

/** Stage the Bedrock reply as the raw model text the handler will regex over. */
function bedrockText(text: string) {
  mockBedrockSend.mockResolvedValueOnce({
    body: new TextEncoder().encode(JSON.stringify({ content: [{ text }] })),
  });
}

/** Stage a well-formed extraction result. */
function bedrockExtracts(fields: { amount?: unknown; date?: unknown; referenceNo?: unknown }) {
  bedrockText(JSON.stringify({
    amount: fields.amount ?? null,
    date: fields.date ?? null,
    referenceNo: fields.referenceNo ?? null,
  }));
}

/** The request payload the handler built for the model. */
function bedrockPayload() {
  return JSON.parse(mockBedrockSend.mock.calls[0][0].body);
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  mockDbSend.mockReset();
  mockS3Send.mockReset();
  mockS3Send.mockResolvedValue({});
  mockBedrockSend.mockReset();
  mockGetSignedUrl.mockReset();
  mockGetSignedUrl.mockResolvedValue('https://signed.example/url');
  mockPutObjectCommand.mockClear();
  mockGetObjectCommand.mockClear();
});

afterAll(() => { jest.useRealTimers(); });

// ══════════════════════════════════════════════════════════════════════════════
// POST — the guards, before anything is uploaded or invoked
// ══════════════════════════════════════════════════════════════════════════════

describe('POST receipt — order guards', () => {
  it('returns 404 when the order does not exist', async () => {
    stage({ order: undefined });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Order not found' });
    // The guard fires before the model is paid for.
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('reads the order by PK/SK on the orders table', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    const get = cmds().find((c) => c.__cmd === 'Get');
    expect(get.TableName).toBe('test-orders');
    expect(get.Key).toEqual({ PK: 'ORDER#order-1', SK: 'META' });
  });

  it.each([['PREPARING'], ['READY'], ['COMPLETED'], ['CANCELLED'], ['EXPIRED']])(
    'refuses an order in %s — only PENDING accepts a receipt',
    async (status) => {
      stage({ order: pendingOrder({ status }) });

      const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'Order is not pending' });
      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockBedrockSend).not.toHaveBeenCalled();
    },
  );

  it('refuses a ministry pre-order — a free order has no payment to evidence', async () => {
    // Since v1.71 pre-orders are created PENDING, so they reach this path. Without
    // the guard the extracted amount differs from the RM0 total and the POS card
    // renders a permanent mismatch badge for the rest of the service.
    stage({ order: pendingOrder({ isPreOrder: true, totalAmount: 0 }) });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Pre-orders do not require payment' });
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it('accepts a normal order whose isPreOrder is merely falsy, not absent', async () => {
    // The guard is `=== true`, so `false` must not be conflated with a pre-order.
    stage({ order: pendingOrder({ isPreOrder: false }) });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST — the three input shapes
// ══════════════════════════════════════════════════════════════════════════════

describe('POST receipt — image payload shapes', () => {
  it('unwraps a JSON base64 data-URI and carries its content type through', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(mockPutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
      ContentType: 'image/png',
      Body: PNG_BYTES,
    }));
    expect(bedrockPayload().messages[0].content[0].source).toEqual({
      type: 'base64', media_type: 'image/png', data: PNG_B64,
    });
  });

  it('treats a bare JSON base64 string as image/jpeg', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(PNG_B64));

    expect(res.statusCode).toBe(200);
    expect(mockPutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
      ContentType: 'image/jpeg', Body: PNG_BYTES,
    }));
    expect(bedrockPayload().messages[0].content[0].source.media_type).toBe('image/jpeg');
  });

  it('accepts a raw isBase64Encoded body with a binary content type', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(makeEvent({
      headers: { 'content-type': 'image/png' },
      body: PNG_B64,
      isBase64Encoded: true,
    }));

    expect(res.statusCode).toBe(200);
    expect(mockPutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
      ContentType: 'image/png', Body: PNG_BYTES,
    }));
    expect(bedrockPayload().messages[0].content[0].source.media_type).toBe('image/png');
  });

  it('decodes a raw body as utf-8 when isBase64Encoded is false', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(makeEvent({
      headers: { 'Content-Type': 'image/jpeg' },
      body: 'raw-bytes',
      isBase64Encoded: false,
    }));

    expect(res.statusCode).toBe(200);
    expect(mockPutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
      Body: Buffer.from('raw-bytes', 'utf-8'),
    }));
  });

  it('returns 400 when the JSON body carries no image field, before any DB read', async () => {
    stage({ order: pendingOrder() });

    const res = await handleReceipt(makeEvent({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notAnImage: true }),
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Missing image data' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('defaults to JSON parsing when no content-type header is present at all', async () => {
    stage({ order: pendingOrder() });

    const res = await handleReceipt(makeEvent({
      headers: {}, body: JSON.stringify({ noImage: 1 }),
    }));

    // Reached the JSON branch's own guard, so the default was application/json.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Missing image data' });
  });

  it('reads the content type from a lowercase header when the canonical one is absent', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(makeEvent({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: `data:image/png;base64,${PNG_B64}` }),
    }));

    expect(res.statusCode).toBe(200);
  });

  it('survives an event with no headers object at all', async () => {
    stage({ order: pendingOrder() });

    const res = await handleReceipt(makeEvent({
      headers: undefined, body: JSON.stringify({ noImage: 1 }),
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Missing image data' });
  });

  it('returns 500 for a null body — the empty-string default is not valid JSON', async () => {
    stage({ order: pendingOrder() });

    const res = await handleReceipt(makeEvent({
      headers: { 'Content-Type': 'application/json' }, body: null,
    }));

    expect(res.statusCode).toBe(500);
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('returns 500 when the JSON body is malformed', async () => {
    stage({ order: pendingOrder() });

    const res = await handleReceipt(makeEvent({
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    }));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toMatch(/JSON/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST — extraction (extractReceiptAmount, driven through the route)
// ══════════════════════════════════════════════════════════════════════════════

describe('POST receipt — Bedrock extraction', () => {
  it('invokes the configured model with the documented request shape', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    const cmd = mockBedrockSend.mock.calls[0][0];
    expect(cmd.modelId).toBe('global.anthropic.claude-sonnet-4-6');
    expect(cmd.contentType).toBe('application/json');
    const payload = JSON.parse(cmd.body);
    expect(payload.anthropic_version).toBe('bedrock-2023-05-31');
    expect(payload.max_tokens).toBe(300);
    expect(payload.messages[0].role).toBe('user');
    expect(payload.messages[0].content[1].text).toMatch(/referenceNo/);
  });

  it('constructs the Bedrock client with the ap-southeast-5 default region', async () => {
    expect(mockBedrockClient).toHaveBeenCalledWith({ region: 'ap-southeast-5' });
  });

  it.each([
    ['image/png', 'image/png'],
    ['image/jpeg', 'image/jpeg'],
    ['image/webp', 'image/jpeg'],
    ['application/octet-stream', 'image/jpeg'],
  ])('maps content type %s to media_type %s', async (contentType, mediaType) => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    await handleReceipt(jsonUpload(`data:${contentType};base64,${PNG_B64}`));

    expect(bedrockPayload().messages[0].content[0].source.media_type).toBe(mediaType);
  });

  it('returns 400 asking for a clearer screenshot when the model finds no JSON', async () => {
    stage({ order: pendingOrder() });
    bedrockText('I am sorry, I cannot read this image.');

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Could not read payment amount/);
    expect(updates()).toHaveLength(0);
  });

  it('swallows a JSON.parse failure on the matched chunk and reports it as unreadable', async () => {
    // Matches the `\{[^}]+\}` regex but is not valid JSON — the bare try/catch.
    stage({ order: pendingOrder() });
    bedrockText('{amount: 12.00, date: today}');

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Could not read payment amount/);
  });

  it('treats a missing content array in the model response as unreadable', async () => {
    stage({ order: pendingOrder() });
    mockBedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify({ stop_reason: 'max_tokens' })),
    });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Could not read payment amount/);
  });

  it('rejects a non-numeric amount rather than coercing it', async () => {
    stage({ order: pendingOrder() });
    bedrockText(JSON.stringify({ amount: '12.00', date: RECEIPT_LOCAL, referenceNo: 'REF1' }));

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Could not read payment amount/);
  });

  it('extracts the amount out of surrounding prose', async () => {
    stage({ order: pendingOrder() });
    bedrockText(`Here you go: {"amount": 12, "date": "${RECEIPT_LOCAL}", "referenceNo": "REF9"} — hope that helps.`);

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).receiptAmount).toBe(12);
  });

  it('returns 500 when the model response body is not JSON — the unguarded parse', async () => {
    stage({ order: pendingOrder() });
    mockBedrockSend.mockResolvedValueOnce({ body: new TextEncoder().encode('<html>502</html>') });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(500);
  });

  it('returns 500 when the invocation itself fails, after the image was stored', async () => {
    stage({ order: pendingOrder() });
    mockBedrockSend.mockRejectedValueOnce(new Error('ThrottlingException'));

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'ThrottlingException' });
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(updates()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST — amount matching
// ══════════════════════════════════════════════════════════════════════════════

describe('POST receipt — amount vs order total', () => {
  it('accepts an exact match', async () => {
    stage({ order: pendingOrder({ totalAmount: 12 }) });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });

  it('accepts a difference at the 0.01 tolerance edge — the guard is strictly greater', async () => {
    stage({ order: pendingOrder({ totalAmount: 12 }) });
    bedrockExtracts({ amount: 12.01, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).receiptAmount).toBe(12.01);
  });

  it('rejects a difference outside tolerance and reports both figures', async () => {
    stage({ order: pendingOrder({ totalAmount: 12 }) });
    bedrockExtracts({ amount: 7.5, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.extractedAmount).toBe(7.5);
    expect(body.expectedAmount).toBe(12);
    expect(body.error).toBe(
      "Payment amount (RM 7.50) doesn't match order total (RM 12.00). Please upload the correct receipt.",
    );
    expect(updates()).toHaveLength(0);
  });

  it('rejects an overpayment too, not only an underpayment', async () => {
    stage({ order: pendingOrder({ totalAmount: 12 }) });
    bedrockExtracts({ amount: 120, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).extractedAmount).toBe(120);
  });

  it('treats an order with no totalAmount as RM0.00 when reporting a mismatch', async () => {
    stage({ order: pendingOrder({ totalAmount: undefined }) });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).expectedAmount).toBe(0);
    expect(JSON.parse(res.body).error).toMatch(/order total \(RM 0\.00\)/);
  });

  it('rejects an extracted amount of exactly 0 as unreadable, before any comparison', async () => {
    // `if (!extractResult.amount)` is falsy-checked, so a genuine RM0.00 receipt
    // can never match an RM0 total. Documented, not endorsed — the only orders
    // with a 0 total are pre-orders, which are already refused above.
    stage({ order: pendingOrder({ totalAmount: 0 }) });
    bedrockExtracts({ amount: 0, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Could not read payment amount/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST — the three timestamp windows
// ══════════════════════════════════════════════════════════════════════════════

describe('POST receipt — timestamp windows', () => {
  it('accepts a zone-less timestamp by assuming Malaysia time (UTC+8)', async () => {
    // 11:55 with no suffix is 03:55 UTC — after the 03:50 order, 5 minutes ago.
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).receiptDate).toBe(RECEIPT_LOCAL);
  });

  it('honours an explicit Z suffix instead of shifting it', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: '2026-08-16T03:55:00Z', referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });

  it('honours an explicit +08:00 offset', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: '2026-08-16 11:55+08:00', referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });

  it('treats a zone-LESS ISO timestamp as already-UTC because it contains a T', async () => {
    // BUG (receipt.ts:100): `hasTZ` is true for any string containing 'T', so
    // '2026-08-16T11:55:00' — Malaysian wall time with no offset, the very case the
    // +08:00 fallback exists for — skips the fallback and is read as 11:55 UTC,
    // eight hours in the future. A valid receipt is rejected.
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: '2026-08-16T11:55:00', referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/appears to be in the future/);
  });

  it('rejects a timestamp before the order was placed', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: '2026-08-16 11:45', referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Receipt timestamp is before this order was placed. Please upload the receipt for this order.',
    });
    expect(updates()).toHaveLength(0);
    expect(dbQueries()).toHaveLength(0);
  });

  it('accepts a timestamp equal to the order creation instant', async () => {
    stage({ order: pendingOrder({ createdAt: '2026-08-16T03:55:00.000Z' }) });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });

  it('rejects a timestamp more than 60 seconds in the future', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: '2026-08-16 12:05', referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Receipt timestamp appears to be in the future. Please upload a valid receipt.',
    });
  });

  it('tolerates up to 60 seconds of clock skew ahead', async () => {
    // 12:00:45 MYT = 04:00:45Z, 45s ahead of the pinned now — inside the allowance.
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: '2026-08-16 12:00:45', referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });

  it('rejects a receipt older than 30 minutes', async () => {
    // The order is old enough that the before-order guard does not fire first.
    stage({ order: pendingOrder({ createdAt: '2026-08-16T02:00:00.000Z' }) });
    bedrockExtracts({ amount: 12, date: '2026-08-16 10:30', referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Receipt is older than 30 minutes. Please upload a recent receipt for this order.',
    });
  });

  it('accepts a receipt exactly 30 minutes old — the window is inclusive', async () => {
    stage({ order: pendingOrder({ createdAt: '2026-08-16T02:00:00.000Z' }) });
    bedrockExtracts({ amount: 12, date: '2026-08-16 11:30', referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });

  it('skips all three windows when the model returned no date', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: null, referenceNo: 'REF1' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).receiptDate).toBeNull();
    expect(updates()[0].ExpressionAttributeValues[':dt']).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST — duplicate detection by reference number
// ══════════════════════════════════════════════════════════════════════════════

describe('POST receipt — duplicate detection by referenceNo', () => {
  it('queries the status index for each of PENDING, PREPARING and READY', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    const queries = dbQueries();
    expect(queries).toHaveLength(3);
    expect(queries.map((q) => q.ExpressionAttributeValues[':s']))
      .toEqual(['PENDING', 'PREPARING', 'READY']);
    expect(queries[0].TableName).toBe('test-orders');
    expect(queries[0].IndexName).toBe('status-createdAt-index');
    expect(queries[0].KeyConditionExpression).toBe('#s = :s');
    expect(queries[0].ExpressionAttributeNames).toEqual({ '#s': 'status' });
    expect(queries[0].FilterExpression).toBe('receiptRef = :ref AND orderId <> :oid');
    expect(queries[0].ExpressionAttributeValues).toEqual({
      ':s': 'PENDING', ':ref': 'REF-ABC', ':oid': 'order-1',
    });
  });

  it('rejects a reference already used by a PENDING order, short-circuiting the rest', async () => {
    stage({
      order: pendingOrder(),
      refDups: { PENDING: [{ orderId: 'order-2', receiptRef: 'REF-ABC' }] },
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'This receipt has already been used for another order. Please upload a different receipt.',
    });
    // The loop `break`s on the first hit rather than paying for two more queries.
    expect(dbQueries()).toHaveLength(1);
    expect(updates()).toHaveLength(0);
  });

  it('finds a duplicate sitting in PREPARING', async () => {
    stage({
      order: pendingOrder(),
      refDups: { PREPARING: [{ orderId: 'order-3', receiptRef: 'REF-ABC' }] },
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(dbQueries()).toHaveLength(2);
  });

  it('finds a duplicate sitting in READY — the last status checked', async () => {
    stage({
      order: pendingOrder(),
      refDups: { READY: [{ orderId: 'order-4', receiptRef: 'REF-ABC' }] },
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(dbQueries()).toHaveLength(3);
  });

  it('skips the reference check entirely when the model found no reference', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: null, referenceNo: null });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(dbQueries()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST — fallback duplicate detection by amount + timestamp
// ══════════════════════════════════════════════════════════════════════════════

describe('POST receipt — fallback duplicate detection by amount + timestamp', () => {
  it('queries all three statuses on amount when there is no reference number', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: null });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    const queries = dbQueries();
    expect(queries).toHaveLength(3);
    expect(queries[0].FilterExpression)
      .toBe('receiptAmount = :amt AND orderId <> :oid AND attribute_exists(receiptDate)');
    expect(queries[0].ExpressionAttributeValues).toEqual({
      ':s': 'PENDING', ':amt': 12, ':oid': 'order-1',
    });
  });

  it('rejects another order with the same amount within a minute', async () => {
    stage({
      order: pendingOrder(),
      amountDups: {
        PREPARING: [{ orderId: 'order-2', receiptAmount: 12, receiptDate: '2026-08-16 11:55:30' }],
      },
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: null });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'A receipt with the same amount and timestamp was already used for another order. Please upload a unique receipt.',
    });
    expect(updates()).toHaveLength(0);
    // Unlike the reference loop, this one has no `break` — all three run.
    expect(dbQueries()).toHaveLength(3);
  });

  it('allows another order with the same amount more than a minute apart', async () => {
    stage({
      order: pendingOrder(),
      amountDups: {
        PENDING: [{ orderId: 'order-2', receiptAmount: 12, receiptDate: '2026-08-16 11:53' }],
      },
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: null });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });

  it('compares a stored zone-bearing receiptDate as UTC, not as Malaysia time', async () => {
    stage({
      order: pendingOrder(),
      amountDups: {
        READY: [{ orderId: 'order-2', receiptAmount: 12, receiptDate: '2026-08-16T03:55:20Z' }],
      },
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: null });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
  });

  it('ignores a returned row that carries no receiptDate at all', async () => {
    // The FilterExpression asks for attribute_exists(receiptDate), but the
    // in-handler filter re-checks — a row without one must not be a duplicate.
    stage({
      order: pendingOrder(),
      amountDups: { PENDING: [{ orderId: 'order-2', receiptAmount: 12 }] },
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: null });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });

  it('honours a zone-bearing extracted date on the fallback comparison too', async () => {
    // The fallback re-parses the extracted date with its own copy of the
    // hasTZ ternary, so the TZ-present arm needs covering here as well.
    stage({
      order: pendingOrder(),
      amountDups: {
        PENDING: [{ orderId: 'order-2', receiptAmount: 12, receiptDate: '2026-08-16T03:55:20Z' }],
      },
    });
    bedrockExtracts({ amount: 12, date: '2026-08-16T03:55:00Z', referenceNo: null });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/same amount and timestamp/);
  });

  it('tolerates a dup query response with no Items key at all', async () => {
    // Both loops guard with `Items &&` / `Items || []`; a response missing the key
    // must not throw a 500 at the customer.
    mockDbSend.mockReset();
    mockDbSend.mockImplementation(async (cmd: any) => {
      if (cmd.__cmd === 'Get') return { Item: pendingOrder() };
      return {}; // Query and Update alike — no Items, no Attributes
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: null });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
  });

  it('tolerates a reference dup query response with no Items key at all', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockImplementation(async (cmd: any) => {
      if (cmd.__cmd === 'Get') return { Item: pendingOrder() };
      return {};
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(dbQueries()).toHaveLength(3);
  });

  it('does not run the fallback when a reference number was found', async () => {
    stage({
      order: pendingOrder(),
      // Would match on amount+time, but the reference path owns the decision.
      amountDups: {
        PENDING: [{ orderId: 'order-2', receiptAmount: 12, receiptDate: RECEIPT_LOCAL }],
      },
    });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(dbQueries().every((q) => String(q.FilterExpression).includes('receiptRef'))).toBe(true);
  });

  it('does not run the fallback when there is neither reference nor date', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: null, referenceNo: null });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(dbQueries()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST — the write path
// ══════════════════════════════════════════════════════════════════════════════

describe('POST receipt — success', () => {
  it('stores the image under receipts/{orderId}/{now}.jpg in the configured bucket', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockPutObjectCommand).toHaveBeenCalledWith({
      Bucket: BUCKET,
      Key: `receipts/order-1/${NOW_MS}.jpg`,
      Body: PNG_BYTES,
      ContentType: 'image/png',
    });
  });

  it('writes all five receipt fields and returns the customer-facing summary', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    const update = updates()[0];
    expect(update.TableName).toBe('test-orders');
    expect(update.Key).toEqual({ PK: 'ORDER#order-1', SK: 'META' });
    expect(update.UpdateExpression).toBe(
      'SET receiptUrl = :url, receiptAmount = :amt, receiptDate = :dt, receiptRef = :ref, receiptUploadedAt = :now',
    );
    expect(update.ExpressionAttributeValues).toEqual({
      ':url': `s3://${BUCKET}/receipts/order-1/${NOW_MS}.jpg`,
      ':amt': 12,
      ':dt': RECEIPT_LOCAL,
      ':ref': 'REF-ABC',
      ':now': NOW.toISOString(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      receiptAmount: 12,
      receiptDate: RECEIPT_LOCAL,
      message: 'Receipt uploaded successfully. The cashier will verify your payment shortly.',
    });
  });

  it('never touches expiresAt or status — a receipt upload leaves the order PENDING', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    const update = updates()[0];
    expect(update.UpdateExpression).not.toMatch(/expiresAt|status/);
    expect(Object.keys(update.ExpressionAttributeValues)).toEqual(
      [':url', ':amt', ':dt', ':ref', ':now'],
    );
  });

  it('persists nulls rather than omitting the date and reference when absent', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: null, referenceNo: null });

    await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    const values = updates()[0].ExpressionAttributeValues;
    expect(values[':dt']).toBeNull();
    expect(values[':ref']).toBeNull();
  });

  it('returns 500 when the S3 put fails, and does not update the order', async () => {
    stage({ order: pendingOrder() });
    mockS3Send.mockRejectedValueOnce(new Error('AccessDenied'));

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'AccessDenied' });
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it('returns 500 when the order update fails', async () => {
    stage({ order: pendingOrder(), updateThrows: true });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF-ABC' });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'conditional check failed' });
  });

  it('returns 500 when the order read fails', async () => {
    stage({ getThrows: true });

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'order read failed' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/{id}/receipt
// ══════════════════════════════════════════════════════════════════════════════

const GET_EVENT = { httpMethod: 'GET', path: '/api/orders/order-1/receipt' };

describe('GET receipt', () => {
  it('returns 404 when the order does not exist', async () => {
    stage({ order: undefined });

    const res = await handleReceipt(makeEvent(GET_EVENT));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'No receipt found' });
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 404 when the order exists but has no receipt stored', async () => {
    stage({ order: pendingOrder() });

    const res = await handleReceipt(makeEvent(GET_EVENT));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'No receipt found' });
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('signs a one-hour GET URL for the stored key and returns the recorded figures', async () => {
    stage({
      order: pendingOrder({
        receiptUrl: `s3://${BUCKET}/receipts/order-1/1755316800000.jpg`,
        receiptAmount: 12,
        receiptDate: RECEIPT_LOCAL,
      }),
    });

    const res = await handleReceipt(makeEvent(GET_EVENT));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      receiptUrl: 'https://signed.example/url',
      receiptAmount: 12,
      receiptDate: RECEIPT_LOCAL,
    });
    const [, command, options] = mockGetSignedUrl.mock.calls[0];
    // The s3:// prefix is stripped — a signed URL for the full URI would 404.
    expect(command).toEqual({
      Bucket: BUCKET, Key: 'receipts/order-1/1755316800000.jpg', __cmd: 'S3Get',
    });
    expect(options).toEqual({ expiresIn: 3600 });
  });

  it('passes a receiptUrl from a different bucket through unchanged', async () => {
    // `replace` is a no-op when the prefix does not match, so a legacy row signs
    // against the configured bucket with the raw value as its key.
    stage({ order: pendingOrder({ receiptUrl: 's3://other-bucket/receipts/x.jpg' }) });

    await handleReceipt(makeEvent(GET_EVENT));

    expect(mockGetObjectCommand).toHaveBeenCalledWith({
      Bucket: BUCKET, Key: 's3://other-bucket/receipts/x.jpg',
    });
  });

  it('does not write anything — reading a receipt is a read', async () => {
    stage({ order: pendingOrder({ receiptUrl: `s3://${BUCKET}/receipts/order-1/1.jpg` }) });

    await handleReceipt(makeEvent(GET_EVENT));

    expect(cmds().filter((c) => ['Put', 'Update', 'Delete'].includes(c.__cmd))).toHaveLength(0);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('returns 500 when signing fails', async () => {
    stage({ order: pendingOrder({ receiptUrl: `s3://${BUCKET}/receipts/order-1/1.jpg` }) });
    mockGetSignedUrl.mockRejectedValueOnce(new Error('no credentials'));

    const res = await handleReceipt(makeEvent(GET_EVENT));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'no credentials' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/orders/{id}/receipt/upload-url
// ══════════════════════════════════════════════════════════════════════════════

describe('POST receipt/upload-url', () => {
  const UPLOAD_URL_EVENT = { httpMethod: 'POST', path: '/api/orders/order-9/receipt/upload-url' };

  it('signs a five-minute PUT URL and returns the key it signed', async () => {
    stage({});
    mockGetSignedUrl.mockResolvedValueOnce('https://signed.example/put');

    const res = await handleReceipt(makeEvent(UPLOAD_URL_EVENT));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      uploadUrl: 'https://signed.example/put',
      s3Key: `receipts/order-9/${NOW_MS}.jpg`,
    });
    const [, command, options] = mockGetSignedUrl.mock.calls[0];
    expect(command).toEqual({
      Bucket: BUCKET, Key: `receipts/order-9/${NOW_MS}.jpg`,
      ContentType: 'image/jpeg', __cmd: 'S3Put',
    });
    // Short-lived on purpose: the customer uploads immediately or asks again.
    expect(options).toEqual({ expiresIn: 300 });
  });

  it('touches neither DynamoDB nor S3 itself — it only signs', async () => {
    stage({});

    await handleReceipt(makeEvent(UPLOAD_URL_EVENT));

    expect(mockDbSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('is not swallowed by the plain receipt route despite the shared prefix', async () => {
    stage({ order: pendingOrder() });

    const res = await handleReceipt(makeEvent(UPLOAD_URL_EVENT));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).uploadUrl).toBeDefined();
    expect(JSON.parse(res.body).success).toBeUndefined();
  });

  it('returns 500 when signing the PUT fails', async () => {
    stage({});
    mockGetSignedUrl.mockRejectedValueOnce(new Error('presigner down'));

    const res = await handleReceipt(makeEvent(UPLOAD_URL_EVENT));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'presigner down' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Dispatch misses and failure shape
// ══════════════════════════════════════════════════════════════════════════════

describe('handleReceipt — 404 and 500', () => {
  it.each([
    ['an unrelated path', { httpMethod: 'GET', path: '/api/orders/order-1' }],
    ['a trailing slash', { httpMethod: 'GET', path: '/api/orders/order-1/receipt/' }],
    ['DELETE on the receipt path', { httpMethod: 'DELETE', path: '/api/orders/order-1/receipt' }],
    ['PUT on the receipt path', { httpMethod: 'PUT', path: '/api/orders/order-1/receipt' }],
    ['GET on the upload-url path', { httpMethod: 'GET', path: '/api/orders/order-1/receipt/upload-url' }],
    ['a nested extra segment', { httpMethod: 'POST', path: '/api/orders/order-1/receipt/other' }],
  ])('returns 404 for %s and touches nothing', async (_name, overrides) => {
    stage({ order: pendingOrder() });

    const res = await handleReceipt(makeEvent(overrides));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(mockDbSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the thrown value is not an Error', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue('a bare string');

    const res = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal error' });
  });

  it('always answers with a JSON content type', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const ok = await handleReceipt(jsonUpload(`data:image/png;base64,${PNG_B64}`));
    const missing = await handleReceipt(makeEvent({ httpMethod: 'PATCH', path: '/api/nope' }));

    expect(ok.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(missing.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// RECEIPTS_BUCKET unconfigured — needs its own module instance
// ══════════════════════════════════════════════════════════════════════════════

describe('RECEIPTS_BUCKET not configured', () => {
  let handleReceiptDefaultBucket: (event: any) => Promise<any>;

  beforeAll(() => {
    // `RECEIPTS_BUCKET` is captured once at import time, so the env change only
    // takes effect for a freshly loaded copy of the module.
    jest.resetModules();
    delete process.env.RECEIPTS_BUCKET;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    handleReceiptDefaultBucket = require('../src/routes/receipt').handleReceipt;
  });

  afterAll(() => {
    process.env.RECEIPTS_BUCKET = BUCKET;
    jest.resetModules();
  });

  it('falls back to the rlc-cafe-receipts bucket on upload', async () => {
    stage({ order: pendingOrder() });
    bedrockExtracts({ amount: 12, date: RECEIPT_LOCAL, referenceNo: 'REF1' });

    const res = await handleReceiptDefaultBucket(jsonUpload(`data:image/png;base64,${PNG_B64}`));

    expect(res.statusCode).toBe(200);
    expect(mockPutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: 'rlc-cafe-receipts',
    }));
    expect(updates()[0].ExpressionAttributeValues[':url'])
      .toBe(`s3://rlc-cafe-receipts/receipts/order-1/${NOW_MS}.jpg`);
  });

  it('strips the default-bucket prefix when signing a stored receipt', async () => {
    stage({ order: pendingOrder({ receiptUrl: 's3://rlc-cafe-receipts/receipts/order-1/7.jpg' }) });

    const res = await handleReceiptDefaultBucket(makeEvent(GET_EVENT));

    expect(res.statusCode).toBe(200);
    expect(mockGetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'rlc-cafe-receipts', Key: 'receipts/order-1/7.jpg',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
