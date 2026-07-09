import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomBytes } from 'crypto';
import {
  docClient, SETTINGS_TABLE,
  GetCommand, PutCommand, ScanCommand, UpdateCommand, DeleteCommand,
} from '../lib/db';

const res = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// Ambiguity-free base32-ish alphabet: no 0/O, 1/I/L, uppercase only.
// 30 symbols × 8 chars = 30^8 ≈ 6.5×10¹¹ combos — plenty for our scale.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateCode(): string {
  const buf = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  }
  return code;
}

function pk(code: string): string { return `PREORDER_CODE#${code}`; }

const PREORDER_URL_BASE = 'https://153.oasisofcare.org';

/**
 * Compute service-end-time as the given YYYY-MM-DD at 15:00 MYT (UTC+8),
 * stored as an ISO string (UTC). MYT has no DST so a fixed offset is safe.
 */
function computeServiceEndTime(serviceDate: string): string {
  // 15:00 MYT == 07:00 UTC on the same calendar date.
  return `${serviceDate}T07:00:00.000Z`;
}

export interface PreorderCode {
  PK: string;
  SK: string;
  code: string;
  name: string;
  opensAt: string;
  expiresAt: string;
  serviceDate: string;
  serviceEndTime: string;
  createdAt: string;
  createdBy: string;
  isActive: boolean;
  // ─── Customizable per-campaign fields ──────────────────────────────
  // Optional; when absent the frontend falls back to defaults.
  bannerMessage?: string;               // banner override; max 200 chars; supports {$SUNDAY}
  drinksDescription?: string;           // free-text list shown below banner; max 500 chars
  eligibleItems?: string[];             // whitelist of menuItemIds; empty/undefined = all active drinks
  collectionOptions?: string[];         // choices for the collection-time radios
}

// Server-side defaults for the two-option collection picker.
export const DEFAULT_COLLECTION_OPTIONS: string[] = ['After 1st Service', 'After 2nd Service'];

/**
 * Format "Sunday, D MMM" for the next Sunday in Malaysia time (UTC+8).
 * If today (in MYT) is already Sunday, returns today. Independent of the
 * campaign's stored serviceDate — this is a view-time-relative resolution
 * per the spec, so a customer viewing the page sees the upcoming Sunday
 * regardless of when the admin created the code.
 */
function resolveNextSundayLabel(now: Date = new Date()): string {
  // Shift into MYT wall-clock so weekday math is done in the café's TZ.
  const mytMs = now.getTime() + 8 * 60 * 60 * 1000;
  const mytNow = new Date(mytMs);
  const dow = mytNow.getUTCDay(); // 0 = Sunday
  const daysUntilSun = (7 - dow) % 7; // 0 when today IS Sunday
  const target = new Date(mytMs + daysUntilSun * 24 * 60 * 60 * 1000);
  const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][target.getUTCMonth()];
  return `Sunday, ${target.getUTCDate()} ${monthShort}`;
}

/** Replace all `{$SUNDAY}` occurrences with the resolved label. Empty/undefined passes through. */
function resolveTemplate(text: string | undefined | null): string {
  if (!text) return '';
  if (!text.includes('{$SUNDAY}')) return text;
  const label = resolveNextSundayLabel();
  return text.replace(/\{\$SUNDAY\}/g, label);
}

/**
 * Validate a code against the current time. Returned reasons match the
 * validate endpoint contract.
 */
export type PreorderValidation =
  | { valid: true; code: PreorderCode }
  | { valid: false; reason: 'invalid' | 'expired' | 'not_yet' };

export async function validatePreorderCode(code: string, now: Date = new Date()): Promise<PreorderValidation> {
  if (!code || typeof code !== 'string') return { valid: false, reason: 'invalid' };
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { valid: false, reason: 'invalid' };

  const r = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: pk(trimmed), SK: 'META' },
  }));
  const item = r.Item as PreorderCode | undefined;
  if (!item || item.isActive === false) return { valid: false, reason: 'invalid' };

  const nowIso = now.toISOString();
  if (item.opensAt && nowIso < item.opensAt) return { valid: false, reason: 'not_yet' };
  if (item.expiresAt && nowIso > item.expiresAt) return { valid: false, reason: 'expired' };

  return { valid: true, code: item };
}

// ─── Public: validate ────────────────────────────────────────────────

export async function handleValidatePreorder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;
  if (method !== 'GET' || !path.endsWith('/preorder/validate')) {
    return res(404, { error: 'Not found' });
  }
  const code = event.queryStringParameters?.code || '';
  const v = await validatePreorderCode(code);
  if (v.valid) {
    return res(200, {
      valid: true,
      name: v.code.name,
      opensAt: v.code.opensAt,
      expiresAt: v.code.expiresAt,
      serviceDate: v.code.serviceDate,
      // Template variables ({$SUNDAY}) resolved server-side so the frontend
      // just renders the string. Both fields resolve; either can be empty.
      bannerMessage: resolveTemplate(v.code.bannerMessage),
      drinksDescription: resolveTemplate(v.code.drinksDescription),
      // Empty array (never null) so the client can rely on Array.isArray().
      eligibleItems: Array.isArray(v.code.eligibleItems) ? v.code.eligibleItems : [],
      collectionOptions:
        Array.isArray(v.code.collectionOptions) && v.code.collectionOptions.length
          ? v.code.collectionOptions
          : DEFAULT_COLLECTION_OPTIONS,
    });
  }
  return res(400, { valid: false, reason: v.reason });
}

// ─── Admin: CRUD ─────────────────────────────────────────────────────

