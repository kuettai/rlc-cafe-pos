# Feature History

Sprint-by-sprint completion log, moved out of `.kiro/steering.md` so it does not
consume context on every turn. See `docs/update-YYYYMMDD.md` for session detail.

## Current Status (as of 2026-08-19)
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
- ✅ Push notifications — Web Push API, subscribe per order, VAPID keys (built here, but **dead in production until v1.73.0** — the keys were wipeable Lambda env vars and the failure was silent)
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

### Completed (2026-08-17 Sprint — v1.72.0)
Second release of the same day, on top of v1.71.0. Session detail:
`docs/update-20260817.md`.
- ✅ Admin Dashboard restructured from eight equal-weight sections into two zones — a compact live "Right now" strip (pending, preparing, oldest wait) shown **only** when the selected date is today, then an analysis zone led by revenue. Sunday page height 4006px → 3087px
- ✅ Three new visualisations, plain HTML/CSS with **no charting library**: order-source stacked bar, top items as horizontal bars, and session comparison as two small charts — orders and revenue on separate scales, deliberately not a dual-axis chart
- ✅ **Order-source breakdown** (requested by the café) — how many of the day's orders were walk-ins at the counter, ministry pre-orders, or placed by customers on their phones. Derived client-side from `isWalkUp` / `isPreOrder` over the same non-cancelled/non-expired statuses as the headline count, so the three segments sum to it exactly. No backend change
- ✅ Zero-order dates collapse to a single line instead of four empty panels; `Latest Stock Count` is now a collapsed `<details>`; headings name the date being viewed, so a past Sunday no longer says "Today's Discounts"
- ✅ Fixed two unescaped interpolations in `featuredAuditHtml` and removed a duplicate `fmtTime`
- ✅ **Fix: the Sunday end-of-day revenue email works again.** `closeCafe` fired it un-awaited after returning its response; Lambda freezes the sandbox at that point, so the promise completed only if later traffic happened to thaw the same sandbox. It survived 2026-08-02 (+50s) and 2026-08-09 (+4m39s) and produced nothing at all on 2026-08-16. The summary moved into the expiry cron: awaited, logged on every path, gated on `cafeStatus === 'CLOSED'` plus Sunday and 2pm-MYT, with a `DAILY_SUMMARY#{date}` marker written only after a confirmed send (so a failure retries instead of vanishing). New `backend/src/lib/daily-summary.ts`
- ✅ EventBridge expiry cron widened `cron(0/30 1-7 ? * SUN *)` → `1-9` (9am–5pm MYT) so a café closed after 3:30pm still has a run left to carry the summary. **CDK change — backend deploy required**
- ✅ **Fix: the email subject was dated a day early** ("Saturday, 1 August" for the 2 August service) because `formatDate` called `toLocaleDateString` with no `timeZone`, so it rendered in the runtime's zone — UTC on Lambda. Now pinned to `Asia/Kuala_Lumpur`
- ✅ New `backend/src/lib/date.ts` as the single source of truth for the UTC+8 conversion (`malaysiaToday` / `malaysiaClock` / `malaysiaDayStartUtc`), extracted from `routes/staffcode.ts`, which re-exports it
- ✅ `npm test` is now `TZ=UTC jest` — the date test had passed against the broken code because the dev machine's zone is already `Asia/Kuala_Lumpur`, which is how the bug survived. New `daily-summary-cron.test.ts` and `email-date.test.ts`

