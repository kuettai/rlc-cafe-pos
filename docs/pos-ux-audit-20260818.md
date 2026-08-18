# POS UX Audit — 2026-08-18

An `/impeccable critique` pass over the POS surface (`frontend/pos.html`,
`frontend/js/pos*.js`, `frontend/css/style.css`). Recorded here because the run
produced no artefact on disk and would otherwise have been lost.

**Score: 20/40 — "acceptable, bottom edge."** Weakest dimensions: **Visibility of
System Status 1/4** and **Error Recovery 1/4**. Both P0s below sit in those two.

## Read the method before you trust a finding

This section is not boilerplate. Three limits materially shape what the score is
worth, and each one is a reason a specific finding could be wrong.

- **Nearly all rush states were SIMULATED.** The café was OPEN with an **empty
  queue** during the run. Multi-order boards, the 17-minute urgent card, partial
  release results and the failed-fetch board were produced by **intercepting GET
  responses in the browser**, not by creating orders. **Zero writes** reached
  production — no order records, no `DAILY_SUMMARY#{date}` marker, no
  counter movement. Nothing needed `scripts/cleanup-test-data.mjs` and no
  `ZZTEST_` record exists from this pass.
- **The mechanical detector ran degraded.** It fell back to **regex** rather than
  a parsed stylesheet/DOM, so its counts are a **floor, not a total**. Where this
  audit says "no `:disabled` rule exists" that was confirmed by hand; where it
  gives a count, assume an **undercount**.
- **Chromium at iPad viewports, not real iOS Safari.** The counter device is an
  iPad. Touch-target sizes, the `max-width:768px` portrait finding and any
  `-webkit-` behaviour are therefore **unconfirmed on the actual hardware**.
  A viewport is not a device.

Line references were **re-resolved against the tree at v1.74.0** on
2026-08-18. The original run predates this release's `pos.js` and `style.css`
edits, so its own numbers had already drifted by up to 11 lines; the numbers
below are the current ones.

## Working — do not regress

Called out deliberately. These are the parts a redesign is most likely to
flatten by accident.

- **The three v1.71 confirmation dialogs are the strongest thing on the
  surface.** `askStaffPrice` (`pos.js:865`) puts **the amount on both buttons**,
  so the cashier is choosing between two priced outcomes rather than confirming
  an abstraction, and it **names the customer**.
  `confirmReleaseNotToday` (`pos.js:982`) **leads with the service date** — the
  one fact that makes the decision — instead of burying it in prose.
- **The pre-order ribbon reads correctly against unpaid walk-ins because it is a
  different SHAPE**, a full-width band, not merely a different colour. This
  survives colour-blindness, a dimmed screen and a sunlit counter. The rationale
  is already written into the code comment above it in `cardHtml`
  (`pos.js:746`+) — keep it there.
- **`releaseAllPreorders` (`pos.js:911`) reports honest partial results** rather
  than an optimistic "done". Partial honesty in a bulk action is rare and worth
  protecting.

## P0

**1 — A failed fetch renders an empty board that is indistinguishable from "no
orders."** This is the headline defect and the reason both weak dimensions score
1/4.

The mechanism, all verified in the file:

- `renderBoard()` is called at `pos.js:385`, **inside the `try`**.
- The `catch` at `pos.js:408` **only** calls `showError('Failed to fetch
  orders')` — a toast. It does not set an error state, does not mark the board
  stale, and does not stop the poll.
- `showError` (`pos.js:37`) **auto-hides after 3000ms**.
- The poll (`pos.js:331`) runs every **7000ms**.

So after a failed refresh the only evidence is a toast visible for 3s out of
every 7 — **≈43% of the time**. For the remaining 57% the cashier sees an empty
board and a **green OPEN badge**. Verified directly:
`#orderBoard.textContent === ""` with the OPEN badge lit.

The two states that must never look alike — "the queue is clear" and "I cannot
see the queue" — are pixel-identical for most of every polling cycle. On a
Sunday that means a volunteer walking away from a counter with live orders on
it.

Worth noting the fix is not "make the toast louder": the toast is the wrong
instrument. The board itself needs a stale/error state, and the last-successful
fetch time (`updateLastRefresh`) is already computed and available to drive it.

**2 — Stored XSS in the cashier's authenticated POS session. FIXED in v1.74.0.**
Retained here because the audit found it independently and the score above was
computed with it open. Customer-controlled `customerName`, `items[].name`,
`items[].variant` and `notes` were raw `innerHTML` interpolations on the queue
card, the order detail and the in-POS prep view; `frontend/prep.html` escaped
nothing at all. The POS session holds a **CASHIER JWT**, so this was
privilege-bearing. See `docs/update-20260817.md` for the finding and the fix.

