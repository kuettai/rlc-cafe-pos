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
  app.innerHTML = `<div class="pos-login">
    <h2>Cashier Login</h2>
    <form id="loginForm">
      <input id="loginUser" placeholder="User ID / Name" required autocomplete="username" class="pos-input">
      <input id="loginPin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN (6 digits)" required class="pos-input">
      <button type="submit" class="pos-btn pos-btn-primary">Login</button>
    </form></div>`;
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
      renderMain();
    } catch(e){ showError('Invalid PIN'); }
  };
}

function logout(){ token=null; currentUser=''; sessionStorage.removeItem('pos_token'); sessionStorage.removeItem('pos_user'); renderLogin(); }

// --- Main view ---
function renderMain(){
  app.innerHTML = `<div class="pos-topbar">
    <span class="pos-user">👤 ${currentUser}</span>
    <button id="btnCafeToggle" class="pos-btn pos-btn-sm">${cafeOpen?'Close Café':'Open Café'}</button>
    <button id="btnCelebration" class="pos-btn pos-btn-sm ${celebrationMode?'active':''}">🎉 Celebration</button>
    <button id="btnWalkup" class="pos-btn pos-btn-sm pos-btn-primary">+ Walk-up</button>
    <button id="btnMenu" class="pos-btn pos-btn-sm">Menu</button>
    <button id="btnLogout" class="pos-btn pos-btn-sm pos-btn-danger">Logout</button>
  </div>
  <div class="pos-controls">
    <input id="orderSearch" class="pos-input pos-search" placeholder="Search customer...">
    <button id="btnView" class="pos-btn pos-btn-sm">${viewMode==='kanban'?'List View':'Kanban View'}</button>
  </div>
  <div id="orderBoard" class="pos-board"></div>`;
  $('#btnCafeToggle').onclick = toggleCafe;
  $('#btnCelebration').onclick = ()=>{ celebrationMode=!celebrationMode; renderMain(); };
  $('#btnWalkup').onclick = openWalkup;
  $('#btnMenu').onclick = openMenuToggle;
  $('#btnLogout').onclick = logout;
  $('#btnView').onclick = ()=>{ viewMode = viewMode==='kanban'?'list':'kanban'; renderBoard(); $('#btnView').textContent = viewMode==='kanban'?'List View':'Kanban View'; };
  $('#orderSearch').oninput = e=>{ searchFilter=e.target.value.toLowerCase(); renderBoard(); };
  fetchOrders();
  startPolling();
}

function startPolling(){ stopPolling(); pollTimer = setInterval(fetchOrders, 7000); }
function stopPolling(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }

async function fetchOrders(){
  try{
    const data = await api('GET','/api/pos/orders');
    const list = Array.isArray(data) ? data : data.orders || [];
    if(list.length > prevOrderCount && prevOrderCount > 0) flashNew();
    prevOrderCount = list.length;
    orders = list;
    renderBoard();
  } catch(e){ if(e.message!=='Unauthorized') showError('Failed to fetch orders'); }
}

function flashNew(){ document.body.classList.add('pos-flash'); setTimeout(()=>document.body.classList.remove('pos-flash'),600); }

function filtered(){ return searchFilter ? orders.filter(o=>(o.customerName||'').toLowerCase().includes(searchFilter)) : orders; }

function renderBoard(){
  const board = $('#orderBoard');
  if(!board) return;
  const list = filtered();
  if(viewMode==='kanban'){
    const pending = list.filter(o=>o.status==='PENDING').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    const preparing = list.filter(o=>o.status==='PREPARING');
    const ready = list.filter(o=>o.status==='READY');
    board.className = 'pos-board pos-kanban';
    board.innerHTML = `<div class="pos-col pos-col-pending"><h3>Pending (${pending.length})</h3>${pending.map(cardHtml).join('')}</div>
      <div class="pos-col pos-col-preparing"><h3>Preparing (${preparing.length})</h3>${preparing.map(cardHtml).join('')}</div>
      <div class="pos-col pos-col-ready"><h3>Ready (${ready.length})</h3>${ready.map(cardHtml).join('')}</div>`;
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
  const items = (o.items||[]).map(i=>`${i.quantity||i.qty}x ${i.name}${i.variant?' ('+i.variant+')':''}`).join(', ');
  return `<div class="pos-card pos-card-${o.status.toLowerCase()}" data-id="${o.id||o.orderId}">
    <div class="pos-card-name">${o.customerName||'Guest'}</div>
    <div class="pos-card-items">${items||'—'}</div>
    <div class="pos-card-footer"><span>RM ${(o.total||0).toFixed(2)}</span><span>${timeAgo(o.createdAt)}</span></div></div>`;
}

function bindCards(){ document.querySelectorAll('.pos-card').forEach(c=>c.onclick=()=>openDetail(c.dataset.id)); }

// --- Order Detail ---
function openDetail(id){
  const o = orders.find(x=>(x.id||x.orderId)===id);
  if(!o) return;
  const items = (o.items||[]).map(i=>`<li>${i.quantity||i.qty}x ${i.name}${i.variant?' ('+i.variant+')':''}</li>`).join('');
  let actions = '';
  if(o.status==='PENDING') actions=`<button class="pos-btn pos-btn-primary pos-btn-lg" id="btnApprove">✓ Approve</button>
    <button class="pos-btn pos-btn-lg" id="btnNewcomer" style="background:#8b5cf6;color:#fff">🎁 Newcomer</button>
    <button class="pos-btn pos-btn-danger pos-btn-lg" id="btnReject">✗ Reject</button>`;
  else if(o.status==='PREPARING') actions=`<button class="pos-btn pos-btn-primary pos-btn-lg" id="btnReady">✓ Ready</button>`;

  const modal = document.createElement('div');
  modal.className='pos-modal-overlay';
  modal.innerHTML=`<div class="pos-modal">
    <button class="pos-modal-close">✕</button>
    <h3>${o.customerName||'Guest'}</h3>
    <ul class="pos-detail-items">${items}</ul>
    <div class="pos-detail-total">Total: RM ${(o.total||0).toFixed(2)}</div>
    <div class="pos-detail-actions">${actions}</div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

  if(o.status==='PENDING'){
    modal.querySelector('#btnApprove').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser}); modal.remove(); fetchOrders(); };
    modal.querySelector('#btnNewcomer').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser,discountType:'NEWCOMER'}); modal.remove(); fetchOrders(); };
    modal.querySelector('#btnReject').onclick=()=>showRejectDialog(id, modal);
  } else if(o.status==='PREPARING'){
    modal.querySelector('#btnReady').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/ready`); modal.remove(); fetchOrders(); };
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

