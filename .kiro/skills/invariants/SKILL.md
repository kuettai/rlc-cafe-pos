---
name: invariants
description: Reviewable invariants for RLC Café POS — the do-not-duplicate list, storage conventions, API response shape, path-parameter handling, and auth rules, each written as a checkable assertion with the production bug it prevents. Use when reviewing a diff, before deploying, or when adding code that touches money, order status, versions, or routing.
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

`frontend/js/pricing.js` is a **display mirror only**. It may not be the basis of
any persisted number.

## Money

- ☐ `totalAmount` is NET (collected). `grossAmount` undiscounted.
  `discountOffset = grossAmount - totalAmount`.
- ☐ New aggregation reads `totalAmount` for revenue, never `grossAmount`.
- ☐ Newcomer counts use `isNewcomerOrder()`, not `discountType === 'NEWCOMER'`.
- ☐ Discounts never stack; cheapest candidate wins (see `pricing-rules` skill).
- ☐ FOOD is never discounted.

## Order status

- ☐ Numeric `expiresAt` exists on PENDING orders only.
- ☐ Every transition out of PENDING includes `REMOVE expiresAt`. Missing it means
  DynamoDB TTL silently deletes a live or archived order.
- ☐ Walk-up orders carry no `expiresAt`.
- ☐ Pre-order `expiresAt` stays an **ISO string** — deliberately not a TTL.
- ☐ Every status flip has `ConditionExpression: '#s = :prev'` and returns `409`
  on `ConditionalCheckFailedException`.
- ☐ Food counters adjusted per the `order-lifecycle` table; no clamping to zero.

## Backend shape

- ☐ Handlers return `{ statusCode, headers, body: JSON.stringify(...) }`.
- ☐ Path params come from parsing `event.path`. API Gateway proxy integration does
  **not** populate `event.pathParameters` — the per-route dispatcher (e.g.
  `pos.ts` router at the bottom of the file) parses the path and assigns
  `event.pathParameters` before calling the handler. New route: parse in the
  dispatcher, follow the existing pattern.
- ☐ New route registered in `backend/src/index.ts` **and** covered in
  `backend/tests/router.test.ts`.
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
