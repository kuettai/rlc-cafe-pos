# GRAPH-SPEC — 2026-08-17 work fan-out

Source: WhatsApp thread with Mei Yii (RLC CG), 2026-08-16. Five tasks, derived
from her list plus investigation of the current code. **Item 6 (stock take) is
deliberately excluded** — the request ("the stock take there also need to update
sikit") is too vague to action and needs clarification from her first.

Every claim below was verified against the code at commit `5ca7280`. File and
line references are given so an agent can confirm rather than trust this doc.

---

## Read before starting any task

- `CLAUDE.md` — entry point, then `.kiro/steering/{project,conventions,release-checklist}.md`
- Skills: `invariants` always; `pricing-rules` for T2; `order-lifecycle` for T4;
  `api-reference` + `db-schemas` if you touch endpoints or records
- `release-flow` before shipping anything

### Non-negotiables that bite on these tasks

1. **Pricing lives in `backend/src/lib/pricing.ts` only.** T2 must not write new
   discount maths. `STAFF` is already flat RM5, DRINK-only, food never
   discounted. Spec: `backend/tests/pricing.test.ts`.
2. **Six version markers.** Never hand-edit. `npm run version:bump`, verify with
   `npm run version:check`.
3. **New `frontend/js/*.js` file → add it to the `SHELL` array in `frontend/sw.js`**
   or it is never precached. `version:check` enforces this.
4. **`expiresAt` is a DynamoDB TTL.** Numeric only on PENDING orders; every
   transition out of PENDING must `REMOVE expiresAt`. T4 changes order status —
   read the `order-lifecycle` skill first.
5. **`totalAmount` is NET.** `grossAmount` undiscounted, `discountOffset` the
   reduction. All aggregation assumes this.
6. **Path params:** each route module's dispatcher parses `event.path` and
   assigns `event.pathParameters` itself. API Gateway proxy integration does not
   populate it.
7. **Deploy and push are the user's call.** Prepare, verify, then ask.
8. **Live-API tests write to production.** Never run `integration.test.ts` or the
   Playwright journeys unprompted; they need the café OPEN and cleanup after.

---

## Dependency graph

```
T1 checklist reorder     ── independent ── frontend only
T2 staff link            ── independent ── backend + frontend + new admin tab
T4 pre-order edit fix    ── independent ── backend + frontend  ⚠ highest value
T3 edit discoverability  ── SOFT dep on T4 (shared surface: track.html)
T5 per-item requests     ── SOFT dep on T4 (shared surface: order items shape)
```

**Parallel-safe now:** T1, T2, T4 touch disjoint files. Run together.

**Sequence T3 and T5 after T4.** All three edit `frontend/js/track.js` and the
order-items shape; running them concurrently will conflict. T4 first because it
is a defect, and because its fix determines what T3 and T5 are working with.

---

## T1 — Checklist reorder (Open / Close / Handover)

**Ask:** Admin → Checklist. Let admins reorder items within each phase.

**Verified facts**

- Order IS array position. There is no `sortOrder` field anywhere.
- Admin renders `items.map((item, i))` and displays `${i+1}.` —
  `frontend/js/admin-checklist.js:15-17`
- POS renders the same array order — `frontend/js/pos-checklist.js:66`
- Save is a whole-array `PutCommand`, so order round-trips unchanged —
  `backend/src/routes/checklist.ts:117-127`

**Therefore: NO backend change, NO schema change, NO migration.** Reordering is
`splice` on the existing arrays. Scope is `frontend/js/admin-checklist.js` alone.

**Decided UI (user's choice): drag-and-drop WITH up/down arrows as fallback.**

- Drag handle (⠿) at row start. Use **pointer events, not HTML5 drag** — native
  drag is unreliable on the counter iPad.
- ▲▼ per row as the reliable path. Disable ▲ on the first row, ▼ on the last.
- Both mutate `openItems` / `closeItems` / `handoverItems` then call the existing
  `rerender()` — same pattern as the current add/remove handlers.

**Constraints**

- Reorder within a phase only. No dragging between Open/Close/Handover; a close
  item in the open flow is nonsense.
- `${i+1}.` numbering must update live so the new order is visible before saving.
- Nothing persists until **Save Checklist**, matching how label/type/enabled
  edits already behave.

**Watch out:** each row contains a text input for the label. Dragging must not
fire when an admin is selecting text in that field — hence handle-only dragging.

**Verify:** reorder by drag and by arrows in both directions; first/last arrows
disabled; order survives Save + reload; POS open/close/handover flows show the
new order; label editing and text selection still work.

---

## T2 — Staff link (`?code=staff`, staff price)

**Ask:** staff order at staff price without going through Mei Yii. Her words:
*"the staff link is for staff to order staff price"*.

### This is NOT a pre-order link

The user explicitly confirmed this after an initial mix-up. Do not extend
`PREORDER_CODE#`. Pre-orders and staff orders disagree on every axis:

| | Ministry pre-order | Staff link |
|---|---|---|
| Price | free, RM0 | RM5 |
| Status | PREPARING, skips cashier | **PENDING**, cashier approves |
| Café-open check | bypassed (`orders.ts:65`) | **must apply** |
| Food | drinks only (`orders.ts:79`) | allowed |
| Expiry | same-day via `serviceEndTime` | long-lived, date-gated |

Reusing the pre-order record would mean overriding all five.

### Data

New record type, separate from pre-order codes:

```
PK = STAFF_CODE#<CODE>, SK = META
{ code, label, isActive, startDate, endDate, createdAt, createdBy, updatedAt }
```

**Single entry, always edit** (user's decision) — the admin UI manages one staff
code, not a list. No create/delete flow needed.

### Admin UI

New tab in `frontend/js/admin.js`: add `<button data-tab="stafflink">` near
line 98 and a `case 'stafflink':` at line 153, following the existing pattern.
New file `frontend/js/admin-stafflink.js` — **remember `sw.js` SHELL**.

Fields: short code (manual input), enable/disable toggle, **start date + end
date** as an additional validity gate.

Code normalisation: uppercase on write and lookup (pre-order codes already do
this — `preorder.ts:135`), restricted to an ambiguity-free alphabet
(`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, no 0/O/1/I/L) so a hand-typed code cannot be
misread.

### Pricing — reuse, do not reinvent

Mirror the **cashier walk-up STAFF** behaviour. `pricing.ts` already provides it:
pass `'STAFF'` as the customer class to `priceLine`, which charges
`STAFF_DRINK_PRICE` (RM5) on DRINK lines and leaves FOOD at full price.

### Order flow

Customer page with `?code=staff`: validate the code, show a "Staff price" banner,
price drinks at RM5 via the existing `CafePricing`.

`createOrder`: validate, pass `'STAFF'` into `priceLine` instead of `null`, store
`customerClass: 'STAFF'`. Order stays **PENDING**. Café-open check applies. Food
allowed.

### Cashier confirmation (user's decision)

A staff-code order arrives flagged. On approve the cashier is asked:

> *Staff price (RM5) requested — confirm this is staff?*

- **"Yes, staff price" is the primary button; decline is secondary** (user's
  choice — fast for the common case).
- Declining reprices at full price.
- Either way `approvedBy` records who decided.

**Why this exists:** self-applied discounts erase the audit trail. Today a STAFF
discount is a deliberate cashier action recorded in `approvedBy`; without the
prompt, `discountType: 'STAFF'` would appear with nobody accountable.

**State the residual risk plainly in the PR:** a permanent guessable code means
anyone with the link can *request* staff price. The cashier is the only real
control, and on a busy Sunday someone may tap through. The user accepted this
trade knowingly.

**Verify:** valid code prices drinks at RM5 and food at full; order lands
PENDING; café-closed rejects; disabled code rejected; outside start/end dates
rejected; lowercase `?code=staff` resolves; cashier prompt appears, confirm keeps
RM5, decline reprices to full; `approvedBy` populated either way; a normal order
with no code is completely unaffected.

---

## T4 — Pre-order customers cannot edit their cart ⚠ START HERE

**Ask:** *"Pre-order link — allow to see cart and edit cart (for staff orders) —
got more than one order"*. Volunteers currently delete the order in POS and have
the customer re-order. Real case last week with the music team.

**Root cause (verified)**

- Pre-orders are created with `status: 'PREPARING'` — `orders.ts:169`
- `track.js` renders Edit/Cancel only when `order.status === 'PENDING'` —
  `track.js:119, 178`

So a pre-order can **never** be edited by the customer. Not a UX gap — a
structural one.

**Second finding:** each submit creates a *separate* order, which is why she sees
"more than one order" rather than one editable cart. `app.js:190` also filters
pre-order mode to DRINK only.

**Design questions to settle with the user before building** (do not guess):

1. Should a pre-order become editable, or should the flow instead let a customer
   add to an existing pre-order (one cart, many items)?
2. If editable: until when? Pre-orders skip PENDING entirely, so the natural gate
   (payment proof before the cashier advances) does not exist. Options include
   time-based (until `serviceEndTime`) or an explicit cashier lock.
3. Does editing need to respect `excludedOptions` and `eligibleItems`? It should
   — but confirm, because the enforcement in `createOrder` is on create only.

**Constraint:** whatever the fix, the TTL rule holds. Pre-orders store
`expiresAt` as an **ISO string** deliberately (inert as a TTL, compared by
`expiry.ts`). Do not "normalise" it to a number.

---

## T3 — Customer order editing is not discoverable

**Ask:** *"Once place order cannot order 2nd drink"* / *"Option to add order,
change items"* (clarified: mobile customers, not walk-up).

**It already works.** Do not rebuild it.

- `track.html` on a PENDING order shows **✏️ Edit Order** and **Cancel Order** —
  `track.js:180-181`
- Edit mode offers quantity ±, remove, **+ Add item** (`track.js:274`), inline
  variant pickers, and a notes field
- Backend enforces the user's intended gate exactly:
  `ConditionExpression: '#s = :pending'` returning 409 *"Order is no longer
  modifiable"* once the cashier moves the order to PREPARING —
  `orders.ts:250-264`

The user's gate reasoning is sound: the cashier only advances after seeing
payment proof, so PENDING is the right editable window.

**So this is a discoverability problem.** Two hypotheses worth testing before
changing anything:

1. Customers may not return to `track.html` after ordering, so they never see the
   buttons.
2. The buttons sit below the item list, easy to miss on a phone.

**Do this first:** confirm with the user whether volunteers simply did not know
the feature existed. If so the fix may be zero code — just telling Mei Yii. Only
then consider surfacing the affordance more strongly (e.g. on the confirmation
screen rather than only on track).

---

## T5 — Per-item special requests

**Ask:** *"Multiple drink cannot add request to each item"*. One notes box is
shared across the whole order, so a customer cannot say "less sugar" for just one
of three drinks.

**Verified:** `notes` is a single per-ORDER string — `orders.ts:45, 150, 170`.
There is no per-item note field anywhere.

**The user's own framing:** *"this is toughest as will make UI clunky"*. They
asked for a suggestion and specifically suggested using the newly installed
`/impeccable` skill to design the UI.

**Approach**

- Use `/impeccable` to critique layout options before writing code. This is the
  one task where that tool is genuinely the right fit.
- Rough direction to evaluate, not to assume: a per-line note affordance that
  stays collapsed until tapped, so a single-drink order looks unchanged from
  today.
- Data: adding a `note` to each item in the `items` array is the smaller change
  and keeps the per-order `notes` working for order-wide requests. Confirm with
  the user before committing to a shape.

**Surfaces that must all agree:** customer page (`app.js`), track edit
(`track.js`), walk-up cart (`pos-walkup.js`), POS order card and detail
(`pos.js`), and the cashier's prep view. A per-item note is useless if the
barista cannot see it — check `prep.html` too.

---

## Known adjacent issue, not in scope

Pre-orders zero out **any** paid option, so Iced (+RM1) is given away free along
with everything else. Auditable via `discountOffset` but uncapped. `excludedOptions`
(v1.67.0) blocks specific options but does not address the pricing. Raise it with
the user; do not fold it into these tasks.

---

## Definition of done, per task

- `cd backend && npx tsc --noEmit` clean; `npx jest --testPathIgnorePatterns integration` green
- New behaviour covered by a test that **fails when the change is reverted** —
  verify this, do not assume it
- Frontend verified in a real browser at iPad sizes (1024x768 and 768x1024); the
  POS and admin are used on a counter tablet
- `npm run version:bump` + `npm run version:check`; changelog entry for anything
  user-visible
- Reference docs updated in the same change: new endpoint → `api-reference`; new
  record or attribute → `db-schemas`; new invariant → `invariants`
- Session notes in `docs/update-YYYYMMDD.md`
- Report honestly: distinguish probe/test-harness artifacts from real defects,
  state what was NOT verified, and never report a skipped test as a pass