// --- Cafe toggle ---
async function toggleCafe(){
  try{
    cafeOpen=!cafeOpen;
    await api('PUT',`/api/pos/cafe/${cafeOpen?'open':'close'}`);
    renderMain();
  } catch(e){ cafeOpen=!cafeOpen; showError('Failed to toggle café'); }
}

// --- Walk-up Order ---
async function openWalkup(){
  let menu=[];
  try{ const d=await api('GET','/api/menu'); menu=Array.isArray(d)?d:d.items||[]; } catch(e){ showError('Failed to load menu'); return; }
  const cart=[];
  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';

  function renderWalkup(){
    const cartHtml=cart.map((c,i)=>`<li>${c.qty}x ${c.name}${c.variant?' ('+c.variant+')':''} <button data-ri="${i}" class="pos-remove-item">✕</button></li>`).join('');
    modal.innerHTML=`<div class="pos-modal pos-modal-walkup">
      <button class="pos-modal-close">✕</button>
      <h3>Walk-up Order</h3>
      <input id="wkName" class="pos-input" placeholder="Customer name" value="${cart._name||''}">
      <div class="pos-walkup-menu">${menu.filter(m=>m.available!==false).map(m=>{
        const variants=(m.variants||[]).map(v=>`<button class="pos-variant-btn" data-mid="${m.id||m.name}" data-v="${v.name||v}">${v.name||v}</button>`).join('');
        return `<div class="pos-walkup-item"><span>${m.name} - RM${(m.price||0).toFixed(2)}</span>${variants}<button class="pos-add-btn" data-mid="${m.id||m.name}" data-mname="${m.name}" data-mp="${m.price||0}">+</button></div>`;
      }).join('')}</div>
      <div class="pos-walkup-cart"><h4>Cart</h4><ul>${cartHtml||'<li>Empty</li>'}</ul></div>
      <select id="wkDiscount" class="pos-input"><option value="">No Discount</option><option value="STAFF">Staff (RM5)</option><option value="PASTOR">Pastor (Free)</option></select>
      <button id="wkSubmit" class="pos-btn pos-btn-primary pos-btn-lg" ${cart.length?'':'disabled'}>Submit Order</button></div>`;
    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.querySelectorAll('.pos-add-btn').forEach(b=>b.onclick=()=>{
      cart.push({name:b.dataset.mname, menuItemId:b.dataset.mid, price:+b.dataset.mp, qty:1, variant:null});
      cart._name=$('#wkName')?$('#wkName').value:'';
      renderWalkup();
    });
    modal.querySelectorAll('.pos-variant-btn').forEach(b=>b.onclick=()=>{
      const item=menu.find(m=>(m.id||m.name)===b.dataset.mid);
      cart.push({name:item.name, menuItemId:b.dataset.mid, price:item.price||0, qty:1, variant:b.dataset.v});
      cart._name=$('#wkName')?$('#wkName').value:'';
      renderWalkup();
    });
    modal.querySelectorAll('.pos-remove-item').forEach(b=>b.onclick=()=>{ cart.splice(+b.dataset.ri,1); cart._name=$('#wkName')?$('#wkName').value:''; renderWalkup(); });
    const submitBtn=modal.querySelector('#wkSubmit');
    if(submitBtn) submitBtn.onclick=async()=>{
      const name=modal.querySelector('#wkName').value||'Walk-up';
      const disc=modal.querySelector('#wkDiscount').value||undefined;
      try{
        await api('POST','/api/pos/orders',{customerName:name, items:cart.map(c=>({menuItemId:c.menuItemId,name:c.name,variant:c.variant,qty:c.qty,price:c.price})), discountType:disc});
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
  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';
  modal.innerHTML=`<div class="pos-modal"><button class="pos-modal-close">✕</button><h3>Menu Items</h3>
    <div class="pos-menu-toggles">${menu.map(m=>`<div class="pos-menu-toggle-row">
      <span>${m.name}</span>
      <label class="pos-switch"><input type="checkbox" data-id="${m.id||m.name}" ${m.available!==false?'checked':''}><span class="pos-slider"></span></label>
    </div>`).join('')}</div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
  modal.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.onchange=async()=>{
    try{ await api('PUT',`/api/pos/menu/${cb.dataset.id}/toggle`); } catch(e){ showError('Toggle failed'); cb.checked=!cb.checked; }
  });
}

// --- Init ---
token ? renderMain() : renderLogin();
})();
