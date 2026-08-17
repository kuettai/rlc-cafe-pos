---
name: invariants
description: Reviewable invariants for RLC Café POS — the do-not-duplicate list (including Malaysia-time date conversion and dead code left behind by an early return), storage conventions, who may authorise a discount (cashier-selected vs customer-requested vs system-only), the pre-order ISO expiresAt exception, create/edit parity (a restriction enforced on create must be re-enforced on edit), bulk mutating routes and collection-route dispatch, API response shape, path-parameter handling, no un-awaited work after a handler returns (Lambda freezes the sandbox) and date-keyed markers for at-most-once cron side effects, auth and release rules, and test teeth (a guard is untested unless a fixture reaches it; a test that depends on the machine timezone is not a test). Each is a checkable assertion with the production bug it prevents. Use when reviewing a diff, writing or judging tests, before deploying, or when adding code that touches money, discounts, order status, expiry, pre-orders, emails, background or scheduled work, timezones, versions, or routing.
---

# Invariants

Each item is checkable against a diff. Every one of them has already caused a
production bug in this repo. Violations are defects, not style opinions.

## Single sources of truth — do not duplicate

| Concern | The one place | Copy caused |
|---|---|---|
| Pricing / discounts | `backend/src/lib/pricing.ts` | four drifted implementations, wrong totals |
| Variant selection UI | `frontend/js/variants.js` | inconsistent variant pricing between pages |
| Phone normalisation | `backend/src/lib/phone.ts` | duplicate customer records |
| Version numbers | `scripts/bump-version.mjs` | shipped a release with 4 of 6 markers stale |
| Malaysia-time dates | `backend/src/lib/date.ts` | end-of-day emails headed "Saturday" for a Sunday service |

`lib/date.ts` (`malaysiaToday` / `malaysiaClock` / `malaysiaDayStartUtc`) is the
one place the UTC+8 conversion lives. It was extracted from `routes/staffcode.ts`
in v1.72.0 when the summary cron needed it; `staffcode.ts` re-exports it so old
imports keep working. **One copy remains outside it** —
`backend/src/routes/preorder.ts:108` still does its own
`now.getTime() + 8 * 60 * 60 * 1000`. That is a known follow-up, not a licence to
add a second.

`frontend/js/pricing.js` is a **display mirror only**. It may not be the basis of
any persisted number.

- ☐ **When a handler gains an early-return branch, the code it supersedes is
  deleted in the SAME change.** Found in v1.71 by an independent audit:
  `approveOrder` (`backend/src/routes/pos.ts`) returns early for pre-orders and
  delegates to `releasePreOrderToPreparing()`, but the money path below it still
  carried a complete pre-order branch — an `isPreOrder` flag that was always
  false, a `keepIsoExpiry` that was always false, and a detailed comment block
  re-stating the ISO-`expiresAt` preservation rule. All of it unreachable, proven
  by inserting a `throw` and watching the suite stay green.
