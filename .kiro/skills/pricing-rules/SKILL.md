---
name: pricing-rules
description: Discount and pricing rules for RLC Café POS — the cheapest-candidate-wins algorithm, CELEBRATION / STAFF / PASTOR / NEWCOMER / BLESSING / PREORDER classes, which menu categories each class may discount (PASTOR, NEWCOMER and BLESSING discount FOOD as well as DRINK; STAFF, PREORDER and CELEBRATION are DRINK-only — "FOOD is never discounted" is withdrawn), the one `classAppliesToCategory` / `CLASS_CATEGORIES` allowlist that owns that scope, the four cashier-selectable classes including the BLESSING full-waiver fallback for comping a whole order when no named class fits, the customer-requested STAFF price from the staff link and how it is reverted on approve, the system-only PREORDER class for free ministry pre-orders and its MINISTRY_PREORDER discountType, why WHO DECIDES rather than the size of the discount is what keeps PREORDER out of `parseCustomerClass` while BLESSING is admitted, net vs gross vs offset storage, and the reprice-on-approve path. Use when touching prices, discounts, totals, reports that aggregate money, the staff link, ministry pre-orders, comped or free orders, or the walk-up cart.
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
PASTOR       = RM0                                                ALL categories (DRINK + FOOD)
NEWCOMER     = RM0                                                ALL categories (DRINK + FOOD)
BLESSING     = RM0                                                ALL categories (DRINK + FOOD)
PREORDER     = RM0                                                DRINKs only
FOOD         = discounted by PASTOR / NEWCOMER / BLESSING only;
               never by STAFF, PREORDER or CELEBRATION
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
- **Category scope is a per-class fact, and ONE helper owns it.**
  `classAppliesToCategory(customerClass, category)` (`pricing.ts:198`) is the only
  place the question is asked, over the `CLASS_CATEGORIES` allowlist at `:182`:
  `STAFF: ['DRINK']`, `PREORDER: ['DRINK']`, `PASTOR: ['DRINK','FOOD']`,
  `NEWCOMER: ['DRINK','FOOD']`, `BLESSING: ['DRINK','FOOD']`.
  **Written as an allowlist, never as a negation** —
  the category arrives as `String(menu.category || '')`, so an unknown or missing
  category must match nothing; a `category !== 'DRINK'` test would price a
  malformed menu record free. And `Record<CustomerClass, …>` is exhaustive, so a
  new customer class cannot ship without its categories being decided.
  `BLESSING` lists both members of the enum for the strongest reason of the three
  all-category classes: covering everything is not a *consequence* of the class,
  it **is** the class. If a third menu category is ever added, BLESSING must gain
  it or the waiver silently stops being full.
  There are **two** customer-class gates — `priceLine` (submission-time, `:229`)
  and `repriceStoredItems` (approve-time, `:453`) — and both must call that helper
  rather than inlining the test. A scope that differs between them prices the same
  order two ways depending on when the class was applied: the customer sees one
  number and the cashier grants another.

  The display mirror `frontend/js/pricing.js:38` has a `classAppliesToCategory` of
  the same name and one gate, but **not the same shape** — it is an
  `ALL_CATEGORY_CLASSES` list (`:37`, now
  `['PASTOR','NEWCOMER','BLESSING']`) plus a `category === 'DRINK'` fallback, and it
  defaults a missing category to `'DRINK'`. Display-only, so it can never persist
  a number; if you touch it, prefer converging on the backend's allowlist rather
  than copying the fallback back the other way.
- **Scope and winner are separate decisions.** Whether a candidate is *offered*
  (category scope) and which candidate *wins* (cheapest, ties to the cashier's
  explicit class) are independent. Widening a class to a new category adds
  candidates; it must not touch the comparison or the tie-break.
- `celebrationApplies()` is unchanged by any of this: DRINK **and**
  `celebrationEligible`, never widened to FOOD.

## Who may select a class: cashier, one customer-requested case, one system-only

Classes are normally **cashier-selected**: at approve for a customer-submitted
order, or up front in the walk-up cart's discount chips (`pos-walkup.js`) when the
cashier is ringing the order up themselves. There are four such classes:
`STAFF`, `PASTOR`, `NEWCOMER` and `BLESSING`. Both paths narrow the selection
through `parseCustomerClass`, so the accepted set cannot drift between them.

`BLESSING` sits in exactly that tier, alongside `PASTOR` / `NEWCOMER`: it is
**cashier-selected, never customer-requestable** (unlike the staff link) and
**never server-assigned** (unlike `PREORDER`). It is also the one class whose
*entire purpose* is a full waiver — every item, every category, RM0 — so it is
the **fallback the cashier reaches for when no named class fits** but the café
wants to comp the whole order. Because a human at the till chose it, the waiver
has somebody accountable for it in `approvedBy`; that accountability is the only
thing standing behind it, which is why it must never become selectable by a
customer.

The one exception to cashier-selection is the
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
existing cheapest-wins list, mechanically the same *kind* of candidate as
`PASTOR` / `NEWCOMER` / `BLESSING`.

**It is not scoped like them, though, and that is the part that matters:**
`PREORDER` applies to DRINK lines only, while `PASTOR` / `NEWCOMER` / `BLESSING`
apply to every
category. Pre-orders being drinks-only is enforced upstream as well
(`preorderItemRejection()`, on both create and edit — see the `invariants` skill),
so the DRINK gate here is the second half of a rule, not an arbitrary
restriction. Do not "align" `PREORDER` with the other RM0 classes: a pre-order
zeroes the whole gross, so widening it to FOOD is uncapped cost to the café.

Three rules make it safe:

