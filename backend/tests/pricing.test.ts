import {
  priceLine,
  summarizeOrderDiscount,
  repriceStoredItems,
  resolveQuantity,
  resolveVariants,
  parseCustomerClass,
  STAFF_DRINK_PRICE,
} from '../src/lib/pricing';

// ─── Fixtures mirroring live menu data (fetched 2026-08-02) ──────────────
const latte = { name: '☕ Latte', category: 'DRINK', basePrice: 7, celebrationEligible: true };
const longBlack = { name: '☕ Long Black', category: 'DRINK', basePrice: 6, celebrationEligible: true };
const soda = { name: '🥤 Soda (Iced)', category: 'DRINK', basePrice: 5, celebrationEligible: true };
const matcha = { name: '🍵 Matcha Latte', category: 'DRINK', basePrice: 8 }; // celebrationEligible unset
const mocha = { name: '🍫 Mocha', category: 'DRINK', basePrice: 10, celebrationEligible: false };
const water = { name: '💧 Mineral Water', category: 'DRINK', basePrice: 1, celebrationEligible: true };
const croissant = { name: '🥐 Croissant', category: 'FOOD', basePrice: 6, celebrationEligible: true };

const CELEBRATION_ON = { celebrationMode: true, celebrationPrice: 5 };
const CELEBRATION_OFF = { celebrationMode: false, celebrationPrice: 5 };

const one = (menuItemId = 'x') => ({ menuItemId, quantity: 1 });
const oatMilk = (menuItemId = 'x') => ({
  menuItemId,
  quantity: 1,
  selectedVariants: [{ group: 'Milk', option: 'Oat Milk', price: 1 }],
});

describe('resolveQuantity', () => {
  it('accepts `quantity` (customer payload) and `qty` (walk-up cart)', () => {
    expect(resolveQuantity({ menuItemId: 'x', quantity: 3 })).toBe(3);
    expect(resolveQuantity({ menuItemId: 'x', qty: 2 })).toBe(2);
  });

  it('defaults to 1 for missing or invalid values', () => {
    expect(resolveQuantity({ menuItemId: 'x' })).toBe(1);
    expect(resolveQuantity({ menuItemId: 'x', quantity: 0 })).toBe(1);
    expect(resolveQuantity({ menuItemId: 'x', quantity: NaN })).toBe(1);
  });
});

describe('resolveVariants', () => {
  it('sums selectedVariants and joins labels', () => {
    const { variantLabel, variantModifiers } = resolveVariants(latte, {
      menuItemId: 'x',
      selectedVariants: [
        { group: 'Temperature', option: 'Iced', price: 1 },
        { group: 'Milk', option: 'Oat Milk', price: 1 },
      ],
    });
    expect(variantModifiers).toBe(2);
    expect(variantLabel).toBe('Iced, Oat Milk');
  });

  it('matches a legacy variant by name or id', () => {
    const menu = { ...latte, variants: [{ id: 'oat', name: 'Oat Milk', priceModifier: 1 }] };
    expect(resolveVariants(menu, { menuItemId: 'x', variant: 'Oat Milk' }).variantModifiers).toBe(1);
    expect(resolveVariants(menu, { menuItemId: 'x', variant: 'oat' }).variantModifiers).toBe(1);
  });

  it('treats an unknown legacy variant as no surcharge', () => {
    expect(resolveVariants(latte, { menuItemId: 'x', variant: 'Nope' }).variantModifiers).toBe(0);
  });
});

