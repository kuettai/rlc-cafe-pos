# RLC Café POS — Project Steering

## Project Overview
A Progressive Web App (PWA) for a church café at Oasis of Care (RLC), Petaling Jaya, Malaysia. Replaces Loyverse POS with customer self-ordering, real-time order management, and inventory tracking.

## Architecture
- **Frontend:** Vanilla HTML/CSS/JS PWA hosted on GitHub Pages
- **Backend:** AWS Lambda (Node.js/TypeScript) + API Gateway (proxy integration)
- **Database:** DynamoDB (7 tables: orders, menu, ingredients, users, settings, customers, vouchers)
- **IaC:** AWS CDK (TypeScript)
- **Region:** ap-southeast-5 (Malaysia)
- **Repo:** https://github.com/kuettai/rlc-cafe-pos

## Live URLs
- Frontend (custom domain): https://153.oasisofcare.org/
- Frontend (GitHub Pages): https://kuettai.github.io/rlc-cafe-pos/
- API: https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod/
- POS: https://153.oasisofcare.org/pos.html
- Admin: https://153.oasisofcare.org/admin.html
- Customer: https://153.oasisofcare.org/

## Test Credentials
- Admin: userId=`admin-001`, PIN=`123456`
- Cashier (Sarah): userId=`7cf1994a-4e5d-4603-af7e-475e5043fcde`, PIN=`1234`

