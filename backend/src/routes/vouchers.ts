import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuid } from 'uuid';
import {
  docClient,
  VOUCHERS_TABLE,
  ORDERS_TABLE,
  MENU_TABLE,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '../lib/db';
import { normalizePhone } from '../lib/phone';

// ─── Helpers ──────────────────────────────────────────────────────────

const VOUCHER_TYPES = ['FREE_DRINK', 'FREE_FOOD', 'FREE_COMBO'] as const;
const EXPIRY_MODES = ['DAYS_FROM_ISSUE', 'FIXED_DATE'] as const;
const MAX_CSV_ROWS = 1000;

const res = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

function nowIso() { return new Date().toISOString(); }
function nowEpoch() { return Math.floor(Date.now() / 1000); }

function isVoucherType(v: unknown): v is typeof VOUCHER_TYPES[number] {
  return typeof v === 'string' && (VOUCHER_TYPES as readonly string[]).includes(v);
}
function isExpiryMode(v: unknown): v is typeof EXPIRY_MODES[number] {
  return typeof v === 'string' && (EXPIRY_MODES as readonly string[]).includes(v);
}

/** Compute a voucher's expiresAt ISO string at the moment of issue. */
function computeExpiresAt(campaign: { expiryMode: string; expiryDays?: number; expiryDate?: string }): string {
  if (campaign.expiryMode === 'FIXED_DATE') {
    return campaign.expiryDate as string;
  }
  // DAYS_FROM_ISSUE
  const days = campaign.expiryDays || 0;
  const t = Date.now() + days * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString();
}

async function getCampaign(campaignId: string) {
  const r = await docClient.send(new GetCommand({
    TableName: VOUCHERS_TABLE,
    Key: { PK: `CAMPAIGN#${campaignId}`, SK: 'META' },
  }));
  return r.Item;
}

async function getVoucher(phone: string, voucherId: string) {
  const r = await docClient.send(new GetCommand({
    TableName: VOUCHERS_TABLE,
    Key: { PK: `VOUCHER#${phone}`, SK: `VOUCHER#${voucherId}` },
  }));
  return r.Item;
}

async function getMenuItem(menuItemId: string) {
  const r = await docClient.send(new GetCommand({
    TableName: MENU_TABLE,
    Key: { PK: `MENU#${menuItemId}`, SK: 'META' },
  }));
  return r.Item;
}

/** Check if a phone already has an unredeemed voucher in a campaign. */
async function hasActiveVoucherInCampaign(phone: string, campaignId: string): Promise<boolean> {
  const r = await docClient.send(new QueryCommand({
    TableName: VOUCHERS_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    FilterExpression: 'campaignId = :cid AND #s = :issued',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':pk': `VOUCHER#${phone}`,
      ':skPrefix': 'VOUCHER#',
      ':cid': campaignId,
      ':issued': 'ISSUED',
    },
  }));
  return (r.Items?.length || 0) > 0;
}

/** Parse a CSV string with header `phone,name,note`. Returns up to MAX_CSV_ROWS rows. */
function parseCsv(csv: string): { rows: { row: number; phone: string; name: string; note: string }[]; error?: string } {
  const lines = csv.split(/\r?\n/);
  const rows: { row: number; phone: string; name: string; note: string }[] = [];
  let header: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split(',').map(c => c.trim());

    if (!header) {
      header = cells.map(c => c.toLowerCase());
      if (!header.includes('phone')) {
        return { rows: [], error: 'CSV missing required "phone" column' };
      }
      continue;
    }

    const phoneIdx = header.indexOf('phone');
    const nameIdx = header.indexOf('name');
    const noteIdx = header.indexOf('note');

    rows.push({
      row: i + 1,
      phone: cells[phoneIdx] || '',
      name: nameIdx >= 0 ? (cells[nameIdx] || '') : '',
      note: noteIdx >= 0 ? (cells[noteIdx] || '') : '',
    });

    if (rows.length > MAX_CSV_ROWS) {
      return { rows: [], error: `CSV exceeds maximum ${MAX_CSV_ROWS} rows` };
    }
  }

  return { rows };
}

