/*
 * Fix existing user records for case-insensitive login.
 *
 * Scans rlc-cafe-users, and for any record whose PK (USER#xxx) or
 * userId field contains uppercase characters, writes a new record
 * with PK and userId lowercased, then deletes the old mixed-case
 * record. Leaves name, role, pinHash, and other fields untouched.
 *
 * Defaults to dry run; pass --confirm to actually mutate.
 *
 *   node scripts/fix-user-case.mjs            # dry run
 *   node scripts/fix-user-case.mjs --confirm  # apply changes
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
  PutCommand,
  DeleteCommand,
  GetCommand,
} = require('@aws-sdk/lib-dynamodb');

// ─── Config ─────────────────────────────────────────────────────────

const REGION = 'ap-southeast-5';
const TABLE  = process.env.USERS_TABLE || 'rlc-cafe-users';

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');

const client = new DynamoDBClient({ region: REGION });
const doc    = DynamoDBDocumentClient.from(client);

// ─── Helpers ────────────────────────────────────────────────────────

function hasUpper(s) {
  return typeof s === 'string' && /[A-Z]/.test(s);
}

// PK format is "USER#<identifier>". We only care about case in the
// identifier portion; the "USER#" prefix stays uppercase to match how
// auth.ts constructs lookup keys (`USER#${userId.toLowerCase()}`).
function splitPK(pk) {
  if (typeof pk !== 'string') return { prefix: '', id: pk };
  const i = pk.indexOf('#');
  if (i < 0) return { prefix: '', id: pk };
  return { prefix: pk.slice(0, i + 1), id: pk.slice(i + 1) };
}

function lowercasePKId(pk) {
  const { prefix, id } = splitPK(pk);
  return prefix + (typeof id === 'string' ? id.toLowerCase() : id);
}

function pkNeedsFix(pk) {
  const { id } = splitPK(pk);
  return hasUpper(id);
}

async function scanAllUsers() {
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

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log(`Region: ${REGION}`);
  console.log(`Table:  ${TABLE}`);
  console.log(`Mode:   ${CONFIRM ? 'APPLY' : 'DRY RUN (pass --confirm to apply)'}`);
  console.log('');

  const items = await scanAllUsers();
  console.log(`Scanned ${items.length} item(s).`);
  console.log('');

  const toFix = [];
  const okay  = [];

  for (const item of items) {
    const pk       = item.PK;
    const sk       = item.SK;
    const userId   = item.userId;
    const needsFix = pkNeedsFix(pk) || hasUpper(userId);
    if (needsFix) {
      toFix.push(item);
    } else {
      okay.push(item);
      console.log(`  ok      ${pk} / ${sk}  (userId=${userId})  — already OK`);
    }
  }

  console.log('');
  console.log(`Already OK: ${okay.length}`);
  console.log(`Need fix:   ${toFix.length}`);
  console.log('');

  const fixed    = [];
  const skipped  = [];
  const collided = [];

  for (const item of toFix) {
    const oldPK = item.PK;
    const sk    = item.SK;
    const newPK = typeof oldPK === 'string' ? lowercasePKId(oldPK) : oldPK;
    const newUserId = typeof item.userId === 'string'
      ? item.userId.toLowerCase()
      : item.userId;

    console.log(`  fix     ${oldPK} → ${newPK}  (userId: ${item.userId} → ${newUserId})`);

    if (!CONFIRM) {
      skipped.push({ oldPK, newPK });
      continue;
    }

    // Guard: don't clobber an existing lowercase record if one
    // already exists at the target PK.
    const existing = await doc.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: newPK, SK: sk },
    }));
    if (existing.Item) {
      console.log(`          ⚠️  target ${newPK}/${sk} already exists — skipping to avoid clobber`);
      collided.push({ oldPK, newPK });
      continue;
    }

    const newItem = { ...item, PK: newPK, userId: newUserId };

    await doc.send(new PutCommand({
      TableName: TABLE,
      Item: newItem,
    }));

    await doc.send(new DeleteCommand({
      TableName: TABLE,
      Key: { PK: oldPK, SK: sk },
    }));

    fixed.push({ oldPK, newPK });
  }

  console.log('');
  console.log('─── Summary ─────────────────────────────────────');
  console.log(`Total scanned: ${items.length}`);
  console.log(`Already OK:    ${okay.length}`);
  console.log(`Needed fix:    ${toFix.length}`);
  if (CONFIRM) {
    console.log(`Fixed:         ${fixed.length}`);
    console.log(`Collisions:    ${collided.length}`);
    if (collided.length) {
      for (const c of collided) console.log(`  - ${c.oldPK} → ${c.newPK} (target exists)`);
    }
  } else {
    console.log(`Would fix:     ${skipped.length}  (dry run — re-run with --confirm)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
