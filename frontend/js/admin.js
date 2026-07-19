// admin.js — Shell: auth, sidebar, tab routing, shared helpers
// Part of rlc-cafe-pos v1.52.0 file split
// Depends on: config.js (API_BASE)
// Required by: admin-dashboard.js, admin-menu.js, admin-ingredients.js,
//              admin-checklist.js, admin-vouchers.js, admin-preorder.js

const $ = s => document.querySelector(s);
const app = $('#app');
let token = localStorage.getItem('pos_token');
let currentUser = localStorage.getItem('pos_user') || '';

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
      localStorage.setItem('pos_token', token);
      localStorage.setItem('pos_user', currentUser);
      renderApp();
    } catch(e){ showError('Invalid credentials'); }
  };
}

function logout(){ token=null; localStorage.removeItem('pos_token'); localStorage.removeItem('pos_user'); renderLogin(); }

// --- Main app shell ---
function renderApp(){
  app.innerHTML = `<aside class="admin-sidebar" id="adminSidebar">
  <div class="sidebar-header"><span>☕ Admin</span><button class="sidebar-close" id="sidebarClose">✕</button></div>
  <div class="sidebar-user">👤 ${currentUser}</div>
  <nav class="sidebar-nav">
    <button data-tab="dashboard" class="active">📊 Dashboard</button>
    <button data-tab="menu">🍽️ Menu</button>
    <button data-tab="ingredients">🧪 Ingredients</button>
    <button data-tab="checklist">✅ Checklist</button>
    <button data-tab="planogram">📷 Planogram</button>
    <button data-tab="users">👥 Users</button>
    <button data-tab="vouchers">🎟️ Vouchers</button>
    <button data-tab="preorder">🔗 Pre-Order Links</button>
    <button data-tab="display">📺 Display</button>
    <button data-tab="customers">👤 Customers</button>
    <button id="navReports" type="button">📈 Reports</button>
    <button data-tab="settings">⚙️ Settings</button>
    <button data-tab="verses">✝️ Verses</button>
  </nav>
  <div class="sidebar-footer">
    <a href="pos" class="pos-btn pos-btn-sm" style="text-decoration:none;display:block;text-align:center;margin-bottom:8px">Go to POS</a>
    <button class="nav-logout">Logout</button>
  </div>
</aside>
<div class="admin-overlay" id="adminOverlay"></div>
<main class="admin-main" id="adminContent"></main>`;

  if(window.innerWidth >= 900) document.getElementById('adminSidebar').classList.add('open');

  document.getElementById('adminHeaderToggle').onclick=()=>{
    document.getElementById('adminSidebar').classList.toggle('open');
  };
  document.getElementById('sidebarClose').onclick=()=>{
    document.getElementById('adminSidebar').classList.remove('open');
    document.getElementById('adminOverlay').style.display='';
  };
  document.getElementById('adminOverlay').onclick=()=>{
    document.getElementById('adminSidebar').classList.remove('open');
    document.getElementById('adminOverlay').style.display='';
  };

  app.querySelectorAll('.sidebar-nav button[data-tab]').forEach(btn=>{
    btn.onclick=()=>{
      app.querySelectorAll('.sidebar-nav button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      loadTab();
      if(window.innerWidth < 900){
        document.getElementById('adminSidebar').classList.remove('open');
        document.getElementById('adminOverlay').style.display='';
      }
    };
  });
  app.querySelector('.nav-logout').onclick = logout;
  const navReportsBtn = app.querySelector('#navReports');
  if (navReportsBtn) navReportsBtn.onclick = () => { window.location.href = 'reports.html'; };
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
    case 'vouchers': loadVouchers(c); break;
    case 'preorder': loadPreorderCodes(c); break;
    case 'display': loadDisplay(c); break;
    case 'customers': loadCustomers(c); break;
    case 'settings': loadSettings(c); break;
    case 'verses': loadVerses(c); break;
    // Historical reports (weekly/monthly) live on reports.html — sidebar
    // link `navReports` handles that navigation directly.
  }
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

function renderUsersSection(container, users, filter='ALL'){
  const filtered = filter==='ALL' ? users : filter==='NEVER' ? users.filter(u=>!u.lastLoginAt) : users.filter(u=>u.role===filter);
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Volunteers</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddUser">+ Add Volunteer</button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <button class="pos-btn pos-btn-sm ${filter==='ALL'?'pos-btn-primary':''}" data-user-filter="ALL">All</button>
      <button class="pos-btn pos-btn-sm ${filter==='CASHIER'?'pos-btn-primary':''}" data-user-filter="CASHIER">Cashier</button>
      <button class="pos-btn pos-btn-sm ${filter==='ADMIN'?'pos-btn-primary':''}" data-user-filter="ADMIN">Admin</button>
      <button class="pos-btn pos-btn-sm ${filter==='NEVER'?'pos-btn-primary':''}" data-user-filter="NEVER">Never Logged In</button>
    </div>`;
  if(!filtered.length){
    html += '<div class="admin-empty"><p>No volunteers found.</p></div>';
  } else {
    filtered.forEach(u=>{
      const badge = u.role === 'ADMIN' ? 'badge-admin' : 'badge-cashier';
      html += `<div class="admin-card">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${u.name||u.userId}</div>
            <div class="admin-card-subtitle">${u.lastLoginAt ? 'Last login: '+new Date(u.lastLoginAt).toLocaleString() : 'Never logged in'}</div>
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
  container.querySelectorAll('[data-user-filter]').forEach(btn=>{
    btn.onclick=()=>renderUsersSection(container, users, btn.dataset.userFilter);
  });
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
    if(pin && pin.length < 6){ showError('PIN must be at least 6 digits'); return; }

    const body = { name, role, isActive };
    if(pin) body.pin = pin;

    try{
      if(isEdit) await api('PUT',`/api/admin/users/${user.userId}`, body);
      else await api('POST','/api/admin/users', body);
      if(pin){
        const msg = `This is your access to https://153.oasisofcare.org/pos\nUsername: ${name}\nPin: ${pin}`;
        await navigator.clipboard.writeText(msg);
        showSuccess('Saved! Access details copied to clipboard.');
      }
      form._overlay.remove();
      loadUsers(container);
    } catch(e){ showError('Save failed'); }
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
    // Load both in parallel — pre-order templates live in a separate row
    // and shouldn't block the main settings render if the endpoint is
    // slow. A failure there just means the Templates section is skipped.
    const [settings, templates] = await Promise.all([
      api('GET','/api/admin/settings'),
      api('GET','/api/admin/settings/preorder-templates').catch(() => null),
    ]);
    renderSettingsSection(container, settings, templates);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load settings</p></div>'; }
}

function renderSettingsSection(container, settings, templates){
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
  </div>
  <div class="admin-section" id="preorderTemplatesSection" style="margin-top:24px"></div>`;

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

  // Pre-Order Templates block (loaded via loadSettings). Skipped when the
  // template endpoint returned null (failure) so the main settings page
  // stays usable even if the templates row is broken.
  if (templates) {
    renderPreorderTemplatesSection(container.querySelector('#preorderTemplatesSection'), templates);
  }
}

// ─── Pre-Order Templates section (Admin → Settings) ─────────────────

// Working state for the keyword/collection pill inputs. Reset every time
// the section is rendered so nested renders don't leak.
let _preorderTplKeywords = [];
let _preorderTplCollectionOpts = [];

function renderPreorderTemplatesSection(host, templates) {
  if (!host) return;
  _preorderTplKeywords = Array.isArray(templates.eligibleItemKeywords) ? templates.eligibleItemKeywords.slice() : [];
  _preorderTplCollectionOpts = Array.isArray(templates.collectionOptions) ? templates.collectionOptions.slice() : [];

  const banner = typeof templates.bannerMessage === 'string' ? templates.bannerMessage : '';
  const updated = templates.updatedAt ? new Date(templates.updatedAt).toLocaleString() : '';

  host.innerHTML = `
    <div class="admin-section-header"><h2>📝 Pre-Order Templates</h2></div>
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:12px">
      Defaults that pre-fill the "Create Pre-Order Link" form. Existing links keep their own copy — changes here only affect NEW links.
      ${updated ? `<br><em style="font-size:.8rem">Last updated: ${escapeHtml(updated)}</em>` : ''}
    </p>
    <div class="admin-form">
      <div class="admin-form-group">
        <label>Banner Message</label>
        <textarea id="tplBanner" class="pos-input" rows="3" maxlength="500" style="min-height:60px;font-family:inherit">${escapeHtml(banner)}</textarea>
        <p style="font-size:.75rem;color:var(--text-light);margin-top:4px">Use <code>{$SUNDAY}</code> to auto-insert the next Sunday date (e.g. "Sunday, 12 Jul").</p>
      </div>

      <div class="admin-form-group">
        <label>Eligible Drink Keywords</label>
        <div id="tplKeywordList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px"></div>
        <button type="button" class="pos-btn pos-btn-sm" id="tplAddKeyword">+ Add keyword</button>
        <p style="font-size:.75rem;color:var(--text-light);margin-top:6px">Drinks whose name contains any of these words are pre-checked when creating a new link. Case-insensitive substring match.</p>
      </div>

      <div class="admin-form-group">
        <label>Collection Options</label>
        <div id="tplCollectionList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px"></div>
        <button type="button" class="pos-btn pos-btn-sm" id="tplAddOpt">+ Add option</button>
      </div>

      <div class="admin-form-actions" style="margin-top:24px;border-top:1px solid var(--cream-dark);padding-top:20px">
        <button class="pos-btn pos-btn-primary" id="btnSaveTemplates">Save Templates</button>
      </div>
    </div>`;

  const renderKeywordList = () => {
    const el = host.querySelector('#tplKeywordList');
    el.innerHTML = _preorderTplKeywords.map((v, i) => `
      <div style="display:flex;gap:6px;align-items:center">
        <input class="pos-input" data-kw-idx="${i}" value="${escapeAttr(v)}" placeholder="e.g. latte" style="flex:1;margin:0">
        <button type="button" class="pos-btn pos-btn-sm pos-btn-danger" data-kw-remove="${i}" style="min-width:36px">✕</button>
      </div>`).join('');
    el.querySelectorAll('input[data-kw-idx]').forEach(inp => {
      inp.oninput = () => { _preorderTplKeywords[+inp.dataset.kwIdx] = inp.value; };
    });
    el.querySelectorAll('[data-kw-remove]').forEach(btn => {
      btn.onclick = () => {
        _preorderTplKeywords.splice(+btn.dataset.kwRemove, 1);
        renderKeywordList();
      };
    });
  };

  const renderOptList = () => {
    const el = host.querySelector('#tplCollectionList');
    el.innerHTML = _preorderTplCollectionOpts.map((v, i) => `
      <div style="display:flex;gap:6px;align-items:center">
        <input class="pos-input" data-opt-idx="${i}" value="${escapeAttr(v)}" placeholder="e.g. After 1st Service" maxlength="60" style="flex:1;margin:0">
        <button type="button" class="pos-btn pos-btn-sm pos-btn-danger" data-opt-remove="${i}" ${_preorderTplCollectionOpts.length <= 1 ? 'disabled title="Need at least one option"' : ''} style="min-width:36px">✕</button>
      </div>`).join('');
    el.querySelectorAll('input[data-opt-idx]').forEach(inp => {
      inp.oninput = () => { _preorderTplCollectionOpts[+inp.dataset.optIdx] = inp.value; };
    });
    el.querySelectorAll('[data-opt-remove]').forEach(btn => {
      btn.onclick = () => {
        _preorderTplCollectionOpts.splice(+btn.dataset.optRemove, 1);
        renderOptList();
      };
    });
  };

  renderKeywordList();
  renderOptList();

  host.querySelector('#tplAddKeyword').onclick = () => {
    _preorderTplKeywords.push('');
    renderKeywordList();
    const inputs = host.querySelectorAll('#tplKeywordList input');
    inputs[inputs.length - 1]?.focus();
  };
  host.querySelector('#tplAddOpt').onclick = () => {
    _preorderTplCollectionOpts.push('');
    renderOptList();
    const inputs = host.querySelectorAll('#tplCollectionList input');
    inputs[inputs.length - 1]?.focus();
  };

  host.querySelector('#btnSaveTemplates').onclick = async () => {
    const bannerMessage = host.querySelector('#tplBanner').value;
    const eligibleItemKeywords = _preorderTplKeywords.map(s => s.trim()).filter(Boolean);
    const collectionOptions = _preorderTplCollectionOpts.map(s => s.trim()).filter(Boolean);
    if (!collectionOptions.length) {
      showError('At least one collection option is required');
      return;
    }
    try {
      await api('PUT', '/api/admin/settings/preorder-templates', {
        bannerMessage, eligibleItemKeywords, collectionOptions,
      });
      showSuccess('Templates saved');
    } catch (e) {
      showError('Failed to save templates');
    }
  };
}

// --- Reports ---
async function loadReports(container){
  container.innerHTML = '<div class="loading">Loading reports...</div>';
  try{
    const [daily, inventory, weekly, discounts, sessions, monthly] = await Promise.all([
      api('GET','/api/admin/reports/daily'),
      api('GET','/api/admin/reports/inventory'),
      api('GET','/api/admin/reports/weekly'),
      api('GET','/api/admin/reports/discounts'),
      api('GET','/api/admin/reports/sessions'),
      api('GET','/api/admin/reports/monthly')
    ]);
    renderReportsSection(container, daily, inventory, weekly, discounts, sessions, monthly);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load reports</p></div>'; }
}

function renderReportsSection(container, daily, inventory, weekly, discounts, sessions, monthly){
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

  if(sessions){
    const s1 = sessions.session1 || {};
    const s2 = sessions.session2 || {};
    const s1Better = s1.revenue > s2.revenue;
    const s2Better = s2.revenue > s1.revenue;
    function sessionCard(label, s, isBetter){
      const bold = isBetter ? 'font-weight:700;color:var(--success)' : '';
      const topStr = (s.topItems||[]).map(i=>`${i.name} (${i.count})`).join(', ') || '—';
      return `<div class="admin-card" style="flex:1;min-width:240px;${isBetter?'border:2px solid var(--success)':''}">
        <div class="admin-card-header"><div><div class="admin-card-title">${label}</div></div></div>
        <div style="padding:0 16px 16px">
          <div style="${bold}">Orders: ${s.orderCount||0}</div>
          <div style="${bold}">Revenue: RM ${(s.revenue||0).toFixed(2)}</div>
          <div>Avg: RM ${(s.avgOrderValue||0).toFixed(2)}</div>
          <div style="margin-top:8px;font-size:.85rem;color:var(--text-light)">Top: ${topStr}</div>
        </div>
      </div>`;
    }
    html += '<h3 style="margin:24px 0 14px;color:var(--primary)">Session Comparison</h3>';
    html += `<div style="display:flex;gap:16px;flex-wrap:wrap">${sessionCard('Session 1 (10:15-11:30)',s1,s1Better)}${sessionCard('Session 2 (12:45-13:30)',s2,s2Better)}</div>`;
  }

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
      <div class="admin-stat-card"><div class="stat-value">${t.avgPerDay}</div><div class="stat-label">Avg / Service Day</div></div>
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

  // Monthly Summary
  if(monthly){
    html += `<h3 style="margin:32px 0 14px;color:var(--primary)">📊 Monthly Summary — ${monthly.period}</h3>
    <div class="admin-stats">
      <div class="admin-stat-card"><div class="stat-value">${monthly.totalOrders}</div><div class="stat-label">Total Orders</div></div>
      <div class="admin-stat-card"><div class="stat-value">RM ${monthly.totalRevenue.toLocaleString()}</div><div class="stat-label">Revenue</div></div>
      <div class="admin-stat-card"><div class="stat-value">RM ${monthly.netCollection.toLocaleString()}</div><div class="stat-label">Net Collection</div></div>
      <div class="admin-stat-card"><div class="stat-value">${monthly.newcomersServed}</div><div class="stat-label">Newcomers Served</div></div>
      <div class="admin-stat-card"><div class="stat-value">${monthly.serviceDays}</div><div class="stat-label">Service Days</div></div>
    </div>`;
    if(monthly.weeklyBreakdown && monthly.weeklyBreakdown.length){
      html += '<h4 style="margin:20px 0 10px">Weekly Breakdown</h4><div class="admin-form"><table style="width:100%;border-collapse:collapse">';
      html += '<tr style="border-bottom:2px solid var(--cream-dark)"><th style="text-align:left;padding:8px 0">Week</th><th style="text-align:right;padding:8px 0">Orders</th><th style="text-align:right;padding:8px 0">Revenue</th></tr>';
      monthly.weeklyBreakdown.forEach(w=>{
        html += `<tr style="border-bottom:1px solid var(--cream-dark)"><td style="padding:8px 0">${w.week}</td><td style="text-align:right">${w.orders}</td><td style="text-align:right">RM ${w.revenue.toLocaleString()}</td></tr>`;
      });
      html += '</table></div>';
    }
    html += `<button class="pos-btn pos-btn-primary" id="btnCopyMonthlyReport" style="margin-top:16px">📋 Copy Monthly Report</button>`;
  }

  // Restock Shopping List
  html += `<h3 style="margin:24px 0 14px;color:var(--primary)">🛒 Restock Shopping List</h3>
    <button class="pos-btn pos-btn-primary" id="btnLoadRestock">Load Restock List</button>
    <div id="restockResult"></div>`;

  // Discount & Offset Summary
  if(discounts){
    // Types are the values `discountType` can take on stored orders.
    // Add MINISTRY_PREORDER (free ministry pre-order drinks) and VOUCHER
    // (redeemed voucher offsets) alongside the classic cashier discounts.
    const types = ['NEWCOMER','STAFF','PASTOR','CELEBRATION','MINISTRY_PREORDER','VOUCHER'];
    const labelFor = t => ({
      NEWCOMER: 'Newcomer',
      STAFF: 'Staff',
      PASTOR: 'Pastor',
      CELEBRATION: 'Celebration',
      MINISTRY_PREORDER: 'Ministry Pre-Order',
      VOUCHER: 'Voucher',
    })[t] || (t.charAt(0)+t.slice(1).toLowerCase());
    const summary = discounts.summary || {};
    html += `<h3 style="margin:32px 0 14px;color:var(--primary)">💰 Discount & Offset Summary</h3>`;
    html += '<div class="admin-form"><table style="width:100%;border-collapse:collapse">';
    html += '<tr style="border-bottom:2px solid var(--cream-dark)"><th style="text-align:left;padding:8px 0">Type</th><th style="text-align:right;padding:8px 0">Orders</th><th style="text-align:right;padding:8px 0">Total Offset (RM)</th></tr>';
    types.forEach(t=>{
      const d = summary[t] || {count:0, totalOffset:0};
      html += `<tr style="border-bottom:1px solid var(--cream-dark)"><td style="padding:8px 0">${labelFor(t)}</td><td style="text-align:right">${d.count}</td><td style="text-align:right">${d.totalOffset}</td></tr>`;
    });
    html += `<tr style="border-top:2px solid var(--cream-dark);font-weight:700"><td style="padding:8px 0">Total</td><td style="text-align:right">${discounts.totalDiscountedOrders||0}</td><td style="text-align:right">${discounts.totalOffset||0}</td></tr>`;
    html += '</table></div>';
    html += `<button class="pos-btn pos-btn-sm" id="btnCopyDiscounts" style="margin-top:12px">📋 Copy</button>`;
  }

  html += '</div>';
  container.innerHTML = html;

  // Copy weekly report handler
  if(weekly && weekly.totals){
    const btn = container.querySelector('#btnCopyWeeklyReport');
    if(btn) btn.onclick = ()=>{
      const t = weekly.totals;
      const topStr = (weekly.topItems||[]).map(i=>`${stripLeadingEmoji(i.name)} (${i.count})`).join(', ');
      const text = `📊 Weekly Report (${fmtDate(weekly.startDate)} - ${fmtDate(weekly.endDate)})\nTotal Orders: ${t.totalOrders} | Revenue: RM ${t.totalRevenue.toFixed(0)}\nTop Items: ${topStr}`;
      navigator.clipboard.writeText(text).then(()=>showSuccess('Report copied to clipboard'));
    };
  }

  if(monthly){
    const btn = container.querySelector('#btnCopyMonthlyReport');
    if(btn) btn.onclick = ()=>{
      const topStr = (monthly.topItems||[]).map(i=>`${stripLeadingEmoji(i.name)} (${i.count})`).join(', ');
      const text = `📊 RLC Café Monthly Report (${monthly.period})\n━━━━━━━━━━━━━━━━━━━━━━\nOrders: ${monthly.totalOrders} | Revenue: RM ${monthly.totalRevenue.toLocaleString()}\nNet Collection: RM ${monthly.netCollection.toLocaleString()} (offsets: RM ${monthly.totalOffsets.toLocaleString()})\nNewcomers Served: ${monthly.newcomersServed} 🎉\nService Days: ${monthly.serviceDays} | Avg: ${monthly.avgOrdersPerServiceDay} orders/day\n\nTop Items: ${topStr}`;
      navigator.clipboard.writeText(text).then(()=>showSuccess('Monthly report copied to clipboard'));
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
        items.forEach(i=>{ text+=`- ${stripLeadingEmoji(i.name)}: need ${i.suggestedRestock}${i.unit} (currently ${i.currentStock}${i.unit})\n`; });
        navigator.clipboard.writeText(text).then(()=>showSuccess('Copied to clipboard'));
      };
    } catch(e){ div.innerHTML='<p style="color:var(--warning)">Failed to load restock list</p>'; }
  };

  // Copy discount summary handler
  if(discounts && container.querySelector('#btnCopyDiscounts')){
    const types = ['NEWCOMER','STAFF','PASTOR','CELEBRATION','MINISTRY_PREORDER','VOUCHER'];
    const labelFor = t => ({
      NEWCOMER: 'Newcomer',
      STAFF: 'Staff',
      PASTOR: 'Pastor',
      CELEBRATION: 'Celebration',
      MINISTRY_PREORDER: 'Ministry Pre-Order',
      VOUCHER: 'Voucher',
    })[t] || (t.charAt(0)+t.slice(1).toLowerCase());
    const summary = discounts.summary || {};
    container.querySelector('#btnCopyDiscounts').onclick=()=>{
      let text = '💰 Discount Summary\n';
      types.forEach(t=>{
        const d = summary[t] || {count:0, totalOffset:0};
        text += `${labelFor(t)}: ${d.count} orders, RM ${d.totalOffset} offset\n`;
      });
      text += `Total: ${discounts.totalDiscountedOrders||0} orders, RM ${discounts.totalOffset||0} offset`;
      navigator.clipboard.writeText(text).then(()=>showSuccess('Copied to clipboard'));
    };
  }
}

// --- Helpers ---
function showSuccess(msg){
  const b=$('#errorBanner');
  b.textContent=msg;
  b.style.background='var(--success)';
  b.classList.add('show');
  setTimeout(()=>{ b.classList.remove('show'); b.style.background=''; },3000);
}

