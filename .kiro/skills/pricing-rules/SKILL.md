---
name: pricing-rules
description: Discount and pricing rules for RLC Café POS — the cheapest-candidate-wins algorithm, CELEBRATION / STAFF / PASTOR / NEWCOMER / PREORDER classes, the customer-requested STAFF price from the staff link and how it is reverted on approve, the system-only PREORDER class for free ministry pre-orders and its MINISTRY_PREORDER discountType, net vs gross vs offset storage, and the reprice-on-approve path. Use when touching prices, discounts, totals, reports that aggregate money, the staff link, ministry pre-orders, or the walk-up cart.
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
PREORDER     = RM0                                                DRINKs only
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

## Who may select a class: cashier, one customer-requested case, one system-only

Classes are normally **cashier-selected at approve**. The one exception is the
staff link (`?code=<CODE>`, `backend/src/routes/staffcode.ts`): a customer can
**request** `STAFF` themselves, and `createOrder` prices the order that way up
front so the customer sees the number they will pay.

A request is not an approval. The order is stored with `staffCode` and
`customerClass: 'STAFF'` on a PENDING order, and `approveOrder` **reverts** the
requested price unless the cashier explicitly passes `discountType: 'STAFF'`.
Nothing else in the system lets a customer choose their own price — keep it that
way, and see the `invariants` skill for the assertion.

`PREORDER` is a third category: **server-assigned, never selected by anybody.**
See below.

## `PREORDER` — the system-only class (v1.71)

A ministry pre-order is free by construction. Before v1.71 that was hardcoded
("free" written out at each site); it now goes through `pricing.ts` like every
other rule, as the `PREORDER` customer class: **DRINK lines price at RM0, FOOD is
untouched, and no new arithmetic was added** — it is another RM0 candidate in the
existing cheapest-wins list, exactly like `PASTOR` / `NEWCOMER`.

Three rules make it safe:

- **`parseCustomerClass()` deliberately does not accept it.** Its input is
  untrusted request bodies, and `PREORDER` zeroes every drink — a crafted
  `discountType: 'PREORDER'` would otherwise zero any order and report it as
  MINISTRY_PREORDER, a free order with nobody accountable. `PREORDER` may only be
  derived from the order record's own `isPreOrder` flag: `createOrder` /
  `modifyOrder` derive it from `preorderRecord`, `approveOrder` /
  `releasePreOrderToPreparing` force it from the stored order.
- **It never reaches a report as `discountType`.** `summarizeOrderDiscount` maps
  the class to `discountType: 'MINISTRY_PREORDER'` **unconditionally** (not
  conditional on a rule having fired — a hypothetical RM0 menu item would
  otherwise come out `NONE` and drop the order out of the discount tables), while
  the returned `customerClass` stays `'PREORDER'`. The `DiscountType` type
  `Exclude`s `'PREORDER'`, so forgetting the mapping is a compile error. Every
  report switches on `discountType` against a fixed list that has no `PREORDER`
  in it.
- **Item `unitPrice` stays FULL until approve.** Free-ness is an *order-level*
  fact: `totalAmount` 0, `discountOffset` = the whole gross. `createOrder` and
  `modifyOrder` therefore store the items from a second `priceLine(..., null)`
  call (full price) while the RM0 lines feed the order totals — the same
  two-`priceLine` pattern the staff link uses for `baseUnitPrice`, and the shape
  every pre-order record already has in production, so **no migration and no
  backfill**. At release, `repriceStoredItems(items, 'PREORDER')` rewrites the
  stored `unitPrice` to 0; `grossUnitPrice` is preserved throughout, so the
  offset stays computable.

## Two different questions, two fields

- `customerClass` — the raw selection (`STAFF` / `PASTOR` / `NEWCOMER` /
  `PREORDER` / null). **Who the customer is.** Cashier-selected except for the two
  create-time writers: the staff link, where `STAFF` means "requested", not
  "granted"; and a ministry pre-order, where `PREORDER` is assigned by the server.
- `discountType` — which rule actually reduced a price (adds `CELEBRATION`,
  `MINISTRY_PREORDER`, `VOUCHER`, `NONE`). **What happened to the money.**

They differ legitimately, and `PREORDER` is the sharpest case: `customerClass`
stays `'PREORDER'` (who) while `discountType` is `'MINISTRY_PREORDER'` (what
happened to the money). Likewise a newcomer who orders only food gets no
reduction, so `discountType` is `NONE` while `customerClass` stays
`NEWCOMER`. Reports counting
newcomers must use `isNewcomerOrder()`, never `discountType` alone — under the
old rules a newcomer on a celebration day was tagged `CELEBRATION` and vanished
from the count.

