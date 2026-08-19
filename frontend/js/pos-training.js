// ─── POS Training Mode (v2) ─────────────────────────────────────────
// System-driven guided tour using TourGuide.js. Steps defined in
// training-config.json. Each step has an `action` field; when the user
// clicks "Do it →", the CURRENT step's action fires programmatically
// (order state change, sidebar toggle, etc.) BEFORE the tour advances
// to the next step. This removes the ambiguity of expecting the user
// to click UI elements manually.
//
// Design notes:
// - Mock API intercept prevents real backend calls during training.
// - `orders` array is aliased to `mockOrders` (via the mock's
//   Promise.resolve({ orders: mockOrders })) so in-place mutations
//   (status change / splice / push) are picked up by renderBoard().
// - Sidebar is force-opened on start so cashiers can see nav items.
// - Café is simulated as OPEN so the "closed" banner never shows.
// - Back button is hidden (state changes are one-way in this flow).

let trainingMode = false;
let onboardingProgress = [];
let trainingConfig = null;
let tourGuide = null;

// Mock order state for training. training-001 has a receiptUrl so the
// 💰 badge shows in the card, matching the walkthrough narration.
let mockOrders = [
  {
    orderId: 'training-001',
    customerName: 'Sarah',
    status: 'PENDING',
    items: [{ name: 'Latte', quantity: 1, category: 'DRINK', menuItemId: 'mock-1' }],
    createdAt: new Date().toISOString(),
    totalAmount: 8,
    receiptUrl: 'mock-receipt',
    receiptAmount: 8,
  },
  {
    orderId: 'training-002',
    customerName: 'Daniel',
    status: 'PENDING',
    items: [
      { name: 'Long Black', quantity: 1, category: 'DRINK', menuItemId: 'mock-2' },
      { name: 'Mocha', quantity: 1, category: 'DRINK', menuItemId: 'mock-3' },
    ],
    createdAt: new Date().toISOString(),
    totalAmount: 16,
  },
];

const mockMenu = [
  { menuItemId: 'mock-1', name: 'Latte', category: 'DRINK', basePrice: 8, isActive: true, isEnabledToday: true, sortOrder: 1 },
  { menuItemId: 'mock-2', name: 'Long Black', category: 'DRINK', basePrice: 7, isActive: true, isEnabledToday: true, sortOrder: 2 },
  { menuItemId: 'mock-3', name: 'Mocha', category: 'DRINK', basePrice: 9, isActive: true, isEnabledToday: true, sortOrder: 3 },
  { menuItemId: 'mock-4', name: 'Nasi Lemak', category: 'FOOD', basePrice: 5, isActive: true, isEnabledToday: true, foodQuantityToday: 10, foodReserved: 0, sortOrder: 4 },
];

const mockIngredients = [
  { ingredientId: 'mock-ing-1', name: 'Coffee Beans', unit: 'g', currentStock: 500, lowStockThreshold: 100, storageLocation: 'storeroom', isActive: true },
  { ingredientId: 'mock-ing-2', name: 'Milk', unit: 'ml', currentStock: 2000, lowStockThreshold: 500, storageLocation: 'fridge', isActive: true },
];

// Save reference to real API function
const _realApi = typeof api === 'function' ? api : null;

