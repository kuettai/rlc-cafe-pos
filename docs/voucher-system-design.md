# Voucher System — Design Document

Status: Draft (design only, no implementation yet)
Author: Architecture review
Date: 2026-06-22

## 1. Overview

A campaign-driven voucher system for the RLC Café POS. Admins create
campaigns, assign vouchers to customer phone numbers, and cashiers redeem
them at the till. Each voucher entitles the bearer to one free item (a drink
with all add-ons, or a food item) and is single-use.

Out of scope: percentage discounts, flat-amount vouchers, multi-item
vouchers, transferable vouchers, customer self-service redemption.

### 1.1 Voucher types

| Type | Covers | Notes |
|------|--------|-------|
| `FREE_DRINK` | Any single drink, base + every add-on (variant groups: Temperature, Milk, Flavor) | Add-ons like Oat Milk +RM1 are also free |
| `FREE_FOOD` | Any single food item | Subject to daily availability (`foodQuantityToday`) |
| `FREE_COMBO` | Exactly one drink **and** one food item, redeemed together as a single order | Cashier picks both items in a two-step flow; both rows go on the same order |

### 1.2 Lifecycle

```
        admin assigns                   cashier redeems
CAMPAIGN ────────────► VOUCHER (ISSUED) ─────────────► VOUCHER (REDEEMED)
                          │                              │
                          │ expiry passes                │ links to ORDER
                          ▼                              ▼
                       (EXPIRED)                    (immutable)
```

A voucher is in exactly one of three states: `ISSUED`, `REDEEMED`, `EXPIRED`.
Expiry is computed lazily on read (no cron required) — the expiry timestamp
is stored on the voucher at issue time.

### 1.3 Expiry modes (set per campaign)

- `DAYS_FROM_ISSUE` — `expiresAt = issuedAt + N days`. Each voucher's expiry
  is calculated when it is assigned. Useful for "valid 30 days from when we
  give it to you" campaigns.
- `FIXED_DATE` — every voucher expires at the same absolute timestamp.
  Useful for "Christmas campaign, valid until 31 Dec 23:59 MYT".

Changing a campaign's expiry settings after vouchers are issued does **not**
retroactively update already-issued vouchers. Admin must revoke + reissue.

## 2. DynamoDB Schema

### 2.1 New table: `rlc-cafe-vouchers`

Follows the existing single-table-per-domain convention used in
`infra-stack.ts` (orders, menu, ingredients, users, settings, customers).

```ts
const vouchersTable = new dynamodb.Table(this, 'VouchersTable', {
  tableName: 'rlc-cafe-vouchers',
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

vouchersTable.addGlobalSecondaryIndex({
  indexName: 'campaignId-issuedAt-index',
  partitionKey: { name: 'campaignId', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'issuedAt',   type: dynamodb.AttributeType.STRING },
});
```

Also grant `vouchersTable.grantReadWriteData(apiHandler)` and add
`VOUCHERS_TABLE: vouchersTable.tableName` to the Lambda environment.

### 2.2 Record types

Two record shapes share the table, distinguished by PK prefix.

#### Campaign record

```
PK = CAMPAIGN#{campaignId}
SK = META
```

| Attribute | Type | Description |
|-----------|------|-------------|
| campaignId | string (UUID) | Unique campaign id |
| name | string | Display name (e.g. "Christmas 2026 Free Drink") |
| description | string | Free-text description for admin context |
| voucherType | string | `FREE_DRINK` / `FREE_FOOD` |
| expiryMode | string | `DAYS_FROM_ISSUE` / `FIXED_DATE` |
| expiryDays | number? | Set when mode = `DAYS_FROM_ISSUE` |
| expiryDate | string? | ISO timestamp when mode = `FIXED_DATE` |
| status | string | `ACTIVE` / `ARCHIVED` |
| issuedCount | number | Cached count of vouchers issued |
| redeemedCount | number | Cached count of vouchers redeemed |
| createdAt | string | ISO timestamp |
| createdBy | string | Admin user name |
| updatedAt | string | ISO timestamp |

#### Voucher record

```
PK = VOUCHER#{phone}                       (normalised phone, see lib/phone.ts)
SK = CAMPAIGN#{campaignId}#VOUCHER#{voucherId}
```