## Storage convention — all aggregations assume it

| Field | Meaning |
|---|---|
| `totalAmount` | **NET** — what is actually collected |
| `grossAmount` | undiscounted total |
| `discountOffset` | `grossAmount - totalAmount` |
| item `unitPrice` | NET unit price charged. **Exception:** a pre-order stores the FULL price until it is released — free-ness is order-level; `repriceStoredItems` rewrites it to 0 at release |
| item `grossUnitPrice` | undiscounted unit price (absent on legacy records) |
| item `baseUnitPrice` | NET unit price with **no** customer class — celebration-or-full. Written only by the staff-link path |

Any new report, export, or dashboard tile must read `totalAmount` as net. Summing
gross into a revenue figure overstates takings.

## Approve-time reprice

`repriceStoredItems()` applies a cashier-selected class to an order already
priced at submission. It does **not** re-read the menu — menu prices may have
changed since the customer ordered, so the stored `unitPrice` acts as the
incumbent candidate. Same rules: cheapest wins, ties to the cashier, never
stacked. Orders predating `grossUnitPrice` fall back to treating stored net as
gross, which understates the offset rather than inventing a number.

**A pre-order must be repriced with the class forced to `'PREORDER'`.** The
cashier's dropdown has no PREORDER entry and `parseCustomerClass` refuses one, so
the class is null there; with a null class the stored FULL `unitPrice` wins as the
incumbent candidate and releasing a pre-order would **bill it** — `totalAmount` =
full gross, `discountType` `NONE`, the MINISTRY_PREORDER label gone.
`releasePreOrderToPreparing()` does this for both the single and the bulk release.

### Reverting a customer-requested class first

Because `repriceStoredItems` treats the stored net as the incumbent candidate and
only ever charges the cheaper option, a self-requested RM5 would **stick even
when the cashier declined** — and, being below gross, come back out labelled
`CELEBRATION`. So `approveOrder` runs the items through
`revertRequestedClassPricing()` **before** `repriceStoredItems` whenever
`order.staffCode` is present and the cashier did not pass `discountType: 'STAFF'`.

`revertRequestedClassPricing` is a lookup, not arithmetic:
`unitPrice = baseUnitPrice ?? grossUnitPrice ?? unitPrice`. It restores
`baseUnitPrice` rather than `grossUnitPrice` on purpose — declining the staff
price must not also throw away a legitimate celebration discount. The
`grossUnitPrice` and `unitPrice` fallbacks cover records predating the field.

The APPROVE audit line records `staffCode` and `staffPriceGranted`, so the grant
rate is auditable after the fact.

## API surface

`priceLine`, `summarizeOrderDiscount`, `repriceStoredItems`,
`revertRequestedClassPricing`, `toOrderItem`, `parseCustomerClass`,
`isNewcomerOrder`, `resolveQuantity`, `resolveVariants`, constants
`STAFF_DRINK_PRICE`, `DEFAULT_CELEBRATION_PRICE`.

`toOrderItem(line, opts?)` takes an optional `{ baseUnitPrice }`. Supply it only
when the line was priced with a **customer-requested** class; omitted, the shape
is exactly what it has always been, so existing callers are unaffected.

The staff price itself introduces no new arithmetic — it is the existing
`priceLine(..., 'STAFF')` / `STAFF_DRINK_PRICE` path, and `baseUnitPrice` is the
same `priceLine` called with a null class.

`resolveQuantity` exists because customer/POS payloads send `quantity` while the
walk-up cart sends `qty`. Always go through it.

## Changing a rule

1. Edit `backend/src/lib/pricing.ts` only.
2. Add the case to `backend/tests/pricing.test.ts` first — it is the spec.
3. If the customer-facing UI shows the price, mirror in `frontend/js/pricing.js`
   (display only — the backend number always wins).
4. Vouchers still price separately in `backend/src/routes/vouchers.ts` and feed
   `discountType`. **Ministry pre-orders no longer do** — since v1.71 they price
   through this module as the `PREORDER` class; `preorder.ts` only holds the link
   record and its restrictions.
5. Reports read these fields — check `frontend/js/reports.js` and
   `backend/src/routes/admin.ts` before renaming anything.
