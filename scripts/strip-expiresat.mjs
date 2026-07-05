/*
 * Strip `expiresAt` from every order that has moved past PENDING. The
 * table has TTL enabled on the `expiresAt` attribute; historical
 * transitions never cleared it, so ARCHIVED / CANCELLED / EXPIRED /
 * PREPARING / READY orders were silently on borrowed time.
 *
 * Only PENDING orders keep their expiresAt (they NEED the numeric TTL
 * so a never-approved order eventually gets swept).
 *
 * Pre-orders (isPreOrder=true) store expiresAt as an ISO string — TTL
 * ignores non-numeric values, so those wouldn't be deleted anyway.
 * Still, once a pre-order has left PREPARING it makes sense to strip
 * the attribute for consistency. This script does that.
 *
 * Defaults to dry run; pass --confirm to apply.
 *
 *   node scripts/strip-expiresat.mjs
 *   node scripts/strip-expiresat.mjs --confirm
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const REGION  = 'ap-southeast-5';
const TABLE   = 'rlc-cafe-orders';
const CONFIRM = process.argv.slice(2).includes('--confirm');

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Any status where TTL must not fire — anything except PENDING.
const KEEP_TTL_STATUS = new Set(['PENDING']);

async function scanAll() {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: TABLE,
      // Server-side filter: fetch orders that (a) have expiresAt set AND
      // (b) are not PENDING. Reduces payload significantly.
      FilterExpression: 'attribute_exists(expiresAt) AND #s <> :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':pending': 'PENDING' },
      ExclusiveStartKey: key,
    }));
    if (r.Items) items.push(...r.Items);
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

function stripEmoji(s) { return String(s || '').replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u, ''); }

async function main() {
  console.log(`Region:  ${REGION}`);
  console.log(`Table:   ${TABLE}`);
  console.log(`Mode:    ${CONFIRM ? 'APPLY' : 'DRY RUN (pass --confirm to apply)'}`);
  console.log('');

  const targets = await scanAll();
  console.log(`Non-PENDING orders with expiresAt: ${targets.length}`);
  console.log('');

  // Group by status for the summary
  const byStatus = {};
  for (const o of targets) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  for (const [s, n] of Object.entries(byStatus).sort()) console.log(`  ${s.padEnd(12)} ${n}`);
  console.log('');

  for (const o of targets) {
    const label = `${o.orderId?.slice(0, 8) || '?'}  [${o.status}]  ${(o.customerName || '(guest)').slice(0, 20).padEnd(20)}  expiresAt=${o.expiresAt}`;
    console.log(`  ${CONFIRM ? 'strip' : 'would strip'}  ${label}`);
    if (!CONFIRM) continue;
    // Guard the write with a status condition — if a PENDING transition
    // is racing (e.g., the cron just marked it EXPIRED and set updatedAt),
    // we still only want to strip when the row is in a non-PENDING state.
    try {
      await doc.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: o.PK, SK: o.SK },
        UpdateExpression: 'REMOVE expiresAt',
        ConditionExpression: '#s <> :pending',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':pending': 'PENDING' },
      }));
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') {
        console.log(`      ⚠ skipped — status became PENDING between scan and update`);
      } else {
        throw e;
      }
    }
  }

  console.log('');
  console.log('─── Summary ─────────────────────────────────────');
  console.log(`${CONFIRM ? 'Stripped: ' : 'Would strip: '}${targets.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
