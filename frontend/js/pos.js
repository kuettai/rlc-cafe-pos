// pos.js — Shell: sidebar, polling, board render, stats
// Part of rlc-cafe-pos v1.52.0 file split
// Depends on: config.js (API_BASE), phone.js, variants.js
// Required by: pos-walkup.js, pos-voucher.js, pos-stock.js,
//              pos-checklist.js, pos-history.js

const $ = s => document.querySelector(s);
const app = $('#app');
let token = sessionStorage.getItem('pos_token');
let currentUser = sessionStorage.getItem('pos_user') || '';
let orders = [];
let prevOrderCount = 0;
// Latest response from /api/pos/shift-summary; refreshed alongside every
// queue poll. Used by renderStats() for completed / revenue numbers.
let shiftSummary = null;
let pollTimer = null;
let viewMode = 'kanban';
let cafeOpen = false;
let celebrationMode = false;
let featuredDrink = null;  // { menuItemId, name, basePrice, imageUrl } or null
let searchFilter = '';
let prevUrgentIds = [];

// --- Auth helpers ---
function authHeaders(){ return { 'Content-Type':'application/json', Authorization:`Bearer ${token}` }; }

async function api(method, path, body){
  const opts = { method, headers: authHeaders() };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if(res.status === 401){ logout(); throw new Error('Unauthorized'); }
  if(!res.ok) throw new Error(await res.text());
  return res.json();
}

function showError(msg){ const b=$('#errorBanner'); b.textContent=msg; b.classList.add('show'); setTimeout(()=>b.classList.remove('show'),3000); }

// --- Login ---
function renderLogin(){
  stopPolling();
  const lastUser = localStorage.getItem('pos_last_user') || '';
  app.innerHTML = `<div class="pos-login">
    <h2>Cashier Login</h2>
    <form id="loginForm">
      <input id="loginUser" placeholder="Your name (e.g. Sarah)" required autocomplete="username" class="pos-input" value="${lastUser}">
      <input id="loginPin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN (6 digits)" required class="pos-input">
      <button type="submit" class="pos-btn pos-btn-primary" style="width:100%">Login</button>
    </form>
    <p style="margin-top:16px;font-size:.8rem;color:var(--text-light,#7A6355)">Shortcuts: W = Walk-up, M = Menu, H = History, / = Search</p>
  </div>`;
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    try{
      const res = await fetch(`${API_BASE}/api/auth/login`,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:$('#loginUser').value, pin:$('#loginPin').value}) });
      if(!res.ok) throw new Error();
      const data = await res.json();
      token = data.token;
      currentUser = data.name || $('#loginUser').value;
      sessionStorage.setItem('pos_token', token);
      sessionStorage.setItem('pos_user', currentUser);
      localStorage.setItem('pos_last_user', $('#loginUser').value);
      if(data.forceUpdatePin){ showPinChangeModal(); return; }
      renderMain();
    } catch(e){ showError('Invalid PIN'); }
  };
}

function logout(){ token=null; currentUser=''; sessionStorage.removeItem('pos_token'); sessionStorage.removeItem('pos_user'); renderLogin(); }

function showPinChangeModal(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:400px">
    <h3>🔒 Change Your PIN</h3>
    <p style="margin:12px 0;font-size:.9rem;color:var(--text-light)">You must set a new PIN before continuing.</p>
    <input id="newPin1" type="password" inputmode="numeric" maxlength="6" placeholder="New PIN (min 6 digits)" class="pos-input" style="margin-bottom:10px">
    <input id="newPin2" type="password" inputmode="numeric" maxlength="6" placeholder="Confirm PIN" class="pos-input" style="margin-bottom:16px">
    <button id="pinChangeSubmit" class="pos-btn pos-btn-primary" style="width:100%">Update PIN</button>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#pinChangeSubmit').onclick = async()=>{
    const p1 = modal.querySelector('#newPin1').value, p2 = modal.querySelector('#newPin2').value;
    if(!p1 || p1.length < 6){ showError('PIN must be at least 6 digits'); return; }
    if(p1 !== p2){ showError('PINs do not match'); return; }
    try{
      const res = await fetch(`${API_BASE}/api/auth/update-pin`,{ method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body:JSON.stringify({newPin:p1}) });
      if(!res.ok){ const err = await res.json().catch(()=>({})); throw new Error(err.error||'Failed'); }
      modal.remove();
      renderMain();
    } catch(e){ showError(e.message||'Failed to update PIN'); }
  };
}

