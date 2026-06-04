# RLC Café POS — Architecture Document

## 1. System Overview

```
┌────────────────────────────────────────────────────────────────────┐
│            GitHub Pages (153.oasisofcare.org)                        │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐             │
│  │ Customer │ │ Cashier  │ │  Admin   │ │ Barista  │             │
│  │   PWA    │ │   POS    │ │Dashboard │ │Prep View │             │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘             │
└───────┼─────────────┼────────────┼─────────────┼──────────────────┘
        │             │            │             │
        │          HTTPS (REST API)              │
        ▼             ▼            ▼             ▼
┌────────────────────────────────────────────────────────────────────┐
│                    AWS API Gateway (REST, proxy)                     │
└───────────────────────────┬────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│                      AWS Lambda (single function)                    │
│                                                                     │
│  ┌────────┐ ┌──────┐ ┌──────────┐ ┌──────┐ ┌──────────────────┐  │
│  │ Orders │ │ Menu │ │Inventory │ │ Auth │ │ Checklist/Recipes│  │
│  ├────────┤ ├──────┤ ├──────────┤ ├──────┤ ├──────────────────┤  │
│  │Receipt │ │ POS  │ │Planogram │ │Admin │ │  Cafe/Expiry     │  │
│  └───┬────┘ └──┬───┘ └────┬─────┘ └──┬───┘ └────────┬─────────┘  │
└──────┼─────────┼──────────┼──────────┼───────────────┼─────────────┘
       │         │          │          │               │
       ▼         ▼          ▼          ▼               ▼
┌────────────────────────────────────────────────────────────────────┐
│                         AWS DynamoDB                                 │
│  ┌────────┐ ┌──────┐ ┌───────────┐ ┌──────┐ ┌──────────┐         │
│  │ Orders │ │ Menu │ │Ingredients│ │Users │ │ Settings │         │
│  └────────┘ └──────┘ └───────────┘ └──────┘ └──────────┘         │
└────────────────────────────────────────────────────────────────────┘

┌─────────────────────┐   ┌──────────────────────────────────┐
│   AWS S3 Buckets    │   │      AWS Bedrock (Claude)        │
│  ┌───────────────┐  │   │                                  │
│  │ rlc-receipts  │  │   │  • Receipt amount extraction     │
│  │  (1-day TTL)  │  │   │  • Planogram stock count (vision)│
│  ├───────────────┤  │   │  • Model: Claude Sonnet 4.6      │
│  │rlc-planogram  │  │   │                                  │
│  │ (28-day TTL)  │  │   └──────────────────────────────────┘
│  └───────────────┘  │
└─────────────────────┘
```

## 2. Tech Stack

| Layer | Technology | Free Tier Type | Cost |
|-------|-----------|----------------|------|
| Frontend hosting | GitHub Pages | Always free | RM0 |
| Frontend framework | Vanilla JS (no framework) | N/A | RM0 |
| PWA | Service Worker + manifest.json | N/A | RM0 |
| API | AWS API Gateway (REST, proxy) | $200 credit (6 months) | ~RM0.01/month |
| Compute | AWS Lambda (Node.js 20) | Always free (1M req/month) | RM0 |
| Database | AWS DynamoDB | Always free (25GB) | RM0 |
| Storage | AWS S3 (receipts + planogram) | 5GB free | ~RM0 |
| AI/Vision | AWS Bedrock (Claude Sonnet 4.6) | Pay per use | ~RM2-3/month |
| Email | Gmail SMTP (future) | Always free | RM0 |
| Domain | 153.oasisofcare.org (CNAME) | N/A | Existing |

**Estimated monthly cost: ~RM3-5/month** (mostly Bedrock vision calls for planogram: ~32 images/month × ~RM0.10 each. Everything else is effectively free at church café volume.)

> **Note:** AWS free tier details as of July 2025. Lambda (1M requests/month) and DynamoDB (25GB + 25 RCU/WCU) are **always free** with no expiry. API Gateway moved to a credit-based model for new accounts ($200 credits, 6-month free plan). After credits expire, cost is ~$1 per 1M API calls — effectively zero at church café volume.

## 3. Frontend Architecture

### 3.1 Routes