### Completed (2026-08-17 Sprint — v1.73.0)
Third release of the same day, on top of v1.72.0. Session detail:
`docs/update-20260817.md`.
- ✅ **Fix: web push was dead in production and is now working.** `lib/push.ts` read the VAPID keys from Lambda env vars that `infra-stack.ts` defaulted to `''`, so any `cdk deploy` from a shell that had not exported them wiped the live keys; `push.ts` then hit `if (!VAPID_PUBLIC || !VAPID_PRIVATE) return; // skip silently` and `GET /api/push/vapid-public-key` returned `500` for weeks. Customer-visible shape: `track.js` offered the notifications banner, the customer **granted browser permission**, `subscribe()` then failed on an undefined key — the one notification permission they will ever grant, spent for nothing
- ✅ VAPID config moved to SSM under `/rlc-cafe/` (`VAPID_PUBLIC_KEY` String, `VAPID_PRIVATE_KEY` SecureString, `VAPID_SUBJECT` String), read through a new awaited, cached `ensureVapidConfigured()`. All three `VAPID_*` env vars removed from the Lambda, so there is nothing left for a fresh deploy shell to wipe. **CDK change — backend deploy required**
- ✅ The silent `return` is gone: a missing or malformed config now `console.error`s and names **which half** is missing, plus the SSM path it looked in
- ✅ `routes/push.ts` no longer reads the env var directly — the endpoint answers only once web-push has accepted the whole triple, so it can never serve a public key whose private half is absent (which would produce a browser subscription undeliverable forever)
- ✅ `VAPID_SUBJECT` changed from `mailto:admin@rlccafe.com` (a domain the project does not own) to `https://153.oasisofcare.org`
- ✅ `ORIGIN_VERIFY_SECRET` no longer silently defaults to the committed literal `CHANGE_ME_WHEN_CLOUDFRONT_ENABLED`; it is `requireSecret`d when `ENFORCE_ORIGIN_HEADER === 'true'`, not emitted otherwise, and the placeholder is denylisted
- ✅ **A second latent copy of the same bug, found and fixed:** `getEmailConfig` called `GetParametersByPath` with no pagination. Default page size is 10 and `/rlc-cafe/` already holds 7 — three more parameters and the end-of-day email would have failed in the identical indistinguishable way. Both configs now share one paginated, 5-minute-cached fetch
- ✅ New `backend/tests/push-vapid.test.ts` (16 tests); offline suites 304 → 320 tests. `docs/deployment.md` gained a **Runtime configuration** section — the `/rlc-cafe/` parameters were documented nowhere

### Completed (2026-08-18 Sprint — v1.74.0)
Session detail: `docs/update-20260817.md` (the 2026-08-18 work is appended to that
file rather than split out). UX audit: `docs/pos-ux-audit-20260818.md`.
- ✅ **Per-item special requests (T5).** `notes` was a single per-**order** string, so a customer ordering three drinks could not say "less sugar" about one of them — they had to write it into the order note and hope the barista worked out which cup. Now `items[].note`, capped at **80 trimmed characters**, validated server-side by one `validateItemNote` shared between `createOrder` and `modifyOrder` (create/edit parity) and raised as 400 **before any DynamoDB write**, so a rejected note cannot leave `foodReserved` moved. Attached **only when non-empty**, so records for orders without item notes are byte-identical to before — **no migration, no backfill**
- ✅ The customer cart **no longer merges identical drinks**: every drink is its own line at `qty: 1` with its own always-visible note field, and the redundant per-line quantity controls are gone. Chosen knowingly — orders are mostly a single drink, and per-line notes are worth more than per-line quantity. A one-time expansion splits legacy `localStorage` carts. The order-level box remains for whole-order requests, relabelled so the two roles are unambiguous
- ✅ Notes render on the POS queue card, the POS order detail, the in-POS prep view and `frontend/prep.html` — prefixed 📝 and coloured differently so the cashier can tell an item note from the order note lower down the card
- ✅ **Pre-order collection time is now editable (follow-up b).** The person who placed a ministry pre-order can change their collection time when they edit it, validated server-side against the `collectionOptions` allowlist already stored on the `PREORDER_CODE#` record. The `notes` prefix is rebuilt through the existing `preorderNotesPrefix` / `composePreorderNotes` / `splitPreorderNotes` helpers — **no `collectionTime` attribute was added** (decided against) and **`expiresAt` is untouched**, so the pre-order TTL exception is unaffected. `createOrder` had also been accepting an arbitrary `collectionTime`, so the same validator was applied there too under create/edit parity
- ✅ **Security: stored XSS in the cashier's authenticated POS session, fixed.** `customerName`, `items[].name`, `items[].variant` and `notes` were raw `innerHTML` interpolations on the POS queue card, the order detail and the in-POS prep view; `frontend/prep.html` escaped nothing at all. **Verified exploitable** — an `<img src=x onerror=…>` customer name executed. The POS session holds a **CASHIER JWT**, so this was privilege-bearing, not cosmetic
- ✅ **Security: stored XSS in Admin, fixed.** A checklist label of `5" onmouseover="window.__XSS=1` produced **a real event handler that fired on hover**; same pattern in the menu, ingredients, users and verses tabs. This had been triaged in follow-up (e) as "a mangled form rather than an XSS" — **that was wrong**, and the correction is recorded
- ✅ **The shape of both bugs is the lesson:** in each case a correct escaper *already existed in the same file and was already used correctly a few lines away* — `escapeHtmlPos` in `pos.js`, `mfEsc` in `admin-menu.js` — and had simply never been applied to the **older** hot path. The same `customerName` was escaped in the v1.71 dialogs and not on the card behind them. Recorded as an invariant: **escaping is a property of the render site, not of the field**
- ✅ Three byte-identical admin escaper copies consolidated to one canonical `escapeHtml` / `escapeAttr` in `admin.js`. Two existed **only** to work around script ordering; `admin-vouchers.js` loads after most of its ~25 callers and had been relying on cross-file function hoisting
- ✅ Two new **fully offline** suites — `backend/tests/item-notes.test.ts` (31) and `preorder-collection-time.test.ts` (70). They mock `lib/db`, need no credentials, write nothing to production and need no `ZZTEST_` marker. Offline suites 320 → 421 tests, 0 regressions
- 📋 **POS UX audit scored 20/40, "acceptable, bottom edge"** — weakest on Visibility of System Status (1/4) and Error Recovery (1/4). Headline P0: **a failed fetch renders an empty board indistinguishable from "no orders"**, with the only warning visible ≈43% of the time over a green OPEN badge. Read the audit's method caveats before acting on any finding: rush states were **simulated**, the detector ran **degraded**, and it was **Chromium at iPad viewports, not real iOS Safari**. It carries an open product question — single FIFO list vs three columns — that should be settled **before** further kanban styling work