// --- Main view ---
function renderMain(){
  app.innerHTML = `<aside class="pos-sidebar" id="posSidebar">
  <div class="pos-sidebar-user">👤 ${currentUser} <span class="pos-status-dot ${cafeOpen?'open':'closed'}"></span></div>
  <div class="pos-sidebar-section-label">Quick Actions</div>
  <div class="pos-sidebar-actions">
    <button id="btnWalkup" class="pos-action-btn pos-action-primary">➕ Walk-up</button>
    <button id="btnVoucher" class="pos-action-btn pos-action-primary">🎟️ Voucher</button>
    <button id="btnCelebration" class="pos-action-btn pos-action-toggle ${celebrationMode?'active':''}" aria-pressed="${celebrationMode?'true':'false'}">${celebrationMode?'🎉 Celebration: ON':'🎉 Celebration: OFF'}</button>
    <button id="btnCafeToggle" class="pos-action-btn ${cafeOpen?'pos-action-cafe-open':'pos-action-cafe-closed'}">${cafeOpen?'☕ Café Open ✓':'☕ Open Café'}</button>
    <button id="btnHandover" class="pos-action-btn" style="${cafeOpen ? '' : 'display:none'}">🔄 Handover</button>
  </div>
  <div class="pos-sidebar-section-label">Navigation</div>
  <nav class="pos-sidebar-nav">
    <button id="btnPrep" class="pos-sidebar-btn">☕ Prep Queue</button>
    <button id="btnMenu" class="pos-sidebar-btn">📋 Menu</button>
    <button id="btnChecklist" class="pos-sidebar-btn">☑️ Checklist</button>
    <button id="btnStockCount" class="pos-sidebar-btn">📦 Stock Count</button>
    <button id="btnPlanogram" class="pos-sidebar-btn">📷 AI Scan</button>
    <button id="btnHistory" class="pos-sidebar-btn">📜 History</button>
    <button id="btnStats" class="pos-sidebar-btn">📊 Stats</button>
  </nav>
  <div class="pos-sidebar-footer">
  </div>
</aside>
<div class="pos-sidebar-overlay" id="posSidebarOverlay"></div>
<main class="pos-main">
  <div id="closedBanner" class="pos-closed-banner${cafeOpen?'':' visible'}" role="alert" aria-live="assertive">⚠️ CAFÉ IS CLOSED — Customers cannot order. Tap Open to start service.</div>
  <div id="celebBanner" class="pos-celeb-banner${celebrationMode?' visible':''}" role="status" aria-live="polite">🎉 CELEBRATION MODE — All eligible drinks discounted</div>
  <div id="posStats" class="pos-stats-bar"></div>
  <div class="pos-controls">
    <input id="orderSearch" class="pos-input pos-search" placeholder="Search customer...">
    <button id="btnFeatured" class="pos-btn pos-btn-sm pos-btn-outline pos-btn-featured${featuredDrink?' pos-btn-featured-active':''}">⭐ ${featuredDrink?featuredDrink.name:'Set Featured'}</button>
    <button id="btnView" class="pos-btn pos-btn-sm pos-btn-outline">${viewMode==='kanban'?'📋 List':'📊 Kanban'}</button>
    <span id="lastRefresh" class="pos-last-refresh"></span>
  </div>
  <div id="orderBoard" class="pos-board"></div>
</main>`;
  document.getElementById('posHeaderToggle').onclick = () => {
    $('#posSidebar').classList.toggle('open');
  };
  $('#posSidebarOverlay').onclick = () => {
    $('#posSidebar').classList.remove('open');
  };
  $('#btnCafeToggle').onclick = toggleCafe;
  $('#btnCelebration').onclick = async()=>{
    try{
      celebrationMode=!celebrationMode;
      await api('PUT','/api/pos/cafe/celebration',{enabled:celebrationMode});
      renderMain();
    } catch(e){ celebrationMode=!celebrationMode; showError('Failed to toggle celebration'); }
  };
  $('#btnWalkup').onclick = openWalkup;
  $('#btnVoucher').onclick = openVoucherFlow;
  $('#btnMenu').onclick = openMenuToggle;
  $('#btnPrep').onclick = openPrepView;
  $('#btnChecklist').onclick = ()=>{
    const phase = cafeOpen ? 'close' : 'open';
    openChecklist(phase);
  };
  const btnHandover = document.getElementById('btnHandover');
  if(btnHandover) btnHandover.onclick = ()=> openChecklist('handover');
  $('#btnPlanogram').onclick = ()=>{
    const modal=document.createElement('div');
    modal.className='pos-modal-overlay';
    modal.innerHTML=`<div class="pos-modal" style="max-width:340px;text-align:center">
      <button class="pos-modal-close">✕</button>
      <h3>📷 AI Stock Scan</h3>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:8px 0 20px">Which area?</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="pos-btn pos-btn-primary pos-btn-lg" id="scFridge">🧊 Fridge</button>
        <button class="pos-btn pos-btn-primary pos-btn-lg" id="scStore">📦 Storeroom</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
    modal.querySelector('#scFridge').onclick=()=>{ modal.remove(); openStockCount('fridge'); };
    modal.querySelector('#scStore').onclick=()=>{ modal.remove(); openStockCount('storeroom'); };
  };
  $('#btnStockCount').onclick = ()=> openManualStockCount();
  document.getElementById('headerLogout').onclick = logout;
  $('#btnHistory').onclick = openHistory;
  $('#btnStats').onclick = ()=>{ $('#posStats').classList.toggle('visible'); };
  document.getElementById('headerTutorial').onclick = async ()=>{
    if(!confirm('Start the training tutorial?')) return;
    try{
      await initTrainingMode([]);
      // renderMain() itself schedules startTrainingTour when trainingMode
      // is true (see the tail of this function), so we must NOT schedule
      // it again here — doing so spawns a second TourGuide instance and
      // produces duplicate "Do it →" buttons.
      renderMain();
    } catch(e){ showError('Failed to start tutorial'); }
  };
  $('#btnView').onclick = ()=>{ viewMode = viewMode==='kanban'?'list':'kanban'; renderBoard(); $('#btnView').textContent = viewMode==='kanban'?'📋 List':'📊 Kanban'; };
  $('#orderSearch').oninput = e=>{ searchFilter=e.target.value.toLowerCase(); renderBoard(); };
  $('#btnFeatured').onclick = openFeaturedDrinkModal;
  fetchCafeStatus();
  fetchOrders();
  startPolling();
  if(typeof trainingMode !== 'undefined' && trainingMode && typeof startTrainingTour === 'function'){
    // Give the board a moment to render with mock data, then start tour
    setTimeout(startTrainingTour, 1000);
  }
}

async function fetchCafeStatus(){
  try{
    const s = await api('GET','/api/cafe/status');
    cafeOpen = s.cafeStatus === 'OPEN';
    celebrationMode = s.celebrationMode || false;
    const toggle = $('#btnCafeToggle');
    const celeb = $('#btnCelebration');
    if(toggle){
      toggle.textContent = cafeOpen ? '☕ Café Open ✓' : '☕ Open Café';
      toggle.classList.toggle('pos-action-cafe-open', cafeOpen);
      toggle.classList.toggle('pos-action-cafe-closed', !cafeOpen);
      // Clean up any legacy variant class that a previous render may have left
      toggle.classList.remove('pos-action-danger');
    }
    if(celeb){
      celeb.classList.toggle('active', celebrationMode);
      celeb.textContent = celebrationMode ? '🎉 Celebration: ON' : '🎉 Celebration: OFF';
      celeb.setAttribute('aria-pressed', celebrationMode ? 'true' : 'false');
    }
    const banner = $('#celebBanner');
    if(banner) banner.classList.toggle('visible', celebrationMode);
    const closedBanner = $('#closedBanner');
    if(closedBanner) closedBanner.classList.toggle('visible', !cafeOpen);
    const headerBadge = document.getElementById('headerCafeBadge');
    if(headerBadge){
      if(cafeOpen){
        headerBadge.textContent = '● OPEN';
        headerBadge.classList.add('is-open');
      } else {
        headerBadge.textContent = '';
        headerBadge.classList.remove('is-open');
      }
    }
    // Handover button visibility
    const handoverBtn = document.getElementById('btnHandover');
    if(handoverBtn) handoverBtn.style.display = cafeOpen ? '' : 'none';
    // Featured drink
    featuredDrink = s.featuredDrink || null;
    const featBtn = $('#btnFeatured');
    if(featBtn){
      featBtn.textContent = featuredDrink ? `⭐ ${featuredDrink.name}` : '⭐ Set Featured';
      featBtn.classList.toggle('pos-btn-featured-active', !!featuredDrink);
    }
  } catch(e){}
}

function startPolling(){ stopPolling(); pollTimer = setInterval(fetchOrders, 7000); }
function stopPolling(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }

let prevReceiptCount = 0;
// Snapshot of the previous fetch keyed by orderId → { updatedAt, status }.
// Used to detect mutations (updatedAt change) and customer cancellations
// (visible PENDING order disappearing) between consecutive 7s polls.
let prevOrdersById = {};

async function fetchOrders(){
  try{
    // Fetch queue + shift summary in parallel — one poll cycle updates both
    // the queue view and the stats bar without doubling backend load. Shift
    // summary is used by renderStats for the completed/revenue numbers that
    // the live queue alone can't compute (ARCHIVED isn't in the queue).
    const [data, summaryData] = await Promise.all([
      api('GET','/api/pos/orders'),
      api('GET','/api/pos/shift-summary').catch(() => null),
    ]);
    if (summaryData) shiftSummary = summaryData;
    const list = Array.isArray(data) ? data : data.orders || [];
    if(list.length > prevOrderCount && prevOrderCount > 0) flashNew();
    const receiptCount = list.filter(o=>o.receiptUrl).length;
    if(receiptCount > prevReceiptCount && prevReceiptCount > 0) playReceiptSound();
    prevReceiptCount = receiptCount;
    prevOrderCount = list.length;
    const urgentIds = list.filter(o=>o.status==='PENDING'&&(Date.now()-new Date(o.createdAt))>600000).map(o=>o.orderId||o.id);
    const newUrgent = urgentIds.filter(id=>!prevUrgentIds.includes(id));
    if(newUrgent.length) playUrgentSound();
    prevUrgentIds = urgentIds;

    // Diff vs previous fetch.
    const haveSeenPrev = Object.keys(prevOrdersById).length > 0;
    const currentById = {};
    const mutatedIds = [];
    list.forEach(o => {
      const id = o.orderId || o.id;
      currentById[id] = { updatedAt: o.updatedAt, status: o.status, customerName: o.customerName };
      const prev = prevOrdersById[id];
      if(haveSeenPrev && prev && prev.updatedAt && o.updatedAt && prev.updatedAt !== o.updatedAt){
        mutatedIds.push(id);
      }
    });
    const cancelledOrders = haveSeenPrev
      ? Object.keys(prevOrdersById)
          .filter(id => !currentById[id] && prevOrdersById[id].status === 'PENDING')
          .map(id => ({ id, customerName: prevOrdersById[id].customerName }))
      : [];

    orders = list;
    renderBoard();

    // Apply flash to mutated cards after they exist in the DOM.
    if(mutatedIds.length){
      mutatedIds.forEach(id => {
        document.querySelectorAll(`.pos-card[data-id="${id}"]`).forEach(card => {
          card.classList.add('pos-card-mutated');
          setTimeout(() => card.classList.remove('pos-card-mutated'), 1500);
        });
      });
      playNotifSound();
    }

    cancelledOrders.forEach(o => {
      const shortId = String(o.id).slice(-4);
      const who = o.customerName ? `${o.customerName}'s order` : `Order #${shortId}`;
      showCancelToast(`${who} was cancelled by customer`);
    });
    if(cancelledOrders.length) playCancelSound();

    prevOrdersById = currentById;

    updateLastRefresh();
  } catch(e){ if(e.message!=='Unauthorized') showError('Failed to fetch orders'); }
}