function mockTrainingApi(method, path, body) {
  // Café status — always OPEN in training
  if (path.includes('/api/cafe/status')) {
    return Promise.resolve({
      cafeStatus: 'OPEN',
      queueSize: mockOrders.filter(o => o.status === 'PENDING').length,
      celebrationMode: typeof celebrationMode !== 'undefined' ? !!celebrationMode : false,
      featuredDrink: null,
    });
  }
  // Orders — return the LIVE mockOrders reference so in-place mutations
  // are picked up by the caller (pos.js sets `orders = list`).
  if (method === 'GET' && path.includes('/api/pos/orders')) {
    return Promise.resolve({ orders: mockOrders });
  }
  // Shift summary
  if (path.includes('/api/pos/shift-summary')) {
    return Promise.resolve({
      completed: 0,
      revenue: 0,
      pending: mockOrders.filter(o => o.status === 'PENDING').length,
      preparing: mockOrders.filter(o => o.status === 'PREPARING').length,
    });
  }
  // Approve
  if (method === 'PUT' && path.includes('/approve')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const order = mockOrders.find(o => o.orderId === id);
    if (order) { order.status = 'PREPARING'; order.approvedAt = new Date().toISOString(); }
    return Promise.resolve({ orderId: id, status: 'PREPARING' });
  }
  // Undo-ready (READY → PREPARING). MUST be tested before `/ready`, which
  // `/undo-ready` also contains as a substring.
  if (method === 'PUT' && path.includes('/undo-ready')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const order = mockOrders.find(o => o.orderId === id);
    if (order) { order.status = 'PREPARING'; delete order.readyAt; }
    return Promise.resolve({ orderId: id, status: 'PREPARING' });
  }
  // Undo (PREPARING → PENDING)
  if (method === 'PUT' && path.includes('/undo')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const order = mockOrders.find(o => o.orderId === id);
    if (order) { order.status = 'PENDING'; delete order.approvedAt; }
    return Promise.resolve({ orderId: id, status: 'PENDING' });
  }
  // Mark ready
  if (method === 'PUT' && path.includes('/ready')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const order = mockOrders.find(o => o.orderId === id);
    if (order) { order.status = 'READY'; order.readyAt = new Date().toISOString(); }
    return Promise.resolve({ orderId: id, status: 'READY' });
  }
  // Reject a PENDING order — removes it from the board, as the real
  // CANCELLED transition does (cancelled orders drop out of the POS queue).
  if (method === 'PUT' && path.includes('/reject')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const idx = mockOrders.findIndex(o => o.orderId === id);
    if (idx >= 0) mockOrders.splice(idx, 1);
    return Promise.resolve({ orderId: id, status: 'CANCELLED' });
  }
  // Archive/collect
  if (method === 'PUT' && path.includes('/archive')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const idx = mockOrders.findIndex(o => o.orderId === id);
    if (idx >= 0) mockOrders.splice(idx, 1);
    return Promise.resolve({ orderId: id, status: 'ARCHIVED' });
  }
  // Walk-up order creation
  if (method === 'POST' && path.includes('/api/pos/orders')) {
    const newOrder = {
      orderId: 'training-walkup-' + Date.now(),
      customerName: body?.customerName || 'Walk-up',
      status: 'PREPARING',
      items: body?.items || [],
      createdAt: new Date().toISOString(),
      totalAmount: body?.totalAmount || 0,
    };
    mockOrders.push(newOrder);
    return Promise.resolve({ orderId: newOrder.orderId, status: 'PREPARING', totalAmount: newOrder.totalAmount });
  }
  // Menu (cashier menu toggle view)
  if (path.includes('/api/pos/menu')) {
    if (method === 'PUT' && path.includes('/toggle')) {
      return Promise.resolve({ toggled: true });
    }
    return Promise.resolve({ items: mockMenu });
  }
  // Ingredients / stock
  if (path.includes('/api/pos/ingredients')) {
    if (method === 'PUT') return Promise.resolve({ success: true });
    return Promise.resolve(mockIngredients);
  }
  // Café open/close toggle
  if (path.includes('/api/pos/cafe/close') || path.includes('/api/pos/cafe/open')) {
    return Promise.resolve({ cafeStatus: 'CLOSED' });
  }
  // Celebration toggle
  if (path.includes('/api/pos/cafe/celebration')) {
    return Promise.resolve({ celebrationMode: !!body?.enabled });
  }
  // Checklist config
  if (path.includes('/api/admin/checklist')) {
    return Promise.resolve({ config: { open: [], close: [], handover: [] } });
  }
  // Onboarding progress — this one goes to real backend
  if (path.includes('/api/pos/onboarding-progress')) {
    return _realApi(method, path, body);
  }
  // Default fallback
  return Promise.resolve({});
}

async function initTrainingMode(progress) {
  trainingMode = true;
  onboardingProgress = progress || [];

  // Simulate café is OPEN during training so the closed banner never
  // shows and the handover button (which hides when closed) is visible.
  if (typeof cafeOpen !== 'undefined') cafeOpen = true;

  // Override global api function
  window._origApi = api;
  api = function (method, path, body) {
    if (trainingMode && !path.includes('/api/pos/onboarding-progress')) {
      return mockTrainingApi(method, path, body);
    }
    return window._origApi(method, path, body);
  };

  // Load training config
  try {
    const res = await fetch('js/training-config.json');
    trainingConfig = await res.json();
  } catch (e) {
    console.error('Failed to load training config:', e);
    return;
  }
}

// ─── Action executor ────────────────────────────────────────────────
// Each step's `action` field maps to a case below. Actions mutate the
// mock state in-place and re-render the board so the user visually
// sees the effect between steps.

function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Gap kept between the dialog and the screen edge when clamping. */
const TG_EDGE_MARGIN = 12;

/**
 * Keep the TourGuide dialog fully on screen.
 *
 * TourGuide places the dialog relative to its target and does not verify the
 * result fits the viewport. Measured on the "Order Board" step: x=-128 on both
 * iPad landscape (1024x768) and portrait (768x1024), clipping the left ~130px of
 * every line of text; on iPad Pro (1366x1024) it instead ran off the bottom.
 * Either way the trainee loses part of the instructions.
 *
 * Writes `left`/`top` with !important because TourGuide sets them inline itself,
 * and re-reads the rect each call so it is safe to invoke repeatedly.
 */