// ─── The matrix: celebration × customer class × item type ────────────────
describe('priceLine — no cashier discount', () => {
  it('charges gross when celebration is off', () => {
    expect(priceLine(latte, one(), CELEBRATION_OFF, null).unitPrice).toBe(7);
  });

  it('applies celebration price to eligible drinks', () => {
    const line = priceLine(latte, one(), CELEBRATION_ON, null);
    expect(line.unitPrice).toBe(5);
    expect(line.grossUnitPrice).toBe(7);
    expect(line.appliedRule).toBe('CELEBRATION');
  });

  it('keeps paid variant modifiers on top of the celebration base', () => {
    // RM5 celebration base + RM1 oat milk = RM6, discounted from RM8.
    const line = priceLine(latte, oatMilk(), CELEBRATION_ON, null);
    expect(line.unitPrice).toBe(6);
    expect(line.grossUnitPrice).toBe(8);
  });

  it('leaves non-eligible drinks at full price', () => {
    expect(priceLine(matcha, one(), CELEBRATION_ON, null).unitPrice).toBe(8);
    expect(priceLine(mocha, one(), CELEBRATION_ON, null).unitPrice).toBe(10);
  });

  it('never discounts food, even if flagged eligible', () => {
    expect(priceLine(croissant, one(), CELEBRATION_ON, null).unitPrice).toBe(6);
  });

  it('never RAISES the price of a cheap eligible drink (clamp)', () => {
    // Regression: Mineral Water at RM1 was pushed up to the RM5 celebration
    // price because the old code overwrote basePrice unconditionally.
    const line = priceLine(water, one(), CELEBRATION_ON, null);
    expect(line.unitPrice).toBe(1);
    expect(line.appliedRule).toBe('NONE');
  });

  it('is a no-op when gross already equals the celebration price', () => {
    const line = priceLine(soda, one(), CELEBRATION_ON, null);
    expect(line.unitPrice).toBe(5);
    expect(line.appliedRule).toBe('NONE');
  });
});

describe('priceLine — NEWCOMER and PASTOR', () => {
  it.each(['NEWCOMER', 'PASTOR'] as const)('%s drinks are free with celebration off', cls => {
    expect(priceLine(latte, one(), CELEBRATION_OFF, cls).unitPrice).toBe(0);
  });

  it.each(['NEWCOMER', 'PASTOR'] as const)(
    '%s drinks stay free when celebration is ON (regression)',
    cls => {
      // Old behaviour: celebration won, so a newcomer was charged RM5.
      const line = priceLine(latte, one(), CELEBRATION_ON, cls);
      expect(line.unitPrice).toBe(0);
      expect(line.appliedRule).toBe(cls);
    },
  );

  it('frees non-eligible drinks on a celebration day (regression)', () => {
    // Old behaviour: any eligible drink in the basket flipped the whole order
    // to CELEBRATION, charging full price for everything non-eligible.
    expect(priceLine(matcha, one(), CELEBRATION_ON, 'NEWCOMER').unitPrice).toBe(0);
  });

  it('frees drinks including their variant surcharges', () => {
    expect(priceLine(latte, oatMilk(), CELEBRATION_ON, 'NEWCOMER').unitPrice).toBe(0);
  });

  it('still charges for food', () => {
    expect(priceLine(croissant, one(), CELEBRATION_ON, 'NEWCOMER').unitPrice).toBe(6);
  });
});

describe('priceLine — STAFF', () => {
  it('charges the flat staff price for drinks', () => {
    expect(priceLine(mocha, one(), CELEBRATION_OFF, 'STAFF').unitPrice).toBe(STAFF_DRINK_PRICE);
  });

  it('does not go above gross for a cheap drink', () => {
    expect(priceLine(water, one(), CELEBRATION_OFF, 'STAFF').unitPrice).toBe(1);
  });

  it('takes the cheaper of staff and celebration pricing', () => {
    // Iced latte: gross RM8, celebration RM6, staff flat RM5 → RM5.
    const line = priceLine(latte, oatMilk(), CELEBRATION_ON, 'STAFF');
    expect(line.unitPrice).toBe(5);
    expect(line.appliedRule).toBe('STAFF');
  });

  it('prefers the cashier label when both rules tie', () => {
    // Plain latte: celebration RM5, staff RM5 → tie, label follows the cashier.
    expect(priceLine(latte, one(), CELEBRATION_ON, 'STAFF').appliedRule).toBe('STAFF');
  });

  it('keeps celebration pricing when it beats the staff price', () => {
    const cheapCelebration = { celebrationMode: true, celebrationPrice: 3 };
    const line = priceLine(latte, one(), cheapCelebration, 'STAFF');
    expect(line.unitPrice).toBe(3);
    expect(line.appliedRule).toBe('CELEBRATION');
  });

  it('never charges food to staff at drink prices', () => {
    expect(priceLine(croissant, one(), CELEBRATION_OFF, 'STAFF').unitPrice).toBe(6);
  });
});

