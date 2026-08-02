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
 *   FOOD         = never discounted by any rule
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

/** Cashier-selected customer category. Identifies WHO, not how much. */
export type CustomerClass = 'STAFF' | 'PASTOR' | 'NEWCOMER';

/** Rule that produced the charged price for a line. */
export type PricingRule = 'NONE' | 'CELEBRATION' | CustomerClass;

/** Value persisted on the order record and used by reports. */
export type DiscountType = PricingRule | 'MINISTRY_PREORDER' | 'VOUCHER';

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
  if (customerClass && rules.has(customerClass)) discountType = customerClass;
  else if (rules.has('CELEBRATION')) discountType = 'CELEBRATION';

  return {
    totalAmount,
    grossAmount,
    discountOffset: grossAmount - totalAmount,
    discountType,
    customerClass: customerClass || null,
  };
}

/** Narrow arbitrary request input to a valid CustomerClass, or null. */
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

/** Shape a PricedLine into the item record persisted on orders. */
export function toOrderItem(line: PricedLine) {
  return {
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
  [k: string]: any;
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