/** Compute the unit price of a menu item including selectedVariants add-ons. */
function priceWithVariants(menu: any, selectedVariants: { option?: string; price?: number }[] | undefined): number {
  let unit = menu.basePrice || 0;
  if (selectedVariants?.length) {
    for (const sv of selectedVariants) unit += (sv.price || 0);
  }
  return unit;
}

function variantLabel(selectedVariants: { option?: string }[] | undefined): string | null {
  if (!selectedVariants?.length) return null;
  return selectedVariants.map(sv => sv.option).filter(Boolean).join(', ') || null;
}

// ─── Admin: Campaigns ─────────────────────────────────────────────────

async function createCampaign(event: APIGatewayProxyEvent, actor: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { name, type, expiryMode, expiryValue, description } = body;

  if (!name || typeof name !== 'string') return res(400, { error: 'name required' });
  if (!isVoucherType(type)) return res(400, { error: 'type must be FREE_DRINK, FREE_FOOD, or FREE_COMBO' });
  if (!isExpiryMode(expiryMode)) return res(400, { error: 'expiryMode must be DAYS_FROM_ISSUE or FIXED_DATE' });

  let expiryDays: number | undefined;
  let expiryDate: string | undefined;

  if (expiryMode === 'DAYS_FROM_ISSUE') {
    const days = Number(expiryValue);
    if (!Number.isInteger(days) || days <= 0 || days > 3650) return res(400, { error: 'expiryValue must be a positive integer (days)' });
    expiryDays = days;
  } else {
    if (typeof expiryValue !== 'string') return res(400, { error: 'expiryValue must be ISO date string' });
    const t = Date.parse(expiryValue);
    if (Number.isNaN(t)) return res(400, { error: 'expiryValue is not a valid ISO date' });
    if (t <= Date.now()) return res(400, { error: 'expiryValue must be in the future' });
    expiryDate = new Date(t).toISOString();
  }

  const campaignId = uuid();
  const now = nowIso();
  const item: Record<string, unknown> = {
    PK: `CAMPAIGN#${campaignId}`, SK: 'META',
    campaignId, name,
    description: typeof description === 'string' ? description : '',
    voucherType: type,
    expiryMode,
    status: 'ACTIVE',
    issuedCount: 0,
    redeemedCount: 0,
    createdAt: now,
    createdBy: actor,
    updatedAt: now,
  };
  if (expiryDays !== undefined) item.expiryDays = expiryDays;
  if (expiryDate !== undefined) item.expiryDate = expiryDate;

  await docClient.send(new PutCommand({ TableName: VOUCHERS_TABLE, Item: item }));
  return res(201, item);
}

async function listCampaigns(): Promise<APIGatewayProxyResult> {
  const r = await docClient.send(new ScanCommand({
    TableName: VOUCHERS_TABLE,
    FilterExpression: 'begins_with(PK, :pk) AND SK = :sk',
    ExpressionAttributeValues: { ':pk': 'CAMPAIGN#', ':sk': 'META' },
  }));
  const campaigns = (r.Items || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return res(200, { campaigns });
}

async function getCampaignDetail(campaignId: string): Promise<APIGatewayProxyResult> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return res(404, { error: 'Campaign not found' });

  // Fetch live voucher counts via the GSI rather than trusting cached counters.
  const r = await docClient.send(new QueryCommand({
    TableName: VOUCHERS_TABLE,
    IndexName: 'campaignId-issuedAt-index',
    KeyConditionExpression: 'campaignId = :cid',
    ExpressionAttributeValues: { ':cid': campaignId },
  }));
  const vouchers = r.Items || [];
  const now = nowEpoch();
  const stats = {
    total: vouchers.length,
    issued: vouchers.filter(v => v.status === 'ISSUED' && (v.expiresAtEpoch || 0) > now).length,
    redeemed: vouchers.filter(v => v.status === 'REDEEMED').length,
    expired: vouchers.filter(v => v.status === 'ISSUED' && (v.expiresAtEpoch || 0) <= now).length,
  };

  return res(200, { campaign, stats, vouchers });
}

