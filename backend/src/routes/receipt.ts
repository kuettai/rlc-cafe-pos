import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { docClient, ORDERS_TABLE, GetCommand, UpdateCommand } from '../lib/db';

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-southeast-5' });
const RECEIPTS_BUCKET = process.env.RECEIPTS_BUCKET || 'rlc-cafe-receipts';

function res(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function handleReceipt(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  try {
    // POST /api/orders/{id}/receipt — customer uploads receipt
    if (method === 'POST' && path.match(/\/api\/orders\/[^/]+\/receipt$/)) {
      const parts = path.split('/');
      const orderId = parts[parts.indexOf('orders') + 1];
      if (!orderId) return res(400, { error: 'Missing order ID' });

      const body = event.body || '';
      const contentType = event.headers?.['Content-Type'] || event.headers?.['content-type'] || 'application/json';

      let imageData: Buffer;
      let imageContentType: string;

      if (contentType.includes('application/json')) {
        const json = JSON.parse(body);
        if (!json.image) return res(400, { error: 'Missing image data' });
        const base64Match = json.image.match(/^data:([^;]+);base64,(.+)$/);
        if (base64Match) {
          imageContentType = base64Match[1];
          imageData = Buffer.from(base64Match[2], 'base64');
        } else {
          imageData = Buffer.from(json.image, 'base64');
          imageContentType = 'image/jpeg';
        }
      } else {
        imageData = Buffer.from(body, event.isBase64Encoded ? 'base64' : 'utf-8');
        imageContentType = contentType;
      }

      // Get the order to check total
      const orderResult = await docClient.send(new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: `ORDER#${orderId}`, SK: 'META' },
      }));
      const order = orderResult.Item;
      if (!order) return res(404, { error: 'Order not found' });
      if (order.status !== 'PENDING') return res(400, { error: 'Order is not pending' });

      // Upload to S3
      const s3Key = `receipts/${orderId}/${Date.now()}.jpg`;
      await s3.send(new PutObjectCommand({
        Bucket: RECEIPTS_BUCKET,
        Key: s3Key,
        Body: imageData,
        ContentType: imageContentType,
      }));

      // Call Bedrock to extract amount
      const extractResult = await extractReceiptAmount(imageData, imageContentType);

      if (!extractResult.amount) {
        return res(400, { error: 'Could not read payment amount from receipt. Please upload a clearer screenshot.' });
      }

      // Check if amount matches order total
      const orderTotal = order.totalAmount || 0;
      const tolerance = 0.01;
      if (Math.abs(extractResult.amount - orderTotal) > tolerance) {
        return res(400, {
          error: `Payment amount (RM ${extractResult.amount.toFixed(2)}) doesn't match order total (RM ${orderTotal.toFixed(2)}). Please upload the correct receipt.`,
          extractedAmount: extractResult.amount,
          expectedAmount: orderTotal,
        });
      }

      // Update order with receipt info
      const receiptUrl = `s3://${RECEIPTS_BUCKET}/${s3Key}`;
      await docClient.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: `ORDER#${orderId}`, SK: 'META' },
        UpdateExpression: 'SET receiptUrl = :url, receiptAmount = :amt, receiptDate = :dt, receiptUploadedAt = :now',
        ExpressionAttributeValues: {
          ':url': receiptUrl,
          ':amt': extractResult.amount,
          ':dt': extractResult.date || null,
          ':now': new Date().toISOString(),
        },
      }));

      return res(200, {
        success: true,
        receiptAmount: extractResult.amount,
        receiptDate: extractResult.date,
        message: 'Receipt uploaded successfully. The cashier will verify your payment shortly.',
      });
    }

    // GET /api/orders/{id}/receipt — get presigned URL to view receipt
    if (method === 'GET' && path.match(/\/api\/orders\/[^/]+\/receipt$/)) {
      const parts = path.split('/');
      const orderId = parts[parts.indexOf('orders') + 1];

      const orderResult = await docClient.send(new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: `ORDER#${orderId}`, SK: 'META' },
      }));
      const order = orderResult.Item;
      if (!order || !order.receiptUrl) return res(404, { error: 'No receipt found' });

      const s3Key = order.receiptUrl.replace(`s3://${RECEIPTS_BUCKET}/`, '');
      const presignedUrl = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: RECEIPTS_BUCKET,
        Key: s3Key,
      }), { expiresIn: 3600 });

      return res(200, {
        receiptUrl: presignedUrl,
        receiptAmount: order.receiptAmount,
        receiptDate: order.receiptDate,
      });
    }

    // POST /api/orders/{id}/receipt/upload-url — get presigned PUT URL for direct upload
    if (method === 'POST' && path.match(/\/api\/orders\/[^/]+\/receipt\/upload-url$/)) {
      const parts = path.split('/');
      const orderId = parts[parts.indexOf('orders') + 1];
      const s3Key = `receipts/${orderId}/${Date.now()}.jpg`;

      const { PutObjectCommand: PutCmd } = await import('@aws-sdk/client-s3');
      const putUrl = await getSignedUrl(s3, new PutObjectCommand({
        Bucket: RECEIPTS_BUCKET,
        Key: s3Key,
        ContentType: 'image/jpeg',
      }), { expiresIn: 300 });

      return res(200, { uploadUrl: putUrl, s3Key });
    }

    return res(404, { error: 'Not found' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return res(500, { error: message });
  }
}

async function extractReceiptAmount(imageData: Buffer, contentType: string): Promise<{ amount: number | null; date: string | null }> {
  const mediaType = contentType.includes('png') ? 'image/png' : 'image/jpeg';

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: imageData.toString('base64'),
          },
        },
        {
          type: 'text',
          text: `Extract the payment amount and date/time from this DuitNow/bank transfer receipt screenshot.
Return ONLY a JSON object: {"amount": <number>, "date": "<YYYY-MM-DD HH:mm>"}
If you cannot determine the amount, return: {"amount": null, "date": null}
Do not include any other text, just the JSON.`,
        },
      ],
    }],
  };

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: 'global.anthropic.claude-sonnet-4-6',
    body: JSON.stringify(payload),
    contentType: 'application/json',
  }));

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const text = responseBody.content?.[0]?.text || '';

  try {
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        amount: typeof parsed.amount === 'number' ? parsed.amount : null,
        date: parsed.date || null,
      };
    }
  } catch {}

  return { amount: null, date: null };
}
