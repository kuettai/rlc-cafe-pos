/**
 * cleanup-test-data.mjs — remove production records created by the live
 * integration suite (`backend/tests/integration.test.ts`).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * That suite ran against the production API. Its "Order Flow" group did, per
 * run: open the café → create a real order → approve it → mark it ready →
 * close the café. On 2026-08-02 seven full `npm test` runs therefore put seven
 * phantom RM7 orders into the Sunday figures and sent two spurious end-of-day
 * summary emails. See docs/update-20260802.md.
 *
 * The suite now requires BOTH credentials and RUN_LIVE_WRITE_TESTS=1, so this
 * should not recur — but if it is ever run deliberately, this cleans up after.
 *
 * ── What it removes ─────────────────────────────────────────────────────────
 *  1. Orders            any marked field begins with the shared TEST_PREFIX
 *                       (see scripts/test-markers.cjs)
 *  2. Customers         phone in the reserved test range
 *  3. Close-audit rows  FEATURED_AUDIT#<date> written by closeCafe, correlated
 *                       to a test order by timestamp proximity so a genuine
 *                       end-of-service close is never touched.
 *
 * Matching is by PREFIX from `scripts/test-markers.cjs`, which the suites also
 * import. Previously the match strings were duplicated here as literals and the
 * Playwright customer journey used a third spelling ("Demo Customer"), so its
 * orders were never matched and accumulated in the Sunday figures. Use
 * `--legacy` to sweep up those pre-prefix records.
 *
 * ── What it CANNOT undo (reported, not fixed) ───────────────────────────────
 *  • Ingredient stock deducted at approve (deductIngredients)
 *  • Food quantities reset to 0 by closeCafe
 *  • lastLoginAt on the account the suite logged in as
 *  • The end-of-day emails already sent
 *
 * ── Usage (from repo root) ──────────────────────────────────────────────────
 *   node scripts/cleanup-test-data.mjs                    # dry run, today
 *   node scripts/cleanup-test-data.mjs --date 2026-08-02  # dry run, given date
 *   node scripts/cleanup-test-data.mjs --all              # dry run, every date
 *   node scripts/cleanup-test-data.mjs --legacy            # also match the
 *                                                          pre-prefix names
 *   node scripts/cleanup-test-data.mjs --apply            # delete
 *
 * Every matched record is backed up before deletion. Region: ap-southeast-5.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = 'ap-southeast-5';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'rlc-cafe-orders';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'rlc-cafe-settings';
const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE || 'rlc-cafe-customers';

// Shared with the suites that create the records — never duplicate the strings.
const markers = require(join(__dirname, 'test-markers.cjs'));
const { TEST_PREFIX, MARKED_FIELDS, isTestPhone } = markers;

/**
 * Names used before the prefix convention existed. Matched only with --legacy,
 * as an exact whole-string match so a real customer is never caught.
 * "Demo Customer" came from the Playwright customer journey and was never
 * cleanable; "Test Customer"/"Test Admin" from the integration suite.
 */
const LEGACY_NAMES = ['Test Customer', 'Demo Customer'];
const LEGACY_APPROVERS = ['Test Admin'];

// closeCafe runs immediately after the test order in the same suite teardown.
// A generous window still cannot reach the genuine service close hours earlier.
const CLOSE_CORRELATION_MS = 15_000;

// Refuse to run away if a filter ever matches far more than expected.
const MAX_DELETIONS = 50;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ALL_DATES = argv.includes('--all');
const LEGACY = argv.includes('--legacy');
const dateIdx = argv.indexOf('--date');
const DATE = dateIdx >= 0 && argv[dateIdx + 1] ? argv[dateIdx + 1] : new Date().toISOString().slice(0, 10);

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function scanAll(params) {
  const items = [];
  let key;
  do {
    const out = await doc.send(new ScanCommand({ ...params, ExclusiveStartKey: key }));
    items.push(...(out.Items || []));
    key = out.LastEvaluatedKey;
  } while (key);
  return items;
}

/**
 * Does this record look like one a test created?
 *
 * Prefix match on ANY marked field — deliberately OR, not AND. The old filter
 * required customerName AND approvedBy to both match, so an order that was
 * created but never approved (rejected, cancelled, or a failed run) matched
 * nothing and was left behind.
 */
