(function(){
const $ = s => document.querySelector(s);
const app = $('#app');
let token = sessionStorage.getItem('pos_token');
let currentUser = sessionStorage.getItem('pos_user') || '';
let orders = [];
let prevOrderCount = 0;
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
      renderMain();
    } catch(e){ showError('Invalid PIN'); }
  };
}

function logout(){ token=null; currentUser=''; sessionStorage.removeItem('pos_token'); sessionStorage.removeItem('pos_user'); renderLogin(); }

// --- Main view ---
function renderMain(){
  app.innerHTML = `<div class="pos-topbar">
    <span class="pos-user">👤 ${currentUser} <span class="pos-status-dot ${cafeOpen?'open':'closed'}"></span></span>
    <button id="btnCafeToggle" class="pos-btn pos-btn-sm">${cafeOpen?'Close Café':'Open Café'}</button>
    <button id="btnCelebration" class="pos-btn pos-btn-sm ${celebrationMode?'active':''}">🎉 Celebration</button>
    <button id="btnWalkup" class="pos-btn pos-btn-sm pos-btn-primary">+ Walk-up</button>
    <button id="btnMenu" class="pos-btn pos-btn-sm">Menu</button>
    <button id="btnPrep" class="pos-btn pos-btn-sm">Prep</button>
    <a href="admin" class="pos-btn pos-btn-sm" style="text-decoration:none">Admin</a>
    <button id="btnLogout" class="pos-btn pos-btn-sm pos-btn-danger">Logout</button>
  </div>
  <div id="posStats" class="pos-stats-bar"></div>
  <div class="pos-controls">
    <input id="orderSearch" class="pos-input pos-search" placeholder="Search customer...">
    <button id="btnHistory" class="pos-btn pos-btn-sm">History</button>
    <button id="btnView" class="pos-btn pos-btn-sm">${viewMode==='kanban'?'List View':'Kanban View'}</button>
    <span id="lastRefresh" class="pos-last-refresh"></span>
  </div>
  <div id="orderBoard" class="pos-board"></div>`;
  $('#btnCafeToggle').onclick = toggleCafe;
  $('#btnCelebration').onclick = async()=>{
    try{
      celebrationMode=!celebrationMode;
      await api('PUT','/api/pos/cafe/celebration',{enabled:celebrationMode});
      renderMain();
    } catch(e){ celebrationMode=!celebrationMode; showError('Failed to toggle celebration'); }
  };
  $('#btnWalkup').onclick = openWalkup;
  $('#btnMenu').onclick = openMenuToggle;
  $('#btnPrep').onclick = openPrepView;
  $('#btnLogout').onclick = logout;
  $('#btnHistory').onclick = openHistory;
  $('#btnView').onclick = ()=>{ viewMode = viewMode==='kanban'?'list':'kanban'; renderBoard(); $('#btnView').textContent = viewMode==='kanban'?'List View':'Kanban View'; };
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
    if(toggle) toggle.textContent = cafeOpen ? 'Close Café' : 'Open Café';
    if(celeb) celeb.classList.toggle('active', celebrationMode);
  } catch(e){}
}

function startPolling(){ stopPolling(); pollTimer = setInterval(fetchOrders, 7000); }
function stopPolling(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }

let prevReceiptCount = 0;

