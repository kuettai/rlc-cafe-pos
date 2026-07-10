/*
 * Reconstruct missing 2026-07-05 orders from the bank statement.
 *
 * Scans rlc-cafe-orders (ap-southeast-5) for the day, matches each
 * existing PAID order (ARCHIVED / READY / PREPARING, non pre-order)
 * against the 56 bank movements (same amount, within 5 min), then
 * inserts an ARCHIVED walk-up order for every bank line that has no
 * match. Bank times are MYT; createdAt is stored in UTC (MYT - 8h).
 *
 * Reconstructed rows are tagged with `reconstructed: true` and never
 * carry expiresAt (safe from TTL). Item names / prices are best-guess
 * per the composition rules in the spec — totalAmount is authoritative.
 *
 *   node scripts/reconcile-insert-jul5.mjs             # dry run
 *   node scripts/reconcile-insert-jul5.mjs --confirm   # write to DDB
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const REGION       = 'ap-southeast-5';
const ORDERS_TABLE = 'rlc-cafe-orders';
const MENU_TABLE   = 'rlc-cafe-menu';
const TARGET_DATE  = '2026-07-05';       // UTC day
const MATCH_WINDOW = 5 * 60 * 1000;      // 5 minutes, in ms
const CONFIRM      = process.argv.slice(2).includes('--confirm');

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

/*
 * ─── Bank statement ──────────────────────────────────────────────
 * 56 transactions, MYT, RM 360.80 total.
 */
const BANK = [
  ['9:06AM',  6.00], ['9:07AM',  5.00], ['9:12AM',  5.00], ['9:24AM', 15.00],
  ['9:26AM', 10.00], ['9:37AM',  5.00], ['9:37AM',  5.00], ['9:53AM',  5.50],
  ['9:58AM',  5.00], ['10:44AM',13.10], ['10:52AM', 5.00], ['10:52AM',10.00],
  ['10:52AM', 9.00], ['10:55AM', 5.00], ['10:58AM', 9.00], ['10:58AM', 5.20],
  ['10:59AM', 5.00], ['10:59AM', 3.00], ['11:00AM', 5.00], ['11:00AM', 6.00],
  ['11:01AM', 8.50], ['11:03AM',21.20], ['11:05AM', 5.00], ['11:07AM', 5.00],
  ['11:07AM', 2.50], ['11:09AM', 5.00], ['11:12AM', 2.50], ['11:13AM', 5.00],
  ['11:15AM',10.00], ['11:20AM', 5.10], ['11:29AM', 9.00], ['11:33AM', 5.00],
  ['11:36AM', 3.00], ['11:37AM', 5.00], ['11:40AM',13.00], ['11:58AM', 2.80],
  ['12:01PM', 0.40], ['12:06PM', 5.00], ['12:08PM', 5.00], ['12:38PM',10.00],
  ['12:39PM', 7.00], ['12:39PM', 5.00], ['12:54PM', 5.00], ['1:00PM',  5.00],
  ['1:00PM',  5.00], ['1:01PM',  5.00], ['1:01PM',  5.00], ['1:07PM',  8.00],
  ['1:08PM',  5.00], ['1:12PM',  5.00], ['1:12PM',  5.00], ['1:17PM', 10.00],
  ['1:18PM',  5.00], ['1:21PM',  8.00], ['1:27PM',  5.00], ['1:30PM',  8.00],
];

if (BANK.length !== 56) throw new Error(`Expected 56 bank tx, got ${BANK.length}`);
{
  const total = BANK.reduce((s, [, a]) => s + a, 0);
  if (Math.abs(total - 360.80) > 0.005) throw new Error(`Bank total mismatch: ${total.toFixed(2)}`);
}

// ─── Utility ────────────────────────────────────────────────────
function stripEmoji(s) {
  return String(s || '').replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u, '').trim();
}
function money(n) { return `RM ${Number(n || 0).toFixed(2)}`; }
function padR(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s.slice(-n) : ' '.repeat(n - s.length) + s; }
function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Convert an MYT clock string (e.g. "9:06AM", "12:38PM") to a UTC Date
 * on TARGET_DATE (subtracting 8 h). If the resulting UTC hour crosses
 * midnight backwards, roll the day back one.
 */