// ─── PREORDER: the system-only class (v1.71) ─────────────────────────────
//
// A ministry pre-order is free by construction. Before v1.71 "free" was written
// out at each call site; it is now one more RM0 candidate in the cheapest-wins
// list, exactly like PASTOR / NEWCOMER — no new arithmetic. What makes it
// different is WHO may select it (nobody: it is derived from the order record's
// `isPreOrder` flag) and how it is REPORTED (`MINISTRY_PREORDER`, never
// `PREORDER`). Those two rules are stated below and in `parseCustomerClass`.
describe('priceLine — PREORDER', () => {
  it('prices a drink at RM0 with celebration off', () => {
    const line = priceLine(latte, one(), CELEBRATION_OFF, 'PREORDER');
    expect(line.unitPrice).toBe(0);
    expect(line.grossUnitPrice).toBe(7);
    expect(line.appliedRule).toBe('PREORDER');
  });

  it('stays free when celebration is ON, and on non-eligible drinks', () => {
    expect(priceLine(latte, one(), CELEBRATION_ON, 'PREORDER').unitPrice).toBe(0);
    expect(priceLine(matcha, one(), CELEBRATION_ON, 'PREORDER').unitPrice).toBe(0);
    expect(priceLine(mocha, one(), CELEBRATION_ON, 'PREORDER').unitPrice).toBe(0);
  });

  it('frees drinks including their variant surcharges', () => {
    expect(priceLine(latte, oatMilk(), CELEBRATION_ON, 'PREORDER').unitPrice).toBe(0);
  });

  it('leaves FOOD at full price', () => {
    // FOOD is never discounted by any rule, PREORDER included. The pre-order link
    // rejects food up front, so this is the belt to that braces.
    expect(priceLine(croissant, one(), CELEBRATION_OFF, 'PREORDER').unitPrice).toBe(6);
    expect(priceLine(croissant, one(), CELEBRATION_ON, 'PREORDER').unitPrice).toBe(6);
  });
});

describe('summarizeOrderDiscount — PREORDER reports as MINISTRY_PREORDER', () => {
  it('maps the class to MINISTRY_PREORDER while customerClass stays PREORDER', () => {
    // Two different questions, two fields: `customerClass` is WHO (a ministry
    // pre-order), `discountType` is WHAT HAPPENED TO THE MONEY. 'PREORDER' must
    // never reach `discountType` — every report switches on it against a fixed
    // list that does not contain it, so the order would drop out of the discount
    // tables. The DiscountType type `Exclude`s it, making this a compile error to
    // forget.
    const lines = [
      priceLine(latte, one('latte'), CELEBRATION_OFF, 'PREORDER'),
      priceLine(mocha, one('mocha'), CELEBRATION_OFF, 'PREORDER'),
    ];
    const summary = summarizeOrderDiscount(lines, 'PREORDER');
    expect(summary.discountType).toBe('MINISTRY_PREORDER');
    expect(summary.discountType).not.toBe('PREORDER');
    expect(summary.customerClass).toBe('PREORDER');
    // NET 0, gross the full undiscounted sum, offset the whole of it.
    expect(summary.totalAmount).toBe(0);
    expect(summary.grossAmount).toBe(17);
    expect(summary.discountOffset).toBe(17);
    expect(summary.discountOffset).toBe(summary.grossAmount - summary.totalAmount);
  });

  it('labels MINISTRY_PREORDER even when no rule actually reduced a price', () => {
    // The mapping is UNCONDITIONAL, unlike the cashier classes below it. A
    // hypothetical RM0 menu item reduces nothing, so a `rules.has(customerClass)`
    // test would come out 'NONE' and silently drop a real ministry order out of
    // every discount table.
    const free = { name: '🚰 Tap Water', category: 'DRINK', basePrice: 0 };
    const lines = [priceLine(free, one(), CELEBRATION_OFF, 'PREORDER')];
    expect(lines[0].appliedRule).toBe('NONE');   // nothing was reduced
    const summary = summarizeOrderDiscount(lines, 'PREORDER');
    expect(summary.discountType).toBe('MINISTRY_PREORDER');
    expect(summary.customerClass).toBe('PREORDER');
    expect(summary.discountOffset).toBe(0);
  });
});

