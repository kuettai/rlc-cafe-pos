---
name: api-reference
description: Complete HTTP endpoint reference for the RLC Café POS API — public, display, POS (CASHIER/ADMIN) and ADMIN routes, with paths and auth requirements, including the passkey/WebAuthn login and enrolment routes (`/api/auth/passkey/*`, `/api/admin/passkeys`), the full `GET /api/cafe/status` payload (café status, celebration mode, featured drink, opening hours and the derived opening state) and which `PUT /api/admin/settings` keys are validated, plus the display-slide create/edit routes and their shared `YYYY-MM-DD` date validation. Use when adding, calling, or debugging an API route, or when asking what a route returns.
---

# API Reference

Base URL: `https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod`

## Public Endpoints (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/cafe/status | Returns `{cafeStatus, queueSize, celebrationMode, celebrationPrice, featuredDrink, openingHours, openingState}`. (`celebrationMode`, `celebrationPrice` and `featuredDrink` had shipped long before they were documented here — `featuredDrink` is `null` or `{menuItemId, name, basePrice, imageUrl, category}`.) `openingHours` is the stored schedule or the default (see `db-schemas` → Main Config); `openingState` is `describeOpeningState()` from `lib/opening-hours.ts` evaluated server-side at request time: `{phase, opensLaterToday, nextOpenAt, minutesUntilNextOpen, nextOpenTimeLabel, nextOpenDayLabel, nextServiceSessionsLabel, serviceDaysLabel, currentSessionLabel, currentSessionClosesLabel}`. `phase` ∈ `BEFORE_FIRST_TODAY \| WITHIN_SESSION \| BETWEEN_SESSIONS \| AFTER_LAST_TODAY \| NOT_SERVICE_DAY`; `currentSessionLabel` and `currentSessionClosesLabel` are `null` in every phase except `WITHIN_SESSION`. **`openingState` is DESCRIPTIVE and must never gate anything** — `cafeStatus` remains the only thing that decides whether an order is accepted, because a late-starting or extended service would otherwise lock out customers standing at an open counter. Every label is computed here, in MYT, so the frontend renders server-computed strings and needs no timezone code of its own. `openingHours`/`openingState` are **additive**: an old cached service-worker shell ignores them |
| GET | /api/menu | Returns active menu items |
| POST | /api/orders | Create order. Optional `preorderCode` or `staffCode` (supplying **both** is a 400). With `preorderCode` the order is created **PENDING** (v1.71; it used to be PREPARING) so the customer can still edit it, is free (`totalAmount` 0, `discountType: 'MINISTRY_PREORDER'`), skips the café-open check and is drinks-only. Each `items[]` entry may carry an optional **`note`** — a per-item special request, max **80 chars measured trimmed** (`ITEM_NOTE_MAX_LENGTH`), separate from and additional to the per-order `notes`; `400 {error:'Item note must be a string'}` / `{error:'Item note cannot exceed 80 characters'}`, both raised before any DynamoDB write so a rejected note cannot leave `foodReserved` moved. On a pre-order, `collectionTime` is now **validated** against the link's own `collectionOptions` (falling back to `DEFAULT_COLLECTION_OPTIONS`): off-list is `400 {error:'Invalid collection time'}`, non-string `400 {error:'collectionTime must be a string'}`. It previously accepted any string, so leaving create permissive would have made the same check on edit pointless — no legitimate client is affected, since the customer page only ever submits a value from that same list |
| GET | /api/orders/{id} | Get order status. Also returns `isPreOrder`, `preorderCode`, `discountType`, `discountOffset` and `grossAmount` so `track.html` can tell a free ministry pre-order from an ordinary PENDING order (`totalAmount` is NET, i.e. 0, while the items carry full prices). **Only when `isPreOrder === true`** it additionally returns `collectionTime` (string, parsed out of the stored notes prefix by `parsePreorderCollectionTime`; `''` when the order has no prefix) and `collectionOptions` (`string[]`, the link's own list or the defaults) so `track.html` can render and preselect the collection-time picker. Served from here rather than `GET /api/preorder/validate` because that endpoint enforces the link's ordering window and would refuse to describe a closed link — losing the picker on a legitimate edit, since the edit window is the **order's** PENDING status, not the link's. The extra DynamoDB read is guarded behind the `isPreOrder` flag because `track.html` polls this handler every 7s |
| PUT | /api/orders/{id} | Modify/cancel order. PENDING only. **On a pre-order it re-enforces every create-side restriction** — drinks-only, the link's `eligibleItems`, its `excludedOptions` — returning `400 {error}` with the same readable message `POST /api/orders` gives. Accepts `items[].note` under the identical 80-char rule and the identical messages as create (create/edit parity). It also **owns the `[PRE-ORDER: CODE] Collect: …` notes prefix**: whatever prefix the client sends is stripped and the stored one re-prepended, and the 200-char `notes` budget applies to the customer's portion only. The **code** is always taken from the stored order record, never the request body, so a client cannot forge one. The **time**, however, is now customer-changeable: a `collectionTime` accepted by the same allowed-list check as create **replaces** the stored time, and **creates the prefix outright on a pre-order that had none**. Off-list/non-string give the same two 400s. The `notes = :n` clause is therefore emitted when `body.notes !== undefined` **or** a validated `collectionTime` applies — a client may change only the time, and the time lives inside `notes`; when `body.notes` is absent the stored customer portion is preserved verbatim. Without a `collectionTime` nothing is invented, and `expiresAt` is still never touched |
| POST | /api/auth/login | Login with userId+pin |
| POST | /api/auth/update-pin | Update PIN (requires JWT) |
| POST | /api/orders/{id}/receipt | Upload receipt image (base64). PENDING only, and **rejects a pre-order with `400 {error:'Pre-orders do not require payment'}`** — a free order has nothing to pay, and an extracted amount would never match its RM0 total |
| GET | /api/orders/{id}/receipt | Get presigned URL for receipt |
| POST | /api/customers | Register customer (phone, name, birthday) |
| GET | /api/customers/{phone} | Lookup customer by phone |
| GET | /api/customers/{phone}/orders | Get customer order history |
| GET | /api/preorder/validate?code=... | Validate a pre-order code. Returns campaign details including `eligibleItems` and `excludedOptions` (`"Group:Option"` pairs the customer page must hide) |
| GET | /api/staff-code/validate?code=... | Validate a staff code (the `?code=staff` link). `200 {valid:true, code, label}` / `400 {valid:false, reason:'invalid'\|'not_yet'\|'expired'}`. `not_yet`/`expired` come from the inclusive `startDate`/`endDate` gate in Malaysia time |
| POST | /api/push/subscribe | Subscribe to push notifications (orderId, subscription) |
| DELETE | /api/push/subscribe | Unsubscribe (orderId, endpoint) |
| GET | /api/push/vapid-public-key | Get VAPID public key. Method, path and (absent) auth unchanged, but as of v1.73.0 it **actually works** — it had returned `500 {error:'VAPID not configured'}` in production for weeks because the keys were empty Lambda env vars. It now resolves via `ensureVapidConfigured()` from SSM `/rlc-cafe/VAPID_*` and answers **only once web-push has accepted the whole triple** (subject + public + private); a partial config is still a `500`. Never serve the public key alone — a browser would subscribe successfully and be undeliverable forever, burning the customer's one notification permission |
| GET | /api/verses/random | Get a random active bible verse |

## Passkey / WebAuthn Endpoints (`/api/auth/passkey/*`)

Admin-page passkey login (v1.79.0). All four are dispatched by `handleAuth` in
`backend/src/routes/auth.ts` — `index.ts` needed no change because
`path.startsWith('/api/auth')` already routes there. Every relying-party
constant and every library call lives in `backend/src/lib/webauthn.ts`
(`@simplewebauthn/server` v14); routes never import the library directly.

**PIN login is unchanged and remains the required fallback** — passkey is purely
additive. `MAX_PASSKEYS_PER_USER = 10`.

| Method | Path | Auth | Success | Failures |
|--------|------|------|---------|----------|
| POST | /api/auth/passkey/register-options | JWT + role **ADMIN** + not `forceUpdatePin` | `200 {requestId, options}` | `401 Unauthorized`, `403 Forbidden`, `403 PIN change required before enrolling a passkey` |
| POST | /api/auth/passkey/register-verify | JWT + ADMIN + not `forceUpdatePin` | `201 {registered:true, credentialId, deviceLabel}` | `400` (bad JSON / missing fields / `Challenge not found or expired` / `Registration failed`), `401` (unauthorized, or the account is absent/inactive), `403` (non-ADMIN, challenge issued to a different user, `forceUpdatePin`), `409` (`Passkey already enrolled` / `Passkey limit reached` / `Credential already registered` / `Conflict`) |
| POST | /api/auth/passkey/login-options | **public** | `200 {requestId, options}` — `allowCredentials` is always `[]` | — |
| POST | /api/auth/passkey/login-verify | **public** | `200 {token, userId, name, role, forceUpdatePin, onboardingComplete, onboardingProgress}` — **byte-identical** to `POST /api/auth/login`, so the frontend shares one `applyLoginSuccess()` | **Every** failure is `401 {error:'Invalid credentials'}`, with no exceptions — no user enumeration, no distinguishing "no such credential" from "bad signature" from "inactive account" |

Load-bearing details:

- **`allowCredentials: []` is deliberate.** Registration asks for a discoverable
  credential (`residentKey: 'required'`), which is what makes login
  usernameless: the browser offers whatever passkey it holds for the rpID and
  the server learns the identity from the credential ID in the response. Drop
  the resident-key requirement and `login-options` has nothing to offer.
- **Challenges are single-use and deleted on every outcome**, including failed
  verification, so a captured response cannot be replayed against a challenge
  still sitting in the table. See `db-schemas` → `WEBAUTHN_CHALLENGE#`.
- **`login-verify` returning the exact login payload is a contract**, not a
  coincidence. Anything added to `POST /api/auth/login`'s response must be added
  here too or the passkey path silently loses it.
- **`login-options` is unauthenticated and each call writes a challenge record.**
  There is no rate limiting anywhere in this app; if it is added it belongs at
  API Gateway. See `docs/update-20260907.md`.
- **Passkeys cannot be exercised outside the production origin.** `RP_ID` /
  `ORIGIN` are the single live host, so the local dev flow
  (`npx http-server frontend -p 3001`) can never test this path. A
  misconfiguration's only symptom is the `verify-threw` log line, which carries
  `err.message`, `rpID` and `origin` for exactly that reason.

## Display Endpoints (Requires JWT, any role)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/display/orders | Ready orders for TV display (max 13) |
| GET | /api/display/slides | Active promo slides with presigned URLs |

## POS Endpoints (Requires JWT, role: CASHIER or ADMIN)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/pos/orders | List active orders (PENDING/PREPARING/READY) |
| POST | /api/pos/orders | Create walk-up order |
| PUT | /api/pos/orders/{id}/approve | Approve order (PENDING→PREPARING). For a pre-order this is the **"release to barista"** lock: same endpoint, but it delegates to the shared release helper — pricing class forced to `PREORDER`, ISO `expiresAt` preserved, `409` if the customer cancelled or edited first |
| PUT | /api/pos/preorders/release-all | **Bulk release today's ministry pre-orders** to the barista. No body (the acting cashier comes from the JWT and is written to `approvedBy`). Returns `200 {released, skipped, total}` with `released + skipped === total`. Acts **only** on orders with `isPreOrder === true` whose service-end date is **today in MYT** — a later service date is skipped so its customers keep their edit window, and an order with no usable ISO `expiresAt` is skipped rather than guessed at. Cashier-triggered only; there is deliberately no scheduled equivalent. Collection path, matched exactly, deliberately **not** under `/api/pos/orders/` |
| PUT | /api/pos/orders/{id}/ready | Mark ready |
| PUT | /api/pos/orders/{id}/undo-ready | Undo ready (READY→PREPARING) |
| PUT | /api/pos/orders/{id}/undo | Undo (PREPARING→PENDING) |
| PUT | /api/pos/orders/{id}/archive | Archive order |
| PUT | /api/pos/orders/{id}/reject | Reject order |
| POST | /api/pos/orders/{id}/cancel-completed | Cancel a completed order |
| PUT | /api/pos/cafe/open | Open café |
| PUT | /api/pos/cafe/close | Close café — expires PENDING (skipping pre-orders), archives PREPARING/READY, resets food counters and the featured drink. **Sends no email**: since v1.72.0 the end-of-day revenue summary is sent by the expiry cron once it sees `cafeStatus = CLOSED`, so it arrives within 30 min rather than in this response. Do not reintroduce a send here — it used to be fire-and-forget and Lambda's post-response freeze silently lost it |
| PUT | /api/pos/cafe/celebration | Toggle celebration mode |
| PUT | /api/pos/menu/{id}/toggle | Toggle item enabled today |
| PUT | /api/pos/menu/{id}/quantity | Update food quantity |
| PUT | /api/pos/menu/{id}/pin | Pin/unpin item |
| GET | /api/pos/inventory | Get all ingredients |
| PUT | /api/pos/inventory/{id} | Adjust stock for single ingredient |
| GET | /api/pos/menu | List cashier menu (full details) |
| GET | /api/pos/featured-drink | Get current featured drink |
| PUT | /api/pos/featured-drink | Set featured drink |
| DELETE | /api/pos/featured-drink | Unset featured drink |
| GET | /api/pos/ingredients | List ingredients for stock count |
| PUT | /api/pos/ingredients/bulk-update | Bulk update stock counts |
| GET | /api/pos/usage | Get ingredient usage today |
| GET | /api/pos/shift-summary | Get shift summary stats |
| PUT | /api/pos/onboarding-progress | Update onboarding progress |
| GET | /api/pos/checklist | Get checklist config + today's status |
| PUT | /api/pos/checklist/check | Mark checklist item done |
| PUT | /api/pos/checklist/uncheck | Uncheck item |
| POST | /api/pos/planogram/analyze | Upload photos for AI stock count |
| POST | /api/pos/planogram/confirm | Confirm AI counts and save |
| GET | /api/pos/planogram/reference/{location} | Get reference photo URL |
| GET | /api/pos/vouchers/{phone} | Lookup active vouchers for customer |
| POST | /api/pos/vouchers/redeem | Redeem a voucher |
| POST | /api/pos/vouchers/void | Void a redemption |

## Admin Endpoints (Requires JWT, role: ADMIN)

### Menu

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/menu | List all menu items |
| POST | /api/admin/menu | Add menu item |
| PUT | /api/admin/menu/{id} | Edit menu item |
| DELETE | /api/admin/menu/{id} | Delete menu item |
| PUT | /api/admin/menu/bulk-toggle | Bulk toggle items enabled/disabled |
| POST | /api/admin/menu/duplicate-food | Duplicate a food item |
| PUT | /api/admin/menu/{id}/toggle-active | Toggle admin-level active |

### Ingredients

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/admin/ingredients | Add ingredient |
| PUT | /api/admin/ingredients/{id} | Edit ingredient |
| DELETE | /api/admin/ingredients/{id} | Delete ingredient |
| PUT | /api/admin/ingredients/{id}/toggle-active | Toggle ingredient active |

### Recipes

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/recipes | List all recipes |
| POST | /api/admin/recipes | Define/update recipe |

### Users

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/users | List all users. The `ScanCommand` **must** keep its `FilterExpression: 'begins_with(PK, :userPk)'` (`USER#`). It was unfiltered until v1.79.0, which was harmless only while `USER#` was the sole record type on the table; the `PASSKEY_CRED#` reverse-lookup records then rendered as phantom volunteer rows whose Delete button carried the real owner's `userId`. See `invariants` → unfiltered Scan |
| POST | /api/admin/users | Add user |
| PUT | /api/admin/users/{id} | Edit user |
| DELETE | /api/admin/users/{id} | Delete user |
| PUT | /api/admin/users/{id}/reset-onboarding | Reset user onboarding |

### Passkeys

Self-service only: an admin manages their **own** passkeys. Enrolment lives on
the `/api/auth/passkey/*` routes above (they need a JWT but not the `/api/admin`
prefix). `callerFromToken()` in `routes/admin.ts` reads the identity from the
JWT — never from a path or body parameter.

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/passkeys | `200 {passkeys:[{id, deviceLabel, createdAt}]}` — the **caller's own only**. Never returns `publicKey` or `counter`. `401` unauthorized |
| DELETE | /api/admin/passkeys/{credentialId} | `200 {deleted}`. `400 credentialId required`; `404 Not found` when the credential is not the caller's own (so one admin cannot revoke another's by guessing an ID, and cannot probe for existence); `409 Conflict`. **Returns a JSON body, not `204`** — `admin.js`'s `api()` helper calls `res.json()` unconditionally, so a 204 breaks the caller. Do not "tidy" this to a 204 |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/settings | Get settings |
| PUT | /api/admin/settings | Update settings. Writes every body key straight through into one `UpdateExpression`. **`openingHours` is the one validated key**: `validateOpeningHours()` runs *before* the `UpdateCommand`, so a rejected value writes nothing at all, returns `400 {error}` with an admin-readable message naming the session and field (e.g. `Session 2 ("After 2nd service"): closesAt (12:30) must be after opensAt (12:45)`), and the **normalised** value is what gets persisted (`serviceDays` sorted, labels trimmed, unknown session keys dropped). Returns `200 {updated: [keys]}`. **Every other key is still unvalidated**, `cafeStatus` included — the route now *looks* validated because one key is; see follow-up (d) in `docs/update-20260819.md` |
| GET | /api/admin/settings/preorder-templates | Get pre-order defaults |
| PUT | /api/admin/settings/preorder-templates | Update pre-order defaults |