| Attribute | Type | Description |
|-----------|------|-------------|
| voucherId | string (UUID) | Unique voucher id |
| campaignId | string | Campaign FK (also indexed via GSI) |
| phone | string | Normalised phone (matches `customerId` on orders) |
| voucherType | string | Snapshot of campaign type at issue time |
| status | string | `ISSUED` / `REDEEMED` |
| issuedAt | string | ISO timestamp |
| issuedBy | string | Admin user name |
| expiresAt | string | ISO timestamp — snapshot at issue time |
| expiresAtEpoch | number | Same value as epoch seconds, for easy filtering |
| redeemedAt | string? | ISO timestamp |
| redeemedBy | string? | Cashier user name |
| orderId | string? | Order created from this redemption |
| menuItemId | string? | Item picked at redemption |
| menuItemName | string? | Snapshot of item name |
| variant | string? | Variant label snapshot |
| discountAmount | number? | Full item price waived (recorded for reporting) |
| note | string? | Optional admin note (e.g. "Aunty Jane — 50th birthday") |

Snapshots (`voucherType`, `expiresAt`, `menuItemName`, `discountAmount`) are
intentional. They keep the voucher record self-describing for reporting even
if the campaign or menu changes later.

### 2.3 Access patterns

| # | Pattern | How |
|---|---------|-----|
| 1 | List all campaigns | Scan with filter `begins_with(PK, "CAMPAIGN#") AND SK = "META"` |
| 2 | Get one campaign | GetItem `PK=CAMPAIGN#{id}, SK=META` |
| 3 | List vouchers for a phone | Query `PK=VOUCHER#{phone}` (returns all campaigns mixed; sort by SK groups them by campaign) |
| 4 | List all vouchers in a campaign | Query GSI `campaignId-issuedAt-index` with `campaignId=:c` |
| 5 | Get one voucher (redeem) | GetItem `PK=VOUCHER#{phone}, SK=CAMPAIGN#{campaignId}#VOUCHER#{voucherId}` |
| 6 | Atomic redemption | UpdateItem with `ConditionExpression: status = :issued` |

