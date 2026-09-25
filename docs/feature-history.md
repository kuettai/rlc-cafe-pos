# Feature History

Sprint-by-sprint completion log, moved out of `.kiro/steering.md` so it does not
consume context on every turn. See `docs/update-YYYYMMDD.md` for session detail.

## Current Status (as of 2026-09-25)
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

### Completed (2026-08-19 Sprint — v1.77.0)
Wholesale palette replacement — the **"deliberate warm"** direction, chosen by the
user from three previewed options and approved from a mock. Frontend only: **no
`backend/src/` or `infra/` file changed.** Shipped **deliberately alone**, with
nothing else folded in, so a visual regression cannot be confused with a
behavioural one and `git revert` stays a real option. Session detail:
`docs/update-20260817.md`.

- ✅ **The new world:** true paper `#FFFFFF` instead of cream, espresso ink
  `#241A14` (**17.03:1**), warm secondary `#6B5A4C`, espresso bands `#3A2A1F`, a
  raised step of `#EFEAE1`, and a burnt-orange brand `#B4531C` **split into a fill
  plus `--brand-ink #8F3F11` for text**, because the fill measures 4.18:1 on the
  raised surface — under the body floor. **87 contrast pairs measured in-browser:
  76 PASS, 10 WCAG-exempt or documented bans, 1 diagnostic FAIL** (`--brand` on
  `--quiet`, kept in the table to prove why the brand had to split; no site uses it)
- ✅ **A live accessibility defect fixed — the functional content of a nominally
  cosmetic release.** The **shipped** pre-order violet and preparing blue measured
  **ΔE 0.4 deutan** — the same colour for a deutan cashier — and 12.4
  normal-vision. Both FAIL. The violet is retired: the pre-order ribbon takes
  espresso (**13.72:1** vs the card, up from 5.70) and the later-service variant
  goes **3.09 → 8.47:1** against its sibling. Worst adjacent status separation
  across the six states is now **ΔE 6.0 deutan, up from 0.4**. Every state also
  carries a **word**, so colour is the redundant channel
- ✅ **The one system rule: `--brand` never appears on the POS board** except the
  header wordmark, because burnt orange sits *inside* the warm band the app's
  status semantics already own — vs `--warning` **ΔE 9.2 normal / 6.6 deutan
  FAIL**, vs `--danger` **ΔE 9.9 normal FAIL**, and no recognisable burnt orange
  clears both. Board buttons are espresso, confirm is ready-green. Verified by a
  rendered-DOM hue scan: **0 occurrences on the board, 11 on admin**, where the
  rule wants it. Recorded as an invariant — it will look arbitrary to whoever next
  wants orange buttons on the board
- ✅ **The receipt indigo `#4338CA` is deliberately UNCHANGED** — "money has
  arrived" is genuinely not a warm-band event and could not be made to pass on hue
  alone. Its channel is **shape**: a 2px full-card outline plus a
  `RECEIPT SENT — check it` band. **Mandatory secondary encoding — do not
  "harmonise" it later**
- ✅ **Dashboard chart trio re-keyed** to `#1F6FB2 · #0C8C63 · #93276A` (ALL CHECKS
  PASS on the new surface), slot 2 unchanged. **Not for contrast** — the old trio
  also passed, since `admin.css` sets `--dash-surface:#fff` so the marks were always
  on white — but because `--src-1 #B4691C` was **three hex digits** from the new
  accent and two other charts on that dashboard use the accent family. Accepted
  cost: tritan separation 9.4 → 4.5, mitigated by legend, in-segment counts and
  table view
- ✅ **Follow-up (a) CLOSED.** `.pos-main` and `.admin-main` converted from
  animating `margin-left` to a transform-based push — the **last two
  layout-property animations** in the codebase. `frontend/css/` now has zero.
  `@keyframes training-cue-pulse` left alone deliberately: it is a functional
  tutorial spotlight. Zero-offset coloured halos given an offset and a blur