function clampTourDialog() {
  const dlg = document.querySelector('.tg-dialog');
  if (!dlg) return;
  // While a POS modal is open, placeDialogClearOfModal owns the position: it has
  // deliberately parked the dialog beside or above the modal. Clamping on top of
  // that kept dragging it back over the buttons, because onAfterStepChange fires
  // after the move and re-measures a mid-transition rect.
  if (document.querySelector('.pos-modal-overlay')) return;
  const r = dlg.getBoundingClientRect();
  if (!r.width || !r.height) return;

  const maxLeft = Math.max(TG_EDGE_MARGIN, window.innerWidth - r.width - TG_EDGE_MARGIN);
  const maxTop = Math.max(TG_EDGE_MARGIN, window.innerHeight - r.height - TG_EDGE_MARGIN);
  const left = Math.min(Math.max(r.left, TG_EDGE_MARGIN), maxLeft);
  const top = Math.min(Math.max(r.top, TG_EDGE_MARGIN), maxTop);

  // Only touch the style when it actually moves, so we don't fight TourGuide's
  // own transitions on steps that were already positioned correctly.
  if (Math.abs(left - r.left) > 1) dlg.style.setProperty('left', `${left}px`, 'important');
  if (Math.abs(top - r.top) > 1) dlg.style.setProperty('top', `${top}px`, 'important');
}

/**
 * Re-clamp whenever TourGuide repositions the dialog.
 *
 * It repositions on scroll, resize and its own internal updates, any of which
 * can push the dialog back off screen after a single clamp. A MutationObserver
 * on the dialog's style attribute catches all of them without polling; guarded
 * by a flag so a clamp of our own doesn't retrigger the observer forever.
 */
let tgClampObserver = null;
let tgClamping = false;

function watchTourDialogPosition() {
  const dlg = document.querySelector('.tg-dialog');
  if (!dlg || typeof MutationObserver === 'undefined') return;
  if (tgClampObserver) tgClampObserver.disconnect();

  tgClampObserver = new MutationObserver(() => {
    if (tgClamping) return;
    tgClamping = true;
    clampTourDialog();
    // Release on the next frame: the clamp itself mutates `style`, which would
    // otherwise re-enter this callback immediately.
    requestAnimationFrame(() => { tgClamping = false; });
  });
  tgClampObserver.observe(dlg, { attributes: true, attributeFilter: ['style'] });

  window.addEventListener('resize', clampTourDialog);
  window.addEventListener('orientationchange', clampTourDialog);
}

function unwatchTourDialogPosition() {
  if (tgClampObserver) { tgClampObserver.disconnect(); tgClampObserver = null; }
  // Stop the modal-placement interval too, so nothing keeps running after exit.
  if (tgModalPlaceTimer) { clearInterval(tgModalPlaceTimer); tgModalPlaceTimer = null; }
  window.removeEventListener('resize', clampTourDialog);
  window.removeEventListener('orientationchange', clampTourDialog);
}

/**
 * Re-point step `index` at a LIVE element before TourGuide shows it.
 *
 * TourGuide resolves `step.target` from a selector string to an element the
 * first time it displays that step, then keeps the element
 * (`tourSteps[i].target = document.querySelector(...)`). Its re-resolve only
 * happens while the value is still a string.
 *
 * Every training action re-renders the order board, which rewrites
 * `#orderBoard.innerHTML` and throws away the card nodes — so any cached card
 * element is detached by the time its step is shown. A detached target means
 * no highlight and a dialog stranded at the top-left corner. Writing the
 * selector string back makes TourGuide look the element up again.
 *
 * If the selector no longer matches anything (e.g. the order was archived and
 * its card is gone), the target is dropped so TourGuide centres the dialog on
 * `document.body` instead of pointing at nothing.
 */
async function resolveStepTarget(index) {
  if (!tourGuide || !Array.isArray(tourGuide.tourSteps)) return;
  const tgStep = tourGuide.tourSteps[index];
  const configStep = trainingConfig?.steps?.[index];
  if (!tgStep || !configStep) return;

  const selector = configStep.target;
  if (!selector) { delete tgStep.target; return; }

  // Cards are re-rendered asynchronously; give the DOM a brief chance to
  // settle so a freshly-created card is found rather than skipped.
  let el = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { el = document.querySelector(selector); } catch (e) { el = null; break; }
    if (el) break;
    await waitMs(50);
  }

  if (el) tgStep.target = selector;   // string → TourGuide re-resolves it
  else delete tgStep.target;          // nothing to point at → centred dialog
}

function refreshTrainingBoard() {
  // Alias orders → mockOrders so renderBoard reads the current mock state.
  if (typeof orders !== 'undefined') {
    // Keep the same reference wherever possible so pending diff logic in
    // fetchOrders doesn't fire spurious "cancelled" toasts on next poll.
    orders = mockOrders;
  }
  if (typeof renderBoard === 'function') renderBoard();
}

// How long the order-detail modal stays on screen before the tour clicks the
// action button for the trainee.
//
// It has to cover THREE things in sequence: notice the modal opened, read which
// of Payment Confirmed / Newcomer / Reject is ringed, and register the click.
//
// Tuned by feedback rather than theory: 1400ms was far too fast, 3200ms was
// still reported as rushed, so 6200ms. Erring long is the right trade here —
// this runs once per volunteer during training, never during service, and the
// Hold button means an impatient reader is never actually stuck waiting.
//
// The Reject step spends this twice (action buttons, then the reason picker),
// which is correct — it is two separate decisions.
const MODAL_DWELL_MS = 6200;
// Pause after the click so the resulting board change is visibly connected to
// the button press rather than appearing to happen on its own.
const POST_CLICK_MS = 900;
// Pause after a board-only state change (approve/undo/ready with no modal) so
// the card is seen moving between columns.
const BOARD_SETTLE_MS = 1100;

