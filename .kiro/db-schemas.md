# DynamoDB Table Schemas

## Orders Table (rlc-cafe-orders)
- PK: `ORDER#{orderId}` (string)
- SK: `META` (string)
- GSI: `status-createdAt-index` (partition: status, sort: createdAt)
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
| expiresAt | number | TTL epoch seconds (createdAt + 60min) |
| approvedBy | string | Volunteer name who approved |
| isWalkUp | boolean | Walk-up order created by cashier |
| flaggedItems | list | Items flagged as unavailable |

## Menu Table (rlc-cafe-menu)
- PK: `MENU#{menuItemId}` (string)
- SK: `META` (string)

| Attribute | Type | Description |
|-----------|------|-------------|
| menuItemId | string (UUID) | Unique item ID |
| name | string | Display name |
| category | string | DRINK / FOOD |
| basePrice | number | Price in MYR |
| variants | list | [{id, name, priceModifier}] |
| imageUrl | string | Optional image URL |
| isActive | boolean | Admin-level active |
| isEnabledToday | boolean | Cashier daily toggle |
| foodQuantityToday | number | Food: available count for the day |
| foodReserved | number | Food: reserved by pending orders |
| sortOrder | number | Display order |

## Ingredients Table (rlc-cafe-ingredients)
- PK: `INGREDIENT#{ingredientId}` (string)
- SK: `META` (string)
- Also stores recipes: PK=`RECIPE#{menuItemId}#{variantId}`, SK=`INGREDIENT#{ingredientId}`

| Attribute | Type | Description |
|-----------|------|-------------|
| ingredientId | string (UUID) | Unique ingredient ID |
| name | string | Display name |
| unit | string | ml / g / spoons / pieces |
| currentStock | number | Current quantity |
| lowStockThreshold | number | Alert threshold |
| storageLocation | string | FRIDGE / STOREROOM |

## Users Table (rlc-cafe-users)
- PK: `USER#{userId}` (string)
- SK: `META` (string)

| Attribute | Type | Description |
|-----------|------|-------------|
| userId | string (UUID) | Unique user ID |
| name | string | Display name |
| pinHash | string | bcrypt hash of PIN |
| role | string | CASHIER / ADMIN |
| isActive | boolean | Can login |

## Settings Table (rlc-cafe-settings)
- PK: `SETTINGS` (string)
- SK: `CONFIG` (string)

| Attribute | Type | Description |
|-----------|------|-------------|
| cafeStatus | string | OPEN / CLOSED |
| celebrationMode | boolean | All drinks at flat price |
| celebrationPrice | number | Flat price (default 5) |
| orderExpiryMinutes | number | Order timeout (default 60) |
| archiveAfterMinutes | number | Ready→Archive timeout (default 15) |
