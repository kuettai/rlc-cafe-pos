// pricing.js — client-side mirror of backend/src/lib/pricing.ts
//
// The backend remains authoritative: it re-prices every order on submit. This
// exists so the POS can show the cashier the amount that will actually be
// charged, instead of a gross total that the server then discounts.
//
// ⚠️ Keep the rules here in sync with backend/src/lib/pricing.ts. The backend
// test matrix (backend/tests/pricing.test.ts) is the specification.
//
// Rules (discounts never stack — cheapest applicable price wins per line):
//   gross       = basePrice + variant modifiers
//   CELEBRATION = min(gross, celebrationPrice + variant modifiers)  eligible DRINKs only
//   STAFF       = flat RM5   (DRINKs only)
//   PASTOR      = RM0        (DRINKs only)
//   NEWCOMER    = RM0        (DRINKs only)
//   FOOD        = never discounted

(function (global) {
  'use strict';

  const STAFF_DRINK_PRICE = 5;
  const DEFAULT_CELEBRATION_PRICE = 5;

  function parseCustomerClass(value) {
    return value === 'STAFF' || value === 'PASTOR' || value === 'NEWCOMER' ? value : null;
  }

  /**
   * Net unit price for one cart line.
   *
   * @param {Object} line     Cart line: { price, qty|quantity, category, celebrationEligible, basePrice }
   *                          `price` is the gross unit price (base + variants).
   * @param {Object} opts     { celebrationMode, celebrationPrice, customerClass }
   * @returns {{ unitPrice:number, grossUnitPrice:number, appliedRule:string }}
   */
  function priceCartLine(line, opts) {
    opts = opts || {};
    const grossUnitPrice = Number(line.price) || 0;
    const category = line.category || 'DRINK';
    const customerClass = parseCustomerClass(opts.customerClass);

    const candidates = [{ rule: 'NONE', price: grossUnitPrice }];

    if (category === 'DRINK' && customerClass) {
      candidates.push({
        rule: customerClass,
        price: customerClass === 'STAFF' ? STAFF_DRINK_PRICE : 0,
      });
    }

    if (opts.celebrationMode && category === 'DRINK' && line.celebrationEligible === true) {
      const base = Number(opts.celebrationPrice) || DEFAULT_CELEBRATION_PRICE;
      // Variant surcharges stay on top of the celebration base; the clamp
      // stops celebration mode from ever raising a price.
      const variantModifiers = grossUnitPrice - (Number(line.basePrice) || 0);
      candidates.push({ rule: 'CELEBRATION', price: Math.min(grossUnitPrice, base + variantModifiers) });
    }

    let winner = candidates[0];
    for (const c of candidates) if (c.price < winner.price) winner = c;

    return {
      unitPrice: winner.price,
      grossUnitPrice,
      appliedRule: winner.price < grossUnitPrice ? winner.rule : 'NONE',
    };
  }

  /** Price a whole cart. Returns per-line results plus net/gross totals. */
  function priceCart(cart, opts) {
    const lines = [];
    let total = 0;
    let gross = 0;
    const rules = new Set();

    (cart || []).forEach(function (c) {
      const qty = Number(c.qty != null ? c.qty : c.quantity) || 1;
      const priced = priceCartLine(c, opts);
      total += priced.unitPrice * qty;
      gross += priced.grossUnitPrice * qty;
      if (priced.appliedRule !== 'NONE') rules.add(priced.appliedRule);
      lines.push(Object.assign({}, priced, { qty: qty }));
    });

    return {
      lines: lines,
      total: total,
      gross: gross,
      offset: gross - total,
      discounted: gross - total > 0.001,
      rules: Array.from(rules),
    };
  }

  global.CafePricing = {
    STAFF_DRINK_PRICE: STAFF_DRINK_PRICE,
    parseCustomerClass: parseCustomerClass,
    priceCartLine: priceCartLine,
    priceCart: priceCart,
  };
})(typeof window !== 'undefined' ? window : this);
