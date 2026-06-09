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
process.env.PLANOGRAM_MOCK_FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'planogram',
  'mock-response.json'
);
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

beforeEach(() => {
  mockS3Send.mockReset();
  mockBedrockSend.mockReset();
  mockDbSend.mockReset();
  mockGetSignedUrl.mockReset();

  // Default S3 / DB / signer responses — individual tests override as needed.
  mockS3Send.mockResolvedValue({});
  mockGetSignedUrl.mockResolvedValue('https://signed.example/url');
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
