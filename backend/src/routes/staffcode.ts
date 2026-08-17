/**
 * staffcode.ts — the customer-facing "staff link" (`?code=<CODE>`).
 *
 * A staff code lets a staff member order at the staff price (RM5 on drinks,
 * food at full price) without queueing for a cashier to select the class for
 * them. It is NOT a pre-order code and deliberately does not reuse
 * `PREORDER_CODE#`; the two disagree on every axis:
 *
 *   |                 | Ministry pre-order | Staff link          |
 *   | price           | free, RM0          | RM5 drinks          |
 *   | status          | PREPARING          | PENDING (approved)  |
 *   | café-open check | bypassed           | APPLIES             |
 *   | food            | drinks only        | allowed             |
 *   | expiry          | same-day ISO       | numeric TTL, date-gated |
 *
 * Single entry by design: the admin UI edits ONE staff code, so PUT is an
 * upsert that leaves exactly one `STAFF_CODE#` record behind. There is no
 * create/delete flow to get wrong.
 *
 * Residual risk, accepted knowingly by the café: a long-lived guessable code
 * means anyone holding the link can REQUEST the staff price. The cashier's
 * confirmation at approve time is the only real control — see
 * `revertRequestedClassPricing` in lib/pricing.ts.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  docClient, SETTINGS_TABLE,
  GetCommand, PutCommand, ScanCommand, DeleteCommand,
} from '../lib/db';

const res = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/**
 * Ambiguity-free alphabet: no 0/O, no 1/I/L. Staff codes are typed by hand off
 * a printed link or a WhatsApp message, so a misread character must not be
 * possible.
 */
export const STAFF_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const STAFF_CODE_MIN_LENGTH = 3;
export const STAFF_CODE_MAX_LENGTH = 16;
const STAFF_CODE_PREFIX = 'STAFF_CODE#';
const LABEL_MAX_LENGTH = 60;

function pk(code: string): string { return `${STAFF_CODE_PREFIX}${code}`; }