### Completed (2026-08-18 Sprint — v1.75.0)
Second release of 2026-08-18, on top of v1.74.0 (which had not yet been pushed —
one deploy shipped both). Frontend only: **no `backend/src/` file changed.**
Session detail: `docs/update-20260817.md`. Audit that motivated the POS half:
`docs/pos-ux-audit-20260818.md`.
- ✅ **POS cashier board overhaul**, built from a mock the user previewed and approved. The audit's open product question is now **decided: the three-lane kanban stays, repaired — the single-FIFO-list alternative was rejected**, because an order placed and never paid would permanently occupy the first row. Record that reasoning; it will come up again
- ✅ **Queue order fixed, from ONE shared comparator: receipt-first, then oldest-first.** Pending had sorted **newest-first**, Preparing and Ready had **no sort at all**, and the list view sorted differently again — so a 17-minute order that had already fired the urgent chime rendered **sixth, ~1100px below the fold**. The board's whole job is answering "who has waited longest", and it was answering the opposite
- ✅ **A persistent stale/connection-lost state — the audit's headline P0.** A failed fetch rendered an **empty board under a green OPEN badge**, indistinguishable from "no orders", warned only by a toast that auto-hid after 3s against a 7s poll (visible ≈43% of the time). Now the lanes always render, the header badge flips to "LAST SEEN OPEN · &lt;time&gt;", a persistent panel states the data's age and offers Retry, and mutating controls go inert rather than acting on figures known to be stale
- ✅ Sticky lane headers with per-lane scroll, and `minmax(0,1fr)` so one long customer name can no longer crush the other two lanes to ~110px
- ✅ A real `:disabled` style, generalised from the single `.pos-btn-preorder-release[disabled]` rule that already existed — disabled primaries had been rendering as a full brown gradient with `cursor:pointer`, i.e. indistinguishable from enabled
- ✅ Contrast: lane headers 2.95:1 → 6.46:1, 3.85:1 → 6.77:1, 4.75:1 → 8.01:1; wait time 2.54:1 → 6.89:1. **Every `#9CA3AF` removed.** Approve and Ready differentiated by colour, and card hierarchy lifted so the drinks are no longer the quietest text on the card — **except on Ready cards, where the customer name is promoted instead**, because the job there is calling a name across a room
- ✅ Sidebar docked at ≥900px. It had stayed off-screen at **every** width, so the empty state's "Tap Open to start service" named a button sitting at `left:-212px`
- ✅ Stats strip visible by default with receipt/pre-order flags; a teaching empty state; the list view no longer snaps back to the Pending tab every 7s; the sidebar status dot no longer contradicts the header badge; Logout guarded — it had been one unguarded tap mid-service — via a new in-app `posConfirm()` rather than `window.confirm`
- ✅ **Opening checklist made completable**: "N of M done" counter, progress bar, an explicit "N more below" affordance, a submit label reading "☀️ Open Café — 4 items left", and tapping it while blocked scrolls to and highlights the first unchecked row instead of doing nothing. The 12-item list had shown **8**, and the four hidden ones included "Enable menu items & food quantities in POS". Plus a guard so an empty checklist config can no longer disable Open Café forever
- ✅ **Admin: the Menu tab had been editing two different flags with one visual language.** The row switch sets `isActive` (permanent catalogue), the bulk buttons set `isEnabledToday` (today only), and every badge, count and filter drew `isActive` **alone** — so "Disable All" produced **zero visible change and no toast**, and "Enabled Only (32)" counted catalogue items while the operator read it as "32 serving today". Both flags are now named and drawn per row with state pills and a "why" line, the summary line is corrected, there are six symmetric bulk actions each with confirmation and a result toast, and Delete is demoted and confirmed **by name**. The user chose "name both flags per row" over a separate today-only screen
- ✅ **A leave guard with a change count.** There had been **no dirty-state tracking anywhere in the admin**, so switching tabs silently discarded edits. One registry, applied to Checklist and Settings and structured so other tabs can opt in; reverting an edit puts the guard back to sleep
- ✅ Admin sidebar: all 14 destinations reachable at 1024×768 — Logout had been **245px below the fold with no scroll cue**. Disabled item rows are now tinted rather than faded: item name 2.20:1 → **5.62:1**, subtitle 2.29:1 → 5.62:1, `badge-food` 2.86:1 → 6.46:1, Logout 4.63:1 → 8.80:1
- ✅ Admin Checklist: label on its own line (it had shown ~110px of visible text across 34 items), a sticky save bar with a live count, and two-tap Remove. Drag and ▲▼ reordering untouched
- ✅ **Zero touch targets under 44px on either surface.** The admin `.toggle-switch` had been 42×24 across ~130 instances
- ✅ **Fix: "today" was derived from UTC in 8 admin sites**, so before 08:00 MYT the admin was a day behind and `admin-preorder.js` could stamp `serviceDate` as **Saturday**. One `mytToday()` helper now lives in `admin.js` — the frontend counterpart of `backend/src/lib/date.ts` — and is used at every site including `computePastSundays`. **Closes follow-up (j)**
- ✅ Keyboard-operable sortable `<th>` with `aria-sort`, and accordion with `aria-expanded`
- ✅ **Closes follow-up (t)** — the unescaped drink name in the dashboard discount accordion (`${name} ×${qty}` into `drinkText`, written raw into a `<td>`)
- ✅ New **caller** of an existing endpoint: the admin Menu row's today-switch now calls `PUT /api/pos/menu/{id}/toggle`, chosen over the generic admin PUT because that route also flags PENDING orders containing the item. No endpoint, auth requirement or schema changed
- ✅ `.pos-cl-fill` (the new progress bar) animates `transform:scaleX()` from a left origin with the JS setting a `--cl-progress` custom property, not `width` — a layout property relayouting every frame janks on the counter iPad. Plus a `prefers-reduced-motion` escape, and `role="progressbar"` with proper values on the track
- ⚠️ **Process failure in this sprint — a verification probe wrote to PRODUCTION.** `page.route()` in Playwright does **not** intercept requests issued by a service worker, and every page here registers one, so a harness that "blocked all non-GET" silently passed writes through. It flipped `latte-001` (☕ Latte) to `isActive:false`, taking it **off the customer menu**. Restored. The fix is `newContext({ serviceWorkers: 'block' })` **plus** a positive control that fails loudly — see the `test-suites` skill