- ☐ **A rule never survives in two copies**, comments included. In that case the
  **better-written copy was the dead one**, so the hazard was not only drift: the
  next agent to touch pre-order expiry could edit the no-op, verify by reading,
  and ship nothing. The prose belongs where the code runs; the superseded site
  gets at most a one-line pointer (see `pos.ts` immediately above the
  `repriceStoredItems` call: *"Pre-orders never reach this point … do not add a
  pre-order case here."*).

## Money

- ☐ `totalAmount` is NET (collected). `grossAmount` undiscounted.
  `discountOffset = grossAmount - totalAmount`.
- ☐ New aggregation reads `totalAmount` for revenue, never `grossAmount`.
- ☐ Newcomer counts use `isNewcomerOrder()`, not `discountType === 'NEWCOMER'`.
- ☐ Discounts never stack; cheapest candidate wins (see `pricing-rules` skill).
- ☐ FOOD is never discounted.
- ☐ **A customer-REQUESTED discount class never survives approve unless the
  cashier explicitly selected it.** Today the only requestable class is `STAFF`
  via the staff link (`staffCode` on the order). `approveOrder` must run the
  items through `revertRequestedClassPricing()` before `repriceStoredItems`
  whenever `order.staffCode` is present and the cashier did not pass
  `discountType: 'STAFF'`.

  Why it matters: `repriceStoredItems` treats the stored net as the incumbent
  candidate and only ever charges the cheaper of the two, so a self-applied RM5
  would otherwise **stick even when the cashier declined** — and, being below
  gross, come back out labelled `CELEBRATION`. That is a discount with nobody
  accountable in `approvedBy`, and it is invisible in the discount report.

  Any future customer-requested class must supply `baseUnitPrice` on each item
  (the net with no class at all, so declining does not also discard a legitimate
  celebration discount) and must log whether the request was granted — the
  APPROVE audit line carries `staffCode` and `staffPriceGranted`.
- ☐ **`parseCustomerClass()` never accepts a SYSTEM-ONLY customer class.** Its
  entire input is untrusted request bodies (`body.discountType` on approve, the
  walk-up cart). `'PREORDER'` prices every DRINK at RM0, so it is deliberately
  **not** in the accepted list — it may only be derived server-side from the
  order record's own `isPreOrder` flag (`approveOrder` /
  `releasePreOrderToPreparing` force it; `createOrder` / `modifyOrder` derive it).

  Why it matters: accepting it would let a crafted `discountType: 'PREORDER'`
  zero out any order, reported as `MINISTRY_PREORDER`, i.e. a free order with
  nobody accountable. Any future class that the server assigns rather than a
  human selects belongs in `CustomerClass` but **not** in `parseCustomerClass`.

## Order status

- ☐ **Numeric** `expiresAt` exists on PENDING orders only.
- ☐ Every transition out of PENDING includes `REMOVE expiresAt` — **except a
  pre-order release** (see the two items below). Missing it on a money order
  means DynamoDB TTL silently deletes a live or archived order.
- ☐ Walk-up orders carry no `expiresAt`.
- ☐ **A pre-order's `expiresAt` is an ISO string, and stays one.** It is the
  link's `serviceEndTime`, written by `createOrder` and now present on **PENDING**
  records (pre-orders are created PENDING since v1.71). DynamoDB TTL acts only on
  *numeric* attributes, so this value is deliberately **inert as a TTL** and is
  compared string-wise (`cutoff >= nowIso`, lexicographically valid for ISO) by
  `expirePreOrders()` in `backend/src/expiry.ts`.

  This is not a bug to tidy up. Normalising it to unix seconds arms a real TTL on
  a record that is meant to live for days — a pre-order placed Wednesday for
  Sunday would just vanish, with no error and no log. The one legitimate reaction
  to a **numeric** `expiresAt` on a pre-order is to treat it as unusable and
  overwrite/strip it, which is what `expirePreOrders()` and
  `releasePreOrderToPreparing()` do.
- ☐ **The pre-order release PRESERVES that ISO string instead of removing it.**
  `releasePreOrderToPreparing()` (`pos.ts`) appends `REMOVE expiresAt` only when
  the value is *not* a string. Safe because the string is inert as a TTL;
  necessary because `expirePreOrders()` is the **only** thing that ever expires a
  pre-order — the 1-hour PENDING sweep skips `isPreOrder`, and `closeCafe` skips
  it too. Strip it and an approved-but-never-collected pre-order sits in
  PREPARING forever with nothing able to expire it.

  `modifyOrder` must likewise not touch `expiresAt`: the order stays PENDING, so
  there is no transition to strip a TTL for, and renumbering or removing the ISO
  value there loses the only expiry input.
- ☐ Every status flip has `ConditionExpression: '#s = :prev'` and returns `409`
  on `ConditionalCheckFailedException`.
- ☐ Food counters adjusted per the `order-lifecycle` table; no clamping to zero.

## Create / edit parity