- ✅ **Five pre-existing defects found and fixed en route.** (1) **Three tokens were
  never defined at all** — `--brown`, `--white`, `--cream-lighter` — so their
  `var(…, fallback)` *was* the live value, which is how the old `#6B4226` brown
  stayed pinned into the walk-up screen behind names nobody could grep for.
  (2) **261 `var(--tok,#hex)` fallbacks were a second, drifted palette** —
  `--cream-dark` alone carried **six** different values; all stripped, a render
  no-op. (3) **Every text input in the app failed WCAG 1.4.11 at 1.58:1**, and the
  fix needed *all* of them, not just the one named in the brief — new `--field-bd`
  at 4.33:1. (4) Two placeholders composited below the floor via `opacity:.8`
  (3.62:1, 4.09:1) — **the opacity was the bug**. (5) Two further cool greys the
  earlier sweep missed
- 📐 **Three deviations from the approved mock, each made on a measurement** — the
  mock's `scrollbar-color:var(--tan)` is **2.01:1** and the CSS already carried a
  comment that a near-invisible thumb had been a real usability problem, so
  `--field-bd` (3.18:1) is used; `--tan` was never measured in the mock at all and
  is **2.73:1** on white, now demoted to decorative-only; and five white-labelled
  `--primary`→`--primary-light` gradients were flattened to solid `--brand`
  (5.01:1), because white on the mock's light end is 3.26:1
- ⚠️ **`frontend/manifest.json` is invalid JSON and has NEVER parsed** — three
  shortcuts read `"url": ./track.html",` with a missing opening quote, so the PWA
  has no theme colour, icons or shortcuts. The colour values inside it are now
  correct, but the **syntax was deliberately NOT repaired**: fixing it would newly
  *activate* the whole manifest, a behavioural change that does not belong in an
  isolated repaint. High value and cheap — follow-up (ae)
- ⚠️ **Deferred on purpose:** `display.html`/`display.css` (the TV board) and
  `prep.html` keep their dark navy world, since a dark variant is a design decision
  the user has not reviewed (af); the 8-way `.pos-fam-*` walk-up palette is
  unreviewed and still holds three cool tints, plus `.pos-fam-tea` price ink at
  4.40:1 and `.pos-fam-water` at 4.17:1 are **pre-existing** body-text failures
  (ag); and pill/stepper resting borders sit at 1.87:1, below 1.4.11, consistently
  by design (ah)

### Completed (2026-08-19 Sprint — v1.78.0)
Customer closed-screen redesign + opening times as a single source of truth.
Spans four trees (`backend/src`, `backend/tests`, `frontend`, docs/skills), so
**the backend must deploy first** — the closed screen consumes `openingState`.
Session detail: `docs/update-20260819.md`.

- ✅ **`backend/src/lib/opening-hours.ts` — the one place the café's schedule
  lives.** Types, a deep-frozen `DEFAULT_OPENING_HOURS`, `validateOpeningHours`
  (write path), `readOpeningHours` (read path) and `describeOpeningState(hours,
  now)`, plus label helpers that build every customer-facing string from the data.
  Stored as `openingHours` on `PK=SETTINGS, SK=CONFIG`: `serviceDays` (MYT
  day-of-week) + 1–4 ascending, non-overlapping `sessions`. **Absent → the default
  silently** (the legitimate state of every existing record — nothing needed
  backfilling and no migration script was written); **present but invalid → the
  default plus a loud `console.warn` naming the error and the record**
- ✅ **Descriptive, never a gate.** `cafeStatus` remains the only thing that decides
  whether an order is accepted — a late or extended service must not lock out a
  customer standing at an open counter
- ✅ **`GET /api/cafe/status` now returns `openingHours` + `openingState`**
  (`phase`, `opensLaterToday`, `nextOpenAt`, and finished MYT labels), and
  `PUT /api/admin/settings` validates `openingHours` before the write, returning
  `400 {error}` with an admin-readable message. Both additive and
  backwards-compatible, so an old cached service-worker shell is unaffected
- ✅ **`lib/date.ts` gained `malaysiaTimeUtc(dateIso, hhmm)` and `addDaysIso`**, and
  `malaysiaDayStartUtc` now delegates to the `'00:00'` case, so the offset is
  written once *inside the module that owns it*. **Correction made during the
  release pass:** the claim that "`+08:00` now appears exactly once in the backend"
  was **false** — it appears **5** times in `backend/src/`, four of them outside
  `lib/date.ts` (`lib/email.ts:194`, `routes/receipt.ts:103/155/174`), plus two
  non-literal offset copies. Withdrawn in the `invariants` skill, which now carries
  the full count. Follow-up (i)
