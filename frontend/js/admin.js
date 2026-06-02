(function(){
const $ = s => document.querySelector(s);
const app = $('#app');
let token = sessionStorage.getItem('admin_token');
let currentUser = sessionStorage.getItem('admin_user') || '';
let activeTab = 'orders';
let orders = [];
let pollTimer = null;

function authHeaders(){ return {'Content-Type':'application/json', Authorization:`Bearer ${token}`}; }

async function api(method, path, body){
  const opts = {method, headers: authHeaders()};
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if(res.status === 401){ logout(); throw new Error('Unauthorized'); }
  if(!res.ok) throw new Error(await res.text());
  return res.json();
}

function showError(msg){ const b=$('#errorBanner'); b.textContent=msg; b.classList.add('show'); setTimeout(()=>b.classList.remove('show'),4000); }

// --- Auth ---
function renderLogin(){
  stopPolling();
  app.innerHTML = `<div class="pos-login"><h2>Admin Login</h2><form id="loginForm">
    <input id="loginUser" placeholder="User ID" required class="pos-input" autocomplete="username">
    <input id="loginPin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" required class="pos-input">
    <button type="submit" class="pos-btn pos-btn-primary">Login</button></form></div>`;
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    try{
      const res = await fetch(`${API_BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:$('#loginUser').value,pin:$('#loginPin').value})});
      if(!res.ok) throw new Error('Login failed');
      const data = await res.json();
      if(data.role !== 'ADMIN'){ showError('Admin access required'); return; }
      token = data.token;
      currentUser = data.name || $('#loginUser').value;
      sessionStorage.setItem('admin_token', token);
      sessionStorage.setItem('admin_user', currentUser);
      renderApp();
    } catch(e){ showError('Invalid credentials'); }
  };
}

function logout(){ token=null; currentUser=''; sessionStorage.removeItem('admin_token'); sessionStorage.removeItem('admin_user'); renderLogin(); }

// --- Main Layout ---
const tabs = [
  {id:'orders',icon:'📋',label:'Orders'},
  {id:'menu',icon:'🍽️',label:'Menu'},
  {id:'ingredients',icon:'🧂',label:'Ingredients'},
  {id:'recipes',icon:'📖',label:'Recipes'},
  {id:'users',icon:'👥',label:'Users'},
  {id:'reports',icon:'📊',label:'Reports'},
  {id:'settings',icon:'⚙️',label:'Settings'}
];

function renderApp(){
  app.innerHTML = `<div class="admin-layout">
    <nav class="admin-sidebar">${tabs.map(t=>`<button class="admin-nav-btn${t.id===activeTab?' active':''}" data-tab="${t.id}"><span class="admin-nav-icon">${t.icon}</span><span class="admin-nav-label">${t.label}</span></button>`).join('')}
      <button class="admin-nav-btn admin-logout-btn" id="btnLogout"><span class="admin-nav-icon">🚪</span><span class="admin-nav-label">Logout</span></button>
    </nav>
    <nav class="admin-bottombar">${tabs.map(t=>`<button class="admin-tab-btn${t.id===activeTab?' active':''}" data-tab="${t.id}"><span>${t.icon}</span><span>${t.label}</span></button>`).join('')}</nav>
    <main class="admin-content" id="tabContent"></main>
  </div>`;
  app.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{ activeTab=b.dataset.tab; renderApp(); });
  $('#btnLogout').onclick = logout;
  renderTab();
}

function renderTab(){
  const c=$('#tabContent');
  stopPolling();
  switch(activeTab){
    case 'orders': renderOrders(c); break;
    case 'menu': renderMenu(c); break;
    case 'ingredients': renderIngredients(c); break;
    case 'recipes': renderRecipes(c); break;
    case 'users': renderUsers(c); break;
    case 'reports': renderReports(c); break;
    case 'settings': renderSettings(c); break;
  }
}

// --- Orders Tab ---
function startPolling(){ stopPolling(); pollTimer=setInterval(fetchOrders,7000); }
function stopPolling(){ if(pollTimer){clearInterval(pollTimer);pollTimer=null;} }

async function fetchOrders(){
  try{ const data=await api('GET','/api/pos/orders'); orders=Array.isArray(data)?data:data.orders||[]; renderOrderBoard(); }catch(e){}
}

function renderOrders(c){
  c.innerHTML=`<div class="admin-section-header"><h2>Orders</h2><button class="pos-btn pos-btn-primary" id="btnWalkup">+ Walk-up Order</button></div><div id="orderBoard" class="pos-kanban"></div>`;
  $('#btnWalkup').onclick = openWalkup;
  fetchOrders();
  startPolling();
}

function renderOrderBoard(){
  const board=$('#orderBoard');
  if(!board) return;
  const pending=orders.filter(o=>o.status==='PENDING').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const preparing=orders.filter(o=>o.status==='PREPARING');
  const ready=orders.filter(o=>o.status==='READY');
  board.innerHTML=`<div class="pos-col pos-col-pending"><h3>Pending (${pending.length})</h3>${pending.map(cardHtml).join('')}</div>
    <div class="pos-col pos-col-preparing"><h3>Preparing (${preparing.length})</h3>${preparing.map(cardHtml).join('')}</div>
    <div class="pos-col pos-col-ready"><h3>Ready (${ready.length})</h3>${ready.map(cardHtml).join('')}</div>`;
  board.querySelectorAll('.pos-card').forEach(c=>c.onclick=()=>openOrderDetail(c.dataset.id));
}

function cardHtml(o){
  const items=(o.items||[]).map(i=>`${i.quantity||i.qty}x ${i.name}`).join(', ');
  return `<div class="pos-card pos-card-${o.status.toLowerCase()}" data-id="${o.id||o.orderId}">
    <div class="pos-card-name">${o.customerName||'Guest'}</div>
    <div class="pos-card-items">${items||'—'}</div>
    <div class="pos-card-footer"><span>RM ${(o.total||0).toFixed(2)}</span><span>${timeAgo(o.createdAt)}</span></div></div>`;
}

function timeAgo(d){ const m=Math.floor((Date.now()-new Date(d))/60000); return m<1?'just now':m<60?`${m}m ago`:`${Math.floor(m/60)}h ago`; }

function openOrderDetail(id){
  const o=orders.find(x=>(x.id||x.orderId)===id);
  if(!o) return;
  const items=(o.items||[]).map(i=>`<li>${i.quantity||i.qty}x ${i.name}${i.variant?' ('+i.variant+')':''} - RM ${((i.price||0)*(i.quantity||i.qty)).toFixed(2)}</li>`).join('');
  let actions='';
  if(o.status==='PENDING') actions=`<button class="pos-btn pos-btn-primary" onclick="window._orderAction('approve','${id}')">Approve</button><button class="pos-btn pos-btn-danger" onclick="window._orderAction('reject','${id}')">Reject</button>`;
  if(o.status==='PREPARING') actions=`<button class="pos-btn pos-btn-primary" onclick="window._orderAction('ready','${id}')">Ready</button><button class="pos-btn" onclick="window._orderAction('undo','${id}')">Undo</button>`;
  if(o.status==='READY') actions=`<button class="pos-btn" onclick="window._orderAction('undo','${id}')">Undo</button>`;
  showModal(`<h3>${o.customerName||'Guest'}</h3><ul class="pos-detail-items">${items}</ul><p class="pos-detail-total">Total: RM ${(o.total||0).toFixed(2)}</p><div class="pos-detail-actions">${actions}</div>`);
}

window._orderAction = async(action,id)=>{
  try{ await api('PUT',`/api/pos/orders/${id}/${action}`); closeModal(); fetchOrders(); }catch(e){ showError('Action failed'); }
};

async function openWalkup(){
  let menu=[];
  try{ menu=await api('GET','/api/menu'); if(!Array.isArray(menu)) menu=menu.items||[]; }catch(e){}
  let cart=[];
  const render=()=>{
    const cartHtml=cart.map((c,i)=>`<li>${c.qty}x ${c.name}${c.variant?' ('+c.variant+')':''} <button class="pos-remove-item" data-i="${i}">✗</button></li>`).join('');
    showModal(`<h3>Walk-up Order</h3>
      <input id="walkupName" placeholder="Customer name" class="pos-input" style="margin-bottom:12px">
      <div class="admin-table-wrap" style="max-height:40vh;overflow-y:auto">${menu.map((m,mi)=>`<div class="pos-walkup-item"><span>${m.name} - RM ${(m.basePrice||m.price||0).toFixed(2)}</span>
        ${(m.variants&&m.variants.length)?m.variants.map(v=>`<button class="pos-variant-btn" data-mi="${mi}" data-v="${v.id||v.name}">${v.name}</button>`).join(''):`<button class="pos-add-btn" data-mi="${mi}">+</button>`}</div>`).join('')}</div>
      <div class="pos-walkup-cart"><strong>Cart:</strong><ul>${cartHtml||'<li>Empty</li>'}</ul></div>
      <button class="pos-btn pos-btn-primary" id="submitWalkup" style="width:100%">Submit Order</button>`);
    document.querySelectorAll('.pos-add-btn').forEach(b=>b.onclick=()=>{ const m=menu[b.dataset.mi]; cart.push({menuItemId:m.id,name:m.name,variant:null,qty:1,price:m.basePrice||m.price||0}); render(); });
    document.querySelectorAll('.pos-variant-btn').forEach(b=>b.onclick=()=>{ const m=menu[b.dataset.mi]; const v=m.variants.find(x=>(x.id||x.name)===b.dataset.v); cart.push({menuItemId:m.id,name:m.name,variant:v.name,variantId:v.id,qty:1,price:(m.basePrice||m.price||0)+(v.priceModifier||0)}); render(); });
    document.querySelectorAll('.pos-remove-item').forEach(b=>b.onclick=()=>{ cart.splice(+b.dataset.i,1); render(); });
    const sub=$('#submitWalkup');
    if(sub) sub.onclick=async()=>{
      const name=$('#walkupName').value||'Walk-up';
      if(!cart.length){ showError('Add items first'); return; }
      try{ await api('POST','/api/pos/orders',{customerName:name,items:cart}); closeModal(); fetchOrders(); }catch(e){ showError('Failed to create order'); }
    };
  };
  render();
}

// --- Modal ---
function showModal(html){
  let overlay=document.querySelector('.admin-modal-overlay');
  if(!overlay){ overlay=document.createElement('div'); overlay.className='admin-modal-overlay'; document.body.appendChild(overlay); }
  overlay.innerHTML=`<div class="admin-modal"><button class="admin-modal-close" id="modalClose">✕</button>${html}</div>`;
  overlay.style.display='flex';
  overlay.querySelector('#modalClose').onclick=closeModal;
  overlay.onclick=e=>{ if(e.target===overlay) closeModal(); };
}
function closeModal(){ const o=document.querySelector('.admin-modal-overlay'); if(o) o.style.display='none'; }

// --- Menu Tab ---
async function renderMenu(c){
  c.innerHTML='<div class="admin-section-header"><h2>Menu Items</h2><button class="pos-btn pos-btn-primary" id="btnAddMenu">+ Add Item</button></div><div id="menuList" class="loading">Loading...</div>';
  $('#btnAddMenu').onclick=()=>menuForm();
  try{
    let items=await api('GET','/api/menu');
    if(!Array.isArray(items)) items=items.items||[];
    $('#menuList').innerHTML=items.length?`<table class="admin-table"><thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Active</th><th>Actions</th></tr></thead><tbody>${items.map(m=>`<tr>
      <td>${m.name}</td><td>${m.category||'-'}</td><td>RM ${(m.basePrice||m.price||0).toFixed(2)}</td><td>${m.active!==false?'✓':'✗'}</td>
      <td><button class="pos-btn pos-btn-sm" data-edit="${m.id}">Edit</button> <button class="pos-btn pos-btn-sm pos-btn-danger" data-del="${m.id}">Delete</button></td></tr>`).join('')}</tbody></table>`:'<p>No menu items</p>';
    document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>menuForm(items.find(i=>i.id===b.dataset.edit)));
    document.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{ if(confirm('Delete this item?')){ try{ await api('DELETE',`/api/admin/menu/${b.dataset.del}`); renderMenu(c); }catch(e){ showError('Delete failed'); }} });
  }catch(e){ $('#menuList').innerHTML='<p>Failed to load menu</p>'; }
}

function menuForm(item){
  const isEdit=!!item;
  let variants=item?[...(item.variants||[])]:[];
  const render=()=>{
    const variantsHtml=variants.map((v,i)=>`<div style="display:flex;gap:8px;margin-bottom:4px"><input class="pos-input" placeholder="ID" value="${v.id||''}" data-vi="${i}" data-f="id" style="width:60px"><input class="pos-input" placeholder="Name" value="${v.name||''}" data-vi="${i}" data-f="name"><input class="pos-input" type="number" step="0.1" placeholder="+/-Price" value="${v.priceModifier||0}" data-vi="${i}" data-f="priceModifier" style="width:80px"><button class="pos-btn pos-btn-sm pos-btn-danger" data-rmv="${i}">✗</button></div>`).join('');
    showModal(`<h3>${isEdit?'Edit':'Add'} Menu Item</h3>
      <form id="menuItemForm" class="admin-form">
        <label>Name<input class="pos-input" id="miName" value="${item?.name||''}" required></label>
        <label>Category<select class="pos-input" id="miCat"><option value="DRINK"${item?.category==='DRINK'?' selected':''}>DRINK</option><option value="FOOD"${item?.category==='FOOD'?' selected':''}>FOOD</option></select></label>
        <label>Base Price (RM)<input class="pos-input" type="number" step="0.1" id="miPrice" value="${item?.basePrice||item?.price||''}" required></label>
        <label>Sort Order<input class="pos-input" type="number" id="miSort" value="${item?.sortOrder||0}"></label>
        <div><strong>Variants</strong><button type="button" class="pos-btn pos-btn-sm" id="addVariant">+ Add</button></div>
        <div id="variantsList">${variantsHtml}</div>
        <button type="submit" class="pos-btn pos-btn-primary" style="width:100%;margin-top:12px">${isEdit?'Update':'Create'}</button>
      </form>`);
    $('#addVariant').onclick=()=>{ variants.push({id:'',name:'',priceModifier:0}); render(); };
    document.querySelectorAll('[data-rmv]').forEach(b=>b.onclick=()=>{ variants.splice(+b.dataset.rmv,1); render(); });
    document.querySelectorAll('[data-vi]').forEach(inp=>inp.oninput=()=>{ const i=+inp.dataset.vi; const f=inp.dataset.f; variants[i][f]=f==='priceModifier'?parseFloat(inp.value)||0:inp.value; });
    $('#menuItemForm').onsubmit=async e=>{
      e.preventDefault();
      const body={name:$('#miName').value,category:$('#miCat').value,basePrice:parseFloat($('#miPrice').value),sortOrder:parseInt($('#miSort').value)||0,variants};
      try{
        if(isEdit) await api('PUT',`/api/admin/menu/${item.id}`,body);
        else await api('POST','/api/admin/menu',body);
        closeModal(); renderMenu($('#tabContent'));
      }catch(e){ showError('Save failed'); }
    };
  };
  render();
}

// --- Ingredients Tab ---
async function renderIngredients(c){
  c.innerHTML='<div class="admin-section-header"><h2>Ingredients</h2><button class="pos-btn pos-btn-primary" id="btnAddIng">+ Add Ingredient</button></div><div id="ingList" class="loading">Loading...</div>';
  $('#btnAddIng').onclick=()=>ingredientForm();
  try{
    let items=await api('GET','/api/pos/inventory');
    if(!Array.isArray(items)) items=items.ingredients||items.items||[];
    $('#ingList').innerHTML=items.length?`<table class="admin-table"><thead><tr><th>Name</th><th>Stock</th><th>Unit</th><th>Threshold</th><th>Location</th><th>Actions</th></tr></thead><tbody>${items.map(m=>`<tr>
      <td>${m.name}</td><td><input type="number" class="admin-stock-input" data-id="${m.id}" value="${m.currentStock||0}" style="width:70px"></td><td>${m.unit||'-'}</td><td>${m.lowStockThreshold||m.threshold||'-'}</td><td>${m.storageLocation||m.location||'-'}</td>
      <td><button class="pos-btn pos-btn-sm" data-edit="${m.id}">Edit</button></td></tr>`).join('')}</tbody></table>`:'<p>No ingredients</p>';
    document.querySelectorAll('.admin-stock-input').forEach(inp=>inp.onchange=async()=>{
      try{ await api('PUT',`/api/pos/inventory/${inp.dataset.id}`,{currentStock:parseFloat(inp.value)}); }catch(e){ showError('Stock update failed'); }
    });
    document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>ingredientForm(items.find(i=>i.id===b.dataset.edit)));
  }catch(e){ $('#ingList').innerHTML='<p>Failed to load</p>'; }
}

function ingredientForm(item){
  const isEdit=!!item;
  showModal(`<h3>${isEdit?'Edit':'Add'} Ingredient</h3>
    <form id="ingForm" class="admin-form">
      <label>Name<input class="pos-input" id="ingName" value="${item?.name||''}" required></label>
      <label>Unit<select class="pos-input" id="ingUnit"><option value="ml"${item?.unit==='ml'?' selected':''}>ml</option><option value="g"${item?.unit==='g'?' selected':''}>g</option><option value="spoons"${item?.unit==='spoons'?' selected':''}>spoons</option><option value="pieces"${item?.unit==='pieces'?' selected':''}>pieces</option></select></label>
      <label>Current Stock<input class="pos-input" type="number" id="ingStock" value="${item?.currentStock||0}"></label>
      <label>Low Stock Threshold<input class="pos-input" type="number" id="ingThresh" value="${item?.lowStockThreshold||item?.threshold||0}"></label>
      <label>Storage Location<select class="pos-input" id="ingLoc"><option value="FRIDGE"${item?.storageLocation==='FRIDGE'?' selected':''}>FRIDGE</option><option value="STOREROOM"${(item?.storageLocation||'STOREROOM')==='STOREROOM'?' selected':''}>STOREROOM</option></select></label>
      <button type="submit" class="pos-btn pos-btn-primary" style="width:100%;margin-top:12px">${isEdit?'Update':'Create'}</button>
    </form>`);
  $('#ingForm').onsubmit=async e=>{
    e.preventDefault();
    const body={name:$('#ingName').value,unit:$('#ingUnit').value,currentStock:parseFloat($('#ingStock').value),lowStockThreshold:parseFloat($('#ingThresh').value),storageLocation:$('#ingLoc').value};
    try{
      if(isEdit) await api('PUT',`/api/admin/ingredients/${item.id}`,body);
      else await api('POST','/api/admin/ingredients',body);
      closeModal(); renderIngredients($('#tabContent'));
    }catch(e){ showError('Save failed'); }
  };
}

// --- Recipes Tab ---
async function renderRecipes(c){
  c.innerHTML='<div class="admin-section-header"><h2>Recipes</h2></div><div class="admin-form"><label>Select Menu Item<select class="pos-input" id="recipeMenu"><option value="">-- Select --</option></select></div><div id="recipeContent"></div>';
  let menuItems=[], ingredients=[];
  try{ menuItems=await api('GET','/api/menu'); if(!Array.isArray(menuItems)) menuItems=menuItems.items||[]; }catch(e){}
  try{ ingredients=await api('GET','/api/pos/inventory'); if(!Array.isArray(ingredients)) ingredients=ingredients.ingredients||ingredients.items||[]; }catch(e){}
  const sel=$('#recipeMenu');
  menuItems.forEach(m=>{ const o=document.createElement('option'); o.value=m.id; o.textContent=m.name; sel.appendChild(o); });
  sel.onchange=()=>loadRecipe(sel.value, menuItems, ingredients);
}

async function loadRecipe(menuItemId, menuItems, ingredients){
  const rc=$('#recipeContent');
  if(!menuItemId){ rc.innerHTML=''; return; }
  const item=menuItems.find(m=>m.id===menuItemId);
  let recipe=[];
  try{ const data=await api('GET',`/api/admin/recipes/${menuItemId}`); recipe=Array.isArray(data)?data:data.ingredients||[]; }catch(e){}
  let rows=[...recipe];
  const render=()=>{
    rc.innerHTML=`<table class="admin-table"><thead><tr><th>Ingredient</th><th>Quantity</th><th></th></tr></thead><tbody>${rows.map((r,i)=>`<tr>
      <td><select class="pos-input admin-rec-ing" data-i="${i}">${ingredients.map(ing=>`<option value="${ing.id}"${ing.id===r.ingredientId?' selected':''}>${ing.name}</option>`).join('')}</select></td>
      <td><input class="pos-input" type="number" step="0.1" value="${r.quantity||0}" data-i="${i}" data-f="qty" style="width:80px"></td>
      <td><button class="pos-btn pos-btn-sm pos-btn-danger" data-rm="${i}">✗</button></td></tr>`).join('')}</tbody></table>
      <button class="pos-btn pos-btn-sm" id="addRecipeRow" style="margin-top:8px">+ Add Ingredient</button>
      <button class="pos-btn pos-btn-primary" id="saveRecipe" style="margin-top:12px;width:100%">Save Recipe</button>`;
    document.querySelectorAll('.admin-rec-ing').forEach(s=>s.onchange=()=>{ rows[+s.dataset.i].ingredientId=s.value; });
    document.querySelectorAll('[data-f="qty"]').forEach(inp=>inp.oninput=()=>{ rows[+inp.dataset.i].quantity=parseFloat(inp.value)||0; });
    document.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{ rows.splice(+b.dataset.rm,1); render(); });
    $('#addRecipeRow').onclick=()=>{ rows.push({ingredientId:ingredients[0]?.id||'',quantity:0}); render(); };
    $('#saveRecipe').onclick=async()=>{
      try{ await api('POST','/api/admin/recipes',{menuItemId,variantId:null,ingredients:rows.map(r=>({ingredientId:r.ingredientId,quantity:r.quantity}))}); showError('Recipe saved!'); }catch(e){ showError('Save failed'); }
    };
  };
  render();
}

// --- Users Tab ---
async function renderUsers(c){
  c.innerHTML='<div class="admin-section-header"><h2>Users</h2><button class="pos-btn pos-btn-primary" id="btnAddUser">+ Add User</button></div><div id="userList" class="loading">Loading...</div>';
  $('#btnAddUser').onclick=()=>userForm();
  try{
    let users=await api('GET','/api/admin/users');
    if(!Array.isArray(users)) users=users.users||[];
    $('#userList').innerHTML=users.length?`<table class="admin-table"><thead><tr><th>Name</th><th>Role</th><th>Active</th><th>Actions</th></tr></thead><tbody>${users.map(u=>`<tr>
      <td>${u.name||u.userId}</td><td>${u.role}</td><td>${u.active!==false?'✓':'✗'}</td>
      <td><button class="pos-btn pos-btn-sm" data-edit="${u.id||u.userId}">Edit</button> <button class="pos-btn pos-btn-sm pos-btn-danger" data-del="${u.id||u.userId}">Delete</button></td></tr>`).join('')}</tbody></table>`:'<p>No users found</p>';
    document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>userForm(users.find(u=>(u.id||u.userId)===b.dataset.edit)));
    document.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{ if(confirm('Delete this user?')){ try{ await api('DELETE',`/api/admin/users/${b.dataset.del}`); renderUsers(c); }catch(e){ showError('Delete failed'); }} });
  }catch(e){ $('#userList').innerHTML='<p>No users found</p>'; }
}

function userForm(item){
  const isEdit=!!item;
  showModal(`<h3>${isEdit?'Edit':'Add'} User</h3>
    <form id="userForm" class="admin-form">
      <label>Name<input class="pos-input" id="uName" value="${item?.name||''}" required></label>
      <label>PIN<input class="pos-input" type="password" id="uPin" maxlength="6" inputmode="numeric" placeholder="${isEdit?'Leave blank to keep':'6-digit PIN'}" ${isEdit?'':'required'}></label>
      <label>Role<select class="pos-input" id="uRole"><option value="CASHIER"${item?.role==='CASHIER'?' selected':''}>CASHIER</option><option value="ADMIN"${item?.role==='ADMIN'?' selected':''}>ADMIN</option></select></label>
      ${isEdit?`<label><input type="checkbox" id="uActive" ${item?.active!==false?'checked':''}> Active</label>`:''}
      <button type="submit" class="pos-btn pos-btn-primary" style="width:100%;margin-top:12px">${isEdit?'Update':'Create'}</button>
    </form>`);
  $('#userForm').onsubmit=async e=>{
    e.preventDefault();
    const body={name:$('#uName').value,role:$('#uRole').value};
    const pin=$('#uPin').value;
    if(pin) body.pin=pin;
    if(isEdit){ const act=$('#uActive'); if(act) body.active=act.checked; }
    try{
      if(isEdit) await api('PUT',`/api/admin/users/${item.id||item.userId}`,body);
      else await api('POST','/api/admin/users',body);
      closeModal(); renderUsers($('#tabContent'));
    }catch(e){ showError('Save failed'); }
  };
}

// --- Reports Tab ---
async function renderReports(c){
  c.innerHTML='<div class="admin-section-header"><h2>Reports</h2></div><div class="admin-report-cards" id="dailyReport"><h3>Daily Report</h3><p class="loading">Loading...</p></div><div id="invReport"><h3>Inventory Report</h3><p class="loading">Loading...</p></div>';
  try{
    const daily=await api('GET','/api/admin/reports/daily');
    $('#dailyReport').innerHTML=`<h3>Daily Report</h3><div class="admin-cards-row">
      <div class="admin-card"><span>Orders</span><strong>${daily.totalOrders||0}</strong></div>
      <div class="admin-card"><span>Revenue</span><strong>RM ${(daily.revenue||0).toFixed(2)}</strong></div>
      <div class="admin-card"><span>Offsets</span><strong>RM ${(daily.offsets||0).toFixed(2)}</strong></div>
      <div class="admin-card"><span>Net</span><strong>RM ${(daily.net||daily.revenue||0).toFixed(2)}</strong></div></div>`;
  }catch(e){ $('#dailyReport').innerHTML='<h3>Daily Report</h3><p>Unable to load</p>'; }
  try{
    let inv=await api('GET','/api/admin/reports/inventory');
    if(!Array.isArray(inv)) inv=inv.items||inv.ingredients||[];
    const lowStock=inv.filter(i=>i.currentStock<=( i.lowStockThreshold||i.threshold||0));
    $('#invReport').innerHTML=`<h3>Inventory Report</h3>${lowStock.length?`<table class="admin-table"><thead><tr><th>Name</th><th>Stock</th><th>Threshold</th></tr></thead><tbody>${lowStock.map(i=>`<tr class="admin-low-stock"><td>${i.name}</td><td>${i.currentStock}</td><td>${i.lowStockThreshold||i.threshold}</td></tr>`).join('')}</tbody></table>`:'<p>All stock levels OK ✓</p>'}`;
  }catch(e){ $('#invReport').innerHTML='<h3>Inventory Report</h3><p>Unable to load</p>'; }
}

// --- Settings Tab ---
async function renderSettings(c){
  c.innerHTML='<div class="admin-section-header"><h2>Settings</h2></div><div id="settingsForm" class="loading">Loading...</div>';
  try{
    const settings=await api('GET','/api/admin/settings');
    $('#settingsForm').innerHTML=`<form id="sForm" class="admin-form">
      <label>Order Expiry (minutes)<input class="pos-input" type="number" id="sExpiry" value="${settings.orderExpiryMinutes||15}"></label>
      <label>Archive After (minutes)<input class="pos-input" type="number" id="sArchive" value="${settings.archiveAfterMinutes||60}"></label>
      <button type="submit" class="pos-btn pos-btn-primary" style="margin-top:12px">Save Settings</button>
    </form>`;
    $('#sForm').onsubmit=async e=>{
      e.preventDefault();
      try{ await api('PUT','/api/admin/settings',{orderExpiryMinutes:parseInt($('#sExpiry').value),archiveAfterMinutes:parseInt($('#sArchive').value)}); showError('Settings saved!'); }catch(e){ showError('Save failed'); }
    };
  }catch(e){ $('#settingsForm').innerHTML='<p>Failed to load settings</p>'; }
}

// --- Init ---
if(token) renderApp(); else renderLogin();
})();