// ─── Admin: Assign vouchers ───────────────────────────────────────────

interface AssignResult {
  issued: number;
  voucherIds: string[];
  skipped: { row?: number; phone: string; reason: string }[];
}

async function issueOneVoucher(
  campaign: any,
  rawPhone: string,
  name: string,
  note: string,
  actor: string,
  rowNum: number | undefined,
  result: AssignResult,
  allowDuplicates: boolean,
): Promise<void> {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    result.skipped.push({ row: rowNum, phone: rawPhone, reason: 'invalid_phone' });
    return;
  }

  if (!allowDuplicates) {
    const dup = await hasActiveVoucherInCampaign(phone, campaign.campaignId);
    if (dup) {
      result.skipped.push({ row: rowNum, phone, reason: 'duplicate' });
      return;
    }
  }

  const voucherId = uuid();
  const issuedAt = nowIso();
  const expiresAtIso = computeExpiresAt({
    expiryMode: campaign.expiryMode,
    expiryDays: campaign.expiryDays,
    expiryDate: campaign.expiryDate,
  });
  const expiresAtEpoch = Math.floor(Date.parse(expiresAtIso) / 1000);

  const item: Record<string, unknown> = {
    PK: `VOUCHER#${phone}`,
    SK: `VOUCHER#${voucherId}`,
    voucherId,
    campaignId: campaign.campaignId,
    campaignName: campaign.name,
    phone,
    voucherType: campaign.voucherType,
    status: 'ISSUED',
    issuedAt,
    issuedBy: actor,
    expiresAt: expiresAtIso,
    expiresAtEpoch,
  };
  if (name) item.name = name;
  if (note) item.note = note;

  await docClient.send(new PutCommand({ TableName: VOUCHERS_TABLE, Item: item }));
  result.issued += 1;
  result.voucherIds.push(voucherId);
}

async function assignVoucher(event: APIGatewayProxyEvent, campaignId: string, actor: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { phone, name, note } = body;
  if (!phone || typeof phone !== 'string') return res(400, { error: 'phone required' });

  const campaign = await getCampaign(campaignId);
  if (!campaign) return res(404, { error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res(400, { error: 'Campaign is not active' });

  const result: AssignResult = { issued: 0, voucherIds: [], skipped: [] };
  const allowDuplicates = (event.queryStringParameters?.allowDuplicates === 'true');
  await issueOneVoucher(campaign, phone, name || '', note || '', actor, undefined, result, allowDuplicates);

  // Bump the cached counter, ignoring any single-write failure.
  if (result.issued > 0) await bumpIssuedCount(campaignId, result.issued);

  if (result.issued === 0) {
    return res(400, { error: result.skipped[0]?.reason || 'failed', skipped: result.skipped });
  }
  return res(201, { issued: result.issued, voucherId: result.voucherIds[0], skipped: result.skipped });
}

async function assignCsv(event: APIGatewayProxyEvent, campaignId: string, actor: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  let csvText = '';
  if (typeof body.csv === 'string') {
    // Allow either raw CSV or base64-encoded CSV.
    csvText = body.csv;
    if (!csvText.includes(',') && !csvText.includes('\n')) {
      try { csvText = Buffer.from(csvText, 'base64').toString('utf-8'); } catch { /* ignore */ }
    }
  } else {
    return res(400, { error: 'csv field (string) required in body' });
  }

  const parsed = parseCsv(csvText);
  if (parsed.error) return res(400, { error: parsed.error });

  const campaign = await getCampaign(campaignId);
  if (!campaign) return res(404, { error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res(400, { error: 'Campaign is not active' });

  const result: AssignResult = { issued: 0, voucherIds: [], skipped: [] };
  const allowDuplicates = (event.queryStringParameters?.allowDuplicates === 'true');
  for (const row of parsed.rows) {
    if (!row.phone) {
      result.skipped.push({ row: row.row, phone: '', reason: 'missing_phone' });
      continue;
    }
    await issueOneVoucher(campaign, row.phone, row.name, row.note, actor, row.row, result, allowDuplicates);
  }

  if (result.issued > 0) await bumpIssuedCount(campaignId, result.issued);

  return res(200, { campaignId, issued: result.issued, skipped: result.skipped });
}

async function bumpIssuedCount(campaignId: string, delta: number): Promise<void> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: VOUCHERS_TABLE,
      Key: { PK: `CAMPAIGN#${campaignId}`, SK: 'META' },
      UpdateExpression: 'ADD issuedCount :d SET updatedAt = :now',
      ExpressionAttributeValues: { ':d': delta, ':now': nowIso() },
    }));
  } catch { /* best-effort counter; live count comes from the GSI */ }
}

