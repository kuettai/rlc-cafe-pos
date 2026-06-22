/*
 * Surgical cleanup — deletes ONLY orders tagged with
 * seedBatch = 'reports-test' (the marker written by
 * scripts/seed-report-data.mjs). Real orders never carry that
 * attribute, so they're naturally untouched by the FilterExpression.
 *
 * Defaults to dry run; pass --confirm to actually delete.
 *
 *   node scripts/cleanup-seed-data.mjs           # dry run
 *   node scripts/cleanup-seed-data.mjs --confirm # delete
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

// ─── Config ─────────────────────────────────────────────────────────

const REGION = 'ap-southeast-5';
const TABLE  = process.env.ORDERS_TABLE || 'rlc-cafe-orders';
const SEED_BATCH = 'reports-test';

const BATCH_SIZE = 25;
const MAX_RETRIES = 5;

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');

const client = new DynamoDBClient({ region: REGION });
const doc    = DynamoDBDocumentClient.from(client);

// ─── Helpers ────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }
function localDateStr(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

async function scanSeedOrders() {
  const items = [];
  let exclusiveStartKey;
  let pages = 0;
  do {
    const resp = await doc.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'seedBatch = :sb',
      ExpressionAttributeValues: { ':sb': SEED_BATCH },
      ProjectionExpression: 'PK, SK, orderId, customerName, createdAt',
      ExclusiveStartKey: exclusiveStartKey,
    }));
    items.push(...(resp.Items || []));
    exclusiveStartKey = resp.LastEvaluatedKey;
    pages += 1;
  } while (exclusiveStartKey);
  return { items, pages };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function batchDelete(tableName, keys) {
  let pending = { [tableName]: keys.map(k => ({ DeleteRequest: { Key: k } })) };
  let totalDeleted = 0;
  let attempt = 0;

  while (pending && pending[tableName] && pending[tableName].length > 0) {
    if (attempt > MAX_RETRIES) {
      throw new Error(`gave up with ${pending[tableName].length} unprocessed items after ${MAX_RETRIES} retries`);
    }
    if (attempt > 0) await new Promise(r => setTimeout(r, 2 ** attempt * 100));
    const submitted = pending[tableName].length;
    const resp = await doc.send(new BatchWriteCommand({ RequestItems: pending }));
    const unprocessed = (resp.UnprocessedItems && resp.UnprocessedItems[tableName]) || [];
    totalDeleted += submitted - unprocessed.length;
    pending = unprocessed.length ? { [tableName]: unprocessed } : null;
    attempt += 1;
  }
  return totalDeleted;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(64));
  console.log(`  SAFE MODE: Only removing test seed data (seedBatch='${SEED_BATCH}')`);
  console.log(`  Mode:   ${CONFIRM ? 'LIVE — will permanently delete matching rows' : 'DRY RUN — counts only'}`);
  console.log(`  Table:  ${TABLE}`);
  console.log(`  Region: ${REGION}`);
  console.log('═'.repeat(64));
  console.log();

  console.log(`▸ Scanning ${TABLE} for seedBatch='${SEED_BATCH}'…`);
  const { items, pages } = await scanSeedOrders();
  console.log(`  found ${items.length} seed order${items.length === 1 ? '' : 's'} (${pages} page${pages === 1 ? '' : 's'})\n`);

  if (items.length === 0) {
    console.log('Nothing to clean up. Real orders untouched.');
    return;
  }

  // Print the matching rows so the operator can sanity-check before --confirm.
  for (const o of items) {
    const idShort = String(o.orderId || '').slice(0, 8);
    console.log(`  · ${localDateStr(o.createdAt)}  ${idShort}  ${o.customerName || '—'}`);
  }
  console.log();

  if (!CONFIRM) {
    console.log(`DRY RUN — would delete ${items.length} seed order${items.length === 1 ? '' : 's'}.`);
    console.log('Add --confirm to execute. Real orders (without seedBatch) are never touched.');
    return;
  }

  // Delete in batches of 25 with retry on UnprocessedItems.
  const keys = items.map(i => ({ PK: i.PK, SK: i.SK }));
  const batches = chunk(keys, BATCH_SIZE);
  let deleted = 0;
  for (const b of batches) {
    deleted += await batchDelete(TABLE, b);
    process.stdout.write(`\r  Deleted ${deleted}/${keys.length} from ${TABLE}`);
  }
  process.stdout.write('\n\n');

  console.log('═══ SEED CLEANUP COMPLETE ════════════════════════════════════');
  console.log(`  Deleted ${deleted} seed order${deleted === 1 ? '' : 's'}. Real orders untouched.`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