- **`parseCustomerClass()` deliberately does not accept it.** Its input is
  untrusted request bodies, and `PREORDER` zeroes every drink — a crafted
  `discountType: 'PREORDER'` would otherwise zero any order and report it as
  MINISTRY_PREORDER, a free order with nobody accountable. `PREORDER` may only be
  derived from the order record's own `isPreOrder` flag: `createOrder` /
  `modifyOrder` derive it from `preorderRecord`, `approveOrder` /
  `releasePreOrderToPreparing` force it from the stored order.

  **The dividing line is WHO DECIDES, not the size of the discount** — and
  `BLESSING` is what makes that explicit. `BLESSING` also zeroes an entire order,
  across *both* categories rather than just drinks, and it **is** accepted from a
  request body. So "it zeroes the order" was never the reason for the refusal. The
  reason is provenance: `BLESSING` is a **till-side judgement call**, which has to
  be expressible in a request and is accountable in `approvedBy`; `PREORDER` is a
  **server-derived flag**, and a server-derived fact that a request could assert
  is simply forgeable. A class that a human selects belongs in `parseCustomerClass`
  however large its discount; a class the server assigns belongs out of it however
  small. `pricing.ts:317-343` carries this same reasoning at the function — keep
  the two in agreement.
- **It never reaches a report as `discountType`.** `summarizeOrderDiscount` maps
  the class to `discountType: 'MINISTRY_PREORDER'` **unconditionally** (not
  conditional on a rule having fired — a hypothetical RM0 menu item would
  otherwise come out `NONE` and drop the order out of the discount tables), while
  the returned `customerClass` stays `'PREORDER'`. The `DiscountType` type
  `Exclude`s `'PREORDER'`, so forgetting the mapping is a compile error. Every
  report switches on `discountType` against a fixed list that has no `PREORDER`
  in it.

  **`BLESSING` gets no remap at all, and that asymmetry is deliberate.** It
  reports as its own literal `discountType: 'BLESSING'` when it actually reduced a
  price, and `NONE` when it reduced nothing — the ordinary conditional path every
  cashier-selected class takes. `PREORDER` is remapped *unconditionally* because a
  pre-order is free **by construction**, so its label must not depend on a rule
  having fired. A `BLESSING` order is the opposite: it is a real till decision
  about a specific basket, and labelling an order BLESSING when nothing was in fact
  reduced would **overstate how often the café comps** — padding the waiver row of
  the discount report with orders that gave away nothing. Do not "align" BLESSING
  with PREORDER here.
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
  `BLESSING` / `PREORDER` / null). **Who the customer is.** Cashier-selected except for the two
  create-time writers: the staff link, where `STAFF` means "requested", not
  "granted"; and a ministry pre-order, where `PREORDER` is assigned by the server.
- `discountType` — which rule actually reduced a price (adds `CELEBRATION`,
  `MINISTRY_PREORDER`, `VOUCHER`, `NONE`). **What happened to the money.**

They differ legitimately, and `PREORDER` is the sharpest case: `customerClass`
stays `'PREORDER'` (who) while `discountType` is `'MINISTRY_PREORDER'` (what
happened to the money).

Reports counting newcomers must use `isNewcomerOrder()` — which accepts
**either** field (`customerClass === 'NEWCOMER' || discountType === 'NEWCOMER'`,
`pricing.ts:355`) — never `discountType` alone. `discountType` names **the rule that
won the line**, and which rule wins is decided by the candidate comparison and its
tie-break — not by who the customer is. That is not hypothetical: under the old
"celebration always wins" rule a newcomer on a celebration day came out tagged
`CELEBRATION` and **vanished from the newcomer count**. Ties go to the cashier's
explicit class today, so the label is right — but the thing keeping it right is a
tie-break in `pricing.ts`, one rule change away from doing it again.

(An earlier version of this section used "a newcomer who orders only food gets no
reduction, so `discountType` is `NONE`" as the example. That is **no longer true** —
`NEWCOMER` discounts FOOD, so a food-only newcomer order is fully discounted and
its `discountType` *is* `NEWCOMER`. The `isNewcomerOrder()` rule above is
unaffected; only the example was wrong.)

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
cashier's dropdown has four entries (`STAFF` / `PASTOR` / `NEWCOMER` /
`BLESSING`) and **no PREORDER entry**, and `parseCustomerClass` refuses one, so
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

1. Edit `backend/src/lib/pricing.ts` only. A change to a class's **category
   scope** is a change to `classAppliesToCategory`, nowhere else — check that
   both gates (`priceLine`, `repriceStoredItems`) still route through it.
2. Add the case to `backend/tests/pricing.test.ts` first — it is the spec. A scope
   change needs a FOOD case and a DRINK case per affected class, and an
   approve-time reprice case, or the second gate is untested.
3. If the customer-facing UI shows the price, mirror in `frontend/js/pricing.js`
   (display only — the backend number always wins).
4. Vouchers still price separately in `backend/src/routes/vouchers.ts` and feed
   `discountType`. **Ministry pre-orders no longer do** — since v1.71 they price
   through this module as the `PREORDER` class; `preorder.ts` only holds the link
   record and its restrictions.
5. Reports read these fields — check `frontend/js/reports.js` and
   `backend/src/routes/admin.ts` before renaming anything. A scope change lands
   here too: because `PASTOR` / `NEWCOMER` / `BLESSING` discount FOOD,
   `GET /api/admin/reports/discounts` returns a **`foodBreakdown`** alongside its
   existing `drinkBreakdown` (same shape,
   `{ [discountType]: { [itemName]: quantity } }`), rendered by
   `frontend/js/admin-dashboard.js` in the per-type discount accordion. A
   breakdown that counts only drink lines under-reports what was given away.