function matchesTestOrder(order) {
  for (const field of MARKED_FIELDS) {
    const v = order[field];
    if (typeof v === 'string' && v.startsWith(TEST_PREFIX)) return true;
  }
  if (!LEGACY) return false;
  return LEGACY_NAMES.includes(order.customerName)
    || LEGACY_APPROVERS.includes(order.approvedBy);
}

/**
 * Test orders still live in the table.
 *
 * The date filter is pushed to DynamoDB; the marker match runs client-side so
 * one code path (`matchesTestOrder`) decides what counts as a test record, and
 * the prefix definition stays in exactly one file.
 */
async function findTestOrders() {
  const params = { TableName: ORDERS_TABLE };
  if (!ALL_DATES) {
    params.FilterExpression = 'begins_with(createdAt, :d)';
    params.ExpressionAttributeValues = { ':d': DATE };
  }
  const items = await scanAll(params);
  return items
    .filter(matchesTestOrder)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Customer records in the reserved test phone range.
 *
 * Keyed `PK=CUSTOMER#<normalised phone>`, so the prefix is stripped before the
 * range check. Scans every date — customer records have no createdAt filter
 * worth applying and there are few of them.
 */
async function findTestCustomers() {
  try {
    const items = await scanAll({ TableName: CUSTOMERS_TABLE });
    return items.filter(c =>
      isTestPhone(c.phone)
      || isTestPhone(c.customerId)
      || isTestPhone(String(c.PK || '').replace(/^CUSTOMER#/, '')));
  } catch (e) {
    console.warn(`  (could not scan ${CUSTOMERS_TABLE}: ${e.name || e.message})`);
    return [];
  }
}

/**
 * Timestamps of test runs. Uses live orders plus any earlier backup file, so
 * audit rows can still be correlated after the orders themselves are gone.
 */
function loadBackupTimestamps() {
  const candidates = [
    resolve(__dirname, '..', '..', `test-orders-backup-${DATE}.json`),
    resolve(__dirname, '..', '..', `test-data-backup-${DATE}.json`),
  ];
  const stamps = [];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      for (const it of parsed.Items || []) if (it.createdAt) stamps.push(it.createdAt);
      console.log(`  (recovered ${(parsed.Items || []).length} timestamp(s) from ${p})`);
    } catch { /* ignore unreadable backup */ }
  }
  return stamps;
}

/** FEATURED_AUDIT rows from closeCafe that correlate with a test run. */
async function findTestCloseAudits(testTimestamps) {
  const out = await doc.send(new QueryCommand({
    TableName: SETTINGS_TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `FEATURED_AUDIT#${DATE}` },
  }));
  const all = (out.Items || []).sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
  const targets = testTimestamps.map(t => new Date(t).getTime()).filter(n => Number.isFinite(n));

  const matched = [];
  const kept = [];
  for (const row of all) {
    const t = new Date(row.SK).getTime();
    const isSystemClose = row.user === 'SYSTEM/CLOSE';
    const near = targets.some(x => t >= x && t - x <= CLOSE_CORRELATION_MS);
    (isSystemClose && near ? matched : kept).push(row);
  }
  return { matched, kept };
}

async function main() {
  console.log(`Date:   ${ALL_DATES ? 'ALL (--all)' : DATE}`);
  console.log(`Match:  ${MARKED_FIELDS.join(' | ')} begins_with "${TEST_PREFIX}"`);
  console.log(`        customers in the reserved test phone range`);
  if (LEGACY) {
    console.log(`Legacy: also exact names ${LEGACY_NAMES.map(n => `"${n}"`).join(', ')}`);
  }
  console.log('');

  const orders = await findTestOrders();
  const timestamps = [...orders.map(o => o.createdAt), ...loadBackupTimestamps()];

  console.log(`\n1) Orders`);
  let orderTotal = 0;
  if (!orders.length) {
    console.log('   none found');
  } else {
    for (const o of orders) {
      orderTotal += Number(o.totalAmount || 0);
      const names = (o.items || []).map(i => `${i.quantity}x${i.name}`).join(',');
      console.log(`   ${o.createdAt}  ${o.orderId}  ${String(o.status).padEnd(9)} RM${Number(o.totalAmount || 0).toFixed(2)}  ${names}`);
    }
    console.log(`   subtotal: ${orders.length} order(s), RM${orderTotal.toFixed(2)}`);
  }

  const customers = await findTestCustomers();
  console.log(`\n2) Customers (reserved test phone range)`);
  if (!customers.length) {
    console.log('   none found');
  } else {
    for (const c of customers) {
      console.log(`   ${c.PK}  name=${c.name || '-'}  registered=${c.createdAt || '-'}`);
    }
    console.log(`   subtotal: ${customers.length} customer(s)`);
  }

  const { matched: audits, kept } = await findTestCloseAudits(timestamps);
  console.log(`\n3) Close-audit rows (FEATURED_AUDIT#${DATE})`);
  if (!audits.length) {
    console.log('   none correlated with a test run');
  } else {
    for (const a of audits) console.log(`   ${a.SK}  user=${a.user}  action=${a.action}   <- test run`);
    console.log(`   subtotal: ${audits.length} row(s)`);
  }
  if (kept.length) {
    console.log('   KEEPING (genuine):');
    for (const a of kept) console.log(`   ${a.SK}  user=${a.user}  action=${a.action}`);
  }

  const total = orders.length + customers.length + audits.length;
  console.log(`\nTotal to delete: ${total} record(s)`);

  console.log('\nNOT reversible by this script:');
  console.log('  • ingredient stock deducted when the test orders were approved');
  console.log('  • food quantities reset to 0 by the test café closes');
  console.log('  • foodReserved / foodQuantityToday drift — run scripts/reset-food-reserved.mjs');
  console.log('  • café left OPEN by the Playwright cashier journey — close it in the POS');
  console.log('  • opening-checklist rows ticked by that journey');
  console.log('  • lastLoginAt on the account the suite used');
  console.log('  • end-of-day emails already delivered');

  if (!total) {
    console.log('\nNothing to do.');
    return;
  }
  if (total > MAX_DELETIONS) {
    console.error(`\n✗ ${total} matches exceeds the ${MAX_DELETIONS} safety cap — aborting. Inspect manually.`);
    process.exit(1);
  }

  // Backup outside the repo so it is never committed.
  const backupPath = resolve(__dirname, '..', '..', `test-data-backup-${DATE}.json`);
  writeFileSync(backupPath, JSON.stringify({
    _note: 'Backup of integration-test records removed from production. Restore with PutCommand per Item.',
    region: REGION, date: ALL_DATES ? 'ALL' : DATE, prefix: TEST_PREFIX,
    orders: { table: ORDERS_TABLE, count: orders.length, Items: orders },
    customers: { table: CUSTOMERS_TABLE, count: customers.length, Items: customers },
    closeAudits: { table: SETTINGS_TABLE, count: audits.length, Items: audits },
  }, null, 2), 'utf8');
  console.log(`\nBackup written: ${backupPath}`);

  if (!APPLY) {
    console.log('Dry run — nothing deleted. Re-run with --apply to commit.');
    return;
  }

  for (const o of orders) {
    await doc.send(new DeleteCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: `ORDER#${o.orderId}`, SK: 'META' },
    }));
    console.log(`  deleted order ${o.orderId}`);
  }
  for (const c of customers) {
    await doc.send(new DeleteCommand({
      TableName: CUSTOMERS_TABLE,
      Key: { PK: c.PK, SK: c.SK },
    }));
    console.log(`  deleted customer ${c.PK}`);
  }
  for (const a of audits) {
    await doc.send(new DeleteCommand({
      TableName: SETTINGS_TABLE,
      Key: { PK: a.PK, SK: a.SK },
    }));
    console.log(`  deleted audit ${a.SK}`);
  }

  console.log(`\n✅ Removed ${orders.length} order(s) (RM${orderTotal.toFixed(2)}), `
    + `${customers.length} customer(s) and ${audits.length} close-audit row(s).`);
}

main().catch(e => { console.error(e); process.exit(1); });
