import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuid } from 'uuid';
import { docClient, ORDERS_TABLE, MENU_TABLE, SETTINGS_TABLE, GetCommand, PutCommand, UpdateCommand, ScanCommand } from '../lib/db';
import { linkOrderToCustomer } from './customers';
import { normalizePhone } from '../lib/phone';
import { validatePreorderCode, getPreorderCode, optionKey } from './preorder';
import { validateStaffCode } from './staffcode';
import { logOrder, summarizeItems } from '../lib/audit';
import {
  priceLine,
  summarizeOrderDiscount,
  resolveQuantity,
  toOrderItem,
  PricedLine,
  CustomerClass,
} from '../lib/pricing';

const res = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode, headers: {}, body: JSON.stringify(body),
});

async function getSettings() {
  const r = await docClient.send(new GetCommand({ TableName: SETTINGS_TABLE, Key: { PK: 'SETTINGS', SK: 'CONFIG' } }));
  return r.Item;
}

async function getMenuItem(menuItemId: string) {
  const r = await docClient.send(new GetCommand({ TableName: MENU_TABLE, Key: { PK: `MENU#${menuItemId}`, SK: 'META' } }));
  return r.Item;
}

async function releaseFood(items: { menuItemId: string; quantity: number; category?: string }[]) {
  for (const item of items) {
    if (item.category === 'FOOD') {
      await docClient.send(new UpdateCommand({
        TableName: MENU_TABLE,
        Key: { PK: `MENU#${item.menuItemId}`, SK: 'META' },
        UpdateExpression: 'SET foodReserved = foodReserved - :q',
        ExpressionAttributeValues: { ':q': item.quantity },
      }));
    }
  }
}

// ─── Pre-order notes prefix ──────────────────────────────────────────
//
// A pre-order's collection time is stored ONLY inside the `notes` string, as a
// `[PRE-ORDER: <CODE>] Collect: <time>` prefix. There is no `collectionTime`
// attribute on the order record. That prefix is how the cashier knows when the
// ministry is coming to collect, so losing it is unrecoverable data loss — the
// café has to go and ask the customer again.
//
// `modifyOrder` used to write `notes` verbatim from the request body, which made
// preserving the prefix the CLIENT's job. Any client that failed to re-attach it
// — a stale cached PWA shell, a replayed request, a future page — silently
// deleted the collection time. T4 funnels far more customers into the edit form,
// so the backend now owns it: see the composition in `modifyOrder`.
//
// One format string, used by both the create and the edit path. A second copy
// would drift, and the two would stop round-tripping.

const PREORDER_NOTES_SEPARATOR = ' | ';

/** Matches the opening of a `[PRE-ORDER: …] Collect:` prefix. */
const PREORDER_NOTES_MARKER = /^\[PRE-ORDER:[^\]]*\]\s*Collect:/;

/** The prefix itself — the ONLY place this format is written. */
export function preorderNotesPrefix(code: unknown, collectionTime: unknown): string {
  return `[PRE-ORDER: ${String(code ?? '')}] Collect: ${String(collectionTime ?? '')}`;
}

/** Join a prefix with the customer's own note, omitting the separator if empty. */
export function composePreorderNotes(prefix: string, customerNotes: string): string {
  return customerNotes ? `${prefix}${PREORDER_NOTES_SEPARATOR}${customerNotes}` : prefix;
}

/**
 * Split stored (or client-supplied) notes into the operational prefix and the
 * customer's own text.
 *
 * `prefix` is null when there is no `[PRE-ORDER: …] Collect:` marker — which is
 * the case for a pre-order placed with no collection time, and for pre-orders
 * predating the convention. Callers must NOT invent a prefix for those.
 *
 * The split is on the FIRST separator, so a customer note that itself contains
 * " | " survives intact in `rest`. That ambiguity is inherent to storing two
 * fields in one string and predates this helper; it is not made worse here.
 */
export function splitPreorderNotes(notes: unknown): { prefix: string | null; rest: string } {
  const s = typeof notes === 'string' ? notes : '';
  if (!PREORDER_NOTES_MARKER.test(s)) return { prefix: null, rest: s };

  const sep = s.indexOf(PREORDER_NOTES_SEPARATOR);
  if (sep === -1) return { prefix: s.trim(), rest: '' };
  return { prefix: s.slice(0, sep).trim(), rest: s.slice(sep + PREORDER_NOTES_SEPARATOR.length) };
}