- ✅ **The closed screen** (`frontend/js/app.js` `renderClosedScreen`) replaces
  three hardcoded lines, re-checks every 60s and hands back to the menu when
  `cafeStatus` flips to OPEN; a new **Opening Times editor** in Admin → Settings is
  wired into the v1.75.0 unsaved-work leave guard and sends `openingHours` only when
  it changed. **No new frontend file, so no `sw.js` `SHELL` entry was needed** —
  verified by `npm run version:check`
- 🐛 **A phase bug caught by the "nothing reads this field" test.** The first cut
  validated and stored `closesAt` while `describeOpeningState` keyed only off
  `opensAt`, so the phases actively lied: at 10:20, inside session 1, `phase` read
  `BETWEEN_SESSIONS`. The customer-visible result was the screen telling a
  congregant at 10:20 on a Sunday that the café opens at **12:45** — a 2.5-hour
  wait — when the volunteers were five minutes late. Fixed by the `WITHIN_SESSION`
  phase, now the only reader of `closesAt`. Recorded as an invariant
- 🐛 **A repo-wide test bug fixed: CI was silently losing a whole suite.** Eleven
  files in `backend/tests/` had no top-level `import`/`export`, so ts-jest compiled
  them as global scripts whose `const`s redeclared each other (`TS2451`). The
  diagnostic appears **only on a cold cache**, so warm local runs looked green while
  a clean CI checkout dropped a file — and the victim moved with compile order.
  Each got `export {};`. Cold and warm now agree for the first time: **22 suites /
  599 passed / 18 skipped**, up from 20 / 421 / 18. All 18 skips are
  `integration.test.ts`. Every test count reported for this repo before 2026-08-19
  was a warm-cache number
- ⚠️ **Two more disagreeing notions of opening times left in place on purpose:**
  `/api/admin/reports/sessions` buckets by a hardcoded 8:00–14:00 MYT with its own
  `(utcHour + 8) % 24` conversions, and the dashboard's Session Comparison cards
  label that data `Session 1 (10:15-11:30)` / `Session 2 (12:45-13:30)` — so today
  the heading and the numbers under it disagree. Follow-ups (a) and (b)

### Completed (2026-09-07 Sprint — v1.79.0)
Passkey (WebAuthn) login for the admin page. **Additive only — PIN login is
unchanged and remains the required fallback.** Spans `backend/src`,
`backend/tests`, `frontend` and docs/skills, so **the backend must deploy first**:
the login screen calls `/api/auth/passkey/*`. **No CDK/infra change** — no new
table, no new env var, no new SSM parameter. Session detail:
`docs/update-20260907.md`.

- ✅ **`backend/src/lib/webauthn.ts` — the one place that knows the relying-party
  identity.** `RP_ID`/`RP_NAME`/`ORIGIN` are **constants, not env vars** (the same
  reasoning that moved the VAPID keys out of the Lambda environment: a deploy from
  an unexported shell cannot blank them). Wraps `@simplewebauthn/server`
  (**new dependency, v14.0.1**) so no route imports it directly — its option names
  changed shape twice across majors. Also owns the base64url helpers and the
  challenge put/get/delete/expiry pair
- ✅ **Usernameless login.** Enrolment asks for a discoverable credential
  (`residentKey:'required'`), so `login-options` sends `allowCredentials: []` and
  the server identifies the user from the credential ID via a
  `PASSKEY_CRED#{credentialId}` reverse-lookup record
- ✅ **Four new routes in `handleAuth`** (`register-options`, `register-verify`,
  `login-options`, `login-verify`) — **no `index.ts` change needed**, because
  `path.startsWith('/api/auth')` already dispatches there. Enrolment requires an
  ADMIN JWT **and** not `forceUpdatePin`, so a forced PIN change cannot be
  sidestepped by enrolling a credential that skips the PIN. `login-verify` returns
  a body **byte-identical** to `POST /api/auth/login`, and **every** failure is an
  indistinguishable `401 Invalid credentials` — no user enumeration
