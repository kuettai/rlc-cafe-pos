(function(){
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
  $('#btnView').onclick = ()=>{ viewMode = viewMode==='kanban'?'list':'kanban'; renderBoard(); $('#btnView').textContent = viewMode==='kanban'?'📋 List':'📊 Kanban'; };
  $('#orderSearch').oninput = e=>{ searchFilter=e.target.value.toLowerCase(); renderBoard(); };
  fetchCafeStatus();
  fetchOrders();
  startPolling();
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

function cardHtml(o){
  const items = (o.items||[]).map(i=>`<div>${i.quantity||i.qty||1}x ${i.name}${i.variant?' ('+i.variant+')':''}</div>`).join('');
  const mins = Math.floor((Date.now()-new Date(o.createdAt))/60000);
  const urgent = mins > 10 && o.status === 'PENDING';
  const hasReceipt = !!o.receiptUrl;
  let quickAction = '';
  if(o.status==='PENDING') quickAction = `<div class="pos-card-actions"><button class="pos-btn pos-btn-sm pos-btn-primary pos-card-quick-approve" data-quick-id="${o.id||o.orderId}" onclick="event.stopPropagation()">✓ Approve</button></div>`;
  else if(o.status==='PREPARING') quickAction = `<div class="pos-card-actions"><button class="pos-btn pos-btn-sm pos-btn-primary pos-card-quick-ready" data-quick-id="${o.id||o.orderId}" onclick="event.stopPropagation()">✓ Ready</button></div>`;

  return `<div class="pos-card pos-card-${o.status.toLowerCase()} ${urgent?'pos-card-urgent':''} ${hasReceipt?'pos-card-receipt':''}" data-id="${o.id||o.orderId}" data-status="${o.status}">
    ${hasReceipt ? `<div class="pos-receipt-badge${Math.abs((o.receiptAmount||0)-(o.total||o.totalAmount||0))>0.01?' pos-receipt-mismatch':''}">💰 Receipt: RM${(o.receiptAmount||0).toFixed(2)}${Math.abs((o.receiptAmount||0)-(o.total||o.totalAmount||0))>0.01?' ⚠️ expected RM'+(o.total||o.totalAmount||0).toFixed(2):''}</div>` : ''}
    ${o.status==='PENDING' && o.modifiedAt ? '<div class="pos-card-modified">✏️ modified</div>' : ''}
    <div class="pos-card-name">${o.customerName||'Guest'}${o.isWalkUp?' <span class="pos-card-tag">walk-up</span>':''}</div>
    <div class="pos-card-items">${items||'—'}</div>
    ${o.notes ? '<div class="pos-card-note">📝 '+o.notes+'</div>' : ''}
    ${archiveHint(o)}
    <div class="pos-card-footer"><span>RM ${(o.total||o.totalAmount||0).toFixed(2)}</span><span>${urgent?'⚠️ ':''}${timeAgo(o.createdAt)}</span></div>
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

// --- Cafe toggle with checklist ---
async function toggleCafe(){
  const phase = cafeOpen ? 'close' : 'open';
  openChecklist(phase);
}

async function showShiftSummary(){
  try{
    const data = await api('GET','/api/pos/shift-summary');
    const modal = document.createElement('div');
    modal.className = 'pos-modal-overlay';
    modal.innerHTML = `<div class="pos-modal" style="max-width:360px;text-align:center">
      <h3 style="font-size:1.5rem;margin-bottom:8px">🎉 Great shift!</h3>
      <div style="border-top:2px solid var(--cream-dark,#eee);border-bottom:2px solid var(--cream-dark,#eee);padding:16px 0;margin:12px 0;text-align:left;font-size:1rem;line-height:2">
        <div>Orders processed: <strong>${data.totalOrders}</strong></div>
        <div>Revenue: <strong>RM ${data.totalRevenue}</strong></div>
        <div>Newcomers served: <strong>${data.newcomersServed}</strong> 🙏</div>
        <div>Most popular: <strong>☕ ${data.peakItem}</strong></div>
      </div>
      <p style="color:var(--text-light,#7A6355);margin-bottom:16px">See you next Sunday!</p>
      <button class="pos-btn pos-btn-primary" id="shiftSummaryClose">Close</button>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#shiftSummaryClose').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
  } catch(e){}
}

async function openChecklist(phase){
  let data;
  try{ data = await api('GET','/api/pos/checklist'); } catch(e){ showError('Failed to load checklist'); return; }
  const config = data.config || { open: [], close: [] };
  const log = data.log || { open: { items: {} }, close: { items: {} } };
  const items = phase === 'open' ? config.open : config.close;
  const checked = log[phase]?.items || {};

  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';

  function renderChecklistModal(){
    const allChecked = items.every(i => checked[i.id]?.checked);
    modal.innerHTML = `<div class="pos-modal" style="max-width:520px">
      <button class="pos-modal-close">✕</button>
      <h3>${phase === 'open' ? '☀️ Open Café Checklist' : '🌙 Close Café Checklist'}</h3>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:8px 0 16px">Complete all items before ${phase === 'open' ? 'opening' : 'closing'}</p>
      <div class="checklist-items">
        ${items.map(item => {
          const isDone = checked[item.id]?.checked;
          const doneBy = checked[item.id]?.completedBy;
          const doneAt = checked[item.id]?.completedAt;
          const timeStr = doneAt ? new Date(doneAt).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit'}) : '';
          return `<div class="checklist-row ${isDone?'done':''}">
            <label class="checklist-label">
              <input type="checkbox" data-item-id="${item.id}" ${isDone?'checked':''}>
              <span>${item.name || item.label}</span>
              ${item.type === 'image' ? '<span class="checklist-badge">📷</span>' : ''}
              ${item.type === 'text' ? '<span class="checklist-badge">✏️</span>' : ''}
            </label>
            ${isDone ? `<span class="checklist-meta">${doneBy} · ${timeStr}</span>` : ''}
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:20px;display:flex;gap:10px">
        <button id="clSubmit" class="pos-btn pos-btn-primary pos-btn-lg" ${allChecked?'':'disabled'}>
          ${phase === 'open' ? '☀️ Open Café' : '🌙 Close Café'}
        </button>
        <button id="clCancel" class="pos-btn pos-btn-lg">Cancel</button>
      </div>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.querySelector('#clCancel').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

    modal.querySelectorAll('input[type=checkbox]').forEach(cb=>{
      cb.onchange=async()=>{
        const itemId = cb.dataset.itemId;
        const item = items.find(i=>i.id===itemId);
        if(cb.checked){
          if(item.type === 'image'){
            cb.checked = false;
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.capture = 'environment';
            fileInput.onchange = async () => {
              if(!fileInput.files?.length) return;
              checked[itemId] = { checked: true, completedBy: currentUser, completedAt: new Date().toISOString() };
              api('PUT','/api/pos/checklist/check',{ phase, itemId, completedBy: currentUser }).catch(()=>{});
              cb.checked = true;
              const row = cb.closest('.checklist-row');
              row.classList.add('done');
              const allChecked = items.every(i => checked[i.id]?.checked);
              const submitBtn = modal.querySelector('#clSubmit');
              if(submitBtn) submitBtn.disabled = !allChecked;
            };
            fileInput.click();
            return;
          }
          try{
            await api('PUT','/api/pos/checklist/check',{ phase, itemId, completedBy: currentUser });
            checked[itemId] = { checked: true, completedBy: currentUser, completedAt: new Date().toISOString() };
          } catch(e){ cb.checked = false; showError('Failed to save'); return; }
        } else {
          try{
            await api('PUT','/api/pos/checklist/uncheck',{ phase, itemId });
            delete checked[itemId];
          } catch(e){ cb.checked = true; showError('Failed to save'); return; }
        }
        const allChecked = items.every(i => checked[i.id]?.checked);
        const submitBtn = modal.querySelector('#clSubmit');
        if(submitBtn) submitBtn.disabled = !allChecked;
        const row = cb.closest('.checklist-row');
        if(cb.checked){ row.classList.add('done'); } else { row.classList.remove('done'); }
      };
    });

    const submitBtn = modal.querySelector('#clSubmit');
    if(submitBtn) submitBtn.onclick=async()=>{
      if(phase === 'close'){
        const activeCount = orders.filter(o=>o.status==='PENDING'||o.status==='PREPARING').length;
        if(activeCount > 0 && !confirm(`This will expire ${activeCount} active order(s). Continue?`)) return;
      }
      try{
        cafeOpen = phase === 'open';
        await api('PUT',`/api/pos/cafe/${phase}`);
        modal.remove();
        if(phase === 'close') await showShiftSummary();
        renderMain();
      } catch(e){ cafeOpen = !cafeOpen; showError('Failed to toggle café'); }
    };
  }

  renderChecklistModal();
  document.body.appendChild(modal);
}

// --- Walk-up Order ---
async function openWalkup(){
  let menu=[];
  try{ const d=await api('GET','/api/menu'); menu=Array.isArray(d)?d:d.items||[]; } catch(e){ showError('Failed to load menu'); return; }
  const cart=[];
  let wkFilter = '';
  let wkCategory = 'ALL';
  // Discount is preserved across re-renders since renderWalkup() rewrites
  // innerHTML each time. Kept in closure state so the pill selection sticks
  // when a user adds items or searches after picking a discount.
  let selectedDiscount = '';
  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';

  // Sort by popularity (items ordered more often appear first)
  const orderHistory = JSON.parse(localStorage.getItem('walkup_item_counts')||'{}');
  menu.sort((a,b)=>{
    const aCount = orderHistory[a.menuItemId||a.id]||0;
    const bCount = orderHistory[b.menuItemId||b.id]||0;
    if(bCount !== aCount) return bCount - aCount;
    return (a.sortOrder||0)-(b.sortOrder||0);
  });

  function filteredMenu(){
    return menu.filter(m=>{
      if(m.isEnabledToday === false) return false;
      if(wkCategory !== 'ALL' && m.category !== wkCategory) return false;
      if(wkFilter && !m.name.toLowerCase().includes(wkFilter)) return false;
      return true;
    });
  }

  function renderWalkup(){
    const filtered = filteredMenu();
    const cartHtml=cart.map((c,i)=>`<li>${c.qty}x ${c.name}${c.variant?' ('+c.variant+')':''} <span style="color:var(--text-light,#7A6355);font-size:.85rem">RM${(c.price*c.qty).toFixed(2)}</span> <button data-ri="${i}" class="pos-remove-item">✕</button></li>`).join('');
    const cartTotal = cart.reduce((s,c)=>s+c.price*c.qty,0);

    modal.innerHTML=`<div class="pos-modal pos-modal-walkup">
      <button class="pos-modal-close">✕</button>
      <h3>Walk-up Order</h3>
      <input id="wkName" class="pos-input" placeholder="Customer name" value="${cart._name||''}" style="margin-bottom:12px">
      <input id="wkSearch" class="pos-input" placeholder="Search menu..." value="${wkFilter}" style="margin-bottom:8px">
      <div class="pos-walkup-filters">
        <button class="pos-btn pos-btn-sm ${wkCategory==='ALL'?'active':''}" data-wk-cat="ALL">All</button>
        <button class="pos-btn pos-btn-sm ${wkCategory==='DRINK'?'active':''}" data-wk-cat="DRINK">Drinks</button>
        <button class="pos-btn pos-btn-sm ${wkCategory==='FOOD'?'active':''}" data-wk-cat="FOOD">Food</button>
      </div>
      <div class="pos-walkup-menu">${filtered.length ? filtered.map(m=>{
        const price = m.basePrice || m.price || 0;
        let variantHtml = '';
        if(m.variantGroups && m.variantGroups.length){
          variantHtml = m.variantGroups.map(g=>g.options.map(o=>
            `<button class="pos-variant-btn" data-mid="${m.menuItemId||m.id}" data-group="${g.group}" data-type="${g.type}" data-v="${o.name}" data-vp="${o.price||0}">${o.name}${o.price ? ' +'+o.price : ''}</button>`
          ).join('')).join('');
        } else if(m.variants && m.variants.length){
          variantHtml = m.variants.map(v=>`<button class="pos-variant-btn" data-mid="${m.menuItemId||m.id}" data-v="${v.name||v.id}" data-vp="${v.priceModifier||0}">${v.name||v}${v.priceModifier ? ' +'+v.priceModifier : ''}</button>`).join('');
        }
        return `<div class="pos-walkup-item"><span>${m.name}${price ? ' - RM'+price.toFixed(2) : ''}</span>${variantHtml}<button class="pos-add-btn" data-mid="${m.menuItemId||m.id}" data-mname="${m.name}" data-mp="${price}">+</button></div>`;
      }).join('') : '<div style="padding:16px;text-align:center;color:var(--text-light,#7A6355)">No items match</div>'}</div>
      <div class="pos-walkup-cart"><h4>Cart${cart.length ? ' — RM'+cartTotal.toFixed(2) : ''}</h4><ul>${cartHtml||'<li>Empty</li>'}</ul></div>
      <input id="wkNotes" class="pos-input" placeholder="Special requests (less sugar, extra hot)" style="margin-bottom:12px">
      <fieldset class="pos-chip-group" id="wkDiscountGroup" aria-label="Discount">
        <legend class="pos-chip-legend">Discount</legend>
        ${[
          {value:'',         label:'No Discount'},
          {value:'STAFF',    label:'Staff (RM5)'},
          {value:'PASTOR',   label:'Pastor (Free)'},
          {value:'NEWCOMER', label:'Newcomer (Free)'},
        ].map(o=>`<label class="pos-chip"><input type="radio" name="wkDiscount" value="${o.value}" ${selectedDiscount===o.value?'checked':''}><span>${o.label}</span></label>`).join('')}
      </fieldset>
      <button id="wkSubmit" class="pos-btn pos-btn-primary pos-btn-lg" ${cart.length?'':'disabled'}>Submit Order</button></div>`;

    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

    modal.querySelector('#wkSearch').oninput=e=>{
      wkFilter=e.target.value.toLowerCase();
      cart._name=modal.querySelector('#wkName')?.value||'';
      renderWalkup();
      modal.querySelector('#wkSearch').focus();
    };

    modal.querySelectorAll('[data-wk-cat]').forEach(btn=>btn.onclick=()=>{
      wkCategory=btn.dataset.wkCat;
      cart._name=modal.querySelector('#wkName')?.value||'';
      renderWalkup();
    });

    modal.querySelectorAll('.pos-add-btn').forEach(b=>b.onclick=()=>{
      const existing = cart.find(c=>c.menuItemId===b.dataset.mid && !c.variant);
      if(existing){ existing.qty++; }
      else { cart.push({name:b.dataset.mname, menuItemId:b.dataset.mid, price:+b.dataset.mp, qty:1, variant:null}); }
      cart._name=modal.querySelector('#wkName')?.value||'';
      renderWalkup();
    });
    modal.querySelectorAll('.pos-variant-btn').forEach(b=>b.onclick=()=>{
      const item=menu.find(m=>(m.menuItemId||m.id)===b.dataset.mid);
      const basePrice = item.basePrice || item.price || 0;
      const variantPrice = basePrice + (+b.dataset.vp||0);
      const sv = [{group: b.dataset.group||'', option: b.dataset.v, price: +b.dataset.vp||0}];
      const existing = cart.find(c=>c.menuItemId===b.dataset.mid && c.variant===b.dataset.v);
      if(existing){ existing.qty++; }
      else { cart.push({name:item.name, menuItemId:b.dataset.mid, price:variantPrice, qty:1, variant:b.dataset.v, selectedVariants:sv}); }
      cart._name=modal.querySelector('#wkName')?.value||'';
      renderWalkup();
    });
    modal.querySelectorAll('.pos-remove-item').forEach(b=>b.onclick=()=>{ cart.splice(+b.dataset.ri,1); cart._name=modal.querySelector('#wkName')?.value||''; renderWalkup(); });

    modal.querySelectorAll('input[name="wkDiscount"]').forEach(r=>{
      r.onchange=()=>{ if(r.checked) selectedDiscount = r.value; };
    });

    const submitBtn=modal.querySelector('#wkSubmit');
    if(submitBtn) submitBtn.onclick=async()=>{
      const name=modal.querySelector('#wkName').value||'Walk-up';
      const disc=(modal.querySelector('input[name="wkDiscount"]:checked')?.value)||undefined;
      const notes=modal.querySelector('#wkNotes')?.value||'';
      try{
        await api('POST','/api/pos/orders',{customerName:name, items:cart.map(c=>({menuItemId:c.menuItemId,name:c.name,variant:c.variant,selectedVariants:c.selectedVariants||[],quantity:c.qty,price:c.price})), discountType:disc, notes});
        // Track item popularity for favourites sorting
        const counts = JSON.parse(localStorage.getItem('walkup_item_counts')||'{}');
        cart.forEach(c=>{ counts[c.menuItemId] = (counts[c.menuItemId]||0) + c.qty; });
        localStorage.setItem('walkup_item_counts', JSON.stringify(counts));
        modal.remove(); fetchOrders();
      } catch(e){ showError('Failed to submit order'); }
    };
  }
  renderWalkup();
  document.body.appendChild(modal);
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

// --- Order History ---
async function openHistory(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:600px"><button class="pos-modal-close">✕</button><h3>Order History (Today)</h3><div class="loading">Loading...</div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

  try{
    const data = await api('GET','/api/pos/orders?all=true');
    const allOrders = Array.isArray(data) ? data : data.orders || [];
    const completed = allOrders.filter(o=>['ARCHIVED','EXPIRED','CANCELLED','READY'].includes(o.status));
    completed.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));

    const content = modal.querySelector('.pos-modal');
    if(!completed.length){
      content.innerHTML = `<button class="pos-modal-close">✕</button><h3>Order History (Today)</h3><div style="padding:24px;text-align:center;color:var(--text-light,#7A6355)">No completed orders yet</div>`;
    } else {
      content.innerHTML = `<button class="pos-modal-close">✕</button><h3>Order History (Today)</h3>
        <div class="pos-history-list">${completed.map(o=>{
          const items = (o.items||[]).map(i=>`${i.quantity||i.qty||1}x ${i.name}`).join(', ');
          const statusClass = o.status==='CANCELLED'||o.status==='EXPIRED' ? 'badge-inactive' : 'badge-active';
          const oid = o.orderId || o.id;
          const canCancel = (o.status === 'READY' || o.status === 'ARCHIVED');
          return `<div class="pos-history-item">
            <div class="pos-history-header">
              <strong>${o.customerName||'Guest'}</strong>
              <span class="admin-card-badge ${statusClass}">${o.status}</span>
            </div>
            <div class="pos-history-details">${items}</div>
            ${o.cancelReason ? `<div style="font-size:.75rem;color:var(--text-light,#7A6355);margin-top:4px">Cancelled: ${o.cancelReason}${o.cancelledBy?' · by '+o.cancelledBy:''}</div>` : ''}
            <div class="pos-history-footer">
              <span>RM ${(o.total||o.totalAmount||0).toFixed(2)}</span>
              <span>${new Date(o.createdAt).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit'})}</span>
              <button class="pos-btn pos-btn-sm" data-reorder='${JSON.stringify({name:o.customerName,items:o.items})}'>Reorder</button>
              ${canCancel ? `<button class="pos-btn pos-btn-sm pos-btn-danger" data-cancel-completed="${oid}">Cancel / Refund</button>` : ''}
            </div>
          </div>`;
        }).join('')}</div>`;
    }

    content.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    content.querySelectorAll('[data-reorder]').forEach(btn=>btn.onclick=async()=>{
      const data = JSON.parse(btn.dataset.reorder);
      try{
        await api('POST','/api/pos/orders',{customerName:data.name||'Walk-up', items:(data.items||[]).map(i=>({menuItemId:i.menuItemId,name:i.name,variant:i.variant,qty:i.quantity||i.qty||1,price:i.price||i.unitPrice||0}))});
        modal.remove();
        fetchOrders();
      } catch(e){ showError('Reorder failed'); }
    });

    content.querySelectorAll('[data-cancel-completed]').forEach(btn=>{
      btn.onclick = ()=> showCancelCompletedDialog(btn.dataset.cancelCompleted, modal);
    });
  } catch(e){ showError('Failed to load history'); modal.remove(); }
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

// --- Manual Stock Count GUI ---
// Cashier flow: pick a location (or ALL), see current stock for every
// ingredient, adjust with +/- or direct entry, hit Save. Backend persists
// new counts and records a snapshot for admin backtrace.
async function openManualStockCount(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:640px;max-height:90vh;display:flex;flex-direction:column;padding:0">
    <div style="padding:16px 20px;border-bottom:1px solid var(--cream-dark,#E7DFD5);display:flex;justify-content:space-between;align-items:center;gap:12px">
      <h3 style="margin:0">📦 Stock Count</h3>
      <button class="pos-modal-close" id="mscClose" style="position:static">✕</button>
    </div>
    <div style="padding:12px 20px;border-bottom:1px solid var(--cream-dark,#E7DFD5);display:flex;gap:8px;flex-wrap:wrap" id="mscFilters">
      <button class="pos-btn pos-btn-sm pos-btn-primary" data-msc-loc="ALL">All</button>
      <button class="pos-btn pos-btn-sm" data-msc-loc="FRIDGE">🧊 Fridge</button>
      <button class="pos-btn pos-btn-sm" data-msc-loc="STOREROOM">🗄️ Storeroom</button>
    </div>
    <div id="mscBody" style="flex:1;overflow-y:auto;padding:12px 20px">
      <div class="loading">Loading ingredients…</div>
    </div>
    <div style="padding:14px 20px;border-top:1px solid var(--cream-dark,#E7DFD5);display:flex;justify-content:space-between;align-items:center;gap:12px">
      <span id="mscHint" style="font-size:.8rem;color:var(--text-light,#7A6355)"></span>
      <button class="pos-btn pos-btn-primary pos-btn-lg" id="mscSave" disabled>Save Stock Count</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#mscClose').onclick = ()=> modal.remove();
  modal.onclick = e => { if(e.target === modal) modal.remove(); };

  let ingredients = [];
  let filter = 'ALL';
  // Working values, keyed by ingredientId. Populated from currentStock on
  // load; +/- and direct entry mutate this map only. Save reads it back.
  const workingCounts = {};
  // Track which ids have been touched, so hint can show diff count.
  const dirty = new Set();

  try {
    const data = await api('GET','/api/pos/ingredients');
    ingredients = data.ingredients || [];
    for (const ing of ingredients) workingCounts[ing.ingredientId] = ing.currentStock;
  } catch (e) {
    modal.querySelector('#mscBody').innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger,#B00020)">Failed to load ingredients</div>';
    return;
  }

  function stepFor(unit){
    // Fractional units (bottles, liters) get 0.5 step; discrete/gram units get 1.
    const u = (unit || '').toLowerCase();
    if (u === 'bottle' || u === 'bottles' || u === 'l' || u === 'liter' || u === 'liters') return 0.5;
    return 1;
  }

  function render(){
    const body = modal.querySelector('#mscBody');
    // Items marked BOTH appear under either Fridge or Storeroom filter (and ALL).
    const filtered = filter === 'ALL'
      ? ingredients
      : ingredients.filter(i => {
          const loc = i.storageLocation || '';
          return loc === filter || loc === 'BOTH';
        });
    if (!filtered.length){
      body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-light,#7A6355)">No ingredients in this location</div>';
      updateSaveState();
      return;
    }
    body.innerHTML = filtered.map(ing => {
      const val = workingCounts[ing.ingredientId];
      const step = stepFor(ing.unit);
      const isDirty = dirty.has(ing.ingredientId);
      const last = ing.lastCountedAt ? `<div style="font-size:.7rem;color:var(--text-light,#7A6355);margin-top:2px">Last: ${new Date(ing.lastCountedAt).toLocaleString()}${ing.lastCountedBy?' by '+escapeHtmlPos(ing.lastCountedBy):''}</div>` : '';
      return `<div class="msc-row" data-id="${escapeHtmlPos(ing.ingredientId)}" style="padding:12px 0;border-bottom:1px solid #f0ebe4;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center">
        <div style="min-width:0">
          <div style="font-weight:600;color:${isDirty?'var(--primary,#6B4226)':'inherit'}">${escapeHtmlPos(ing.name)} ${isDirty?'<span style="font-size:.7rem;color:var(--primary,#6B4226)">•edited</span>':''}</div>
          <div style="font-size:.75rem;color:var(--text-light,#7A6355)">${escapeHtmlPos(ing.storageLocation||'—')}</div>
          ${last}
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button class="pos-btn pos-btn-sm msc-dec" data-step="${step}" aria-label="Decrease">−</button>
          <input class="pos-input msc-input" type="number" inputmode="decimal" step="${step}" min="0" value="${val}" style="width:80px;text-align:center;margin:0" aria-label="${escapeHtmlPos(ing.name)} count">
          <button class="pos-btn pos-btn-sm msc-inc" data-step="${step}" aria-label="Increase">+</button>
          <span style="font-size:.8rem;color:var(--text-light,#7A6355);min-width:52px">${escapeHtmlPos(ing.unit||'')}</span>
        </div>
      </div>`;
    }).join('');

    // Wire up controls
    body.querySelectorAll('.msc-row').forEach(row => {
      const id = row.dataset.id;
      const input = row.querySelector('.msc-input');
      const dec = row.querySelector('.msc-dec');
      const inc = row.querySelector('.msc-inc');

      function commit(newVal){
        const n = Math.max(0, Number(newVal));
        if (!isFinite(n)) return;
        // Round to 2dp to avoid float drift (e.g., 0.1+0.2)
        workingCounts[id] = Math.round(n * 100) / 100;
        input.value = workingCounts[id];
        // Original = the loaded currentStock for that ingredient
        const original = ingredients.find(i => i.ingredientId === id)?.currentStock;
        if (workingCounts[id] !== original) dirty.add(id); else dirty.delete(id);
        // Update the "•edited" marker without a full re-render
        const marker = row.querySelector('span[style*="•edited"]');
        const title = row.querySelector('div[style^="font-weight"]');
        if (title){
          const isD = dirty.has(id);
          title.style.color = isD ? 'var(--primary,#6B4226)' : 'inherit';
          title.innerHTML = escapeHtmlPos(ingredients.find(i => i.ingredientId === id)?.name || '') +
            (isD ? ' <span style="font-size:.7rem;color:var(--primary,#6B4226)">•edited</span>' : '');
        }
        void marker; // (no-op — marker refreshed via innerHTML above)
        updateSaveState();
      }

      dec.onclick = ()=> commit(workingCounts[id] - Number(dec.dataset.step || 1));
      inc.onclick = ()=> commit(workingCounts[id] + Number(inc.dataset.step || 1));
      input.oninput = ()=> commit(input.value);
    });
    updateSaveState();
  }

  function updateSaveState(){
    const btn = modal.querySelector('#mscSave');
    const hint = modal.querySelector('#mscHint');
    if (dirty.size === 0){
      btn.disabled = false; // still allow save-all if user just wants to log a snapshot
      btn.textContent = 'Save Stock Count';
      hint.textContent = 'No changes yet';
    } else {
      btn.disabled = false;
      btn.textContent = `Save Stock Count (${dirty.size} changed)`;
      hint.textContent = `${dirty.size} item${dirty.size===1?'':'s'} changed`;
    }
  }

  // Filter buttons
  modal.querySelectorAll('[data-msc-loc]').forEach(btn => {
    btn.onclick = ()=>{
      filter = btn.dataset.mscLoc;
      modal.querySelectorAll('[data-msc-loc]').forEach(b => b.classList.toggle('pos-btn-primary', b.dataset.mscLoc === filter));
      render();
    };
  });

  modal.querySelector('#mscSave').onclick = async ()=>{
    const btn = modal.querySelector('#mscSave');
    // Send ALL counts (simpler, backend overwrites). Snapshot captures the
    // full picture at this point in time, which is what admin history needs.
    const counts = ingredients.map(i => ({ ingredientId: i.ingredientId, count: workingCounts[i.ingredientId] }));
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const result = await api('PUT','/api/pos/ingredients/bulk-update', { counts });
      showSuccessToast(`Stock count saved (${result.updated || counts.length} items)`);
      modal.remove();
    } catch (e){
      btn.disabled = false;
      btn.textContent = 'Save Stock Count';
      showError('Failed to save stock count');
    }
  };

  render();
}

// --- Planogram Stock Count ---
async function openStockCount(location){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:560px">
    <button class="pos-modal-close">✕</button>
    <h3>📷 Stock Count — ${location === 'fridge' ? 'Fridge' : 'Storeroom'}</h3>
    <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:8px 0 16px">Take 1-3 photos. AI will count your stock.</p>
    <div id="stockPhotos" class="stock-photos"></div>
    <div style="display:flex;gap:10px;margin:16px 0">
      <label class="pos-btn pos-btn-primary" for="stockCameraInput" style="flex:1;text-align:center;cursor:pointer">📷 Take Photo</label>
      <input type="file" id="stockCameraInput" accept="image/*" capture="environment" style="display:none" multiple>
    </div>
    <button id="stockAnalyze" class="pos-btn pos-btn-primary pos-btn-lg" disabled style="width:100%">Analyze Stock</button>
    <div id="stockResults"></div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

  let photos = [];

  modal.querySelector('#stockCameraInput').onchange = (e)=>{
    const files = Array.from(e.target.files);
    files.forEach(file=>{
      const reader = new FileReader();
      reader.onload = ()=>{
        photos.push(reader.result);
        renderPhotos();
      };
      reader.readAsDataURL(file);
    });
  };

  function renderPhotos(){
    const container = modal.querySelector('#stockPhotos');
    container.innerHTML = photos.map((p,i)=>`<div class="stock-photo-thumb">
      <img src="${p}" alt="Photo ${i+1}">
      <button data-remove-photo="${i}">✕</button>
    </div>`).join('') || '<p style="color:var(--text-light,#7A6355);text-align:center">No photos yet</p>';
    container.querySelectorAll('[data-remove-photo]').forEach(btn=>btn.onclick=()=>{
      photos.splice(+btn.dataset.removePhoto, 1);
      renderPhotos();
    });
    modal.querySelector('#stockAnalyze').disabled = photos.length === 0;
  }

  modal.querySelector('#stockAnalyze').onclick = async()=>{
    const btn = modal.querySelector('#stockAnalyze');
    const resultsEl = modal.querySelector('#stockResults');
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    resultsEl.innerHTML = '<p style="text-align:center;color:var(--primary,#6B4226)">🤖 AI is counting your stock...</p>';

    try{
      const data = await api('POST','/api/pos/planogram/analyze',{ location, images: photos });
      const counts = data.counts || [];
      const ingredients = data.ingredients || [];
      const logId = data.logId || null;

      let html = '<div class="stock-results-list"><h4 style="margin:16px 0 12px;color:var(--primary,#6B4226)">Results — adjust if needed</h4>';
      counts.forEach((item,i)=>{
        const match = ingredients.find(ing=>ing.name.toLowerCase().includes(item.name.toLowerCase()));
        const confidence = item.confidence === 'high' ? '🟢' : item.confidence === 'medium' ? '🟡' : '🔴';
        html += `<div class="stock-result-row">
          <span class="stock-result-name">${confidence} ${item.name}</span>
          <input type="number" step="0.1" class="stock-result-input" value="${item.count}" data-idx="${i}" data-ing-id="${match?.ingredientId||''}">
          ${item.notes ? `<span class="stock-result-note">${item.notes}</span>` : ''}
        </div>`;
      });
      html += `<button id="stockConfirm" class="pos-btn pos-btn-primary pos-btn-lg" style="width:100%;margin-top:16px">✓ Confirm & Save</button></div>`;
      resultsEl.innerHTML = html;
      btn.textContent = 'Re-analyze';
      btn.disabled = false;

      resultsEl.querySelector('#stockConfirm').onclick = async()=>{
        const inputs = resultsEl.querySelectorAll('.stock-result-input');
        const updates = [];
        inputs.forEach(inp=>{
          if(inp.dataset.ingId) updates.push({ ingredientId: inp.dataset.ingId, count: +inp.value });
        });
        try{
          await api('POST','/api/pos/planogram/confirm',{ counts: updates, logId });
          showError(''); // clear any error
          modal.querySelector('.pos-modal').innerHTML = `<div style="text-align:center;padding:40px"><div style="font-size:2rem;margin-bottom:12px">✅</div><h3 style="color:var(--primary,#6B4226)">Stock Updated!</h3><p style="color:var(--text-light,#7A6355);margin-top:8px">${updates.length} items saved</p><button class="pos-btn pos-btn-primary" id="stockDone" style="margin-top:20px">Done</button></div>`;
          modal.querySelector('#stockDone').onclick=()=>modal.remove();
        } catch(e){ showError('Failed to save stock'); }
      };
    } catch(e){
      resultsEl.innerHTML = `<p style="color:var(--danger,#C0392B);text-align:center">Failed to analyze. Please try again.</p>`;
      btn.textContent = 'Retry Analysis';
      btn.disabled = false;
    }
  };

  renderPhotos();
}

// --- Voucher redemption (cashier-driven) ---
//
// Single re-rendering modal that walks the cashier through three steps:
//   1. phone entry
//   2. voucher list (eligible + past) for that phone
//   3. menu picker (filtered to drinks or food per voucher type) + variant picker
//
// All UI state is local to the modal — closing it cleanly resets everything.
function openVoucherFlow(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  document.body.appendChild(modal);

  const state = {
    step: 'phone',     // 'phone' | 'list' | 'pick' | 'summary'
    rawPhone: '',
    phone: '',
    customerName: '',
    eligible: [],
    past: [],
    selectedVoucher: null,
    allMenuItems: [],  // full menu fetched once when a voucher is chosen
    // For single-item vouchers: slots=[{category:'DRINK'|'FOOD',label}], picks length 1.
    // For FREE_COMBO: slots=[{category:'DRINK',label:'drink'},{category:'FOOD',label:'food'}].
    slots: [],
    picks: [],         // parallel to slots — { menuItem, selectedVariants } | null
    pickIndex: 0,
  };

  modal.onclick = e => { if(e.target === modal) modal.remove(); };

  function setStep(step){ state.step = step; render(); }

  function render(){
    if(state.step === 'phone')   return renderPhone();
    if(state.step === 'list')    return renderList();
    if(state.step === 'pick')    return renderPick();
    if(state.step === 'summary') return renderSummary();
  }

  // ── Step 1: phone entry ──────────────────────────────────────────
  function renderPhone(){
    modal.innerHTML = `<div class="pos-modal" style="max-width:420px">
      <button class="pos-modal-close">✕</button>
      <h3>🎟️ Redeem Voucher</h3>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:8px 0 14px">
        Enter the customer's phone number to look up their vouchers.
      </p>
      <input id="vfPhone" type="tel" inputmode="tel" autocomplete="off"
             class="pos-input" placeholder="0168089999"
             value="${state.rawPhone}" style="margin-bottom:12px">
      <button id="vfLookup" class="pos-btn pos-btn-primary pos-btn-lg" style="width:100%">Look up</button>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    const phoneInput = modal.querySelector('#vfPhone');
    phoneInput.focus();
    phoneInput.select();

    const submit = async ()=>{
      const raw = phoneInput.value.trim();
      if(!raw){ showError('Phone number required'); return; }
      const normalized = (typeof window.normalizePhone === 'function')
        ? window.normalizePhone(raw)
        : raw.replace(/[^0-9]/g, '');
      if(!normalized){ showError('Invalid phone number'); return; }
      state.rawPhone = raw;
      state.phone = normalized;
      await lookupVouchers();
    };

    modal.querySelector('#vfLookup').onclick = submit;
    phoneInput.onkeydown = (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); submit(); } };
  }

  async function lookupVouchers(){
    modal.innerHTML = `<div class="pos-modal" style="max-width:420px;text-align:center">
      <p style="margin:24px 0;color:var(--text-light,#7A6355)">Looking up vouchers…</p>
    </div>`;
    try{
      const data = await api('GET', `/api/pos/vouchers/${encodeURIComponent(state.phone)}`);
      state.eligible = data.eligible || [];
      state.past = data.past || [];
      state.customerName = (state.eligible[0]?.name) || (state.past[0]?.name) || '';
      setStep('list');
    } catch(e){
      showError('Failed to look up vouchers');
      setStep('phone');
    }
  }

  // ── Step 2: voucher list ─────────────────────────────────────────
  function renderList(){
    const eligibleHtml = state.eligible.length
      ? state.eligible.map(v => voucherCardHtml(v, true)).join('')
      : '<p style="text-align:center;color:var(--text-light,#7A6355);padding:16px 0;font-size:.9rem">No eligible vouchers.</p>';

    const pastHtml = state.past.length
      ? `<h4 style="margin:20px 0 8px;color:var(--text-light,#7A6355);font-size:.9rem">Past (${state.past.length})</h4>` +
        state.past.map(v => voucherCardHtml(v, false)).join('')
      : '';

    const headline = state.customerName
      ? `${state.phone} · ${escapeHtmlPos(state.customerName)}`
      : state.phone;

    modal.innerHTML = `<div class="pos-modal" style="max-width:520px;max-height:85vh;overflow-y:auto">
      <button class="pos-modal-close">✕</button>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <button class="pos-btn pos-btn-sm pos-btn-outline" id="vfBack">← Back</button>
        <h3 style="margin:0;flex:1">${headline}</h3>
      </div>
      ${state.eligible.length === 0 && state.past.length === 0
        ? '<p style="text-align:center;color:var(--text-light,#7A6355);padding:32px 0">No vouchers found for this number.</p>'
        : `<h4 style="margin:12px 0 8px;font-size:.9rem">Available (${state.eligible.length})</h4>${eligibleHtml}${pastHtml}`}
    </div>`;

    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    modal.querySelector('#vfBack').onclick = ()=> setStep('phone');

    modal.querySelectorAll('[data-redeem-id]').forEach(btn => {
      btn.onclick = ()=>{
        const v = state.eligible.find(x => x.voucherId === btn.dataset.redeemId);
        if(!v) return;
        state.selectedVoucher = v;
        // Build the pick slots based on voucher type.
        if(v.voucherType === 'FREE_COMBO'){
          state.slots = [
            { category: 'DRINK', label: 'drink' },
            { category: 'FOOD',  label: 'food'  },
          ];
        } else if(v.voucherType === 'FREE_FOOD'){
          state.slots = [{ category: 'FOOD', label: 'food' }];
        } else {
          state.slots = [{ category: 'DRINK', label: 'drink' }];
        }
        state.picks = state.slots.map(()=> null);
        state.pickIndex = 0;
        loadMenuForVoucher();
      };
    });
  }

  function voucherCardHtml(v, isEligible){
    let typeBadge;
    if(v.voucherType === 'FREE_DRINK'){
      typeBadge = '<span class="pos-card-tag" style="background:#3B82F6;color:#fff">🥤 FREE DRINK</span>';
    } else if(v.voucherType === 'FREE_FOOD'){
      typeBadge = '<span class="pos-card-tag" style="background:#F59E0B;color:#fff">🍪 FREE FOOD</span>';
    } else {
      typeBadge = '<span class="pos-card-tag" style="background:#7C3AED;color:#fff">🥤🍪 FREE COMBO</span>';
    }

    const opacity = isEligible ? '1' : '.55';
    const cursor  = isEligible ? 'default' : 'default';

    let bottom = '';
    if(isEligible){
      const expiresAt = v.expiresAt ? new Date(v.expiresAt) : null;
      const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / (24*60*60*1000)) : null;
      const expiryText = expiresAt
        ? (daysLeft <= 0 ? 'Expires today' :
           daysLeft === 1 ? 'Expires tomorrow' :
           `Expires in ${daysLeft} days (${expiresAt.toLocaleDateString()})`)
        : '';
      bottom = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
        <span style="font-size:.8rem;color:var(--text-light,#7A6355)">${expiryText}</span>
        <button class="pos-btn pos-btn-primary pos-btn-sm" data-redeem-id="${v.voucherId}">Use →</button>
      </div>`;
    } else {
      const display = v.displayStatus || v.status;
      let detail = '';
      if(display === 'REDEEMED'){
        const when = v.redeemedAt ? new Date(v.redeemedAt).toLocaleDateString() : '';
        const what = v.menuItemName ? `${escapeHtmlPos(v.menuItemName)}${v.variant ? ' ('+escapeHtmlPos(v.variant)+')' : ''}` : '';
        detail = `Redeemed ${when}${what ? ' · '+what : ''}`;
      } else if(display === 'EXPIRED'){
        const when = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : '';
        detail = `Expired ${when}`;
      }
      bottom = `<div style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:6px">${detail}</div>`;
    }

    return `<div class="pos-card" style="opacity:${opacity};cursor:${cursor};margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${typeBadge}<strong>${escapeHtmlPos(v.campaignName || 'Voucher')}</strong></div>
      ${v.note ? '<div style="font-size:.8rem;color:var(--text-light,#7A6355)">'+escapeHtmlPos(v.note)+'</div>' : ''}
      ${bottom}
    </div>`;
  }

  // ── Step 3: item picker ──────────────────────────────────────────
  async function loadMenuForVoucher(){
    modal.innerHTML = `<div class="pos-modal" style="max-width:420px;text-align:center">
      <p style="margin:24px 0;color:var(--text-light,#7A6355)">Loading menu…</p>
    </div>`;
    try{
      const data = await api('GET', '/api/menu');
      const all = Array.isArray(data) ? data : (data.items || []);
      state.allMenuItems = all
        .filter(m => m.isActive !== false && m.isEnabledToday !== false)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || ''));
      setStep('pick');
    } catch(e){
      showError('Failed to load menu');
      setStep('list');
    }
  }

  function renderPick(){
    const v = state.selectedVoucher;
    const isCombo = v.voucherType === 'FREE_COMBO';
    const slot = state.slots[state.pickIndex];
    const pick = state.picks[state.pickIndex]; // current pick (may be null)
    const isLastSlot = state.pickIndex === state.slots.length - 1;

    // Heading + step indicator (only meaningful for combo).
    let typeLabel;
    if(v.voucherType === 'FREE_DRINK')      typeLabel = '🥤 FREE DRINK';
    else if(v.voucherType === 'FREE_FOOD')  typeLabel = '🍪 FREE FOOD';
    else                                    typeLabel = '🥤🍪 FREE COMBO';
    const stepLabel = isCombo
      ? `<span style="color:var(--text-light,#7A6355);font-size:.85rem;margin-left:8px">Step ${state.pickIndex + 1} of ${state.slots.length}: pick a ${slot.label}</span>`
      : '';

    const filtered = state.allMenuItems.filter(m => m.category === slot.category);
    const itemsHtml = filtered.length
      ? filtered.map(m => {
          const id = m.menuItemId || m.id;
          const isSelected = pick && (pick.menuItem.menuItemId || pick.menuItem.id) === id;
          const price = m.basePrice || 0;
          return `<div class="pos-card" data-pick-id="${id}" style="cursor:pointer;margin-bottom:6px;${isSelected ? 'border:2px solid var(--primary,#6B4226)' : ''}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong>${escapeHtmlPos(m.name)}</strong>
              <span style="color:var(--text-light,#7A6355);font-size:.85rem">RM ${price.toFixed(2)}</span>
            </div>
          </div>`;
        }).join('')
      : '<p style="text-align:center;color:var(--text-light,#7A6355);padding:24px 0">No items available.</p>';

    let variantHtml = '';
    if(pick){
      const m = pick.menuItem;
      const hasVariants = (m.variantGroups && m.variantGroups.length) || (m.variants && m.variants.length);
      if(hasVariants){
        variantHtml = `<div style="margin-top:12px;padding:12px;background:var(--cream-lighter,#FAF6F0);border-radius:var(--radius,8px)">
          <div style="font-size:.85rem;font-weight:600;margin-bottom:6px">Pick options</div>
          <div id="vfVariantHost"></div>
        </div>`;
      }
    }

    // Header back-button: combo step 2+ goes to step 1; otherwise back to list.
    const backLabel = (isCombo && state.pickIndex > 0) ? '← Back' : '← Vouchers';
    // Primary button label: last slot in combo says "Review →"; single-item says "Confirm Redemption".
    const primaryLabel = isCombo
      ? (isLastSlot ? 'Review →' : 'Next →')
      : 'Confirm Redemption';
    const primaryClass = (isCombo && !isLastSlot) ? 'pos-btn pos-btn-outline pos-btn-lg' : 'pos-btn pos-btn-primary pos-btn-lg';

    modal.innerHTML = `<div class="pos-modal" style="max-width:520px;max-height:85vh;overflow-y:auto">
      <button class="pos-modal-close">✕</button>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <button class="pos-btn pos-btn-sm pos-btn-outline" id="vfBackList">${backLabel}</button>
        <h3 style="margin:0;flex:1">${typeLabel}${stepLabel}</h3>
      </div>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:4px 0 12px">
        ${escapeHtmlPos(v.campaignName || '')} · ${state.phone}${state.customerName ? ' · '+escapeHtmlPos(state.customerName) : ''}
      </p>
      <div style="max-height:45vh;overflow-y:auto;margin-bottom:12px">${itemsHtml}</div>
      ${variantHtml}
      <div style="margin-top:14px;display:flex;gap:8px">
        <button class="${primaryClass}" id="vfConfirm" style="flex:1" ${pick ? '' : 'disabled'}>
          ${primaryLabel}
        </button>
      </div>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    modal.querySelector('#vfBackList').onclick = ()=>{
      if(isCombo && state.pickIndex > 0){
        state.pickIndex -= 1;
        setStep('pick');
      } else {
        setStep('list');
      }
    };

    modal.querySelectorAll('[data-pick-id]').forEach(card => {
      card.onclick = ()=>{
        const id = card.dataset.pickId;
        const m = state.allMenuItems.find(item => (item.menuItemId || item.id) === id) || null;
        if(!m) return;
        state.picks[state.pickIndex] = { menuItem: m, selectedVariants: [] };
        renderPick(); // re-render to show variants + enable next/confirm
      };
    });

    // Wire variant picker via the shared module if present.
    const variantHost = modal.querySelector('#vfVariantHost');
    if(variantHost && pick && window.RLCVariants){
      window.RLCVariants.renderVariantPicker(pick.menuItem, variantHost, (selected)=>{
        // Mutate the pick in place — same object referenced from state.picks.
        pick.selectedVariants = selected || [];
      });
    }

    modal.querySelector('#vfConfirm').onclick = ()=>{
      if(!pick) return;
      // Validate single-select variant groups have an option chosen.
      const m = pick.menuItem;
      if(m.variantGroups && m.variantGroups.length){
        const required = m.variantGroups.filter(g => g.type === 'single').map(g => g.group);
        const chosen = new Set((pick.selectedVariants || []).map(sv => sv.group));
        for(const g of required){
          if(!chosen.has(g)){ showError(`Pick a ${g} option`); return; }
        }
      }

      if(isCombo && !isLastSlot){
        state.pickIndex += 1;
        setStep('pick');
      } else if(isCombo && isLastSlot){
        setStep('summary');
      } else {
        confirmRedeem();
      }
    };
  }

  // ── Step 4: combo summary (combo only) ───────────────────────────
  function renderSummary(){
    const v = state.selectedVoucher;
    const rows = state.picks.map((p, i) => {
      const m = p.menuItem;
      const price = m.basePrice + (p.selectedVariants || []).reduce((s, sv) => s + (sv.price || 0), 0);
      const vlabel = (p.selectedVariants || []).map(sv => sv.option).filter(Boolean).join(', ');
      return `<div class="pos-card" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:.75rem;color:var(--text-light,#7A6355);text-transform:uppercase;letter-spacing:.05em">${escapeHtmlPos(state.slots[i].label)}</div>
            <strong>${escapeHtmlPos(m.name)}</strong>
            ${vlabel ? '<div style="font-size:.85rem;color:var(--text-light,#7A6355)">'+escapeHtmlPos(vlabel)+'</div>' : ''}
          </div>
          <span style="color:var(--text-light,#7A6355);font-size:.85rem;text-decoration:line-through">RM ${price.toFixed(2)}</span>
        </div>
      </div>`;
    }).join('');

    const total = state.picks.reduce((s, p) => {
      return s + (p.menuItem.basePrice || 0) + (p.selectedVariants || []).reduce((a, sv) => a + (sv.price || 0), 0);
    }, 0);

    modal.innerHTML = `<div class="pos-modal" style="max-width:520px;max-height:85vh;overflow-y:auto">
      <button class="pos-modal-close">✕</button>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <button class="pos-btn pos-btn-sm pos-btn-outline" id="vfBackPick">← Back</button>
        <h3 style="margin:0;flex:1">🥤🍪 Review Redemption</h3>
      </div>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:4px 0 12px">
        ${escapeHtmlPos(v.campaignName || '')} · ${state.phone}${state.customerName ? ' · '+escapeHtmlPos(state.customerName) : ''}
      </p>
      ${rows}
      <div style="text-align:right;margin:12px 0;font-size:.95rem">
        Total value: <strong>RM ${total.toFixed(2)}</strong> — voucher covers everything
      </div>
      <button class="pos-btn pos-btn-primary pos-btn-lg" id="vfConfirm" style="width:100%">Confirm Redemption</button>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    modal.querySelector('#vfBackPick').onclick = ()=>{
      state.pickIndex = state.slots.length - 1;
      setStep('pick');
    };
    modal.querySelector('#vfConfirm').onclick = confirmRedeem;
  }

  // ── Confirm + redeem ─────────────────────────────────────────────
  async function confirmRedeem(){
    if(!state.selectedVoucher) return;
    if(state.picks.some(p => !p)) return;

    const btn = modal.querySelector('#vfConfirm');
    if(btn){ btn.disabled = true; btn.textContent = 'Redeeming…'; }

    try{
      await api('POST', '/api/pos/vouchers/redeem', {
        voucherId: state.selectedVoucher.voucherId,
        phone: state.phone,
        customerName: state.customerName || state.selectedVoucher.name || '',
        items: state.picks.map(p => ({
          menuItemId: p.menuItem.menuItemId || p.menuItem.id,
          selectedVariants: p.selectedVariants || [],
        })),
      });
      modal.remove();
      try{ playReadySound(); } catch(e){}
      showSuccessToast('Voucher redeemed — order created');
      try{ fetchOrders(); } catch(e){}
    } catch(e){
      const msg = String(e && e.message || '');
      if(msg.includes('already redeemed') || msg.includes('expired')){
        showError('Voucher is no longer valid');
        await lookupVouchers();
      } else {
        showError('Redemption failed');
        if(btn){ btn.disabled = false; btn.textContent = 'Confirm Redemption'; }
      }
    }
  }

  render();
}

// Reuse the existing toast host pattern but with a success palette.
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

// --- Init ---
token ? renderMain() : renderLogin();
})();