| Path | View | Auth Required |
|------|------|---------------|
| `/` | Customer — Menu & ordering | No |
| `/track.html?id=xxx` | Customer — Order tracking + receipt upload | No |
| `/pos.html` | Cashier — Order board, walk-up, menu mgmt | PIN login |
| `/admin.html` | Admin — Menu CRUD, ingredients, recipes, checklist, planogram, reports | PIN login (ADMIN role) |
| `/prep.html` | Barista — Prep queue (large text, dark theme) | PIN login (shared session) |

### 3.2 Hosting

- **Primary URL:** https://153.oasisofcare.org/
- **Fallback URL:** https://kuettai.github.io/rlc-cafe-pos/
- **Deployment:** GitHub Actions auto-deploys on push to `frontend/`
- **Repo:** https://github.com/kuettai/rlc-cafe-pos
- **CNAME:** `153.oasisofcare.org` → `kuettai.github.io`

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

## 7. Infrastructure (AWS CDK)

### 7.1 Resources

- **API Gateway:** Single REST API with Lambda proxy integration (all CORS)
- **Lambda:** Single bundled function (esbuild, Node.js 20, 256MB, 10s timeout)
- **Lambda (expiry):** Cron function for order expiry (128MB, 30s, every 5 min)
- **DynamoDB:** 5 tables (orders, menu, ingredients, users, settings) — PAY_PER_REQUEST
- **S3 (receipts):** `rlc-cafe-receipts-{account}` — 1-day lifecycle, CORS
- **S3 (planogram):** `rlc-cafe-planogram-{account}` — 28-day lifecycle, CORS
- **EventBridge:** Scheduled rule for order expiry (every 5 min)
- **IAM:** Lambda role with DynamoDB RW + S3 RW + Bedrock InvokeModel
- **Bedrock:** Claude Sonnet 4.6 (global inference profile)

### 7.2 Deployment

- Infrastructure as Code: **AWS CDK (TypeScript)** — `infra/lib/infra-stack.ts`
- Account/Region: `956288449190` / `ap-southeast-5` (hardcoded in `bin/infra.ts`)
- CI/CD: GitHub Actions → auto-deploy frontend on push to `frontend/`
- Backend deploy: `cd infra && npx cdk deploy`
- Frontend URL: https://153.oasisofcare.org/
- API URL: https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod/

### 7.3 Environments

- **Production:** Single environment (low traffic, minimal cost)
- **Local dev:** `npx http-server frontend -p 3001` + live API
- **Tests:** `cd backend && npm test` (unit + integration against live API)

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

## 10. AI Integration

### 10.1 Payment Receipt Verification
- Customer uploads receipt screenshot → Lambda sends to Bedrock
- Claude extracts: amount, date/time, transaction reference number
- Validation: amount match, time window (30 min), duplicate detection (reference uniqueness)
- Auto-reject on mismatch (cashier not notified for failed uploads)

### 10.2 Planogram Stock Count
- Cashier takes 1-3 photos of fridge/storeroom
- Lambda sends photos + reference layout + ingredient list to Bedrock
- Claude Vision identifies items, counts units, estimates fill levels
- Returns editable results with confidence indicators
- Cashier confirms → stock levels updated

## 11. Future Considerations

- WebSocket for real-time updates (if polling insufficient)
- CloudFront CDN (if GitHub Pages latency an issue)
- Display screen app (TV showing "Ready" orders)
- Customer push notifications (Web Push API)
- Email notifications (low stock, end-of-day summary)
- Multi-site support (if café expands)

## 12. Current Deployment

| Component | URL/Location |
|-----------|-------------|
| Frontend (Customer) | https://153.oasisofcare.org/ |
| Frontend (POS) | https://153.oasisofcare.org/pos.html |
| Frontend (Admin) | https://153.oasisofcare.org/admin.html |
| Frontend (Barista) | https://153.oasisofcare.org/prep.html |
| API Gateway | https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod/ |
| GitHub Repo | https://github.com/kuettai/rlc-cafe-pos |
| AWS Region | ap-southeast-5 (Malaysia) |
| AWS Account | 956288449190 |
| CloudFormation Stack | RlcCafeStack |

### Credentials
- Admin: name=`admin-001` or `Admin`, PIN=`123456`
- Cashier: name=`Sarah`, PIN=`1234`
