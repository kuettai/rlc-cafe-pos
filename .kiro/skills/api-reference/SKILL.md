---
name: api-reference
description: Complete HTTP endpoint reference for the RLC Café POS API — public, display, POS (CASHIER/ADMIN) and ADMIN routes, with paths and auth requirements. Use when adding, calling, or debugging an API route.
---

# API Reference

Base URL: `https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod`

## Public Endpoints (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/cafe/status | Returns {cafeStatus, queueSize} |
| GET | /api/menu | Returns active menu items |
| POST | /api/orders | Create order. Optional `preorderCode` or `staffCode` (supplying **both** is a 400). With `preorderCode` the order is created **PENDING** (v1.71; it used to be PREPARING) so the customer can still edit it, is free (`totalAmount` 0, `discountType: 'MINISTRY_PREORDER'`), skips the café-open check and is drinks-only |
| GET | /api/orders/{id} | Get order status. Also returns `isPreOrder`, `preorderCode`, `discountType`, `discountOffset` and `grossAmount` so `track.html` can tell a free ministry pre-order from an ordinary PENDING order (`totalAmount` is NET, i.e. 0, while the items carry full prices) |
| PUT | /api/orders/{id} | Modify/cancel order. PENDING only. **On a pre-order it re-enforces every create-side restriction** — drinks-only, the link's `eligibleItems`, its `excludedOptions` — returning `400 {error}` with the same readable message `POST /api/orders` gives. It also **owns the `[PRE-ORDER: CODE] Collect: …` notes prefix**: whatever prefix the client sends is stripped and the stored one re-prepended, so a client can neither drop the collection time nor forge one, and the 200-char `notes` budget applies to the customer's portion only |
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
| GET | /api/push/vapid-public-key | Get VAPID public key |
| GET | /api/verses/random | Get a random active bible verse |

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
| GET | /api/admin/users | List all users |
| POST | /api/admin/users | Add user |
| PUT | /api/admin/users/{id} | Edit user |
| DELETE | /api/admin/users/{id} | Delete user |
| PUT | /api/admin/users/{id}/reset-onboarding | Reset user onboarding |

### Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/settings | Get settings |
| PUT | /api/admin/settings | Update settings |
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
| GET | /api/admin/reports/sessions | Session 1 vs Session 2 breakdown |
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

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/admin/display/slides | List all slides |
| POST | /api/admin/display/slides | Create slide record |
| DELETE | /api/admin/display/slides/{id} | Delete slide |
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
