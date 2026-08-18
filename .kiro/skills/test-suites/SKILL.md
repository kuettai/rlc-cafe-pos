---
name: test-suites
description: How to run the RLC Café POS test suites safely — which are offline and which write to the live production café, why it must be `npm test` (`TZ=UTC jest`) and never a bare `npx jest`, the ZZTEST_ prefix every test-created record must carry, the reserved test phone range, the Sunday-afternoon end-of-day-email hazard, why a Playwright `page.route()` block does NOT stop writes (service workers bypass it — this already took a menu item off the live customer menu) and the `serviceWorkers:'block'` + positive-control harness rule, and the cleanup procedure afterwards. Use before running any test, adding a suite that writes data, driving any frontend page in a real browser against the live API, or cleaning up after a live run.
---

# Test Suites

Two categories, and the difference matters more than anything else here: some
suites are pure and offline, and some **write to the live production café** that
real volunteers use on Sunday mornings. There is no staging environment.

> ## ⛔ Read this before driving any page in a real browser
>
> **A Playwright `page.route()` block does NOT stop this app from writing to
> production.** `page.route()` does not intercept requests issued by a **service
> worker**, and **every page here registers one** (`frontend/sw.js`, whose `fetch`
> handler passes `/api/` straight through). So a harness that "blocks all non-GET"
> can report zero blocked requests and still have let every `PUT` reach the live
> table.
>
> **This has already happened.** On 2026-08-18, during a verification probe of the
> admin Menu tab, a harness believed to be read-only flipped `latte-001`
> (☕ Latte) to `isActive:false` — **taking Latte off the live customer menu**. It
> was restored to `isActive:true, isEnabledToday:false` and verified. The tell was
> a **positive control that read 0 allowed requests**: a route handler that has
> intercepted nothing is not a route handler that blocked everything, it is a
> route handler that was never consulted.
>
> The harness rule, both halves required:
>
> ```js
> const ctx = await browser.newContext({ serviceWorkers: 'block' });
> // …then a POSITIVE CONTROL that must FAIL LOUDLY:
> let seen = 0;
> await ctx.route('**/api/**', r => { seen++; return r.continue(); });
> // after navigating and doing anything at all:
> if (seen === 0) throw new Error('interception never fired — assume writes escaped');
> ```
>
> `serviceWorkers: 'block'` is a **context** option; it cannot be set per page,
> and setting it after the page exists is too late.
>
> **Corollary — an earlier read-only claim is unreliable for the same reason.**
> The admin UX audit that preceded this, and the `journey_admin` "read-only" row
> below, were both asserted with the same defective mechanism. Treat them as
> unproven, not as evidence that a browser probe of the admin is safe.
>
> A frontend probe against the live API is a **category-2 activity**: say what it
> may write, get explicit confirmation, and check afterwards.

## Category 1 — safe, offline, run freely

```bash
cd backend && npx tsc                                          # typecheck
cd backend && npm test                                         # all suites (integration self-skips)
cd backend && TZ=UTC npx jest --testPathIgnorePatterns integration   # unit suites only
npm run version:check                                          # six markers + SHELL
```

**Always `npm test`, never a bare `npx jest`.** `npm test` is `TZ=UTC jest`, and
the `TZ` is load-bearing: Lambda runs in UTC, the dev machines are in
`Asia/Kuala_Lumpur`, and the end-of-day email's date test passed against **broken
code** because the ambient MYT zone made the wrong output look right. If you must
invoke `jest` directly, pass `TZ=UTC` yourself. Setting `process.env.TZ` inside
`tests/setup.ts` does not work — Node caches the zone before `setupFiles` runs —
so `setup.ts` only prints a warning when the resolved zone is not UTC. Watch for
it.

