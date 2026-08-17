---
name: db-schemas
description: DynamoDB table schemas for RLC Café POS — orders, menu, ingredients, users, settings, customers, vouchers. Includes partition/sort keys, GSIs, TTL attributes, and the single-table record types stored in the settings table (pre-order codes, staff codes, checklists, slides). Use when reading or writing DynamoDB records, adding attributes, or designing queries.
---

# DynamoDB Table Schemas

## Orders Table (rlc-cafe-orders)
- PK: string, SK: string
- GSI: `status-createdAt-index` (partition: status, sort: createdAt)
- GSI: `customerId-createdAt-index` (partition: customerId, sort: createdAt)
- TTL: `expiresAt` (epoch seconds) — **numeric values only.** A pre-order stores
  an ISO **string** here on purpose, which TTL ignores; see `isPreOrder` below.

| Attribute | Type | Description |
|-----------|------|-------------|
| orderId | string (UUID) | Unique order ID |
| customerName | string | Customer display name |
| items | list | [{menuItemId, name, variant, quantity, unitPrice, category, grossUnitPrice?, baseUnitPrice?}]. `unitPrice` is NET as stored; `grossUnitPrice` is the undiscounted unit price, persisted so the approve path can reprice without re-reading the menu. `baseUnitPrice` is the net the line would have had with **no** customer class (celebration-or-full) and is written **only** by the staff-link path — it is what `revertRequestedClassPricing` falls back to when the cashier declines a self-requested staff price, so declining does not also discard a legitimate celebration discount |
| totalAmount | number | **NET** total in MYR (what is collected) — 0 on a ministry pre-order |
| grossAmount | number | Undiscounted total. `discountOffset = grossAmount - totalAmount` |
| status | string | PENDING / PREPARING / READY / ARCHIVED / EXPIRED / CANCELLED |
| discountType | string | NONE / NEWCOMER / STAFF / PASTOR / CELEBRATION / MINISTRY_PREORDER / VOUCHER. Never `PREORDER` — that is a *customerClass* value only, and every report switches on this field against a fixed list that has no `PREORDER` in it |
| discountOffset | number | Amount discounted |
| createdAt | string | ISO timestamp |
| updatedAt | string | ISO timestamp |
| expiresAt | number \| string | **number** = live DynamoDB TTL (epoch seconds), PENDING orders only. **string** = a pre-order's ISO `serviceEndTime` — see `isPreOrder` below |
| notes | string | Customer note. On a pre-order it is prefixed `[PRE-ORDER: <CODE>] Collect: <time>` — the **only** record of the collection time (there is no `collectionTime` attribute), and backend-owned on edit |
| modifiedAt | string | ISO timestamp of the last customer edit (`PUT /api/orders/{id}`) |
| approvedBy | string | Volunteer name who approved |
| isWalkUp | boolean | Walk-up order created by cashier |
| flaggedItems | list | Items flagged as unavailable |
| customerId | string | Phone number for customer-linked orders |
| isPreOrder | boolean | `true` = ministry pre-order placed through a pre-order link. Created **PENDING** since v1.71 (previously PREPARING) so the customer can still edit it; the cashier's release to PREPARING is the lock. Its `expiresAt` is an **ISO string**, so it is inert as a TTL and survives for days — the 1-hour PENDING sweep and `closeCafe` both skip these records, and only `expirePreOrders()` in `expiry.ts` expires them. **Never write a numeric `expiresAt` on one:** that arms a real TTL and DynamoDB deletes the order silently |
| preorderCode | string | Pre-order code if from pre-order. Also the key back to the `PREORDER_CODE#` settings record, which supplies the restrictions on edit and the `serviceEndTime` fallback in `expirePreOrders()` |
| staffCode | string | Staff code the customer ordered through (staff link). Present = the STAFF price was **requested**, not granted; the POS keys its confirmation prompt off this, and `approveOrder` reverts the price unless the cashier passes `discountType: 'STAFF'` |
| customerClass | string | STAFF / PASTOR / NEWCOMER / CELEBRATION / PREORDER — normally written by the cashier at approve. Two paths set it at **create** time: the staff link (`'STAFF'`, a request rather than an approval) and a ministry pre-order (`'PREORDER'`, assigned by the server and never accepted from a request body — `parseCustomerClass` refuses it) |
| remark | string | Customer remark / special instructions |
| readyAt | string | ISO timestamp when marked ready |