## P1

**3 — The empty-state instruction names a button the user cannot see.**
`pos.js:192` renders "⚠️ CAFÉ IS CLOSED — Customers cannot order. **Tap Open to
start service.**" The `btnCafeToggle` it refers to is in the sidebar
(`pos.js:174`), and `.pos-sidebar` is `transform:translateX(-100%)`
(`style.css:2172`) — **at every width**. Only `.pos-sidebar.open`
(`style.css:2176`) brings it on screen. The `@media(min-width:900px)` block
(`style.css:2214`) that looks like it should reveal the sidebar on a landscape
iPad **only sets `.pos-main{margin-left:220px}`** — it never touches the
transform. At 220px wide, off-canvas, the button sits at roughly
`left:-212px`.

A first-time volunteer is told to tap something ~212px off the left edge of the
screen, with no indication a hamburger has to be opened first.

**4 — Disabled primaries do not look disabled, and the checklist hides its own
tail.** Two independent problems that compound into one bad outcome.

- There is **no `:disabled` rule for `.pos-btn` anywhere** in `style.css`. The
  only disabled styling in the whole file is
  `.pos-btn-preorder-release[disabled]` (`style.css:1346`). So a disabled
  primary renders as the **full brown gradient with `cursor:pointer`** —
  identical to an enabled one.
- `.checklist-items` caps at `max-height:50vh` (`style.css:2079`).

On the counter iPad the real **12-item** checklist therefore shows about **8**,
with **no scroll affordance**, and the Open Café button beneath it looks
pressable but silently does nothing. The volunteer's model is "the button is
broken", not "there are four more items". Among the hidden four is **"Enable
menu items & food quantities in POS"** — so the failure mode is the café opening
with items unavailable, which is exactly the kind of Sunday-morning confusion
this checklist exists to prevent.

**5 — The queue sorts newest-first, which buries the order that most needs
attention.** In kanban mode (`pos.js:676-680`) PENDING sorts receipt-first, then
`new Date(b.createdAt) - new Date(a.createdAt)` — **descending**. The urgent
marker fires at `mins > 10` (`pos.js:760`). A 17-minute order that had **already
rung the chime** rendered **sixth**, roughly **1100px below the fold**. The
system knows the order is urgent, says so audibly, and then sorts it out of
sight.

Two aggravations in the same function:
- **`preparing` and `ready` get no `.sort()` at all** (`pos.js:681-682`) — they
  render in whatever order the API returned.
- **List view sorts differently again** (`pos.js:694`): `createdAt` descending
  with **no receipt-first tier**. So switching view silently changes the
  ordering of the same queue.

Any FIFO decision should be made once, in one place, for all three columns and
both views.

## Further verified defects

Each was confirmed in the file, not inferred.

- **List view snaps back to the Pending tab every 7 seconds.**
  `pos.js:690-694` rebuilds the tab strip with `class="pos-tab active"`
  hardcoded on PENDING and `#listItems` filtered to PENDING. The tab click
  handler mutates the DOM only, so the next poll discards the volunteer's
  choice. List view is effectively unusable for watching Preparing or Ready.
- **The sidebar status dot is permanently grey on first login while the header
  badge reads OPEN.** `pos.js:169` renders the dot from `cafeOpen` at
  render time; `fetchCafeStatus` (`pos.js:284`) resolves later and updates the
  header badge (`:284-328`) but never re-renders the sidebar. Two indicators of
  one fact, disagreeing, on the status dimension that already scores 1/4.
- **Column headers and the controls bar scroll away.** `position:sticky` is set
  on `.pos-topbar` (`style.css:1211-1222`) — a class that is **rendered
  nowhere**. Grepped across `frontend/js/` and every `frontend/*.html`: zero
  occurrences outside the stylesheet (plus its own `max-width:768px` override at
  `:2134`). The sticky rule has never applied to anything.
- **Contrast failures on the three fastest-scanned pieces of text**, computed
  from the tokens rather than eyeballed:
  - PENDING column header — `--warning:#C47F17` on `--warning-bg:#FEF3C7` =
    **2.95:1** (`style.css:1371-1375`)
  - READY column header — `--success:#2D8A4E` on `--success-bg:#E8F5EC` =
    **3.85:1** (`style.css:1381-1385`)
  - Wait time in the card footer — `#9CA3AF` on white = **2.54:1**
    (`style.css:1606-1612`)

  All three fail WCAG AA (4.5:1 normal, 3:1 large). The wait time is the worst
  of the three **and is the element that carries the `⚠️` urgent marker**
  (`pos.js:818`), so the weakest contrast on the surface is on its most
  time-critical value.