### Reports

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/reports | Main report (with ?date param, returns orders/stats/activity for a date) |
| GET | /api/admin/reports/daily | Daily reconciliation report |
| GET | /api/admin/reports/weekly | Weekly summary |
| GET | /api/admin/reports/monthly | Monthly aggregated report |
| GET | /api/admin/reports/inventory | Low stock report |
| GET | /api/admin/reports/restock | Restock recommendation |
| GET | /api/admin/reports/discounts | Discount breakdown report |
| GET | /api/admin/reports/sessions | Session 1 vs Session 2 breakdown. **Does not use `lib/opening-hours.ts`** — it buckets orders by a hardcoded `8:00 – 14:00 MYT` span split at the handover-checklist completion time (default `splitMinutes = 690`, i.e. 11:30), with its own open-coded `(utcHour + 8) % 24` conversions. So its `timeRange` strings are genuinely 8:00-based and do **not** match the configured opening hours; the admin dashboard nonetheless labels these cards `Session 1 (10:15-11:30)` / `Session 2 (12:45-13:30)`, so heading and numbers disagree. Follow-ups (a) and (b) in `docs/update-20260819.md` |
| GET | /api/admin/activity-log | Activity log |

### Featured Drink

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/featured-drink/audit | Get featured drink audit log |

### Stock History

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/stock-history | Get stock snapshots for a date (?date=YYYY-MM-DD) |
| GET | /api/admin/stock-history/snapshots | List all snapshot dates |

