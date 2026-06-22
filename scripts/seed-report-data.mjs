/*
 * Seed sample orders into the rlc-cafe-orders DynamoDB table for
 * exercising the reports page. Idempotent in the sense that every run
 * generates fresh UUIDs — running it multiple times will accumulate
 * orders. Use `scripts/cleanup-orders.mjs` (or DynamoDB console) to
 * remove if needed.
 *
 * Run from the backend/ directory so @aws-sdk/* imports resolve:
 *   cd backend && node ../scripts/seed-report-data.mjs
 * Or any cwd that has access to @aws-sdk/client-dynamodb +
 * @aws-sdk/lib-dynamodb + uuid in its node_modules.
 *
 * Region: ap-southeast-5 (matches the deployed stack).
 * Table:  ORDERS_TABLE env var or default 'rlc-cafe-orders'.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// The AWS SDK and uuid live under backend/node_modules. Resolve them
// relative to this script's location so it runs from any cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuid } = require('uuid');

const REGION = 'ap-southeast-5';
const TABLE  = process.env.ORDERS_TABLE || 'rlc-cafe-orders';

const client = new DynamoDBClient({ region: REGION });
const doc    = DynamoDBDocumentClient.from(client);

// ─── Reference data ─────────────────────────────────────────────────

// Sundays the café operated. Months are 0-indexed in JS Date.
const SUNDAYS = [
  new Date(2026, 5, 1),   // Jun 1
  new Date(2026, 5, 8),   // Jun 8
  new Date(2026, 5, 15),  // Jun 15
  new Date(2026, 5, 22),  // Jun 22
];

const NAMES = [
  'Sarah', 'James', 'Rachel', 'David', 'Emily', 'Michael', 'Grace',
  'Daniel', 'Joshua', 'Anna', 'Peter', 'Mary', 'Stephen', 'Lydia',
  'Aaron', 'Hannah', 'Caleb', 'Esther',
];

const MENU = [
  { menuItemId: 'latte-hot',     name: 'Latte',         variant: 'Hot',           unitPrice: 7.00, category: 'DRINK' },
  { menuItemId: 'latte-iced',    name: 'Latte',         variant: 'Iced',          unitPrice: 8.00, category: 'DRINK' },
  { menuItemId: 'long-black',    name: 'Long Black',    variant: null,            unitPrice: 6.00, category: 'DRINK' },
  { menuItemId: 'mocha-hot',     name: 'Mocha',         variant: 'Hot',           unitPrice:10.00, category: 'DRINK' },
  { menuItemId: 'matcha-latte',  name: 'Matcha Latte',  variant: null,            unitPrice: 8.00, category: 'DRINK' },
  { menuItemId: 'chai-latte',    name: 'Chai Latte',    variant: null,            unitPrice: 8.00, category: 'DRINK' },
  { menuItemId: 'soda-bp',       name: 'Soda',          variant: 'Butterfly Pea', unitPrice: 5.00, category: 'DRINK' },
  { menuItemId: 'soda-lemon',    name: 'Soda',          variant: 'Lemon',         unitPrice: 5.00, category: 'DRINK' },
  { menuItemId: 'nasi-lemak',    name: 'Nasi Lemak',    variant: null,            unitPrice: 3.20, category: 'FOOD'  },
  { menuItemId: 'mee-siam',      name: 'Mee Siam',      variant: null,            unitPrice: 4.50, category: 'FOOD'  },
  { menuItemId: 'curry-puff',    name: 'Curry Puff',    variant: null,            unitPrice: 2.50, category: 'FOOD'  },
  { menuItemId: 'kueh',          name: 'Assorted Kueh', variant: null,            unitPrice: 3.00, category: 'FOOD'  },
];

// ─── Helpers ────────────────────────────────────────────────────────

const rand     = arr => arr[Math.floor(Math.random() * arr.length)];
const randInt  = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

function randomPhone() {
  const prefixes = ['016', '012', '011', '017', '019', '018', '014'];
  const p = rand(prefixes);
  let rest = '';
  for (let i = 0; i < 7; i++) rest += String(randInt(0, 9));
  return p + rest;
}

/**
 * Build an ISO timestamp at a random moment between 09:00 and 14:00 MYT
 * on the given local-date Sunday. Returns the equivalent UTC ISO string.
 * MYT = UTC+8 → subtract 8h when constructing the UTC date.
 */
function randomMytDuringService(sundayLocalDate, addMinutes = 0) {
  const hour   = randInt(9, 13);             // 9..13 → service window 9 AM – 2 PM
  const minute = randInt(0, 59);
  const utc = new Date(Date.UTC(
    sundayLocalDate.getFullYear(),
    sundayLocalDate.getMonth(),
    sundayLocalDate.getDate(),
    hour - 8,                                // shift MYT → UTC
    minute + addMinutes,
    0, 0,
  ));
  return utc.toISOString();
}

function pickItems() {
  const count = randInt(1, 3);
  const items = [];
  const seen = new Set();
  while (items.length < count) {
    const m = rand(MENU);
    if (seen.has(m.menuItemId)) continue;
    seen.add(m.menuItemId);
    items.push({
      menuItemId: m.menuItemId,
      name:       m.name,
      variant:    m.variant,
      quantity:   randInt(1, 2),
      unitPrice:  m.unitPrice,
      category:   m.category,
    });
  }
  return items;
}

