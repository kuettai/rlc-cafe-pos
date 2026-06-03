# RLC Café POS — Project Steering

## Project Overview
A Progressive Web App (PWA) for a church café at Oasis of Care (RLC), Petaling Jaya, Malaysia. Replaces Loyverse POS with customer self-ordering, real-time order management, and inventory tracking.

## Architecture
- **Frontend:** Vanilla HTML/CSS/JS PWA hosted on GitHub Pages
- **Backend:** AWS Lambda (Node.js/TypeScript) + API Gateway (proxy integration)
- **Database:** DynamoDB (5 tables: orders, menu, ingredients, users, settings)
- **IaC:** AWS CDK (TypeScript)
- **Region:** ap-southeast-5 (Malaysia)
- **Repo:** https://github.com/kuettai/rlc-cafe-pos

## Live URLs
- Frontend: https://kuettai.github.io/rlc-cafe-pos/
- API: https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod/
- POS: https://kuettai.github.io/rlc-cafe-pos/pos.html

## Test Credentials
- Admin: userId=`admin-001`, PIN=`123456`
- Cashier (Sarah): userId=`7cf1994a-4e5d-4603-af7e-475e5043fcde`, PIN=`1234`

## Project Structure
```
cafepos/
├── .kiro/              # Project context & steering
├── .ref/               # Reference data (stock-check.csv, questionnaire)
├── .github/workflows/  # CI/CD (deploy-pages.yml)
├── backend/src/        # Lambda handlers (TypeScript)
│   ├── index.ts        # Main router with auth middleware
│   ├── expiry.ts       # Order expiry cron (EventBridge, every 5min)
│   ├── lib/            # db.ts (DynamoDB client), auth.ts (JWT/PIN)
│   └── routes/         # auth, cafe, menu, orders, pos, admin
├── frontend/           # PWA (vanilla JS, served via GitHub Pages)
│   ├── index.html      # Customer ordering
│   ├── track.html      # Order tracking (polls every 7s)
│   ├── pos.html        # Cashier POS
│   ├── js/             # app.js, track.js, pos.js, config.js
│   ├── css/style.css   # All styles
│   ├── manifest.json   # PWA manifest
│   └── sw.js           # Service worker
├── infra/              # CDK stack
│   └── lib/infra-stack.ts  # All AWS resources
└── docs/               # Requirements, architecture, user journey
```

## Key Design Decisions
1. **API Gateway proxy integration** — single Lambda handles all routes (avoids 20KB policy limit)
2. **esbuild bundling** — CDK NodejsFunction bundles TypeScript + deps into single file
3. **No Docker** — local esbuild bundling (Docker not available on this machine)
4. **DynamoDB keys:** Orders use PK=`ORDER#{orderId}`, Menu uses PK=`MENU#{menuItemId}`, GSI `status-createdAt-index` for order queries
5. **Auth:** Individual PINs per volunteer → JWT (4hr expiry), role-based (CASHIER/ADMIN)
6. **Polling:** Customer tracks order via 7s polling (no WebSocket)
7. **PWA paths:** GitHub Pages serves from `/rlc-cafe-pos/` prefix

## Development Workflow
- **Local frontend test:** `npm run dev` → http://localhost:3000 (uses live API)
- **Build backend:** `npm run build:backend`
- **Deploy backend:** `npm run deploy:backend` (or `cd infra && npx cdk deploy`)
- **Deploy frontend:** Push to master with changes in `frontend/` → auto-deploys via GitHub Actions
- **Always test locally before pushing frontend changes**

## Coding Conventions
- Backend: TypeScript, async/await, minimal error messages in responses
- Frontend: Vanilla JS (no frameworks), ES6+, mobile-first responsive
- CSS: Semantic class names, POS-specific styles prefixed with `.pos-`
- API responses: `{ statusCode, headers: {}, body: JSON.stringify(...) }`
- Path parameter extraction from `event.path` (not `event.pathParameters`) due to proxy integration

## Current Status (as of 2026-06-03)
### Completed (Foundation)
- ✅ All backend routes (auth, cafe, menu, orders, pos, admin)
- ✅ Customer ordering PWA (menu, cart, order submission)
- ✅ Order tracking page (auto-polls status)
- ✅ Cashier POS (login, order board, approve/ready/undo/reject, walk-up, café controls)
- ✅ CDK infrastructure deployed
- ✅ GitHub Pages CI/CD
- ✅ Variant pricing (e.g., Oat Milk +RM1)
- ✅ Order expiry cron (5min check, 1hr timeout)