## Menu Table (rlc-cafe-menu)
- PK: `MENU#{menuItemId}` (string)
- SK: `META` (string)

| Attribute | Type | Description |
|-----------|------|-------------|
| menuItemId | string (UUID) | Unique item ID |
| name | string | Display name |
| category | string | DRINK / FOOD |
| basePrice | number | Price in MYR |
| variants | list | [{id, name, priceModifier}] (legacy, replaced by variantGroups) |
| variantGroups | list | [{group, type, options: [{name, price}]}] — type: single/optional/multi |
| imageUrl | string | Optional image URL |
| isActive | boolean | Admin-level active |
| isEnabledToday | boolean | Cashier daily toggle |
| foodQuantityToday | number | Food: available count for the day |
| foodReserved | number | Food: reserved by pending orders |
| sortOrder | number | Display order |
| isPinned | boolean | Pinned for upsell display |

## Ingredients Table (rlc-cafe-ingredients)
- PK: `INGREDIENT#{ingredientId}` (string), SK: `META` (string)
- Also stores recipes: PK=`RECIPE#{menuItemId}#{variantId}`, SK=`INGREDIENT#{ingredientId}`

| Attribute | Type | Description |
|-----------|------|-------------|
| ingredientId | string (UUID) | Unique ingredient ID |
| name | string | Display name |
| unit | string | ml / g / spoons / pieces |
| currentStock | number | Current quantity |
| lowStockThreshold | number | Alert threshold |
| storageLocation | string | FRIDGE / STOREROOM |
| isActive | boolean | Whether ingredient is active |

## Users Table (rlc-cafe-users)
- PK: `USER#{userId}` (string), SK: `META` (string)
- Also has records: PK=`USER#{userId}`, SK=`NAMELOWER` (stores nameLower for login-by-name)

| Attribute | Type | Description |
|-----------|------|-------------|
| userId | string (UUID) | Unique user ID |
| name | string | Display name |
| nameLower | string | Lowercase name for login-by-name lookup |
| pinHash | string | bcrypt hash of PIN |
| role | string | CASHIER / ADMIN |
| isActive | boolean | Can login |
| forceUpdatePin | boolean | Must change PIN on next login |
| lastLoginAt | string | ISO timestamp of last successful login |
| onboardingCompleted | boolean | Has completed onboarding |
| onboardingProgress | map | Onboarding step progress |

## Settings Table (rlc-cafe-settings)
- PK: string, SK: string
- TTL: `expiresAt` (epoch seconds) — used for PUSH_SUB records

This table stores multiple record types using a single-table design pattern:

### Record Type 1: Main Config
- PK=`SETTINGS`, SK=`CONFIG`

| Attribute | Type | Description |
|-----------|------|-------------|
| cafeStatus | string | OPEN / CLOSED |
| celebrationMode | boolean | All drinks at flat price |
| celebrationPrice | number | Flat price (default 5) |
| orderExpiryMinutes | number | Order timeout (default 60) |
| archiveAfterMinutes | number | Ready→Archive timeout (default 15) |
| pushEnabled | boolean | Push notifications enabled |
| onboardingEnabled | boolean | New user onboarding flow enabled |

### Record Type 2: Checklist Config
- PK=`CHECKLIST_CONFIG`, SK=`META`

Stores the list of checklist items for daily open/close procedures, as three
arrays (`open` / `close` / `handover`).

**Array position IS the display order** — there is no `sortOrder` attribute. Admin
reorders items by array position (v1.71.0) and the POS renders the same arrays, so
a change that sorts, filters-and-rebuilds, or re-keys these arrays silently
destroys an ordering a volunteer set deliberately. The save is a whole-array
`PutCommand`, which is what makes the order round-trip.

### Record Type 3: Checklist Logs
- PK=`CHECKLIST_LOG#{date}`, SK=`{phase}`

Daily checklist completion logs per phase (e.g. OPEN, CLOSE).

### Record Type 4: Planogram References
- PK=`PLANOGRAM_REF#{location}`, SK=`META`

Reference photos for fridge/storeroom planogram layout.

### Record Type 5: Push Subscriptions
- PK=`PUSH_SUB#{orderId}`, SK=`{hash}`
- TTL: 24 hours

Push notification subscriptions tied to specific orders.