| Suite | Covers |
|---|---|
| `pricing.test.ts` | the discount **specification** — read it as documentation |
| `orders.test.ts` | order creation and transitions |
| `expiry.test.ts` | the EventBridge cron |
| `router.test.ts` | path dispatch |
| `auth.test.ts`, `login-blocklist.test.ts` | JWT, PIN, login blocking |
| `phone.test.ts` | phone normalisation |
| `planogram.test.ts` | planogram routes |
| `daily-summary.test.ts` | `summarizeDailyRevenue` — the end-of-day figures |
| `daily-summary-cron.test.ts` | `sendDailySummary` in the cron — the Sunday/2pm-MYT/`CLOSED` gates, the `DAILY_SUMMARY#{date}` exactly-once marker, that a failure leaves no marker so the next run retries, and that `closeCafe` no longer sends |
| `email-date.test.ts` | that the summary subject renders the **Malaysian** service date; emulates the runtime zone itself so it passes or fails identically anywhere |
| `preorder-excluded-options.test.ts` | `optionKey` / `normalizeExcludedOptions`, and `createOrder` refusing an excluded pre-order option |
| `staff-code.test.ts` | the staff link — code validation/date gate, and that a requested STAFF price reverts on approve unless the cashier confirms |
| `preorder-pending.test.ts` | ministry pre-orders as PENDING — free release (single and bulk), the preserved ISO `expiresAt`, the create/edit restriction parity, the backend-owned notes prefix, `closeCafe` skipping pre-orders, and the `expirePreOrders` recovery path |
| `preorder-pending-gaps.test.ts` | the coverage holes a mutation audit found in the suite above — the 1-hour PENDING sweep **skipping** pre-orders (previously staged with an empty result, so untested), the `409` on a stale status for the single-order release, `getOrder`'s five pre-order response fields, and the admin daily-report pre-order bucket in both directions (its only prior coverage was the live integration suite) |
| `push-vapid.test.ts` | web push VAPID config — read from SSM (`/rlc-cafe/VAPID_*`) and cached, paginated, env fallback, and above all that a **missing or malformed config LOGS instead of returning silently**; plus the `vapid-public-key` route, including its refusal to serve a public key whose private counterpart is missing. SSM, DynamoDB and `web-push` are all mocked — nothing is sent, nothing is read for real |
| `item-notes.test.ts` | per-item special requests — `validateItemNote` / `ITEM_NOTE_MAX_LENGTH` (80 chars **measured trimmed**), the create/edit parity of the cap and its two 400 messages, and that `note` is persisted **only when non-empty** so a note-free order's items stay byte-identical to the pre-feature shape. Also that a rejected note returns before any write, so `foodReserved` is never left moved. 31 tests |
| `preorder-collection-time.test.ts` | editable pre-order collection times — `resolveCollectionTime` against the link's `collectionOptions` (and the `DEFAULT_COLLECTION_OPTIONS` fallback, including the hard-deleted-link fail-closed case), `parsePreorderCollectionTime`, `createOrder` now validating the field it used to accept as free text, `modifyOrder` rebuilding the prefix with the code taken from the **stored record** rather than the body, the `notes = :n` clause being emitted for a time-only change, a validated time **creating** a prefix that did not exist, `getOrder`'s two pre-order-only response fields, and that `expiresAt` is still untouched. 70 tests |
| `test-markers.test.ts` | the test-data marker contract (below) |

These mock DynamoDB. They touch nothing real.

`item-notes.test.ts` and `preorder-collection-time.test.ts` are fully mocked and
offline: both `jest.mock('../src/lib/db', …)`, which is the **only** DynamoDB
client in the backend, plus `../src/routes/customers`. They make no network call,
need **no credentials**, write **nothing** to production, and therefore need **no
`ZZTEST_` marker** — the prefix rule below applies only to suites that create real
records. Verified rather than assumed.

## Category 2 — writes to PRODUCTION, ask first

| Suite | What it writes |
|---|---|
| `backend/tests/integration.test.ts` "Order Flow" | opens the café, creates a real order, approves it (deducts ingredient stock), marks it ready, closes the café (expires PENDING orders and archives the rest) |
| `screenshots/journey_customer/customer.spec.ts` | submits a real customer order, then cancels it (leaving a CANCELLED record) |
| `screenshots/journey_cashier/cashier.spec.ts` | may **open the café** and tick opening-checklist rows; the walk-up cart does not submit |
| `screenshots/journey_admin/admin.spec.ts` | login + tab navigation. **"Read-only" is a claim, not a verified fact** — it was asserted with a `page.route()` harness, which the box above shows does not see service-worker traffic. Re-establish it under `serviceWorkers:'block'` before relying on it |
| **any ad-hoc browser probe of a frontend page against the live API** | whatever the page's own JS decides to send. See the box above |

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

### The summary email risk moved, it did not go away

Since v1.72.0 the café close no longer sends the end-of-day email itself — the
expiry cron does. So an Order Flow run **on a Sunday after 2pm MYT** leaves
`cafeStatus = CLOSED`, and the next cron run (within 30 min, up to 09:00 UTC) will
email a real summary that includes the test order, then write the
`DAILY_SUMMARY#{date}` marker. Worse than the old behaviour in one way: it also
**burns that date's single send**, so the genuine service summary is then
suppressed as already-sent. `scripts/cleanup-test-data.mjs` cannot recall an email.

Practical rule: do not run a category-2 suite on a Sunday afternoon. If it
happens, delete the `DAILY_SUMMARY#{date}` / `SK=META` record from the settings
table before the real close so the true summary can still go out.

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
- A Playwright spec or ad-hoc browser harness creates its context with
  `serviceWorkers: 'block'` **and** carries a positive control that throws when
  interception never fired — see the box at the top of this file. A harness whose
  block is unverified is a harness that writes to production.
- A guard is only tested if a fixture **reaches** it, and a multi-query handler
  needs each query's fixture staged distinctly — see **Test teeth** in the
  `invariants` skill. A suite that stages `{ Items: [] }` for the query a guard
  sits on passes whether the guard is there or not.