async function fetchOrders(){
  try{
    const data = await api('GET','/api/pos/orders');
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
    orders = list;
    renderBoard();
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
  const revenue = orders.reduce((s,o)=>s+(o.total||o.totalAmount||0),0);
  const drinkItems = orders.filter(o=>o.status==='PREPARING'||o.status==='PENDING').reduce((s,o)=>s+(o.items||[]).filter(i=>i.category==='DRINK').reduce((ss,i)=>ss+(i.quantity||i.qty||1),0),0);
  const statsEl = $('#posStats');
  if(statsEl) statsEl.innerHTML = `<div class="pos-stat"><span class="pos-stat-num">${pending}</span><span class="pos-stat-lbl">Pending</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${preparing}</span><span class="pos-stat-lbl">Making</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${ready}</span><span class="pos-stat-lbl">Ready</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${total}</span><span class="pos-stat-lbl">Total</span></div>
    <div class="pos-stat"><span class="pos-stat-num">RM${revenue.toFixed(0)}</span><span class="pos-stat-lbl">Revenue</span></div>
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

function cardHtml(o){
  const items = (o.items||[]).map(i=>`${i.quantity||i.qty||1}x ${i.name}${i.variant?' ('+i.variant+')':''}`).join(', ');
  const mins = Math.floor((Date.now()-new Date(o.createdAt))/60000);
  const urgent = mins > 10 && o.status === 'PENDING';
  const hasReceipt = !!o.receiptUrl;
  let quickAction = '';
  if(o.status==='PENDING') quickAction = `<div class="pos-card-actions"><button class="pos-btn pos-btn-sm pos-btn-primary pos-card-quick-approve" data-quick-id="${o.id||o.orderId}" onclick="event.stopPropagation()">✓ Approve</button></div>`;
  else if(o.status==='PREPARING') quickAction = `<div class="pos-card-actions"><button class="pos-btn pos-btn-sm pos-btn-primary pos-card-quick-ready" data-quick-id="${o.id||o.orderId}" onclick="event.stopPropagation()">✓ Ready</button></div>`;

  return `<div class="pos-card pos-card-${o.status.toLowerCase()} ${urgent?'pos-card-urgent':''} ${hasReceipt?'pos-card-receipt':''}" data-id="${o.id||o.orderId}" data-status="${o.status}">
    ${hasReceipt ? `<div class="pos-receipt-badge${Math.abs((o.receiptAmount||0)-(o.total||o.totalAmount||0))>0.01?' pos-receipt-mismatch':''}">💰 Receipt: RM${(o.receiptAmount||0).toFixed(2)}${Math.abs((o.receiptAmount||0)-(o.total||o.totalAmount||0))>0.01?' ⚠️ expected RM'+(o.total||o.totalAmount||0).toFixed(2):''}</div>` : ''}
    <div class="pos-card-name">${o.customerName||'Guest'}${o.isWalkUp?' <span class="pos-card-tag">walk-up</span>':''}</div>
    <div class="pos-card-items">${items||'—'}</div>
    ${o.notes ? '<div class="pos-card-note">📝 '+o.notes+'</div>' : ''}
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
  else if(o.status==='READY') actions=`<button class="pos-btn pos-btn-primary pos-btn-lg" id="btnCollected">✓ Collected</button>`;

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
    modal.querySelector('#btnApprove').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser}); modal.remove(); fetchOrders(); };
    modal.querySelector('#btnNewcomer').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser,discountType:'NEWCOMER'}); modal.remove(); fetchOrders(); };
    modal.querySelector('#btnReject').onclick=()=>showRejectDialog(id, modal);
  } else if(o.status==='PREPARING'){
    modal.querySelector('#btnReady').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/ready`); modal.remove(); playReadySound(); showNameFlash(o.customerName); fetchOrders(); };
    modal.querySelector('#btnUndo').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/undo`); modal.remove(); fetchOrders(); };
  } else if(o.status==='READY'){
    modal.querySelector('#btnCollected').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/archive`); modal.remove(); fetchOrders(); };
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
        const variants=(m.variants||[]).map(v=>`<button class="pos-variant-btn" data-mid="${m.menuItemId||m.id}" data-v="${v.name||v.id}" data-vp="${v.priceModifier||0}">${v.name||v}${v.priceModifier ? ' +'+v.priceModifier : ''}</button>`).join('');
        return `<div class="pos-walkup-item"><span>${m.name}${price ? ' - RM'+price.toFixed(2) : ''}</span>${variants}<button class="pos-add-btn" data-mid="${m.menuItemId||m.id}" data-mname="${m.name}" data-mp="${price}">+</button></div>`;
      }).join('') : '<div style="padding:16px;text-align:center;color:var(--text-light,#7A6355)">No items match</div>'}</div>
      <div class="pos-walkup-cart"><h4>Cart${cart.length ? ' — RM'+cartTotal.toFixed(2) : ''}</h4><ul>${cartHtml||'<li>Empty</li>'}</ul></div>
      <input id="wkNotes" class="pos-input" placeholder="Special requests (less sugar, extra hot)" style="margin-bottom:12px">
      <select id="wkDiscount" class="pos-input"><option value="">No Discount</option><option value="STAFF">Staff (RM5)</option><option value="PASTOR">Pastor (Free)</option><option value="NEWCOMER">Newcomer (Free)</option></select>
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
      const existing = cart.find(c=>c.menuItemId===b.dataset.mid && c.variant===b.dataset.v);
      if(existing){ existing.qty++; }
      else { cart.push({name:item.name, menuItemId:b.dataset.mid, price:variantPrice, qty:1, variant:b.dataset.v}); }
      cart._name=modal.querySelector('#wkName')?.value||'';
      renderWalkup();
    });
    modal.querySelectorAll('.pos-remove-item').forEach(b=>b.onclick=()=>{ cart.splice(+b.dataset.ri,1); cart._name=modal.querySelector('#wkName')?.value||''; renderWalkup(); });

    const submitBtn=modal.querySelector('#wkSubmit');
    if(submitBtn) submitBtn.onclick=async()=>{
      const name=modal.querySelector('#wkName').value||'Walk-up';
      const disc=modal.querySelector('#wkDiscount').value||undefined;
      const notes=modal.querySelector('#wkNotes')?.value||'';
      try{
        await api('POST','/api/pos/orders',{customerName:name, items:cart.map(c=>({menuItemId:c.menuItemId,name:c.name,variant:c.variant,qty:c.qty,price:c.price})), discountType:disc, notes});
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
  try{ const d=await api('GET','/api/menu'); menu=Array.isArray(d)?d:d.items||[]; } catch(e){ showError('Failed to load menu'); return; }
  const drinks = menu.filter(m=>m.category==='DRINK');
  const food = menu.filter(m=>m.category==='FOOD');
  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';

  function renderModal(){
    const allItems = [...drinks, ...food];
    modal.innerHTML=`<div class="pos-modal" style="max-width:600px">
      <button class="pos-modal-close">✕</button>
      <h3>Menu & Food Quantity</h3>
      <div style="margin-top:16px">
        <h4 style="margin-bottom:10px;color:var(--primary,#6B4226)">🥤 Drinks</h4>
        <div class="pos-menu-toggles">${drinks.map(m=>`<div class="pos-menu-toggle-row">
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
          return `<div class="pos-menu-toggle-row" style="flex-wrap:wrap;gap:8px">
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
      try{ await api('PUT',`/api/pos/menu/${cb.dataset.id}/toggle`); }
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
          return `<div class="pos-history-item">
            <div class="pos-history-header">
              <strong>${o.customerName||'Guest'}</strong>
              <span class="admin-card-badge ${statusClass}">${o.status}</span>
            </div>
            <div class="pos-history-details">${items}</div>
            <div class="pos-history-footer">
              <span>RM ${(o.total||o.totalAmount||0).toFixed(2)}</span>
              <span>${new Date(o.createdAt).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit'})}</span>
              <button class="pos-btn pos-btn-sm" data-reorder='${JSON.stringify({name:o.customerName,items:o.items})}'>Reorder</button>
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
    <a href="prep.html" target="_blank" style="font-size:.82rem;color:var(--primary,#6B4226);text-decoration:underline">Open full-screen barista view ↗</a>
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
          await api('POST','/api/pos/planogram/confirm',{ counts: updates });
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

// --- Keyboard shortcuts ---
document.addEventListener('keydown', e=>{
  if(!token) return;
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  if(e.key==='w'||e.key==='W'){ e.preventDefault(); openWalkup(); }
  if(e.key==='m'||e.key==='M'){ e.preventDefault(); openMenuToggle(); }
  if(e.key==='h'||e.key==='H'){ e.preventDefault(); openHistory(); }
  if(e.key==='p'||e.key==='P'){ e.preventDefault(); openPrepView(); }
  if(e.key==='s'||e.key==='S'){ e.preventDefault(); openStockCount('fridge'); }
  if(e.key==='/'){ e.preventDefault(); const s=$('#orderSearch'); if(s) s.focus(); }
});

// --- Init ---
token ? renderMain() : renderLogin();
})();