function updateLastRefresh(){
  const el = $('#lastRefresh');
  if(el) el.textContent = 'Updated ' + new Date().toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function flashNew(){
  document.body.classList.add('pos-flash');
  setTimeout(()=>document.body.classList.remove('pos-flash'),600);
  playNotifSound();
}

function playNotifSound(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch(e){}
}

function playReceiptSound(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(523, ctx.currentTime);
    osc.frequency.setValueAtTime(659, ctx.currentTime + 0.15);
    osc.frequency.setValueAtTime(784, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch(e){}
}

function playUrgentSound(){
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type='square'; osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(440,ctx.currentTime);
    osc.frequency.setValueAtTime(880,ctx.currentTime+0.15);
    osc.frequency.setValueAtTime(440,ctx.currentTime+0.3);
    gain.gain.setValueAtTime(0.2,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01,ctx.currentTime+0.5);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.5);
  } catch(e){}
}

// Distinct two-note descending chime for customer cancellations — different
// timbre from the new-order / receipt / urgent / ready chimes so cashiers
// can tell at a glance.
function playCancelSound(){
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type='triangle'; osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.setValueAtTime(415, ctx.currentTime+0.18);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime+0.45);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.45);
  } catch(e){}
}

// Lightweight transient toast in the top-right of the POS view. Stacks if
// multiple cancellations land in the same poll. Auto-dismisses after 5s.
function showCancelToast(msg){
  let host = document.getElementById('posToastHost');
  if(!host){
    host = document.createElement('div');
    host.id = 'posToastHost';
    host.style.cssText = 'position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:500;pointer-events:none';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'pos-toast pos-toast-cancel';
  t.textContent = '❌ ' + msg;
  host.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(), 300); }, 5000);
}

// True when an order has been modified within the last `windowMs` ms — used
// by the approve-guard to ask the cashier to re-verify items first.
function recentlyModified(o, windowMs){
  if(!o || !o.modifiedAt) return false;
  const ms = typeof windowMs === 'number' ? windowMs : 5000;
  return (Date.now() - new Date(o.modifiedAt)) < ms;
}

function approveGuardOk(orderId){
  const o = orders.find(x => (x.orderId||x.id) === orderId);
  if(!recentlyModified(o)) return true;
  return confirm('This order was modified moments ago — verify items before approving.');
}

function playReadySound(){
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator();const gain=ctx.createGain();
    osc.connect(gain);gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(660,ctx.currentTime);
    osc.frequency.setValueAtTime(880,ctx.currentTime+0.15);
    osc.frequency.setValueAtTime(1047,ctx.currentTime+0.3);
    gain.gain.setValueAtTime(0.3,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01,ctx.currentTime+0.6);
    osc.start(ctx.currentTime);osc.stop(ctx.currentTime+0.6);
  }catch(e){}
}

function showNameFlash(name){
  const el=document.createElement('div');
  el.style.cssText='position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(45,138,78,.9);color:#fff;font-size:2.5rem;font-weight:800;z-index:999;animation:fadeIn .2s ease';
  el.textContent='🎉 '+name+' — READY!';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),2000);
}

function filtered(){ return searchFilter ? orders.filter(o=>(o.customerName||'').toLowerCase().includes(searchFilter)) : orders; }

function renderStats(){
  const pending = orders.filter(o=>o.status==='PENDING').length;
  const preparing = orders.filter(o=>o.status==='PREPARING').length;
  const ready = orders.filter(o=>o.status==='READY').length;
  const total = orders.length;
  // "Completed" and "Revenue" come from /api/pos/shift-summary — the live
  // queue only carries PENDING/PREPARING/READY, so the queue-derived sum
  // can never see ARCHIVED sales. Falls back to queue-derived numbers if
  // the shift-summary fetch failed.
  const completed = shiftSummary?.completedOrders ?? 0;
  const revenue = shiftSummary?.totalRevenue ??
    orders.reduce((s,o)=>s+(o.total||o.totalAmount||0),0);
  const drinkItems = orders.filter(o=>o.status==='PREPARING'||o.status==='PENDING').reduce((s,o)=>s+(o.items||[]).filter(i=>i.category==='DRINK').reduce((ss,i)=>ss+(i.quantity||i.qty||1),0),0);
  const statsEl = $('#posStats');
  if(statsEl) statsEl.innerHTML = `<div class="pos-stat"><span class="pos-stat-num">${pending}</span><span class="pos-stat-lbl">Pending</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${preparing}</span><span class="pos-stat-lbl">Making</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${ready}</span><span class="pos-stat-lbl">Ready</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${completed}</span><span class="pos-stat-lbl">Completed</span></div>
    <div class="pos-stat"><span class="pos-stat-num">RM${revenue.toFixed(0)}</span><span class="pos-stat-lbl">Revenue</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${total}</span><span class="pos-stat-lbl">Queue</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${drinkItems}</span><span class="pos-stat-lbl">Drinks</span></div>
    <div class="pos-stat pos-stat-btn" id="btnIngUsed" style="cursor:pointer"><span class="pos-stat-num">📦</span><span class="pos-stat-lbl">Usage</span></div>`;
  $('#btnIngUsed')?.addEventListener('click', showIngredientUsage);
}