### Completed (2026-08-18 Sprint — v1.75.1)
Third release of 2026-08-18, on top of v1.75.0 (**already pushed and deployed**).
Frontend only: **no `backend/src/` file changed.** A copy correction, not a
feature. Session detail: `docs/update-20260817.md`.
- ✅ **The domain fact was wrong, and the app had encoded it in three places: payment is QR-ONLY — no card, no cash — and the DuitNow QR is PHYSICAL, printed on the café tabletops.** The app had been telling customers to *pay at the counter*, which is not a thing that can happen: there is no till transaction to perform. A first-time congregant had no way to learn that a tabletop QR exists
- ✅ **Tracking page (`track.js`) restructured from "two ways to pay" into one method, two peer proofs**: scan the tabletop QR, then either upload the screenshot or show the payment at the counter. The two proofs are now equally weighted controls (measured identical at 348×56) instead of a filled button beside an underlined text link — the choice is about how you tell the cashier, not about how you pay
- ✅ **Fix: the cart footer told ministry pre-orders to pay.** `app.js` rendered `🏪 Pay at the counter after ordering` **unconditionally** on the screen where the customer commits, so a volunteer on an RM 0 `MINISTRY_PREORDER` was instructed to pay for a free order. It is now gated on `preorderMode` and reads `🎉 Free — nothing to pay`; otherwise it names the tabletop QR
- ✅ **POS walk-up tag no longer claims cash.** Every walk-up card had read `🚶 walk-up · cash at counter`; the tag now says only where the order came from, with a code comment recording why so it is not reinstated
- ✅ Dead code removed: a 15-line commented-out in-app QR block (placeholder image, dummy account numbers), six superseded/dead CSS rules (`.qr-container`, `.qr-image`, `.qr-amount`, `.qr-hint`, `.receipt-upload-area` and its `p`), and `frontend/img/qr-payment.svg`, which never rendered and was never in the `sw.js` `SHELL` array
- ✅ `frontend/img/README.md` had instructed the next person to *"Place `qr-payment.png` here"* — the same pending-feature trap in a second location, aimed at whoever came next. Rewritten to describe the `menu/` photos it actually governs, plus a line stating the QR is physical
- ✅ **Verified and deliberately kept, so it is not "corrected" later:** *"Instant AI verification — cashier gets notified automatically"* is accurate. `backend/src/routes/receipt.ts` really invokes Bedrock to extract amount/date/reference and rejects a mismatch, and the cashier really is alerted in-app — `pos.js` plays a receipt sound on a rising receipt count, renders a pulsing `💰 Receipt: RM…` badge, and v1.75.0's receipt-first sort tier lifts the order to the top of Pending

