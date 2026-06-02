# RLC Café POS — Architecture Document

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      GitHub Pages (Free)                      │
│                                                              │
│  ┌──────────┐   ┌──────────────┐   ┌───────────────────┐   │
│  │ Customer │   │ Cashier POS  │   │ Admin Dashboard   │   │
│  │   PWA    │   │     PWA      │   │       PWA         │   │
│  └────┬─────┘   └──────┬───────┘   └────────┬──────────┘   │
└───────┼─────────────────┼────────────────────┼──────────────┘
        │                 │                    │
        │        HTTPS (REST API)              │
        ▼                 ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                   AWS API Gateway (REST)                      │
│                      + Lambda Authorizer                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     AWS Lambda Functions                      │
│                                                              │
│  ┌─────────┐ ┌─────────┐ ┌───────────┐ ┌───────────────┐  │
│  │ Orders  │ │  Menu   │ │ Inventory │ │     Auth      │  │
│  └────┬────┘ └────┬────┘ └─────┬─────┘ └───────┬───────┘  │
└───────┼────────────┼────────────┼───────────────┼───────────┘
        │            │            │               │
        ▼            ▼            ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│                      AWS DynamoDB                             │
│                                                              │
│  ┌────────┐ ┌──────┐ ┌───────────┐ ┌──────┐ ┌──────────┐  │
│  │ Orders │ │ Menu │ │ Inventory │ │ Users│ │ Settings │  │
│  └────────┘ └──────┘ └───────────┘ └──────┘ └──────────┘  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────┐
│  Gmail SMTP (Free)  │ ← Triggered by Lambda (low-stock, end-of-day)
└─────────────────────┘
```

## 2. Tech Stack

| Layer | Technology | Free Tier Type | Cost |
|-------|-----------|----------------|------|
| Frontend hosting | GitHub Pages | Always free | RM0 |
| Frontend framework | Vanilla JS or lightweight framework (e.g., Preact) | N/A | RM0 |
| PWA | Service Worker + manifest.json | N/A | RM0 |
| API | AWS API Gateway (REST) | $200 credit (6 months for new accounts) | ~RM0.01/month after credits expire |
| Compute | AWS Lambda (Node.js) | Always free (1M requests/month) | RM0 |
| Database | AWS DynamoDB | Always free (25GB, 25 RCU/WCU) | RM0 |
| Email | Gmail SMTP via Lambda (app password) | Always free | RM0 |
| Domain (optional) | Custom domain | N/A | ~RM40/year |

**Estimated monthly cost after free credits expire: ~RM0.01/month** (API Gateway pay-per-use at ~1,000 requests/month is negligible. Lambda and DynamoDB are always free at this volume — ~200 orders/month, ~50 users.)

> **Note:** AWS free tier details as of July 2025. Lambda (1M requests/month) and DynamoDB (25GB + 25 RCU/WCU) are **always free** with no expiry. API Gateway moved to a credit-based model for new accounts ($200 credits, 6-month free plan). After credits expire, cost is ~$1 per 1M API calls — effectively zero at church café volume.

## 3. Frontend Architecture

### 3.1 Routes

| Path | View | Auth Required |
|------|------|---------------|
| `/` | Customer — Menu & ordering | No |
| `/track.html?id=xxx` | Customer — Order tracking | No |
| `/pos.html` | Cashier — Order board | PIN login |
| `/admin.html` | Admin — Dashboard (future) | PIN login |

### 3.2 Hosting

- **URL:** https://kuettai.github.io/rlc-cafe-pos/
- **Deployment:** GitHub Actions auto-deploys on push to `frontend/`
- **Repo:** https://github.com/kuettai/rlc-cafe-pos

### 3.2 PWA Configuration

- `manifest.json` with app name, icons, theme colour (church branding)
- Service worker caches static shell (HTML/CSS/JS) for fast load
- Data always fetched live from API (no offline data sync needed — WiFi required for payment anyway)

### 3.3 Responsive Design

- **iPad (1024px+):** Kanban 3-column view for POS
- **Mobile (<768px):** Single-list view with tabs
- Customer menu: Mobile-first design (most customers on phones)

## 4. API Design

### 4.1 Public Endpoints (No Auth)

```
GET    /api/menu                    → Active menu items + availability
GET    /api/cafe/status             → Open/closed, queue size
POST   /api/orders                  → Submit new order
GET    /api/orders/{id}             → Get order status (polling)
PUT    /api/orders/{id}             → Modify/cancel own order (while Pending)
```

### 4.2 Authenticated Endpoints (Cashier + Admin)

```
POST   /api/auth/login              → PIN login, returns JWT
POST   /api/auth/logout             → Invalidate token