async function getRecipesAndIngredients(){
  const today = new Date().toISOString().slice(0,10);
  const cached = JSON.parse(localStorage.getItem('recipeCache') || '{}');
  if(cached.date === today && cached.recipes && cached.ingredients){
    return { recipes: cached.recipes, ingredients: cached.ingredients };
  }
  const invRes = await api('GET','/api/pos/inventory');
  const allItems = invRes.ingredients || [];
  const recipes = allItems.filter(i=>i.PK?.startsWith('RECIPE#'));
  const ingredients = allItems.filter(i=>i.PK?.startsWith('INGREDIENT#') && i.SK==='META');
  localStorage.setItem('recipeCache', JSON.stringify({ date: today, recipes, ingredients }));
  return { recipes, ingredients };
}

async function showIngredientUsage(){
  let recipes = [];
  let ingredients = [];
  let allOrders = [...orders];
  try{
    const cached = await getRecipesAndIngredients();
    recipes = cached.recipes;
    ingredients = cached.ingredients;
    // Try to get all today's orders (admin only), fall back to current POS orders
    try{
      const reportRes = await api('GET','/api/admin/reports/daily');
      const reportOrders = reportRes.orders || [];
      const activeIds = new Set(orders.map(o=>o.orderId));
      reportOrders.forEach(o=>{ if(!activeIds.has(o.orderId)) allOrders.push(o); });
    } catch(e){}
  } catch(e){}

  const ingMap = {};
  ingredients.forEach(i=>{ ingMap[i.ingredientId] = i; });

  // Build recipe lookup: menuItemId#variant -> [{ingredientId, quantity}]
  const recipeMap = {};
  recipes.forEach(r=>{
    const key = r.PK; // RECIPE#menuItemId#variant
    if(!recipeMap[key]) recipeMap[key] = [];
    recipeMap[key].push({ ingredientId: r.ingredientId, quantity: r.quantity });
  });

  // Calculate ingredient usage from orders (base + variant override)
  const usage = {};
  allOrders.forEach(o=>{
    (o.items||[]).forEach(i=>{
      const qty = i.quantity||i.qty||1;
      const menuId = i.menuItemId||i.id;
      const variant = i.variant||'default';
      const baseKey = `RECIPE#${menuId}#default`;
      const variantKey = `RECIPE#${menuId}#${variant}`;
      const baseRecipe = recipeMap[baseKey] || [];
      const variantRecipe = variant !== 'default' ? (recipeMap[variantKey] || []) : [];
      // Merge: start with base, then override with variant (variant replaces same ingredient, adds new ones)
      const merged = {};
      baseRecipe.forEach(r=>{ merged[r.ingredientId] = r.quantity; });
      variantRecipe.forEach(r=>{ merged[r.ingredientId] = r.quantity; });
      Object.entries(merged).forEach(([ingId, amount])=>{
        usage[ingId] = (usage[ingId]||0) + amount * qty;
      });
    });
  });

  const sorted = Object.entries(usage).sort((a,b)=>b[1]-a[1]);
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:400px;position:relative">
    <button class="pos-modal-close">✕</button>
    <h3>📦 Ingredients Used Today</h3>
    <button class="pos-btn pos-btn-sm" id="refreshRecipeCache" style="position:absolute;top:16px;right:16px">🔄 Refresh</button>
    <div style="margin-top:14px;max-height:60vh;overflow-y:auto">
      ${sorted.length ? sorted.map(([id,qty])=>{
        const ing = ingMap[id];
        const name = ing?.name || id;
        const unit = ing?.usageUnit || ing?.unit || '';
        return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--cream-dark,#eee)"><span>${name}</span><strong>${qty} ${unit}</strong></div>`;
      }).join('') : `<p style="color:var(--text-light)">${recipes.length ? 'No active orders with recipe data' : 'No recipe data yet. Set up recipes in Admin → Ingredients.'}</p>`}
    </div>
  </div>`;
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.querySelector('#refreshRecipeCache').onclick=()=>{ localStorage.removeItem('recipeCache'); modal.remove(); showIngredientUsage(); };
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
  document.body.appendChild(modal);
}

function renderBoard(){
  const board = $('#orderBoard');
  if(!board) return;
  renderStats();
  const list = filtered();
  if(viewMode==='kanban'){
    const pending = list.filter(o=>o.status==='PENDING').sort((a,b)=>{
      if(a.receiptUrl && !b.receiptUrl) return -1;
      if(!a.receiptUrl && b.receiptUrl) return 1;
      return new Date(b.createdAt)-new Date(a.createdAt);
    });
    const preparing = list.filter(o=>o.status==='PREPARING');
    const ready = list.filter(o=>o.status==='READY');
    board.className = 'pos-board pos-kanban';
    const emptyMsg = '<div class="pos-col-empty">No orders</div>';
    board.innerHTML = `<div class="pos-col pos-col-pending"><h3>Pending (${pending.length})</h3>${pending.length ? pending.map(cardHtml).join('') : emptyMsg}</div>
      <div class="pos-col pos-col-preparing"><h3>Preparing (${preparing.length})</h3>${preparing.length ? preparing.map(cardHtml).join('') : emptyMsg}</div>
      <div class="pos-col pos-col-ready"><h3>Ready (${ready.length})</h3>${ready.length ? ready.map(cardHtml).join('') : emptyMsg}</div>`;
  } else {
    board.className = 'pos-board pos-list-view';
    board.innerHTML = `<div class="pos-tabs">
      <button class="pos-tab active" data-s="PENDING">Pending</button>
      <button class="pos-tab" data-s="PREPARING">Preparing</button>
      <button class="pos-tab" data-s="READY">Ready</button></div>
      <div id="listItems">${list.filter(o=>o.status==='PENDING').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(cardHtml).join('')}</div>`;
    board.querySelectorAll('.pos-tab').forEach(t=>t.onclick=e=>{
      board.querySelectorAll('.pos-tab').forEach(x=>x.classList.remove('active'));
      e.target.classList.add('active');
      const s=e.target.dataset.s;
      const f=filtered().filter(o=>o.status===s);
      $('#listItems').innerHTML=f.map(cardHtml).join('');
      bindCards();
    });
  }
  bindCards();
}

function timeAgo(d){ const m=Math.floor((Date.now()-new Date(d))/60000); return m<1?'just now':m<60?`${m}m ago`:`${Math.floor(m/60)}h ${m%60}m ago`; }

// Auto-archive countdown for READY cards. Threshold matches Settings.archiveAfterMinutes
// (default 15 min). The cron actually performs the archive; this is a UX hint so
// cashiers know an order will disappear soon.
const ARCHIVE_AFTER_MIN = 15;
function archiveHint(o){
  if(o.status !== 'READY') return '';
  const anchor = o.readyAt || o.updatedAt;
  if(!anchor) return '';
  const elapsedMin = (Date.now() - new Date(anchor)) / 60000;
  const remaining = Math.max(0, ARCHIVE_AFTER_MIN - elapsedMin);
  let cls = 'pos-archive-hint';
  if(remaining <= 0)     cls += ' pos-archive-hint-overdue';
  else if(remaining < 2) cls += ' pos-archive-hint-soon';
  const label = remaining <= 0
    ? 'auto-archives any moment'
    : `auto-archives in ${Math.ceil(remaining)}m`;
  return `<div class="${cls}">⏱ ${label}</div>`;
}

function discountBadgeHtml(discountType) {
  if (!discountType || discountType === 'NONE') return '';
  // Pretty label + color-variant class. Fallback to title-case for any
  // future type so a new discountType shows up as a plain grey pill
  // rather than not at all.
  const meta = {
    NEWCOMER:          { label: 'Newcomer',    variant: 'newcomer' },
    STAFF:             { label: 'Staff',       variant: 'staff' },
    PASTOR:            { label: 'Pastor',      variant: 'pastor' },
    CELEBRATION:       { label: 'Celebration', variant: 'celebration' },
    MINISTRY_PREORDER: { label: 'Pre-Order',   variant: 'preorder' },
    VOUCHER:           { label: 'Voucher',     variant: 'voucher' },
  }[discountType];
  const label = meta?.label || (discountType.charAt(0) + discountType.slice(1).toLowerCase());
  const variant = meta?.variant || 'other';
  return `<span class="discount-badge discount-badge-${variant}">${label}</span>`;
}

function cardHtml(o){
  const items = (o.items||[]).map(i=>`<div>${i.quantity||i.qty||1}x ${i.name}${i.variant?' ('+i.variant+')':''}</div>`).join('');
  const mins = Math.floor((Date.now()-new Date(o.createdAt))/60000);
  const urgent = mins > 10 && o.status === 'PENDING';
  const hasReceipt = !!o.receiptUrl;
  let quickAction = '';
  if(o.status==='PENDING') quickAction = `<div class="pos-card-actions"><button class="pos-btn pos-btn-sm pos-btn-primary pos-card-quick-approve" data-quick-id="${o.id||o.orderId}" onclick="event.stopPropagation()">✓ Approve</button></div>`;
  else if(o.status==='PREPARING') quickAction = `<div class="pos-card-actions"><button class="pos-btn pos-btn-sm pos-btn-primary pos-card-quick-ready" data-quick-id="${o.id||o.orderId}" onclick="event.stopPropagation()">✓ Ready</button></div>`;

  // Price display: when a discount is applied show the gross (strikethrough)
  // next to the net collected. Gross reconstructed as net + offset since
  // totalAmount is stored as net across the codebase.
  const gross = Number(o.totalAmount || 0) + Number(o.discountOffset || 0);
  const net   = Number(o.total || o.totalAmount || 0);
  const priceHtml = o.discountType && o.discountType !== 'NONE' && Number(o.discountOffset || 0) > 0
    ? `<s style="color:#999">RM ${gross.toFixed(2)}</s> RM ${net.toFixed(2)}`
    : `RM ${net.toFixed(2)}`;

  return `<div class="pos-card pos-card-${o.status.toLowerCase()} ${urgent?'pos-card-urgent':''} ${hasReceipt?'pos-card-receipt':''}" data-id="${o.id||o.orderId}" data-status="${o.status}">
    ${hasReceipt ? `<div class="pos-receipt-badge${Math.abs((o.receiptAmount||0)-(o.total||o.totalAmount||0))>0.01?' pos-receipt-mismatch':''}">💰 Receipt: RM${(o.receiptAmount||0).toFixed(2)}${Math.abs((o.receiptAmount||0)-(o.total||o.totalAmount||0))>0.01?' ⚠️ expected RM'+(o.total||o.totalAmount||0).toFixed(2):''}</div>` : ''}
    ${o.status==='PENDING' && o.modifiedAt ? '<div class="pos-card-modified">✏️ modified</div>' : ''}
    <div class="pos-card-name">${o.customerName||'Guest'}${o.isWalkUp?' <span class="pos-card-tag">walk-up</span>':''}</div>
    <div class="pos-card-items">${items||'—'}</div>
    ${o.notes ? '<div class="pos-card-note">📝 '+o.notes+'</div>' : ''}
    ${archiveHint(o)}
    <div class="pos-card-footer"><span>${priceHtml}</span><span>${urgent?'⚠️ ':''}${timeAgo(o.createdAt)}</span></div>
    ${o.discountType && o.discountType !== 'NONE' ? `<div class="pos-card-discount">${discountBadgeHtml(o.discountType)}</div>` : ''}
    ${quickAction}
  </div>`;
}

function bindCards(){
  document.querySelectorAll('.pos-card').forEach(c=>{
    c.onclick=()=>openDetail(c.dataset.id);
    initSwipe(c);
  });
  document.querySelectorAll('.pos-card-quick-approve').forEach(btn=>btn.onclick=async(e)=>{
    e.stopPropagation();
    if(!approveGuardOk(btn.dataset.quickId)) return;
    btn.disabled=true; btn.textContent='...';
    try{ await api('PUT',`/api/pos/orders/${btn.dataset.quickId}/approve`,{approvedBy:currentUser}); fetchOrders(); }
    catch(err){ btn.disabled=false; btn.textContent='✓ Approve'; showError('Approve failed'); }
  });
  document.querySelectorAll('.pos-card-quick-ready').forEach(btn=>btn.onclick=async(e)=>{
    e.stopPropagation();
    btn.disabled=true; btn.textContent='...';
    try{ await api('PUT',`/api/pos/orders/${btn.dataset.quickId}/ready`); fetchOrders(); }
    catch(err){ btn.disabled=false; btn.textContent='✓ Ready'; showError('Ready failed'); }
  });
}

// --- Swipe gestures ---
function initSwipe(card){
  let startX=0, currentX=0, swiping=false;
  const threshold=80;

  card.addEventListener('touchstart',e=>{
    startX=e.touches[0].clientX;
    currentX=startX;
    swiping=true;
    card.style.transition='none';
  },{passive:true});

  card.addEventListener('touchmove',e=>{
    if(!swiping) return;
    currentX=e.touches[0].clientX;
    const dx=currentX-startX;
    if(Math.abs(dx)>10){
      card.style.transform=`translateX(${dx*0.5}px)`;
      card.style.opacity=1-Math.abs(dx)/300;
    }
  },{passive:true});

  card.addEventListener('touchend',async()=>{
    if(!swiping) return;
    swiping=false;
    const dx=currentX-startX;
    card.style.transition='var(--transition)';
    card.style.transform='';
    card.style.opacity='';

    const id=card.dataset.id;
    const status=card.dataset.status;

    if(dx>threshold){
      // Swipe right: advance state
      if(status==='PENDING'){
        try{ await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser}); fetchOrders(); }catch(e){ showError('Approve failed'); }
      } else if(status==='PREPARING'){
        try{ await api('PUT',`/api/pos/orders/${id}/ready`); fetchOrders(); }catch(e){ showError('Ready failed'); }
      }
    } else if(dx<-threshold){
      // Swipe left: undo/reject
      if(status==='PENDING') openDetail(id);
      else if(status==='PREPARING'){
        try{ await api('PUT',`/api/pos/orders/${id}/undo`); fetchOrders(); }catch(e){ showError('Undo failed'); }
      }
    }
  });
}

// --- Order Detail ---
function openDetail(id){
  const o = orders.find(x=>(x.id||x.orderId)===id);
  if(!o) return;
  const items = (o.items||[]).map(i=>`<li>${i.quantity||i.qty||1}x ${i.name}${i.variant?' ('+i.variant+')':''} <span style="color:var(--text-light,#7A6355);float:right">RM${((i.price||i.unitPrice||0)*(i.quantity||i.qty||1)).toFixed(2)}</span></li>`).join('');
  let actions = '';
  if(o.status==='PENDING') actions=`<button class="pos-btn pos-btn-primary pos-btn-lg" id="btnApprove">✓ Payment Confirmed</button>
    <button class="pos-btn pos-btn-lg" id="btnNewcomer" style="background:#8b5cf6;color:#fff">🎁 Newcomer</button>
    <button class="pos-btn pos-btn-danger pos-btn-lg" id="btnReject">✗ Reject</button>`;
  else if(o.status==='PREPARING') actions=`<button class="pos-btn pos-btn-primary pos-btn-lg" id="btnReady">✓ Ready</button>
    <button class="pos-btn pos-btn-lg" id="btnUndo" style="background:#6b7280;color:#fff">↩ Undo</button>`;
  else if(o.status==='READY') actions=`<button class="pos-btn pos-btn-primary pos-btn-lg" id="btnCollected">✓ Collected</button>
    <button class="pos-btn pos-btn-lg" id="btnUndoReady" style="background:#6b7280;color:#fff">↩ Back to Preparing</button>
    <button class="pos-btn pos-btn-danger pos-btn-lg" id="btnCancelCompleted">✗ Cancel / Refund</button>`;

  const orderTime = new Date(o.createdAt).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit'});

  const modal = document.createElement('div');
  modal.className='pos-modal-overlay';
  modal.innerHTML=`<div class="pos-modal">
    <button class="pos-modal-close">✕</button>
    <h3>${o.customerName||'Guest'}</h3>
    <p style="font-size:.82rem;color:var(--text-light,#7A6355);margin-top:4px">Ordered at ${orderTime} · ${timeAgo(o.createdAt)}${o.isWalkUp?' · Walk-up':''}</p>
    <ul class="pos-detail-items">${items}</ul>
    ${o.notes ? `<div style="background:var(--cream,#f9f5f0);padding:10px 12px;border-radius:8px;font-size:.85rem;margin-bottom:10px">📝 ${o.notes}</div>` : ''}
    <div class="pos-detail-total">Total: RM ${(o.total||o.totalAmount||0).toFixed(2)}</div>
    ${o.discountType && o.discountType!=='NONE' ? `<div style="font-size:.85rem;color:#7C3AED;margin-bottom:8px">Discount: ${o.discountType}</div>` : ''}
    <div class="pos-detail-actions">${actions}</div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

  if(o.status==='PENDING'){
    modal.querySelector('#btnApprove').onclick=async()=>{ if(!approveGuardOk(id)) return; await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser}); modal.remove(); fetchOrders(); };
    modal.querySelector('#btnNewcomer').onclick=async()=>{ if(!approveGuardOk(id)) return; await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser,discountType:'NEWCOMER'}); modal.remove(); fetchOrders(); };
    modal.querySelector('#btnReject').onclick=()=>showRejectDialog(id, modal);
  } else if(o.status==='PREPARING'){
    modal.querySelector('#btnReady').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/ready`); modal.remove(); playReadySound(); showNameFlash(o.customerName); fetchOrders(); };
    modal.querySelector('#btnUndo').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/undo`); modal.remove(); fetchOrders(); };
  } else if(o.status==='READY'){
    modal.querySelector('#btnCollected').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/archive`); modal.remove(); fetchOrders(); };
    modal.querySelector('#btnUndoReady').onclick=async()=>{
      const btn = modal.querySelector('#btnUndoReady');
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = '…';
      try {
        await api('PUT',`/api/pos/orders/${id}/undo-ready`);
        modal.remove();
        fetchOrders();
      } catch(e){
        showError('Could not move back to Preparing');
        btn.disabled = false;
        btn.textContent = prev;
      }
    };
    modal.querySelector('#btnCancelCompleted').onclick=()=> showCancelCompletedDialog(id, modal);
  }
}

function showRejectDialog(id, parentModal){
  const reasons=['Out of stock','Customer cancelled','Payment issue','Other'];
  const d=document.createElement('div');
  d.className='pos-reject-picker';
  d.innerHTML=`<h4>Reject Reason</h4>${reasons.map(r=>`<button class="pos-btn pos-btn-sm">${r}</button>`).join('')}`;
  parentModal.querySelector('.pos-detail-actions').appendChild(d);
  d.querySelectorAll('button').forEach(b=>b.onclick=async()=>{
    await api('PUT',`/api/pos/orders/${id}/reject`,{reason:b.textContent});
    parentModal.remove(); fetchOrders();
  });
}

// Cashier-driven cancel for READY/ARCHIVED orders. Distinct from Reject
// (which only acts on PENDING) — this records cancelReason + cancelledBy
// on the order so daily reports can flag it as a refund line.
function showCancelCompletedDialog(id, parentModal){
  const presetReasons = ['Wrong order made', 'Customer no-show', 'Duplicate', 'Made by mistake'];
  const overlay = document.createElement('div');
  overlay.className = 'pos-modal-overlay';
  overlay.style.zIndex = '600';
  overlay.innerHTML = `<div class="pos-modal" style="max-width:420px">
    <button class="pos-modal-close">✕</button>
    <h3 style="color:#B91C1C">Cancel / Refund Order</h3>
    <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:8px 0 14px">
      This marks the order as cancelled for reporting (refund line).
      Ingredients already used will not be returned to stock.
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
      ${presetReasons.map(r=>`<button class="pos-btn pos-btn-sm" data-preset="${r}">${r}</button>`).join('')}
    </div>
    <input id="ccReason" class="pos-input" placeholder="Reason (required)" maxlength="200" style="margin-bottom:12px">
    <div style="display:flex;gap:8px">
      <button class="pos-btn" id="ccBack" style="flex:1">Back</button>
      <button class="pos-btn pos-btn-danger pos-btn-lg" id="ccConfirm" style="flex:2">Confirm Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if(e.target === overlay) overlay.remove(); };
  overlay.querySelector('.pos-modal-close').onclick = ()=> overlay.remove();
  overlay.querySelector('#ccBack').onclick = ()=> overlay.remove();

  const reasonInput = overlay.querySelector('#ccReason');
  reasonInput.focus();
  overlay.querySelectorAll('[data-preset]').forEach(b=>{
    b.onclick = ()=>{
      reasonInput.value = b.dataset.preset;
      reasonInput.focus();
    };
  });

  overlay.querySelector('#ccConfirm').onclick = async ()=>{
    const reason = reasonInput.value.trim();
    if(!reason){ showError('Reason is required'); reasonInput.focus(); return; }
    const btn = overlay.querySelector('#ccConfirm');
    btn.disabled = true; btn.textContent = 'Cancelling…';
    try{
      await api('POST', `/api/pos/orders/${id}/cancel-completed`, { reason });
      overlay.remove();
      if(parentModal) parentModal.remove();
      try{ showSuccessToast('Order cancelled — will show as refund in reports'); }
      catch(e){ /* helper may not exist on older builds */ }
      fetchOrders();
    } catch(e){
      btn.disabled = false; btn.textContent = 'Confirm Cancel';
      const msg = String(e && e.message || '');
      if(msg.includes('no longer in a cancellable state')){
        showError('Order is no longer cancellable');
      } else {
        showError('Cancel failed');
      }
    }
  };
}