A whole class of bug, found in v1.71: **`modifyOrder` enforced none of the
restrictions `createOrder` enforces.** Pre-orders are drinks-only, limited by the
link's `eligibleItems` allowlist and by its `excludedOptions`; all three were
checked on create and none on edit, so the customer edit endpoint was a straight
bypass of all three. Because a pre-order zeroes the whole gross, that was
uncapped cost to the café — place a compliant pre-order, then edit it into food
or into an excluded paid option.

- ☐ **Every restriction enforced when a record is CREATED is re-enforced when it
  is EDITED, or the edit endpoint is the bypass.** Applies to any future rule
  (eligibility, quantity caps, per-link limits), not only these three.
- ☐ The shared rules live in ONE helper called by both paths —
  `preorderItemRejection()` in `backend/src/routes/orders.ts`. Do not copy the
  checks to a third site; the copies drift and the messages stop matching.
- ☐ The edit path re-reads the *restrictions* without re-applying the *ordering
  window*: `modifyOrder` uses `getPreorderCode()`, not `validatePreorderCode()`.
  The editable window is the order's own PENDING status, not the link's
  `opensAt`/`expiresAt` — validating the link would refuse a legitimate edit of a
  still-PENDING order after the link closed. A hard-deleted link still gets
  drinks-only enforced (fail closed).
- ☐ **An operational field is never dependent on the client re-sending it.** A
  pre-order's collection time exists ONLY inside the `notes` string as the
  `[PRE-ORDER: CODE] Collect: …` prefix — there is no `collectionTime` attribute.
  `modifyOrder` used to write `notes` verbatim from the body, making preservation
  the *client's* job: a stale cached PWA shell, a replayed request or a future
  page silently deleted the collection time, which is unrecoverable (the café has
  to ask the customer again). The backend now owns it — it strips whatever prefix
  the client sent and re-prepends the **stored** one
  (`splitPreorderNotes` / `preorderNotesPrefix` / `composePreorderNotes`), which
  also stops a client forging a different code or time.
- ☐ A length budget on a composed field measures the **customer's** portion only.
  `createOrder` lets the composed `notes` exceed 200 chars because the prefix is
  the café's text; `modifyOrder` therefore validates
  `splitPreorderNotes(body.notes).rest`, or an edit would reject notes that
  create accepted.

## Backend shape

- ☐ Handlers return `{ statusCode, headers, body: JSON.stringify(...) }`.
- ☐ Path params come from parsing `event.path`. API Gateway proxy integration does
  **not** populate `event.pathParameters` — the per-route dispatcher (e.g.
  `pos.ts` router at the bottom of the file) parses the path and assigns
  `event.pathParameters` before calling the handler. New route: parse in the
  dispatcher, follow the existing pattern.
- ☐ New route registered in `backend/src/index.ts` **and** covered in
  `backend/tests/router.test.ts`.
- ☐ **A COLLECTION-level POS route does not live inside the
  `/api/pos/orders/{id}/{verb}` family.** Those branches pair
  `path.endsWith('/verb')` with **unanchored** regexes, so a collection path
  under `/api/pos/orders/` is safe only by accident — it survives merely by not
  ending in one of today's verbs, and breaks silently when someone adds the next
  one. The bulk release is therefore `PUT /api/pos/preorders/release-all`,
  dispatched by **exact match** (`path === …`), where nothing can capture it and
  it cannot shadow a per-id route. It takes no path parameter, so it assigns
  nothing to `event.pathParameters`.
