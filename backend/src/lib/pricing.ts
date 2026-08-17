/**
 * pricing.ts — single source of truth for order line pricing.
 *
 * Before this module the same math was copy-pasted into four places
 * (createOrder, modifyOrder, createWalkUp, approveOrder) and had drifted.
 * All four now call `priceLine` + `summarizeOrderDiscount`.
 *
 * ── Discount rules ──────────────────────────────────────────────────────
 * Discounts never stack. For each line we compute every applicable price and
 * charge the LOWEST. This replaces the old "celebration always wins" rule,
 * which cancelled a newcomer's free drink and charged them RM5 instead — and
 * charged full price for any non-eligible item in the same basket.
 *
 *   gross        = basePrice + variant modifiers
 *   CELEBRATION  = celebrationPrice + variant modifiers   (eligible DRINKs only)
 *   STAFF        = flat RM5                               (DRINKs only)
 *   PASTOR       = RM0                                    (DRINKs only)
 *   NEWCOMER     = RM0                                    (DRINKs only)
 *   PREORDER     = RM0                                    (DRINKs only)
 *   FOOD         = never discounted by any rule
 *
 * PREORDER is the ministry pre-order class. It is NOT cashier-selectable and
 * `parseCustomerClass` deliberately refuses it — see the note there. It exists
 * so `createOrder` / `modifyOrder` / `approveOrder` can price a pre-order
 * through this module instead of hardcoding "free" three times, and it is
 * reported as `discountType: 'MINISTRY_PREORDER'` (see
 * `summarizeOrderDiscount`), never as 'PREORDER'.
 *
 * The celebration candidate is clamped by `Math.min(gross, ...)`, so turning
 * on celebration mode can never RAISE a price. Without the clamp, marking a
 * cheap drink (e.g. Mineral Water at RM1) as celebration-eligible would push
 * it up to the celebration price.
 *
 * STAFF is deliberately a flat RM5 that absorbs variant modifiers, preserving
 * the pre-existing behaviour. Celebration instead keeps paid modifiers on top
 * of its base (the earlier "Bug 5 fix"). That asymmetry is intentional here
 * only to avoid silently repricing staff drinks; revisit if the café wants
 * staff pricing to match the celebration convention.
 */

export const STAFF_DRINK_PRICE = 5;
export const DEFAULT_CELEBRATION_PRICE = 5;

/**
 * Customer category a line is priced for. Identifies WHO, not how much.
 *
 * STAFF / PASTOR / NEWCOMER are cashier-selected (STAFF may also be
 * customer-REQUESTED via the staff link). PREORDER is neither: it is derived
 * from the order record's `isPreOrder` flag and can never arrive from a request
 * body — `parseCustomerClass` rejects it.
 */
export type CustomerClass = 'STAFF' | 'PASTOR' | 'NEWCOMER' | 'PREORDER';

/** Rule that produced the charged price for a line. */
export type PricingRule = 'NONE' | 'CELEBRATION' | CustomerClass;

/**
 * Value persisted on the order record and used by reports.
 *
 * 'PREORDER' is deliberately excluded: reports switch on this value against a
 * fixed list (`frontend/js/admin.js`, `frontend/js/pos.js`,
 * `frontend/js/admin-dashboard.js`), and a pre-order is labelled
 * MINISTRY_PREORDER there. The `Exclude` makes that mapping a compile error to
 * forget — see `summarizeOrderDiscount`.
 */
export type DiscountType = Exclude<PricingRule, 'PREORDER'> | 'MINISTRY_PREORDER' | 'VOUCHER';

export interface PricingSettings {
  celebrationMode?: boolean;
  celebrationPrice?: number | string;
  [k: string]: any;
}

/**
 * Shape of a menu record as read from DynamoDB. Fields are optional so a raw
 * `Record<string, any>` from the SDK is assignable without casting; values are
 * coerced at use.
 */
export interface MenuItemLike {
  basePrice?: number | string;
  category?: string;
  celebrationEligible?: boolean;
  variants?: { id?: string; name?: string; priceModifier?: number }[];
  name?: string;
  [k: string]: any;
}

