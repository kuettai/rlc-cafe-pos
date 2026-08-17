---
name: order-lifecycle
description: Order status state machine for RLC Café POS — valid transitions, guard conditions, the approve-time reprice (including the staff-link price revert), the ministry pre-order PENDING → PREPARING "release to barista" (single and bulk), the expiresAt/TTL rules and who may expire a pre-order, and food counter (foodReserved / foodQuantityToday) accounting on each transition. Use when changing order status, adding a transition, touching expiry or pre-orders, or debugging vanished orders or drifted food counts.
---

# Order Lifecycle

Source of truth: `backend/src/routes/pos.ts`, `backend/src/routes/orders.ts`,
`backend/src/expiry.ts`. Spec tests: `backend/tests/orders.test.ts`,
`backend/tests/expiry.test.ts`.

## States

`PENDING` → `PREPARING` → `READY` → `ARCHIVED`
plus terminal `EXPIRED`, `CANCELLED`.

| From | To | Trigger | Endpoint |
|---|---|---|---|
| — | PENDING | customer submits | `POST /api/orders` |
| — | PENDING | ministry pre-order placed through a link | `POST /api/orders` (with `preorderCode`) |
| — | PREPARING | cashier walk-up (skips PENDING) | `POST /api/pos/orders` |
| PENDING | PREPARING | cashier approves | `PUT /api/pos/orders/{id}/approve` |
| PENDING | PREPARING | cashier **releases a pre-order to the barista** (one) | `PUT /api/pos/orders/{id}/approve` |
| PENDING | PREPARING | cashier releases **all** of today's pre-orders | `PUT /api/pos/preorders/release-all` |
| PENDING | CANCELLED | cashier rejects | `PUT /api/pos/orders/{id}/reject` |
| PENDING | EXPIRED | cron, unapproved > 1h (**pre-orders skipped**) | `expiry.ts` |
| PENDING | EXPIRED | café closed (**pre-orders skipped**) | `PUT /api/pos/cafe/close` |
| PREPARING | READY | barista marks ready | `PUT /api/pos/orders/{id}/ready` |
| PREPARING | PENDING | undo | `PUT /api/pos/orders/{id}/undo` |
| READY | PREPARING | undo ready | `PUT /api/pos/orders/{id}/undo-ready` |
| READY | ARCHIVED | cashier archives, or cron auto-archive | `PUT /api/pos/orders/{id}/archive` |
| ARCHIVED/READY | CANCELLED | cancel a completed order | `POST /api/pos/orders/{id}/cancel-completed` |
| PENDING/PREPARING/READY | EXPIRED | pre-order past its ISO `expiresAt` | `expiry.ts` (`expirePreOrders`) |

**Ministry pre-orders enter PENDING, not PREPARING** (changed in v1.71 — they
used to be created PREPARING). PENDING is the only status `modifyOrder` will
edit, so creating them PENDING reuses the existing customer **Edit Order** flow
and its `ConditionExpression: '#s = :pending'` gate unchanged; the cashier's
PENDING → PREPARING release **is** the lock. Before this, a pre-order was
uneditable from the moment it was placed, and volunteers were deleting it in the
POS and asking the customer to order again — which produced duplicate orders.

Walk-up cashier orders are still the only creation path that skips PENDING.

## Guard conditions — keep them

Every status flip uses a DynamoDB `ConditionExpression: '#s = :prev'` and returns
`409` on `ConditionalCheckFailedException`. This is what makes a double-click or
a cashier undo racing the cron safe. A transition written without the guard can
double-apply its side effects (double food decrement, resurrected order).

Use `ReturnValues: 'ALL_OLD'` when the side effect needs the pre-transition
`items` array — that way the read and the guard are one atomic call.

### PENDING → PREPARING (approve) also reprices

Approve is the only transition that touches money. It re-applies the cashier's
selected class with `repriceStoredItems` and writes `totalAmount`, `grossAmount`,
`discountType`, `discountOffset`, `customerClass`, `approvedBy` and the repriced
`items` in the same guarded update.

**Staff-link orders add one step in front of that.** An order carrying
`staffCode` arrives already priced at the customer's own **requested** STAFF rate.
In `approveOrder`, if `order.staffCode` is present and the cashier did **not**
pass `discountType: 'STAFF'`, the items go through
`revertRequestedClassPricing()` before `repriceStoredItems` — otherwise the
self-requested RM5 would survive as the cheaper incumbent and be mislabelled
`CELEBRATION`. `approvedBy` is recorded either way, and the APPROVE audit line
carries `staffCode` and `staffPriceGranted`. Details in the `pricing-rules` and
`invariants` skills.

