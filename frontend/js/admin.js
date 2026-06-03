(function(){
const $ = s => document.querySelector(s);
const app = $('#app');
let token = sessionStorage.getItem('pos_token');
let currentUser = sessionStorage.getItem('pos_user') || '';

function showFormModal(form){
  const overlay = document.createElement('div');
  overlay.className = 'pos-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'pos-modal';
  modal.style.maxWidth = '600px';
  modal.style.maxHeight = '85vh';
  modal.style.overflowY = 'auto';
  modal.appendChild(form);
  overlay.appendChild(modal);
  overlay.onclick = e => { if(e.target===overlay) overlay.remove(); };
  document.body.appendChild(overlay);
  form._overlay = overlay;
}
let currentTab = 'dashboard';

function authHeaders(){ return { 'Content-Type':'application/json', Authorization:`Bearer ${token}` }; }

async function api(method, path, body){
  const opts = { method, headers: authHeaders() };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if(res.status === 401){ logout(); throw new Error('Unauthorized'); }
  if(!res.ok){ const err = await res.text(); throw new Error(err); }
  return res.json();
}

function showError(msg){ const b=$('#errorBanner'); b.textContent=msg; b.classList.add('show'); setTimeout(()=>b.classList.remove('show'),4000); }

// --- Login ---
function renderLogin(){
  app.innerHTML = `<div class="admin-login">
    <h2>Admin Login</h2>
    <p>Access restricted to administrators</p>
    <form id="loginForm">
      <input id="loginUser" placeholder="Your name (e.g. Admin)" required autocomplete="username" class="pos-input">
      <input id="loginPin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" required class="pos-input">
      <button type="submit" class="pos-btn pos-btn-primary" style="width:100%">Login</button>
    </form></div>`;
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    try{
      const res = await fetch(`${API_BASE}/api/auth/login`,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:$('#loginUser').value, pin:$('#loginPin').value}) });
      if(!res.ok) throw new Error();
      const data = await res.json();
      if(data.role !== 'ADMIN'){ showError('Admin access required'); return; }
      token = data.token;
      currentUser = data.name || 'Admin';
      sessionStorage.setItem('pos_token', token);
      sessionStorage.setItem('pos_user', currentUser);
      renderApp();
    } catch(e){ showError('Invalid credentials'); }
  };
}

function logout(){ token=null; sessionStorage.removeItem('pos_token'); sessionStorage.removeItem('pos_user'); renderLogin(); }

