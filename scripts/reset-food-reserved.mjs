/*
 * Reset stale foodReserved values on menu items.
 *
 * Scans rlc-cafe-menu and sets foodReserved = 0 on any META row where
 * foodReserved > 0. Used when foodReserved has drifted from reality
 * (e.g., after test orders were bulk-deleted without going through the
 * normal ready/archive flow that would decrement reservations).
 *
 * Defaults to dry run; pass --confirm to actually mutate.
 *
 *   node scripts/reset-food-reserved.mjs            # dry run
 *   node scripts/reset-food-reserved.mjs --confirm  # apply
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

const REGION = 'ap-southeast-5';
const TABLE  = process.env.MENU_TABLE || 'rlc-cafe-menu';
const CONFIRM = process.argv.slice(2).includes('--confirm');

const client = new DynamoDBClient({ region: REGION });
const doc    = DynamoDBDocumentClient.from(client);

async function scanAll() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(new ScanCommand({
      TableName: TABLE,
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

  const items = await scanAll();
  const metaItems = items.filter(i => i.SK === 'META');
  const stale = metaItems.filter(i => Number(i.foodReserved || 0) > 0);

  console.log(`Scanned ${items.length} row(s), ${metaItems.length} menu META row(s).`);
  console.log(`Rows with foodReserved > 0: ${stale.length}`);
  console.log('');

  if (stale.length === 0) {
    console.log('Nothing to reset — everything already at 0.');
    return;
  }

  for (const item of stale) {
    console.log(`  ${CONFIRM ? 'reset' : 'would reset'}  ${item.name || item.menuItemId}  (foodReserved=${item.foodReserved} → 0)`);
    if (!CONFIRM) continue;
    await doc.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: item.PK, SK: item.SK },
      UpdateExpression: 'SET foodReserved = :z',
      ExpressionAttributeValues: { ':z': 0 },
    }));
  }

  console.log('');
  console.log('─── Summary ─────────────────────────────────────');
  console.log(`Menu items scanned:  ${metaItems.length}`);
  console.log(`Rows with stale >0:  ${stale.length}`);
  console.log(`${CONFIRM ? 'Reset to 0:          ' : 'Would reset:         '}${stale.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