/**
 * Open the REAL order-detail modal for a training order and hand it back.
 *
 * Order actions in this POS live inside that modal — "✓ Payment Confirmed",
 * "↩ Undo", "✓ Ready", "✓ Collected", "✗ Reject". The tour previously mutated
 * `mockOrders` directly, so the card silently changed column and the trainee
 * was never shown the dialog they will actually be tapping on a Sunday. Every
 * API call is mocked during training, so driving the genuine UI is safe.
 *
 * Returns null if the modal could not be opened, so callers can fall back to a
 * direct state change rather than stalling the tour.
 */
async function openTrainingDetail(orderId, highlightSelector) {
  if (typeof openDetail !== 'function') return null;
  // `openDetail` reads from the global `orders`; make sure it points at the
  // current mock state before it looks the order up.
  refreshTrainingBoard();
  await waitMs(150);

  try { openDetail(orderId); } catch (e) {
    console.error('Training: could not open detail modal for', orderId, e);
    return null;
  }

  const modal = document.querySelector('.pos-modal-overlay');
  if (!modal) return null;

  // Mark the button the tour is about to press BEFORE the dwell. The detail
  // modal offers three similar-looking buttons (Payment Confirmed / Newcomer /
  // Reject), and without this the trainee saw the modal appear and vanish with
  // no clue which one was used — the step's whole point.
  highlightModalButton(modal, highlightSelector);
  // The tour dialog is anchored to the card BEHIND this modal, so it lands on
  // top of it and hides the buttons being explained. Shift it aside.
  moveTourDialogClearOfModal(modal);

  // Countdown with a Hold button rather than a blind wait — the trainee decides
  // when they have read enough.
  await dwellWithHold(modal, MODAL_DWELL_MS, labelForSelector(highlightSelector));
  return modal;
}

/**
 * Human wording for the button a step is about to press, used in the countdown.
 * Falls back to a generic phrase so an unmapped selector still reads sensibly.
 */
function labelForSelector(selector) {
  const map = {
    '#btnApprove': 'Confirming payment',
    '#btnUndo': 'Undoing',
    '#btnReady': 'Marking ready',
    '#btnCollected': 'Collecting',
    '#btnReject': 'Rejecting',
    '#btnUndoReady': 'Moving back to Preparing',
  };
  return map[selector] || 'Continuing';
}

/**
 * Wait `ms`, showing a countdown the trainee can pause.
 *
 * A fixed dwell is only ever a guess at someone's reading speed, and volunteers
 * reported the modal steps going too fast. This shows what is about to happen,
 * counts down, and offers a Hold button that stops the clock indefinitely — so a
 * slow reader is never rushed and a confident one is not made to wait.
 */
function dwellWithHold(modal, ms, label) {
  return new Promise(resolve => {
    const host = modal?.querySelector('.pos-modal');
    if (!host) { setTimeout(resolve, ms); return; }

    const bar = document.createElement('div');
    bar.className = 'training-dwell';
    bar.innerHTML = `<span class="training-dwell-text">${label} in <b class="training-dwell-n">${Math.ceil(ms / 1000)}</b>s</span>`
      + `<button type="button" class="pos-btn pos-btn-sm training-dwell-hold">⏸ Hold</button>`;
    host.appendChild(bar);

    let remaining = ms;
    let held = false;
    const nEl = bar.querySelector('.training-dwell-n');
    const holdBtn = bar.querySelector('.training-dwell-hold');

    const tick = setInterval(() => {
      if (held) return;
      remaining -= 100;
      if (nEl) nEl.textContent = String(Math.max(0, Math.ceil(remaining / 1000)));
      if (remaining <= 0) { finish(); }
    }, 100);

    function finish() {
      clearInterval(tick);
      if (bar.isConnected) bar.remove();
      resolve();
    }

    holdBtn.onclick = () => {
      held = !held;
      holdBtn.textContent = held ? '▶ Continue' : '⏸ Hold';
      bar.classList.toggle('training-dwell-held', held);
      const t = bar.querySelector('.training-dwell-text');
      if (t) t.innerHTML = held
        ? 'Paused — take your time'
        : `${label} in <b class="training-dwell-n">${Math.max(1, Math.ceil(remaining / 1000))}</b>s`;
    };
  });
}

/**
 * Ring the button the tutorial is about to click, and dim its siblings.
 *
 * TourGuide's own highlight cannot be used here: its backdrop sits below the POS
 * modal (z-index 500+), so the "spotlight" would be hidden behind it. This is a
 * plain class the CSS animates instead.
 */
function highlightModalButton(modal, selector) {
  if (!modal || !selector) return null;
  const btn = modal.querySelector(selector);
  if (!btn) return null;
  modal.querySelectorAll('.pos-detail-actions button').forEach(b => {
    b.classList.toggle('training-cue', b === btn);
    b.classList.toggle('training-dim', b !== btn);
  });
  return btn;
}