async function bumpRedeemedCount(campaignId: string): Promise<void> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: VOUCHERS_TABLE,
      Key: { PK: `CAMPAIGN#${campaignId}`, SK: 'META' },
      UpdateExpression: 'ADD redeemedCount :d SET updatedAt = :now',
      ExpressionAttributeValues: { ':d': 1, ':now': nowIso() },
    }));
  } catch { /* best-effort */ }
}

// ─── Admin: Revoke ────────────────────────────────────────────────────

async function revokeVoucher(event: APIGatewayProxyEvent, voucherId: string): Promise<APIGatewayProxyResult> {
  // Phone is required to address the record (the SK alone is voucher-scoped,
  // but PK is voucher#{phone}). Admin UI knows phone from the listing.
  const rawPhone = event.queryStringParameters?.phone;
  if (!rawPhone) return res(400, { error: 'phone query parameter required' });
  const phone = normalizePhone(rawPhone);
  if (!phone) return res(400, { error: 'invalid phone' });

  const v = await getVoucher(phone, voucherId);
  if (!v) return res(404, { error: 'Voucher not found' });
  if (v.status === 'REDEEMED') return res(409, { error: 'Cannot revoke a redeemed voucher' });

  await docClient.send(new DeleteCommand({
    TableName: VOUCHERS_TABLE,
    Key: { PK: `VOUCHER#${phone}`, SK: `VOUCHER#${voucherId}` },
  }));

  // Decrement issued counter (best-effort).
  try {
    await docClient.send(new UpdateCommand({
      TableName: VOUCHERS_TABLE,
      Key: { PK: `CAMPAIGN#${v.campaignId}`, SK: 'META' },
      UpdateExpression: 'ADD issuedCount :d SET updatedAt = :now',
      ExpressionAttributeValues: { ':d': -1, ':now': nowIso() },
    }));
  } catch { /* ignore */ }

  return res(200, { revoked: voucherId });
}

// ─── POS: Lookup ──────────────────────────────────────────────────────

