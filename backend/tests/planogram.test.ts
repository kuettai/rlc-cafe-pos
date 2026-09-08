import * as path from 'path';
import { APIGatewayProxyEvent } from 'aws-lambda';

// ---------------------------------------------------------------------------
// Module mocks
//
// These factories run lazily on first import. Variable names are prefixed
// with "mock" so Jest's babel transform allows them inside jest.mock factories.
// ---------------------------------------------------------------------------

const mockS3Send = jest.fn();
const mockBedrockSend = jest.fn();
const mockDbSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Put' })),
  GetObjectCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Get' })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Invoke' })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: any[]) => mockGetSignedUrl(...args),
}));

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  SETTINGS_TABLE: 'test-settings',
  INGREDIENTS_TABLE: 'test-ingredients',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'DbGet' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'DbPut' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'DbScan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'DbUpdate' })),
}));

// Force mock mode + point at the fixture before importing the handler.
process.env.PLANOGRAM_MOCK = 'true';
const ENVELOPE_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'planogram',
  'mock-response.json'
);
// The same data as a bare top-level array rather than a { counts: [...] }
// envelope — loadMockResult accepts either shape.
const BARE_ARRAY_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'planogram',
  'mock-response-array.json'
);
process.env.PLANOGRAM_MOCK_FIXTURE_PATH = ENVELOPE_FIXTURE;
process.env.PLANOGRAM_BUCKET = 'test-planogram-bucket';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handlePlanogram } = require('../src/routes/planogram');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/api/pos/planogram/analyze',
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
    ...overrides,
  };
}

// A 1×1 transparent PNG, base64-encoded. Decodes to non-empty bytes so the
// image-validation check passes.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// The same bytes with no data-URL wrapper, for the "bare base64" branch.
const TINY_PNG_BASE64 = TINY_PNG_DATA_URL.split(',')[1];

// Base64 that is syntactically accepted but decodes to zero bytes.
const UNDECODABLE_BASE64 = '===';

// A Bedrock InvokeModel reply, shaped the way the handler reads it:
// `JSON.parse(new TextDecoder().decode(response.body)).content[0].text`.
function bedrockReply(text: string) {
  return {
    body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text }] })),
  };
}

// The three DB calls analyze makes, in order: ingredient Scan, reference Get,
// log Put. `referenceItem` is what the Get returns as `Item`.
function stageAnalyzeDb(referenceItem?: Record<string, unknown>) {
  mockDbSend
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Item: referenceItem })
    .mockResolvedValueOnce({});
}

// The content[] array the handler handed to Bedrock on its first call.
function bedrockContent(): any[] {
  return JSON.parse(mockBedrockSend.mock.calls[0][0].body).messages[0].content;
}

