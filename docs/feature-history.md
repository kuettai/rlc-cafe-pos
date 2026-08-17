# Feature History

Sprint-by-sprint completion log, moved out of `.kiro/steering.md` so it does not
consume context on every turn. See `docs/update-YYYYMMDD.md` for session detail.

## Current Status (as of 2026-08-17)
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


### Completed (2026-08-17 Sprint — v1.71.0)
From the WhatsApp thread with RLC CG, 2026-08-16. Spec and dependency graph:
`docs/graph-spec-20260817.md`; session detail: `docs/update-20260817.md`.
- ✅ T2 Staff ordering link (`?code=<CODE>`) — staff self-order at the staff rate (drinks RM5, food full price) instead of queueing for a cashier-built walk-up. New `STAFF_CODE#` settings record, new `backend/src/routes/staffcode.ts`, new Admin > Staff Link tab (`frontend/js/admin-stafflink.js`, single-entry upsert, enable toggle + inclusive start/end date gate in MYT). The customer only **requests** the price: the order is stored priced but the cashier is prompted at approve, and declining reverts to celebration-or-full via the new `baseUnitPrice` item field. `approvedBy` + `staffPriceGranted` on the APPROVE audit line either way
- ✅ T4 Ministry pre-orders are editable — created **PENDING** instead of PREPARING, so the existing customer Edit Order flow and its race-safe `#s = :pending` gate apply unchanged. Previously a pre-order was uneditable from the moment it was placed and volunteers deleted it in the POS to make the customer re-order
- ✅ Pre-order "release to barista" is the lock — the ordinary approve, renamed in the POS, plus a new bulk `PUT /api/pos/preorders/release-all` (today's pre-orders only, `isPreOrder`-filtered, paginated, shares the single-order helper). No scheduled auto-release, by design
- ✅ New system-only `PREORDER` pricing class (`discountType: 'MINISTRY_PREORDER'`) keeps pre-orders free through both the edit and the release paths; `parseCustomerClass` refuses it from a request body
- ✅ Create/edit parity for pre-orders — `modifyOrder` now re-enforces drinks-only, `eligibleItems` and `excludedOptions`, which `createOrder` enforced and the edit endpoint did not (an uncapped-cost bypass on a free order)
- ✅ Fix: closing the café no longer expires every outstanding pre-order (`closeCafe` queried PENDING unbounded by date and had no `isPreOrder` guard)
- ✅ Fix: `track.js` set `isEditing` but never read it, so the 7s poll silently discarded a customer's in-progress edit — affected all customer edits, not just pre-orders
- ✅ T3 Edit Order affordance surfaced on the order confirmation screen, not only `track.html` (the feature already existed; this was discoverability)
- ✅ T1 Admin > Checklist reordering — drag the ⠿ handle (pointer events, not HTML5 drag, which is unreliable on the counter iPad) or use ▲▼, within a phase only. Frontend-only: order is array position, and the whole-array `PutCommand` round-trips it
- ✅ Test coverage from a mutation audit — `staff-code.test.ts`, `preorder-pending.test.ts`, `preorder-pending-gaps.test.ts`; offline suites 187 → 276 tests

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
- Special pricing: Celebration (all drinks RM5), Newcomer (free), Pastor (walk-up only),
  Staff (walk-up, or self-requested via the staff link `?code=<CODE>` and confirmed by the cashier at approval)
- Inventory: recipe-based estimation, cashier manual override
- Menu: ~10 drinks (variant groups: Temperature hot/iced, Milk oat milk, Flavor for tea/soda) + food (subject to availability)