function sumItems(items) {
  return items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
}

// ─── Order builders ─────────────────────────────────────────────────

function buildArchivedOrder(sunday, opts = {}) {
  const orderId   = uuid();
  const items     = opts.items || pickItems();
  const gross     = sumItems(items);
  const discount  = opts.discountOffset || 0;
  const totalAmount = +(gross - discount).toFixed(2);
  const createdAt = randomMytDuringService(sunday);
  const updatedAt = randomMytDuringService(sunday, randInt(3, 12));

  const item = {
    PK: `ORDER#${orderId}`, SK: 'META',
    orderId,
    customerName: rand(NAMES),
    customerId:   randomPhone(),
    items,
    totalAmount,
    discountOffset: discount,
    discountType:   opts.discountType || 'NONE',
    status:         'ARCHIVED',
    isWalkUp:       false,
    flaggedItems:   [],
    notes:          '',
    createdAt,
    updatedAt,
    approvedBy:     'Sarah',
    seedBatch:      'reports-test',
  };
  if (opts.voucherId) {
    item.voucherId         = opts.voucherId;
    item.voucherType       = opts.voucherType || 'FREE_DRINK';
    item.voucherCampaignId = opts.voucherCampaignId || uuid();
    item.voucherPhone      = item.customerId;
  }
  return item;
}

function buildRefundOrder(sunday) {
  const base = buildArchivedOrder(sunday);
  const cancelledAt = randomMytDuringService(sunday, randInt(15, 40));
  return {
    ...base,
    status: 'CANCELLED',
    postCompletionCancel: true,
    cancelReason: rand(['Wrong order made', 'Customer no-show', 'Made by mistake']),
    cancelledBy: 'Admin',
    cancelledAt,
    updatedAt: cancelledAt,
  };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log(`Seeding sample orders into ${TABLE} (region ${REGION})…\n`);

  const perSunday = {};
  let total = 0;
  let voucherBudget = 3;     // total voucher orders across the run
  let refundBudget  = 3;     // total refund orders across the run
  // Distribute these across Sundays roughly evenly.
  const voucherSundays = pickRandomIndices(SUNDAYS.length, voucherBudget);
  const refundSundays  = pickRandomIndices(SUNDAYS.length, refundBudget);

  for (let s = 0; s < SUNDAYS.length; s++) {
    const sunday = SUNDAYS[s];
    const dateStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
    perSunday[dateStr] = 0;

    const want = randInt(10, 15);
    const wantVouchers = voucherSundays.filter(i => i === s).length;
    const wantRefunds  = refundSundays.filter(i => i === s).length;

    for (let i = 0; i < want; i++) {
      // Decide what kind of order this is.
      let order;
      if (i < wantVouchers) {
        // Voucher redemption — fully free.
        const items = pickItems();
        const gross = sumItems(items);
        const types = ['FREE_DRINK', 'FREE_FOOD', 'FREE_COMBO'];
        order = buildArchivedOrder(sunday, {
          items,
          discountOffset: gross,
          discountType: 'VOUCHER',
          voucherId: uuid(),
          voucherType: rand(types),
        });
      } else if (i < wantVouchers + wantRefunds) {
        order = buildRefundOrder(sunday);
      } else {
        // Sometimes apply a NEWCOMER (free) or STAFF (RM5/drink) discount.
        const roll = Math.random();
        if (roll < 0.10) {
          const items = pickItems();
          const gross = sumItems(items);
          order = buildArchivedOrder(sunday, {
            items,
            discountOffset: gross, // free
            discountType: 'NEWCOMER',
          });
        } else if (roll < 0.18) {
          const items = pickItems();
          const gross = sumItems(items);
          // STAFF: drinks at RM5.
          let discounted = 0;
          for (const it of items) {
            discounted += (it.category === 'DRINK' ? 5 : it.unitPrice) * it.quantity;
          }
          order = buildArchivedOrder(sunday, {
            items,
            discountOffset: +(gross - discounted).toFixed(2),
            discountType: 'STAFF',
          });
        } else {
          order = buildArchivedOrder(sunday);
        }
      }

      try {
        await doc.send(new PutCommand({ TableName: TABLE, Item: order }));
        perSunday[dateStr] += 1;
        total += 1;
        process.stdout.write(`  · ${dateStr}  ${order.status.padEnd(9)}  ${order.orderId.slice(0, 8)}  ${order.customerName.padEnd(8)}  RM ${order.totalAmount.toFixed(2)}${order.discountType !== 'NONE' ? '  ['+order.discountType+']' : ''}${order.postCompletionCancel ? '  ⮕ refund' : ''}\n`);
      } catch (err) {
        console.error(`  ✗ failed: ${err.message}`);
      }
    }
  }

  console.log('\n──── Seed Summary ────────────────────────────');
  for (const [d, n] of Object.entries(perSunday)) {
    console.log(`  ${d}: ${n} orders`);
  }
  console.log(`  Total: ${total} orders`);
  console.log('──────────────────────────────────────────────');
}

/** Pick `count` random indices in [0..n), with replacement. */
function pickRandomIndices(n, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(randInt(0, n - 1));
  return out;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