### Completed (2026-06-03 Sprint)
- ✅ UI Redesign — warm café theme (browns/cream/caramel) across all pages
- ✅ Admin dashboard page (admin.html) — menu CRUD, ingredients, users, reports, settings, checklist, planogram
- ✅ Food item quantity management UI (POS → Menu panel, 20 food items seeded)
- ✅ Celebration mode pricing reflected on customer menu (flat RM5, crossed-out original)
- ✅ End-of-day close flow (auto-expire orders + reset food quantities)
- ✅ Customer order cancel fix (correct API endpoint)
- ✅ Pin/upsell items feature (POS toggle, customer page ⭐ highlight + sort-to-top)
- ✅ Walk-up order filter (search input + category tabs All/Drinks/Food)
- ✅ POS live stats bar (Pending/Making/Ready/Total/Revenue)
- ✅ POS order history modal with reorder button
- ✅ Order tracking progress stepper (3-step visual)
- ✅ PWA install prompt, service worker v3, manifest shortcuts
- ✅ Keyboard shortcuts for POS (W=Walk-up, M=Menu, H=History, /=Search)
- ✅ Login by name (not just UUID) — backend auth updated
- ✅ Ingredients seeded (18 items from stock-check.csv with usageUnit)
- ✅ POS sound notifications (new order + receipt uploaded)
- ✅ Urgent order highlighting (red pulse if pending >10 min)
- ✅ Duplicate order detection for customers
- ✅ Café Open/Close Checklist (blocking, logged, admin-editable, 3 item types)
- ✅ Payment Receipt Upload (S3 + Bedrock AI extraction, auto-reject if amount mismatch)
- ✅ Planogram Stock Count (multi-photo, AI vision, reference photo, editable results)
- ✅ CDK: S3 buckets (receipts 1-day, planogram 4-week) + Bedrock permissions
- ✅ Unit tests (auth, router) + Integration tests (21 tests against live API)
- ✅ Backend compiles clean, all 33 tests passing

### Completed (2026-06-03)
- ✅ Admin dashboard page (admin.html) — menu CRUD, ingredients, users, reports, settings
- ✅ Food item quantity management UI (POS → Menu panel)
- ✅ Celebration mode pricing reflected on customer menu
- ✅ End-of-day close flow (auto-expire remaining orders + reset food)
- ✅ Customer order cancel fix
- ✅ Pin/upsell items feature
- ✅ Walk-up order filter (search + category tabs)
- ✅ POS live stats, order history, reorder
- ✅ Order tracking progress stepper
- ✅ PWA install prompt, service worker v2, manifest shortcuts
- ✅ Keyboard shortcuts for POS
- ✅ Login by name (not just UUID)

### TODO — Easy
- [ ] Café Open/Close Checklist — configurable list of tasks for cashier to tick off before opening (e.g., "turn on machine", "fill ice", "check milk") and after closing (e.g., "wipe counter", "empty grounds", "lock fridge"). Editable by Admin in settings.

### TODO — Medium
- [ ] Payment Receipt Upload — customer uploads DuitNow screenshot on track page, backend invokes Bedrock Claude to extract payment amount, auto-attaches to order with badge + distinct sound on POS card. Cashier still manually approves. Requires: S3 bucket for receipts, Bedrock API call, new field `receiptUrl` + `receiptAmount` on order.
- [ ] Recipe-based ingredient deduction on order approval
- [ ] Email notifications (low stock, end-of-day summary)

### TODO — Complex
- [ ] Planogram Stock Count — upload multiple fridge/shelf photos from POS or Admin, invoke Bedrock Claude Vision to count bottles/items by type, suggest stock levels. S3 storage with 1-day lifecycle policy. Requires: S3 bucket, Bedrock multimodal API, UI for photo capture + review of AI suggestions before committing stock.

### TODO — Polish
- [ ] PWA icons (192x192, 512x512)
- [ ] Customer order modify UI
- [ ] Better error handling, loading states

## Important Context
- Church café operates Sundays only: 10:15-11:30 and 12:45-13:30
- ~2-3 volunteers per shift (1 cashier, 1-2 baristas)
- Payment: Maybank QR (DuitNow), manually verified by cashier
- Special pricing: Celebration (all drinks RM5), Newcomer (free), Staff/Pastor (walk-up only)
- Inventory: recipe-based estimation, cashier manual override
- Menu: ~10 drinks (hot/iced variants, oat milk option) + food (subject to availability)
