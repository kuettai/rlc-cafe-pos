/**
 * Add "Matcha Sparkling" menu item + recipe to DynamoDB.
 * Item is created as DISABLED (isActive=false, isEnabledToday=false).
 *
 * Run from the backend/ directory:
 *   cd backend && node ../scripts/add-matcha-sparkling.mjs
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
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuid } = require('uuid');

const REGION = 'ap-southeast-5';
const MENU_TABLE = process.env.MENU_TABLE || 'rlc-cafe-menu';
const INGREDIENTS_TABLE = process.env.INGREDIENTS_TABLE || 'rlc-cafe-ingredients';

const client = new DynamoDBClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(client);

// ─── Menu Item ───────────────────────────────────────────────────────────────
const menuItemId = uuid();
const menuItem = {
  PK: `MENU#${menuItemId}`,
  SK: 'META',
  menuItemId,
  name: 'Matcha Sparkling',
  category: 'DRINK',
  basePrice: 9,
  variants: [],
  variantGroups: [],
  imageUrl: null,
  sortOrder: 50,
  isActive: false,
  isEnabledToday: false,
  celebrationEligible: true,
};

await doc.send(new PutCommand({ TableName: MENU_TABLE, Item: menuItem }));
console.log(`✓ Menu item created: ${menuItem.name} (${menuItemId}) — DISABLED`);

// ─── Recipe ──────────────────────────────────────────────────────────────────
// Look up ingredient IDs by name
const ingredients = await doc.send(new ScanCommand({ TableName: INGREDIENTS_TABLE }));
const allIngredients = (ingredients.Items || []).filter(i => i.SK === 'META');

function findIngredient(name) {
  const found = allIngredients.find(i => i.name.toLowerCase() === name.toLowerCase())
    || allIngredients.find(i => i.name.toLowerCase().includes(name.toLowerCase())
       && !i.name.toLowerCase().includes('decaf'));
  if (!found) {
    console.warn(`  ⚠ Ingredient "${name}" not found — skipping recipe entry`);
    return null;
  }
  return found;
}

const recipeIngredients = [
  { name: 'Coffee Beans', quantity: 18 },     // 18g
  { name: 'Tonic Water', quantity: 200 },     // 200ml
  { name: 'Matcha Powder', quantity: 4 },     // 4g
];

const recipeKey = `RECIPE#${menuItemId}#default`;
let recipeCount = 0;

for (const { name, quantity } of recipeIngredients) {
  const ing = findIngredient(name);
  if (!ing) continue;
  await doc.send(new PutCommand({
    TableName: INGREDIENTS_TABLE,
    Item: { PK: recipeKey, SK: `INGREDIENT#${ing.ingredientId}`, ingredientId: ing.ingredientId, quantity },
  }));
  console.log(`  ✓ Recipe: ${quantity} ${ing.unit || 'units'} of ${ing.name}`);
  recipeCount++;
}

console.log(`\n✓ Done. Menu item: ${menuItemId}, recipe entries: ${recipeCount}`);
console.log(`  Note: Item is DISABLED. Enable via Admin → Menu → toggle active.`);
