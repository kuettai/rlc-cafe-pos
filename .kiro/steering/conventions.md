# Conventions & Design Decisions

## Coding
- **Backend:** TypeScript, async/await, minimal error messages in responses
- **Frontend:** vanilla JS (no frameworks), ES6+, mobile-first responsive
- **CSS:** semantic class names; POS-specific styles prefixed `.pos-`
- **API responses:** `{ statusCode, headers: {}, body: JSON.stringify(...) }`
- Extract path parameters from `event.path`, **not** `event.pathParameters` —
  the proxy integration doesn't populate the latter for the internal router
- Read existing code before adding new patterns; match what's there

## Load-bearing decisions
1. **API Gateway proxy integration** — one Lambda handles every route, avoiding
   the 20KB IAM policy limit
2. **esbuild bundling** via CDK `NodejsFunction`; **no Docker** on the dev machine
3. **DynamoDB keys** — orders `PK=ORDER#{orderId}`, menu `PK=MENU#{menuItemId}`,
   `SK=META`; GSI `status-createdAt-index` for order queries
4. **Auth** — per-volunteer PIN → JWT (4h), roles CASHIER/ADMIN, forced PIN
   change on first login
5. **Polling, not WebSockets** — customer tracking polls every 7s
6. **TTL discipline** — only PENDING orders carry a numeric `expiresAt`. Writing
   one on any other status lets DynamoDB TTL silently delete live/archived
   orders. Terminal transitions must `REMOVE expiresAt`.
7. **Storage convention** — `totalAmount` is always NET (what is collected);
   `discountOffset` records the reduction; `grossAmount` is the undiscounted
   total. Aggregations across the codebase assume this.

## Single sources of truth
Do not duplicate these — they have each caused a production bug when copied:
- **Pricing / discounts:** `backend/src/lib/pricing.ts`
  (spec: `backend/tests/pricing.test.ts`; display mirror: `frontend/js/pricing.js`)
- **Variant selection UI:** `frontend/js/variants.js`
- **Phone normalisation:** `backend/src/lib/phone.ts`
- **Version numbers:** `scripts/bump-version.mjs`
- **Malaysia-time dates:** `backend/src/lib/date.ts` — `malaysiaToday()`,
  `malaysiaClock()`, `malaysiaDayStartUtc()`. Every "what day is it" decision is a
  Malaysian wall-clock decision, never a UTC one. Lambda runs in UTC, so anything
  derived from `new Date().toISOString()` or from an unqualified
  `toLocaleDateString` is 8 hours early: that is why the end-of-day emails for the
  2026-08-02 and 2026-08-09 services were headed "Saturday". `backend` tests run
  as `TZ=UTC jest` to match production — a bare `jest` on a Malaysian laptop hides
  this whole class of bug.

## Data changes
Menu/settings edits the admin UI cannot express require a script in `scripts/`.
Follow the existing pattern: default to a dry run that prints before/after, write
only with `--apply`.

`variantGroups` used to be an example of this; since v1.64.0 it is editable in
Admin → Menu → Edit (Option Groups), and pre-order links can block individual
options via `excludedOptions` since v1.67.0. Prefer the UI over a script for both.