async function createPreorderCode(event: APIGatewayProxyEvent, actor: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const opensAt = typeof body.opensAt === 'string' ? body.opensAt : '';
  const expiresAt = typeof body.expiresAt === 'string' ? body.expiresAt : '';
  const serviceDate = typeof body.serviceDate === 'string' ? body.serviceDate.trim() : '';

  if (!name)        return res(400, { error: 'name is required' });
  if (!opensAt)     return res(400, { error: 'opensAt is required (ISO datetime)' });
  if (!expiresAt)   return res(400, { error: 'expiresAt is required (ISO datetime)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) return res(400, { error: 'serviceDate must be YYYY-MM-DD' });
  if (Date.parse(opensAt) >= Date.parse(expiresAt)) return res(400, { error: 'expiresAt must be after opensAt' });

  // Optional customization fields. All normalized here so the DB record is
  // always well-shaped even if the caller sent weird input.
  const rawBanner = typeof body.bannerMessage === 'string' ? body.bannerMessage.trim() : '';
  if (rawBanner.length > 200) return res(400, { error: 'bannerMessage cannot exceed 200 characters' });
  const bannerMessage = rawBanner;

  const rawDrinks = typeof body.drinksDescription === 'string' ? body.drinksDescription.trim() : '';
  if (rawDrinks.length > 500) return res(400, { error: 'drinksDescription cannot exceed 500 characters' });
  const drinksDescription = rawDrinks;

  const rawEligible: unknown[] = Array.isArray(body.eligibleItems) ? body.eligibleItems : [];
  // Store as unique, trimmed, non-empty strings. Empty list = "all drinks".
  const eligibleItems: string[] = Array.from(new Set(
    rawEligible
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim())
  ));

  const rawOpts: unknown[] = Array.isArray(body.collectionOptions) ? body.collectionOptions : [];
  const cleanedOpts: string[] = rawOpts
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim().slice(0, 60));
  const collectionOptions: string[] = cleanedOpts.length ? cleanedOpts : DEFAULT_COLLECTION_OPTIONS.slice();

  // Retry generation on the (astronomically unlikely) collision.
  let code = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    const existing = await docClient.send(new GetCommand({
      TableName: SETTINGS_TABLE,
      Key: { PK: pk(candidate), SK: 'META' },
    }));
    if (!existing.Item) { code = candidate; break; }
  }
  if (!code) return res(500, { error: 'Failed to allocate a unique code — try again' });

  const now = new Date().toISOString();
  const item: PreorderCode = {
    PK: pk(code),
    SK: 'META',
    code,
    name,
    opensAt,
    expiresAt,
    serviceDate,
    serviceEndTime: computeServiceEndTime(serviceDate),
    createdAt: now,
    createdBy: actor || 'Unknown',
    isActive: true,
    bannerMessage,
    drinksDescription,
    eligibleItems,
    collectionOptions,
  };

  await docClient.send(new PutCommand({ TableName: SETTINGS_TABLE, Item: item }));

  return res(201, {
    ...item,
    link: `${PREORDER_URL_BASE}/?code=${encodeURIComponent(code)}`,
  });
}

async function listPreorderCodes(): Promise<APIGatewayProxyResult> {
  const scan = await docClient.send(new ScanCommand({
    TableName: SETTINGS_TABLE,
    FilterExpression: 'begins_with(PK, :prefix)',
    ExpressionAttributeValues: { ':prefix': 'PREORDER_CODE#' },
  }));
  const codes = (scan.Items || [])
    .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map((it: any) => ({
      ...it,
      link: `${PREORDER_URL_BASE}/?code=${encodeURIComponent(it.code)}`,
    }));
  return res(200, { codes });
}

async function deactivatePreorderCode(code: string): Promise<APIGatewayProxyResult> {
  if (!code) return res(400, { error: 'code required' });
  const existing = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: pk(code), SK: 'META' },
  }));
  if (!existing.Item) return res(404, { error: 'code not found' });

  // Soft-deactivate rather than delete — keeps audit trail of used links.
  await docClient.send(new UpdateCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: pk(code), SK: 'META' },
    UpdateExpression: 'SET isActive = :f',
    ExpressionAttributeValues: { ':f': false },
  }));
  return res(200, { code, isActive: false });
}

async function hardDeletePreorderCode(code: string): Promise<APIGatewayProxyResult> {
  // Hard-delete via a query param for cleanup convenience.
  if (!code) return res(400, { error: 'code required' });
  await docClient.send(new DeleteCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: pk(code), SK: 'META' },
  }));
  return res(200, { code, deleted: true });
}

/**
 * Path style: /api/admin/preorder-codes[/<code>[?hard=1]]
 * - POST   /api/admin/preorder-codes            → create
 * - GET    /api/admin/preorder-codes            → list
 * - DELETE /api/admin/preorder-codes/<code>     → deactivate (soft)
 * - DELETE /api/admin/preorder-codes/<code>?hard=1 → hard delete
 */
export async function handleAdminPreorder(event: APIGatewayProxyEvent, actor: string): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  try {
    if (method === 'POST' && path.endsWith('/admin/preorder-codes')) {
      return await createPreorderCode(event, actor);
    }
    if (method === 'GET' && path.endsWith('/admin/preorder-codes')) {
      return await listPreorderCodes();
    }
    const match = path.match(/\/admin\/preorder-codes\/([^/]+)$/);
    if (method === 'DELETE' && match) {
      const code = decodeURIComponent(match[1]).toUpperCase();
      if (event.queryStringParameters?.hard === '1') {
        return await hardDeletePreorderCode(code);
      }
      return await deactivatePreorderCode(code);
    }
    return res(404, { error: 'Not found' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return res(500, { error: message });
  }
}
