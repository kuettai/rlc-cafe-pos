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
  // Mark ready
  if (method === 'PUT' && path.includes('/ready')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const order = mockOrders.find(o => o.orderId === id);
    if (order) { order.status = 'READY'; order.readyAt = new Date().toISOString(); }
    return Promise.resolve({ orderId: id, status: 'READY' });
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

function refreshTrainingBoard() {
  // Alias orders → mockOrders so renderBoard reads the current mock state.
  if (typeof orders !== 'undefined') {
    // Keep the same reference wherever possible so pending diff logic in
    // fetchOrders doesn't fire spurious "cancelled" toasts on next poll.
    orders = mockOrders;
  }
  if (typeof renderBoard === 'function') renderBoard();
}

async function executeTrainingAction(actionId) {
  switch (actionId) {
    case 'none':
      return;
    case 'click-approve-training-001': {
      const order = mockOrders.find(o => o.orderId === 'training-001');
      if (order) { order.status = 'PREPARING'; order.approvedAt = new Date().toISOString(); }
      refreshTrainingBoard();
      await waitMs(500);
      return;
    }
    case 'click-undo-training-001': {
      const order = mockOrders.find(o => o.orderId === 'training-001');
      if (order) { order.status = 'PENDING'; delete order.approvedAt; }
      refreshTrainingBoard();
      await waitMs(500);
      return;
    }
    case 'click-ready-training-001': {
      const order = mockOrders.find(o => o.orderId === 'training-001');
      if (order) { order.status = 'READY'; order.readyAt = new Date().toISOString(); }
      refreshTrainingBoard();
      await waitMs(500);
      return;
    }
    case 'click-archive-training-001': {
      const idx = mockOrders.findIndex(o => o.orderId === 'training-001');
      if (idx >= 0) mockOrders.splice(idx, 1);
      refreshTrainingBoard();
      await waitMs(500);
      return;
    }
    case 'click-cancel-training-002': {
      const idx = mockOrders.findIndex(o => o.orderId === 'training-002');
      if (idx >= 0) mockOrders.splice(idx, 1);
      refreshTrainingBoard();
      await waitMs(500);
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
      await waitMs(500);
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
      await waitMs(300);
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
    // Build TourGuide steps from config; drop targets that don't exist
    // so TourGuide centers the dialog instead of erroring. Empty targets
    // must be omitted entirely — passing an empty string makes TourGuide
    // call `document.querySelector('')` which throws SyntaxError.
    const tgSteps = steps.map(s => {
      const step = { title: s.title, content: s.content, order: s.order };
      if (s.target && document.querySelector(s.target)) step.target = s.target;
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
        progressBar: '#6B4226',
        showStepDots: true,
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
    });

    tourGuide.onFinish(async () => {
      // Save the last step's completion, then flip onboardingComplete.
      const lastStep = steps[steps.length - 1];
      if (lastStep) await markTrainingStepComplete(lastStep.id);
      completeOnboarding();
    });

    try { tourGuide.start(); }
    catch (e) { console.error('TourGuide start failed:', e); completeOnboarding(); }
    // Mark the tour as active (CSS uses this to dim the sidebar during
    // non-sidebar steps) and sync the target-in-sidebar flag for step 0.
    document.body.classList.add('training-active');
    updateSidebarTargetState(steps[0]);
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
  // Remove tour overlay
  if (tourGuide) { try { tourGuide.exit(); } catch (e) {} }
  // Clear tour-lifecycle body classes so the sidebar dim overlay is
  // removed on cancel/complete.
  document.body.classList.remove('training-active', 'training-target-sidebar');
  // Show completion message
  if (typeof showSuccessToast === 'function') {
    showSuccessToast('🎉 Training complete! Welcome to RLC Café POS');
  }
  // Reload with real data
  if (typeof fetchCafeStatus === 'function') fetchCafeStatus();
  if (typeof fetchOrders === 'function') fetchOrders();
}

// Called from pos.js after login if onboardingComplete is false
// After renderMain finishes (with mock data), call startTrainingTour()
// to kick off the guided overlay.