### Completed (2026-08-19 Sprint — v1.76.0)
Customer-screen pass, on top of v1.75.1 (**already pushed and deployed**).
Frontend only: **no `backend/src/` file changed.** From an `/impeccable` critique
of `index.html` / `track.html` that scored the pair 23/40. Session detail:
`docs/update-20260817.md`.
- ✅ **Escaping sweep across the two customer pages, and the real finding was not the missing escapes — it was four *incomplete* escapers that looked finished.** Old `app.js` carried `esc` at `:226` and `:251` handling only `[<>&]`, `escAttr` at `:275` handling only `"`, and `escText` at `:276` handling only `[<>&]`; the `escAttr` one guarded a **quoted attribute**, where an unescaped `'` or `&` is exactly what matters. A partial escaper is worse than none, because a reviewer greps for `esc(` and sees a call. All four deleted; both pages now route every non-literal string through the single complete five-character `escHtml`
- ✅ Raw render sites closed well beyond the three that were known (`customerProfile.name`, the name input `value`, the search input `value`): `item.description`, item names in both the card and the featured hero **including their `aria-label`s**, slugs in `src`, `item.id` in `data-id`, the pre-order banner message and name, the staff-link label, the collection-time options, the verse text and reference, `flaggedItems`, `order.reason` (cashier free text), and `orderId` / `date` in the order history — plus a missing `encodeURIComponent`. `variants.js` alone had **eleven** raw sites
- ✅ `customerProfile.name` is the load-bearing one: it arrives from `GET /api/customers/{phone}` (verified — `backend/src/routes/customers.ts:188` → `lookupCustomer`), so it is a **stored, cross-user** value. One person's name renders in another person's page
- ✅ **Cart total and Place Order pinned.** `index.html`'s cart is now three bands — fixed head, one scrolling region, pinned foot. Measured with five drinks in the cart, the total and the primary button sat **322 / 249 / 174px below the bottom edge** at 390 / 932 / 1024 viewport widths; now **21px clear at all three**, and only the rows scroll
- ✅ **A price on every cart line** — there were none at all. Staff mode shows the struck-through gross beside RM 5.00 on drinks; a free ministry pre-order shows FREE per line and makes no payment claim
- ✅ **Fix: the premature `Notification.requestPermission()` on `track.js` load is deleted.** It fired with no user gesture and, worse, with no `subscribe()` after it — so the single permission grant a customer will ever be asked for was spent before the 🔔 banner ran, after which tapping "Yes, notify me" returned in silence. The dialog is now raised from that tap, `vapidRes.ok` is checked, and all three failure paths (denied / dismissed / setup failed) now say something
- ✅ **404 split from offline on both customer pages.** A dead order id used to render "Loading order… / Connection error, retrying…" for ever — wrong diagnosis, no end to it, no link out. It now shows `This order has closed` with links back, and **polling stops** (measured: 1 request across 16s, was continuous). A 500 gets its own distinct screen and keeps polling
- ✅ **Variant group names printed**, with `role="group"`, `aria-label` and `aria-pressed`. `aria-pressed` was `null` on the newer `.variantGroups` path while the legacy `.variants` path it replaced had always set it — the newer code was the **less** accessible of the two. Pickers are now opt-in collapsible (`opts.collapsible`), used on the 14-card menu but not the one-item-at-a-time edit and voucher pickers
- ✅ Past orders now fetched **once per load** instead of once per 7s poll — was ~8.5 extra requests/min plus permanent flicker
- ✅ `Track · Preparing` now leads with a two-line wait: the ETA is the only question left on that screen, so it stops being the quietest line on the page
- ✅ **Sold-out card contrast, using tokens that already existed.** The blanket `opacity:.5` is gone: "Sold out" goes **2.25:1 → 8.43:1**, the name 2.96 → 5.62:1, the price 2.49 → 4.64:1
- ⚠️ **Accepted duplication, recorded in the `invariants` skill:** `variants.js` now carries its own module-private `esc`. It loads on `index.html`, `track.html` **and** `pos.html`, whose bundles name their escapers `escHtml`, `escHtml` and `escapeHtmlPos` — borrowing a sibling global would emit raw HTML on whichever page lacks that name. This is a **5th** accepted entry on the do-not-duplicate exception list. Do not "consolidate" it
- 📐 **Menu card density: measured, and the original premise was wrong.** The card is **282px**, not the 372px assumed, and 14 items total **4,575px**, not ~5,200px. The grid layout was measured as a candidate fix and is **worse** per card (520px), with **zero** cards fully above the fold in *either* layout — so `list` stays the default. The collapse was applied anyway (median card 282 → 241px, total scroll 4,575 → 4,075px) but is a minor lever: **the shell above the first card is 493px, 58% of an 844px viewport.** No card arithmetic gets a second drink above the fold while that stands. The **name wall** is the real next lever, since `promptName()` already asks again at checkout