function mytToUtc(mytStr) {
  const m = mytStr.match(/^(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (!m) throw new Error(`Bad MYT time: ${mytStr}`);
  let h = +m[1];
  const min = +m[2];
  const meridiem = m[3].toUpperCase();
  if (meridiem === 'AM' && h === 12) h = 0;
  if (meridiem === 'PM' && h !== 12) h += 12;

  let utcH = h - 8;
  let dayOffset = 0;
  if (utcH < 0) { utcH += 24; dayOffset = -1; }

  const d = new Date(`${TARGET_DATE}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(utcH, min, 0, 0);
  return d;
}

// ─── Menu lookup ────────────────────────────────────────────────
const menuByName = new Map();   // lower-cased canonical name → menu row

async function loadMenu() {
  let key;
  do {
    const r = await doc.send(new ScanCommand({ TableName: MENU_TABLE, ExclusiveStartKey: key }));
    for (const m of r.Items || []) {
      if (m.SK !== 'META') continue;
      const n = stripEmoji(m.name).toLowerCase();
      if (n) menuByName.set(n, m);
    }
    key = r.LastEvaluatedKey;
  } while (key);
}

/**
 * Resolve an item to (menuRow, variantLabel). Tries each name candidate;
 * the first one that exists in the menu wins. If a variantCandidate
 * matches an option in that menu's variantGroups / variants, that
 * label is used; otherwise variant is left blank (item may already
 * carry the variant in its name, e.g. "Matcha (Iced)").
 */
function resolveItem(nameCandidates, variantCandidates = []) {
  for (const raw of nameCandidates) {
    const m = menuByName.get(String(raw).toLowerCase());
    if (!m) continue;
    if (!variantCandidates.length) return { menu: m, variant: '' };

    for (const v of variantCandidates) {
      const inGroups = (m.variantGroups || []).some(g =>
        (g.options || []).some(o => o.name === v)
      );
      const inLegacy = (m.variants || []).some(x => x.name === v || x.id === v);
      if (inGroups || inLegacy) return { menu: m, variant: v };
    }
    // Menu row exists but no variant match — accept with blank variant.
    return { menu: m, variant: '' };
  }
  throw new Error(`Menu lookup failed. Candidates: ${nameCandidates.join(' | ')}  variants=${variantCandidates.join('|') || '(none)'}`);
}

/** basePrice + variant modifier (matches the backend's celebration math). */
function grossOf(menu, variantLabel) {
  let unit = Number(menu.basePrice || 0);
  if (variantLabel) {
    let added = false;
    for (const g of (menu.variantGroups || [])) {
      const opt = (g.options || []).find(o => o.name === variantLabel);
      if (opt) { unit += Number(opt.price || 0); added = true; break; }
    }
    if (!added) {
      const legacy = (menu.variants || []).find(v => v.name === variantLabel || v.id === variantLabel);
      if (legacy) unit += Number(legacy.priceModifier || 0);
    }
  }
  return round2(unit);
}

/** Build an order item object suitable for orders.items[]. */
function itemOf({ menu, variant }, qty, unitPrice) {
  return {
    menuItemId: menu.menuItemId,
    name:       menu.name,           // canonical display name (may contain emoji)
    variant:    variant || '',
    quantity:   qty,
    unitPrice:  round2(unitPrice),
    category:   menu.category,
  };
}

// ─── Composition ────────────────────────────────────────────────
/*
 * Celebration drink pool. Iced / Hot lattes and long blacks are the
 * usual celebration participants; Soda would give a zero offset
 * (already RM 5) so it's excluded to keep the audit trail clean.
 */
const CELEBRATION_POOL = [
  { nameCandidates: ['long black'], variantCandidates: ['Hot'] },
  { nameCandidates: ['latte'],      variantCandidates: ['Hot'] },
  { nameCandidates: ['long black'], variantCandidates: ['Iced'] },
  { nameCandidates: ['latte'],      variantCandidates: ['Iced'] },
];

/** Deterministic celebration pick for a given rotation index. */
function celebrationPick(rotationIdx) {
  const spec = CELEBRATION_POOL[rotationIdx % CELEBRATION_POOL.length];
  return resolveItem(spec.nameCandidates, spec.variantCandidates);
}

function celebrationBundle(n, rotationIdx) {
  const items = [];
  let grossSum = 0;
  for (let k = 0; k < n; k++) {
    const r = celebrationPick(rotationIdx + k);
    grossSum += grossOf(r.menu, r.variant);
    items.push(itemOf(r, 1, 5));   // customer-paid price
  }
  const offset = round2(grossSum - 5 * n);
  return { items, offset };
}

/** Non-drink helpers with fallback name candidates for schema tolerance. */
const NAMES = {
  kueh:       ['assorted kueh', 'kueh'],
  curryPuff:  ['curry puff'],
  fishBall:   ['fish ball sticks', 'fishball sticks'],
  water:      ['mineral water'],
  matchaIced: [['matcha latte',   ['Iced']], ['matcha',   ['Iced']], ['matcha (iced)', []], ['matcha (ice)', []]],
  hotChocIced:[['hot chocolate',  ['Iced']], ['chocolate',['Iced']], ['chocolate (iced)', []], ['hot choc marshmallow', []]],
  mocha:      [['mocha',          ['Hot']],  ['mocha (hot)', []]],
  latteHot:   [['latte',          ['Hot']],  ['latte (hot)', []]],
  latteIced:  [['latte',          ['Iced']], ['latte (iced)', []]],
  longBlackHot:  [['long black',  ['Hot']],  ['long black (hot)', []]],
};

/** Resolve one of the multi-candidate entries in NAMES. */
function resolveMulti(entries) {
  for (const [name, variants] of entries) {
    try { return resolveItem([name], variants); } catch { /* try next */ }
  }
  throw new Error('Multi-lookup failed: ' + JSON.stringify(entries));
}

/**
 * For a given bank amount + rotation index, produce
 * { items, discountType, discountOffset }. `items[i].unitPrice * qty`
 * sums to `amount` for every branch (verified below).
 */
function composeForAmount(amount, rotationIdx) {
  const cents = Math.round(amount * 100);

  let items = [];
  let discountType = 'NONE';
  let discountOffset = 0;

  switch (cents) {
    case 40:     // Mineral Water partial (bank shows RM 0.40)
      items = [itemOf(resolveItem(NAMES.water), 1, 0.40)];
      break;

    case 250:    // Curry Puff
      items = [itemOf(resolveItem(NAMES.curryPuff), 1, 2.50)];
      break;

    case 280:    // Fish Ball Sticks
      items = [itemOf(resolveItem(NAMES.fishBall), 1, 2.80)];
      break;

    case 300:    // Assorted Kueh
      items = [itemOf(resolveItem(NAMES.kueh), 1, 3.00)];
      break;

    case 500: {  // Celebration drink @ RM 5
      const b = celebrationBundle(1, rotationIdx);
      items = b.items; discountType = 'CELEBRATION'; discountOffset = b.offset;
      break;
    }

    case 510: {  // Celebration drink + partial mineral water (0.10)
      const b = celebrationBundle(1, rotationIdx);
      items = [...b.items, itemOf(resolveItem(NAMES.water), 1, 0.10)];
      discountType = 'CELEBRATION'; discountOffset = b.offset;
      break;
    }

    case 520:    // ~2× Fish Ball Sticks (adjusted unit price to hit total)
      items = [itemOf(resolveItem(NAMES.fishBall), 2, 2.60)];
      break;

    case 550:    // Kueh + Curry Puff
      items = [
        itemOf(resolveItem(NAMES.kueh), 1, 3.00),
        itemOf(resolveItem(NAMES.curryPuff), 1, 2.50),
      ];
      break;

    case 600:    // Long Black (Hot) non-celebration
      items = [itemOf(resolveMulti(NAMES.longBlackHot), 1, 6.00)];
      break;

    case 700:    // Latte (Hot) non-celebration
      items = [itemOf(resolveMulti(NAMES.latteHot), 1, 7.00)];
      break;

    case 800:    // Latte (Iced) non-celebration
      items = [itemOf(resolveMulti(NAMES.latteIced), 1, 8.00)];
      break;

    case 850:    // Long Black (Hot) + Curry Puff
      items = [
        itemOf(resolveMulti(NAMES.longBlackHot), 1, 6.00),
        itemOf(resolveItem(NAMES.curryPuff),    1, 2.50),
      ];
      break;

    case 900: {  // Matcha Latte (Iced) or Hot Chocolate (Iced)
      const pick = rotationIdx % 2 === 0
        ? resolveMulti(NAMES.matchaIced)
        : resolveMulti(NAMES.hotChocIced);
      items = [itemOf(pick, 1, 9.00)];
      break;
    }

    case 1000: {  // 2× celebration OR 1× Mocha (rotate)
      if (rotationIdx % 2 === 0) {
        const b = celebrationBundle(2, rotationIdx);
        items = b.items; discountType = 'CELEBRATION'; discountOffset = b.offset;
      } else {
        items = [itemOf(resolveMulti(NAMES.mocha), 1, 10.00)];
      }
      break;
    }

    case 1300: {  // 2× celebration + Kueh
      const b = celebrationBundle(2, rotationIdx);
      items = [...b.items, itemOf(resolveItem(NAMES.kueh), 1, 3.00)];
      discountType = 'CELEBRATION'; discountOffset = b.offset;
      break;
    }

    case 1310: {  // 2× celebration + Kueh + partial water (0.10)
      const b = celebrationBundle(2, rotationIdx);
      items = [
        ...b.items,
        itemOf(resolveItem(NAMES.kueh),  1, 3.00),
        itemOf(resolveItem(NAMES.water), 1, 0.10),
      ];
      discountType = 'CELEBRATION'; discountOffset = b.offset;
      break;
    }

    case 1500: {  // 3× celebration
      const b = celebrationBundle(3, rotationIdx);
      items = b.items; discountType = 'CELEBRATION'; discountOffset = b.offset;
      break;
    }

    case 2120: {  // 3× celebration + Kueh + Fish Ball + Water
      const b = celebrationBundle(3, rotationIdx);
      items = [
        ...b.items,
        itemOf(resolveItem(NAMES.kueh),      1, 3.00),
        itemOf(resolveItem(NAMES.fishBall),  1, 2.80),
        itemOf(resolveItem(NAMES.water),     1, 0.40),
      ];
      discountType = 'CELEBRATION'; discountOffset = b.offset;
      break;
    }

    default:
      throw new Error(`No composition rule for amount RM ${amount}`);
  }

  // Sanity: item subtotal must equal totalAmount (offset is separately audited).
  const sum = round2(items.reduce((s, i) => s + i.unitPrice * i.quantity, 0));
  if (Math.abs(sum - amount) > 0.005) {
    throw new Error(`Composition mismatch: amount=${amount} items sum to ${sum}`);
  }
  return { items, discountType, discountOffset: round2(discountOffset) };
}

// ─── Scan existing Jul 5 orders ─────────────────────────────────
async function scanDay() {
  const items = [];
  let key;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: ORDERS_TABLE,
      FilterExpression: 'begins_with(createdAt, :d)',
      ExpressionAttributeValues: { ':d': TARGET_DATE },
      ExclusiveStartKey: key,
    }));
    if (r.Items) items.push(...r.Items);
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

// ─── Match existing paid orders against bank txs ────────────────
function matchBankToOrders(bankTxs, paidOrders) {
  const orderMatched = new Set();  // indexes into paidOrders

  for (const bt of bankTxs) {
    let best = -1, bestDelta = Infinity;
    for (let i = 0; i < paidOrders.length; i++) {
      if (orderMatched.has(i)) continue;
      const o = paidOrders[i];
      if (Math.abs(Number(o.totalAmount || 0) - bt.amount) > 0.005) continue;
      const delta = Math.abs(new Date(o.createdAt).getTime() - bt.utc.getTime());
      if (delta > MATCH_WINDOW) continue;
      if (delta < bestDelta) { best = i; bestDelta = delta; }
    }
    if (best >= 0) {
      orderMatched.add(best);
      bt.matchedOrder = paidOrders[best];
    }
  }
  return { orderMatched };
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`Region:        ${REGION}`);
  console.log(`Orders table:  ${ORDERS_TABLE}`);
  console.log(`Menu table:    ${MENU_TABLE}`);
  console.log(`Target date:   ${TARGET_DATE} (UTC)`);
  console.log(`Mode:          ${CONFIRM ? 'APPLY (writing to DynamoDB)' : 'DRY RUN (pass --confirm to apply)'}`);
  console.log('');

  await loadMenu();
  console.log(`Loaded ${menuByName.size} menu items.`);

  const rawOrders = await scanDay();
  console.log(`Scanned ${rawOrders.length} orders for ${TARGET_DATE}.`);

  // Bank rows enriched with UTC timestamps.
  const bankTxs = BANK.map(([timeStr, amount]) => ({
    time: timeStr,
    amount: round2(amount),
    utc: mytToUtc(timeStr),
    matchedOrder: null,
  }));

  const paidOrders = rawOrders.filter(o =>
    ['ARCHIVED', 'READY', 'PREPARING'].includes(o.status) &&
    o.discountType !== 'MINISTRY_PREORDER' &&
    o.isPreOrder !== true
  );

  const { orderMatched } = matchBankToOrders(bankTxs, paidOrders);
  const matchedCount    = bankTxs.filter(b => b.matchedOrder).length;
  const unmatchedBank   = bankTxs.filter(b => !b.matchedOrder);
  const unmatchedPaid   = paidOrders.filter((_, i) => !orderMatched.has(i));

  console.log('');
  console.log('─── Matching summary ───────────────────────────────');
  console.log(`Bank transactions:            ${bankTxs.length}   (${money(bankTxs.reduce((s, b) => s + b.amount, 0))})`);
  console.log(`Existing paid orders on day:  ${paidOrders.length}   (${money(paidOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0))})`);
  console.log(`Matched bank → order:         ${matchedCount}`);
  console.log(`Unmatched bank (need insert): ${unmatchedBank.length}`);
  console.log(`Unmatched existing paid:      ${unmatchedPaid.length}`);
  console.log('');

  // ── Build inserts ─────────────────────────────────────────────
  const inserts = [];
  let rotationIdx = 0;
  for (const bt of unmatchedBank) {
    const { items, discountType, discountOffset } = composeForAmount(bt.amount, rotationIdx);
    rotationIdx++;
    const id = randomUUID();
    const createdAt = bt.utc.toISOString();
    const updatedAt = new Date(bt.utc.getTime() + 2 * 60_000).toISOString();
    inserts.push({
      PK: `ORDER#${id}`,
      SK: 'META',
      orderId: id,
      status: 'ARCHIVED',
      customerName: 'Walk-in',
      items,
      totalAmount: bt.amount,
      discountType,
      discountOffset,
      createdAt,
      updatedAt,
      notes: '',
      flaggedItems: [],
      isWalkUp: true,
      reconstructed: true,
      reconstructionNote: 'Reconstructed from bank statement 2026-07-05',
      _bankTime: bt.time,   // internal only — stripped before write
    });
  }

  const insertTotal = round2(inserts.reduce((s, o) => s + o.totalAmount, 0));

  // ── Detail table ──────────────────────────────────────────────
  console.log('─── Planned inserts ────────────────────────────────');
  console.log(`Count:   ${inserts.length}`);
  console.log(`Total:   ${money(insertTotal)}`);
  console.log('');
  console.log('  ' + padR('bank time', 10) + padL('amount', 9) + '  ' +
              padR('createdAt (UTC)', 26) + padR('discount', 13) + padL('offset', 7) + '  items');
  console.log('  ' + '-'.repeat(140));
  for (const o of inserts) {
    const its = o.items.map(i => {
      const nm = stripEmoji(i.name) + (i.variant ? `(${i.variant})` : '');
      return `${i.quantity}×${nm}@${i.unitPrice}`;
    }).join(', ');
    console.log('  ' +
      padR(o._bankTime, 10) +
      padL(money(o.totalAmount), 9) + '  ' +
      padR(o.createdAt, 26) +
      padR(o.discountType, 13) +
      padL(o.discountOffset.toFixed(2), 7) + '  ' + its);
  }

  if (unmatchedPaid.length) {
    console.log('');
    console.log('─── Unmatched existing paid orders (FYI) ──────────');
    for (const o of unmatchedPaid) {
      const its = (o.items || []).map(i => `${i.quantity || 1}×${stripEmoji(i.name)}`).join(', ');
      console.log(`  ${(o.orderId || '').slice(0,8)}  ${(o.createdAt || '').slice(11,19)}Z  ` +
                  `${money(o.totalAmount)}  ${o.status}  ${o.discountType || 'NONE'}  ${its}`);
    }
  }

  console.log('');
  console.log('─── Post-insert projection ─────────────────────────');
  const projectedCount = paidOrders.length + inserts.length;
  const projectedTotal = round2(
    paidOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0) + insertTotal
  );
  console.log(`Projected paid orders:   ${projectedCount}   (bank: ${bankTxs.length})`);
  console.log(`Projected paid total:    ${money(projectedTotal)}   (bank: ${money(360.80)})`);
  console.log(`Delta count:             ${projectedCount - bankTxs.length}`);
  console.log(`Delta total:             RM ${(projectedTotal - 360.80).toFixed(2)}`);

  if (!CONFIRM) {
    console.log('');
    console.log('DRY RUN — no writes performed. Re-run with --confirm to apply.');
    return;
  }

  console.log('');
  console.log('─── Writing to DynamoDB ────────────────────────────');
  let written = 0;
  for (const o of inserts) {
    // Drop internal-only fields before writing.
    const { _bankTime, ...toWrite } = o;
    try {
      await doc.send(new PutCommand({
        TableName: ORDERS_TABLE,
        Item: toWrite,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      written++;
      if (written % 10 === 0 || written === inserts.length) {
        console.log(`  wrote ${written}/${inserts.length}...`);
      }
    } catch (e) {
      console.error(`  ✗ failed ${o.orderId.slice(0,8)}: ${e.message}`);
    }
  }
  console.log('');
  console.log(`✓ Wrote ${written} of ${inserts.length} orders.`);
}

main().catch(err => { console.error(err); process.exit(1); });