### Bible Verses

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/verses | List all verses |
| POST | /api/admin/verses | Create verse |
| PUT | /api/admin/verses/{id} | Update verse |
| DELETE | /api/admin/verses/{id} | Delete verse |

### Display Slides

`startDate` / `expiryDate` are validated identically on **create and edit** by
one helper, `slideDateRejection()` (`backend/src/routes/admin.ts:53`): both
required, both `YYYY-MM-DD`, and `expiryDate >= startDate` (equal is a valid
one-day window). The format check is load-bearing, not cosmetic —
`routes/display.ts` picks today's slides with a **lexicographic** string compare,
so `'16/08/2026'` is never rejected downstream, it is silently mis-compared, and
the slide simply never appears on the TV with nothing logged. **`imageUrl` is not
editable**: replacing a slide's image stays delete + re-upload.

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/display/slides | List all slides |
| POST | /api/admin/display/slides | Create slide record. Body `{imageUrl, title, startDate, expiryDate, sortOrder}`; `imageUrl`, `startDate`, `expiryDate` required. **Now rejects what it used to accept** — a free-text date and an inverted range were checked only in the browser, so the API took both; the create path calls the shared validator above (`admin.ts:1178`) |
| PUT | /api/admin/display/slides/{id} | Edit an existing slide's metadata. Body `{title, startDate, expiryDate, sortOrder}` — a fixed allowlist, never iterated from the body, which is what keeps `imageUrl`, `PK`, `SK`, `slideId` and `createdAt` out of reach. Dates required and validated exactly as on create (`admin.ts:1207`). `200 {updated: id}`; `404 {error:'Slide not found'}` from `ConditionExpression: attribute_exists(PK)` — an `UpdateCommand` upserts by default, and a PUT to a deleted `slideId` would otherwise write a new partial record with no `imageUrl` that the 1080p foyer TV renders as a broken image. Shipped in v1.81.0, together with the POST behaviour change above |
| DELETE | /api/admin/display/slides/{id} | Delete slide. Does **not** delete the underlying S3 object |
| GET | /api/admin/display/upload-url | Get presigned S3 upload URL (?filename, ?contentType) |

