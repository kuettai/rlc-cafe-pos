// display.ts — TV display screen endpoints
// Both routes require a valid Bearer token (any role) — wired in
// index.ts AFTER the auth check. Data returned is intentionally minimal
// (customer names, slide URLs) so a shoulder-surfer at the TV can't see
// sensitive order info.

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  docClient, ORDERS_TABLE, SETTINGS_TABLE,
  QueryCommand, ScanCommand,
} from '../lib/db';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Reused across Lambda invocations. Region is picked up from
// AWS_REGION (auto-set by the runtime).
const s3 = new S3Client({});
const BUCKET = process.env.FRONTEND_BUCKET || '';

function res(statusCode: number, body: object): APIGatewayProxyResult {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function handleDisplay(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  try {
    // GET /api/display/orders — READY orders only (name + orderId + readyAt).
    // Sorted newest-ready first so the "hero" slots show the most recent
    // ready orders (customers who just heard their name still linger).
    // Cap at 13 = 3 hero + 10 compact grid.
    if (method === 'GET' && path === '/api/display/orders') {
      const result = await docClient.send(new QueryCommand({
        TableName: ORDERS_TABLE,
        IndexName: 'status-createdAt-index',
        KeyConditionExpression: '#s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':status': 'READY' },
      }));

      const orders = (result.Items || [])
        .map(o => ({
          orderId: o.orderId,
          customerName: o.customerName,
          readyAt: o.readyAt || o.updatedAt || o.createdAt,
        }))
        .sort((a, b) => (b.readyAt || '').localeCompare(a.readyAt || ''))
        .slice(0, 13);

      return res(200, { orders });
    }

    // GET /api/display/slides — active promo slides.
    // "Active" = today (UTC date) falls within [startDate, expiryDate]
    // inclusive. Sorted by sortOrder ascending so admin can pin a
    // seasonal slide to the top.
    if (method === 'GET' && path === '/api/display/slides') {
      const today = new Date().toISOString().split('T')[0];
      const result = await docClient.send(new ScanCommand({
        TableName: SETTINGS_TABLE,
        FilterExpression: 'begins_with(PK, :prefix)',
        ExpressionAttributeValues: { ':prefix': 'DISPLAY_SLIDE#' },
      }));

      const active = (result.Items || [])
        .filter(s => s.startDate <= today && s.expiryDate >= today)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

      // Sign a short-lived GET URL per slide. Bucket is private (see
      // infra-stack.ts); 1-hour expiry is well beyond the display
      // page's 60s slide-list refresh interval, so the <img src>
      // always sees a fresh URL. Skips signing (returns null URL) if
      // FRONTEND_BUCKET isn't configured — the display page hides
      // slides with a falsy imageUrl.
      const slides = await Promise.all(active.map(async s => {
        const raw: string = s.imageUrl || '';
        // imageUrl is stored as "/display-slides/<file>" — strip the
        // leading slash to get the S3 key.
        const key = raw.startsWith('/') ? raw.slice(1) : raw;
        let imageUrl = '';
        if (BUCKET && key) {
          imageUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET, Key: key }),
            { expiresIn: 3600 },
          );
        }
        return { slideId: s.slideId, imageUrl, title: s.title || '' };
      }));

      return res(200, { slides });
    }

    return res(404, { error: 'Not found' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return res(500, { error: message });
  }
}
