---
name: test-suites
description: How to run the RLC Café POS test suites safely — which are offline and which write to the live production café, the ZZTEST_ prefix every test-created record must carry, the reserved test phone range, and the cleanup procedure afterwards. Use before running any test, adding a suite that writes data, or cleaning up after a live run.
---

# Test Suites

Two categories, and the difference matters more than anything else here: some
suites are pure and offline, and some **write to the live production café** that
real volunteers use on Sunday mornings. There is no staging environment.

## Category 1 — safe, offline, run freely

```bash
cd backend && npx tsc                                          # typecheck
cd backend && npx jest --testPathIgnorePatterns integration     # all unit suites
npm run version:check                                          # six markers + SHELL
```

| Suite | Covers |
|---|---|
| `pricing.test.ts` | the discount **specification** — read it as documentation |
| `orders.test.ts` | order creation and transitions |
| `expiry.test.ts` | the EventBridge cron |
| `router.test.ts` | path dispatch |
| `auth.test.ts`, `login-blocklist.test.ts` | JWT, PIN, login blocking |
| `phone.test.ts` | phone normalisation |
| `planogram.test.ts` | planogram routes |
| `test-markers.test.ts` | the test-data marker contract (below) |

These mock DynamoDB. They touch nothing real.

## Category 2 — writes to PRODUCTION, ask first

| Suite | What it writes |
|---|---|
| `backend/tests/integration.test.ts` "Order Flow" | opens the café, creates a real order, approves it (deducts ingredient stock), marks it ready, closes the café (**sends an end-of-day email**) |
| `screenshots/journey_customer/customer.spec.ts` | submits a real customer order, then cancels it (leaving a CANCELLED record) |
| `screenshots/journey_cashier/cashier.spec.ts` | may **open the café** and tick opening-checklist rows; the walk-up cart does not submit |
| `screenshots/journey_admin/admin.spec.ts` | read-only (login + tab navigation) |

On 2026-08-02, seven `npm test` runs put seven phantom RM7 orders into the Sunday
figures and sent two spurious summary emails. That is why `integration.test.ts`
now needs a second, independent gate:

```bash
TEST_ADMIN_USER=... TEST_ADMIN_PIN=... RUN_LIVE_WRITE_TESTS=1 \
  npx jest tests/integration.test.ts
```

Credentials alone are not enough. Without `RUN_LIVE_WRITE_TESTS=1` the Order Flow
group skips and warns.

**Before running either category-2 suite:** state what will be created, get
explicit confirmation, and confirm the café is OPEN (the order flow needs it).

## Credentials

Never committed. Read from the environment:

`TEST_ADMIN_USER`, `TEST_ADMIN_PIN`, `TEST_CASHIER_USER`, `TEST_CASHIER_PIN`.

Suites **skip cleanly** when they are unset. A skip is not a pass — always report
which suites skipped, or a green run means nothing.

## The prefix rule

**Every record a test creates in production carries the prefix `ZZTEST_`.**

`ZZ` sorts last, so test rows collect at the bottom of any name-ordered report
instead of hiding among real customers.

The prefix and the marker values live in exactly one file:
**`scripts/test-markers.cjs`**. CommonJS on purpose, so all three runtimes share
it — ts-jest suites, Playwright specs, and the ESM `.mjs` cleanup script.

```js
const { MARKERS } = require('../../scripts/test-markers.cjs');

MARKERS.customerName             // 'ZZTEST_Customer'
MARKERS.approvedBy               // 'ZZTEST_Admin'
MARKERS.walkUpName               // 'ZZTEST_WalkUp'
MARKERS.customerRegistrationName // 'ZZTEST_Registration'
```

**Never hardcode a marker string in a suite.** Before this module existed, the
strings were duplicated as literals in `integration.test.ts` and in the cleanup
script (with a comment saying "BOTH must match"), and the Playwright customer
journey used a *third* spelling, `Demo Customer`. Cleanup matched only the first
pair, so the journey's orders were invisible to it — a real one from 2026-07-12
sat in the July figures until the prefix sweep found it.

The fields that carry the prefix are `MARKED_FIELDS` = `customerName`,
`approvedBy`. Cleanup matches **any** of them with `begins_with`, not all of them
with AND — an order created but never approved still needs cleaning up.

### Records with no name field

Customer records key on a phone number, which cannot carry a text prefix, so a
**reserved phone range** is the marker instead: `011-9900 0NN`, not issuable by
any Malaysian carrier.

```js
const { phoneFor, isTestPhone } = require('../../scripts/test-markers.cjs');
phoneFor(0)   // '0119900000'  — already in canonical normalizePhone form
```

`phoneFor()` returns the **canonical** form (digits, leading `0`, 10 digits) that
`backend/src/lib/phone.ts` produces and DynamoDB stores. `isTestPhone()`
normalises its input first, so `+60119900007` and `011-9900 007` are both
recognised. `backend/tests/test-markers.test.ts` guards all of this.

## Adding a suite that writes to production

1. Stamp every record with a value from `MARKERS` (or `phoneFor()`).
2. If a new kind of record has no marked field, add a marker to
   `scripts/test-markers.cjs` — do not invent a local string.
3. Teach `scripts/cleanup-test-data.mjs` to find and delete it.
4. Gate the suite behind an explicit opt-in env var, as
   `RUN_LIVE_WRITE_TESTS=1` does.
5. Add a row to the category-2 table above.
6. List any side effect cleanup cannot undo in the script's "NOT reversible"
   output — silent partial cleanup is worse than none.

## Cleanup — always, after any category-2 run

```bash
node scripts/cleanup-test-data.mjs                    # dry run, today
node scripts/cleanup-test-data.mjs --all              # dry run, every date
node scripts/cleanup-test-data.mjs --legacy           # also pre-prefix names
node scripts/cleanup-test-data.mjs --date 2026-08-02  # a specific date
node scripts/cleanup-test-data.mjs --apply            # delete
```

Dry run by default. It prints every match, backs everything up to
`../test-data-backup-<date>.json` (outside the repo, so it is never committed),
and refuses to proceed past a 50-record safety cap.

It removes: marked orders, customers in the reserved phone range, and
`FEATURED_AUDIT` close rows correlated to a test run by timestamp — a genuine
end-of-service close is never touched.

`--legacy` additionally matches the exact pre-prefix names `Test Customer`,
`Demo Customer`, `Test Admin`. Use it once to sweep up old records; it is not
needed for new runs.

**It cannot undo:** ingredient stock deducted at approve, food quantities reset
to 0 by a café close, `foodReserved` / `foodQuantityToday` drift (use
`scripts/reset-food-reserved.mjs`), a café left OPEN by the cashier journey
(close it in the POS), ticked checklist rows, `lastLoginAt`, or emails already
sent. The script prints this list every run — read it.

## Writing tests

- Match the existing suite's style; fixtures in `backend/tests/fixtures`.
- A discount rule change lands in `pricing.test.ts` **first** — it is the spec.
- A new endpoint needs a `router.test.ts` dispatch case plus a behaviour test.
- A new order transition needs the happy path **and** the `409` on a stale
  status.
- Cover the invariants that have bitten: `expiresAt` removed on transitions out
  of PENDING, discounts not stacking, net vs gross totals, food counters
  balancing across ready/undo.