Otherwise a staff order is an **ordinary** PENDING order: no new status, no new
transition, the ordinary numeric `expiresAt` TTL, the ordinary food reservation,
and the café-open check still applies (unlike a ministry pre-order).

### PENDING → PREPARING for a pre-order: "release to barista"

`approveOrder` short-circuits on `order.isPreOrder === true` and delegates to
`releasePreOrderToPreparing()` in `pos.ts`. The bulk route
`PUT /api/pos/preorders/release-all` calls the **same helper**, so "release four
individually" and "release all four" cannot diverge on the guard, the pricing, the
audit line, the push or the ingredient deduction. Do not duplicate the update
expression across the two paths.

What is different from a money approve:

- **Pricing class is forced from the record.** `repriceStoredItems(items,
  'PREORDER')`. The cashier's dropdown has no PREORDER entry and
  `parseCustomerClass` refuses one from a request body, so with a null class the
  stored (FULL) `unitPrice` would win as the incumbent candidate and the order
  would be **billed**: `totalAmount` = full gross, `discountType` NONE, the
  MINISTRY_PREORDER label gone. See `pricing-rules`.
- **`expiresAt` is preserved, not removed** — see the TTL rule below.
- **A failed `#s = :pending` guard is not an error.** The helper returns
  `released: false`; the single route answers `409`, the bulk route counts it as
  *skipped*.
- **Ingredient stock is deducted here.** `deductIngredients()` is only ever
  called on the approve/release path, so pre-order drinks now move ingredient
  usage — which they never did while pre-orders were born PREPARING. Expect
  inventory and usage numbers to change.

`PREPARING → PENDING` (`PUT /api/pos/orders/{id}/undo`) is the **recovery route
for an early release**: it does not touch `expiresAt`, so the pre-order goes back
to being free, editable by the customer, and releasable again.

## TTL rule — the one that deletes data

`expiresAt` on the orders table is a **DynamoDB TTL attribute**.

- **Numeric `expiresAt` belongs on PENDING orders only.** It is how unapproved
  orders self-clean.
- **Every transition out of PENDING must `REMOVE expiresAt`** in its
  `UpdateExpression`. Approve, reject, archive, expire, cancel-completed all do.
  Omit it and TTL silently deletes a live or archived order later — no error, no
  log, the record is just gone.
- **Walk-up orders never get `expiresAt`** (`pos.ts` ~line 664). They start at
  PREPARING, so a TTL would wipe real history.