beforeEach(() => {
  mockS3Send.mockReset();
  mockBedrockSend.mockReset();
  mockDbSend.mockReset();
  mockGetSignedUrl.mockReset();

  // Default S3 / DB / signer responses — individual tests override as needed.
  mockS3Send.mockResolvedValue({});
  mockGetSignedUrl.mockResolvedValue('https://signed.example/url');

  // analyzeStock reads PLANOGRAM_MOCK, and loadMockResult reads
  // PLANOGRAM_MOCK_FIXTURE_PATH, on every call — so mock mode against the
  // envelope fixture is the per-test default and tests opt out explicitly.
  process.env.PLANOGRAM_MOCK = 'true';
  process.env.PLANOGRAM_MOCK_FIXTURE_PATH = ENVELOPE_FIXTURE;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handlePlanogram — analyze', () => {
  it('uploads photos to S3, writes a log, returns mocked counts + logId', async () => {
    // Sequence of DB calls inside analyze:
    //   1. ScanCommand   → ingredients   (returns Items[])
    //   2. GetCommand    → reference     (no item, so reference is skipped)
    //   3. PutCommand    → log entry
    mockDbSend
      .mockResolvedValueOnce({
        Items: [
          {
            ingredientId: 'ing-1',
            name: 'Oat Milk',
            unit: 'carton',
            usageUnit: 'ml',
            currentStock: 4,
            storageLocation: 'FRIDGE',
          },
          {
            ingredientId: 'ing-2',
            name: 'Sugar',
            unit: 'kg',
            currentStock: 2,
            storageLocation: 'STOREROOM',
          },
        ],
      })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({});

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });

    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.logId).toMatch(/^\d{4}-\d{2}-\d{2}#\d+$/);
    expect(body.counts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Oat Milk', count: 3, confidence: 'high' }),
      ])
    );
    expect(body.counts.length).toBeGreaterThan(5);

    // Only fridge ingredients should be returned in the ingredients[] context.
    expect(body.ingredients).toEqual([
      expect.objectContaining({ ingredientId: 'ing-1', name: 'Oat Milk' }),
    ]);

    // S3 was called once per photo to put the snapshot.
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const s3Cmd = mockS3Send.mock.calls[0][0];
    expect(s3Cmd.Bucket).toBe('test-planogram-bucket');
    expect(s3Cmd.Key).toMatch(
      /^stock-count\/\d{4}-\d{2}-\d{2}\/fridge\/\d+-0\.jpg$/
    );

    // Bedrock was NOT called (mock mode).
    expect(mockBedrockSend).not.toHaveBeenCalled();

    // Last DB call must be the log Put with confirmedAt: null.
    const putCall = mockDbSend.mock.calls[2][0];
    expect(putCall.__cmd).toBe('DbPut');
    expect(putCall.Item.PK).toMatch(/^PLANOGRAM_LOG#/);
    expect(putCall.Item.confirmedAt).toBeNull();
    expect(putCall.Item.location).toBe('fridge');
  });

  it('rejects an unknown location with 400', async () => {
    const event = makeEvent({
      body: JSON.stringify({ location: 'pantry', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/location/);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects a missing location with 400', async () => {
    const event = makeEvent({
      body: JSON.stringify({ images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/location/);
  });

  it('rejects an empty images array with 400', async () => {
    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/images/);
  });

  it('rejects an unparseable image entry with 400', async () => {
    mockDbSend.mockResolvedValueOnce({ Items: [] });
    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [''] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/images\[0\]/);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('rejects a non-string image entry with 400, naming its index', async () => {
    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL, 12345] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toMatch(/images\[1\] must be a non-empty string/);
    // The valid image at [0] was uploaded before the bad entry was reached, so
    // the guard is about rejecting the request, not about atomicity.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects an image whose base64 decodes to zero bytes with 400', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        location: 'fridge',
        images: [`data:image/png;base64,${UNDECODABLE_BASE64}`],
      }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('images[0] could not be decoded');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects a bare base64 payload that decodes to zero bytes with 400', async () => {
    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [UNDECODABLE_BASE64] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('images[0] could not be decoded');
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('accepts a bare base64 image and defaults the content type to image/jpeg', async () => {
    stageAnalyzeDb(undefined);

    const event = makeEvent({
      body: JSON.stringify({ location: 'storeroom', images: [TINY_PNG_BASE64] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const s3Cmd = mockS3Send.mock.calls[0][0];
    expect(s3Cmd.__cmd).toBe('S3Put');
    expect(s3Cmd.ContentType).toBe('image/jpeg');
    expect(s3Cmd.Key).toMatch(/^stock-count\/\d{4}-\d{2}-\d{2}\/storeroom\/\d+-0\.jpg$/);
  });
});

describe('handlePlanogram — analyze with a stored reference photo', () => {
  it('fetches the reference from S3 and prepends it, labelled, to the AI input', async () => {
    process.env.PLANOGRAM_MOCK = 'false';
    stageAnalyzeDb({ s3Key: 'reference/fridge.jpg' });
    mockS3Send
      .mockResolvedValueOnce({}) // PutObject — the snapshot
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
      });
    mockBedrockSend.mockResolvedValueOnce(
      bedrockReply('Here you go: [{"name":"Oat Milk","count":2,"confidence":"high"}]')
    );

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).counts).toEqual([
      { name: 'Oat Milk', count: 2, confidence: 'high' },
    ]);

    // Second S3 call is the reference GetObject against the same bucket.
    const refGet = mockS3Send.mock.calls[1][0];
    expect(refGet.__cmd).toBe('S3Get');
    expect(refGet.Bucket).toBe('test-planogram-bucket');
    expect(refGet.Key).toBe('reference/fridge.jpg');

    // Order matters: label, reference image, today's photo, then the prompt.
    const content = bedrockContent();
    expect(content).toHaveLength(4);
    expect(content[0]).toEqual({
      type: 'text',
      text: 'REFERENCE IMAGE (ideal arrangement):',
    });
    expect(content[1].type).toBe('image');
    expect(content[1].source.data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(content[2].source.media_type).toBe('image/png');
    expect(content[3].text).toContain('fridge');
  });

  it('carries on without the reference when the S3 fetch throws', async () => {
    process.env.PLANOGRAM_MOCK = 'false';
    stageAnalyzeDb({ s3Key: 'reference/fridge.jpg' });
    mockS3Send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('NoSuchKey'));
    mockBedrockSend.mockResolvedValueOnce(bedrockReply('[]'));

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);

    // Just the photo and the prompt — no reference label.
    const content = bedrockContent();
    expect(content).toHaveLength(2);
    expect(JSON.stringify(content)).not.toContain('REFERENCE IMAGE');
  });

  it('carries on without the reference when the object body is empty', async () => {
    process.env.PLANOGRAM_MOCK = 'false';
    stageAnalyzeDb({ s3Key: 'reference/storeroom.jpg' });
    mockS3Send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => undefined } });
    mockBedrockSend.mockResolvedValueOnce(bedrockReply('[]'));

    const event = makeEvent({
      body: JSON.stringify({ location: 'storeroom', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(bedrockContent()).toHaveLength(2);
  });
});

describe('analyzeStock via handlePlanogram — live Bedrock path', () => {
  it('sends the model id, the images and a prompt naming the location and ingredients', async () => {
    process.env.PLANOGRAM_MOCK = 'false';
    mockDbSend
      .mockResolvedValueOnce({
        Items: [
          {
            ingredientId: 'ing-1',
            name: 'Oat Milk',
            unit: 'carton',
            usageUnit: 'ml',
            storageLocation: 'FRIDGE',
          },
          { ingredientId: 'ing-2', name: 'Sugar', unit: 'kg', storageLocation: 'STOREROOM' },
        ],
      })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({});
    mockBedrockSend.mockResolvedValueOnce(
      bedrockReply('[{"name":"Oat Milk","count":0.7,"confidence":"low","notes":"hazy"}]')
    );

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).counts).toEqual([
      { name: 'Oat Milk', count: 0.7, confidence: 'low', notes: 'hazy' },
    ]);

    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    const cmd = mockBedrockSend.mock.calls[0][0];
    expect(cmd.__cmd).toBe('Invoke');
    expect(cmd.modelId).toBe('global.anthropic.claude-sonnet-4-6');
    expect(cmd.contentType).toBe('application/json');

    const payload = JSON.parse(cmd.body);
    expect(payload.anthropic_version).toBe('bedrock-2023-05-31');
    expect(payload.max_tokens).toBe(1000);

    // Only the FRIDGE ingredient reaches the prompt; the storeroom one must not.
    const prompt = payload.messages[0].content.at(-1).text;
    expect(prompt).toContain('- Oat Milk (stored in carton, usage: ml)');
    expect(prompt).not.toContain('Sugar');
    expect(prompt).toContain('fridge');

    // The log Put still records the parsed result.
    expect(mockDbSend.mock.calls[2][0].__cmd).toBe('DbPut');
    expect(mockDbSend.mock.calls[2][0].Item.result).toEqual([
      { name: 'Oat Milk', count: 0.7, confidence: 'low', notes: 'hazy' },
    ]);
  });

  it('falls back to n/a in the prompt for an ingredient with no usageUnit', async () => {
    process.env.PLANOGRAM_MOCK = 'false';
    mockDbSend
      .mockResolvedValueOnce({
        Items: [{ ingredientId: 'ing-9', name: 'Beans', unit: 'bag', storageLocation: 'STOREROOM' }],
      })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({});
    mockBedrockSend.mockResolvedValueOnce(bedrockReply('[]'));

    const event = makeEvent({
      body: JSON.stringify({ location: 'storeroom', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    const prompt = JSON.parse(mockBedrockSend.mock.calls[0][0].body).messages[0].content.at(-1).text;
    expect(prompt).toContain('- Beans (stored in bag, usage: n/a)');
  });

  it('returns [] when the model reply contains no JSON array', async () => {
    process.env.PLANOGRAM_MOCK = 'false';
    stageAnalyzeDb(undefined);
    mockBedrockSend.mockResolvedValueOnce(bedrockReply('I cannot see anything in these photos.'));

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).counts).toEqual([]);
  });

  it('returns [] when the bracketed text is not valid JSON', async () => {
    process.env.PLANOGRAM_MOCK = 'false';
    stageAnalyzeDb(undefined);
    mockBedrockSend.mockResolvedValueOnce(bedrockReply('[{name: Oat Milk, count: oops}]'));

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).counts).toEqual([]);
  });

  it('returns [] when the model reply has no content block', async () => {
    process.env.PLANOGRAM_MOCK = 'false';
    stageAnalyzeDb(undefined);
    mockBedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(JSON.stringify({ stopReason: 'max_tokens' })),
    });

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).counts).toEqual([]);
  });
});