describe('summarizeOrderDiscount', () => {
  it('reports NONE for an undiscounted order', () => {
    const lines = [priceLine(latte, one(), CELEBRATION_OFF, null)];
    expect(summarizeOrderDiscount(lines, null)).toMatchObject({
      totalAmount: 7,
      grossAmount: 7,
      discountOffset: 0,
      discountType: 'NONE',
      customerClass: null,
    });
  });

  it('tags a celebration-priced order and records the offset', () => {
    const lines = [
      priceLine(latte, one('latte'), CELEBRATION_ON, null),   // 7 → 5
      priceLine(longBlack, one('lb'), CELEBRATION_ON, null),  // 6 → 5
    ];
    expect(summarizeOrderDiscount(lines, null)).toMatchObject({
      totalAmount: 10,
      grossAmount: 13,
      discountOffset: 3,
      discountType: 'CELEBRATION',
    });
  });

  it('the headline regression: newcomer + mixed basket on a celebration day', () => {
    // Latte (eligible) + Matcha (not eligible). Old behaviour charged RM13.
    const lines = [
      priceLine(latte, one('latte'), CELEBRATION_ON, 'NEWCOMER'),
      priceLine(matcha, one('matcha'), CELEBRATION_ON, 'NEWCOMER'),
    ];
    const summary = summarizeOrderDiscount(lines, 'NEWCOMER');
    expect(summary.totalAmount).toBe(0);
    expect(summary.grossAmount).toBe(15);
    expect(summary.discountOffset).toBe(15);
    expect(summary.discountType).toBe('NEWCOMER');
  });

  it('records customerClass even when nothing was discounted', () => {
    // Food-only newcomer: no price change, but they must still be counted.
    const lines = [priceLine(croissant, one(), CELEBRATION_ON, 'NEWCOMER')];
    const summary = summarizeOrderDiscount(lines, 'NEWCOMER');
    expect(summary.totalAmount).toBe(6);
    expect(summary.discountOffset).toBe(0);
    expect(summary.discountType).toBe('NONE');
    expect(summary.customerClass).toBe('NEWCOMER');
  });

  it('falls back to CELEBRATION when the cashier class priced nothing', () => {
    // Staff orders food (no staff discount) plus an eligible drink.
    const lines = [
      priceLine(croissant, one('food'), CELEBRATION_ON, 'STAFF'),
      priceLine(soda, one('soda'), CELEBRATION_ON, 'STAFF'),
    ];
    const summary = summarizeOrderDiscount(lines, 'STAFF');
    // Soda gross RM5, staff RM5 → tie at gross, so no rule reduced anything.
    expect(summary.discountOffset).toBe(0);
    expect(summary.discountType).toBe('NONE');
    expect(summary.customerClass).toBe('STAFF');
  });

  it('multiplies by quantity', () => {
    const lines = [priceLine(latte, { menuItemId: 'latte', quantity: 3 }, CELEBRATION_ON, null)];
    expect(summarizeOrderDiscount(lines, null)).toMatchObject({
      totalAmount: 15,
      grossAmount: 21,
      discountOffset: 6,
    });
  });

  it('never produces a negative total or offset', () => {
    const combos: (null | 'STAFF' | 'PASTOR' | 'NEWCOMER' | 'PREORDER')[] =
      [null, 'STAFF', 'PASTOR', 'NEWCOMER', 'PREORDER'];
    const menus = [latte, longBlack, soda, matcha, mocha, water, croissant];
    for (const cls of combos) {
      for (const settings of [CELEBRATION_ON, CELEBRATION_OFF, { celebrationMode: true, celebrationPrice: 3 }]) {
        for (const menu of menus) {
          const line = priceLine(menu, oatMilk(), settings, cls);
          expect(line.unitPrice).toBeGreaterThanOrEqual(0);
          expect(line.unitPrice).toBeLessThanOrEqual(line.grossUnitPrice);
        }
      }
    }
  });
});