- ✅ **Two `/api/admin/passkeys` branches** (list / delete), self-service via
  `callerFromToken()` — a caller sees and revokes only their own, and the list
  never returns `publicKey` or `counter`. `DELETE` returns a **JSON body, not 204**,
  because `admin.js`'s `api()` helper calls `res.json()` unconditionally.
  `MAX_PASSKEYS_PER_USER = 10`
- 🐛 **A pre-existing latent bug fixed, and it was the real find:**
  `GET /api/admin/users` ran an **unfiltered `ScanCommand`** on `USERS_TABLE`. That
  was harmless only while `USER#` was the sole record type there; the new
  `PASSKEY_CRED#` records made each enrolled passkey render as a **phantom
  volunteer row with a blank name and role, whose Delete button carried the REAL
  owner's `userId`** — deleting the phantom deleted a live account. Now carries
  `FilterExpression: 'begins_with(PK, :userPk)'`. Recorded in the `invariants`
  skill as a general rule: **an unfiltered `Scan` becomes a data-loss bug the
  moment a second record type joins the table**, and adding a record type means
  grepping every reader of that table
- ⚠️ **The suite had actively defended that defect** — a test asserted the Scan's
  `FilterExpression` was `undefined`, i.e. pinned "harmless today" as a
  requirement, so the correct fix looked like a regression. Also recorded as an
  invariant: a test asserting the *absence* of a safety measure is asserting that
  today's schema is permanent
- ✅ **Frontend: `frontend/js/admin.js` + `frontend/css/admin.css` only.** No new
  file, so **no `SHELL` change** (`pos.js`, `pos.html`, `config.js`, `sw.js` and
  `admin.html` are all untouched). A feature-detected "Sign in with Face ID /
  Touch ID" button on the login screen, a self-contained Passkeys card in Settings
  (independent of `btnSaveSettings`), and a shared `applyLoginSuccess()` now used
  by both the PIN and passkey paths
- ✅ **Challenges are prefetched so `navigator.credentials.get()/create()` are
  called inside the click's own dispatch** — Safari/iOS drops user activation
  across an `await`, which would otherwise make the button silently do nothing on
  the exact devices the feature is for
- ✅ **`backend/tests/passkey.test.ts` — 91 tests, fully mocked and offline** (both
  `lib/db` and `@simplewebauthn/server` mocked; no credentials, no production
  writes, no `ZZTEST_` marker needed). Verified by two rounds of mutation testing —
  21 mutations then 26 more, **zero survivors**. Cold and warm runs agree:
  **44 suites / 2111 passed / 18 skipped**
- ⚠️ **Top open question, deliberately left as-is:**
  `userVerification:'preferred'` + `requireUserVerification:false` reduces an ADMIN
  login to a bare possession factor — a stolen *unlocked* phone signs in with no
  biometric and no device PIN, against a role that can edit pricing and delete
  users. `'required'` is arguably correct for an admin surface, and changing it
  later costs a re-enrolment for everyone already registered. **This is the user's
  policy decision, not the agent's**
- ⚠️ **Never exercised for real.** `RP_ID`/`ORIGIN` are the single production host,
  so the documented local dev flow can never test this path, and the real Face ID /
  Touch ID ceremony needs Secure Enclave hardware — all browser verification used a
  **stubbed `navigator.credentials`**. One manual iPhone pass is owed after deploy.
  Also unverified: `InvalidStateError` (device already registered). And
  `login-options` is unauthenticated and writes a challenge record per call with
  **no rate limiting** — nothing in this app has any, so it belongs at API Gateway

### Completed (2026-09-23 Sprint — v1.80.0)
TV display (`display.html`) layout redesign + slideshow cross-fade fix, plus one
service-worker fix. **Frontend-only — no backend, no CDK, no schema change**, so
only `npm run deploy:frontend` is involved. Session detail:
`docs/update-20260923.md`.

