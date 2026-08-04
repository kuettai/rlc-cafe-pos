---
name: order-lifecycle
description: Order status state machine for RLC Café POS — valid transitions, guard conditions, the expiresAt/TTL rules, and food counter (foodReserved / foodQuantityToday) accounting on each transition. Use when changing order status, adding a transition, touching expiry, or debugging vanished orders or drifted food counts.
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
| — | PREPARING | cashier walk-up (skips PENDING) | `POST /api/pos/orders` |
| PENDING | PREPARING | cashier approves | `PUT /api/pos/orders/{id}/approve` |
| PENDING | CANCELLED | cashier rejects | `PUT /api/pos/orders/{id}/reject` |
| PENDING | EXPIRED | cron, unapproved > 1h | `expiry.ts` |
| PREPARING | READY | barista marks ready | `PUT /api/pos/orders/{id}/ready` |
| PREPARING | PENDING | undo | `PUT /api/pos/orders/{id}/undo` |
| READY | PREPARING | undo ready | `PUT /api/pos/orders/{id}/undo-ready` |
| READY | ARCHIVED | cashier archives, or cron auto-archive | `PUT /api/pos/orders/{id}/archive` |
| ARCHIVED/READY | CANCELLED | cancel a completed order | `POST /api/pos/orders/{id}/cancel-completed` |
| PREPARING/READY | EXPIRED | pre-order past its ISO `expiresAt` | `expiry.ts` |

## Guard conditions — keep them

Every status flip uses a DynamoDB `ConditionExpression: '#s = :prev'` and returns
`409` on `ConditionalCheckFailedException`. This is what makes a double-click or
a cashier undo racing the cron safe. A transition written without the guard can
double-apply its side effects (double food decrement, resurrected order).

Use `ReturnValues: 'ALL_OLD'` when the side effect needs the pre-transition
`items` array — that way the read and the guard are one atomic call.

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
  **ISO string**, not a number. DynamoDB TTL ignores non-numeric values, so it
  is inert as a TTL and is instead compared string-wise by `expiry.ts`. Do not
  "fix" this to a number.

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
- **Counters may go negative.** Tolerated deliberately. Fix drift with
  `scripts/reset-food-reserved.mjs`; do not clamp in the helpers — clamping
  hides real accounting errors.
- Helpers swallow per-item errors and continue, so a deleted menu item can't
  fail a customer-facing transition.

## Cron

`backend/src/expiry.ts` runs on EventBridge every 5 minutes and does three jobs:
expire stale PENDING orders (older than 1h), expire pre-orders past their ISO
`expiresAt`, and auto-archive old READY orders. All three are status-guarded.

## Checklist for a new transition

1. `ConditionExpression` on the previous status; `409` on failure.
2. `REMOVE expiresAt` if leaving PENDING.
3. Food counters: which of the four effects above applies?
4. `logOrder(...)` for the audit trail.
5. Push notification, if the customer should be told.
6. Add it to the table above and to `backend/tests/orders.test.ts`.