describe('parseCustomerClass', () => {
  it('accepts the three valid classes', () => {
    expect(parseCustomerClass('STAFF')).toBe('STAFF');
    expect(parseCustomerClass('PASTOR')).toBe('PASTOR');
    expect(parseCustomerClass('NEWCOMER')).toBe('NEWCOMER');
  });

  it('rejects anything else', () => {
    // 'PREORDER' is in this list ON PURPOSE and is the security-relevant entry.
    // This function's whole input is untrusted request bodies (`body.discountType`
    // on approve, the walk-up cart's `discountType`) and PREORDER prices every
    // drink at RM0 — accepting it would let a crafted request zero ANY order and
    // have it reported as MINISTRY_PREORDER, i.e. a free order with nobody
    // accountable. A system-only class must never be parseable from input; it may
    // only be derived from the order record's own `isPreOrder` flag.
    for (const v of ['NONE', 'CELEBRATION', 'PREORDER', 'MINISTRY_PREORDER', '', undefined, null, 'staff', 0]) {
      expect(parseCustomerClass(v)).toBeNull();
    }
  });
});

describe('repriceStoredItems — PREORDER at release', () => {
  // Item `unitPrice` on a stored pre-order is the FULL price until release —
  // free-ness is an ORDER-level fact, and that is the shape every pre-order
  // record already in production has, so nothing is backfilled. Releasing to the
  // barista rewrites it, and `releasePreOrderToPreparing` must force the class to
  // 'PREORDER' to do so.
  const storedDrink = {
    menuItemId: 'latte', name: '☕ Latte', variant: null, quantity: 2,
    unitPrice: 8, grossUnitPrice: 8, category: 'DRINK',
  };

  it('zeroes stored DRINK items and preserves grossUnitPrice', () => {
    const { items, summary } = repriceStoredItems([storedDrink], 'PREORDER');
    expect(items[0].unitPrice).toBe(0);
    // Preserved, so the offset stays computable after the rewrite.
    expect(items[0].grossUnitPrice).toBe(8);
    expect(summary.totalAmount).toBe(0);
    expect(summary.grossAmount).toBe(16);
    expect(summary.discountOffset).toBe(16);
    expect(summary.discountType).toBe('MINISTRY_PREORDER');
    expect(summary.customerClass).toBe('PREORDER');
  });

  it('BILLS the order in full if the class is not forced (the bug it prevents)', () => {
    // The cashier's dropdown has no PREORDER entry and parseCustomerClass refuses
    // one, so at approve the class is null. With a null class the stored FULL
    // unitPrice wins as the incumbent candidate and a released pre-order would be
    // charged RM16 with the MINISTRY_PREORDER label gone. This is why
    // `releasePreOrderToPreparing` passes 'PREORDER' explicitly.
    const { items, summary } = repriceStoredItems([storedDrink], null);
    expect(items[0].unitPrice).toBe(8);
    expect(summary.totalAmount).toBe(16);
    expect(summary.discountType).toBe('NONE');
  });

  it('leaves a stored FOOD item alone', () => {
    const storedFood = {
      menuItemId: 'croissant', name: '🥐 Croissant', variant: null, quantity: 1,
      unitPrice: 6, grossUnitPrice: 6, category: 'FOOD',
    };
    const { items, summary } = repriceStoredItems([storedDrink, storedFood], 'PREORDER');
    expect(items[0].unitPrice).toBe(0);
    expect(items[1].unitPrice).toBe(6);
    expect(summary.totalAmount).toBe(6);
    expect(summary.grossAmount).toBe(22);
    expect(summary.discountOffset).toBe(16);
  });
});