async function lookupByPhone(rawPhone: string): Promise<APIGatewayProxyResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return res(400, { error: 'invalid phone' });

  const r = await docClient.send(new QueryCommand({
    TableName: VOUCHERS_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `VOUCHER#${phone}`, ':sk': 'VOUCHER#' },
  }));
  const items = r.Items || [];
  const now = nowEpoch();

  const eligible: any[] = [];
  const past: any[] = [];

  for (const v of items) {
    const decorated = {
      voucherId: v.voucherId,
      campaignId: v.campaignId,
      campaignName: v.campaignName,
      phone: v.phone,
      name: v.name,
      voucherType: v.voucherType,
      status: v.status,
      issuedAt: v.issuedAt,
      expiresAt: v.expiresAt,
      expiresAtEpoch: v.expiresAtEpoch,
      redeemedAt: v.redeemedAt,
      redeemedBy: v.redeemedBy,
      orderId: v.orderId,
      menuItemName: v.menuItemName,
      variant: v.variant,
      note: v.note,
    };
    const isExpired = (v.expiresAtEpoch || 0) <= now;
    if (v.status === 'ISSUED' && !isExpired) {
      eligible.push(decorated);
    } else {
      // Surface a derived display state without writing back.
      past.push({ ...decorated, displayStatus: v.status === 'ISSUED' && isExpired ? 'EXPIRED' : v.status });
    }
  }

  eligible.sort((a, b) => (a.expiresAt || '').localeCompare(b.expiresAt || ''));
  past.sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || ''));

  return res(200, { phone, eligible, past });
}

// ─── POS: Redeem ──────────────────────────────────────────────────────

