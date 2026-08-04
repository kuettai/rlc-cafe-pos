---
name: pricing-rules
description: Discount and pricing rules for RLC Café POS — the cheapest-candidate-wins algorithm, CELEBRATION / STAFF / PASTOR / NEWCOMER classes, net vs gross vs offset storage, and the reprice-on-approve path. Use when touching prices, discounts, totals, reports that aggregate money, or the walk-up cart.
---

# Pricing & Discounts

Single source of truth: `backend/src/lib/pricing.ts`. Executable specification:
`backend/tests/pricing.test.ts`. Display-only mirror for the customer UI:
`frontend/js/pricing.js`.

**Never compute a price inline.** The same math was once copy-pasted into
`createOrder`, `modifyOrder`, `createWalkUp` and `approveOrder`, drifted between
them, and shipped wrong totals to production more than once. All four call
`priceLine` + `summarizeOrderDiscount` today. Keep it that way.

## Algorithm: cheapest candidate wins, never stacks

For each line, build every applicable candidate price and charge the lowest:

```
gross        = basePrice + variant modifiers
CELEBRATION  = min(gross, celebrationPrice + variant modifiers)   eligible DRINKs only
STAFF        = flat RM5 (absorbs variant modifiers)               DRINKs only
PASTOR       = RM0                                                DRINKs only
NEWCOMER     = RM0                                                DRINKs only
FOOD         = never discounted by any rule
```

- Replaced an old "celebration always wins" rule that cancelled a newcomer's
  free drink and charged RM5 instead.
- The `Math.min(gross, ...)` clamp on celebration means enabling celebration
  mode can never *raise* a price (Mineral Water at RM1 stays RM1).
- **Ties go to the cashier's explicit class**, not to celebration, so the label
  reflects who the customer is.
- STAFF absorbing modifiers while CELEBRATION keeps paid modifiers on top is a
  deliberate asymmetry, preserved to avoid silently repricing staff drinks.
- Celebration eligibility is per menu item: `celebrationEligible === true` **and**
  `settings.celebrationMode`.

## Two different questions, two fields

- `customerClass` — the cashier's raw selection (`STAFF` / `PASTOR` /
  `NEWCOMER` / null). **Who the customer is.**
- `discountType` — which rule actually reduced a price (adds `CELEBRATION`,
  `MINISTRY_PREORDER`, `VOUCHER`, `NONE`). **What happened to the money.**

They differ legitimately: a newcomer who orders only food gets no reduction, so
`discountType` is `NONE` while `customerClass` stays `NEWCOMER`. Reports counting
newcomers must use `isNewcomerOrder()`, never `discountType` alone — under the
old rules a newcomer on a celebration day was tagged `CELEBRATION` and vanished
from the count.

## Storage convention — all aggregations assume it

| Field | Meaning |
|---|---|
| `totalAmount` | **NET** — what is actually collected |
| `grossAmount` | undiscounted total |
| `discountOffset` | `grossAmount - totalAmount` |
| item `unitPrice` | NET unit price charged |
| item `grossUnitPrice` | undiscounted unit price (absent on legacy records) |

Any new report, export, or dashboard tile must read `totalAmount` as net. Summing
gross into a revenue figure overstates takings.

## Approve-time reprice

`repriceStoredItems()` applies a cashier-selected class to an order already
priced at submission. It does **not** re-read the menu — menu prices may have
changed since the customer ordered, so the stored `unitPrice` acts as the
incumbent candidate. Same rules: cheapest wins, ties to the cashier, never
stacked. Orders predating `grossUnitPrice` fall back to treating stored net as
gross, which understates the offset rather than inventing a number.

## API surface

`priceLine`, `summarizeOrderDiscount`, `repriceStoredItems`, `toOrderItem`,
`parseCustomerClass`, `isNewcomerOrder`, `resolveQuantity`, `resolveVariants`,
constants `STAFF_DRINK_PRICE`, `DEFAULT_CELEBRATION_PRICE`.

`resolveQuantity` exists because customer/POS payloads send `quantity` while the
walk-up cart sends `qty`. Always go through it.

## Changing a rule

1. Edit `backend/src/lib/pricing.ts` only.
2. Add the case to `backend/tests/pricing.test.ts` first — it is the spec.
3. If the customer-facing UI shows the price, mirror in `frontend/js/pricing.js`
   (display only — the backend number always wins).
4. Vouchers and ministry pre-orders price separately in
   `backend/src/routes/vouchers.ts` / `preorder.ts` and feed `discountType`.
5. Reports read these fields — check `frontend/js/reports.js` and
   `backend/src/routes/admin.ts` before renaming anything.