/**
 * Move the tour dialog clear of the POS modal.
 *
 * TourGuide anchors the dialog to the order CARD, which sits behind the detail
 * modal — so the dialog landed on top of the modal and covered the very buttons
 * the step is explaining. Rather than fight z-index (the dialog has to stay
 * readable), park it on whichever side has more free space beside the modal.
 *
 * Position is restored by the next step's own repositioning, so nothing needs
 * undoing.
 */
function moveTourDialogClearOfModal(modal) {
  const dlg = document.querySelector('.tg-dialog');
  if (!dlg || !modal) return;
  const box = modal.querySelector('.pos-modal');
  if (!box) return;

  // Suppress the reposition observer for the duration of this move. Each style
  // write below triggers it, and clampTourDialog would then re-measure a
  // half-applied layout and drag the dialog back over the modal — which is why
  // the portrait "place it above" branch appeared not to run at all.
  // TourGuide runs its own updatePositions() after a step settles and re-anchors
  // the dialog to the order CARD, undoing a single placement — measured: the
  // dialog went straight back to top=705, sitting over the modal. Re-apply on a
  // short interval for the duration of the dwell so the last word is ours.
  const apply = () => {
    if (!document.querySelector('.pos-modal-overlay')) return false;
    tgClamping = true;
    placeDialogClearOfModal(dlg, box);
    requestAnimationFrame(() => { tgClamping = false; });
    return true;
  };
  apply();
  if (tgModalPlaceTimer) clearInterval(tgModalPlaceTimer);
  tgModalPlaceTimer = setInterval(() => {
    // Stops itself once the modal closes, so it never outlives the step.
    if (!apply()) { clearInterval(tgModalPlaceTimer); tgModalPlaceTimer = null; }
  }, 120);
}

/** Interval that keeps the dialog clear of an open POS modal. */
let tgModalPlaceTimer = null;

/** Geometry half of moveTourDialogClearOfModal; see that function's comment. */
function placeDialogClearOfModal(dlg, box) {

  const m = box.getBoundingClientRect();
  const gap = 12;
  const MIN_W = 200;   // below this the narration is unreadable

  const spaceRight = window.innerWidth - m.right - gap * 2;
  const spaceLeft = m.left - gap * 2;
  // Measured from the modal edge to the screen edge, leaving one gap at each
  // end. Recomputed here rather than reused later, because the dialog's height
  // changes once its width is overridden.
  const spaceBelow = window.innerHeight - m.bottom - gap * 2;
  const spaceAbove = m.top - gap * 2;

  // The detail modal is 500px wide, which on a 1024px iPad leaves only ~262px
  // either side — less than the dialog's natural 340px. So narrow the dialog to
  // fit the gap rather than giving up and leaving it over the buttons.
  const side = Math.max(spaceRight, spaceLeft);
  if (side >= MIN_W) {
    const w = Math.min(340, side);
    dlg.style.setProperty('max-width', `${w}px`, 'important');
    dlg.style.setProperty('width', `${w}px`, 'important');
    // Re-measure: the height grows as the width shrinks.
    const d = dlg.getBoundingClientRect();
    const left = (spaceRight >= spaceLeft) ? (m.right + gap) : (m.left - w - gap);
    dlg.style.setProperty('left', `${Math.round(left)}px`, 'important');
    dlg.style.setProperty('top', `${Math.round(Math.max(gap, m.top + (m.height - d.height) / 2))}px`, 'important');
  } else {
    // No usable side room. On a portrait iPad the modal is bottom-anchored and
    // full-width (0,715 768x309 measured), so the only space is ABOVE it —
    // prefer whichever gap is genuinely larger and actually fits the dialog.
    const d = dlg.getBoundingClientRect();
    const fitsAbove = spaceAbove >= d.height;
    const fitsBelow = spaceBelow >= d.height;

    if (fitsAbove && (spaceAbove >= spaceBelow || !fitsBelow)) {
      dlg.style.setProperty('top', `${Math.round(Math.max(gap, m.top - d.height - gap))}px`, 'important');
    } else if (fitsBelow) {
      dlg.style.setProperty('top', `${Math.round(m.bottom + gap)}px`, 'important');
    } else {
      // Neither gap fits at full height: shrink to the larger gap so the dialog
      // and the modal can coexist rather than overlapping.
      const avail = Math.max(spaceAbove, spaceBelow);
      dlg.style.setProperty('max-height', `${Math.max(140, avail)}px`, 'important');
      dlg.style.setProperty('overflow-y', 'auto', 'important');
      dlg.style.setProperty('top', spaceAbove >= spaceBelow
        ? `${gap}px`
        : `${Math.round(m.bottom + gap)}px`, 'important');
    }
    // Centre horizontally against the modal instead of hugging its left edge.
    const w = d.width;
    dlg.style.setProperty('left', `${Math.round(Math.max(gap, m.left + (m.width - w) / 2))}px`, 'important');
  }

  // No clampTourDialog() here: it now bails out while a modal is open (this
  // function owns the position), and every branch above already keeps the dialog
  // inside the viewport by construction.
}

/**
 * Click a button inside the detail modal the way the trainee would.
 *
 * The handlers are async (mocked `api()` call, then `modal.remove()` and
 * `fetchOrders()`), so wait for the state change to land before the tour moves
 * on. Returns false if the button wasn't there.
 */