export interface RequestedItem {
  menuItemId: string;
  /** Customer/POS payloads use `quantity`; the walk-up cart posts `qty`. */
  quantity?: number;
  qty?: number;
  variant?: string;
  selectedVariants?: { group?: string; option: string; price?: number }[];
  [k: string]: any;
}

export interface PricedLine {
  menuItemId: string;
  name: string;
  variant: string | null;
  quantity: number;
  /** Net unit price actually charged. */
  unitPrice: number;
  category: string;
  /** Undiscounted unit price, for offset/reporting. */
  grossUnitPrice: number;
  /** Which rule won this line. */
  appliedRule: PricingRule;
}

/** `quantity` (customer) and `qty` (walk-up cart) both mean the same thing. */
export function resolveQuantity(item: RequestedItem): number {
  const q = Number(item.quantity ?? item.qty ?? 1);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

/**
 * Resolve the variant surcharge and display label for a line.
 * Supports the current `selectedVariants` array and the legacy single
 * `variant` string, matched against a variant's `id` or `name`.
 */
export function resolveVariants(
  menu: MenuItemLike,
  item: RequestedItem,
): { variantLabel: string | null; variantModifiers: number } {
  if (item.selectedVariants?.length) {
    let variantModifiers = 0;
    for (const sv of item.selectedVariants) variantModifiers += Number(sv.price || 0);
    return {
      variantLabel: item.selectedVariants.map(sv => sv.option).join(', '),
      variantModifiers,
    };
  }

  if (item.variant) {
    const variant = menu.variants?.find(v => v.id === item.variant || v.name === item.variant);
    return {
      variantLabel: item.variant,
      variantModifiers: Number(variant?.priceModifier || 0),
    };
  }

  return { variantLabel: null, variantModifiers: 0 };
}

function celebrationApplies(menu: MenuItemLike, settings?: PricingSettings): boolean {
  return !!settings?.celebrationMode
    && menu.category === 'DRINK'
    && menu.celebrationEligible === true;
}

/**
 * Price one order line. Returns the net unit price plus the gross it was
 * discounted from and which rule won, so callers can build the order-level
 * discount fields without recomputing anything.
 */
export function priceLine(
  menu: MenuItemLike,
  item: RequestedItem,
  settings?: PricingSettings,
  customerClass?: CustomerClass | null,
): PricedLine {
  const quantity = resolveQuantity(item);
  const { variantLabel, variantModifiers } = resolveVariants(menu, item);
  const grossUnitPrice = Number(menu.basePrice || 0) + variantModifiers;
  const category = String(menu.category || '');

  // Candidate prices, cheapest wins. Ties resolve to the earlier entry, so
  // an explicit cashier selection is preferred over celebration when both
  // land on the same amount — the label then reflects who the customer is.
  const candidates: { rule: PricingRule; price: number }[] = [{ rule: 'NONE', price: grossUnitPrice }];

  if (category === 'DRINK' && customerClass) {
    const price = customerClass === 'STAFF' ? STAFF_DRINK_PRICE : 0;
    candidates.push({ rule: customerClass, price });
  }

  if (celebrationApplies(menu, settings)) {
    const celebrationPrice = Number(settings?.celebrationPrice) || DEFAULT_CELEBRATION_PRICE;
    // Clamp: a "discount" must never increase the price.
    candidates.push({ rule: 'CELEBRATION', price: Math.min(grossUnitPrice, celebrationPrice + variantModifiers) });
  }

  let winner = candidates[0];
  for (const c of candidates) if (c.price < winner.price) winner = c;

  return {
    menuItemId: item.menuItemId,
    name: menu.name || '',
    variant: variantLabel,
    quantity,
    unitPrice: winner.price,
    category,
    grossUnitPrice,
    appliedRule: winner.price < grossUnitPrice ? winner.rule : 'NONE',
  };
}

export interface OrderDiscountSummary {
  /** Net amount actually collected. */
  totalAmount: number;
  /** Undiscounted amount, for auditability. */
  grossAmount: number;
  /** Sum of all reductions: grossAmount - totalAmount. */
  discountOffset: number;
  /** Winning label, kept in the existing single-value shape reports expect. */
  discountType: DiscountType;
  /** Cashier's raw selection, independent of which rule won the pricing. */
  customerClass: CustomerClass | null;
}

/**
 * Roll priced lines up into the order-level discount fields.
 *
 * `customerClass` is persisted separately from `discountType` because the two
 * answer different questions. A newcomer who orders food only gets no price
 * reduction, so `discountType` is NONE — but they are still a newcomer, and
 * the shift summary / monthly report need to count them.
 *
 * The PREORDER class is the sharpest example: the returned `customerClass` stays
 * 'PREORDER' (who), while `discountType` is 'MINISTRY_PREORDER' (what happened
 * to the money).
 */
export function summarizeOrderDiscount(
  lines: PricedLine[],
  customerClass?: CustomerClass | null,
): OrderDiscountSummary {
  let totalAmount = 0;
  let grossAmount = 0;
  const rules = new Set<PricingRule>();

  for (const l of lines) {
    totalAmount += l.unitPrice * l.quantity;
    grossAmount += l.grossUnitPrice * l.quantity;
    if (l.appliedRule !== 'NONE') rules.add(l.appliedRule);
  }

  // Prefer the cashier's category when it actually priced something; fall
  // back to CELEBRATION so celebration-day reporting stays intact.
  let discountType: DiscountType = 'NONE';
  if (customerClass === 'PREORDER') {
    // A ministry pre-order reports as MINISTRY_PREORDER, unconditionally — the
    // whole order is free by construction, so the label does not depend on a
    // rule having fired (a hypothetical RM0 menu item would otherwise come out
    // 'NONE' and drop the order out of the discount tables). 'PREORDER' must
    // never reach the record: every report switches on `discountType` against a
    // fixed list that does not contain it.
    discountType = 'MINISTRY_PREORDER';
  } else if (customerClass && rules.has(customerClass)) discountType = customerClass;
  else if (rules.has('CELEBRATION')) discountType = 'CELEBRATION';

  return {
    totalAmount,
    grossAmount,
    discountOffset: grossAmount - totalAmount,
    discountType,
    customerClass: customerClass || null,
  };
}

/**
 * Narrow arbitrary request input to a valid CustomerClass, or null.
 *
 * STAFF / PASTOR / NEWCOMER only. **'PREORDER' is deliberately NOT accepted.**
 * This function's whole input is untrusted request bodies (`body.discountType`
 * on approve, the walk-up cart's `discountType`). PREORDER prices every drink
 * at RM0, so accepting it here would let a cashier — or a crafted request —
 * zero out any order and have it reported as MINISTRY_PREORDER, i.e. a free
 * order with nobody accountable. The PREORDER class may only be derived from
 * the order record's own `isPreOrder` flag, never from input.
 */
export function parseCustomerClass(value: any): CustomerClass | null {
  return value === 'STAFF' || value === 'PASTOR' || value === 'NEWCOMER' ? value : null;
}

/**
 * Was this order served to a newcomer?
 *
 * Checks `customerClass` first and falls back to `discountType` for orders
 * written before `customerClass` existed. Reports must not infer this from
 * `discountType` alone: under the old rules a newcomer served on a celebration
 * day was tagged CELEBRATION and vanished from the count.
 */
export function isNewcomerOrder(order: { customerClass?: any; discountType?: any }): boolean {
  return order?.customerClass === 'NEWCOMER' || order?.discountType === 'NEWCOMER';
}

/**
 * Shape a PricedLine into the item record persisted on orders.
 *
 * `opts.baseUnitPrice` is only supplied by callers that priced the line with a
 * CUSTOMER-REQUESTED class (the staff link). It records what the same line
 * would have cost with no class at all, so the cashier declining the request
 * can fall back to it. Omitted, the returned shape is exactly what it has
 * always been — existing callers are unaffected.
 */
export function toOrderItem(line: PricedLine, opts?: { baseUnitPrice?: number }) {
  const item = {
    menuItemId: line.menuItemId,
    name: line.name,
    variant: line.variant,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    category: line.category,
    // Persisted so the approve path can re-apply discounts without having to
    // re-read the menu (prices may have changed since the order was placed).
    grossUnitPrice: line.grossUnitPrice,
  };
  if (opts?.baseUnitPrice !== undefined) {
    return { ...item, baseUnitPrice: opts.baseUnitPrice };
  }
  return item;
}

export interface StoredOrderItem {
  menuItemId: string;
  name?: string;
  variant?: string | null;
  quantity: number;
  /** Net price as stored — already celebration-priced if that applied. */
  unitPrice: number;
  category: string;
  /** Absent on orders created before this field existed. */
  grossUnitPrice?: number;
  /**
   * Net unit price this line would have had with NO customer class —
   * celebration-or-full. Only written by the staff-link path; see
   * `revertRequestedClassPricing`.
   */
  baseUnitPrice?: number;
  [k: string]: any;
}

/**
 * Undo a CUSTOMER-REQUESTED customer-class price, restoring each line to what
 * it would have cost with no class.
 *
 * Why this exists: the staff link lets a customer ask for the RM5 staff price
 * themselves, and the order is stored already priced that way so the customer
 * sees the number they will pay. But a self-applied discount is not an
 * approved one — the cashier must confirm at approve time.
 *
 * `repriceStoredItems` treats the stored net as the incumbent candidate and
 * only ever charges the cheaper option, so without this step the RM5 would
 * silently stick when the cashier DECLINED, and (because the incumbent net is
 * below gross) be mislabelled CELEBRATION on the way out.
 *
 * This is a lookup, not arithmetic: `baseUnitPrice` was computed by
 * `priceLine` with a null class at submission time. Falling back to
 * `grossUnitPrice` covers legacy records that predate the field; falling back
 * to `unitPrice` leaves an item alone when neither is present. Using
 * `baseUnitPrice` rather than `grossUnitPrice` matters because declining the
 * staff price must not also throw away a legitimate celebration discount.
 */
export function revertRequestedClassPricing(items: StoredOrderItem[]): StoredOrderItem[] {
  return items.map(item => ({
    ...item,
    unitPrice: Number(item.baseUnitPrice ?? item.grossUnitPrice ?? item.unitPrice),
  }));
}

/**
 * Apply a cashier-selected customer class to an already-priced order, as the
 * cashier does when approving a customer-submitted order.
 *
 * The stored `unitPrice` already encodes any celebration discount, so it acts
 * as the incumbent candidate and no menu re-read is needed. Same rule as
 * `priceLine`: cheapest wins, ties go to the cashier's label, never stacked.
 *
 * Orders predating `grossUnitPrice` fall back to treating the stored net as
 * gross, which understates the offset slightly rather than inventing a number.
 */
export function repriceStoredItems(
  items: StoredOrderItem[],
  customerClass?: CustomerClass | null,
): { items: StoredOrderItem[]; summary: OrderDiscountSummary } {
  const lines: PricedLine[] = items.map(item => {
    const gross = Number(item.grossUnitPrice ?? item.unitPrice);
    const incumbentNet = Number(item.unitPrice);
    let unitPrice = incumbentNet;
    let appliedRule: PricingRule = incumbentNet < gross ? 'CELEBRATION' : 'NONE';

    if (item.category === 'DRINK' && customerClass) {
      const classPrice = customerClass === 'STAFF' ? STAFF_DRINK_PRICE : 0;
      // `<=` so an explicit cashier class wins ties, matching priceLine.
      if (classPrice <= unitPrice) {
        unitPrice = classPrice;
        appliedRule = classPrice < gross ? customerClass : 'NONE';
      }
    }

    return {
      menuItemId: item.menuItemId,
      name: item.name || '',
      variant: item.variant ?? null,
      quantity: Number(item.quantity) || 1,
      unitPrice,
      category: item.category,
      grossUnitPrice: gross,
      appliedRule,
    };
  });

  return {
    items: items.map((item, i) => ({
      ...item,
      unitPrice: lines[i].unitPrice,
      grossUnitPrice: lines[i].grossUnitPrice,
    })),
    summary: summarizeOrderDiscount(lines, customerClass),
  };
}
