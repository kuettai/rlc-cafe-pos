// ─── POS Training Mode ──────────────────────────────────────────────
// Uses TourGuide.js for step overlay. Steps defined in training-config.json.
// Mock API intercept prevents real backend calls during training.

let trainingMode = false;
let onboardingProgress = [];
let trainingConfig = null;
let tourGuide = null;

// Mock order state for training
let mockOrders = [
  { orderId:'training-001', customerName:'Sarah', status:'PENDING', items:[{name:'Latte',quantity:1,category:'DRINK',menuItemId:'mock-1'}], createdAt:new Date().toISOString(), totalAmount:8 },
  { orderId:'training-002', customerName:'Daniel', status:'PENDING', items:[{name:'Long Black',quantity:1,category:'DRINK',menuItemId:'mock-2'},{name:'Mocha',quantity:1,category:'DRINK',menuItemId:'mock-3'}], createdAt:new Date().toISOString(), totalAmount:16 },
];

const mockMenu = [
  { menuItemId:'mock-1', name:'Latte', category:'DRINK', basePrice:8, isActive:true, isEnabledToday:true, sortOrder:1 },
  { menuItemId:'mock-2', name:'Long Black', category:'DRINK', basePrice:7, isActive:true, isEnabledToday:true, sortOrder:2 },
  { menuItemId:'mock-3', name:'Mocha', category:'DRINK', basePrice:9, isActive:true, isEnabledToday:true, sortOrder:3 },
  { menuItemId:'mock-4', name:'Nasi Lemak', category:'FOOD', basePrice:5, isActive:true, isEnabledToday:true, foodQuantityToday:10, foodReserved:0, sortOrder:4 },
];

const mockIngredients = [
  { ingredientId:'mock-ing-1', name:'Coffee Beans', unit:'g', currentStock:500, lowStockThreshold:100, storageLocation:'storeroom', isActive:true },
  { ingredientId:'mock-ing-2', name:'Milk', unit:'ml', currentStock:2000, lowStockThreshold:500, storageLocation:'fridge', isActive:true },
];

// Save reference to real API function
const _realApi = typeof api === 'function' ? api : null;