async function redeemVoucher(event: APIGatewayProxyEvent, actor: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { voucherId, customerName } = body;
  const rawPhone = body.phone;

  if (!voucherId) return res(400, { error: 'voucherId required' });
  if (!rawPhone) return res(400, { error: 'phone required' });

  const phone = normalizePhone(rawPhone);
  if (!phone) return res(400, { error: 'invalid phone' });

  // Accept either {items: [...]} (preferred, required for FREE_COMBO) or
  // legacy {menuItemId, selectedVariants} (single-item shape used by the
  // earlier FREE_DRINK / FREE_FOOD frontend). Normalise to a single shape.
  type ReqItem = { menuItemId: string; selectedVariants?: { option?: string; price?: number; group?: string }[] };
  let requestedItems: ReqItem[];
  if (Array.isArray(body.items) && body.items.length) {
    requestedItems = body.items;
  } else if (body.menuItemId) {
    requestedItems = [{ menuItemId: body.menuItemId, selectedVariants: body.selectedVariants }];
  } else {
    return res(400, { error: 'items[] or menuItemId required' });
  }
  for (const r of requestedItems) {
    if (!r || !r.menuItemId) return res(400, { error: 'each item must include menuItemId' });
  }

  const voucher = await getVoucher(phone, voucherId);
  if (!voucher) return res(404, { error: 'Voucher not found' });
  if (voucher.status !== 'ISSUED') return res(409, { error: 'Voucher already redeemed or revoked' });

  const now = nowEpoch();
  if ((voucher.expiresAtEpoch || 0) <= now) return res(409, { error: 'Voucher has expired' });

  // Resolve menu items + cross-check counts/categories per voucher type.
  const resolved: { req: ReqItem; menu: any }[] = [];
  for (const r of requestedItems) {
    const menu = await getMenuItem(r.menuItemId);
    if (!menu) return res(404, { error: `Menu item not found: ${r.menuItemId}` });
    if (!menu.isActive) return res(400, { error: `Menu item is not active: ${menu.name}` });
    resolved.push({ req: r, menu });
  }

  if (voucher.voucherType === 'FREE_DRINK') {
    if (resolved.length !== 1) return res(400, { error: 'FREE_DRINK voucher takes exactly one item' });
    if (resolved[0].menu.category !== 'DRINK') return res(400, { error: 'This voucher is for drinks only' });
  } else if (voucher.voucherType === 'FREE_FOOD') {
    if (resolved.length !== 1) return res(400, { error: 'FREE_FOOD voucher takes exactly one item' });
    if (resolved[0].menu.category !== 'FOOD') return res(400, { error: 'This voucher is for food only' });
  } else if (voucher.voucherType === 'FREE_COMBO') {
    if (resolved.length !== 2) return res(400, { error: 'FREE_COMBO voucher requires exactly two items (one drink + one food)' });
    const cats = resolved.map(x => x.menu.category).sort();
    if (cats[0] !== 'DRINK' || cats[1] !== 'FOOD') {
      return res(400, { error: 'FREE_COMBO requires one DRINK and one FOOD item' });
    }
  } else {
    return res(400, { error: 'Unknown voucher type' });
  }

  // Build the order line items (everything zero-priced) and compute the
  // total price that the voucher is offsetting.
  const orderItems: any[] = [];
  let totalPrice = 0;
  const labelParts: string[] = [];

  for (const { req, menu } of resolved) {
    const variants = Array.isArray(req.selectedVariants) ? req.selectedVariants : [];
    const itemPrice = priceWithVariants(menu, variants);
    const vlabel = variantLabel(variants);
    totalPrice += itemPrice;
    orderItems.push({
      menuItemId: menu.menuItemId,
      name: menu.name,
      variant: vlabel,
      quantity: 1,
      unitPrice: 0,
      category: menu.category,
    });
    labelParts.push(vlabel ? `${menu.name} (${vlabel})` : menu.name);
  }

  // Snapshot stored on the voucher record. For combos we join the two
  // names with " + " so reports/admin lists stay readable.
  const snapshotName = labelParts.join(' + ');
  // Snapshot the variant label for single-item only — combo names already
  // embed their variants. Keeps the data shape stable for old consumers.
  const snapshotVariant = resolved.length === 1 ? variantLabel(resolved[0].req.selectedVariants || []) : null;
  const primaryMenuItemId = resolved[0].menu.menuItemId; // first item — not particularly meaningful for combos
  const orderId = uuid();
  const nowIsoStr = nowIso();
  // Match the existing orders convention: TTL ~60min from creation.
  const expiresAt = now + 60 * 60;

  const orderItem: Record<string, unknown> = {
    PK: `ORDER#${orderId}`, SK: 'META',
    orderId,
    customerName: customerName || voucher.name || 'Voucher Redemption',
    customerId: phone,
    items: orderItems,
    totalAmount: 0,
    status: 'PREPARING',
    discountType: 'VOUCHER',
    discountOffset: totalPrice,
    voucherId,
    voucherCampaignId: voucher.campaignId,
    voucherType: voucher.voucherType,
    voucherPhone: phone,
    isWalkUp: true,
    approvedBy: actor,
    flaggedItems: [],
    createdAt: nowIsoStr,
    updatedAt: nowIsoStr,
    expiresAt,
    notes: '',
  };

  // Atomic: voucher flip + order create. Either both succeed, or the user
  // sees an error and nothing was written.
  try {
    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: VOUCHERS_TABLE,
            Key: { PK: `VOUCHER#${phone}`, SK: `VOUCHER#${voucherId}` },
            UpdateExpression:
              'SET #s = :redeemed, redeemedAt = :now, redeemedBy = :actor, ' +
              'orderId = :oid, menuItemId = :mid, menuItemName = :mname, ' +
              'variant = :vlabel, discountAmount = :price',
            ConditionExpression: '#s = :issued AND expiresAtEpoch > :nowEpoch',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':redeemed': 'REDEEMED',
              ':issued': 'ISSUED',
              ':now': nowIsoStr,
              ':actor': actor,
              ':oid': orderId,
              ':mid': primaryMenuItemId,
              ':mname': snapshotName,
              ':vlabel': snapshotVariant,
              ':price': totalPrice,
              ':nowEpoch': now,
            },
          },
        },
        {
          Put: {
            TableName: ORDERS_TABLE,
            Item: orderItem,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    }));
  } catch (e: any) {
    if (e.name === 'TransactionCanceledException') {
      return res(409, { error: 'Voucher could not be redeemed (already redeemed, expired, or order id conflict)' });
    }
    throw e;
  }

  await bumpRedeemedCount(voucher.campaignId);

  return res(201, {
    orderId,
    voucherId,
    status: 'REDEEMED',
    discountAmount: totalPrice,
    items: orderItems.map(i => ({ menuItemId: i.menuItemId, name: i.name, variant: i.variant, category: i.category })),
  });
}