- ☐ **A BULK mutating route carries its own safety filters and paginates.**
  `releaseAllPreOrders()` (`pos.ts`) is the model:
  - `isPreOrder === true` — it walks **every PENDING order**, and the PENDING
    bucket is full of ordinary UNPAID customer orders awaiting the cashier's
    payment check. Lose that filter and the route mass-approves them: unpaid
    orders marked paid and sent to the barista.
  - service-end date is **today in MYT** — a link can stay open across services,
    so PENDING can hold orders for a later date; releasing those closes the edit
    window for customers who ordered for next week. An order with no usable
    `expiresAt` is skipped and logged, never guessed at.
  - **paginate on `LastEvaluatedKey`.** A single Query returns at most 1MB, and
    silent truncation in a *mutating* batch tells the cashier "released 40" — so
    they reasonably believe the queue is empty — while real orders stay stranded
    in PENDING.
  - per-order `ConditionalCheckFailedException` counts as *skipped*, never fails
    the batch, and `released + skipped === total` holds.
- ☐ A per-order action and its bulk equivalent share **one** helper, so they
  cannot diverge on the guard, the pricing, the audit line, the push or the
  ingredient deduction (`releasePreOrderToPreparing()` is called by both
  `approveOrder` and `releaseAllPreOrders`).
- ☐ **No un-awaited work outlives a request handler.** A promise started but not
  awaited before the handler returns is not "background work" on Lambda — the
  execution environment is FROZEN the instant the response goes out, and the
  promise only advances if that same sandbox happens to be thawed by a later
  request. It may never resume, and the sandbox is eventually reaped mid-flight.
  `closeCafe` ended with `sendDailySummaryEmail().catch(() => {})` and so the
  Sunday revenue email was a coin flip on traffic: it landed on 2026-08-02 (+50s)
  and 2026-08-09 (+4m39s), both completing against a *later* request id than the
  close, and on the quiet 2026-08-16 the sandbox was reaped 0.78s after the close
  and no email was ever sent. The `.catch(() => {})` meant there was no log line
  either, so it went unnoticed for a week.
  Either **await it** — and justify the latency against the 10s API timeout — or
  hand it to the EventBridge cron (`expiry.ts`), which is what the summary now
  does. A fire-and-forget `.catch(() => {})` on the request path is a defect.
- ☐ **An at-most-once side effect owned by a repeating cron is guarded by a
  date-keyed marker record written ONLY after a confirmed success**
  (`DAILY_SUMMARY#{date}`, `LOW_STOCK_ALERT#{date}`, both `SK=META` in the
  settings table). Writing the marker before or regardless of the outcome
  restores the lost-email failure mode with no retry; the absence of the record is
  what makes the next run try again. The send's return value must be checked — the
  old caller discarded `sendEndOfDaySummary`'s boolean.
- ☐ Error responses stay minimal — no internal detail, no stack traces.
- ☐ CORS headers merged from the router, not re-declared per route.

## Auth

- ☐ Role checked (`CASHIER` / `ADMIN`) before any mutating POS or admin action.
- ☐ JWT 4h expiry; PIN change forced on first login.
- ☐ No credentials, PINs, secrets or tokens in source, tests, docs or
  screenshots. Tests read `TEST_ADMIN_USER` / `TEST_ADMIN_PIN` /
  `TEST_CASHIER_USER` / `TEST_CASHIER_PIN` from the environment and skip cleanly
  when unset. (Live PINs were once committed across seven files.)
- ☐ Mutating actions write an audit entry (`backend/src/lib/audit.ts`).

## Frontend

- ☐ No framework, no build step for `frontend/`. Vanilla ES6+, mobile-first.
- ☐ New `frontend/js/*.js` or `frontend/css/*.css` file is added to the `SHELL`
  array in `frontend/sw.js`, or it is never precached. `npm run version:check`
  enforces this; `reports.js` and `reports.html` went unprecached for months.
- ☐ POS-specific CSS prefixed `.pos-`.

## Release

- ☐ All six version markers agree (`sw.js` `CACHE_NAME`, `.app-version` in
  index/pos/admin/reports, top entry of `changelog.json`). Bump via
  `npm run version:bump`, verify with `npm run version:check`.
- ☐ User-visible change has a `changelog.json` entry.
- ☐ Backend touched → `cd backend && npx tsc && npm test` passes.
- ☐ Session notes written to `docs/update-YYYYMMDD.md`.

## Test teeth