- **Pre-orders overload the name:** `isPreOrder` records store `expiresAt` as an
  **ISO string** (the link's `serviceEndTime`), not a number, and since v1.71 that
  string is present on **PENDING** records too. DynamoDB TTL ignores non-numeric
  values, so it is inert as a TTL and is instead compared string-wise by
  `expiry.ts`. Do not "fix" this to a number — a numeric value here arms a real
  TTL on an order that is meant to live for days and DynamoDB deletes it silently.
- **The pre-order release is the documented exception to the `REMOVE expiresAt`
  rule.** `releasePreOrderToPreparing()` appends `REMOVE expiresAt` **only** when
  the value is not a string, i.e. it preserves the ISO string and strips a stray
  numeric one. Safe because the string is inert; necessary because
  `expirePreOrders()` is the only thing that ever expires a pre-order — strip the
  field and an approved-but-uncollected pre-order sits in PREPARING forever.
  `modifyOrder` likewise never touches `expiresAt`.

## Food counter accounting

Two attributes on the menu record: `foodQuantityToday` (available today) and
`foodReserved` (claimed by in-flight orders). Available = the difference.

| Transition | Effect |
|---|---|
| order created with FOOD | `foodReserved += qty` |
| PREPARING → READY (`consumeFoodOnCollection`) | `foodReserved -= qty` **and** `foodQuantityToday -= qty` |
| READY → PREPARING (`unconsumeFoodOnUndo`) | exact inverse, both `+= qty` |
| reject / expire (`releaseFood`) | `foodReserved -= qty` only |
| cancel-completed | counters **untouched** — the food was already made and consumed |

Notes:
- Consumption moved from archive to `markReady` in v1.51.x: cashiers rarely
  archive explicitly, so archive-triggered decrements were unreliable.
- DRINK lines no-op inside every helper (category filter). Don't add category
  checks at call sites.
- Pre-orders are drinks-only, enforced on create **and** (since v1.71) on edit, so
  no pre-order path can move `foodReserved` — in particular a pre-order edit
  cannot drive it negative.
- **Counters may go negative.** Tolerated deliberately. Fix drift with
  `scripts/reset-food-reserved.mjs`; do not clamp in the helpers — clamping
  hides real accounting errors.
- Helpers swallow per-item errors and continue, so a deleted menu item can't
  fail a customer-facing transition.

## Cron

`backend/src/expiry.ts` runs on EventBridge every 30 minutes on Sundays
(01:00–09:00 UTC = 9am–5pm MYT), plus a midweek stock run on Wednesdays. It does
four jobs: expire stale PENDING orders (older than 1h), expire pre-orders past
their ISO `expiresAt`, auto-archive old READY orders, and — since the end-of-day
email moved off the request path — send the low-stock alert and the **end-of-day
revenue summary**. The three order jobs are all status-guarded.

### Who may expire a pre-order — exactly one thing

1. **The 1-hour PENDING sweep skips `isPreOrder`.** This is not defensive coding
   any more: pre-orders live in PENDING by design, and they are placed days ahead
   of the service they are for. That `continue` is precisely what lets a Wednesday
   pre-order survive to Sunday.
2. **`closeCafe` skips `isPreOrder` too.** Its PENDING query is unbounded by date,
   so before v1.71 closing the café once **expired every outstanding pre-order**,
   including next Sunday's. (The loop had no guard because the old comment
   correctly claimed pre-orders "skip PENDING entirely" — they no longer do.)
3. **`expirePreOrders()` is therefore the only expiry path**, and it now sweeps
   **PENDING** as well as PREPARING and READY. Without PENDING in that list, an
   unreleased pre-order would be immortal.

`expirePreOrders()` also self-heals a pre-order that has lost `expiresAt` (such a
record would otherwise be un-expirable by all three routes above): it falls back
to the linked `PREORDER_CODE#` record's `serviceEndTime`, and when the order is
not yet due it **backfills that value as an ISO string** under a status guard, one
code lookup per code per sweep. A stray **numeric** `expiresAt` puts the order on
the same branch and the backfill overwrites it, disarming a live TTL. If the code
record is gone or has no `serviceEndTime`, the order is logged and skipped rather
than expired against a guessed cutoff. The repair lives in the cron, not in
`undoToPending`, so it covers however the field was lost and adds no reads to a
hot cashier gesture.

### Closing the café does NOT send the end-of-day email

`closeCafe` expires PENDING orders, archives PREPARING/READY, resets the food
counters and featured drink — and then returns. It sends **no email**.

It used to end with `sendDailySummaryEmail().catch(() => {})`. Lambda freezes the
execution environment as soon as a handler returns, so that un-awaited promise
only progressed when the same sandbox happened to be thawed by a later request.
It survived on busy Sundays and died on a quiet one: on 2026-08-16 the sandbox
took two more requests and was reaped 0.78s after the close, and the revenue
report simply never arrived — silently, because the `catch` discarded the error
and the caller discarded `sendEndOfDaySummary`'s boolean.

The summary now belongs to the cron (`sendDailySummary` in `expiry.ts`), gated on
`cafeStatus === 'CLOSED'`, Malaysian Sunday after 2pm, and a
`DAILY_SUMMARY#{date}` marker written only after a confirmed send. So:

- **Close Café is what triggers it**, indirectly — the cron picks it up within
  30 minutes of the status flip.
- **Never add an email or other slow side effect to a request handler and leave
  it un-awaited.** Either await it (and justify the added latency against the
  10s API timeout) or hand it to the cron.
- A close after 5pm MYT has no cron run left to carry the summary. Widen the
  EventBridge window in `infra/lib/infra-stack.ts` if service hours change.

## Checklist for a new transition

1. `ConditionExpression` on the previous status; `409` on failure.
2. `REMOVE expiresAt` if leaving PENDING.
3. Food counters: which of the four effects above applies?
4. `logOrder(...)` for the audit trail.
5. Push notification, if the customer should be told.
6. Add it to the table above and to `backend/tests/orders.test.ts`.
