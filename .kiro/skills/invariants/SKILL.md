---
name: invariants
description: Reviewable invariants for RLC Café POS — the do-not-duplicate list (including Malaysia-time date conversion and dead code left behind by an early return), storage conventions, who may authorise a discount (cashier-selected vs customer-requested vs system-only), the pre-order ISO expiresAt exception, create/edit parity (a restriction enforced on create must be re-enforced on edit), bulk mutating routes and collection-route dispatch, API response shape, path-parameter handling, no un-awaited work after a handler returns (Lambda freezes the sandbox) and date-keyed markers for at-most-once cron side effects, no silently-skipped feature when its config is missing (config in SSM, never a wipeable Lambda env default), auth and release rules, frontend HTML escaping (a customer-controlled string is escaped at every innerHTML render site, not just the newest one — and a textContent sink must not be escaped; a partial escaper that covers only some of the five characters is more dangerous than a missing one, so audit escaper bodies and not call sites; `escapeHtml`/`escapeAttr` in `admin.js` are canonical for the whole admin bundle, `mfEsc` is gone, and `variants.js` keeps a module-private escaper because it loads on three pages whose bundles name theirs differently), frontend state and motion rules (a failure state must not render identically to an empty success state, two distinct persisted flags must not share one visual language, a `[disabled]` control must look disabled, animate transform/opacity and never a layout property), user-visible copy rules (copy asserting a domain fact is gated on the state that makes it true; the house payment fact — payment is QR-ONLY, no cash and no card, and the DuitNow QR is physical and printed on the café tables, so no surface may say "pay at the counter"; a pending feature is deleted rather than commented out, placeholder assets and READMEs included), Malaysia-time dates on the admin frontend via `mytToday()`, and test teeth (a guard is untested unless a fixture reaches it; a test that depends on the machine timezone is not a test). Each is a checkable assertion with the production bug it prevents. Use when reviewing a diff, writing or judging tests, before deploying, or when adding code that touches money, discounts, order status, expiry, pre-orders, collection times, item notes, emails, background or scheduled work, timezones, versions, routing, customer-facing payment copy, or the rendering of customer-supplied text into the DOM.
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
| Malaysia-time dates (backend) | `backend/src/lib/date.ts` | end-of-day emails headed "Saturday" for a Sunday service |
| Malaysia-time dates (admin frontend) | `mytToday()` in `frontend/js/admin.js` | eight `toISOString()` sites: before 08:00 MYT the admin showed the previous day, and `admin-preorder.js` could stamp `serviceDate` as Saturday |
| Runtime config (`/rlc-cafe/` SSM) | `backend/src/lib/ssm-config.ts` | two separate readers of the same prefix, each with its own unpaginated fetch: web push died in production, the end-of-day email was three parameters from the same fate |

`lib/date.ts` (`malaysiaToday` / `malaysiaClock` / `malaysiaDayStartUtc`) is the
one place the UTC+8 conversion lives. It was extracted from `routes/staffcode.ts`
in v1.72.0 when the summary cron needed it; `staffcode.ts` re-exports it so old
imports keep working. **One copy remains outside it** —
`backend/src/routes/preorder.ts:108` still does its own
`now.getTime() + 8 * 60 * 60 * 1000`. That is a known follow-up, not a licence to
add a second.

`mytToday()` (`frontend/js/admin.js:109`) is the frontend counterpart, added in
v1.75.0 with `isoAddDays` / `isoDayOfWeek` / `mytDayLabel` beside it: **`mytToday()`
decides what day it is, then plain UTC arithmetic operates on that `YYYY-MM-DD`
string.** Never mix the two — the original `computePastSundays` bug was reading the
**local** day-of-week and then serialising through **UTC**, so it disagreed with
itself. No `admin*.js` file may derive "today" from `new Date().toISOString()`
again. The `toISOString()` calls that remain (`admin-ingredients.js:400`,
`admin-vouchers.js:139`, `admin-preorder.js:33`, `:391-392`) are all either
operating on a date the user picked or producing an **instant** for comparison
against other ISO instants — neither of which is a "what day is it" decision. That
is the line to check when reviewing a new one.

`frontend/js/pricing.js` is a **display mirror only**. It may not be the basis of
any persisted number.

**One accepted exception:** the HTML escapers are per-page-bundle
(`escapeHtmlPos`, `escHtml`, `prep.html`'s inline `esc()`, `escapeHtml` /
`escapeAttr` in `admin.js` for the whole `admin*.js` bundle, and — 5th, added in
v1.76.0 — a module-private `esc()` in `variants.js`) because there is no
shared frontend util module and adding one costs a new `SHELL` entry plus a script
tag on every page. See **Frontend** below for the rules that make the duplication
survivable.

