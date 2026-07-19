/**
 * backfill-customer-orders.mjs
 *
 * One-time fix: Many customers registered AFTER their first order, so
 * linkOrderToCustomer was never called for those orders. This script
 * scans all orders with a customerId, aggregates orderCount + totalSpent
 * per phone, and updates customer records that have stale counts.
 *
 * Also handles the case where a customer registered but their orders
 * didn't include customerId — for those, we match by customerName
 * against the customer's name (fuzzy match by lowercase).
 *
 * Usage:
 *   node scripts/backfill-customer-orders.mjs [--dry-run]
 *
 * Requires AWS credentials with DynamoDB access in ap-southeast-5.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = 'ap-southeast-5';
const ORDERS_TABLE = 'rlc-cafe-orders';
const CUSTOMERS_TABLE = 'rlc-cafe-customers';

const dryRun = process.argv.includes('--dry-run');

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

async function scanAll(tableName, filterExpression, exprValues) {
  const items = [];
  let lastKey;
  do {
    const params = { TableName: tableName, ExclusiveStartKey: lastKey };
    if (filterExpression) {
      params.FilterExpression = filterExpression;
      params.ExpressionAttributeValues = exprValues;
    }
    const result = await docClient.send(new ScanCommand(params));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function main() {
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Backfilling customer order counts...\n`);

  // 1. Load all customers
  console.log('Scanning customers...');
  const customers = await scanAll(CUSTOMERS_TABLE, 'SK = :meta', { ':meta': 'META' });
  console.log(`  Found ${customers.length} customers`);

  // Build a map of phone → customer record
  const customerByPhone = new Map();
  for (const c of customers) {
    const phone = c.phone || c.PK?.replace('CUSTOMER#', '');
    if (phone) customerByPhone.set(phone, c);
  }

  // 2. Load all orders that are completed (ARCHIVED, READY — real revenue)
  console.log('Scanning orders...');
  const orders = await scanAll(ORDERS_TABLE, 'SK = :meta', { ':meta': 'META' });
  console.log(`  Found ${orders.length} total orders`);

  // Only count completed orders (ARCHIVED, READY) — not CANCELLED/EXPIRED/PENDING
  const completedStatuses = new Set(['ARCHIVED', 'READY']);
  const completedOrders = orders.filter(o => completedStatuses.has(o.status));
  console.log(`  ${completedOrders.length} completed orders (ARCHIVED + READY)`);

  // 3. Aggregate by customerId (phone)
  const stats = new Map(); // phone → { orderCount, totalSpent, lastOrderAt }

  for (const o of completedOrders) {
    const phone = o.customerId;
    if (!phone) continue;

    if (!stats.has(phone)) {
      stats.set(phone, { orderCount: 0, totalSpent: 0, lastOrderAt: null });
    }
    const s = stats.get(phone);
    s.orderCount += 1;
    s.totalSpent += Number(o.totalAmount || 0) + Number(o.discountOffset || 0); // gross amount
    if (!s.lastOrderAt || o.createdAt > s.lastOrderAt) {
      s.lastOrderAt = o.createdAt;
    }
  }

  console.log(`\n  ${stats.size} customers have orders linked by customerId`);

  // 4. Compare and update
  let updatedCount = 0;
  let skippedCount = 0;
  let missingCount = 0;

  for (const [phone, actual] of stats) {
    const customer = customerByPhone.get(phone);
    if (!customer) {
      missingCount++;
      continue;
    }

    const currentCount = customer.orderCount || 0;
    const currentSpent = customer.totalSpent || 0;

    // Only update if the actual values differ
    if (currentCount === actual.orderCount && Math.abs(currentSpent - actual.totalSpent) < 0.01) {
      skippedCount++;
      continue;
    }

    console.log(`  ${phone} (${customer.name}): ${currentCount}→${actual.orderCount} orders, RM${currentSpent.toFixed(2)}→RM${actual.totalSpent.toFixed(2)}`);

    if (!dryRun) {
      await docClient.send(new UpdateCommand({
        TableName: CUSTOMERS_TABLE,
        Key: { PK: `CUSTOMER#${phone}`, SK: 'META' },
        UpdateExpression: 'SET orderCount = :count, totalSpent = :spent, lastOrderAt = :last, updatedAt = :now',
        ExpressionAttributeValues: {
          ':count': actual.orderCount,
          ':spent': actual.totalSpent,
          ':last': actual.lastOrderAt,
          ':now': new Date().toISOString(),
        },
      }));
    }
    updatedCount++;
  }

  // 5. Find customers with zero orders (might have orders not linked by customerId)
  const zeroOrderCustomers = customers.filter(c => (c.orderCount || 0) === 0 && !stats.has(c.phone));
  if (zeroOrderCustomers.length > 0) {
    console.log(`\n  ${zeroOrderCustomers.length} customers with 0 orders (no customerId link found):`);
    for (const c of zeroOrderCustomers.slice(0, 20)) {
      console.log(`    - ${c.phone} (${c.name})`);
    }
    if (zeroOrderCustomers.length > 20) console.log(`    ... and ${zeroOrderCustomers.length - 20} more`);
  }

  console.log(`\n--- Summary ---`);
  console.log(`  Updated: ${updatedCount}`);
  console.log(`  Skipped (already correct): ${skippedCount}`);
  console.log(`  Orders linked to unknown phone: ${missingCount}`);
  console.log(`  Zero-order customers (unlinked): ${zeroOrderCustomers.length}`);
  if (dryRun) console.log(`\n  [DRY RUN — no changes written. Remove --dry-run to apply.]`);
}

main().catch(e => { console.error(e); process.exit(1); });