/**
 * The three ministry pre-order restrictions, in ONE place.
 *
 * `createOrder` enforced these and `modifyOrder` did not, so the edit path was a
 * straight bypass of all three: a customer could place a compliant pre-order and
 * then edit it into food, an ineligible drink, or an excluded (paid) option.
 * Since pre-orders zero out the whole gross, that was uncapped cost to the café.
 * Both paths call this now — do not copy the rules to a third site.
 *
 * Call only for an order that IS a pre-order. `preorderRecord` may be null (the
 * link was hard-deleted after the order was placed); the drinks-only rule still
 * applies in that case, which is the fail-closed choice on the rule that matters
 * most for the food counters.
 *
 * Returns the customer-facing error message, or null when the item is allowed.
 * Messages are byte-identical to the create-path originals.
 */
export function preorderItemRejection(
  preorderRecord: { eligibleItems?: unknown; excludedOptions?: unknown } | null | undefined,
  menu: { name?: string; category?: string },
  item: { menuItemId?: string; variant?: string; selectedVariants?: { group?: string; option: string }[] },
): string | null {
  // 1. Drinks only — the workflow does not reserve FOOD stock ahead of Sunday,
  //    and a pre-order carrying FOOD would move the food counters on a record
  //    that is never collected through the normal counter flow.
  if (menu.category !== 'DRINK') {
    return `Pre-orders can only include drinks (${menu.name} is ${menu.category})`;
  }

  if (!preorderRecord) return null;

  // 2. eligibleItems allowlist. Empty/absent = ALL active drinks, not none.
  if (Array.isArray(preorderRecord.eligibleItems) && preorderRecord.eligibleItems.length > 0) {
    if (!preorderRecord.eligibleItems.includes(item.menuItemId)) {
      return `${menu.name} is not available on this pre-order link`;
    }
  }

  // 3. Variant-level exclusions, e.g. no Oat Milk on a ministry link. The
  //    customer page already hides these, but that is only a courtesy — a reused
  //    link with a crafted payload has to be refused here, exactly as an
  //    ineligible menu item is above.
  if (Array.isArray(preorderRecord.excludedOptions) && preorderRecord.excludedOptions.length > 0) {
    const blocked = new Set<string>(preorderRecord.excludedOptions.map((x: unknown) => String(x)));
    for (const sv of (Array.isArray(item.selectedVariants) ? item.selectedVariants : [])) {
      const key = optionKey(sv?.group, sv?.option);
      if (blocked.has(key)) {
        return `${sv.option} is not available on this pre-order link`;
      }
    }
    // Legacy single-variant payloads carry only a name, with no group. Match
    // those against the option half of each exclusion so an older client
    // cannot slip past the check.
    if (item.variant) {
      const legacy = String(item.variant).trim();
      for (const b of blocked) {
        if (b.slice(b.indexOf(':') + 1) === legacy) {
          return `${legacy} is not available on this pre-order link`;
        }
      }
    }
  }

  return null;
}