- ✅ **Fullscreen promo image with the orders panel overlaid on it.** The board was
  a `2fr 1fr` grid — photo left, orders in a flat navy column right — so a 1080p
  foyer TV gave two thirds of its area to the image and a third to at most 13 order
  numbers. `.display-container` is now `position:relative` with `.display-promo`
  at `inset:0` and `.display-orders` absolutely positioned over the right 30%
  (`min-width:380px`, `z-index:10`). Readability over an arbitrary photo comes from
  a horizontal scrim (transparent → `rgba(10,14,26,0.92)`) plus `backdrop-filter`
  and `text-shadow` on the cards, dividers and empty state — **not** from an opaque
  panel. Portrait TV mounts get a bottom strip (`height:42%`, scrim rotated to
  `to top`) instead of the old 60/40 row split
- ✅ **True cross-fade between slides.** Two stacked `.promo-layer` images
  (`promoImgA`/`promoImgB`) transition `opacity` only; the incoming URL is loaded
  by a throwaway `new Image()` and the layers are swapped in its `onload`/`onerror`.
  Replaces a single `<img>` that faded out, swapped `src` on a hard-coded
  `setTimeout(…, 1000)` matched by hand to a `1s` CSS transition, and faded back in
  — which dipped through the dark `#111` panel between every slide and could reveal
  a half-decoded image. Slide-visibility CSS (`img[src=""] ~ .fallback`) is gone;
  the fallback is now driven by JS, with `clearPromoLayers()` as the single reset
  path. Recorded as an invariant
- ✅ **`sw.js` ignores non-`http(s)` requests.** One guard line at the top of the
  `fetch` listener. A browser extension's `chrome-extension://` fetches were
  reaching the cache-write branch, where `cache.put` rejects on an unsupported
  scheme and fails a request the page never made. Recorded as an invariant
- 📐 Mock-first, per the standing rule: `tmp/display-fullscreen-mock.html` was
  built and approved before any real CSS was touched. Scratch, not shipped
- ⚠️ **The v1.77.0 deferral (af) still stands.** This was a *layout* change:
  `display.css` keeps its own hand-written dark navy values and is still not on the
  `style.css` token palette. A dark variant remains an unreviewed design decision

### Completed (2026-09-23 Sprint — v1.81.0)
Display-slide **editing**, plus server-side date validation on slide creation. A
separate feature from v1.80.0 the same day: that one was the TV board's layout,
this one is the admin screen that manages its slides. **Backend + frontend**, so
`npm run deploy:backend` ships first. Session detail: `docs/update-20260923.md`.

- ✅ **Admins can edit an existing slide.** New `PUT /api/admin/display/slides/{id}`
  (ADMIN-only) and an Edit button per slide in `admin-display.js` opening a
  prefilled form for title / start date / expiry date / sort order. Previously the
  only way to correct a typo or shift a date was delete + re-upload the image.
  `imageUrl` stays deliberately immutable — the `UpdateExpression` is a fixed
  four-field allowlist, never iterated from the request body, which is also what
  keeps `PK`, `SK`, `slideId` and `createdAt` out of reach. A `ConditionExpression:
  attribute_exists(PK)` turns a PUT to a deleted slide into a `404` instead of
  upserting a new partial record with no image
- ✅ **Slide dates are now validated server-side on create too.** Both write paths
  call one shared `slideDateRejection()` (`backend/src/routes/admin.ts:53`).
  **This changes the behaviour of the already-shipped `POST`**: a missing date, a
  non-`YYYY-MM-DD` date and an inverted range now all return `400` where they used
  to be stored. Hardening both paths was chosen deliberately over edit-only —
  the rule had lived *only* in the browser form, so the create endpoint was a
  bypass, and `routes/display.ts` compares these dates **lexicographically**, so a
  free-text date was never rejected downstream, just silently mis-compared, and the
  slide simply never appeared on the TV with nothing logged. Recorded as an
  invariant, as is the test that had pinned the defect (it asserted `201` for an
  inverted range)
- ⚠️ **Known gaps, left as follow-ups:** no audit-log entry on any display-slide
  route; `title` and `sortOrder` are untyped on both create and edit; the date
  regex accepts calendar-invalid values like `2026-13-45` (harmless — they still
  sort correctly against a real date)

### Completed (2026-09-25 Sprint — v1.82.0)
Discount **category scope** became a per-class fact: `PASTOR` and `NEWCOMER` now
discount FOOD as well as DRINK. **Backend + frontend**, so
`npm run deploy:backend` ships first. Session detail: `docs/update-20260925.md`.