**A green suite is not evidence.** Every item here was found by mutating the
source and watching the tests stay green; none of it is visible from a passing
run, which is exactly why it belongs on a reviewable list — this class of hole is
caught by reading a diff, or not at all.

- ☐ **A skip/continue guard inside a loop over query results is untested unless a
  fixture returns a row that REACHES it.** Assert on the resulting **write** — or
  on the absence of that write — never merely on the absence of an error.

  Why it matters: `if (order.isPreOrder === true) continue;` in the 1-hour PENDING
  sweep (`backend/src/expiry.ts`) could be deleted with all 254 tests then in the
  repo still passing. No fixture had ever put a row in front of that particular
  query — every suite staged `{ Items: [] }` for it, so every assertion about the
  sweep's *behaviour* was vacuous, and a neighbouring test appeared to cover it
  while actually staging into a different query in the same handler. It is the
  single most consequential line in the pre-order feature: without it the cron
  EXPIREs every pre-order within an hour of creation, and the `REMOVE expiresAt`
  on the way out destroys the ISO service-end time too — the whole feature dies
  silently, on a schedule, days before anyone would notice. Now covered by
  `backend/tests/preorder-pending-gaps.test.ts`.
- ☐ **A multi-query handler needs each query's fixture staged distinctly.** The
  expiry cron issues four queries (the 1-hour PENDING sweep, the per-status
  pre-order sweep, the READY auto-archive, the ingredient scan), so a queued mock
  `docClient.send` lets a test pass by filling the wrong slot. Stage by call order
  deliberately, and assert which query each fixture answered.
- ☐ **A test that constructs an object and then asserts on that same object
  cannot fail.** Assert on what the code under test produced: the
  `UpdateExpression` it built, the item it wrote, the response body it returned.
- ☐ **A fixture so sparse that removing the guard yields the same outcome for an
  unrelated reason is a test without teeth.** If the row would have been skipped
  anyway — wrong status, missing field, empty `items` — the guard is not what the
  test is pinning. Instances of both this and the previous item were found in the
  v1.71 suites.
- ☐ **A test whose result depends on the machine's timezone is not a test.**
  `npm test` is `TZ=UTC jest` (`backend/package.json`) because Lambda runs in UTC
  while the dev machines are in `Asia/Kuala_Lumpur`. The date test for the
  end-of-day email passed against the *broken* code for exactly that reason: with
  no `timeZone` option, `toLocaleDateString` rendered in the ambient zone, which
  locally is MYT and looked right — so the assertion could not see the production
  bug it was supposed to guard.

  Two traps: setting `process.env.TZ` in `setupFiles` does **not** work, because
  Node resolves and caches the process timezone before that code runs — it has to
  come from the environment before the process starts, hence the `package.json`
  script rather than a jest config. And running a bare `npx jest` bypasses the
  pin entirely; `tests/setup.ts` warns when the resolved zone is not UTC. Anything
  genuinely timezone-sensitive converts explicitly via `lib/date.ts` instead of
  relying on the ambient zone.

## Test data

- ☐ Every record a test writes to production carries the `ZZTEST_` prefix, taken
  from `scripts/test-markers.cjs` — never a hardcoded literal. Duplicated
  literals plus a third spelling (`Demo Customer`) made the Playwright journey's
  orders invisible to cleanup; one sat in the July figures for weeks.
- ☐ Records with no name field (customers) use the reserved phone range via
  `phoneFor()`, not an ad-hoc number.
- ☐ A suite that writes to production is gated behind its own opt-in env var
  (`RUN_LIVE_WRITE_TESTS=1`); credentials alone are never sufficient.
- ☐ `scripts/cleanup-test-data.mjs` can find and delete every record type a suite
  creates, and lists what it cannot undo.

## Data scripts

- ☐ Script in `scripts/` defaults to a **dry run** printing before/after, and
  writes only with `--apply`.
- ☐ Region `ap-southeast-5`, account `956288449190`.