// --- Main app shell ---
function renderApp(){
  app.innerHTML = `<nav class="admin-nav">
    <span class="admin-nav-user">👤 ${currentUser}</span>
    <button data-tab="dashboard" class="active">Dashboard</button>
    <button data-tab="menu">Menu</button>
    <button data-tab="users">Users</button>
    <button data-tab="ingredients">Ingredients</button>
    <button data-tab="checklist">Checklist</button>
    <button data-tab="planogram">Planogram</button>
    <button data-tab="settings">Settings</button>
    <button data-tab="reports">Reports</button>
    <a href="pos" class="pos-btn pos-btn-sm" style="text-decoration:none;margin-left:auto">POS</a>
    <button class="nav-logout">Logout</button>
  </nav>
  <div id="adminContent"></div>`;
  app.querySelectorAll('.admin-nav button[data-tab]').forEach(btn=>{
    btn.onclick=()=>{
      app.querySelectorAll('.admin-nav button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      loadTab();
    };
  });
  app.querySelector('.nav-logout').onclick = logout;
  loadTab();
}

function loadTab(){
  const c = $('#adminContent');
  switch(currentTab){
    case 'dashboard': loadDashboard(c); break;
    case 'menu': loadMenu(c); break;
    case 'users': loadUsers(c); break;
    case 'ingredients': loadIngredients(c); break;
    case 'checklist': loadChecklist(c); break;
    case 'planogram': loadPlanogram(c); break;
    case 'settings': loadSettings(c); break;
    case 'reports': loadReports(c); break;
  }
}

// --- Dashboard ---
async function loadDashboard(container){
  container.innerHTML = '<div class="loading">Loading dashboard...</div>';
  try{
    const [settings, daily, inventory] = await Promise.all([
      api('GET','/api/admin/settings'),
      api('GET','/api/admin/reports/daily'),
      api('GET','/api/admin/reports/inventory')
    ]);
    const orders = daily.orders || [];
    const pending = orders.filter(o=>o.status==='PENDING'||o.status==='CONFIRMED').length;
    const active = orders.filter(o=>o.status==='PREPARING').length;
    const lowStock = inventory.lowStock || [];
    const recent = orders.slice(-5).reverse();

    let html = `<div class="admin-section"><div class="admin-section-header"><h2>At a Glance</h2></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
        <div class="admin-card"><div class="admin-card-header"><div>
          <div class="admin-card-title">Café Status</div>
          <div class="admin-card-subtitle" style="margin-top:8px">
            <span class="admin-card-badge ${settings.cafeStatus==='OPEN'?'badge-active':'badge-inactive'}">${settings.cafeStatus||'CLOSED'}</span>
            ${settings.celebrationMode?'<span class="admin-card-badge badge-drink" style="margin-left:8px">🎉 Celebration Mode</span>':''}
          </div>
        </div></div></div>
        <div class="admin-card"><div class="admin-card-header"><div>
          <div class="admin-card-title">Today's Stats</div>
          <div class="admin-card-subtitle" style="margin-top:8px">
            Orders: <strong>${daily.totalOrders||0}</strong> · Revenue: <strong>RM ${(daily.totalRevenue||0).toFixed(2)}</strong><br>
            Pending: <strong>${pending}</strong> · Preparing: <strong>${active}</strong>
          </div>
        </div></div></div>
        <div class="admin-card"><div class="admin-card-header"><div>
          <div class="admin-card-title">Low Stock Alerts</div>
          <div class="admin-card-subtitle" style="margin-top:8px">${lowStock.length ? lowStock.map(i=>`<div>${i.name}: <strong>${i.currentStock}</strong> ${i.unit} (threshold: ${i.lowStockThreshold})</div>`).join('') : '<span style="color:var(--success)">All stocked ✓</span>'}</div>
        </div></div></div>
        <div class="admin-card"><div class="admin-card-header"><div>
          <div class="admin-card-title">Recent Activity</div>
          <div class="admin-card-subtitle" style="margin-top:8px">${recent.length ? recent.map(o=>`<div>${o.customerName||'Guest'} · <span class="admin-card-badge">${o.status}</span> · ${new Date(o.createdAt||o.orderTime).toLocaleTimeString()}</div>`).join('') : 'No orders yet today'}</div>
        </div></div></div>
      </div>
    </div>`;
    container.innerHTML = html;
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load dashboard</p></div>'; }
}

// --- Menu Management ---
async function loadMenu(container){
  container.innerHTML = '<div class="loading">Loading menu...</div>';
  try{
    const data = await api('GET','/api/menu');
    const items = (Array.isArray(data) ? data : data.items || []);
    renderMenuSection(container, items);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load menu</p></div>'; }
}

function renderMenuSection(container, items){
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Menu Items</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddMenu">+ Add Item</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <button class="pos-btn pos-btn-sm" id="btnEnableDrinks">✅ Enable All Drinks</button>
      <button class="pos-btn pos-btn-sm" id="btnEnableFood">✅ Enable All Food</button>
      <button class="pos-btn pos-btn-sm pos-btn-danger" id="btnDisableAll">❌ Disable All</button>
      <button class="pos-btn pos-btn-sm" id="btnRepeatFood">📋 Repeat Last Food</button>
    </div>`;
  if(!items.length){
    html += '<div class="admin-empty"><p>No menu items yet</p></div>';
  } else {
    items.forEach(item=>{
      const badge = item.category === 'DRINK' ? 'badge-drink' : 'badge-food';
      const variants = (item.variants||[]).map(v=>v.name||v).join(', ');
      html += `<div class="admin-card">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${item.name}</div>
            <div class="admin-card-subtitle">RM ${(item.basePrice||0).toFixed(2)}${variants ? ' · '+variants : ''}</div>
          </div>
          <div class="admin-card-actions">
            <span class="admin-card-badge ${badge}">${item.category}</span>
            <button class="pos-btn pos-btn-sm" data-edit-menu="${item.menuItemId||item.id}">Edit</button>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-menu="${item.menuItemId||item.id}">Delete</button>
          </div>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;

  $('#btnAddMenu').onclick = ()=> openMenuForm(container, null, items);
  $('#btnEnableDrinks').onclick = async()=>{ try{ await api('PUT','/api/admin/menu/bulk-toggle',{enable:true,category:'DRINK'}); loadMenu(container); }catch(e){ showError('Failed'); } };
  $('#btnEnableFood').onclick = async()=>{ try{ await api('PUT','/api/admin/menu/bulk-toggle',{enable:true,category:'FOOD'}); loadMenu(container); }catch(e){ showError('Failed'); } };
  $('#btnDisableAll').onclick = async()=>{ try{ await api('PUT','/api/admin/menu/bulk-toggle',{enable:false}); loadMenu(container); }catch(e){ showError('Failed'); } };
  $('#btnRepeatFood').onclick = async()=>{ try{ const r=await api('POST','/api/admin/menu/duplicate-food',{}); showSuccess(`Repeated ${r.duplicated} food items`); loadMenu(container); }catch(e){ showError('Failed'); } };
  container.querySelectorAll('[data-edit-menu]').forEach(btn=>{
    btn.onclick=()=>{ const item=items.find(i=>(i.menuItemId||i.id)===btn.dataset.editMenu); openMenuForm(container, item, items); };
  });
  container.querySelectorAll('[data-del-menu]').forEach(btn=>{
    btn.onclick=async()=>{
      if(!confirm('Delete this menu item?')) return;
      try{ await api('DELETE',`/api/admin/menu/${btn.dataset.delMenu}`); loadMenu(container); } catch(e){ showError('Delete failed'); }
    };
  });
}

function openMenuForm(container, item, allItems){
  const isEdit = !!item;
  const variants = item?.variants || [];
  let variantHtml = variants.map((v,i)=>`<div class="variant-row">
    <input class="pos-input" placeholder="Name" value="${v.name||''}" data-vi="${i}" data-vf="name">
    <input class="pos-input" placeholder="+Price" type="number" step="0.5" value="${v.priceModifier||0}" data-vi="${i}" data-vf="priceModifier">
    <button class="remove-variant" data-vri="${i}">✕</button></div>`).join('');

  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>${isEdit?'Edit':'Add'} Menu Item</h3>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Name</label><input id="mfName" class="pos-input" value="${item?.name||''}"></div>
      <div class="admin-form-group"><label>Category</label><select id="mfCategory" class="pos-input"><option value="DRINK" ${item?.category==='DRINK'?'selected':''}>Drink</option><option value="FOOD" ${item?.category==='FOOD'?'selected':''}>Food</option></select></div>
    </div>
    <div class="admin-form-group"><label>Description</label><input id="mfDesc" class="pos-input" value="${item?.description||''}" placeholder="Short description (optional)"></div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Base Price (RM)</label><input id="mfPrice" type="number" step="0.5" class="pos-input" value="${item?.basePrice||''}"></div>
      <div class="admin-form-group"><label>Sort Order</label><input id="mfSort" type="number" class="pos-input" value="${item?.sortOrder||0}"></div>
    </div>
    <div class="admin-form-group"><label>Variants</label><div id="variantList" class="variant-list">${variantHtml}</div>
      <button class="pos-btn pos-btn-sm" id="btnAddVariant" style="margin-top:8px">+ Add Variant</button></div>
    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="mfSubmit">${isEdit?'Save Changes':'Add Item'}</button>
      <button class="pos-btn" id="mfCancel">Cancel</button>
    </div>`;

  showFormModal(form);
  let currentVariants = [...variants];

  form.querySelector('#btnAddVariant').onclick=()=>{
    currentVariants.push({name:'',priceModifier:0});
    refreshVariants();
  };

  function refreshVariants(){
    const list = form.querySelector('#variantList');
    list.innerHTML = currentVariants.map((v,i)=>`<div class="variant-row">
      <input class="pos-input" placeholder="Name" value="${v.name||''}" data-vi="${i}" data-vf="name">
      <input class="pos-input" placeholder="+Price" type="number" step="0.5" value="${v.priceModifier||0}" data-vi="${i}" data-vf="priceModifier">
      <button class="remove-variant" data-vri="${i}">✕</button></div>`).join('');
    list.querySelectorAll('input').forEach(inp=>inp.oninput=()=>{
      const idx=+inp.dataset.vi;
      const field=inp.dataset.vf;
      currentVariants[idx][field] = field==='priceModifier' ? +inp.value : inp.value;
    });
    list.querySelectorAll('.remove-variant').forEach(btn=>btn.onclick=()=>{
      currentVariants.splice(+btn.dataset.vri,1);
      refreshVariants();
    });
  }
  refreshVariants();

  form.querySelector('#mfCancel').onclick=()=>{ form._overlay.remove(); };
  form.querySelector('#mfSubmit').onclick=async()=>{
    const body = {
      name: form.querySelector('#mfName').value.trim(),
      description: form.querySelector('#mfDesc').value.trim(),
      category: form.querySelector('#mfCategory').value,
      basePrice: +form.querySelector('#mfPrice').value,
      sortOrder: +form.querySelector('#mfSort').value,
      variants: currentVariants.filter(v=>v.name)
    };
    if(!body.name || !body.basePrice){ showError('Name and price are required'); return; }
    try{
      if(isEdit) await api('PUT',`/api/admin/menu/${item.menuItemId||item.id}`, body);
      else await api('POST','/api/admin/menu', body);
      form._overlay.remove();
      loadMenu(container);
    } catch(e){ showError('Save failed'); }
  };
}

// --- Users Management ---
async function loadUsers(container){
  container.innerHTML = '<div class="loading">Loading users...</div>';
  try{
    const data = await api('GET','/api/pos/inventory');
    const usersRes = await fetch(`${API_BASE}/api/admin/users`, { headers: authHeaders() });
    let users = [];
    if(usersRes.ok){ const d = await usersRes.json(); users = Array.isArray(d) ? d : d.users || []; }
    renderUsersSection(container, users);
  } catch(e){ renderUsersSection(container, []); }
}

function renderUsersSection(container, users){
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Volunteers</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddUser">+ Add Volunteer</button>
    </div>`;
  if(!users.length){
    html += '<div class="admin-empty"><p>No users loaded. Users are managed via the API.</p></div>';
  } else {
    users.forEach(u=>{
      const badge = u.role === 'ADMIN' ? 'badge-admin' : 'badge-cashier';
      html += `<div class="admin-card">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${u.name||u.userId}</div>
            <div class="admin-card-subtitle">${u.userId}</div>
          </div>
          <div class="admin-card-actions">
            <span class="admin-card-badge ${badge}">${u.role}</span>
            <span class="admin-card-badge ${u.isActive!==false?'badge-active':'badge-inactive'}">${u.isActive!==false?'Active':'Inactive'}</span>
            <button class="pos-btn pos-btn-sm" data-edit-user="${u.userId}">Edit</button>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-user="${u.userId}">Delete</button>
          </div>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;

  $('#btnAddUser').onclick = ()=> openUserForm(container, null);
  container.querySelectorAll('[data-edit-user]').forEach(btn=>{
    btn.onclick=()=>{ const u=users.find(x=>x.userId===btn.dataset.editUser); openUserForm(container, u); };
  });
  container.querySelectorAll('[data-del-user]').forEach(btn=>{
    btn.onclick=async()=>{
      if(!confirm('Delete this user?')) return;
      try{ await api('DELETE',`/api/admin/users/${btn.dataset.delUser}`); loadUsers(container); } catch(e){ showError('Delete failed'); }
    };
  });
}

function openUserForm(container, user){
  const isEdit = !!user;
  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>${isEdit?'Edit':'Add'} Volunteer</h3>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Name</label><input id="ufName" class="pos-input" value="${user?.name||''}"></div>
      <div class="admin-form-group"><label>Role</label><select id="ufRole" class="pos-input"><option value="CASHIER" ${user?.role==='CASHIER'?'selected':''}>Cashier</option><option value="ADMIN" ${user?.role==='ADMIN'?'selected':''}>Admin</option></select></div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>PIN ${isEdit?'(leave blank to keep)':''}</label><input id="ufPin" type="password" inputmode="numeric" maxlength="6" class="pos-input" placeholder="6-digit PIN"></div>
      <div class="admin-form-group"><label>Active</label><select id="ufActive" class="pos-input"><option value="true" ${user?.isActive!==false?'selected':''}>Yes</option><option value="false" ${user?.isActive===false?'selected':''}>No</option></select></div>
    </div>
    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="ufSubmit">${isEdit?'Save Changes':'Add Volunteer'}</button>
      <button class="pos-btn" id="ufCancel">Cancel</button>
    </div>`;

  showFormModal(form);
  form.querySelector('#ufCancel').onclick=()=>form._overlay.remove();
  form.querySelector('#ufSubmit').onclick=async()=>{
    const name = form.querySelector('#ufName').value.trim();
    const role = form.querySelector('#ufRole').value;
    const pin = form.querySelector('#ufPin').value;
    const isActive = form.querySelector('#ufActive').value === 'true';

    if(!name){ showError('Name is required'); return; }
    if(!isEdit && !pin){ showError('PIN is required for new users'); return; }

    const body = { name, role, isActive };
    if(pin) body.pin = pin;

    try{
      if(isEdit) await api('PUT',`/api/admin/users/${user.userId}`, body);
      else await api('POST','/api/admin/users', body);
      form._overlay.remove();
      loadUsers(container);
    } catch(e){ showError('Save failed'); }
  };
}

// --- Ingredients ---
async function loadIngredients(container){
  container.innerHTML = '<div class="loading">Loading ingredients...</div>';
  try{
    const [data, menuData, recipeData] = await Promise.all([
      api('GET','/api/pos/inventory'),
      api('GET','/api/menu'),
      api('GET','/api/admin/recipes')
    ]);
    const all = Array.isArray(data) ? data : data.ingredients || [];
    const items = all.filter(i => i.PK && i.PK.startsWith('INGREDIENT#') && i.SK === 'META');
    const menuItems = Array.isArray(menuData) ? menuData : menuData.items || [];
    const recipes = recipeData.recipes || [];
    renderIngredientsSection(container, items, menuItems, recipes);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load ingredients</p></div>'; }
}

function renderIngredientsSection(container, items, menuItems, recipes){
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Ingredients</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddIngredient">+ Add Ingredient</button>
    </div>`;
  if(!items.length){
    html += '<div class="admin-empty"><p>No ingredients added yet</p></div>';
  } else {
    items.forEach(ing=>{
      const isLow = ing.currentStock <= (ing.lowStockThreshold||0);
      const usageLabel = ing.usageUnit ? ` · recipe unit: ${ing.usageUnit}` : '';
      html += `<div class="admin-card">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${ing.name}</div>
            <div class="admin-card-subtitle">${ing.currentStock} ${ing.unit} · ${ing.storageLocation||'—'}${usageLabel}</div>
          </div>
          <div class="admin-card-actions">
            ${isLow ? '<span class="admin-card-badge badge-inactive">Low Stock</span>' : ''}
            <button class="pos-btn pos-btn-sm" data-edit-ing="${ing.ingredientId}">Edit</button>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-ing="${ing.ingredientId}">Delete</button>
          </div>
        </div>
      </div>`;
    });
  }
  html += '</div>';

  // Recipes section — one line per menu item
  html += `<div class="admin-section" style="margin-top:24px">
    <div class="admin-section-header"><h2>Recipes</h2></div>
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:14px">Define base ingredients + variant overrides per menu item</p>`;
  if(!menuItems.length || !items.length){
    html += '<div class="admin-empty"><p>Add menu items and ingredients first</p></div>';
  } else {
    menuItems.forEach(mi=>{
      const id = mi.menuItemId||mi.id;
      const baseRecipe = recipes.filter(r=>r.PK===`RECIPE#${id}#default`);
      const variantRecipes = recipes.filter(r=>r.PK.startsWith(`RECIPE#${id}#`) && r.PK!==`RECIPE#${id}#default`);
      const baseStr = baseRecipe.map(r=>{
        const ing = items.find(i=>i.ingredientId===r.ingredientId);
        return `${r.quantity}${ing?.usageUnit||''} ${ing?.name||'?'}`;
      }).join(', ') || '<em style="color:var(--text-light)">not set</em>';
      const overrideCount = variantRecipes.length;
      html += `<div class="admin-card" style="padding:12px 16px">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title" style="font-size:.95rem">${mi.name}</div>
            <div class="admin-card-subtitle">Base: ${baseStr}${overrideCount ? ` · ${overrideCount} variant override(s)` : ''}</div>
          </div>
          <button class="pos-btn pos-btn-sm" data-edit-recipe="${id}">Edit</button>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;

  $('#btnAddIngredient').onclick = ()=> openIngredientForm(container, null, items);
  container.querySelectorAll('[data-edit-ing]').forEach(btn=>{
    btn.onclick=()=>{ const ing=items.find(i=>i.ingredientId===btn.dataset.editIng); openIngredientForm(container, ing, items); };
  });
  container.querySelectorAll('[data-del-ing]').forEach(btn=>{
    btn.onclick=async()=>{
      if(!confirm('Delete this ingredient?')) return;
      try{ await api('DELETE',`/api/admin/ingredients/${btn.dataset.delIng}`); loadIngredients(container); } catch(e){ showError('Delete failed'); }
    };
  });
  container.querySelectorAll('[data-edit-recipe]').forEach(btn=>{
    btn.onclick=()=>{
      const mi = menuItems.find(m=>(m.menuItemId||m.id)===btn.dataset.editRecipe);
      openRecipeForm(container, mi, items, recipes, menuItems);
    };
  });
}

function openRecipeForm(container, menuItem, ingredients, allRecipes, menuItems){
  const id = menuItem.menuItemId||menuItem.id;
  const variants = menuItem.variants||[];
  const baseExisting = allRecipes.filter(r=>r.PK===`RECIPE#${id}#default`);
  let baseRows = baseExisting.map(r=>({ingredientId:r.ingredientId, quantity:r.quantity}));
  if(!baseRows.length) baseRows.push({ingredientId:'', quantity:0});

  // Variant overrides: {variantId: [{ingredientId, quantity, action:'add'|'replace'}]}
  let variantOverrides = {};
  variants.forEach(v=>{
    const vid = v.id||v.name||v;
    const existing = allRecipes.filter(r=>r.PK===`RECIPE#${id}#${vid}`);
    variantOverrides[vid] = existing.map(r=>({ingredientId:r.ingredientId, quantity:r.quantity}));
  });

  const form = document.createElement('div');
  form.className = 'admin-form';

  function ingSelect(row, idx, prefix){
    return `<select class="pos-input" data-prefix="${prefix}" data-ri="${idx}" data-rf="ingredientId" style="flex:2">
      <option value="">-- Select --</option>
      ${ingredients.map(ing=>`<option value="${ing.ingredientId}" ${ing.ingredientId===row.ingredientId?'selected':''}>${ing.name} (${ing.usageUnit||ing.unit})</option>`).join('')}
    </select>`;
  }

  function renderRows(rows, prefix){
    return rows.map((r,i)=>`<div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
      ${ingSelect(r,i,prefix)}
      <input type="number" step="0.1" class="pos-input" data-prefix="${prefix}" data-ri="${i}" data-rf="quantity" value="${r.quantity||''}" placeholder="Qty" style="flex:1">
      <button class="pos-btn pos-btn-sm pos-btn-danger" data-prefix="${prefix}" data-rr="${i}" style="min-width:32px">✕</button>
    </div>`).join('');
  }

  function render(){
    let variantHtml = '';
    if(variants.length){
      variantHtml = `<h4 style="margin-top:16px;margin-bottom:8px">Variant Overrides <span style="font-size:.8rem;color:var(--text-light)">(leave empty = use base only)</span></h4>`;
      variants.forEach(v=>{
        const vid = v.id||v.name||v;
        const vname = v.name||v;
        const rows = variantOverrides[vid]||[];
        variantHtml += `<div style="margin-bottom:12px;padding:10px;background:var(--cream,#f9f5f0);border-radius:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><strong style="font-size:.9rem">${vname}</strong><button class="pos-btn pos-btn-sm" data-add-override="${vid}">+ Add</button></div>
          <div data-override-list="${vid}">${rows.length ? renderRows(rows, `v_${vid}`) : '<span style="font-size:.8rem;color:var(--text-light)">No override — uses base recipe</span>'}</div>
        </div>`;
      });
    }

    form.innerHTML = `<h3>Recipe: ${menuItem.name}</h3>
      <h4 style="margin-bottom:8px">Base Ingredients</h4>
      <div id="baseRows">${renderRows(baseRows, 'base')}</div>
      <button class="pos-btn pos-btn-sm" id="addBaseRow" style="margin-top:6px">+ Add Ingredient</button>
      ${variantHtml}
      <div class="admin-form-actions" style="margin-top:16px">
        <button class="pos-btn pos-btn-primary" id="saveRecipe">Save Recipe</button>
        <button class="pos-btn" id="cancelRecipe">Cancel</button>
      </div>`;

    // Bind base
    form.querySelectorAll('[data-prefix="base"][data-rf="ingredientId"]').forEach(s=>s.onchange=()=>{ baseRows[+s.dataset.ri].ingredientId=s.value; });
    form.querySelectorAll('[data-prefix="base"][data-rf="quantity"]').forEach(inp=>inp.oninput=()=>{ baseRows[+inp.dataset.ri].quantity=+inp.value; });
    form.querySelectorAll('[data-prefix="base"][data-rr]').forEach(btn=>btn.onclick=()=>{ baseRows.splice(+btn.dataset.rr,1); if(!baseRows.length) baseRows.push({ingredientId:'',quantity:0}); render(); });
    form.querySelector('#addBaseRow').onclick=()=>{ baseRows.push({ingredientId:'',quantity:0}); render(); };

    // Bind variant overrides
    variants.forEach(v=>{
      const vid = v.id||v.name||v;
      const prefix = `v_${vid}`;
      form.querySelectorAll(`[data-prefix="${prefix}"][data-rf="ingredientId"]`).forEach(s=>s.onchange=()=>{ variantOverrides[vid][+s.dataset.ri].ingredientId=s.value; });
      form.querySelectorAll(`[data-prefix="${prefix}"][data-rf="quantity"]`).forEach(inp=>inp.oninput=()=>{ variantOverrides[vid][+inp.dataset.ri].quantity=+inp.value; });
      form.querySelectorAll(`[data-prefix="${prefix}"][data-rr]`).forEach(btn=>btn.onclick=()=>{ variantOverrides[vid].splice(+btn.dataset.rr,1); render(); });
      form.querySelector(`[data-add-override="${vid}"]`).onclick=()=>{ if(!variantOverrides[vid]) variantOverrides[vid]=[]; variantOverrides[vid].push({ingredientId:'',quantity:0}); render(); };
    });

    form.querySelector('#cancelRecipe').onclick=()=>form._overlay.remove();
    form.querySelector('#saveRecipe').onclick=async()=>{
      try{
        // Save base
        const baseValid = baseRows.filter(r=>r.ingredientId && r.quantity>0);
        await api('POST','/api/admin/recipes',{ menuItemId:id, variantId:null, ingredients:baseValid });
        // Save variant overrides
        for(const v of variants){
          const vid = v.id||v.name||v;
          const rows = (variantOverrides[vid]||[]).filter(r=>r.ingredientId && r.quantity>0);
          await api('POST','/api/admin/recipes',{ menuItemId:id, variantId:vid, ingredients:rows });
        }
        form._overlay.remove();
        loadIngredients(container);
      } catch(e){ showError('Failed to save recipe'); }
    };
  }
  render();
  showFormModal(form);
}

function openIngredientForm(container, ing, allItems){
  const isEdit = !!ing;
  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>${isEdit?'Edit':'Add'} Ingredient</h3>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Name</label><input id="ifName" class="pos-input" value="${ing?.name||''}"></div>
      <div class="admin-form-group"><label>Stock Unit (how you count it)</label><select id="ifUnit" class="pos-input">
        <option value="bottles" ${ing?.unit==='bottles'?'selected':''}>bottles</option>
        <option value="bags" ${ing?.unit==='bags'?'selected':''}>bags</option>
        <option value="box" ${ing?.unit==='box'?'selected':''}>box</option>
        <option value="pieces" ${ing?.unit==='pieces'?'selected':''}>pieces</option>
      </select></div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Usage Unit (per drink recipe)</label><select id="ifUsageUnit" class="pos-input">
        <option value="ml" ${ing?.usageUnit==='ml'?'selected':''}>ml</option>
        <option value="g" ${ing?.usageUnit==='g'?'selected':''}>g</option>
        <option value="spoons" ${ing?.usageUnit==='spoons'?'selected':''}>spoons</option>
        <option value="pieces" ${ing?.usageUnit==='pieces'?'selected':''}>pieces</option>
      </select></div>
      <div class="admin-form-group"><label>Storage Location</label><select id="ifLocation" class="pos-input">
        <option value="FRIDGE" ${ing?.storageLocation==='FRIDGE'?'selected':''}>Fridge</option>
        <option value="STOREROOM" ${ing?.storageLocation==='STOREROOM'?'selected':''}>Storeroom</option>
      </select></div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Current Stock</label><input id="ifStock" type="number" step="0.1" class="pos-input" value="${ing?.currentStock||0}"></div>
      <div class="admin-form-group"><label>Low Stock Threshold</label><input id="ifThreshold" type="number" step="0.1" class="pos-input" value="${ing?.lowStockThreshold||0}"></div>
    </div>
    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="ifSubmit">${isEdit?'Save Changes':'Add Ingredient'}</button>
      <button class="pos-btn" id="ifCancel">Cancel</button>
    </div>`;

  showFormModal(form);
  form.querySelector('#ifCancel').onclick=()=>form._overlay.remove();
  form.querySelector('#ifSubmit').onclick=async()=>{
    const body = {
      name: form.querySelector('#ifName').value.trim(),
      unit: form.querySelector('#ifUnit').value,
      usageUnit: form.querySelector('#ifUsageUnit').value,
      currentStock: +form.querySelector('#ifStock').value,
      lowStockThreshold: +form.querySelector('#ifThreshold').value,
      storageLocation: form.querySelector('#ifLocation').value
    };
    if(!body.name){ showError('Name is required'); return; }
    try{
      if(isEdit) await api('PUT',`/api/admin/ingredients/${ing.ingredientId}`, body);
      else await api('POST','/api/admin/ingredients', body);
      form._overlay.remove();
      loadIngredients(container);
    } catch(e){ showError('Save failed'); }
  };
}

// --- Checklist ---
async function loadChecklist(container){
  container.innerHTML = '<div class="loading">Loading checklist config...</div>';
  try{
    const data = await api('GET','/api/admin/checklist/config');
    renderChecklistAdmin(container, data);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load checklist</p></div>'; }
}

function renderChecklistAdmin(container, config){
  function renderPhase(phase, items){
    return items.map((item, i)=>`<div class="admin-card" style="display:flex;align-items:center;gap:12px;padding:12px 16px">
      <span style="min-width:24px;color:var(--text-light);font-weight:600">${i+1}.</span>
      <input class="pos-input" style="flex:1;margin:0" value="${item.label}" data-phase="${phase}" data-idx="${i}" data-field="label">
      <select class="pos-input" style="width:120px;margin:0" data-phase="${phase}" data-idx="${i}" data-field="type">
        <option value="checkbox" ${item.type==='checkbox'?'selected':''}>Checkbox</option>
        <option value="text" ${item.type==='text'?'selected':''}>Text input</option>
        <option value="image" ${item.type==='image'?'selected':''}>Image upload</option>
      </select>
      <button class="pos-btn pos-btn-sm pos-btn-danger" data-remove-phase="${phase}" data-remove-idx="${i}" style="min-width:36px">✕</button>
    </div>`).join('');
  }

  container.innerHTML = `<div class="admin-section">
    <div class="admin-section-header"><h2>Checklist Configuration</h2></div>
    <div class="admin-form">
      <h3 style="margin-bottom:12px">☀️ Open Checklist</h3>
      <div id="openItems">${renderPhase('open', config.open||[])}</div>
      <button class="pos-btn pos-btn-sm" id="addOpenItem" style="margin-top:10px">+ Add item</button>
    </div>
    <div class="admin-form" style="margin-top:16px">
      <h3 style="margin-bottom:12px">🌙 Close Checklist</h3>
      <div id="closeItems">${renderPhase('close', config.close||[])}</div>
      <button class="pos-btn pos-btn-sm" id="addCloseItem" style="margin-top:10px">+ Add item</button>
    </div>
    <div class="admin-form-actions" style="margin-top:20px">
      <button class="pos-btn pos-btn-primary" id="saveChecklist">Save Checklist</button>
    </div>
  </div>`;

  let openItems = [...(config.open||[])];
  let closeItems = [...(config.close||[])];

  container.querySelector('#addOpenItem').onclick=()=>{
    openItems.push({id:`open-${Date.now()}`, label:'', type:'checkbox'});
    renderChecklistAdmin(container, {open:openItems, close:closeItems});
  };
  container.querySelector('#addCloseItem').onclick=()=>{
    closeItems.push({id:`close-${Date.now()}`, label:'', type:'checkbox'});
    renderChecklistAdmin(container, {open:openItems, close:closeItems});
  };

  container.querySelectorAll('[data-remove-phase]').forEach(btn=>{
    btn.onclick=()=>{
      const phase = btn.dataset.removePhase;
      const idx = +btn.dataset.removeIdx;
      if(phase==='open') openItems.splice(idx,1);
      else closeItems.splice(idx,1);
      renderChecklistAdmin(container, {open:openItems, close:closeItems});
    };
  });

  container.querySelectorAll('input[data-field="label"]').forEach(inp=>{
    inp.oninput=()=>{
      const phase = inp.dataset.phase;
      const idx = +inp.dataset.idx;
      if(phase==='open') openItems[idx].label = inp.value;
      else closeItems[idx].label = inp.value;
    };
  });

  container.querySelectorAll('select[data-field="type"]').forEach(sel=>{
    sel.onchange=()=>{
      const phase = sel.dataset.phase;
      const idx = +sel.dataset.idx;
      if(phase==='open') openItems[idx].type = sel.value;
      else closeItems[idx].type = sel.value;
    };
  });

  container.querySelector('#saveChecklist').onclick=async()=>{
    const open = openItems.filter(i=>i.label.trim()).map((item,i)=>({...item, id:item.id||`open-${i+1}`, label:item.label.trim()}));
    const close = closeItems.filter(i=>i.label.trim()).map((item,i)=>({...item, id:item.id||`close-${i+1}`, label:item.label.trim()}));
    try{
      await api('PUT','/api/admin/checklist/config', {open, close});
      showSuccess('Checklist saved');
    } catch(e){ showError('Failed to save checklist'); }
  };
}

// --- Planogram ---
async function loadPlanogram(container){
  container.innerHTML = `<div class="admin-section">
    <div class="admin-section-header"><h2>Planogram — Reference Photos</h2></div>
    <p style="color:var(--text-light);margin-bottom:20px;font-size:.9rem">Upload photos of the ideal arrangement. AI compares against these to identify items.</p>
    <div class="admin-form">
      <h3 style="margin-bottom:12px">🧊 Fridge Reference</h3>
      <div id="fridgeRefPreview" class="planogram-preview"></div>
      <label class="upload-btn" for="fridgeRefInput" style="margin-top:12px;display:inline-block">📷 Upload Fridge Reference</label>
      <input type="file" id="fridgeRefInput" accept="image/*" style="display:none">
    </div>
    <div class="admin-form" style="margin-top:16px">
      <h3 style="margin-bottom:12px">🗄️ Storeroom Reference</h3>
      <div id="storeroomRefPreview" class="planogram-preview"></div>
      <label class="upload-btn" for="storeroomRefInput" style="margin-top:12px;display:inline-block">📷 Upload Storeroom Reference</label>
      <input type="file" id="storeroomRefInput" accept="image/*" style="display:none">
    </div>
    <div class="admin-form" style="margin-top:16px">
      <h3 style="margin-bottom:12px">📊 Run Stock Count Now</h3>
      <p style="font-size:.85rem;color:var(--text-light);margin-bottom:12px">Take photos and let AI count your stock</p>
      <div style="display:flex;gap:10px">
        <button class="pos-btn pos-btn-primary" id="runFridgeCount">🧊 Count Fridge</button>
        <button class="pos-btn pos-btn-primary" id="runStoreroomCount">🗄️ Count Storeroom</button>
      </div>
    </div>
  </div>`;

  // Load existing reference photos
  loadRefPreview('fridge', container.querySelector('#fridgeRefPreview'));
  loadRefPreview('storeroom', container.querySelector('#storeroomRefPreview'));

  container.querySelector('#fridgeRefInput').onchange = (e)=> uploadReference('fridge', e.target.files[0], container);
  container.querySelector('#storeroomRefInput').onchange = (e)=> uploadReference('storeroom', e.target.files[0], container);
  container.querySelector('#runFridgeCount').onclick = ()=> openAdminStockCount('fridge');
  container.querySelector('#runStoreroomCount').onclick = ()=> openAdminStockCount('storeroom');
}

async function loadRefPreview(location, el){
  try{
    const data = await api('GET',`/api/pos/planogram/reference/${location}`);
    if(data.url) el.innerHTML = `<img src="${data.url}" style="max-width:100%;max-height:200px;border-radius:var(--radius);border:1px solid var(--cream-dark)"><p style="font-size:.75rem;color:var(--text-light);margin-top:4px">Uploaded: ${new Date(data.uploadedAt).toLocaleDateString()}</p>`;
  } catch(e){ el.innerHTML = '<p style="color:var(--text-light);font-size:.85rem">No reference photo yet</p>'; }
}

async function uploadReference(location, file, container){
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async()=>{
    try{
      await api('POST','/api/admin/planogram/reference',{ location, image: reader.result });
      showSuccess(`${location} reference uploaded`);
      loadPlanogram(container);
    } catch(e){ showError('Upload failed'); }
  };
  reader.readAsDataURL(file);
}

function openAdminStockCount(location){
  // Reuse the same stock count modal from POS
  if(typeof openStockCount === 'function'){
    openStockCount(location);
  } else {
    // Inline version for admin
    const modal = document.createElement('div');
    modal.className = 'pos-modal-overlay';
    modal.innerHTML = `<div class="pos-modal" style="max-width:560px;text-align:center;padding:40px">
      <p>Stock count is available from the POS panel.</p>
      <a href="pos" class="pos-btn pos-btn-primary" style="margin-top:16px;display:inline-block;text-decoration:none">Open POS</a>
    </div>`;
    document.body.appendChild(modal);
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
  }
}

// --- Settings ---
async function loadSettings(container){
  container.innerHTML = '<div class="loading">Loading settings...</div>';
  try{
    const settings = await api('GET','/api/admin/settings');
    renderSettingsSection(container, settings);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load settings</p></div>'; }
}

function renderSettingsSection(container, settings){
  container.innerHTML = `<div class="admin-section">
    <div class="admin-section-header"><h2>Settings</h2></div>
    <div class="admin-form">
      <div class="admin-setting-row">
        <div class="admin-setting-info"><h4>Café Status</h4><p>Open or close the café for ordering</p></div>
        <div class="admin-setting-control"><select id="setCafeStatus" class="pos-input"><option value="OPEN" ${settings.cafeStatus==='OPEN'?'selected':''}>Open</option><option value="CLOSED" ${settings.cafeStatus!=='OPEN'?'selected':''}>Closed</option></select></div>
      </div>
      <div class="admin-setting-row">
        <div class="admin-setting-info"><h4>Celebration Mode</h4><p>All drinks at a flat price</p></div>
        <div class="admin-setting-control">
          <label class="pos-switch"><input type="checkbox" id="setCelebration" ${settings.celebrationMode?'checked':''}><span class="pos-slider"></span></label>
        </div>
      </div>
      <div class="admin-setting-row">
        <div class="admin-setting-info"><h4>Celebration Price (RM)</h4><p>Flat price when celebration mode is on</p></div>
        <div class="admin-setting-control"><input id="setCelebrationPrice" type="number" step="1" value="${settings.celebrationPrice||5}"></div>
      </div>
      <div class="admin-setting-row">
        <div class="admin-setting-info"><h4>Order Expiry (minutes)</h4><p>How long before unpaid orders expire</p></div>
        <div class="admin-setting-control"><input id="setExpiry" type="number" value="${settings.orderExpiryMinutes||60}"></div>
      </div>
      <div class="admin-setting-row">
        <div class="admin-setting-info"><h4>Archive After (minutes)</h4><p>How long ready orders stay visible</p></div>
        <div class="admin-setting-control"><input id="setArchive" type="number" value="${settings.archiveAfterMinutes||15}"></div>
      </div>
      <div class="admin-form-actions" style="margin-top:24px;border-top:1px solid var(--cream-dark);padding-top:20px">
        <button class="pos-btn pos-btn-primary" id="btnSaveSettings">Save Settings</button>
      </div>
    </div>
  </div>`;

  $('#btnSaveSettings').onclick = async()=>{
    const body = {
      cafeStatus: container.querySelector('#setCafeStatus').value,
      celebrationMode: container.querySelector('#setCelebration').checked,
      celebrationPrice: +container.querySelector('#setCelebrationPrice').value,
      orderExpiryMinutes: +container.querySelector('#setExpiry').value,
      archiveAfterMinutes: +container.querySelector('#setArchive').value
    };
    try{
      await api('PUT','/api/admin/settings', body);
      showSuccess('Settings saved');
    } catch(e){ showError('Failed to save settings'); }
  };
}

// --- Reports ---
async function loadReports(container){
  container.innerHTML = '<div class="loading">Loading reports...</div>';
  try{
    const [daily, inventory, weekly] = await Promise.all([
      api('GET','/api/admin/reports/daily'),
      api('GET','/api/admin/reports/inventory'),
      api('GET','/api/admin/reports/weekly')
    ]);
    renderReportsSection(container, daily, inventory, weekly);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load reports</p></div>'; }
}

function renderReportsSection(container, daily, inventory, weekly){
  const lowStock = inventory.lowStock || [];
  const orders = daily.orders || [];
  const fmtDate = d => { const p = d.split('-'); const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${+p[2]} ${months[+p[1]-1]}`; };

  // Item popularity
  const itemCounts = {};
  orders.forEach(o=>{
    (o.items||[]).forEach(i=>{
      const key = i.name + (i.variant ? ' ('+i.variant+')' : '');
      itemCounts[key] = (itemCounts[key]||0) + (i.quantity||1);
    });
  });
  const popular = Object.entries(itemCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);

  let html = `<div class="admin-section">
    <div class="admin-section-header"><h2>Reports</h2></div>
    <h3 style="margin-bottom:14px;color:var(--primary)">Today's Summary — ${daily.date||'—'}</h3>
    <div class="admin-stats">
      <div class="admin-stat-card"><div class="stat-value">${daily.totalOrders||0}</div><div class="stat-label">Total Orders</div></div>
      <div class="admin-stat-card"><div class="stat-value">RM ${(daily.totalRevenue||0).toFixed(2)}</div><div class="stat-label">Gross Revenue</div></div>
      <div class="admin-stat-card"><div class="stat-value">RM ${(daily.totalOffsets||0).toFixed(2)}</div><div class="stat-label">Discounts</div></div>
      <div class="admin-stat-card"><div class="stat-value">RM ${(daily.netExpected||0).toFixed(2)}</div><div class="stat-label">Net Expected</div></div>
    </div>`;

  if(popular.length){
    html += '<h3 style="margin:24px 0 14px;color:var(--primary)">Popular Items Today</h3>';
    html += '<div class="admin-form"><table style="width:100%;border-collapse:collapse">';
    html += '<tr style="border-bottom:2px solid var(--cream-dark)"><th style="text-align:left;padding:8px 0">Item</th><th style="text-align:right;padding:8px 0">Qty Sold</th></tr>';
    popular.forEach(([name, count], i) => {
      html += `<tr style="border-bottom:1px solid var(--cream-dark)"><td style="padding:8px 0">${i+1}. ${name}</td><td style="text-align:right;font-weight:700;padding:8px 0">${count}</td></tr>`;
    });
    html += '</table></div>';
  }

  // Weekly Report
  if(weekly && weekly.totals){
    const t = weekly.totals;
    html += `<h3 style="margin:32px 0 14px;color:var(--primary)">Weekly Report — ${fmtDate(weekly.startDate)} to ${fmtDate(weekly.endDate)}</h3>
    <div class="admin-stats">
      <div class="admin-stat-card"><div class="stat-value">${t.totalOrders}</div><div class="stat-label">Total Orders</div></div>
      <div class="admin-stat-card"><div class="stat-value">RM ${t.totalRevenue.toFixed(2)}</div><div class="stat-label">Total Revenue</div></div>
      <div class="admin-stat-card"><div class="stat-value">${t.avgPerDay}</div><div class="stat-label">Avg / Day</div></div>
    </div>`;
    if(weekly.days && weekly.days.length){
      html += '<h4 style="margin:20px 0 10px">Daily Breakdown</h4><div class="admin-form"><table style="width:100%;border-collapse:collapse">';
      html += '<tr style="border-bottom:2px solid var(--cream-dark)"><th style="text-align:left;padding:8px 0">Date</th><th style="text-align:right;padding:8px 0">Orders</th><th style="text-align:right;padding:8px 0">Revenue</th><th style="text-align:right;padding:8px 0">Offsets</th></tr>';
      weekly.days.forEach(d=>{
        html += `<tr style="border-bottom:1px solid var(--cream-dark)"><td style="padding:8px 0">${d.date}</td><td style="text-align:right">${d.orderCount}</td><td style="text-align:right">RM ${d.revenue.toFixed(2)}</td><td style="text-align:right">RM ${d.offsets.toFixed(2)}</td></tr>`;
      });
      html += '</table></div>';
    }
    if(weekly.topItems && weekly.topItems.length){
      html += '<h4 style="margin:20px 0 10px">Top 5 Items This Week</h4><div class="admin-form">';
      weekly.topItems.forEach((item,i)=>{ html += `<div style="padding:6px 0;border-bottom:1px solid var(--cream-dark)">${i+1}. ${item.name} — <strong>${item.count}</strong></div>`; });
      html += '</div>';
    }
    html += `<button class="pos-btn pos-btn-primary" id="btnCopyWeeklyReport" style="margin-top:16px">📋 Copy Report</button>`;
  }

  if(lowStock.length){
    html += '<h3 style="margin:24px 0 14px;color:var(--warning)">Low Stock Alerts</h3>';
    lowStock.forEach(item=>{
      html += `<div class="low-stock-item">
        <span class="stock-name">${item.name}</span>
        <span class="stock-level">${item.currentStock} ${item.unit} (threshold: ${item.lowStockThreshold})</span>
      </div>`;
    });
  } else {
    html += '<p style="color:var(--text-light);margin-top:20px">No low stock alerts</p>';
  }

  // Restock Shopping List
  html += `<h3 style="margin:24px 0 14px;color:var(--primary)">🛒 Restock Shopping List</h3>
    <button class="pos-btn pos-btn-primary" id="btnLoadRestock">Load Restock List</button>
    <div id="restockResult"></div>`;

  html += '</div>';
  container.innerHTML = html;

  // Copy weekly report handler
  if(weekly && weekly.totals){
    const btn = container.querySelector('#btnCopyWeeklyReport');
    if(btn) btn.onclick = ()=>{
      const t = weekly.totals;
      const topStr = (weekly.topItems||[]).map(i=>`${i.name} (${i.count})`).join(', ');
      const text = `📊 Weekly Report (${fmtDate(weekly.startDate)} - ${fmtDate(weekly.endDate)})\nTotal Orders: ${t.totalOrders} | Revenue: RM ${t.totalRevenue.toFixed(0)}\nTop Items: ${topStr}`;
      navigator.clipboard.writeText(text).then(()=>showSuccess('Report copied to clipboard'));
    };
  }

  container.querySelector('#btnLoadRestock').onclick = async()=>{
    const div = container.querySelector('#restockResult');
    div.innerHTML = '<div class="loading">Loading...</div>';
    try{
      const data = await api('GET','/api/admin/reports/restock');
      const items = data.items||[];
      if(!items.length){ div.innerHTML='<p style="color:var(--text-light);margin-top:12px">All stocked up! Nothing to restock.</p>'; return; }
      let t='<table style="width:100%;border-collapse:collapse;margin-top:12px"><tr style="border-bottom:2px solid var(--cream-dark)"><th style="text-align:left;padding:8px 0">Item</th><th style="text-align:right;padding:8px 0">Current</th><th style="text-align:right;padding:8px 0">Need</th><th style="text-align:right;padding:8px 0">Location</th></tr>';
      items.forEach(i=>{
        t+=`<tr style="border-bottom:1px solid var(--cream-dark)"><td style="padding:8px 0">${i.name}</td><td style="text-align:right">${i.currentStock} ${i.unit}</td><td style="text-align:right;font-weight:700">${i.suggestedRestock} ${i.unit}</td><td style="text-align:right">${i.storageLocation||'—'}</td></tr>`;
      });
      t+='</table><button class="pos-btn pos-btn-sm" id="btnCopyRestock" style="margin-top:12px">📋 Copy to Clipboard</button>';
      div.innerHTML=t;
      div.querySelector('#btnCopyRestock').onclick=()=>{
        const today=new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
        let text=`🛒 Restock List (${today})\n`;
        items.forEach(i=>{ text+=`- ${i.name}: need ${i.suggestedRestock}${i.unit} (currently ${i.currentStock}${i.unit})\n`; });
        navigator.clipboard.writeText(text).then(()=>showSuccess('Copied to clipboard'));
      };
    } catch(e){ div.innerHTML='<p style="color:var(--warning)">Failed to load restock list</p>'; }
  };
}

// --- Helpers ---
function showSuccess(msg){
  const b=$('#errorBanner');
  b.textContent=msg;
  b.style.background='var(--success)';
  b.classList.add('show');
  setTimeout(()=>{ b.classList.remove('show'); b.style.background=''; },3000);
}

// --- Init ---
token ? renderApp() : renderLogin();
})();