async function clickModalAction(modal, selector) {
  const btn = modal?.querySelector(selector);
  if (!btn) return false;
  btn.click();
  await waitMs(POST_CLICK_MS);
  // Belt and braces: if a handler bailed before removing the overlay, don't
  // leave it covering the next tour step.
  if (modal.isConnected) modal.remove();
  refreshTrainingBoard();
  return true;
}

async function executeTrainingAction(actionId) {
  switch (actionId) {
    case 'none':
      return;
    case 'click-approve-training-001': {
      // Show the PENDING modal, then confirm payment — the real approve path.
      const modal = await openTrainingDetail('training-001', '#btnApprove');
      if (await clickModalAction(modal, '#btnApprove')) return;
      // Fallback: modal unavailable, change state directly so the tour
      // narration still matches the board.
      const order = mockOrders.find(o => o.orderId === 'training-001');
      if (order) { order.status = 'PREPARING'; order.approvedAt = new Date().toISOString(); }
      refreshTrainingBoard();
      await waitMs(BOARD_SETTLE_MS);
      return;
    }
    case 'click-undo-training-001': {
      const modal = await openTrainingDetail('training-001', '#btnUndo');
      if (await clickModalAction(modal, '#btnUndo')) return;
      const order = mockOrders.find(o => o.orderId === 'training-001');
      if (order) { order.status = 'PENDING'; delete order.approvedAt; }
      refreshTrainingBoard();
      await waitMs(BOARD_SETTLE_MS);
      return;
    }
    case 'click-ready-training-001': {
      const modal = await openTrainingDetail('training-001', '#btnReady');
      if (await clickModalAction(modal, '#btnReady')) return;
      const order = mockOrders.find(o => o.orderId === 'training-001');
      if (order) { order.status = 'READY'; order.readyAt = new Date().toISOString(); }
      refreshTrainingBoard();
      await waitMs(BOARD_SETTLE_MS);
      return;
    }
    case 'click-archive-training-001': {
      const modal = await openTrainingDetail('training-001', '#btnCollected');
      if (await clickModalAction(modal, '#btnCollected')) return;
      const idx = mockOrders.findIndex(o => o.orderId === 'training-001');
      if (idx >= 0) mockOrders.splice(idx, 1);
      refreshTrainingBoard();
      await waitMs(BOARD_SETTLE_MS);
      return;
    }
    case 'click-cancel-training-002': {
      // Cancelling a PENDING order is "Reject", which opens a second dialog
      // asking for a reason. Show both — the step narration promises a reason
      // is logged for admin review.
      const modal = await openTrainingDetail('training-002', '#btnReject');
      const rejectBtn = modal?.querySelector('#btnReject');
      if (rejectBtn) {
        rejectBtn.click();                 // reveals the reason picker
        // Cue the reason that will be chosen, and clear the cue from the action
        // buttons so two highlights aren't competing.
        modal.querySelectorAll('.pos-detail-actions button')
          .forEach(b => b.classList.remove('training-cue', 'training-dim'));
        const reason = modal.querySelector('.pos-reject-picker button');
        if (reason) {
          reason.classList.add('training-cue');
          modal.querySelectorAll('.pos-reject-picker button')
            .forEach(b => { if (b !== reason) b.classList.add('training-dim'); });
        }
        await dwellWithHold(modal, MODAL_DWELL_MS, 'Choosing a reason');
        if (reason) {
          reason.click();
          await waitMs(POST_CLICK_MS);
          if (modal.isConnected) modal.remove();
          refreshTrainingBoard();
          return;
        }
        if (modal.isConnected) modal.remove();
      }
      const idx = mockOrders.findIndex(o => o.orderId === 'training-002');
      if (idx >= 0) mockOrders.splice(idx, 1);
      refreshTrainingBoard();
      await waitMs(BOARD_SETTLE_MS);
      return;
    }
    case 'open-walkup-demo': {
      // Add a mock walk-up order to demonstrate the outcome without
      // opening the real walk-up modal (which needs a full menu load).
      mockOrders.push({
        orderId: 'training-walkup-1',
        customerName: 'Walk-up: Emily',
        status: 'PREPARING',
        items: [{ name: 'Mocha', quantity: 1, category: 'DRINK' }],
        createdAt: new Date().toISOString(),
        totalAmount: 9,
      });
      refreshTrainingBoard();
      await waitMs(BOARD_SETTLE_MS);
      return;
    }
    case 'toggle-celebration': {
      if (typeof celebrationMode !== 'undefined') {
        celebrationMode = !celebrationMode;
      }
      const celeb = document.getElementById('btnCelebration');
      if (celeb) {
        celeb.classList.toggle('active', !!celebrationMode);
        celeb.textContent = celebrationMode ? '🎉 Celebration: ON' : '🎉 Celebration: OFF';
        celeb.setAttribute('aria-pressed', celebrationMode ? 'true' : 'false');
      }
      const banner = document.getElementById('celebBanner');
      if (banner) banner.classList.toggle('visible', !!celebrationMode);
      await waitMs(BOARD_SETTLE_MS);
      return;
    }
    default:
      return;
  }
}