function mockTrainingApi(method, path, body) {
  // Cafe status — always OPEN in training
  if (path.includes('/api/cafe/status')) {
    return Promise.resolve({ cafeStatus:'OPEN', queueSize:mockOrders.filter(o=>o.status==='PENDING').length, celebrationMode:false, featuredDrink:null });
  }
  // Orders
  if (method === 'GET' && path.includes('/api/pos/orders')) {
    return Promise.resolve({ orders: mockOrders });
  }
  // Shift summary
  if (path.includes('/api/pos/shift-summary')) {
    return Promise.resolve({ completed:0, revenue:0, pending:mockOrders.filter(o=>o.status==='PENDING').length, preparing:mockOrders.filter(o=>o.status==='PREPARING').length });
  }
  // Approve
  if (method === 'PUT' && path.includes('/approve')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const order = mockOrders.find(o => o.orderId === id);
    if (order) { order.status = 'PREPARING'; order.approvedAt = new Date().toISOString(); }
    return Promise.resolve({ orderId: id, status:'PREPARING' });
  }
  // Mark ready
  if (method === 'PUT' && path.includes('/ready')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const order = mockOrders.find(o => o.orderId === id);
    if (order) { order.status = 'READY'; order.readyAt = new Date().toISOString(); }
    return Promise.resolve({ orderId: id, status:'READY' });
  }
  // Archive/collect
  if (method === 'PUT' && path.includes('/archive')) {
    const id = path.match(/orders\/([^/]+)/)?.[1];
    const order = mockOrders.find(o => o.orderId === id);
    if (order) order.status = 'ARCHIVED';
    return Promise.resolve({ orderId: id, status:'ARCHIVED' });
  }
  // Walk-up order creation
  if (method === 'POST' && path.includes('/api/pos/orders')) {
    const newOrder = { orderId:'training-walkup-'+ Date.now(), customerName: body?.customerName||'Walk-up', status:'PREPARING', items: body?.items||[], createdAt:new Date().toISOString(), totalAmount: body?.totalAmount||0 };
    mockOrders.push(newOrder);
    return Promise.resolve({ orderId: newOrder.orderId, status:'PREPARING', totalAmount: newOrder.totalAmount });
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
  // Cafe open/close toggle
  if (path.includes('/api/pos/cafe/close') || path.includes('/api/pos/cafe/open')) {
    return Promise.resolve({ cafeStatus: 'CLOSED' });
  }
  // Checklist
  if (path.includes('/api/admin/checklist')) {
    return Promise.resolve({ config: { open:[], close:[], handover:[] } });
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

  // Override global api function
  window._origApi = api;
  api = function(method, path, body) {
    if (trainingMode && !path.includes('/api/pos/onboarding-progress')) {
      return mockTrainingApi(method, path, body);
    }
    return window._origApi(method, path, body);
  };

  // Load training config
  try {
    const res = await fetch('js/training-config.json');
    trainingConfig = await res.json();
  } catch(e) {
    console.error('Failed to load training config:', e);
    return;
  }

  // Let the POS render with mock data first
  // (renderMain will be called by init, which will use mock api)
}

function startTrainingTour() {
  if (!trainingConfig || !trainingConfig.steps) return;

  // Guard: TourGuide.js loaded? CDN could fail silently. Bail cleanly
  // instead of blowing up on `new tourguide.TourGuideClient(...)`.
  if (typeof tourguide === 'undefined' || !tourguide.TourGuideClient) {
    console.error('TourGuide not loaded — skipping training tour');
    completeOnboarding();
    return;
  }

  // Find the first incomplete step
  const remainingSteps = trainingConfig.steps.filter(s => !onboardingProgress.includes(s.id));
  if (!remainingSteps.length) {
    completeOnboarding();
    return;
  }

  // Wait for the first step's target to exist in the DOM. renderMain →
  // fetchOrders is async, so cards may not be there yet when this fires.
  // Steps whose targets never resolve (e.g. mock order card missing) get
  // their `target` dropped so TourGuide falls back to a centered dialog
  // instead of crashing on `.remove()` of undefined.
  const firstTarget = remainingSteps[0].target;
  const MAX_WAIT_MS = 5000;
  const POLL_MS = 100;
  const start = Date.now();
  const waitForTarget = () => {
    if (firstTarget && document.querySelector(firstTarget)) return launch();
    if (Date.now() - start >= MAX_WAIT_MS) {
      console.warn('Training: first target not found after', MAX_WAIT_MS, 'ms — starting anyway with fallback');
      return launch();
    }
    setTimeout(waitForTarget, POLL_MS);
  };

  const launch = () => {
    // Build TourGuide steps from config; drop targets that don't exist
    // (TourGuide handles missing/empty target by centering the dialog).
    const tgSteps = remainingSteps.map(s => ({
      title: s.title,
      content: s.content,
      target: (s.target && document.querySelector(s.target)) ? s.target : '',
      order: s.order,
    }));

    // Initialize TourGuide
    try {
      tourGuide = new tourguide.TourGuideClient({
        steps: tgSteps,
        dialogAnimate: true,
        dialogPlacement: 'bottom',
        targetPadding: 8,
        closeButton: false,    // Can't skip training
        exitOnClickOutside: false,
        completeOnFinish: false,
        progressBar: true,
        showStepDots: true,
        showButtons: true,
        nextLabel: 'Do it →',
        prevLabel: '← Back',
        finishLabel: 'Complete ✓',
      });
    } catch(e) {
      console.error('TourGuide init failed:', e);
      completeOnboarding();
      return;
    }

    // On step change — detect completion
    tourGuide.onAfterStepChange((step) => {
      const configStep = remainingSteps[step.currentStep - 1];
      if (configStep && !onboardingProgress.includes(configStep.id)) {
        markTrainingStepComplete(configStep.id);
      }
    });

    tourGuide.onFinish(() => {
      // Mark the last step complete
      const lastStep = remainingSteps[remainingSteps.length - 1];
      if (lastStep && !onboardingProgress.includes(lastStep.id)) {
        markTrainingStepComplete(lastStep.id);
      }
      completeOnboarding();
    });

    try { tourGuide.start(); }
    catch(e) { console.error('TourGuide start failed:', e); completeOnboarding(); }
  };

  waitForTarget();
}

async function markTrainingStepComplete(stepId) {
  if (onboardingProgress.includes(stepId)) return;
  onboardingProgress.push(stepId);
  // Save to backend (real API)
  try {
    await window._origApi('PUT', '/api/pos/onboarding-progress', { step: stepId });
  } catch(e) { console.error('Failed to save onboarding progress:', e); }
}

function completeOnboarding() {
  trainingMode = false;
  // Restore real API
  if (window._origApi) api = window._origApi;
  // Remove tour overlay
  if (tourGuide) { try { tourGuide.exit(); } catch(e){} }
  // Show completion message
  showSuccessToast('🎉 Training complete! Welcome to RLC Café POS');
  // Reload with real data
  fetchCafeStatus();
  fetchOrders();
}

// Called from pos.js after login if onboardingComplete is false
// After renderMain finishes (with mock data), call startTrainingTour()
// to kick off the guided overlay.
