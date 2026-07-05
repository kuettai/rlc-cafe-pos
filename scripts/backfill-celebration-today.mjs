/*
 * Backfill celebration discountType/discountOffset on today's orders.
 *
 * Before v42, celebration mode silently reduced eligible drink prices to
 * the celebration price without recording the discount — orders landed
 * with `discountType=NONE, discountOffset=0` even though a discount had
 * been applied. This script recomputes the gross price from each order's
 * items (looking up base + variant modifiers on the menu table) and, if
 * the recomputed gross exceeds the stored totalAmount, tags the order as
 * `discountType='CELEBRATION'` and writes the correct offset.
 *
 * Read-only by default; pass --confirm to apply.
 *
 *   node scripts/backfill-celebration-today.mjs
 *   node scripts/backfill-celebration-today.mjs --confirm
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const REGION        = 'ap-southeast-5';
const ORDERS_TABLE  = 'rlc-cafe-orders';
const MENU_TABLE    = 'rlc-cafe-menu';
const CONFIRM       = process.argv.slice(2).includes('--confirm');
const TODAY         = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD

const client = new DynamoDBClient({ region: REGION });
const doc    = DynamoDBDocumentClient.from(client);

const menuCache = new Map();
async function getMenu(menuItemId) {
  if (!menuItemId) return null;
  if (menuCache.has(menuItemId)) return menuCache.get(menuItemId);
  const r = await doc.send(new GetCommand({
    TableName: MENU_TABLE,
    Key: { PK: `MENU#${menuItemId}`, SK: 'META' },
  }));
  menuCache.set(menuItemId, r.Item || null);
  return r.Item || null;
}

/**
 * Recompute the pre-discount unit price for an order item, using the same
 * math the backend uses: basePrice + variant/variantGroups modifiers. Falls
 * back to the stored unitPrice when the menu record is missing (deleted).
 */
async function grossUnitFor(item) {
  const menu = await getMenu(item.menuItemId);
  if (!menu) return Number(item.unitPrice || 0); // best effort

  let unit = Number(menu.basePrice || 0);

  if (Array.isArray(item.selectedVariants) && item.selectedVariants.length) {
    for (const sv of item.selectedVariants) unit += Number(sv.price || 0);
  } else if (typeof item.variant === 'string' && item.variant.length) {
    // Variant string might be a single label ("Iced") or a comma-separated
    // multi-group label ("Hot, Oat Milk"). Try to find each label across
    // variantGroups and legacy variants.
    const labels = item.variant.split(',').map(s => s.trim()).filter(Boolean);
    for (const label of labels) {
      let added = false;
      for (const g of (menu.variantGroups || [])) {
        const opt = (g.options || []).find(o => o.name === label);
        if (opt) { unit += Number(opt.price || 0); added = true; break; }
      }
      if (added) continue;
      const legacy = (menu.variants || []).find(v => v.name === label || v.id === label);
      if (legacy) unit += Number(legacy.priceModifier || 0);
    }
  }

  return unit;
}

async function grossFor(order) {
  let gross = 0;
  for (const it of order.items || []) {
    const qty = Number(it.quantity || it.qty || 1);
    const unit = await grossUnitFor(it);
    gross += unit * qty;
  }
  return Math.round(gross * 100) / 100; // avoid float drift
}

async function scanTodaysOrders() {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: 'begins_with(createdAt, :d)',
      ExpressionAttributeValues: { ':d': TODAY },
      ExclusiveStartKey: key,
    }));
    if (r.Items) items.push(...r.Items);
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

async function main() {
  console.log(`Region:       ${REGION}`);
  console.log(`Orders table: ${ORDERS_TABLE}`);
  console.log(`Menu table:   ${MENU_TABLE}`);
  console.log(`Today (UTC):  ${TODAY}`);
  console.log(`Mode:         ${CONFIRM ? 'APPLY' : 'DRY RUN (pass --confirm to apply)'}`);
  console.log('');

  const orders = await scanTodaysOrders();
  console.log(`Today's orders scanned: ${orders.length}`);
  console.log('');

  const fixes  = [];
  const skips  = [];

  for (const o of orders) {
    const dt = o.discountType || 'NONE';
    // Skip orders that already have a real discount tag — including
    // CELEBRATION (already correct) and MINISTRY_PREORDER (pre-order flow).
    if (dt !== 'NONE') {
      skips.push({ orderId: o.orderId, reason: `discountType=${dt} already` });
      continue;
    }
    const total = Number(o.totalAmount || 0);
    const gross = await grossFor(o);
    const delta = Math.round((gross - total) * 100) / 100;
    if (delta <= 0.009) {
      skips.push({ orderId: o.orderId, reason: `no discount (gross=${gross}, total=${total})` });
      continue;
    }
    fixes.push({ order: o, gross, total, delta });
  }

  console.log(`Need backfill: ${fixes.length}`);
  console.log(`Skipped:       ${skips.length}`);
  console.log('');

  for (const f of fixes) {
    const o = f.order;
    const label = `${o.customerName || '(guest)'}  ${(o.items || []).map(i => `${i.quantity || 1}×${(i.name||'?').replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u,'')}${i.variant ? '('+i.variant+')' : ''}`).join(', ')}`;
    console.log(`  ${CONFIRM ? 'fix' : 'would fix'}  ${o.orderId}  ${label}`);
    console.log(`     gross=${f.gross}  total=${f.total}  →  offset=${f.delta}, discountType=CELEBRATION`);
    if (!CONFIRM) continue;
    await doc.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: o.PK, SK: o.SK },
      UpdateExpression: 'SET discountType = :dt, discountOffset = :do',
      ExpressionAttributeValues: { ':dt': 'CELEBRATION', ':do': f.delta },
    }));
  }

  console.log('');
  console.log('─── Skipped detail ───────────────────────────────');
  for (const s of skips) console.log(`  ${s.orderId}  — ${s.reason}`);

  console.log('');
  console.log('─── Summary ──────────────────────────────────────');
  console.log(`Scanned:     ${orders.length}`);
  console.log(`${CONFIRM ? 'Backfilled:  ' : 'Would fix:   '}${fixes.length}`);
  console.log(`Skipped:     ${skips.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