### Record Type 6: Bible Verses
- PK=`BIBLE_VERSE#{verseId}`, SK=`META`

| Attribute | Type | Description |
|-----------|------|-------------|
| text | string | Verse content |
| reference | string | Book chapter:verse reference |
| isActive | boolean | Currently shown |

### Record Type 7: Display Slides
- PK=`DISPLAY_SLIDE#{slideId}`, SK=`META`

| Attribute | Type | Description |
|-----------|------|-------------|
| imageUrl | string | Slide image URL |
| title | string | Slide title |
| startDate | string | When to start showing |
| expiryDate | string | When to stop showing |
| sortOrder | number | Display order |

### Record Type 8: Stock Snapshots
- PK=`STOCK_SNAPSHOT#{date}`, SK=`{timestamp}`

Stock count snapshots submitted by cashier during close procedure.

### Record Type 9: Pre-order Codes
- PK=`PREORDER_CODE#{code}`, SK=`META`

| Attribute | Type | Description |
|-----------|------|-------------|
| name | string | Pre-order event name |
| opensAt | string | ISO timestamp when ordering opens |
| expiresAt | string | ISO timestamp when code expires |
| serviceDate | string | Date of service/collection |
| bannerMessage | string | Banner shown to customers |
| eligibleItems | list | Menu items available for pre-order. **Empty/absent = ALL active drinks**, not none |
| excludedOptions | list | Variant options this link may not use, as `"Group:Option"` (e.g. `"Milk:Oat Milk"`). Empty/absent = nothing excluded. Enforced in `orders.ts` createOrder, mirrored by the customer page |
| collectionOptions | list | Available collection time slots |

### Record Type 10: Pre-order Templates
- PK=`SETTINGS#PREORDER_TEMPLATES`, SK=`META`

Defaults that pre-fill the "Create Pre-Order Link" form. Existing codes are
unaffected — each carries its own independent copy of these fields.

| Attribute | Type | Description |
|-----------|------|-------------|
| bannerMessage | string | Default banner; supports `{$SUNDAY}` |
| eligibleItemKeywords | list | Drink-name substrings pre-checked as eligible |
| collectionOptions | list | Default collection-time radio choices |
| excludedOptions | list | Default blocked variant options, `"Group:Option"` (e.g. `"Milk:Oat Milk"`). Unlike the others there is **no non-empty fallback** — an empty list means "block nothing" and must survive a reload |
| updatedAt | string | ISO timestamp of the last save |

### Record Type 11: Featured Drink
- PK=`FEATURED_DRINK`, SK=`META`

Current featured drink selection displayed on customer screen.

### Record Type 12: Featured Drink Audit
- PK=`FEATURED_AUDIT#{date}`, SK=`{timestamp}`

Audit log of featured drink changes (who changed, previous/new selection).

### Record Type 13: Activity Log
- PK=`ACTIVITY_LOG#{date}`, SK=`{timestamp}`

Activity log entries tracking café open/close events and significant actions.

### Record Type 14: Staff Codes
- PK=`STAFF_CODE#{code}`, SK=`META`

Backs the customer-facing staff link (`?code=<CODE>`): drinks at the staff rate
(RM5), food at full price. **Single entry by design** — the admin UI edits one
code, so `PUT /api/admin/staff-code` is an upsert that deletes every other
`STAFF_CODE#` record after writing, leaving exactly one behind.

Deliberately **not** a `PREORDER_CODE#` record: the two disagree on price,
status, café-open check, food eligibility and expiry.

| Attribute | Type | Description |
|-----------|------|-------------|
| code | string | Uppercased on both write and lookup. Alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L — the code is typed by hand off a printed link), 3–16 chars |
| label | string | Admin-facing note, max 60 chars |
| isActive | boolean | `false` validates as `reason:'invalid'` |
| startDate | string | `YYYY-MM-DD`, **inclusive**. Empty string = unbounded. Before it → `reason:'not_yet'` |
| endDate | string | `YYYY-MM-DD`, **inclusive**. Empty string = unbounded. After it → `reason:'expired'` |
| createdAt | string | ISO timestamp. Preserved across upserts when the code itself is unchanged |
| createdBy | string | Admin who created it; preserved on the same condition |
| updatedAt | string | ISO timestamp of the last save; also the tiebreak if a partial write ever left two records |

