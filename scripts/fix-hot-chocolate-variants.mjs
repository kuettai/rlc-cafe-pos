/**
 * Fix Hot Chocolate's oat milk option.
 *
 * Problem: the item carries a LEGACY `variants` entry
 *   { name: 'Oat Milk +1', priceModifier: 9 }
 * on a basePrice of 8. Both pricing paths compute basePrice + priceModifier,
 * so selecting it would charge RM17 instead of RM9.
 *
 * It is currently unreachable in the UI — every renderer (variants.js:40,
 * pos-walkup.js:66, app.js:277, pos-voucher.js:314) prefers `variantGroups`
 * when present, and Hot Chocolate already has a Temperature group. So the
 * side effect today is that oat milk simply cannot be ordered on it.
 *
 * Fix: express oat milk as an optional variantGroup at +RM1 (matching Latte
 * and Matcha Latte) and clear the legacy array. Result: RM8 + RM1 = RM9.
 *
 * Run from the repo root (reads AWS creds from your environment):
 *   node scripts/fix-hot-chocolate-variants.mjs          # dry run, prints diff
 *   node scripts/fix-hot-chocolate-variants.mjs --apply  # writes to DynamoDB
 *
 * Region: ap-southeast-5 (matches the deployed stack).
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = 'ap-southeast-5';
const MENU_TABLE = process.env.MENU_TABLE || 'rlc-cafe-menu';
const MENU_ITEM_ID = 'c2c644d4-4278-4934-8dfe-79ce08403a86'; // Hot Chocolate

const APPLY = process.argv.includes('--apply');

const client = new DynamoDBClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(client);

const TARGET_GROUPS = [
  { group: 'Temperature', type: 'single',   options: [{ name: 'Hot', price: 0 }, { name: 'Iced', price: 1 }] },
  { group: 'Milk',        type: 'optional', options: [{ name: 'Oat Milk', price: 1 }] },
];

async function main() {
  const key = { PK: `MENU#${MENU_ITEM_ID}`, SK: 'META' };
  const { Item } = await doc.send(new GetCommand({ TableName: MENU_TABLE, Key: key }));

  if (!Item) {
    console.error(`Menu item ${MENU_ITEM_ID} not found in ${MENU_TABLE}`);
    process.exit(1);
  }

  console.log(`Item:      ${Item.name} (basePrice RM${Item.basePrice})`);
  console.log(`BEFORE     variants:      ${JSON.stringify(Item.variants || [])}`);
  console.log(`           variantGroups: ${JSON.stringify(Item.variantGroups || [])}`);
  console.log(`AFTER      variants:      []`);
  console.log(`           variantGroups: ${JSON.stringify(TARGET_GROUPS)}`);
  console.log(`Oat milk price: RM${Item.basePrice} + RM1 = RM${Number(Item.basePrice) + 1}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to commit.');
    return;
  }

  await doc.send(new UpdateCommand({
    TableName: MENU_TABLE,
    Key: key,
    UpdateExpression: 'SET variants = :v, variantGroups = :g',
    ExpressionAttributeValues: { ':v': [], ':g': TARGET_GROUPS },
  }));

  console.log('\n✅ Updated. Hot Chocolate + Oat Milk now prices at RM9.');
}

main().catch(e => { console.error(e); process.exit(1); });