export interface StaffCodeRecord {
  PK: string;
  SK: string;
  code: string;
  label: string;
  isActive: boolean;
  /** YYYY-MM-DD, inclusive. Empty = unbounded on this side. */
  startDate: string;
  /** YYYY-MM-DD, inclusive. Empty = unbounded on this side. */
  endDate: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/** Uppercase + trim. Applied on BOTH write and lookup so the two always agree. */
export function normalizeStaffCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

/** True when every character is in the ambiguity-free alphabet and the length fits. */
export function isWellFormedStaffCode(code: string): boolean {
  if (code.length < STAFF_CODE_MIN_LENGTH || code.length > STAFF_CODE_MAX_LENGTH) return false;
  for (const ch of code) if (!STAFF_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * Today's calendar date in Malaysia time as YYYY-MM-DD.
 *
 * The date gate is a wall-clock decision made in the café, not in UTC: a code
 * ending "today" must stay valid until midnight local. MYT is UTC+8 with no
 * DST, so shifting the epoch by a fixed 8h and reading the UTC parts is exact.
 * Factored out (and taking `now`) so a test can pin the boundary.
 */
export function malaysiaToday(now: Date = new Date()): string {
  const myt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = myt.getUTCFullYear();
  const m = String(myt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(myt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type StaffCodeValidation =
  | { valid: true; code: StaffCodeRecord }
  | { valid: false; reason: 'invalid' | 'not_yet' | 'expired' };

/**
 * Validate a staff code for use on an order. Mirrors `validatePreorderCode`'s
 * shape so `createOrder` reads the same either way. Dates are INCLUSIVE at both
 * ends and compared against today in Malaysia time.
 */
export async function validateStaffCode(code: string, now: Date = new Date()): Promise<StaffCodeValidation> {
  const normalized = normalizeStaffCode(code);
  if (!normalized || !isWellFormedStaffCode(normalized)) return { valid: false, reason: 'invalid' };

  const r = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: pk(normalized), SK: 'META' },
  }));
  const item = r.Item as StaffCodeRecord | undefined;
  if (!item || item.isActive === false) return { valid: false, reason: 'invalid' };

  const today = malaysiaToday(now);
  if (item.startDate && today < item.startDate) return { valid: false, reason: 'not_yet' };
  if (item.endDate && today > item.endDate) return { valid: false, reason: 'expired' };

  return { valid: true, code: item };
}

// ─── Public: validate ────────────────────────────────────────────────

/**
 * GET /api/staff-code/validate?code=<CODE>
 *   200 { valid: true, code, label }
 *   400 { valid: false, reason }
 *
 * Contract is fixed — the customer page is written against it.
 */
export async function handleValidateStaffCode(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod !== 'GET' || !event.path.endsWith('/staff-code/validate')) {
    return res(404, { error: 'Not found' });
  }
  const v = await validateStaffCode(event.queryStringParameters?.code || '');
  if (v.valid) {
    return res(200, { valid: true, code: v.code.code, label: v.code.label || '' });
  }
  return res(400, { valid: false, reason: v.reason });
}

// ─── Admin: single-entry get/upsert ──────────────────────────────────

/** Scan the prefix and return the freshest record, or null. */
async function loadStaffCode(): Promise<StaffCodeRecord | null> {
  const scan = await docClient.send(new ScanCommand({
    TableName: SETTINGS_TABLE,
    FilterExpression: 'begins_with(PK, :prefix)',
    ExpressionAttributeValues: { ':prefix': STAFF_CODE_PREFIX },
  }));
  const items = (scan.Items || []) as StaffCodeRecord[];
  if (!items.length) return null;
  // Single-entry semantics mean there should only ever be one; if a partial
  // write ever left two behind, prefer the most recently touched.
  return items.sort((a, b) =>
    ((b.updatedAt || b.createdAt || '')).localeCompare(a.updatedAt || a.createdAt || '')
  )[0];
}

async function getStaffCode(): Promise<APIGatewayProxyResult> {
  return res(200, { staffCode: await loadStaffCode() });
}

async function putStaffCode(event: APIGatewayProxyEvent, actor: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');

  const code = normalizeStaffCode(body.code);
  if (!code) return res(400, { error: 'code is required' });
  if (code.length < STAFF_CODE_MIN_LENGTH || code.length > STAFF_CODE_MAX_LENGTH) {
    return res(400, { error: `code must be ${STAFF_CODE_MIN_LENGTH}-${STAFF_CODE_MAX_LENGTH} characters` });
  }
  if (!isWellFormedStaffCode(code)) {
    return res(400, { error: `code may only use ${STAFF_CODE_ALPHABET}` });
  }

  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (label.length > LABEL_MAX_LENGTH) {
    return res(400, { error: `label cannot exceed ${LABEL_MAX_LENGTH} characters` });
  }

  const startDate = typeof body.startDate === 'string' ? body.startDate.trim() : '';
  const endDate = typeof body.endDate === 'string' ? body.endDate.trim() : '';
  if (startDate && !DATE_RE.test(startDate)) return res(400, { error: 'startDate must be YYYY-MM-DD or empty' });
  if (endDate && !DATE_RE.test(endDate)) return res(400, { error: 'endDate must be YYYY-MM-DD or empty' });
  if (startDate && endDate && endDate < startDate) {
    return res(400, { error: 'endDate cannot be before startDate' });
  }

  // Default true so an admin saving the form without touching the toggle gets
  // a working link, matching how the pre-order create path behaves.
  const isActive = body.isActive === undefined ? true : !!body.isActive;

  // Preserve provenance when the code itself is unchanged; a new code is a new
  // link, so it gets a fresh createdAt/createdBy.
  const existing = await loadStaffCode();
  const now = new Date().toISOString();
  const sameCode = existing?.code === code;

  const item: StaffCodeRecord = {
    PK: pk(code),
    SK: 'META',
    code,
    label,
    isActive,
    startDate,
    endDate,
    createdAt: sameCode && existing?.createdAt ? existing.createdAt : now,
    createdBy: sameCode && existing?.createdBy ? existing.createdBy : (actor || 'Unknown'),
    updatedAt: now,
  };

  await docClient.send(new PutCommand({ TableName: SETTINGS_TABLE, Item: item }));

  // Single-entry semantics: sweep every other STAFF_CODE# record so exactly one
  // survives. Done AFTER the put so a failure here leaves the new code usable
  // rather than leaving none at all.
  const scan = await docClient.send(new ScanCommand({
    TableName: SETTINGS_TABLE,
    FilterExpression: 'begins_with(PK, :prefix)',
    ExpressionAttributeValues: { ':prefix': STAFF_CODE_PREFIX },
  }));
  for (const other of (scan.Items || []) as StaffCodeRecord[]) {
    if (other.PK === item.PK) continue;
    await docClient.send(new DeleteCommand({
      TableName: SETTINGS_TABLE,
      Key: { PK: other.PK, SK: other.SK || 'META' },
    }));
  }

  return res(200, { staffCode: item });
}

/**
 * Path style: /api/admin/staff-code
 * - GET → the single record (or null)
 * - PUT → upsert the single record
 */
export async function handleAdminStaffCode(event: APIGatewayProxyEvent, actor: string): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  try {
    if (method === 'GET' && path.endsWith('/admin/staff-code')) {
      return await getStaffCode();
    }
    if (method === 'PUT' && path.endsWith('/admin/staff-code')) {
      return await putStaffCode(event, actor);
    }
    return res(404, { error: 'Not found' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return res(500, { error: message });
  }
}