// ─── Void redemption (move order back to PENDING) ─────────────────────
//
// Per resolved decision: voiding moves the linked order back to PENDING so
// the cashier can edit it as a normal order. The voucher itself stays
// REDEEMED — a redeemed voucher is gone for good. This endpoint is exposed
// here so the eventual frontend can find it under the voucher namespace,
// even though the underlying mutation is on the order record.
async function voidRedemption(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { orderId } = body;
  if (!orderId) return res(400, { error: 'orderId required' });

  const r = await docClient.send(new GetCommand({
    TableName: ORDERS_TABLE,
    Key: { PK: `ORDER#${orderId}`, SK: 'META' },
  }));
  if (!r.Item) return res(404, { error: 'Order not found' });
  if (r.Item.discountType !== 'VOUCHER') return res(400, { error: 'Order did not originate from a voucher' });
  if (r.Item.status !== 'PREPARING') return res(409, { error: 'Order is no longer in PREPARING' });

  await docClient.send(new UpdateCommand({
    TableName: ORDERS_TABLE,
    Key: { PK: `ORDER#${orderId}`, SK: 'META' },
    UpdateExpression: 'SET #s = :pending, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'PENDING', ':now': nowIso(), ':preparing': 'PREPARING' },
    ConditionExpression: '#s = :preparing',
  }));

  return res(200, { orderId, status: 'PENDING' });
}

// ─── Router ───────────────────────────────────────────────────────────

function extractSegment(path: string, pattern: RegExp, index: number): string | null {
  const m = path.match(pattern);
  return m ? m[index] : null;
}

export async function handleVouchers(event: APIGatewayProxyEvent, actor: string): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  // Admin
  if (method === 'POST' && path === '/api/admin/vouchers/campaigns') return createCampaign(event, actor);
  if (method === 'GET'  && path === '/api/admin/vouchers/campaigns') return listCampaigns();

  if (method === 'GET' && /^\/api\/admin\/vouchers\/campaigns\/[^/]+$/.test(path)) {
    const id = extractSegment(path, /\/api\/admin\/vouchers\/campaigns\/([^/]+)$/, 1);
    if (id) return getCampaignDetail(id);
  }

  if (method === 'POST' && /^\/api\/admin\/vouchers\/campaigns\/[^/]+\/assign$/.test(path)) {
    const id = extractSegment(path, /\/api\/admin\/vouchers\/campaigns\/([^/]+)\/assign$/, 1);
    if (id) return assignVoucher(event, id, actor);
  }

  if (method === 'POST' && /^\/api\/admin\/vouchers\/campaigns\/[^/]+\/assign-csv$/.test(path)) {
    const id = extractSegment(path, /\/api\/admin\/vouchers\/campaigns\/([^/]+)\/assign-csv$/, 1);
    if (id) return assignCsv(event, id, actor);
  }

  if (method === 'DELETE' && /^\/api\/admin\/vouchers\/[^/]+$/.test(path)) {
    const voucherId = extractSegment(path, /\/api\/admin\/vouchers\/([^/]+)$/, 1);
    if (voucherId) return revokeVoucher(event, voucherId);
  }

  // POS
  if (method === 'GET' && /^\/api\/pos\/vouchers\/[^/]+$/.test(path)) {
    const phone = extractSegment(path, /\/api\/pos\/vouchers\/([^/]+)$/, 1);
    if (phone) return lookupByPhone(decodeURIComponent(phone));
  }

  if (method === 'POST' && path === '/api/pos/vouchers/redeem') return redeemVoucher(event, actor);
  if (method === 'POST' && path === '/api/pos/vouchers/void')   return voidRedemption(event);

  return res(404, { error: 'Not found' });
}