- **The portrait breakpoint lands exactly on the iPad's portrait width.**
  `@media(max-width:768px)` (`style.css:2124`) — an iPad in portrait is
  **768px** CSS px, so it sits precisely on the boundary. `max-width` is
  inclusive so it does apply, but a layout whose correctness depends on an
  inclusive comparison at the exact width of the only device in use is one
  rounding change away from flipping. Flagged as fragile, not broken. **Not
  verified on real hardware** — see the method section.
- **One long name can crush two columns.** `.pos-kanban` is
  `grid-template-columns:1fr 1fr 1fr` (`style.css:1357`) with **no
  `minmax(0,…)`**. `1fr` is `minmax(auto,1fr)`, so a long unbroken customer
  name raises one column's min-content width and squeezes the other two to
  ~110px.
- **Touch targets under 44px, and the guard is on the wrong button.**
  `pos.html:15`: **Logout measures 73×29** and is **unguarded** — one stray tap
  ends the session mid-service — while **Tutorial**, beside it, is
  confirm-gated. The destructive action is the unprotected one.
- **The most destructive action on the surface is guarded only by
  `window.confirm`.** `pos-checklist.js:151` expires **live orders**
  (`This will expire ${activeCount} active order(s). Continue?`) behind a native
  confirm — on the same iPad for which `window.confirm` was already judged
  unusable and replaced by custom dialogs for the *less* destructive staff-price
  and release paths (the code says so itself at `pos.js:942`). The project
  already knows the right pattern and applied it everywhere except here.
- **Every login failure says "Invalid PIN."** `pos.js:136` catches all errors
  and shows one message, so a wrong user ID, a network failure and a 500 are
  indistinguishable from a mistyped PIN. A volunteer will keep re-entering a
  correct PIN against a backend that is down.
- **Latent: an empty checklist config would disable Open Café forever.**
  `pos-checklist.js:59-60`: `allChecked = items.length > 0 && items.every(…)`.
  With zero configured items this is `false`, so the café can never be opened
  and there is no item to tick to change that. Not currently reachable — the
  config is populated — and it fails closed rather than open, but it is one bad
  settings record away from a Sunday with no service. Related to the "no
  silently-skipped feature when its config is missing" invariant.

## Improvements (not defects)

- **Differentiate `✓ Approve` from `✓ Ready` by colour.** Both render as
  `pos-btn-primary` in the same position on the card (`pos.js:765-766`), so two
  different state transitions are one identical-looking green tap apart.
- **Invert the card hierarchy.** The drinks are currently the quietest text on
  the card, below the name, badges and pills — yet they are what the barista
  actually makes.
- **`#posStats` is `display:none` by default** (`style.css:1250-1251`, toggled
  by `.visible` via `pos.js:260`). The day's numbers are one tap away but
  invisible, so in practice nobody looks at them.
- **Make the walk-up grid layout the default.** `pos-walkup.js:20` defaults to
  `'list'` unless `localStorage.walkup_layout === 'grid'`; the block layout was
  built for the counter and has larger tap targets.
- **`prep.html` is orphaned.** Grepped the whole of `frontend/` — **nothing
  links to it**, from any page or script. The barista reaches it by typing a
  URL. It is also missing from the `sw.js` `SHELL` array (follow-up **n**), so
  it is not precached either.
- **The empty state teaches nothing.** "No orders" is a dead end; it is the
  moment with the most attention available and the least competing information,
  and it could name the next action.

## Open question — decide this before polishing the kanban

**For one volunteer, on one tablet, doing one thing at a time — is a single FIFO
list better than three columns of which two are always mostly off-screen?**

The three-column board carries real cost: it is the source of P1 #5 (three
different sort behaviours), of the list-view tab reset, and of the
`1fr 1fr 1fr` crush. A single time-ordered list with status as a property of the
row would delete all three at once.

This is a **product decision, not a styling one**, and it should be settled
before anyone spends effort on column headers, sticky bars or contrast tokens
inside the kanban — that work is wasted if the kanban goes away. A preview mock
is being built at `tmp/pos-mock.html` (gitignored, deliberately not part of this
release).

## What this audit did not cover

- No real-hardware pass on the counter iPad (iOS Safari).
- No multi-order behaviour observed against genuinely created orders — see the
  simulation caveat.
- No audit of the customer-facing pages, admin, or `display.html`.
- The mechanical counts are floors; a non-degraded detector run would likely
  find more contrast and touch-target failures than the ones listed.