### Checklist

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/checklist/config | Get checklist configuration |
| PUT | /api/admin/checklist/config | Save checklist config |
| GET | /api/admin/checklist/logs | Get historical checklist logs |

### Planogram

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/admin/planogram/reference | Upload reference photo |

### Vouchers

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/admin/vouchers/campaigns | Create voucher campaign |
| GET | /api/admin/vouchers/campaigns | List all campaigns |
| GET | /api/admin/vouchers/campaigns/{id} | Get campaign details + issued vouchers |
| POST | /api/admin/vouchers/campaigns/{id}/assign | Assign voucher to phone |
| POST | /api/admin/vouchers/campaigns/{id}/assign-csv | Bulk assign from CSV |
| DELETE | /api/admin/vouchers/{id} | Delete/revoke a voucher |

### Pre-Order Codes

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/admin/preorder-codes | Create pre-order code |
| GET | /api/admin/preorder-codes | List all pre-order codes |
| PUT | /api/admin/preorder-codes/{code} | Update pre-order code |
| DELETE | /api/admin/preorder-codes/{code} | Delete pre-order code |

### Staff Code

Single-entry by design: the café runs at most one staff link, so there is no
create/delete pair — `PUT` is an upsert that sweeps every other `STAFF_CODE#`
record so exactly one survives.

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/staff-code | `200 {staffCode: record\|null}` — the single record |
| PUT | /api/admin/staff-code | Upsert. Body `{code, label, isActive, startDate, endDate}`; returns `200 {staffCode}`. `code` is uppercased and must use the ambiguity-free alphabet (3–16 chars); dates are `YYYY-MM-DD` or empty |