**Why `variants.js` gets its own, and why consolidating it reintroduces a bug:**
`variants.js` is itself a single source of truth (row 2 of the table above) and is
loaded by **`index.html`, `track.html` AND `pos.html`**. Those three bundles do not
agree on a name — they define `escHtml`, `escHtml` and `escapeHtmlPos`
respectively. So there is no sibling global `variants.js` can call that exists on
all three pages: reaching for `escHtml` emits **raw HTML on `pos.html`**, and
reaching for `escapeHtmlPos` emits raw HTML on the two customer pages. A
module-private escaper is the only option that is correct on every page that loads
the file, and variant markup is built in exactly one function, so its escaping
still lives in exactly one place. **Do not "consolidate" it into a page bundle.**

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
  Two more helpers now follow the same pattern in that file:
  **`validateItemNote()`** (the 80-char per-item note cap, identical messages on
  both paths) and **`resolveCollectionTime()`** (the allowed-list check for a
  pre-order's collection time). The latter shows the parity rule can bite in the
  **other** direction: `createOrder` had accepted an arbitrary `collectionTime`
  string, so hardening only the edit path would have been pointless — a crafted
  *create* would just set the arbitrary value up front. When adding a restriction
  to an edit path, check whether the create path ever had one.
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

  **Backend-owned does not have to mean immutable.** The collection time is now
  deliberately customer-changeable on edit, and the distinction is what keeps the
  invariant intact: the **code** still comes only from the stored order record,
  and the **time** only from a value the link itself offers
  (`resolveCollectionTime` against `collectionOptions`, defaults as a fail-closed
  fallback when the link was hard-deleted) — never from free text in the body. A
  validated time replaces the stored one and may create a prefix that did not
  exist. Preserving an operational field is the server's job; *choosing* among a
  server-defined set of values may still be the customer's.

  One consequence worth stating, because it is easy to get wrong: once a field
  lives inside a composed string, the clause that writes that string must be
  emitted whenever **either** part changes. `modifyOrder` emitted `notes = :n`
  only for `body.notes !== undefined`, so a request changing nothing but the time
  would have written nothing at all.
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
- ☐ **A FEATURE DISABLED BY MISSING CONFIG LOGS, LOUDLY, EVERY TIME IT IS
  SKIPPED.** `if (!KEY) return; // not configured, skip silently` is a defect, not
  defensive coding: a value that goes missing then looks identical to a feature
  that was deliberately turned off, and nobody finds out. Two separate features
  died this way for weeks each — the end-of-day email (`.catch(() => {})`, above)
  and web push, whose `lib/push.ts` carried literally
  `if (!VAPID_PUBLIC || !VAPID_PRIVATE) return; // VAPID not configured, skip silently`
  while the Lambda's `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` sat at empty
  strings. `GET /api/push/vapid-public-key` returned `500` the whole time, and the
  customer-visible shape was the worst kind: `track.js` asked for notification
  permission, the customer GRANTED it, and then received nothing, forever.

  The log line must name **which** values are missing and **where** they were
  looked for, or it is undiagnosable from CloudWatch. Keep the *response* minimal
  (`{ error: 'VAPID not configured' }`); the detail goes to the log.
- ☐ **Runtime config that can be silently emptied by a deploy does not belong in
  the Lambda environment.** The VAPID keys were env vars that
  `infra/lib/infra-stack.ts` defaulted to `''`, so any `cdk deploy` from a shell
  that had not exported them wiped the live keys — which is how they were lost.
  Runtime config lives in SSM under `/rlc-cafe/`, read through
  `backend/src/lib/ssm-config.ts` (one cached, paginated fetch of the whole
  prefix), because nothing in the deploy path can wipe a parameter. A secret that
  must stay an env var is guarded by `requireSecret()` so synth FAILS rather than
  defaulting — never by a placeholder literal, which in a public repo is a
  published secret the moment the feature is switched on.
- ☐ **A partial config is treated as no config.** `GET /api/push/vapid-public-key`
  goes through `ensureVapidConfigured()` and only answers once web-push has
  accepted the whole triple. Serving a public key with no working private
  counterpart lets the browser subscribe successfully and be undeliverable
  forever — worse than an honest 500, because it burns the one permission prompt
  the customer will ever grant.
- ☐ **A paged AWS list call is paginated, even when today's count is under the
  page size.** `GetParametersByPath` returns 10 per call and `/rlc-cafe/` already
  holds 7; a truncated read is indistinguishable from "never configured", i.e.
  it re-arms the exact bug above.
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
- ☐ **A failure state must not render identically to an empty success state.**
  Found in v1.75.0 on the POS board: `renderBoard()` sat inside the `try`, the
  `catch` only toasted, and the toast auto-hid after 3s against a 7s poll — so a
  dropped connection showed **an empty queue under a green OPEN badge**, visually
  identical to a quiet morning, with a warning present ≈43% of the time. A cashier
  cannot act on data they believe is fresh and isn't. The fix pattern: keep the
  last-known data on screen, say **how old it is**, offer a retry, and make
  mutating controls inert — a transient toast is not a system-status indicator.
- ☐ **Two distinct persisted flags must not share one visual language.** Found in
  v1.75.0 on the admin Menu tab: the row switch wrote `isActive` (permanent
  catalogue), the bulk buttons wrote `isEnabledToday` (today only), and every
  badge, count and filter drew `isActive` alone. "Disable All" therefore produced
  **no visible change and no toast**, and a filter reading "Enabled Only (32)" was
  read by the operator as "32 serving today". If a screen can write two flags, both
  are **named** and **drawn** wherever either is editable, and every count says
  which one it is counting.
- ☐ **A `[disabled]` control must look disabled.** The POS had exactly one
  `[disabled]` rule (`.pos-btn-preorder-release`), so every other disabled primary
  rendered as a full brown gradient with `cursor:pointer` — indistinguishable from
  enabled, and tapped repeatedly. Style `:disabled` generically, not per button.
- ☐ **Copy that asserts a domain fact is gated on the state that makes it true.**
  A payment instruction rendered unconditionally is a false statement in every
  state that does not require payment. Found in v1.75.1: `app.js` rendered
  `🏪 Pay at the counter after ordering` in the cart footer with **no
  `preorderMode` check**, so a ministry volunteer on an RM 0 `MINISTRY_PREORDER`
  was told to go and pay — on the screen where they commit to the order. Same
  shape as the failure-vs-empty-success rule above: the render site knew nothing
  about the state it was describing. When adding a line that states a fact, ask
  which states it is false in, and branch.
- ☐ **The house payment fact: QR only — no cash, no card — and the DuitNow QR is
  PHYSICAL, printed on the café tables.** The app has never rendered a QR of its
  own. So no surface may say "pay at the counter" or "cash": there is no till
  transaction to perform, and a first-time congregant cannot guess that a tabletop
  QR exists unless the copy says so. What the counter *is* for is **proving**
  payment — one method, two peer proofs (upload the screenshot, or show the
  payment to the cashier). Collection copy (`Collect your order at the counter`)
  is about collection, not payment, and is correct. Why it matters: v1.75.1 had to
  correct this in **three** shipped places at once — `track.js`, the `app.js` cart
  footer, and a user-visible POS tag reading `🚶 walk-up · cash at counter` — plus
  two docs that instructed the next person to reinstate it.
- ☐ **A pending or disabled feature is deleted, not commented out — and its
  placeholder assets and READMEs go with it.** A commented-out block is a claim
  that outlives its accuracy and nobody re-reads it. Found in v1.75.1: a 15-line
  commented-out in-app QR block in `track.js` held a placeholder image and dummy
  account numbers behind a "re-enable once real payment details are in place"
  note — for a feature that must **never** exist — while `frontend/img/README.md`
  independently told the next person to *"Place `qr-payment.png` here"*, and
  `frontend/img/qr-payment.svg` sat in the tree never rendered by anything (and
  never in the `SHELL` array, so not even precached). Three separate invitations
  to build the wrong thing. Delete the code; record the decision in the session
  notes and, if it is a rule, here.
- ☐ **Animate `transform` / `opacity`, never a layout property.** `width`,
  `margin-left` and friends relayout every frame and jank on the counter iPad. The
  v1.75.0 checklist progress bar scales an always-full-width fill via
  `transform:scaleX(var(--cl-progress))` from a left origin rather than animating
  `width`, and pairs it with a `prefers-reduced-motion:reduce` escape. Two known
  offenders remain — `.admin-main` and `.pos-main` both transition `margin-left`
  (follow-up (a)).
- ☐ **A customer-controlled string interpolated into `innerHTML` is escaped at
  EVERY render site, not just the newest one.** Escaping is a property of the
  *site*, not of the field: the same field being escaped somewhere else in the
  file is not coverage, and "this page has an escaper" is not coverage either.
  When adding a render site for a field, grep every existing interpolation of
  that field on that page and fix the whole set.

  Why it matters: found live in v1.73 while adding the per-item note render
  sites. **`frontend/prep.html` escaped nothing at all** — `${i.name}`,
  `${i.variant}`, `${o.customerName}` and `${o.notes}` went raw into
  `innerHTML`, and the order-level `notes` is **customer-typed free text**, so
  that was an open injection path onto the barista's screen. `frontend/js/pos.js`
  had the same raw `customerName`, `items[].name`, `items[].variant` and `notes`
  on the queue card, in the order detail and in the in-POS prep view — while
  **already escaping `customerName` correctly in its own v1.71 dialogs**
  (`askStaffPrice`, `confirmReleaseNotToday`) and not on the card behind them.
  The newer code got it right; the v1.0 hot path was never revisited. This is
  privilege-bearing, not cosmetic: the POS session holds a **CASHIER JWT in
  `sessionStorage`**, so script injected there runs with till privileges.

  Escape all five of `& < > " '`, so the same helper is safe inside a quoted
  attribute as well as in text. `escapeHtmlPos` (`pos.js`), `escHtml`
  (`app.js`, `track.js`), the inline `esc()` in `prep.html` and the module-private
  `esc()` in `variants.js` all do.
- ☐ **A page having a complete escaper does NOT mean the page is escaped, and a
  local `esc(...)` call is not evidence of anything.** Corrects an earlier version
  of this skill, which listed `escHtml` in `app.js` / `track.js` as five-character
  complete — true of those two helpers, and it read as "the customer pages are
  done." They were not. v1.76.0 found the customer pages carried **four additional
  inline escapers that were incomplete**: in `app.js`, `esc` at `:226` and `:251`
  handling only `[<>&]`, `escAttr` at `:275` handling only `"`, and `escText` at
  `:276` handling only `[<>&]`. `variants.js` had **eleven** entirely unescaped
  sites. The `escAttr` one guarded a **quoted attribute** — precisely where an
  unescaped `'` or `&` is what breaks out.

  Why it matters: **a partial escaper is more dangerous than a missing one.** A
  reviewer greps for `esc(`, sees a call at the render site, and moves on; there is
  no absence to notice. Audit the *body* of every escaper on the page, not the
  call sites, and delete function-local escapers rather than completing them —
  a second correct copy is the next drift. The load-bearing field here was
  `customerProfile.name`, from `GET /api/customers/{phone}`
  (`backend/src/routes/customers.ts:188`): **stored and cross-user**, so one
  person's name renders inside another person's page.
- ☐ **A `textContent` sink must NOT be escaped** — the counterpart rule, and the
  one that stops the item above turning into over-correction. `textContent`
  assigns a text node, so it is already safe; escaping first makes the cashier
  read a literal `&quot;`. `showCancelToast` and `showNameFlash` in `pos.js` both
  build their string from a raw `customerName` and assign `textContent`, and are
  **correct as they stand** — a report flagging them was a false positive.
  Judge the sink, not the field.
- ☐ **The escapers are per-page-bundle by necessity.** `app.js`, `track.js`,
  `pos.js` and `prep.html` each carry their own (`prep.html` inline, because its
  script is self-contained and it loads only `js/config.js`), and `variants.js`
  carries a module-private one because it loads on three pages that name theirs
  differently — see the do-not-duplicate section above for why that one must not be
  folded into a bundle. **The whole
  `admin*.js` bundle shares one canonical pair — `escapeHtml` / `escapeAttr` in
  `admin.js` (`:79`, `:86`), canonical since v1.74.0.** `mfEsc()` no longer
  exists: it lived in `admin-menu.js` only to work around script ordering, and the
  three byte-identical admin copies were consolidated when follow-up (e) was
  addressed. Do not reintroduce a local admin escaper — add the call, not a copy.
  There is no shared *cross-page* util module, and adding one is not free: it
  means a **new file in the `sw.js` `SHELL` array** plus a `<script>` tag on every
  page. So the remaining per-bundle escapers are an accepted exception to the
  do-not-duplicate list above — but each copy must cover all five characters, and
  each page's sites must all use it.

  **Still true, and it undercuts the consolidation:** `reports.js` defines its own
  `escapeHtml` and loads at `admin.html:45`, *after* every admin module, so on the
  admin page its global shadows the canonical one for every later caller. Harmless
  only while the two implementations stay identical. Follow-up (s) in
  `docs/update-20260817.md`.

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