describe('handlePlanogram — failures become a 500', () => {
  it('reports the error message when a DynamoDB call rejects', async () => {
    mockDbSend.mockRejectedValueOnce(
      Object.assign(new Error('Requested resource not found'), {
        name: 'ResourceNotFoundException',
      })
    );

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Requested resource not found' });
  });

  it('reports the error message when the S3 upload rejects', async () => {
    mockS3Send.mockReset();
    mockS3Send.mockRejectedValueOnce(new Error('AccessDenied'));

    const event = makeEvent({
      path: '/api/admin/planogram/reference',
      body: JSON.stringify({ location: 'fridge', image: TINY_PNG_DATA_URL }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('AccessDenied');
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rethrows a non-conditional log-update failure as a 500', async () => {
    mockDbSend
      .mockResolvedValueOnce({}) // ingredient update
      .mockRejectedValueOnce(
        Object.assign(new Error('throughput exceeded'), {
          name: 'ProvisionedThroughputExceededException',
        })
      );

    const event = makeEvent({
      path: '/api/pos/planogram/confirm',
      body: JSON.stringify({
        logId: '2026-06-09#999',
        counts: [{ ingredientId: 'ing-1', count: 1 }],
      }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('throughput exceeded');
  });

  it('falls back to "Internal error" when a non-Error is thrown', async () => {
    mockDbSend.mockRejectedValueOnce('a bare string, not an Error');

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Internal error' });
  });

  // CHARACTERISATION TEST — documents a bug, does not endorse it.
  //
  // planogram.ts:27 parses the body OUTSIDE the try/catch that begins at :29,
  // so a malformed body escapes the handler entirely instead of becoming the
  // 500 that every other failure here produces. src/index.ts has no outer
  // try/catch either, so the throw reaches the Lambda runtime and API Gateway
  // answers a bare 502 with no CORS headers — the browser sees a network error
  // rather than a JSON error body.
  //
  // Expected: 400 { error: 'Invalid JSON body' } (or at minimum the 500).
  // The same pattern is in admin.ts:37, checklist.ts:11, push.ts:33/:60 and
  // pos.ts:1367. When it is fixed, flip this assertion.
  it('THROWS instead of returning a response on a malformed JSON body', async () => {
    const event = makeEvent({ body: '{not json' });
    await expect(handlePlanogram(event)).rejects.toThrow(SyntaxError);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

describe('handlePlanogram — unmatched routes', () => {
  it('returns 404 for an unknown planogram path', async () => {
    const event = makeEvent({ httpMethod: 'GET', path: '/api/pos/planogram/history', body: null });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: 'Not found' });
  });

  it('returns 404 for the right path under the wrong method', async () => {
    const event = makeEvent({ httpMethod: 'GET', path: '/api/pos/planogram/analyze', body: null });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(404);
  });
});

describe('handlePlanogram — analyze mock fixture shapes', () => {
  it('treats a Scan with no Items key as an empty ingredient list', async () => {
    mockDbSend
      .mockResolvedValueOnce({}) // Scan — no Items key at all
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({});

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).ingredients).toEqual([]);
  });

  it('accepts a fixture that is a bare array rather than a { counts } envelope', async () => {
    process.env.PLANOGRAM_MOCK_FIXTURE_PATH = BARE_ARRAY_FIXTURE;
    stageAnalyzeDb(undefined);

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).counts).toEqual([
      { name: 'Bare Array Item', count: 2, confidence: 'high' },
    ]);
  });

  it('falls back to the bundled fixture when PLANOGRAM_MOCK_FIXTURE_PATH is unset', async () => {
    delete process.env.PLANOGRAM_MOCK_FIXTURE_PATH;
    stageAnalyzeDb(undefined);

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    // The bundled default is tests/fixtures/planogram/mock-response.json.
    expect(JSON.parse(result.body).counts).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Oat Milk', count: 3 })])
    );
  });

  it('returns [] when the fixture parses but is neither an array nor an envelope', async () => {
    // Any valid JSON object with no `counts` array will do; package.json saves
    // committing a deliberately-wrong fixture just to prove the guard holds.
    process.env.PLANOGRAM_MOCK_FIXTURE_PATH = path.join(__dirname, '..', 'package.json');
    stageAnalyzeDb(undefined);

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).counts).toEqual([]);
  });
});

describe('handlePlanogram — analyze with empty fixture (degraded path)', () => {
  it('returns counts: [] when the fixture cannot be read', async () => {
    const original = process.env.PLANOGRAM_MOCK_FIXTURE_PATH;
    process.env.PLANOGRAM_MOCK_FIXTURE_PATH = '/no/such/file/exists.json';

    // Reset modules so planogram.ts re-imports fs with the new env.
    jest.resetModules();
    // Re-register module mocks for the freshly-loaded module.
    jest.doMock('@aws-sdk/client-s3', () => ({
      S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
      PutObjectCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Put' })),
      GetObjectCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'S3Get' })),
    }));
    jest.doMock('@aws-sdk/client-bedrock-runtime', () => ({
      BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
      InvokeModelCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Invoke' })),
    }));
    jest.doMock('@aws-sdk/s3-request-presigner', () => ({
      getSignedUrl: (...args: any[]) => mockGetSignedUrl(...args),
    }));
    jest.doMock('../src/lib/db', () => ({
      docClient: { send: mockDbSend },
      SETTINGS_TABLE: 'test-settings',
      INGREDIENTS_TABLE: 'test-ingredients',
      GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'DbGet' })),
      PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'DbPut' })),
      ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'DbScan' })),
      UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'DbUpdate' })),
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handlePlanogram: freshHandler } = require('../src/routes/planogram');

    mockDbSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({});

    const event = makeEvent({
      body: JSON.stringify({ location: 'fridge', images: [TINY_PNG_DATA_URL] }),
    });
    const result = await freshHandler(event);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.counts).toEqual([]);
    expect(body.logId).toBeTruthy();

    // Restore for any later tests.
    process.env.PLANOGRAM_MOCK_FIXTURE_PATH = original;
    jest.resetModules();
  });
});