- ✅ **Pastor and Newcomer discounts cover food.** Both hospitality classes price
  the whole order at RM0 instead of drinks only — the café gives a visiting pastor
  or a newcomer their food too, which the code had never allowed. `STAFF` and
  `PREORDER` are **unchanged and stay DRINK-only**, each for its own reason:
  `STAFF` is a flat RM5 *drink* price that against food would charge RM5 for a RM6
  pastry and leave a RM3 cookie untouched, and `PREORDER` is the drinks-only
  ministry pre-order whose link already rejects food up front. `CELEBRATION` is
  untouched (eligible-DRINK-only)
- ✅ **The scope lives in one allowlist that fails closed.** `CLASS_CATEGORIES` +
  `classAppliesToCategory()` (`backend/src/lib/pricing.ts:170`), read by **both**
  pricing gates — `priceLine` (submission) and `repriceStoredItems` (approve) —
  which previously each carried their own hardcoded `category === 'DRINK'` test.
  Two gates with the rule written twice is how an order gets freed on one path and
  billed on the other. Written as an allowlist rather than a `!== 'DRINK'`
  negation so a menu record with a missing category matches nothing instead of
  being handed out free, and typed `Record<CustomerClass, …>` so a future fifth
  class cannot ship without its categories being decided
- ✅ **Admin discount report itemises food.** `GET /api/admin/reports/discounts`
  returns a new `foodBreakdown` alongside `drinkBreakdown` (same shape), rendered
  as a labelled "Food" group in the dashboard's existing discount accordion.
  Without it a newcomer's discounted food was written off with nothing itemising
  it. Drink and food lines are now **labelled** in that cell — bare item names
  were unambiguous when it held drinks only, and stopped being so
- ⚠️ **Known deliberate divergence:** the display mirror
  `frontend/js/pricing.js` defaults a category-less menu record to `DRINK`, where
  the backend allowlist fails closed and charges full price. Display-only, cannot
  persist a number, recorded in the `pricing-rules` skill; converge on the
  backend's allowlist if that file is touched
- 📝 **Invariant withdrawn:** the flat "FOOD is never discounted" assertion is now
  false and was replaced in the `invariants` skill by the per-class allowlist rule.
  Any report, export or tile assuming food lines always carry full price will
  overstate takings

### TODO — Remaining
- ✅ Email notifications — low stock alert (Sunday last run + Wednesday midweek) and end-of-day summary to admin (expiry cron, gated + exactly-once as of v1.72.0)
- ✅ Customer order modify UI (change items while order is still PENDING) — Tier 1 (race-safe + cashier indicators), Tier 2 (add items + notes), Tier 3 (variant editing via shared variants.js)
- [ ] Stock history & consumption trends (graph of usage over weeks)
- [ ] Weekly/monthly sales summary report
- [ ] Item-disabled notification to customers with that item in pending orders
- [ ] Better error handling, loading states

## Important Context
- Church café operates Sundays only: 10:15-11:30 and 12:45-13:30 — but since the
  2026-08-19 sprint this is the **configurable default**
  (`DEFAULT_OPENING_HOURS`), not a constant. The truth is the `openingHours`
  attribute of `PK=SETTINGS, SK=CONFIG`, owned by
  `backend/src/lib/opening-hours.ts` and edited in Admin → Settings. Never hardcode
  a time again
- ~2-3 volunteers per shift (1 cashier, 1-2 baristas)
- Payment: **QR only — no cash, no card.** A Maybank DuitNow QR **printed on the
  café tables**; the app never renders one. The customer scans it, then either
  uploads the screenshot (parsed by Bedrock) or shows the payment to the cashier
- Special pricing: Celebration (eligible drinks RM5), Newcomer (free — **drinks and
  food**, since v1.82.0), Pastor (walk-up only; free — **drinks and food**, since
  v1.82.0), Staff (flat RM5, **drinks only**; walk-up, or self-requested via the
  staff link `?code=<CODE>` and confirmed by the cashier at approval). Which
  categories each class covers is per-class — see the `pricing-rules` skill
- Inventory: recipe-based estimation, cashier manual override
- Menu: ~10 drinks (variant groups: Temperature hot/iced, Milk oat milk, Flavor for tea/soda) + food (subject to availability)