### TODO — Remaining
- ✅ Email notifications — low stock alert (Sunday last run + Wednesday midweek) and end-of-day summary to admin (expiry cron, gated + exactly-once as of v1.72.0)
- ✅ Customer order modify UI (change items while order is still PENDING) — Tier 1 (race-safe + cashier indicators), Tier 2 (add items + notes), Tier 3 (variant editing via shared variants.js)
- [ ] Stock history & consumption trends (graph of usage over weeks)
- [ ] Weekly/monthly sales summary report
- [ ] Item-disabled notification to customers with that item in pending orders
- [ ] Better error handling, loading states

## Important Context
- Church café operates Sundays only: 10:15-11:30 and 12:45-13:30
- ~2-3 volunteers per shift (1 cashier, 1-2 baristas)
- Payment: **QR only — no cash, no card.** A Maybank DuitNow QR **printed on the
  café tables**; the app never renders one. The customer scans it, then either
  uploads the screenshot (parsed by Bedrock) or shows the payment to the cashier
- Special pricing: Celebration (all drinks RM5), Newcomer (free), Pastor (walk-up only),
  Staff (walk-up, or self-requested via the staff link `?code=<CODE>` and confirmed by the cashier at approval)
- Inventory: recipe-based estimation, cashier manual override
- Menu: ~10 drinks (variant groups: Temperature hot/iced, Milk oat milk, Flavor for tea/soda) + food (subject to availability)
