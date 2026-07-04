/*
 * Backfill nameLower on existing user records.
 *
 * The login fallback scan (auth.ts) now matches on `nameLower` instead
 * of `name` so case-insensitive login works. New/updated users get
 * nameLower set by admin.ts, but records created before that change
 * still need a one-time backfill.
 *
 * Defaults to dry run; pass --confirm to actually mutate.
 *
 *   node scripts/backfill-user-namelower.mjs            # dry run
 *   node scripts/backfill-user-namelower.mjs --confirm  # apply
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
const TABLE   = process.env.USERS_TABLE || 'rlc-cafe-users';
const CONFIRM = process.argv.slice(2).includes('--confirm');

const client = new DynamoDBClient({ region: REGION });
const doc    = DynamoDBDocumentClient.from(client);

async function scanAll() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
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
  console.log(`Scanned ${items.length} row(s).`);

  const targets = [];
  const skipped = [];
  for (const item of items) {
    if (typeof item.name !== 'string') { skipped.push({ item, reason: 'no name field' }); continue; }
    const desired = item.name.toLowerCase().trim();
    if (item.nameLower === desired) { skipped.push({ item, reason: 'already correct' }); continue; }
    targets.push({ item, desired });
  }

  console.log(`Needs backfill: ${targets.length}`);
  console.log(`Already OK / skipped: ${skipped.length}`);
  console.log('');

  for (const { item, desired } of targets) {
    console.log(`  ${CONFIRM ? 'set' : 'would set'}  ${item.PK}  name="${item.name}"  →  nameLower="${desired}"${item.nameLower !== undefined ? ` (was "${item.nameLower}")` : ''}`);
    if (!CONFIRM) continue;
    await doc.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: item.PK, SK: item.SK },
      UpdateExpression: 'SET nameLower = :nl',
      ExpressionAttributeValues: { ':nl': desired },
    }));
  }

  console.log('');
  console.log('─── Summary ─────────────────────────────────────');
  console.log(`Scanned:               ${items.length}`);
  console.log(`${CONFIRM ? 'Backfilled:            ' : 'Would backfill:        '}${targets.length}`);
  console.log(`Already OK / skipped:  ${skipped.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