describe('handlePlanogram — confirm', () => {
  it('updates ingredient stocks and stamps confirmedAt on the log', async () => {
    // Each ingredient update + the final log update.
    mockDbSend.mockResolvedValue({});

    const event = makeEvent({
      path: '/api/pos/planogram/confirm',
      body: JSON.stringify({
        logId: '2026-06-09#1717920000000',
        counts: [
          { ingredientId: 'ing-1', count: 3 },
          { ingredientId: 'ing-2', count: 0.7 },
        ],
      }),
    });

    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      updated: 2,
      logId: '2026-06-09#1717920000000',
    });

    // 2 ingredient updates + 1 log update = 3 calls.
    expect(mockDbSend).toHaveBeenCalledTimes(3);

    const ingUpdate1 = mockDbSend.mock.calls[0][0];
    expect(ingUpdate1.TableName).toBe('test-ingredients');
    expect(ingUpdate1.Key.PK).toBe('INGREDIENT#ing-1');
    expect(ingUpdate1.ExpressionAttributeValues[':s']).toBe(3);

    const logUpdate = mockDbSend.mock.calls[2][0];
    expect(logUpdate.TableName).toBe('test-settings');
    expect(logUpdate.Key.PK).toBe('PLANOGRAM_LOG#2026-06-09#1717920000000');
    expect(logUpdate.UpdateExpression).toContain('confirmedAt');
    expect(logUpdate.ConditionExpression).toContain('attribute_exists');
  });

  it('skips rows without ingredientId', async () => {
    mockDbSend.mockResolvedValue({});

    const event = makeEvent({
      path: '/api/pos/planogram/confirm',
      body: JSON.stringify({
        counts: [
          { ingredientId: 'ing-1', count: 5 },
          { name: 'Unknown thing', count: 2 }, // no ingredientId → skipped
          { ingredientId: 'ing-2' }, // no count → skipped
        ],
      }),
    });

    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);

    // Only one ingredient update, no log update (no logId provided).
    expect(mockDbSend).toHaveBeenCalledTimes(1);
    expect(mockDbSend.mock.calls[0][0].Key.PK).toBe('INGREDIENT#ing-1');
  });

  it('silently no-ops the log update when the record is missing', async () => {
    const conditionalErr = Object.assign(new Error('cond fail'), {
      name: 'ConditionalCheckFailedException',
    });
    mockDbSend
      .mockResolvedValueOnce({}) // ingredient update
      .mockRejectedValueOnce(conditionalErr); // log update fails

    const event = makeEvent({
      path: '/api/pos/planogram/confirm',
      body: JSON.stringify({
        logId: '2026-06-09#999',
        counts: [{ ingredientId: 'ing-1', count: 1 }],
      }),
    });

    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).updated).toBe(1);
  });

  it('rejects non-array counts with 400', async () => {
    const event = makeEvent({
      path: '/api/pos/planogram/confirm',
      body: JSON.stringify({ counts: 'not-an-array' }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

describe('handlePlanogram — reference upload', () => {
  it('uploads the image to S3 and records the metadata', async () => {
    mockDbSend.mockResolvedValue({});

    const event = makeEvent({
      path: '/api/admin/planogram/reference',
      body: JSON.stringify({ location: 'fridge', image: TINY_PNG_DATA_URL }),
    });

    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      location: 'fridge',
      s3Key: 'reference/fridge.jpg',
    });

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0].Key).toBe('reference/fridge.jpg');
    expect(mockS3Send.mock.calls[0][0].ContentType).toBe('image/png');

    expect(mockDbSend).toHaveBeenCalledTimes(1);
    const dbCall = mockDbSend.mock.calls[0][0];
    expect(dbCall.Item.PK).toBe('PLANOGRAM_REF#fridge');
    expect(dbCall.Item.s3Key).toBe('reference/fridge.jpg');
  });

  it('rejects unknown location', async () => {
    const event = makeEvent({
      path: '/api/admin/planogram/reference',
      body: JSON.stringify({ location: 'kitchen', image: TINY_PNG_DATA_URL }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects missing image', async () => {
    const event = makeEvent({
      path: '/api/admin/planogram/reference',
      body: JSON.stringify({ location: 'storeroom' }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
  });

  it('accepts a bare base64 image and defaults the content type to image/jpeg', async () => {
    mockDbSend.mockResolvedValue({});

    const event = makeEvent({
      path: '/api/admin/planogram/reference',
      body: JSON.stringify({ location: 'storeroom', image: TINY_PNG_BASE64 }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).s3Key).toBe('reference/storeroom.jpg');
    expect(mockS3Send.mock.calls[0][0].ContentType).toBe('image/jpeg');
    expect(mockDbSend.mock.calls[0][0].Item.PK).toBe('PLANOGRAM_REF#storeroom');
  });

  it('rejects an image whose base64 decodes to zero bytes with 400', async () => {
    const event = makeEvent({
      path: '/api/admin/planogram/reference',
      body: JSON.stringify({
        location: 'fridge',
        image: `data:image/png;base64,${UNDECODABLE_BASE64}`,
      }),
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('image could not be decoded');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

describe('handlePlanogram — reference get', () => {
  it('returns a presigned URL for an existing reference', async () => {
    mockDbSend.mockResolvedValueOnce({
      Item: { s3Key: 'reference/fridge.jpg', uploadedAt: '2026-06-01T00:00:00Z' },
    });

    const event = makeEvent({
      httpMethod: 'GET',
      path: '/api/pos/planogram/reference/fridge',
      body: null,
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toEqual({
      location: 'fridge',
      url: 'https://signed.example/url',
      uploadedAt: '2026-06-01T00:00:00Z',
    });
    expect(mockGetSignedUrl).toHaveBeenCalled();
  });

  it('returns 404 when no reference is stored', async () => {
    mockDbSend.mockResolvedValueOnce({ Item: undefined });

    const event = makeEvent({
      httpMethod: 'GET',
      path: '/api/pos/planogram/reference/storeroom',
      body: null,
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(404);
  });

  it('returns 404 when the location regex does not match', async () => {
    const event = makeEvent({
      httpMethod: 'GET',
      path: '/api/pos/planogram/reference/pantry',
      body: null,
    });
    const result = await handlePlanogram(event);
    expect(result.statusCode).toBe(404);
  });
});