async function createOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { customerName, items, notes, customerId, preorderCode, staffCode, collectionTime } = body;
  if (!customerName || !items?.length) return res(400, { error: 'customerName and items required' });

  // The two link types contradict each other on price, status, café-open and
  // food, so a request carrying both is refused rather than silently ranked.
  if (preorderCode && staffCode) {
    return res(400, { error: 'A staff code cannot be combined with a pre-order code' });
  }

  // If a customerId (phone) is supplied, normalize it so the order's
  // GSI key matches the customer record's PK exactly. An invalid value
  // is dropped silently — anonymous orders are always allowed.
  const normalizedCustomerId = customerId ? normalizePhone(customerId) : null;

  const settings = await getSettings();

  // ─── Link-type branch ────────────────────────────────────────────
  // Ministry pre-orders (link with a code) bypass the café-open check
  // and are always free. Drinks only — the workflow does not reserve
  // FOOD stock ahead of Sunday.
  //
  // A STAFF link is not a pre-order: it is a live order at the staff price, so
  // it keeps every rule a walk-in customer order has (café must be OPEN, food
  // allowed, status PENDING) and only the pricing class differs. The café-open
  // check therefore sits in the non-pre-order branch, which both regular and
  // staff orders take.
  let preorderRecord: any = null;
  let staffCodeRecord: any = null;
  if (preorderCode) {
    const v = await validatePreorderCode(String(preorderCode));
    if (!v.valid) return res(400, { error: `Pre-order code ${v.reason}` });
    preorderRecord = v.code;
  } else {
    if (!settings || settings.cafeStatus !== 'OPEN') return res(403, { error: 'Cafe is not open' });
    if (staffCode) {
      const v = await validateStaffCode(String(staffCode));
      if (!v.valid) return res(400, { error: `Staff code ${v.reason}` });
      staffCodeRecord = v.code;
    }
  }

  // The ONLY customer-selectable class. A staff-code order is priced at the
  // staff rate up front so the customer sees what they will pay, but it is a
  // REQUEST: approveOrder reverts it unless the cashier confirms.
  const requestedClass: CustomerClass | null = staffCodeRecord ? 'STAFF' : null;

  // Class the ORDER-LEVEL totals are computed with. A ministry pre-order is
  // free, and PREORDER is how that is expressed through pricing.ts rather than
  // hardcoded here (see the `preorderRecord` branch of `orderItem` below for
  // why the stored item `unitPrice` stays FULL). PREORDER can only come from
  // this derivation — `parseCustomerClass` refuses it from a request body.
  const pricingClass: CustomerClass | null = preorderRecord ? 'PREORDER' : requestedClass;

  const orderItems: any[] = [];
  const pricedLines: PricedLine[] = [];

  for (const item of items) {
    const menu = await getMenuItem(item.menuItemId);
    if (!menu) return res(400, { error: `Item ${item.menuItemId} not found` });
    if (!menu.isActive) return res(400, { error: `${menu.name} is not available` });
    if (!menu.isEnabledToday) return res(400, { error: `${menu.name} is not available today` });

    // Drinks-only + eligibleItems + excludedOptions, shared with modifyOrder.
    if (preorderRecord) {
      const rejection = preorderItemRejection(preorderRecord, menu, item);
      if (rejection) return res(400, { error: rejection });
    }

    const quantity = resolveQuantity(item);

    if (menu.category === 'FOOD') {
      const available = (menu.foodQuantityToday || 0) - (menu.foodReserved || 0);
      if (available < quantity) return res(400, { error: `Insufficient stock for ${menu.name}` });
    }

    // Celebration is the only rule in play for an ordinary customer order; a
    // cashier-selected STAFF/PASTOR/NEWCOMER is applied later in approveOrder.
    // A staff link is the one case where the customer's own request feeds the
    // class, and it still has to be confirmed on approve.
    const line = priceLine(menu, item, settings, pricingClass);
    pricedLines.push(line);
    if (preorderRecord) {
      // Pre-order ITEMS keep the FULL unit price; the free-ness lives at ORDER
      // level (totalAmount 0, discountOffset = the whole gross). That is the
      // shape every pre-order record in production already has, so nothing
      // needs backfilling. `line` (PREORDER-priced, RM0) still feeds
      // `pricedLines` so the order totals come out of pricing.ts.
      //
      // Two `priceLine` calls, no new arithmetic — the same pattern the
      // staff-link path uses for `baseUnitPrice`.
      const fullLine = priceLine(menu, item, settings, null);
      orderItems.push(toOrderItem(fullLine));
    } else if (requestedClass) {
      // What this line would cost with NO class — celebration-or-full. Stored
      // so declining the staff price falls back to the correct number instead
      // of throwing away a legitimate celebration discount. Same `priceLine`,
      // no new arithmetic.
      const baseLine = priceLine(menu, item, settings, null);
      orderItems.push(toOrderItem(line, { baseUnitPrice: baseLine.unitPrice }));
    } else {
      orderItems.push(toOrderItem(line));
    }
  }

  const pricing = summarizeOrderDiscount(pricedLines, pricingClass);
  // NET, per the storage convention — RM0 for a pre-order. This is also what
  // `linkOrderToCustomer` is given below: it used to receive a pre-order's full
  // GROSS (the summary was computed with a null class) while the order itself
  // stored 0, inflating the customer's lifetime spend by the whole pre-order.
  const totalAmount = pricing.totalAmount;

  // Reserve food (pre-orders are drinks-only so this loop is a no-op there)
  for (const oi of orderItems) {
    if (oi.category === 'FOOD') {
      await docClient.send(new UpdateCommand({
        TableName: MENU_TABLE,
        Key: { PK: `MENU#${oi.menuItemId}`, SK: 'META' },
        UpdateExpression: 'SET foodReserved = foodReserved + :q',
        ExpressionAttributeValues: { ':q': oi.quantity },
      }));
    }
  }

  const orderId = uuid();
  const now = new Date().toISOString();

  // Compose notes (prepend collection time for pre-orders so the cashier
  // sees it at a glance in the queue). Shared helpers, so `modifyOrder` rebuilds
  // exactly this shape on an edit — see the block comment above
  // `preorderNotesPrefix`.
  const trimmedNotes = typeof notes === 'string' ? notes : '';
  const composedNotes = preorderRecord && collectionTime
    ? composePreorderNotes(preorderNotesPrefix(preorderRecord.code, collectionTime), trimmedNotes)
    : trimmedNotes;

  const orderItem: any = preorderRecord
    ? {
        // ── Pre-order: PENDING, always free, expires at serviceEndTime (ISO).
        //
        // PENDING (not PREPARING, which is what this was until v1.71) is the
        // whole point: PENDING is the only status `modifyOrder` will edit, so
        // creating pre-orders here reuses the existing customer Edit Order
        // feature and its `ConditionExpression: '#s = :pending'` gate for free.
        // The cashier's normal PENDING → PREPARING approve becomes the lock.
        //
        // ⚠ `expiresAt` is `serviceEndTime`, an **ISO STRING**, and must stay
        // one. DynamoDB TTL only acts on NUMERIC attributes, so this value is
        // inert as a TTL and survives from (say) Wednesday to Sunday; it is
        // compared string-wise by `expirePreOrders()` in expiry.ts, which is the
        // only thing that ever expires a pre-order. Normalising it to unix
        // seconds would arm a live TTL on a legitimately long-lived order and
        // DynamoDB would silently delete it — no error, no log.
        //
        // Storage convention (matches approveOrder / createWalkUp): `totalAmount`
        // is stored as NET (what's actually collected — RM 0 here) and
        // `discountOffset` records the discount applied (the full item price
        // sum). This keeps aggregation formulas across the codebase valid
        // without special-casing pre-orders.
        PK: `ORDER#${orderId}`, SK: 'META', orderId, customerName,
        items: orderItems,
        totalAmount: 0,                          // == pricing.totalAmount (PREORDER)
        status: 'PENDING',
        notes: composedNotes,
        // Literal, not `pricing.discountType`: identical today, and pinning it
        // makes the reported label independent of the pricing class name.
        discountType: 'MINISTRY_PREORDER',
        discountOffset: pricing.discountOffset,  // full gross → net 0
        grossAmount: pricing.grossAmount,        // kept for auditability / reports
        // Who the order was for. `modifyOrder` reads this back rather than
        // re-deriving the class.
        customerClass: 'PREORDER',
        createdAt: now, updatedAt: now,
        expiresAt: preorderRecord.serviceEndTime,
        isPreOrder: true,
        preorderCode: preorderRecord.code,
        isWalkUp: false, flaggedItems: [],
      }
    : {
        // ── Regular customer order: PENDING with a short (30-min) TTL
        // for auto-cleanup if the cashier never approves. If celebration
        // mode reduced any eligible drink prices, tag the discount here
        // so reports can attribute the offset (matches STAFF/PASTOR/NEWCOMER
        // convention where discountType/discountOffset live on the order).
        PK: `ORDER#${orderId}`, SK: 'META', orderId, customerName,
        items: orderItems, totalAmount, status: 'PENDING',
        notes: composedNotes,
        discountType: pricing.discountType,
        discountOffset: pricing.discountOffset,
        grossAmount: pricing.grossAmount,
        createdAt: now, updatedAt: now,
        expiresAt: Math.floor(Date.now() / 1000) + ((settings?.orderExpiryMinutes || 30) * 60),
        isWalkUp: false, flaggedItems: [],
      };
  if (normalizedCustomerId) orderItem.customerId = normalizedCustomerId;
  if (staffCodeRecord) {
    // `staffCode` is the cashier's flag: the POS keys the "staff price
    // requested — confirm?" prompt off its presence, and approveOrder reverts
    // the price unless the cashier explicitly picks STAFF.
    orderItem.customerClass = 'STAFF';
    orderItem.staffCode = staffCodeRecord.code;
  }

  await docClient.send(new PutCommand({ TableName: ORDERS_TABLE, Item: orderItem }));

  logOrder(preorderRecord ? 'CREATE_PREORDER' : staffCodeRecord ? 'CREATE_STAFF' : 'CREATE', orderId, {
    customer: customerName,
    items: summarizeItems(orderItems),
    total: orderItem.totalAmount,
    discount: orderItem.discountType,
    offset: orderItem.discountOffset,
    status: orderItem.status,
    preorderCode: preorderRecord?.code,
    staffCode: staffCodeRecord?.code,
    collectionTime: collectionTime || undefined,
  });

  if (normalizedCustomerId) {
    await linkOrderToCustomer(normalizedCustomerId, orderId, totalAmount);
  }

  return res(201, {
    orderId,
    totalAmount: orderItem.totalAmount,
    status: orderItem.status,
    isPreOrder: !!preorderRecord,
  });
}

