/*
 * Bump the expiryDate on expired TV-display slides.
 *
 * Scans rlc-cafe-settings for DISPLAY_SLIDE#<id> / META records and sets
 * expiryDate to a target date on any slide whose expiryDate is already in
 * the past. Used when every slide has aged out and the TV display has
 * nothing to show.
 *
 * NOTE ON ATTRIBUTE NAMES: a slide's date field is `expiryDate` (a plain
 * YYYY-MM-DD string). It is NOT `expiresAt` — that is the settings-table
 * DynamoDB TTL, used only by PUSH_SUB# and WEBAUTHN_CHALLENGE# records.
 * This script never reads or writes `expiresAt`, and must not start to:
 * a numeric expiresAt on a slide would let TTL delete it silently.
 *
 * Only `expiryDate` is touched. `startDate`, `sortOrder`, `imageUrl`,
 * `title` and `createdAt` are left exactly as found.
 *
 * Idempotent: a slide whose expiryDate is already >= the target is skipped,
 * so re-running changes nothing. Slides that are currently active (expiry
 * today or later) are also skipped — this script only revives dead slides.
 *
 * Defaults to dry run; pass --apply (or --confirm) to actually mutate.
 *
 *   node scripts/bump-slide-expiry.mjs                       # dry run
 *   node scripts/bump-slide-expiry.mjs --apply               # apply
 *   node scripts/bump-slide-expiry.mjs --target=2026-12-31   # override target
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
const TABLE  = process.env.SETTINGS_TABLE || 'rlc-cafe-settings';

const args   = process.argv.slice(2);
const APPLY  = args.includes('--apply') || args.includes('--confirm');
const targetArg = args.find(a => a.startsWith('--target='));
const TARGET = targetArg ? targetArg.split('=')[1] : '2026-12-31';

if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET)) {
  console.error(`Invalid --target "${TARGET}" — expected YYYY-MM-DD.`);
  process.exit(1);
}

// The public read path (backend/src/routes/display.ts) compares against the
// UTC date via new Date().toISOString().split('T')[0]. Match that exactly so
// this script's notion of "expired" is the same one the display uses.
const TODAY = new Date().toISOString().split('T')[0];

const client = new DynamoDBClient({ region: REGION });
const doc    = DynamoDBDocumentClient.from(client);

async function scanSlides() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :meta',
      ExpressionAttributeValues: { ':prefix': 'DISPLAY_SLIDE#', ':meta': 'META' },
      ExclusiveStartKey,
    }));
    if (res.Items) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

function label(s) {
  return `${s.title || '(untitled)'} [${s.slideId || s.PK}]`;
}

async function main() {
  console.log(`Region: ${REGION}`);
  console.log(`Table:  ${TABLE}`);
  console.log(`Today:  ${TODAY} (UTC, same basis as GET /api/display/slides)`);
  console.log(`Target: expiryDate = ${TARGET}`);
  console.log(`Mode:   ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);
  console.log('');

  const slides = await scanSlides();
  console.log(`Examined ${slides.length} DISPLAY_SLIDE# record(s).`);
  console.log('');

  const toChange = [];
  const skipped  = [];

  for (const s of slides) {
    // Legacy / hand-written records may be missing either date. Treat an
    // absent or non-string expiryDate as expired (the display filter's
    // `s.expiryDate >= today` is false for undefined, so such a slide is
    // invisible today) and give it the target date.
    const expiry = typeof s.expiryDate === 'string' ? s.expiryDate : null;

    if (expiry && expiry >= TARGET) {
      skipped.push([s, `expiryDate ${expiry} already >= target`]);
      continue;
    }
    if (expiry && expiry >= TODAY) {
      skipped.push([s, `still active (expiryDate ${expiry} >= today)`]);
      continue;
    }
    toChange.push([s, expiry]);
  }

  const active = slides.filter(s =>
    typeof s.startDate === 'string' && typeof s.expiryDate === 'string' &&
    s.startDate <= TODAY && s.expiryDate >= TODAY
  );
  console.log(`Active on the display right now: ${active.length}`);
  console.log('');

  if (toChange.length) {
    console.log('─── Diff ────────────────────────────────────────');
    for (const [s, expiry] of toChange) {
      console.log(`  ${APPLY ? 'bump ' : 'would bump'}  ${label(s)}`);
      console.log(`      startDate  : ${s.startDate ?? '(absent)'}  (unchanged)`);
      console.log(`      expiryDate : ${expiry ?? '(absent)'}  →  ${TARGET}`);
    }
    console.log('');
  }

  if (skipped.length) {
    console.log('─── Skipped ─────────────────────────────────────');
    for (const [s, why] of skipped) console.log(`  skip  ${label(s)} — ${why}`);
    console.log('');
  }

  let changed = 0;
  if (APPLY) {
    for (const [s] of toChange) {
      await doc.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: s.PK, SK: s.SK },
        UpdateExpression: 'SET expiryDate = :d',
        ExpressionAttributeValues: { ':d': TARGET },
        ConditionExpression: 'attribute_exists(PK)',
      }));
      changed++;
    }
  }

  console.log('─── Summary ─────────────────────────────────────');
  console.log(`Examined:      ${slides.length}`);
  console.log(`Would change:  ${APPLY ? 0 : toChange.length}`);
  console.log(`Changed:       ${changed}`);
  console.log(`Skipped:       ${skipped.length}`);
  if (!APPLY && toChange.length) {
    console.log('');
    console.log('No writes performed. Re-run with --apply to commit.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
