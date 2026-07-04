/*
 * Backfill pre-orders that were written under the v37 (broken) storage
 * convention.
 *
 * Broken shape:   totalAmount = <gross>, discountOffset = <gross>
 * Correct shape:  totalAmount = 0,       discountOffset = <gross>, grossAmount = <gross>
 *
 * This normalizes pre-orders to match the rest of the codebase, which
 * treats `totalAmount` as the net (post-discount) collected amount.
 *
 * Only touches rows where:
 *   - isPreOrder === true
 *   - discountOffset > 0
 *   - totalAmount === discountOffset  (i.e. the broken pattern)
 *
 * Defaults to dry run; pass --confirm to apply.
 *
 *   node scripts/backfill-preorder-totals.mjs
 *   node scripts/backfill-preorder-totals.mjs --confirm
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const REGION  = 'ap-southeast-5';
const TABLE   = process.env.ORDERS_TABLE || 'rlc-cafe-orders';
const CONFIRM = process.argv.slice(2).includes('--confirm');

const client = new DynamoDBClient({ region: REGION });
const doc    = DynamoDBDocumentClient.from(client);

async function scanAllPreorders() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'isPreOrder = :t',
      ExpressionAttributeValues: { ':t': true },
      ExclusiveStartKey,
    }));
    if (res.Items) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function main() {
  console.log(`Region: ${REGION}`);
  console.log(`Table:  ${TABLE}`);
  console.log(`Mode:   ${CONFIRM ? 'APPLY' : 'DRY RUN (pass --confirm to apply)'}`);
  console.log('');

  const preorders = await scanAllPreorders();
  console.log(`Pre-orders scanned: ${preorders.length}`);

  const stale = [];
  const skipped = [];
  for (const o of preorders) {
    const total = Number(o.totalAmount || 0);
    const off   = Number(o.discountOffset || 0);
    // Broken shape: total == off and both > 0
    if (total > 0 && off > 0 && Math.abs(total - off) < 0.001) {
      stale.push(o);
    } else {
      skipped.push({ o, reason: total === 0 ? 'already correct' : 'unexpected shape' });
    }
  }

  console.log(`Broken shape (total == offset > 0): ${stale.length}`);
  console.log(`Already correct or skipped:         ${skipped.length}`);
  console.log('');

  for (const o of stale) {
    const gross = Number(o.totalAmount);
    console.log(`  ${CONFIRM ? 'fix' : 'would fix'}  ${o.PK}  ${o.customerName || ''}  gross=${gross}  →  totalAmount=0, grossAmount=${gross}`);
    if (!CONFIRM) continue;
    await doc.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: o.PK, SK: o.SK },
      UpdateExpression: 'SET totalAmount = :zero, grossAmount = :g',
      ExpressionAttributeValues: { ':zero': 0, ':g': gross },
    }));
  }

  console.log('');
  console.log('─── Summary ─────────────────────────────────────');
  console.log(`Pre-orders scanned:  ${preorders.length}`);
  console.log(`${CONFIRM ? 'Fixed:               ' : 'Would fix:           '}${stale.length}`);
  console.log(`Skipped:             ${skipped.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