function startTrainingTour() {
  if (!trainingConfig || !trainingConfig.steps) return;

  // Guard: TourGuide.js loaded? CDN could fail silently.
  if (typeof tourguide === 'undefined' || !tourguide.TourGuideClient) {
    console.error('TourGuide not loaded — skipping training tour');
    completeOnboarding();
    return;
  }

  // Guard: if a tour is already running (e.g. this function was scheduled
  // twice by re-entrant callers), tear it down before starting a new one.
  // Otherwise we end up with two overlays and duplicate "Do it →" buttons.
  if (tourGuide) {
    try { tourGuide.exit(); } catch (e) {}
    tourGuide = null;
  }
  // Belt-and-braces: sweep any stray TourGuide DOM left behind by a prior
  // instance whose exit() didn't fully clean up.
  document.querySelectorAll('.tg-dialog, .tg-backdrop')
    .forEach(el => el.remove());

  // Force sidebar open so the trainee can see nav buttons the tour
  // will highlight (Menu, Stock Count, Handover, Café toggle, etc.).
  document.getElementById('posSidebar')?.classList.add('open');

  // Stop the 7s order poll for the duration of the tour.
  //
  // renderMain() starts polling, and each poll runs renderBoard(), which
  // rewrites `#orderBoard.innerHTML` and destroys the card the tour is
  // highlighting — including its `.tg-active-element` class. A trainee who
  // spent more than ~7s reading a step watched the highlight vanish while the
  // dialog kept pointing at a node that was no longer in the document.
  //
  // Training runs entirely on mock data, so the poll has nothing real to
  // fetch. completeOnboarding() calls fetchOrders() and restarts it.
  if (typeof stopPolling === 'function') stopPolling();

  // v2 always starts from the beginning. Resumability was dropped
  // because per-step actions mutate state; resuming mid-way would
  // leave orders in inconsistent states.
  const steps = trainingConfig.steps;

  // Wait for the first step's target to exist in the DOM. renderMain →
  // fetchOrders is async, so cards may not be there yet when this fires.
  // We look for the first step that HAS a target, since step 0 (welcome)
  // is a centered dialog with no target.
  const firstTargetedStep = steps.find(s => s.target);
  const firstTarget = firstTargetedStep ? firstTargetedStep.target : '';
  const MAX_WAIT_MS = 5000;
  const POLL_MS = 100;
  const start = Date.now();
  const waitForTarget = () => {
    if (!firstTarget || document.querySelector(firstTarget)) return launch();
    if (Date.now() - start >= MAX_WAIT_MS) {
      console.warn('Training: first target not found after', MAX_WAIT_MS, 'ms — starting anyway with fallback');
      return launch();
    }
    setTimeout(waitForTarget, POLL_MS);
  };

  const launch = () => {
    // Build TourGuide steps from config. Empty targets must be omitted
    // entirely — passing an empty string makes TourGuide call
    // `document.querySelector('')`, which throws SyntaxError.
    //
    // Targets are kept even when they don't resolve YET: order cards are
    // rendered asynchronously, and `resolveStepTarget` below re-resolves
    // each step's selector immediately before the step is shown.
    const tgSteps = steps.map(s => {
      const step = { title: s.title, content: s.content, order: s.order };
      if (s.target) step.target = s.target;
      return step;
    });

    try {
      tourGuide = new tourguide.TourGuideClient({
        steps: tgSteps,
        dialogAnimate: true,
        dialogPlacement: 'bottom',
        targetPadding: 8,
        closeButton: false,       // Can't skip training
        exitOnClickOutside: false,
        exitOnEscape: false,
        completeOnFinish: false,
        // ONE progress indicator only. TourGuide has three, and
        // `showStepDots` / `showStepProgress` both default to true — enabling
        // the bar as well rendered a bar under the title, a row of dots AND an
        // "n/22" counter. The bar reads best on the POS tablet.
        progressBar: '#3A2A1F',
        showStepDots: false,
        showStepProgress: false,
        showButtons: true,
        hidePrev: true,           // System-driven flow — no going back
        keyboardControls: false,  // Prevent arrow keys skipping actions
        nextLabel: 'Do it →',
        finishLabel: 'Complete ✓',
        rememberStep: false,
      });
    } catch (e) {
      console.error('TourGuide init failed:', e);
      completeOnboarding();
      return;
    }

    // Before advancing: execute the CURRENT step's action. Only fires
    // when moving FORWARD (newIndex > oldIndex) — hidePrev already
    // blocks the back button but be defensive.
    tourGuide.onBeforeStepChange(async (oldIndex, newIndex) => {
      if (newIndex > oldIndex) {
        const configStep = steps[oldIndex];
        if (configStep && configStep.action && configStep.action !== 'none') {
          try { await executeTrainingAction(configStep.action); }
          catch (e) { console.error('Training action failed:', configStep.action, e); }
        }
      }
      // The action above almost always re-rendered the order board, which
      // replaces `#orderBoard.innerHTML` and therefore DESTROYS the card
      // nodes. TourGuide resolves `target` to an element once and caches it,
      // so without this the upcoming step would highlight a detached node:
      // no highlight, and the dialog parked in the top-left corner. Restore
      // the selector STRING so TourGuide re-resolves against the live DOM.
      await resolveStepTarget(newIndex);
      // Drop any width override a modal step applied, so the next step's dialog
      // is measured at its natural size rather than the narrowed one.
      const dlgEl = document.querySelector('.tg-dialog');
      if (dlgEl) {
        dlgEl.style.removeProperty('width');
        dlgEl.style.removeProperty('max-width');
        dlgEl.style.removeProperty('max-height');
        dlgEl.style.removeProperty('overflow-y');
      }
      // Sync the sidebar-dim state to the UPCOMING step's target.
      // See CSS `.training-active .pos-sidebar::after` — this class
      // controls whether the sidebar is dimmed or lit.
      updateSidebarTargetState(steps[newIndex]);
      return true;
    });

    // After advancing: save the step just finished as complete. This
    // is best-effort; if the network is down the finish handler will
    // still flip onboardingComplete via the sentinel step.
    tourGuide.onAfterStepChange((oldIndex, newIndex) => {
      if (newIndex > oldIndex) {
        const configStep = steps[oldIndex];
        if (configStep) markTrainingStepComplete(configStep.id);
      }
      // TourGuide positions the dialog relative to the target without checking
      // that it still fits the screen. On an iPad the "Order Board" step put it
      // at x=-128, clipping the first ~130px of every line — a cashier read
      // "…oard" and a third of the sentence was simply gone. iPad Pro pushed it
      // off the BOTTOM instead. Clamp it back inside after each move.
      clampTourDialog();
    });

    tourGuide.onFinish(async () => {
      // Save the last step's completion, then flip onboardingComplete.
      const lastStep = steps[steps.length - 1];
      if (lastStep) await markTrainingStepComplete(lastStep.id);
      completeOnboarding();
    });

    // Step 0 is shown by start() itself, before onBeforeStepChange can fire,
    // so resolve its target up front.
    resolveStepTarget(0);

    try { tourGuide.start(); }
    catch (e) { console.error('TourGuide start failed:', e); completeOnboarding(); }
    // Mark the tour as active (CSS uses this to dim the sidebar during
    // non-sidebar steps) and sync the target-in-sidebar flag for step 0.
    document.body.classList.add('training-active');
    updateSidebarTargetState(steps[0]);
    // Clamp step 0 and keep watching: TourGuide repositions on scroll, resize
    // and orientation change, any of which can push the dialog back off screen.
    clampTourDialog();
    watchTourDialogPosition();
    // Debug/test hook: expose the instance so tests can inspect state
    // (activeStep, _promiseWaiting). Safe to keep in prod — it's just
    // a reference to the same instance the module already holds.
    window.__tourGuide = tourGuide;
  };

  waitForTarget();
}

