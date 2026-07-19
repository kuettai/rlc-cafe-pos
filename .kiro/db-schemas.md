# DynamoDB Table Schemas

## Orders Table (rlc-cafe-orders)
- PK: string, SK: string
- GSI: `status-createdAt-index` (partition: status, sort: createdAt)
- GSI: `customerId-createdAt-index` (partition: customerId, sort: createdAt)
- TTL: `expiresAt` (epoch seconds)

| Attribute | Type | Description |
|-----------|------|-------------|
| orderId | string (UUID) | Unique order ID |
| customerName | string | Customer display name |
| items | list | [{menuItemId, name, variant, quantity, unitPrice, category}] |
| totalAmount | number | Total in MYR |
| status | string | PENDING / PREPARING / READY / ARCHIVED / EXPIRED / CANCELLED |
| discountType | string | NONE / NEWCOMER / STAFF / PASTOR / CELEBRATION |
| discountOffset | number | Amount discounted |
| createdAt | string | ISO timestamp |
| updatedAt | string | ISO timestamp |
| expiresAt | number | TTL epoch seconds |
| approvedBy | string | Volunteer name who approved |
| isWalkUp | boolean | Walk-up order created by cashier |
| flaggedItems | list | Items flagged as unavailable |
| customerId | string | Phone number for customer-linked orders |
| preorderCode | string | Pre-order code if from pre-order |
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

Stores the list of checklist items for daily open/close procedures.

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
| eligibleItems | list | Menu items available for pre-order |
| collectionOptions | list | Available collection time slots |

### Record Type 10: Pre-order Templates
- PK=`SETTINGS#PREORDER_TEMPLATES`, SK=`META`

Default templates for creating new pre-order codes.

### Record Type 11: Featured Drink
- PK=`FEATURED_DRINK`, SK=`META`

Current featured drink selection displayed on customer screen.

### Record Type 12: Featured Drink Audit
- PK=`FEATURED_AUDIT#{date}`, SK=`{timestamp}`

Audit log of featured drink changes (who changed, previous/new selection).

### Record Type 13: Activity Log
- PK=`ACTIVITY_LOG#{date}`, SK=`{timestamp}`

Activity log entries tracking café open/close events and significant actions.

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