Both dates are compared against **today in Malaysia time (UTC+8)**, not UTC —
`malaysiaToday()` in `backend/src/lib/date.ts` (re-exported from
`routes/staffcode.ts`, which is where it used to live). A code ending "today"
must stay valid until local midnight.

This record carries **no `expiresAt`**, so the settings-table TTL cannot reach
it. That is intentional (the link is long-lived and date-gated instead) — do not
"tidy up" by adding one, and note the accepted consequence: the code is
permanent and guessable, with the cashier's approve-time confirmation as the
only real control.

### Record Type 15: Low Stock Alert Marker
- PK=`LOW_STOCK_ALERT#{date}`, SK=`META`

Written by `checkLowStock()` in `backend/src/expiry.ts` **only after a confirmed
send**, to keep the alert to one email per day. `{date}` is the Malaysian date.

| Attribute | Type | Description |
|-----------|------|-------------|
| lastSent | string | ISO timestamp of the successful send. Its presence IS the "already sent" flag |
| itemCount | number | How many ingredients were below threshold, for forensics |

### Record Type 16: Daily Summary Marker
- PK=`DAILY_SUMMARY#{date}`, SK=`META`

Written by `sendDailySummary()` in `backend/src/expiry.ts` after the end-of-day
revenue email has been confirmed sent. `{date}` is the **Malaysian** service date
from `malaysiaToday()`.

| Attribute | Type | Description |
|-----------|------|-------------|
| lastSent | string | ISO timestamp of the successful send. Its presence IS the "already sent" flag |
| date | string | The MYT service date the summary covered, `YYYY-MM-DD` |

**Write it only on success.** The cron re-runs every 30 min until 09:00Z, and the
absence of this record is what makes a failed summary retry instead of vanishing.
Writing it unconditionally would restore the old failure mode: one lost email per
week and no second attempt.

Both marker records are how an at-most-once email survives a handler that runs
repeatedly. Neither carries `expiresAt`; they are tiny and their date-keyed PKs
make them self-documenting, so the settings-table TTL is not involved.

## Customers Table (rlc-cafe-customers)
- PK: `CUSTOMER#{phone}` (string), SK: `META` (string)

| Attribute | Type | Description |
|-----------|------|-------------|
| phone | string | Normalized Malaysian format (0xxxxxxxxx) |
| name | string | Customer name |
| birthday | string | MM-DD format |
| orderCount | number | Total number of orders |
| totalSpent | number | Lifetime spend in MYR |
| lastOrderAt | string | ISO timestamp of last order |
| createdAt | string | ISO timestamp |
| updatedAt | string | ISO timestamp |

## Vouchers Table (rlc-cafe-vouchers)
- PK: string, SK: string
- GSI: `campaignId-issuedAt-index` (partition: campaignId, sort: issuedAt)

This table stores campaign definitions and individual vouchers:

### Record Type 1: Campaign Definitions
- PK=`CAMPAIGN#{campaignId}`, SK=`META`

| Attribute | Type | Description |
|-----------|------|-------------|
| campaignId | string (UUID) | Unique campaign ID |
| name | string | Campaign name |
| voucherType | string | FREE_DRINK / FREE_FOOD / FREE_COMBO |
| expiryMode | string | DAYS_FROM_ISSUE / FIXED_DATE |
| expiryDays | number | Days until expiry (if DAYS_FROM_ISSUE) |
| expiryDate | string | Fixed expiry date (if FIXED_DATE) |
| maxRedemptions | number | Max redemptions per voucher |
| isActive | boolean | Campaign is active |
| createdAt | string | ISO timestamp |
| createdBy | string | User who created the campaign |

### Record Type 2: Individual Vouchers
- PK=`VOUCHER#{phone}`, SK=`VOUCHER#{voucherId}`

| Attribute | Type | Description |
|-----------|------|-------------|
| voucherId | string (UUID) | Unique voucher ID |
| campaignId | string | Parent campaign ID |
| phone | string | Customer phone number |
| status | string | ISSUED / REDEEMED / EXPIRED / REVOKED |
| voucherType | string | Copied from campaign at issue time |
| issuedAt | string | ISO timestamp |
| expiresAt | string | ISO timestamp |
| redeemedAt | string | ISO timestamp (when redeemed) |
| redeemedBy | string | User who processed redemption |
| orderId | string | Order ID linked at redemption |