GET    /api/pos/orders              → All active orders (Pending/Preparing/Ready)
PUT    /api/pos/orders/{id}/approve → Move to Preparing (+ optional: newcomer flag)
PUT    /api/pos/orders/{id}/ready   → Move to Ready
PUT    /api/pos/orders/{id}/reject  → Reject with reason
POST   /api/pos/orders              → Create walk-up order

PUT    /api/pos/menu/{id}/toggle    → Enable/disable item for the day
PUT    /api/pos/cafe/open           → Open café
PUT    /api/pos/cafe/close          → Close café
PUT    /api/pos/cafe/celebration    → Toggle Special Celebration mode

GET    /api/pos/inventory           → Current stock levels
PUT    /api/pos/inventory/{id}      → Adjust stock count
```

### 4.3 Admin-Only Endpoints

```
POST   /api/admin/menu              → Add menu item
PUT    /api/admin/menu/{id}         → Edit menu item
DELETE /api/admin/menu/{id}         → Remove menu item

POST   /api/admin/ingredients       → Add raw ingredient
PUT    /api/admin/ingredients/{id}  → Edit ingredient (unit, threshold)
POST   /api/admin/recipes           → Define recipe for menu item

POST   /api/admin/users             → Add volunteer PIN
PUT    /api/admin/users/{id}        → Edit role/PIN
DELETE /api/admin/users/{id}        → Remove volunteer

GET    /api/admin/reports/daily     → End-of-day reconciliation
GET    /api/admin/reports/weekly    → Weekly summary
GET    /api/admin/reports/inventory → Inventory trends

GET    /api/admin/settings          → Get settings
PUT    /api/admin/settings          → Update settings
GET    /api/admin/activity-log      → Audit trail
```

## 5. Data Model (DynamoDB)

### 5.1 Orders Table

```
PK: ORDER#{date}#{orderId}
SK: META

Attributes:
- orderId (string, UUID)
- customerName (string)
- items (list: [{menuItemId, name, variant, quantity, unitPrice}])
- totalAmount (number)
- status (enum: PENDING | PREPARING | READY | ARCHIVED | EXPIRED | CANCELLED)
- discountType (enum: NONE | NEWCOMER | STAFF | PASTOR | CELEBRATION)
- discountOffset (number)
- createdAt (ISO timestamp)
- updatedAt (ISO timestamp)
- expiresAt (TTL — 1 hour after creation)
- approvedBy (volunteer name, set when moved to Preparing)
- isWalkUp (boolean)

GSI1: status-createdAt-index (for querying by status)
```

### 5.2 Menu Table

```
PK: MENU#{menuItemId}
SK: META

Attributes:
- menuItemId (string, UUID)
- name (string)
- category (enum: DRINK | FOOD)
- basePrice (number, MYR)
- variants (list: [{id, name, priceModifier}])
  e.g., [{id: "hot", name: "Hot", priceModifier: 0},
         {id: "iced", name: "Iced", priceModifier: 0},
         {id: "oat", name: "Oat Milk", priceModifier: 1}]
- imageUrl (string, optional)
- isActive (boolean — admin-level active)
- isEnabledToday (boolean — cashier daily toggle)
- foodQuantityToday (number, for food items)
- foodReserved (number, held by pending orders)
- sortOrder (number)
```

### 5.3 Ingredients Table

```
PK: INGREDIENT#{ingredientId}
SK: META

Attributes:
- ingredientId (string, UUID)
- name (string)
- unit (string: "ml", "g", "spoons", "pieces")
- currentStock (number)
- lowStockThreshold (number)
- storageLocation (enum: FRIDGE | STOREROOM)
- lastUpdatedBy (string)
- lastUpdatedAt (ISO timestamp)
```

### 5.4 Recipes Table

```
PK: RECIPE#{menuItemId}#{variantId}
SK: INGREDIENT#{ingredientId}

Attributes:
- quantity (number — amount of ingredient consumed per unit sold)
```

### 5.5 Users Table

```
PK: USER#{userId}
SK: META

Attributes:
- userId (string, UUID)
- name (string)
- pinHash (string, bcrypt)
- role (enum: CASHIER | ADMIN)
- isActive (boolean)
- createdAt (ISO timestamp)
```

### 5.6 Settings Table

```
PK: SETTINGS
SK: CONFIG

Attributes:
- cafeStatus (enum: OPEN | CLOSED)
- celebrationMode (boolean)
- celebrationPrice (number, default 5)
- operatingHours (list: [{start, end}])
- orderExpiryMinutes (number, default 60)
- archiveAfterMinutes (number, default 15)
- restockEmailRecipients (list of emails)
- adminEmailRecipients (list of emails)
```

### 5.7 Activity Log Table

```
PK: LOG#{date}
SK: {timestamp}#{eventId}