Note: the cashier always reaches a redemption with both `phone` and
`voucherId` already in hand (from access pattern #3), so a `voucherId-only`
GSI is unnecessary.

### 2.4 Why a separate table (not customers/settings)

- Campaigns are global, not per-customer — they don't fit under
  `CUSTOMER#{phone}` PKs.
- Voucher records are conceptually owned by the (campaign × phone) pair,
  not by the customer profile. A customer with no profile (never registered)
  can still receive a voucher; reusing the customers table would force
  creating profile stubs.
- Following the one-table-per-domain pattern keeps IAM scoping and reporting
  queries clean.

### 2.5 Order schema additions

The orders table (`rlc-cafe-orders`) gains two new attributes used only
when the order originated from a voucher redemption. No schema migration
needed — DynamoDB is schemaless.

| Attribute | Type | Description |
|-----------|------|-------------|
| `discountType` | string | New value `VOUCHER` joins the existing `NONE/NEWCOMER/STAFF/PASTOR/CELEBRATION` |
| `discountOffset` | number | Set to full item price (existing field, reused) |
| `voucherId` | string | The voucher consumed |
| `voucherCampaignId` | string | Denormalised for reporting |
| `voucherPhone` | string | Denormalised for reporting; equals `customerId` |

The `customerId` GSI key on the order is also set to the voucher's phone,
so the order shows up in the customer's `/track` history automatically.

## 3. API Endpoints

All admin endpoints live under `/api/admin/vouchers/*` and require ADMIN
role (existing JWT middleware in `backend/src/index.ts` already covers
the path prefix). POS endpoints under `/api/pos/vouchers/*` require
CASHIER or ADMIN.

### 3.1 Admin — campaigns

| Method | Path | Body / Returns |
|--------|------|----------------|
| GET | `/api/admin/vouchers/campaigns` | → `{ campaigns: [...] }` |
| POST | `/api/admin/vouchers/campaigns` | `{ name, description, voucherType, expiryMode, expiryDays?, expiryDate? }` → `{ campaignId, ... }` |
| GET | `/api/admin/vouchers/campaigns/{id}` | → campaign + counts |
| PUT | `/api/admin/vouchers/campaigns/{id}` | `{ name?, description?, status? }` (expiry fields are append-only after first issue — see §1.3) |
| DELETE | `/api/admin/vouchers/campaigns/{id}` | Only allowed when `issuedCount = 0`; otherwise use status=ARCHIVED |

### 3.2 Admin — voucher assignment

| Method | Path | Body / Returns |
|--------|------|----------------|
| GET | `/api/admin/vouchers/campaigns/{id}/vouchers` | → `{ vouchers: [...] }` (paginated by `issuedAt`, GSI #4) |
| POST | `/api/admin/vouchers/campaigns/{id}/assign` | `{ phones: ["0168089999", "60123456789"], note? }` → `{ issued: N, skipped: [{phone, reason}] }` |
| POST | `/api/admin/vouchers/campaigns/{id}/assign-csv` | Multipart or `{ csv: "<base64>" }` — see §6 for format → `{ issued, skipped }` |
| DELETE | `/api/admin/vouchers/{phone}/{voucherId}` | Revoke an unredeemed voucher; rejects if status != ISSUED |

`assign` normalises phones via `lib/phone.ts`. Invalid or duplicate
(same phone × same campaign with active ISSUED voucher) entries are
returned in `skipped` rather than aborting the batch. Each successful
assignment computes its own `expiresAt` per campaign rules.

### 3.3 POS — lookup & redemption

| Method | Path | Body / Returns |
|--------|------|----------------|
| GET | `/api/pos/vouchers/lookup?phone={phone}` | → `{ phone, customerName?, eligible: [...], history: [...] }` |
| POST | `/api/pos/vouchers/{phone}/{voucherId}/redeem` | `{ menuItemId, variant?, selectedVariants?, redeemedBy }` (single-item) **or** `{ items: [{menuItemId, selectedVariants?}, ...], redeemedBy }` (combo) → `{ orderId, voucherId, status: "REDEEMED" }` |

For `FREE_COMBO` the request **must** carry `items[]` of length 2 with one
`DRINK` and one `FOOD` item; the API rejects 1-item or wrong-category
combos with 400. For `FREE_DRINK` / `FREE_FOOD` either shape is accepted
(legacy single-`menuItemId` form continues to work).

#### Lookup behaviour

- Normalise the phone via `lib/phone.ts`. Return 400 on invalid input.
- Query `PK=VOUCHER#{phone}`.
- Partition into:
  - `eligible`: `status = ISSUED` AND `expiresAtEpoch > now`. Sorted by
    `expiresAt` ascending (use-it-or-lose-it order).
  - `history`: everything else (REDEEMED, EXPIRED-but-still-ISSUED).
    The lookup endpoint flips `status` from ISSUED to EXPIRED on returned
    payload only — it does not write back; expiry is a derived state.
- Optionally enrich with `customerName` from the customers table when a
  profile exists (purely cosmetic).

#### Redemption behaviour (atomic)

The endpoint must guarantee: voucher gets marked REDEEMED **iff** an order
record is successfully created, and never twice.

Recommended implementation using `TransactWriteCommand`:

```
TransactWrite([
  Update voucher:
    Key: PK=VOUCHER#{phone}, SK=CAMPAIGN#{cid}#VOUCHER#{vid}
    SET status='REDEEMED', redeemedAt=:now, redeemedBy=:user,
        orderId=:oid, menuItemId=:mid, menuItemName=:mname,
        variant=:vlabel, discountAmount=:price
    Condition: status = 'ISSUED' AND expiresAtEpoch > :now_epoch,
  Put order:
    Item: { PK=ORDER#{oid}, SK=META, status='PREPARING',
            discountType='VOUCHER', discountOffset=:price,
            totalAmount=0, voucherId=:vid, voucherCampaignId=:cid,
            voucherPhone=:phone, customerId=:phone, customerName=...,
            items=[ {menuItemId, name, variant, quantity:1, unitPrice:0,
                     category} ],
            isWalkUp=true, createdAt=:now, ... },
])
```

If the conditional update fails (already redeemed, expired, or revoked),
return 409 with a clear reason. The order is never written.

Side-effects after the transaction commits (best-effort, matching existing
`approveOrder` patterns):
1. If item is `FOOD`, increment `foodReserved` (so daily count stays correct).
   If this fails the order is still valid; cron-based reconciliation handles
   stragglers. Open question — see §8.
2. Deduct ingredient usage via the existing `deductIngredients()` helper
   so recipe-based stock tracking stays accurate.
3. Increment `redeemedCount` on the campaign record.

The `customerId` field on the order makes it queryable via the existing
`customerId-createdAt-index` GSI, so the `/track` page picks it up
automatically.

## 4. Frontend UI

### 4.1 Admin — Vouchers tab

Add a sidebar entry between "Users" and "Settings" in `frontend/js/admin.js`.

```
┌──────────────────────────────────────────────────────────────────────┐
│ ☕ Admin               │  Vouchers                                    │
│ 👤 Pastor Joe          │                              [+ New Campaign]│
│                        │  ┌─────────────────────────────────────────┐ │
│ 📊 Dashboard           │  │ Christmas 2026 Free Drink               │ │
│ 📈 Reports             │  │ FREE_DRINK · Expires 2026-12-31         │ │
│ 🍽️ Menu                │  │ Issued: 42  Redeemed: 17  Active        │ │
│ 🧪 Ingredients         │  │              [View] [Edit] [Archive]    │ │
│ ✅ Checklist            │  ├─────────────────────────────────────────┤ │
│ 📷 Planogram           │  │ Newcomer Welcome Pack                   │ │
│ 👥 Users               │  │ FREE_FOOD · 30 days from issue          │ │
│ 🎟️  Vouchers     ◄────  │  │ Issued: 8   Redeemed: 3   Active        │ │
│ ⚙️  Settings            │  │              [View] [Edit] [Archive]    │ │
│                        │  └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

Click `[New Campaign]` → modal:

```
┌─────────────────────────────────────────────────┐
│ New Voucher Campaign                          ✕ │
├─────────────────────────────────────────────────┤
│ Name        [_____________________________]     │
│ Description [_____________________________]     │
│             [_____________________________]     │
│                                                 │
│ Voucher Type                                    │
│   ( ) FREE_DRINK — any drink + add-ons free     │
│   ( ) FREE_FOOD  — any food item free           │
│                                                 │
│ Expiry                                          │
│   ( ) Days from issue   [ 30 ] days             │
│   ( ) Fixed date        [ 2026-12-31 ▾ ]        │
│                                                 │
│                          [Cancel]  [Create]     │
└─────────────────────────────────────────────────┘
```

Click `[View]` on a campaign → drill-in showing assigned vouchers + assign
controls:

```
┌─────────────────────────────────────────────────────────────────┐
│ ← Back   Christmas 2026 Free Drink                              │
│          FREE_DRINK · Expires 2026-12-31 · Active               │
├─────────────────────────────────────────────────────────────────┤
│ Assign vouchers                                                  │
│ ┌──────────────────────────────────────────────┐  ┌───────────┐ │
│ │ Phone numbers (one per line, or paste CSV)   │  │ ─ OR ─    │ │
│ │ 0168089999                                   │  │           │ │
│ │ 60123456789                                  │  │ [📂 Upload│ │
│ │ 016-808-9999                                 │  │   CSV]    │ │
│ │ ...                                          │  │           │ │
│ └──────────────────────────────────────────────┘  └───────────┘ │
│ Note (optional) [_______________________]                       │
│                                                       [Assign]  │
├─────────────────────────────────────────────────────────────────┤
│ Issued vouchers (42)                          [Search phone __] │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 0168089999  Aunty Jane    Issued 2026-06-15  ISSUED   [✕]   │ │
│ │ 0123456789  —             Issued 2026-06-15  REDEEMED       │ │
│ │             ↳ Order #abc12 · Latte (Iced, Oat Milk)         │ │
│ │ 0192223333  John          Issued 2026-06-10  EXPIRED        │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

`[✕]` on an ISSUED voucher revokes (DELETE endpoint). REDEEMED rows are
read-only and link to the source order.

### 4.2 POS — Voucher redemption flow

Add a `🎟️ Voucher` button next to the existing `➕ Walk-up` in the POS
sidebar (`frontend/js/pos.js → renderMain()`). Same modal pattern as
walk-up.

#### Step 1 — phone entry

```
┌──────────────────────────────────────┐
│ 🎟️  Redeem Voucher                ✕  │
├──────────────────────────────────────┤
│ Customer phone                       │
│ [_______________________]            │
│                                      │
│                  [Cancel]  [Look up] │
└──────────────────────────────────────┘
```

#### Step 2 — voucher list

Eligible at top, past/used greyed below. Sorted within each section by
`expiresAt` ascending.

```
┌────────────────────────────────────────────────────┐
│ ← 0168089999  ·  Aunty Jane                     ✕  │
├────────────────────────────────────────────────────┤
│ Available (2)                                       │
│ ┌────────────────────────────────────────────────┐ │
│ │ 🥤 FREE DRINK                                  │ │
│ │ Christmas 2026 Free Drink                      │ │
│ │ Expires in 12 days (2026-12-31)        [Use →] │ │
│ ├────────────────────────────────────────────────┤ │
│ │ 🍪 FREE FOOD                                   │ │
│ │ Newcomer Welcome Pack                          │ │
│ │ Expires in 3 days (2026-06-25)         [Use →] │ │
│ └────────────────────────────────────────────────┘ │
│                                                     │
│ Past (3)                                            │
│ ┌────────────────────────────────────────────────┐ │
│ │ 🥤 FREE DRINK · Christmas 2025                 │ │
│ │ REDEEMED 2026-01-04 · Latte (Iced, Oat Milk)   │ │
│ ├────────────────────────────────────────────────┤ │
│ │ 🍪 FREE FOOD · Newcomer Welcome Pack           │ │
│ │ EXPIRED 2026-04-30                             │ │
│ └────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

#### Step 3 — pick item

`[Use →]` opens the menu picker, filtered to drinks (FREE_DRINK) or food
(FREE_FOOD). Reuses the existing walk-up menu render with item rows and
variant buttons. Cart is hard-locked to qty=1.

```
┌────────────────────────────────────────────────────┐
│ ← Voucher: FREE DRINK · Aunty Jane              ✕  │
├────────────────────────────────────────────────────┤
│ Pick a drink                       [Search ____ ]  │
│ ┌────────────────────────────────────────────────┐ │
│ │ Latte                                          │ │
│ │ Temperature: [Hot] [Iced]                      │ │
│ │ Milk:        [Oat Milk +RM1]                   │ │
│ ├────────────────────────────────────────────────┤ │
│ │ Long Black                                     │ │
│ │ Temperature: [Hot] [Iced]                      │ │
│ ├────────────────────────────────────────────────┤ │
│ │ ... (filtered to category=DRINK,               │ │
│ │      isEnabledToday=true)                      │ │
│ └────────────────────────────────────────────────┘ │
│                                                     │
│ Selected:  Latte (Iced, Oat Milk)                   │
│ Item value:  RM 8.00  ──►  voucher covers RM 8.00   │
│                                                     │
│                       [Cancel]  [Confirm Redeem]   │
└────────────────────────────────────────────────────┘
```

`[Confirm Redeem]` calls `POST /api/pos/vouchers/{phone}/{voucherId}/redeem`.
On 200 the modal closes and the new order appears on the prep board (it
was created with `status=PREPARING`, so the existing kanban + `/track`
view picks it up via the standard polling loop).

On 409 (already redeemed / expired) the modal stays open and re-fetches
the voucher list so the cashier sees the updated state.

## 5. How redemption links to the order record

The order record is the single source of truth for reporting. Voucher
redemption produces an order with these specific attributes set. For
`FREE_COMBO` the only difference is that `items[]` has two entries
(one DRINK + one FOOD) and `discountOffset` is the sum of both prices —
all other fields are identical:

```json
{
  "PK": "ORDER#<orderId>",
  "SK": "META",
  "orderId": "<uuid>",
  "customerName": "Aunty Jane",          // from customer profile if known
  "customerId": "0168089999",            // = voucherPhone, hits GSI for /track
  "items": [
    {
      "menuItemId": "<menuItemId>",
      "name": "Latte",
      "variant": "Iced, Oat Milk",
      "quantity": 1,
      "unitPrice": 0,                    // free
      "category": "DRINK"
    }
  ],
  "totalAmount": 0,
  "status": "PREPARING",                 // skips PENDING — no payment step
  "discountType": "VOUCHER",
  "discountOffset": 8.00,                // full item price waived
  "voucherId": "<voucherId>",
  "voucherCampaignId": "<campaignId>",
  "voucherPhone": "0168089999",
  "isWalkUp": true,
  "approvedBy": "<cashierName>",         // = redeemedBy
  "createdAt": "2026-06-22T09:30:00Z",
  "updatedAt": "2026-06-22T09:30:00Z",
  "expiresAt": <epoch>,
  "flaggedItems": []
}
```

Why these choices:
- `status=PREPARING` matches the existing walk-up flow and means the order
  shows up on the prep kanban immediately, with no payment-confirmation
  step.
- `discountType=VOUCHER` is a new value; existing reports
  (`/api/admin/reports/discounts`, `/api/admin/reports/monthly`,
  `/api/admin/reports/sessions`) already group by `discountType` and sum
  `discountOffset`, so vouchers slot in for free.
- `discountOffset = unitPrice` (after variant up-charges) keeps revenue
  reconciliation correct — the item's "would-have-been" revenue is
  recoverable from the report.
- `customerId = phone` lets the customer find the order on `/track`
  without any extra lookup endpoint.
- `voucherId` / `voucherCampaignId` give a forward link from order →
  voucher for audit. The reverse link (voucher → order) is on the
  voucher record.

The reverse link is set in the same transaction (see §3.3), so audit
traversals work in either direction without a join.

## 6. CSV bulk-upload format

Plain CSV, UTF-8, max 1000 rows per upload.

### 6.1 Required header row

```
phone,name,note
```

- `phone` — required. Any format accepted by `lib/phone.ts` (e.g.
  `0168089999`, `+60168089999`, `016-808-9999`). Normalised on ingest.
- `name` — optional. If the customer has no profile yet, the import
  does **not** create one (vouchers don't require profiles). If a
  profile already exists, name is ignored. Provided for the admin's
  own context only.
- `note` — optional. Persisted on each voucher record.

### 6.2 Example

```csv
phone,name,note
0168089999,Aunty Jane,Birthday gift
60123456789,,
016-808-9999,John Tan,Newcomer 2026-06-22
```

### 6.3 Rules

- Empty lines and lines starting with `#` are ignored.
- Phones that fail normalisation are reported back in `skipped` with
  reason `"invalid_phone"`.
- A phone that already has an active (`ISSUED`) voucher in the same
  campaign is reported in `skipped` with reason `"duplicate"` — admin
  must explicitly revoke + reissue, or accept the duplicate by passing
  `?allowDuplicates=true` on the request.
- Maximum 1000 rows per upload to fit within the API Gateway 10 MB
  request limit and Lambda 10s timeout when normalising + writing.
  Larger lists must be split.

### 6.4 Response

```json
{
  "campaignId": "...",
  "issued": 87,
  "skipped": [
    { "row": 5,  "phone": "abc",         "reason": "invalid_phone" },
    { "row": 12, "phone": "0168089999",  "reason": "duplicate" }
  ]
}
```

## 7. Reporting impact

No new report endpoints required. The existing endpoints already aggregate
by `discountType`:

- `/api/admin/reports/discounts` — adds a `VOUCHER` row to `summary` with
  count + total offset.
- `/api/admin/reports/daily`, `/weekly`, `/monthly` — `totalOffsets`
  includes voucher redemptions; `netCollection` reflects the give-away.
- `/api/admin/reports/sessions` — voucher orders count toward the
  Sunday session whose hour they fall in (drinks served, top items).

The Vouchers admin tab also shows per-campaign counters
(`issuedCount`, `redeemedCount`) maintained on the campaign record for
fast display.

## 8. Open questions

1. **Voiding a redeemed voucher.** What happens if a barista realises
   immediately after redemption that the customer wanted something else?
   Options:
   (a) cashier rejects the order (existing `/reject` endpoint), and we
   add logic to flip the voucher back to `ISSUED` if the order had
   `voucherId`;
   (b) treat redeemed vouchers as immutable and require admin to issue
   a replacement.
   Recommendation: (a), guarded by a 5-minute window from `redeemedAt`,
   with an audit field `voidedAt` on the voucher.

2. **Multiple vouchers in one transaction.** If a customer has both a
   `FREE_DRINK` and `FREE_FOOD` voucher, do we redeem both into a
   single order? Easier model: one redemption = one order. Customer
   gets two prep tickets (their drink and their food), which is how the
   barista station already operates. Keep one-per-order.

3. **Food availability collisions.** Today's food count
   (`foodQuantityToday - foodReserved`) can hit zero. Should a
   `FREE_FOOD` voucher fail at redemption with "out of stock", or should
   it bypass the count (since redemption is essentially gift-fulfilment)?
   Recommendation: respect the count. The cashier can suggest a
   different item or come back next week.

4. **Anonymous (no-phone) vouchers.** Out of scope per requirements,
   but worth flagging — physical paper vouchers with a code would need a
   different lookup path. Not designing for this now.

5. **Customer-side visibility.** Should the customer see their own
   vouchers on `/track` or `/index`? Not in this design (no public
   endpoint exposed). Could be added later with a "lookup my vouchers"
   page that prompts for phone + a one-time code.

6. **Per-campaign limits.** No per-customer cap or total-issued cap is
   enforced beyond duplicate detection. If campaigns need a hard cap
   (e.g. "only first 100 newcomers"), add `maxVouchers` to the campaign
   record and check at assign time.

7. **Cron cleanup of expired vouchers.** Not required (expiry is
   computed lazily). But if the voucher table grows large over years,
   adding a TTL attribute mirroring `expiresAtEpoch + grace_period`
   would let DynamoDB auto-delete old records. Decide once volumes
   justify it.