// Toggles `body.training-target-sidebar` based on whether the given
// step's target resolves to an element inside `.pos-sidebar`. Used by
// CSS to hide the sidebar dim overlay for sidebar-targeted steps.
function updateSidebarTargetState(configStep) {
  let inSidebar = false;
  if (configStep && configStep.target) {
    try {
      const el = document.querySelector(configStep.target);
      inSidebar = !!(el && el.closest('.pos-sidebar'));
    } catch (e) { /* invalid selector — treat as non-sidebar */ }
  }
  document.body.classList.toggle('training-target-sidebar', inSidebar);
}

async function markTrainingStepComplete(stepId) {
  if (onboardingProgress.includes(stepId)) return;
  onboardingProgress.push(stepId);
  try {
    await window._origApi('PUT', '/api/pos/onboarding-progress', { step: stepId });
  } catch (e) { console.error('Failed to save onboarding progress:', e); }
}

function completeOnboarding() {
  trainingMode = false;
  // Restore real API
  if (window._origApi) api = window._origApi;
  // Stop watching the dialog before tearing it down, so the observer and the
  // window listeners don't outlive the tour.
  unwatchTourDialogPosition();
  // Remove tour overlay
  if (tourGuide) { try { tourGuide.exit(); } catch (e) {} }
  // exit() leaves `tg-active-element` on whichever element was highlighted last,
  // which keeps a stray raised/outlined style on a real POS control after the
  // tour is over. Harmless but visible, so clear it.
  document.querySelectorAll('.tg-active-element')
    .forEach(el => el.classList.remove('tg-active-element'));
  // Clear tour-lifecycle body classes so the sidebar dim overlay is
  // removed on cancel/complete.
  document.body.classList.remove('training-active', 'training-target-sidebar');
  // Show completion message
  if (typeof showSuccessToast === 'function') {
    showSuccessToast('🎉 Training complete! Welcome to RLC Café POS');
  }
  // Reload with real data and resume the live queue poll that
  // startTrainingTour() stopped for the duration of the tour.
  if (typeof fetchCafeStatus === 'function') fetchCafeStatus();
  if (typeof fetchOrders === 'function') fetchOrders();
  if (typeof startPolling === 'function') startPolling();
}

// Called from pos.js after login if onboardingComplete is false
// After renderMain finishes (with mock data), call startTrainingTour()
// to kick off the guided overlay.