Attributes:
- userId (string)
- userName (string)
- action (string)
- details (map)
- timestamp (ISO)
```

## 6. Key Flows

### 6.1 Customer Order Submission

```
1. Client POST /api/orders {customerName, items}
2. Lambda validates:
   - Café is open
   - All items exist and are enabled today
   - Food items: check (foodQuantityToday - foodReserved) >= requested quantity
3. If food items: increment foodReserved count (atomic update)
4. Create order record with status=PENDING, set expiresAt=now+1hr
5. Return orderId + total amount
```

### 6.2 Item Disabled Mid-Service

```
1. Cashier PUT /api/pos/menu/{id}/toggle (disable)
2. Lambda sets isEnabledToday=false
3. Lambda queries all PENDING orders containing this item
4. For each affected order: add "flaggedItems" attribute
5. Customer polling GET /api/orders/{id} sees flaggedItems
6. Customer must remove flagged items before paying
```

### 6.3 Order Approval

```
1. Cashier PUT /api/pos/orders/{id}/approve {discountType?}
2. Lambda:
   - Update status=PREPARING
   - Set approvedBy
   - Calculate discountOffset if newcomer/staff/pastor
   - Deduct ingredients from stock based on recipes
   - Check if any ingredient hit low-stock threshold → trigger email
3. Return updated order
```

### 6.4 Order Expiry

```
- DynamoDB TTL on expiresAt automatically deletes expired orders
- OR: Lambda cron (every 5 min) marks expired orders as EXPIRED and releases food reservations
- Recommendation: Lambda cron approach (need to release foodReserved counts)
```

### 6.5 End-of-Day

```
1. Cashier/Admin closes café (or auto-close at configured time)
2. Lambda:
   - Set cafeStatus=CLOSED
   - Archive any remaining READY orders
   - Expire any remaining PENDING orders, release reservations
   - Generate reconciliation report
   - Send end-of-day email (sales summary, menu changes, inventory status)
```

## 7. Infrastructure (AWS)

### 7.1 Resources

- **API Gateway:** Single REST API with Lambda proxy integration
- **Lambda functions:** Single function (or split by domain: orders, menu, inventory, auth)
- **DynamoDB:** Single-table design or multiple tables (as shown above)
- **EventBridge:** Scheduled rule for order expiry check (every 5 min)
- **IAM:** Lambda execution role with DynamoDB + SES/SMTP access

### 7.2 Deployment

- Infrastructure as Code: **AWS CDK (TypeScript)** — all resources defined in code for easy migration between AWS accounts
- CI/CD: GitHub Actions → auto-deploy frontend to GitHub Pages on push to `frontend/`
- Backend: `cd infra && npx cdk deploy` to update Lambda + API Gateway
- Account migration: Simply configure new AWS credentials and run `cdk deploy` to replicate entire stack
- Frontend URL: https://kuettai.github.io/rlc-cafe-pos/
- API URL: https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod/

### 7.3 Environments

- **Production:** Single environment (low traffic, minimal cost concern)
- **Local dev:** SAM local or LocalStack for testing

## 8. Security

- **Frontend:** No secrets, all logic server-side
- **API Auth:** Lambda authorizer validates JWT on protected endpoints
- **JWT:** Signed with secret stored in Lambda environment variable (or AWS Secrets Manager)
- **PINs:** Stored as bcrypt hashes in DynamoDB
- **CORS:** Restrict to GitHub Pages domain only
- **Rate limiting:** API Gateway throttling (prevent abuse of public order endpoint)

## 9. Monitoring & Alerts

- **CloudWatch:** Lambda errors, API Gateway 4xx/5xx rates
- **DynamoDB:** Consumed capacity monitoring (ensure within free tier)
- **Application:** Low-stock email alerts, end-of-day summary emails

## 10. Future Considerations

- WebSocket (API Gateway WebSocket API) for real-time updates if polling becomes insufficient
- S3 for image uploads (menu item photos)
- CloudFront CDN if GitHub Pages latency is an issue from Malaysia
- Display screen app (TV at counter showing "Ready" orders)
- Customer push notifications via Web Push API

## 11. Current Deployment

| Component | URL/Location |
|-----------|-------------|
| Frontend (Customer + POS) | https://kuettai.github.io/rlc-cafe-pos/ |
| API Gateway | https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod/ |
| GitHub Repo | https://github.com/kuettai/rlc-cafe-pos |
| AWS Region | ap-southeast-5 (Malaysia) |
| AWS Account | 956288449190 |
| CloudFormation Stack | RlcCafeStack |

### Test Credentials
- Admin: userId=`admin-001`, PIN=`123456`
- Cashier: userId=`7cf1994a-4e5d-4603-af7e-475e5043fcde` (Sarah), PIN=`1234`