## Project Structure
```
cafepos/
├── .kiro/              # Project context & steering
├── .ref/               # Reference data (stock-check.csv, questionnaires)
├── .github/workflows/  # CI/CD (deploy-pages.yml)
├── backend/src/        # Lambda handlers (TypeScript)
│   ├── index.ts        # Main router with auth middleware
│   ├── expiry.ts       # Order expiry cron (EventBridge, every 5min)
│   ├── lib/            # db.ts (DynamoDB client), auth.ts (JWT/PIN), audit.ts (order logging), phone.ts (Malaysian phone normalizer), push.ts (web-push helper)
│   ├── routes/         # auth, cafe, menu, orders, pos, admin, checklist, receipt, planogram, customers, vouchers, preorder, push, display, verses
│   └── tests/          # Jest unit + integration tests
├── frontend/           # PWA (vanilla JS, served via GitHub Pages)
│   ├── index.html      # Customer ordering
│   ├── track.html      # Order tracking (polls every 7s) + receipt upload
│   ├── pos.html        # Cashier POS
│   ├── admin.html      # Admin dashboard
│   ├── display.html    # TV Display screen (ready orders + promo slideshow)
│   ├── reports.html    # Reports page
│   ├── js/             # app.js, track.js, pos.js, admin.js, config.js, admin-vouchers.js, admin-preorder.js, admin-display.js, admin-verses.js, admin-checklist.js, admin-dashboard.js, admin-menu.js, admin-ingredients.js, pos-voucher.js, pos-training.js, pos-stock.js, pos-history.js, pos-checklist.js, pos-walkup.js, phone.js, display.js, variants.js, changelog.js
│   ├── css/            # style.css, admin.css
│   ├── img/            # QR payment image
│   ├── manifest.json   # PWA manifest
│   ├── sw.js           # Service worker (v16)
│   └── CNAME           # Custom domain: 153.oasisofcare.org
├── infra/              # CDK stack
│   └── lib/infra-stack.ts  # DynamoDB, Lambda, API GW, S3, Bedrock perms
└── docs/               # Requirements, architecture, user journey, problem statement
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
- **Local frontend test:** `npx http-server frontend -p 3001` → http://localhost:3001 (uses live API)
- **Run tests:** `cd backend && npm test`
- **Deploy backend:** `cd infra && npx cdk deploy` (requires AWS credentials, region: ap-southeast-5)
- **Deploy frontend:** Push to master with changes in `frontend/` → auto-deploys via GitHub Actions to 153.oasisofcare.org
- **Always test locally before pushing frontend changes**
- **CDK account/region:** 956288449190 / ap-southeast-5 (hardcoded in bin/infra.ts)

## Coding Conventions
- Backend: TypeScript, async/await, minimal error messages in responses
- Frontend: Vanilla JS (no frameworks), ES6+, mobile-first responsive
- CSS: Semantic class names, POS-specific styles prefixed with `.pos-`
- API responses: `{ statusCode, headers: {}, body: JSON.stringify(...) }`
- Path parameter extraction from `event.path` (not `event.pathParameters`) due to proxy integration

## Versioning & Release Notes
- **Update documents:** Create `update-YYYYMMDD.md` in project root for each work session. Include: analysis, findings, fixes applied, features implemented, and remaining items.
- **Service worker version:** Bump `sw.js` cache version (currently v16) on every frontend deploy that changes cached assets.
- **Changelog:** `frontend/changelog.json` tracks user-visible changes shown in the PWA changelog modal. Add entries for features/fixes visible to end users.
- **Backend deploys:** No semantic versioning — deploy via `cdk deploy`. Breaking API changes should be documented in the update file.
- **Frontend deploys:** Push to master triggers GitHub Actions. Always bump SW version if JS/CSS/HTML changed.
- **Task tracking:** `tasks.md` in root tracks open bugs, features, and cosmetic items. Update after each session.

## Current Status (as of 2026-07-19)
### Completed (Foundation)
- ✅ All backend routes (auth, cafe, menu, orders, pos, admin)
- ✅ Customer ordering PWA (menu, cart, order submission)
- ✅ Order tracking page (auto-polls status)
- ✅ Cashier POS (login, order board, approve/ready/undo/reject, walk-up, café controls)
- ✅ CDK infrastructure deployed
- ✅ GitHub Pages CI/CD
- ✅ Variant pricing (e.g., Oat Milk +RM1)
- ✅ Order expiry cron (5min check, 1hr timeout)

### Completed (2026-06-04 Sprint)
- ✅ Variant Groups system — Temperature (single), Milk (optional), Flavor (single) selectors
- ✅ Menu restructuring: merged 5 sodas → single "Soda (Iced)" with Flavor picker
- ✅ Renamed iced/hot-only drinks: Tonic Espresso (Iced), Citrus Black (Iced), Fruit Tea (Hot)
- ✅ Added Iced option (+RM1) to Tea
- ✅ Backend supports selectedVariants array in order price calculation (backward compat with old variant field)
- ✅ Force PIN update feature (forceUpdatePin) — new users must change PIN on first login
- ✅ Last login tracking (lastLoginAt) displayed in admin Volunteers
- ✅ Volunteer filter buttons (All / Cashier / Admin / Never Logged In)
- ✅ Clipboard copy of access credentials on volunteer create/edit
- ✅ POS sidebar closed by default, opens only on hamburger tap
- ✅ POS order items displayed as list view (not comma-separated)
- ✅ POS Menu sort: Drinks (Long Black/Latte first, then alpha), Food (pinned > qty > alpha)
- ✅ POS view toggle button styled to match café theme
- ✅ Admin card badges center-aligned
- ✅ Service worker cache bump (v16)

### Completed (Post-June Sprint)
- ✅ Customer CRM — phone-based registration, order linking, lookup, order history
- ✅ Voucher system — campaigns, assign (individual + CSV bulk), redeem at POS, void
- ✅ Pre-order codes — generate shareable links, validate, auto-remark orders
- ✅ Push notifications — Web Push API, subscribe per order, VAPID keys
- ✅ TV Display screen — ready orders board + promo slideshow (S3 presigned URLs)
- ✅ Bible verses — admin CRUD, random verse on payment screen
- ✅ Featured drink — POS set/unset, admin audit log
- ✅ Stock history — cashier snapshots, admin date-picker view
- ✅ Reports expansion — discounts report, session breakdown (S1/S2), monthly report, restock recommendations
- ✅ POS improvements — shift summary, bulk stock update, onboarding flow, archive orders, cancel-completed
- ✅ Admin improvements — bulk menu toggle, duplicate food, ingredient toggle-active, user reset-onboarding, pre-order templates
- ✅ Display slides admin — upload to S3 via presigned URL, manage slideshow
- ✅ Origin verification — CloudFront-ready X-Origin-Verify header check (feature-flagged off)
- ✅ Audit logging — structured CloudWatch logs for all order mutations
- ✅ Malaysian phone normalizer — consistent 0xxxxxxxxx format

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


### TODO — Remaining
- [ ] Email notifications (low stock alert, end-of-day summary to admin)
- ✅ Customer order modify UI (change items while order is still PENDING) — Tier 1 (race-safe + cashier indicators), Tier 2 (add items + notes), Tier 3 (variant editing via shared variants.js)
- [ ] Stock history & consumption trends (graph of usage over weeks)
- [ ] Weekly/monthly sales summary report
- [ ] Item-disabled notification to customers with that item in pending orders
- [ ] Better error handling, loading states

## Important Context
- Church café operates Sundays only: 10:15-11:30 and 12:45-13:30
- ~2-3 volunteers per shift (1 cashier, 1-2 baristas)
- Payment: Maybank QR (DuitNow), manually verified by cashier
- Special pricing: Celebration (all drinks RM5), Newcomer (free), Staff/Pastor (walk-up only)
- Inventory: recipe-based estimation, cashier manual override
- Menu: ~10 drinks (variant groups: Temperature hot/iced, Milk oat milk, Flavor for tea/soda) + food (subject to availability)
