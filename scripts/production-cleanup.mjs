/*
 * Production cleanup — wipes transactional data tables while preserving
 * config tables. Use with extreme care; deletes are irreversible.
 *
 * Default mode is DRY RUN (counts only). Pass `--confirm` to actually
 * delete. A 5-second countdown precedes any destructive action so you
 * have a chance to Ctrl-C out.
 *
 * Tables wiped:
 *   - rlc-cafe-orders
 *   - rlc-cafe-customers
 *   - rlc-cafe-vouchers
 *
 * Tables left untouched:
 *   - rlc-cafe-menu, rlc-cafe-ingredients, rlc-cafe-users, rlc-cafe-settings
 *
 * Run from any cwd:
 *   node scripts/production-cleanup.mjs           # dry run
 *   node scripts/production-cleanup.mjs --confirm # actually delete
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve AWS SDK out of backend/node_modules regardless of cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

// ─── Config ─────────────────────────────────────────────────────────

const REGION = 'ap-southeast-5';
const TABLES_TO_WIPE = [
  { label: 'Orders',    name: 'rlc-cafe-orders'    },
  { label: 'Customers', name: 'rlc-cafe-customers' },
  { label: 'Vouchers',  name: 'rlc-cafe-vouchers'  },
];
const TABLES_PRESERVED = [
  'rlc-cafe-menu',
  'rlc-cafe-ingredients',
  'rlc-cafe-users',
  'rlc-cafe-settings',
];

const BATCH_SIZE = 25;       // BatchWriteItem hard limit
const MAX_RETRIES = 5;       // for UnprocessedItems

// ─── Setup ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');

const client = new DynamoDBClient({ region: REGION });
const doc    = DynamoDBDocumentClient.from(client);

// ─── Helpers ────────────────────────────────────────────────────────

function banner() {
  const line = '═'.repeat(64);
  console.log(line);
  console.log('  ⚠️  THIS WILL DELETE ALL ORDERS, CUSTOMERS, AND VOUCHERS');
  console.log(`  Mode: ${CONFIRM ? 'LIVE — will permanently delete' : 'DRY RUN — counts only'}`);
  console.log(`  Region: ${REGION}`);
  console.log(line);
  console.log();
}

async function countdown(seconds) {
  process.stdout.write('  Starting in ');
  for (let i = seconds; i >= 1; i--) {
    process.stdout.write(`${i}... `);
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write('\n\n');
}

/** Scan a table for all PK+SK pairs, paginating through LastEvaluatedKey. */
async function scanAllKeys(tableName) {
  const keys = [];
  let exclusiveStartKey;
  let pages = 0;
  do {
    const resp = await doc.send(new ScanCommand({
      TableName: tableName,
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of (resp.Items || [])) {
      keys.push({ PK: item.PK, SK: item.SK });
    }
    exclusiveStartKey = resp.LastEvaluatedKey;
    pages += 1;
  } while (exclusiveStartKey);
  return { keys, pages };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Issue a BatchWrite delete for up to 25 keys, retrying any UnprocessedItems
 * with exponential back-off. Returns the count actually deleted.
 */
async function batchDelete(tableName, keys) {
  let pending = {
    [tableName]: keys.map(k => ({ DeleteRequest: { Key: k } })),
  };
  let totalDeleted = 0;
  let attempt = 0;

  while (pending && pending[tableName] && pending[tableName].length > 0) {
    if (attempt > MAX_RETRIES) {
      throw new Error(`BatchWrite gave up with ${pending[tableName].length} unprocessed items after ${MAX_RETRIES} retries`);
    }
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 2 ** attempt * 100));  // 200, 400, 800ms…
    }
    const submittedCount = pending[tableName].length;
    const resp = await doc.send(new BatchWriteCommand({ RequestItems: pending }));
    const unprocessed = (resp.UnprocessedItems && resp.UnprocessedItems[tableName]) || [];
    totalDeleted += submittedCount - unprocessed.length;
    pending = unprocessed.length ? { [tableName]: unprocessed } : null;
    attempt += 1;
  }
  return totalDeleted;
}

// ─── Per-table runner ───────────────────────────────────────────────

async function processTable(table) {
  console.log(`▸ Scanning ${table.name}…`);
  const { keys, pages } = await scanAllKeys(table.name);
  console.log(`  found ${keys.length} item${keys.length === 1 ? '' : 's'} (${pages} page${pages === 1 ? '' : 's'})`);

  if (!CONFIRM) {
    console.log(`  [DRY RUN] would delete ${keys.length} item${keys.length === 1 ? '' : 's'} from ${table.name}\n`);
    return { table: table.label, name: table.name, deleted: 0, found: keys.length, dryRun: true };
  }

  if (keys.length === 0) {
    console.log(`  nothing to delete\n`);
    return { table: table.label, name: table.name, deleted: 0, found: 0, dryRun: false };
  }

  const batches = chunk(keys, BATCH_SIZE);
  let deleted = 0;
  for (let i = 0; i < batches.length; i++) {
    const n = await batchDelete(table.name, batches[i]);
    deleted += n;
    process.stdout.write(`\r  Deleted ${deleted}/${keys.length} from ${table.name}`);
  }
  process.stdout.write('\n\n');
  return { table: table.label, name: table.name, deleted, found: keys.length, dryRun: false };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  banner();

  if (CONFIRM) {
    await countdown(5);
  }

  const summaries = [];
  for (const table of TABLES_TO_WIPE) {
    try {
      summaries.push(await processTable(table));
    } catch (err) {
      console.error(`  ✗ failed on ${table.name}: ${err.message}\n`);
      summaries.push({ table: table.label, name: table.name, deleted: 0, found: 0, error: err.message });
    }
  }

  console.log('═══ PRODUCTION CLEANUP COMPLETE ══════════════════════════════');
  for (const s of summaries) {
    if (s.error) {
      console.log(`  ${s.table.padEnd(10)} ✗ error — ${s.error}`);
    } else if (s.dryRun) {
      console.log(`  ${s.table.padEnd(10)} would delete ${s.found} items`);
    } else {
      console.log(`  ${s.table.padEnd(10)} deleted ${s.deleted}/${s.found} items`);
    }
  }
  console.log();
  console.log('  Config tables UNTOUCHED:');
  for (const t of TABLES_PRESERVED) console.log(`    - ${t}`);
  console.log('═══════════════════════════════════════════════════════════════');

  if (!CONFIRM) {
    console.log('\nDRY RUN — no data was deleted. Add --confirm to execute.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