async function getOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const r = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));
  if (!r.Item) return res(404, { error: 'Order not found' });

  const o = r.Item;
  return res(200, {
    orderId: o.orderId, customerName: o.customerName, items: o.items,
    totalAmount: o.totalAmount, status: o.status, notes: o.notes || '',
    flaggedItems: o.flaggedItems, createdAt: o.createdAt, updatedAt: o.updatedAt,
    modifiedAt: o.modifiedAt, receiptUrl: o.receiptUrl, receiptAmount: o.receiptAmount,
    // Pre-order context for track.html: a pre-order is now an ordinary PENDING
    // order, so the page has to tell the two apart to label the edit window and
    // to show "free" rather than a total of RM0 with items priced in full.
    // `totalAmount` is NET (0), `grossAmount` the undiscounted sum and
    // `discountOffset` the reduction — see the storage convention.
    isPreOrder: o.isPreOrder === true,
    preorderCode: o.preorderCode || null,
    discountType: o.discountType,
    discountOffset: o.discountOffset,
    grossAmount: o.grossAmount,
  });
}

async function modifyOrder(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const id = event.pathParameters?.id;
  if (!id) return res(400, { error: 'Missing order id' });

  const body = JSON.parse(event.body || '{}');
  const r = await docClient.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { PK: `ORDER#${id}`, SK: 'META' } }));
  if (!r.Item) return res(404, { error: 'Order not found' });
  if (r.Item.status !== 'PENDING') return res(400, { error: 'Order cannot be modified' });

  const order = r.Item;
  const now = new Date().toISOString();

  // ─── CANCEL ────────────────────────────────────────────────────────
  if (body.action === 'cancel') {
    // Atomic status flip first; only release food if the flip succeeds.
    // ConditionExpression catches the race where a cashier just approved.
    try {
      await docClient.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: `ORDER#${id}`, SK: 'META' },
        UpdateExpression: 'SET #s = :s, updatedAt = :u REMOVE expiresAt',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'CANCELLED', ':u': now, ':pending': 'PENDING' },
        ConditionExpression: '#s = :pending',
      }));
    } catch (e: any) {
      if (e.name === 'ConditionalCheckFailedException') {
        return res(409, { error: 'Order is no longer modifiable' });
      }
      throw e;
    }
    await releaseFood(order.items);
    logOrder('CANCEL', id, {
      customer: order.customerName,
      total: order.totalAmount,
      reason: 'customer-initiated',
    });
    return res(200, { orderId: id, status: 'CANCELLED' });
  }

  // ─── UPDATE ────────────────────────────────────────────────────────
  if (body.action === 'update' && body.items?.length) {
    // Validate optional notes (max 200 chars, must be string).
    //
    // For a pre-order the budget applies to the CUSTOMER's portion only, measured
    // after the operational `[PRE-ORDER: …] Collect: …` prefix is stripped. The
    // prefix is the café's own text, not the customer's, so it must not eat into
    // what they are allowed to write — and `createOrder` already lets the
    // composed value exceed 200 for exactly that reason. Validating the composed
    // string here would make an edit reject notes that create accepted.
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string') return res(400, { error: 'notes must be a string' });
      const customerPortion = order.isPreOrder === true
        ? splitPreorderNotes(body.notes).rest
        : body.notes;
      if (customerPortion.length > 200) return res(400, { error: 'notes cannot exceed 200 characters' });
    }

    // Validate new items + compute new total. No DB writes yet.
    const settings = await getSettings();
    const newItems: any[] = [];
    const pricedLines: PricedLine[] = [];

    const isPreOrder = order.isPreOrder === true;

    // A pre-order edit must obey the SAME link restrictions as create: this
    // path never loaded the pre-order record before, which made it a bypass of
    // drinks-only, `eligibleItems` and `excludedOptions` all three.
    //
    // Deliberately `getPreorderCode`, NOT `validatePreorderCode`: validate also
    // enforces the link's own opensAt/expiresAt ordering window. Re-applying
    // that here would refuse a legitimate edit of a still-PENDING order placed
    // before the link's window closed — the editable window is the order's own
    // PENDING status, not the link's. A missing record (link hard-deleted) still
    // gets drinks-only enforced inside the helper.
    const preorderRecord = isPreOrder && order.preorderCode
      ? await getPreorderCode(String(order.preorderCode))
      : null;

    // A PENDING staff-link order edited from track.html must keep the staff
    // price it was placed at; repricing with a null class would silently jump
    // the customer back to full price mid-edit. Still only a REQUEST — the
    // cashier's confirmation on approve is unchanged.
    const requestedClass: CustomerClass | null = !isPreOrder && order.staffCode ? 'STAFF' : null;

    // Class the order-level totals are computed with. A pre-order stays free
    // across an edit; a staff-link order keeps T2's requested STAFF price.
    // Neither can come from the request body.
    const pricingClass: CustomerClass | null = isPreOrder ? 'PREORDER' : requestedClass;

    for (const item of body.items) {
      const menu = await getMenuItem(item.menuItemId);
      if (!menu) return res(400, { error: `Item ${item.menuItemId} not found` });
      if (!menu.isActive) return res(400, { error: `${menu.name} is not available` });
      if (!menu.isEnabledToday) return res(400, { error: `${menu.name} is not available today` });

      // Same three checks createOrder applies, same shared helper, same
      // messages. Runs before the FOOD stock check so a pre-order carrying food
      // is refused as "drinks only" rather than as "insufficient stock".
      if (isPreOrder) {
        const rejection = preorderItemRejection(preorderRecord, menu, item);
        if (rejection) return res(400, { error: rejection });
      }

      const quantity = resolveQuantity(item);

      if (menu.category === 'FOOD') {
        const available = (menu.foodQuantityToday || 0) - (menu.foodReserved || 0);
        if (available < quantity) return res(400, { error: `Insufficient stock for ${menu.name}` });
      }

      // Customer-driven edit, so no cashier discount class applies yet —
      // approveOrder re-applies it against the revised items.
      const line = priceLine(menu, item, settings, pricingClass);
      pricedLines.push(line);
      if (isPreOrder) {
        // Edited pre-order items keep the FULL unitPrice, exactly as createOrder
        // stores them — the free-ness stays at order level. Same two-priceLine
        // pattern, no new arithmetic.
        const fullLine = priceLine(menu, item, settings, null);
        newItems.push(toOrderItem(fullLine));
      } else if (requestedClass) {
        const baseLine = priceLine(menu, item, settings, null);
        newItems.push(toOrderItem(line, { baseUnitPrice: baseLine.unitPrice }));
      } else {
        newItems.push(toOrderItem(line));
      }
    }

    const pricing = summarizeOrderDiscount(pricedLines, pricingClass || order.customerClass || null);
    const totalAmount = pricing.totalAmount;

    // Build the conditional update. modifiedAt is stamped so the cashier UI
    // can show a "modified moments ago" indicator + approve guard. Include
    // the recomputed celebration offset so the discount tracking on the
    // modified order stays consistent with a freshly-created one.
    const exprValues: Record<string, any> = {
      ':items': newItems,
      ':t': totalAmount,
      ':u': now,
      ':pending': 'PENDING',
      ':dt': pricing.discountType,
      ':do': pricing.discountOffset,
      ':ga': pricing.grossAmount,
    };
    // `items` is a DynamoDB RESERVED KEYWORD, so it must be aliased (#items).
    // Unaliased, the whole UpdateCommand fails with ValidationException.
    //
    // ⚠ This expression must NOT touch `expiresAt`. The order stays PENDING, so
    // there is no transition to strip a TTL for; and for a pre-order the value
    // is the ISO service-end string that `expirePreOrders()` needs — removing or
    // renumbering it here would leave the order with nothing to expire it.
    let updateExpr = 'SET #items = :items, totalAmount = :t, updatedAt = :u, modifiedAt = :u, discountType = :dt, discountOffset = :do, grossAmount = :ga';
    if (body.notes !== undefined) {
      updateExpr += ', notes = :n';
      // The collection-time prefix is BACKEND-OWNED. Take it from the STORED
      // record, strip whatever prefix the client sent (preserved, forged or
      // absent), and re-prepend the stored one. Consequences, all intended:
      //   - a client that forgets to re-attach the prefix can no longer delete
      //     the collection time, which is stored nowhere else on the order;
      //   - a client that DOES re-attach it (the current frontend does) is
      //     harmless, because the duplicate is stripped before re-composing;
      //   - a client cannot forge a different code or collection time.
      // If the stored order has no prefix — a pre-order placed with no collection
      // time, or one predating this convention — none is invented; the customer's
      // text is stored alone.
      if (isPreOrder) {
        const storedPrefix = splitPreorderNotes(order.notes).prefix;
        const customerPortion = splitPreorderNotes(body.notes).rest;
        exprValues[':n'] = storedPrefix
          ? composePreorderNotes(storedPrefix, customerPortion)
          : customerPortion;
      } else {
        exprValues[':n'] = body.notes;
      }
    }

    try {
      await docClient.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: `ORDER#${id}`, SK: 'META' },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: { '#s': 'status', '#items': 'items' },
        ExpressionAttributeValues: exprValues,
        ConditionExpression: '#s = :pending',
      }));
    } catch (e: any) {
      if (e.name === 'ConditionalCheckFailedException') {
        return res(409, { error: 'Order is no longer modifiable' });
      }
      throw e;
    }

    // Adjust food reservations only after the order update committed.
    // If a foodReserved write fails partway, we accept the inconsistency
    // — the cron will release stale reservations on EXPIRED orders, and
    // the alternative (rolling back the order update) is worse.
    //
    // Both of these are category-filtered no-ops for a pre-order: drinks-only is
    // enforced on create AND (now) on edit, so neither `order.items` nor
    // `newItems` can contain a FOOD line and `foodReserved` cannot be moved —
    // in particular cannot be driven negative — by a pre-order edit.
    await releaseFood(order.items);
    for (const oi of newItems) {
      if (oi.category === 'FOOD') {
        await docClient.send(new UpdateCommand({
          TableName: MENU_TABLE,
          Key: { PK: `MENU#${oi.menuItemId}`, SK: 'META' },
          UpdateExpression: 'SET foodReserved = foodReserved + :q',
          ExpressionAttributeValues: { ':q': oi.quantity },
        }));
      }
    }

    logOrder('MODIFY', id, {
      customer: order.customerName,
      items: summarizeItems(newItems),
      total: totalAmount,
      discount: pricing.discountType,
      offset: pricing.discountOffset,
      // Pre-order edits are new as of v1.71; record which link so an edited
      // ministry order is traceable to its campaign.
      preorderCode: order.preorderCode || undefined,
    });
    return res(200, { orderId: id, totalAmount, status: 'PENDING', modifiedAt: now });
  }

  return res(400, { error: 'Invalid action' });
}

function extractId(path: string, prefix: string): string | null {
  const rest = path.replace(prefix, '');
  if (!rest || rest === '/') return null;
  return rest.startsWith('/') ? rest.slice(1).split('/')[0] : rest.split('/')[0];
}

export async function handleOrders(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const id = extractId(event.path, '/api/orders');

  if (method === 'POST' && !id) return createOrder(event);
  if (method === 'GET' && id) { event.pathParameters = { id }; return getOrder(event); }
  if (method === 'PUT' && id) { event.pathParameters = { id }; return modifyOrder(event); }

  return res(404, { error: 'Not found' });
}
