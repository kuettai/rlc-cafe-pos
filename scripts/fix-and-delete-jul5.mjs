/*
 * Two-part surgical cleanup of 2026-07-05 order data:
 *
 *   1. FIX order 70640940 — totalAmount 15.10 → 13.10 and correct the
 *      two Tea unitPrices 5.00 → 4.00. This aligns it with the bank
 *      line at 10:44AM RM 13.10 (real menu price for Tea is RM 4).
 *
 *   2. DELETE 6 walk-up/cash orders that have no bank counterpart.
 *      Confirmed via the reconciler + investigation script:
 *
 *        6266b52e — Eunice     — RM  9.00 — Matcha Latte (Iced)
 *        089aa8ed — Sam        — RM  9.00 — Matcha Latte (Iced)
 *        7318606c — jiaxin     — RM  9.00 — Hot Chocolate (Iced)
 *        9c979fb0 — Rachel C   — RM 10.00 — Latte (Hot) + Long Black (Iced)
 *        e51c5e7c — Walk-up    — RM  3.20 — Nasi Lemak
 *        c4d46bd1 — Lois Order — RM 20.00 — 3× Soda (Iced) + Long Black (Hot)
 *
 * The full UUIDs are resolved at run time by scanning Jul 5 orders and
 * matching the 8-char prefix. Additional guards below refuse to act on
 * anything that doesn't look like the intended target.
 *
 * Dry run by default:
 *   node scripts/fix-and-delete-jul5.mjs
 *
 * Apply:
 *   node scripts/fix-and-delete-jul5.mjs --confirm
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const REGION       = 'ap-southeast-5';
const ORDERS_TABLE = 'rlc-cafe-orders';
const TARGET_DATE  = '2026-07-05';
const CONFIRM      = process.argv.slice(2).includes('--confirm');

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ─── Targets ───────────────────────────────────────────────────
// Fix: prefix → expected shape for double-check.
const FIX = {
  prefix: '70640940',
  expect: {
    totalAmount: 15.10,
    itemsCount: 4,
    customerName: 'Walk-up',
  },
  patch: {
    newTotalAmount: 13.10,
    teaNewUnitPrice: 4.00,
  },
};

// Deletes: prefix + expected total + expected customer (guard).
const DELETES = [
  { prefix: '6266b52e', expectTotal: 9.00,  expectCustomer: 'Eunice' },
  { prefix: '089aa8ed', expectTotal: 9.00,  expectCustomer: 'Sam' },
  { prefix: '7318606c', expectTotal: 9.00,  expectCustomer: 'jiaxin' },
  { prefix: '9c979fb0', expectTotal: 10.00, expectCustomer: 'Rachel C' },
  { prefix: 'e51c5e7c', expectTotal: 3.20,  expectCustomer: 'Walk' },
  { prefix: 'c4d46bd1', expectTotal: 20.00, expectCustomer: 'Walk-up' },
];

// ─── Helpers ───────────────────────────────────────────────────
function money(n) { return `RM ${Number(n || 0).toFixed(2)}`; }
function stripEmoji(s) { return String(s || '').replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u, '').trim(); }
function isTeaItem(item) {
  const n = stripEmoji(item?.name || '').toLowerCase();
  return n === 'tea' || n.startsWith('tea ') || n.startsWith('tea(');
}

async function scanDay() {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: 'begins_with(createdAt, :d)',
      ExpressionAttributeValues: { ':d': TARGET_DATE },
      ExclusiveStartKey: key,
    }));
    if (r.Items) items.push(...r.Items);
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

function findByPrefix(orders, prefix) {
  const hits = orders.filter(o => (o.orderId || '').startsWith(prefix));
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    throw new Error(`Prefix ${prefix} matches ${hits.length} orders — ambiguous. Aborting.`);
  }
  return hits[0];
}

async function main() {
  console.log(`Region:        ${REGION}`);
  console.log(`Orders table:  ${ORDERS_TABLE}`);
  console.log(`Target date:   ${TARGET_DATE}`);
  console.log(`Mode:          ${CONFIRM ? 'APPLY' : 'DRY RUN (pass --confirm to apply)'}`);
  console.log('');

  const day = await scanDay();
  console.log(`Scanned ${day.length} orders for ${TARGET_DATE}.`);
  console.log('');

  // ── Fix plan ────────────────────────────────────────────────
  console.log('─── Fix plan ──────────────────────────────────────');
  const fixTarget = findByPrefix(day, FIX.prefix);
  if (!fixTarget) {
    console.log(`  ✗ ${FIX.prefix} not found — cannot fix.`);
    process.exit(1);
  }
  // Sanity checks
  const total = Number(fixTarget.totalAmount || 0);
  const items = fixTarget.items || [];
  const teaItems = items.filter(isTeaItem);
  const errs = [];
  if (Math.abs(total - FIX.expect.totalAmount) > 0.005) errs.push(`totalAmount ${total} ≠ expected ${FIX.expect.totalAmount}`);
  if (items.length !== FIX.expect.itemsCount)            errs.push(`items.length ${items.length} ≠ expected ${FIX.expect.itemsCount}`);
  if (fixTarget.customerName !== FIX.expect.customerName) errs.push(`customerName "${fixTarget.customerName}" ≠ expected "${FIX.expect.customerName}"`);
  if (teaItems.length !== 2)                              errs.push(`tea items ${teaItems.length} ≠ expected 2`);
  if (errs.length) {
    console.log(`  ✗ Guard failed for ${fixTarget.orderId}:`);
    for (const e of errs) console.log(`      ${e}`);
    process.exit(1);
  }

  // Build patched items (fresh array, tea prices adjusted).
  const patchedItems = items.map(it => {
    if (!isTeaItem(it)) return it;
    return { ...it, unitPrice: FIX.patch.teaNewUnitPrice };
  });
  console.log(`  target:        ${fixTarget.orderId}`);
  console.log(`  customer:      ${fixTarget.customerName}`);
  console.log(`  totalAmount:   ${money(total)} → ${money(FIX.patch.newTotalAmount)}`);
  console.log(`  tea unitPrice: 5.00 → ${FIX.patch.teaNewUnitPrice.toFixed(2)} (both teas)`);
  console.log(`  items before:`);
  for (const it of items)        console.log(`    - ${stripEmoji(it.name)}${it.variant ? '('+it.variant+')' : ''}  qty=${it.quantity} @ ${it.unitPrice}`);
  console.log(`  items after:`);
  for (const it of patchedItems) console.log(`    - ${stripEmoji(it.name)}${it.variant ? '('+it.variant+')' : ''}  qty=${it.quantity} @ ${it.unitPrice}`);
  const sumAfter = patchedItems.reduce((s, i) => s + Number(i.unitPrice || 0) * Number(i.quantity || 1), 0);
  console.log(`  items subtotal after: ${money(sumAfter)}  (expected ${money(FIX.patch.newTotalAmount)})`);
  if (Math.abs(sumAfter - FIX.patch.newTotalAmount) > 0.005) {
    console.log(`  ✗ Items subtotal after patch does not match new totalAmount — aborting.`);
    process.exit(1);
  }
  console.log('');

  // ── Delete plan ─────────────────────────────────────────────
  console.log('─── Delete plan ───────────────────────────────────');
  const deleteTargets = [];
  for (const spec of DELETES) {
    const o = findByPrefix(day, spec.prefix);
    if (!o) {
      console.log(`  ✗ ${spec.prefix} not found — will skip.`);
      continue;
    }
    const ot = Number(o.totalAmount || 0);
    const guardOk =
      Math.abs(ot - spec.expectTotal) < 0.005 &&
      (o.customerName || '').startsWith(spec.expectCustomer);
    if (!guardOk) {
      console.log(`  ✗ ${spec.prefix} guard failed: totalAmount=${ot} customer="${o.customerName}" — expected ${spec.expectTotal} / "${spec.expectCustomer}". Aborting.`);
      process.exit(1);
    }
    deleteTargets.push(o);
    const its = (o.items || []).map(i => `${i.quantity || 1}×${stripEmoji(i.name)}${i.variant ? '('+i.variant+')' : ''}`).join(', ');
    console.log(`  ${spec.prefix}  ${money(o.totalAmount)}  ${o.customerName?.padEnd(12)}  ${o.status}  ${o.discountType || 'NONE'}  ${its}`);
  }
  const deleteSum = deleteTargets.reduce((s, o) => s + Number(o.totalAmount || 0), 0);
  console.log(`  ---`);
  console.log(`  count: ${deleteTargets.length}   sum: ${money(deleteSum)}`);
  console.log('');

  // ── Apply ────────────────────────────────────────────────────
  if (!CONFIRM) {
    console.log('DRY RUN — no writes. Re-run with --confirm to apply.');
    return;
  }

  console.log('─── Applying fix ─────────────────────────────────');
  try {
    await doc.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: fixTarget.PK, SK: fixTarget.SK },
      UpdateExpression: 'SET totalAmount = :t, #it = :items, updatedAt = :ua',
      ExpressionAttributeNames: { '#it': 'items' },
      ExpressionAttributeValues: {
        ':t':     FIX.patch.newTotalAmount,
        ':items': patchedItems,
        ':ua':    new Date().toISOString(),
        ':oldTotal': FIX.expect.totalAmount,
      },
      // Only patch if the totalAmount hasn't been changed by someone
      // else since we scanned.
      ConditionExpression: 'totalAmount = :oldTotal',
    }));
    console.log(`  ✓ patched ${fixTarget.orderId}`);
  } catch (e) {
    console.error(`  ✗ update failed: ${e.name}: ${e.message}`);
    process.exit(1);
  }
  console.log('');

  console.log('─── Applying deletes ─────────────────────────────');
  let deleted = 0;
  for (const o of deleteTargets) {
    try {
      await doc.send(new DeleteCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: o.PK, SK: o.SK },
        ConditionExpression: 'attribute_exists(PK) AND totalAmount = :t',
        ExpressionAttributeValues: { ':t': Number(o.totalAmount) },
      }));
      console.log(`  ✓ deleted ${o.orderId.slice(0, 8)}  ${money(o.totalAmount)}  ${o.customerName}`);
      deleted++;
    } catch (e) {
      console.error(`  ✗ delete failed for ${o.orderId.slice(0, 8)}: ${e.name}: ${e.message}`);
    }
  }
  console.log('');
  console.log('─── Summary ──────────────────────────────────────');
  console.log(`Patched:  1  (${money(FIX.expect.totalAmount)} → ${money(FIX.patch.newTotalAmount)}, delta ${money(FIX.expect.totalAmount - FIX.patch.newTotalAmount)})`);
  console.log(`Deleted:  ${deleted}/${deleteTargets.length}  (${money(deleteSum)})`);
}

main().catch(e => { console.error(e); process.exit(1); });