// --- Menu Toggle ---
async function openMenuToggle(){
  let menu=[];
  // /api/pos/menu returns every admin-active item (isActive=true) regardless
  // of today's toggle, so the cashier can see + re-enable items that have
  // been switched off for the day. The public /api/menu would hide them.
  try{ const d=await api('GET','/api/pos/menu'); menu=Array.isArray(d)?d:d.items||[]; } catch(e){ showError('Failed to load menu'); return; }
  const drinks = menu.filter(m=>m.category==='DRINK').sort((a,b)=>{
    const top=['Long Black','Latte'];
    const strip=s=>s.replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u,'');
    const ai=top.indexOf(strip(a.name)),bi=top.indexOf(strip(b.name));
    if(ai!==-1&&bi!==-1)return ai-bi;
    if(ai!==-1)return -1;
    if(bi!==-1)return 1;
    return strip(a.name).localeCompare(strip(b.name));
  });
  const foodAll = menu.filter(m=>m.category==='FOOD');
  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';

  function renderModal(){
    const food = foodAll.slice().sort((a,b)=>{
      if(!!a.isPinned!==!!b.isPinned)return a.isPinned?-1:1;
      const aq=Number(a.foodQuantityToday||0)>0, bq=Number(b.foodQuantityToday||0)>0;
      if(aq!==bq)return aq?-1:1;
      const strip=s=>s.replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u,'');
      return strip(a.name).localeCompare(strip(b.name));
    });
    const allItems = [...drinks, ...food];
    modal.innerHTML=`<div class="pos-modal" style="max-width:600px">
      <button class="pos-modal-close">✕</button>
      <h3>Menu & Food Quantity</h3>
      <div style="margin-top:16px">
        <h4 style="margin-bottom:10px;color:var(--primary,#6B4226)">🥤 Drinks</h4>
        <div class="pos-menu-toggles">${drinks.map(m=>`<div class="pos-menu-toggle-row${m.isEnabledToday===false?' is-disabled':''}" data-row-id="${m.menuItemId||m.id}">
          <span>${m.name}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="pos-pin-btn ${m.isPinned?'pinned':''}" data-pin-id="${m.menuItemId||m.id}" title="${m.isPinned?'Unpin':'Pin to top'}">📌</button>
            <label class="pos-switch"><input type="checkbox" data-id="${m.menuItemId||m.id}" data-type="toggle" ${m.isEnabledToday!==false?'checked':''}><span class="pos-slider"></span></label>
          </div>
        </div>`).join('')}</div>
      </div>
      <div style="margin-top:24px">
        <h4 style="margin-bottom:10px;color:var(--primary,#6B4226)">🍔 Food — set today's quantity</h4>
        <div class="pos-menu-toggles">${food.map(m=>{
          const qty = m.foodQuantityToday || 0;
          const reserved = m.foodReserved || 0;
          const enabled = m.isEnabledToday !== false;
          return `<div class="pos-menu-toggle-row${enabled?'':' is-disabled'}" data-row-id="${m.menuItemId||m.id}" style="flex-wrap:wrap;gap:8px">
            <span style="flex:1;min-width:120px">${m.name}</span>
            <div style="display:flex;align-items:center;gap:8px">
              <button class="pos-pin-btn ${m.isPinned?'pinned':''}" data-pin-id="${m.menuItemId||m.id}" title="${m.isPinned?'Unpin':'Pin to top'}">📌</button>
              <label class="pos-switch"><input type="checkbox" data-id="${m.menuItemId||m.id}" data-type="toggle" ${enabled?'checked':''}><span class="pos-slider"></span></label>
              <button class="pos-btn pos-btn-sm" data-food-dec="${m.menuItemId||m.id}" style="width:36px;height:36px;border-radius:50%;padding:0">−</button>
              <input type="number" min="0" data-food-qty="${m.menuItemId||m.id}" value="${qty}" style="width:50px;text-align:center;font-weight:700;border:1px solid var(--cream-dark,#ddd);border-radius:6px;padding:4px;font-size:1rem" class="pos-food-qty-input">
              <button class="pos-btn pos-btn-sm" data-food-inc="${m.menuItemId||m.id}" style="width:36px;height:36px;border-radius:50%;padding:0">+</button>
              ${reserved > 0 ? `<span style="font-size:.75rem;color:#9CA3AF">(${reserved} reserved)</span>` : ''}
            </div>
          </div>`;
        }).join('')}</div>
      </div>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

    modal.querySelectorAll('.pos-pin-btn').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.pinId;
      const item=menu.find(m=>(m.menuItemId||m.id)===id);
      try{
        await api('PUT',`/api/pos/menu/${id}/pin`);
        item.isPinned = !item.isPinned;
        btn.classList.toggle('pinned', item.isPinned);
      } catch(e){ showError('Pin failed'); }
    });

    modal.querySelectorAll('input[data-type="toggle"]').forEach(cb=>cb.onchange=async()=>{
      const id = cb.dataset.id;
      const item = menu.find(m=>(m.menuItemId||m.id)===id);
      const nextEnabled = cb.checked;
      try{
        await api('PUT',`/api/pos/menu/${id}/toggle`);
        if(item) item.isEnabledToday = nextEnabled;
        // Reflect greyed-out state on the row without a full re-render
        const row = modal.querySelector(`.pos-menu-toggle-row[data-row-id="${CSS.escape(id)}"]`);
        if(row) row.classList.toggle('is-disabled', !nextEnabled);
      }
      catch(e){ showError('Toggle failed'); cb.checked=!cb.checked; }
    });

    modal.querySelectorAll('[data-food-inc]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.foodInc;
      const item=menu.find(m=>(m.menuItemId||m.id)===id);
      item.foodQuantityToday = (item.foodQuantityToday||0) + 1;
      try{
        await updateFoodQty(id, item.foodQuantityToday);
        modal.querySelector(`[data-food-qty="${id}"]`).value = item.foodQuantityToday;
      } catch(e){ item.foodQuantityToday--; showError('Update failed'); }
    });

    modal.querySelectorAll('[data-food-dec]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.foodDec;
      const item=menu.find(m=>(m.menuItemId||m.id)===id);
      if((item.foodQuantityToday||0) <= 0) return;
      item.foodQuantityToday--;
      try{
        await updateFoodQty(id, item.foodQuantityToday);
        modal.querySelector(`[data-food-qty="${id}"]`).value = item.foodQuantityToday;
      } catch(e){ item.foodQuantityToday++; showError('Update failed'); }
    });

    modal.querySelectorAll('.pos-food-qty-input').forEach(inp=>inp.onchange=async()=>{
      const id=inp.dataset.foodQty;
      const item=menu.find(m=>(m.menuItemId||m.id)===id);
      const newQty=Math.max(0,parseInt(inp.value)||0);
      inp.value=newQty;
      try{ await updateFoodQty(id, newQty); item.foodQuantityToday=newQty; }
      catch(e){ inp.value=item.foodQuantityToday||0; showError('Update failed'); }
    });
  }

  renderModal();
  document.body.appendChild(modal);
}

async function updateFoodQty(menuItemId, qty){
  await api('PUT',`/api/pos/menu/${menuItemId}/quantity`, { foodQuantityToday: qty });
}

// --- Prep View ---
function openPrepView(){
  const preparing = orders.filter(o=>o.status==='PREPARING');
  const items = [];
  preparing.forEach(o=>{
    (o.items||[]).forEach(i=>{
      for(let n=0;n<(i.quantity||i.qty||1);n++) items.push({name:i.name,variant:i.variant,customer:o.customerName,notes:o.notes});
    });
  });
  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';
  modal.innerHTML=`<div class="pos-modal" style="max-width:500px">
    <button class="pos-modal-close">✕</button>
    <h3>☕ Prep Queue (${items.length} drinks)</h3>
    <div style="margin-top:16px;max-height:60vh;overflow-y:auto">
      ${items.length ? items.map((it,i)=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--cream-dark,#eee)">
        <div><strong>${it.name}</strong>${it.variant?' <span style="color:var(--text-light,#7A6355)">('+it.variant+')</span>':''}</div>
        <div style="text-align:right;font-size:.85rem"><span style="color:var(--primary,#6B4226)">${it.customer}</span>${it.notes?'<br><span style="color:#7C3AED;font-size:.75rem">📝 '+it.notes+'</span>':''}</div>
      </div>`).join('') : '<p style="color:var(--text-light);text-align:center;padding:24px">No orders being prepared</p>'}
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
}

function showSuccessToast(msg){
  let host = document.getElementById('posToastHost');
  if(!host){
    host = document.createElement('div');
    host.id = 'posToastHost';
    host.style.cssText = 'position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:500;pointer-events:none';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'pos-toast';
  t.style.cssText = 'background:#2D8A4E;color:#fff;padding:10px 14px;border-radius:8px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:opacity .3s';
  t.textContent = '✓ ' + msg;
  host.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(), 300); }, 4000);
}

function escapeHtmlPos(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// --- Featured Drink Modal ---
async function openFeaturedDrinkModal(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';

  if(featuredDrink){
    // Show current + option to unfeature
    modal.innerHTML = `<div class="pos-modal" style="max-width:400px;text-align:center">
      <button class="pos-modal-close">✕</button>
      <h3>⭐ Featured Drink</h3>
      <p style="margin:16px 0;font-size:1.1rem;font-weight:600">${featuredDrink.name}</p>
      <p style="color:var(--text-light);font-size:.85rem;margin-bottom:20px">RM ${featuredDrink.basePrice.toFixed(2)}</p>
      <button id="featUnset" class="pos-btn pos-btn-sm" style="background:var(--danger,#C0392B);color:#fff;width:100%">Remove Featured Drink</button>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    modal.onclick = e=>{ if(e.target===modal) modal.remove(); };
    modal.querySelector('#featUnset').onclick = async()=>{
      try{ await api('DELETE','/api/pos/featured-drink'); featuredDrink=null; fetchCafeStatus(); modal.remove(); showSuccessToast('Featured drink removed'); }
      catch(e){ showError('Failed to remove featured drink'); }
    };
    return;
  }

  // Show list of drinks to pick from
  let drinks = [];
  try{ const r = await api('GET','/api/pos/menu'); drinks = (r.items||r).filter(i=>i.category==='DRINK'&&i.isEnabledToday!==false); }
  catch(e){ showError('Failed to load menu'); return; }

  modal.innerHTML = `<div class="pos-modal" style="max-width:500px;max-height:80vh;overflow-y:auto">
    <button class="pos-modal-close">✕</button>
    <h3>⭐ Set Featured Drink</h3>
    <p style="color:var(--text-light);font-size:.85rem;margin:8px 0 16px">Pick one drink to feature on the order screen today.</p>
    <div class="pos-featured-list">
      ${drinks.map(d=>`<button class="pos-featured-pick" data-id="${d.menuItemId}">
        <span class="feat-name">${d.name}</span>
        <span class="feat-price">RM ${d.basePrice.toFixed(2)}</span>
      </button>`).join('')}
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
  modal.onclick = e=>{ if(e.target===modal) modal.remove(); };
  modal.querySelectorAll('.pos-featured-pick').forEach(btn=>{
    btn.onclick = async()=>{
      try{ await api('PUT','/api/pos/featured-drink',{menuItemId:btn.dataset.id}); fetchCafeStatus(); modal.remove(); showSuccessToast('Featured drink set!'); }
      catch(e){ showError('Failed to set featured drink'); }
    };
  });
}

// --- Keyboard shortcuts ---
document.addEventListener('keydown', e=>{
  if(!token) return;
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  if(e.key==='w'||e.key==='W'){ e.preventDefault(); openWalkup(); }
  if(e.key==='v'||e.key==='V'){ e.preventDefault(); openVoucherFlow(); }
  if(e.key==='m'||e.key==='M'){ e.preventDefault(); openMenuToggle(); }
  if(e.key==='h'||e.key==='H'){ e.preventDefault(); openHistory(); }
  if(e.key==='p'||e.key==='P'){ e.preventDefault(); openPrepView(); }
  if(e.key==='s'||e.key==='S'){ e.preventDefault(); openStockCount('fridge'); }
  if(e.key==='/'){ e.preventDefault(); const s=$('#orderSearch'); if(s) s.focus(); }
});

