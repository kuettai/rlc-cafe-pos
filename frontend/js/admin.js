// admin.js — Shell: auth, sidebar, tab routing, shared helpers
// Part of rlc-cafe-pos v1.52.0 file split
// Depends on: config.js (API_BASE)
// Required by: admin-dashboard.js, admin-menu.js, admin-ingredients.js,
//              admin-checklist.js, admin-vouchers.js, admin-preorder.js

const $ = s => document.querySelector(s);
const app = $('#app');
let token = localStorage.getItem('pos_token');
let currentUser = localStorage.getItem('pos_user') || '';

/**
 * Show an admin form in a modal.
 *
 * Default width is 900px for EVERY admin form. It began as a 600px default with
 * an opt-in override for the Menu form, but the same cramping showed up again in
 * the pre-order form (checkbox lists of drinks and options) — the forms in this
 * app are wide by nature, so the wide value is the sensible default rather than
 * something each caller has to remember to ask for.
 *
 * @param {HTMLElement} form
 * @param {Object} [opts]
 * @param {String} [opts.maxWidth='900px'] Per-form override, still available for
 *   a genuinely narrow dialog.
 */
function showFormModal(form, opts){
  const overlay = document.createElement('div');
  overlay.className = 'pos-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'pos-modal';
  // min() so a wide form still fits a narrow screen without overflowing.
  modal.style.maxWidth = `min(${(opts && opts.maxWidth) || '900px'}, calc(100vw - 32px))`;
  modal.style.width = '100%';
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

/**
 * HTML escaping — the ONE escaper for every admin module.
 *
 * It lives here because admin.js is the first admin script on the page, so any
 * admin-*.js can call it at render time without depending on script order. It
 * replaced three identical copies: `escapeHtml` / `escapeAttr` in
 * admin-vouchers.js — which loads AFTER most of the modules that called it, so
 * every one of those calls was relying on cross-file function hoisting — and
 * `mfEsc` in admin-menu.js, which existed only to work around that ordering.
 *
 * ONE function is correct for both places admin-entered text lands, because it
 * escapes all five characters:
 *   - a TEXT NODE needs `&` `<` `>`;
 *   - an ATTRIBUTE VALUE needs `"` and `'` as well, and that is the bug this
 *     actually guards. A checklist label of `5" cup` in `value="${label}"`
 *     closes the attribute early and mangles the rest of the row's markup —
 *     which the v1.71.0 checklist reordering made easy to hit, since a reorder
 *     rerenders every row.
 *
 * The attribute must still be QUOTED at the call site; nothing here can rescue
 * an unquoted one.
 */
function escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/** Same escaping as escapeHtml — a name that reads correctly at an attribute. */
function escapeAttr(s){ return escapeHtml(s); }

/**
 * Malaysia-time dates — the ONE place the admin bundle converts.
 *
 * The café runs on Malaysian wall-clock time (UTC+8, no DST), so every "what
 * day is it" decision has to be made in MYT. Eight sites across admin-*.js
 * derived today from `new Date().toISOString()`, which is UTC: before 08:00 MYT
 * the whole admin was a day behind. The worst of them was the pre-order form,
 * which computed next Sunday from the machine's LOCAL day and then serialised
 * through UTC, so a link created between midnight and 08:00 got a Saturday
 * `serviceDate`.
 *
 * Mirrors `malaysiaToday` / `malaysiaClock` in `backend/src/lib/date.ts`, which
 * stays the source of truth for anything the backend decides. This is the
 * frontend admin bundle's copy for the same reason the escaper is per-bundle:
 * there is no shared frontend util module, and adding one costs a new `SHELL`
 * entry plus a script tag on every page. `pos.js` carries its own `mytDate()`
 * for the POS bundle.
 */
const ADMIN_MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Today's calendar date in MYT as YYYY-MM-DD. */
function mytToday(now){
  return new Date((now ? now.getTime() : Date.now()) + ADMIN_MYT_OFFSET_MS)
    .toISOString().slice(0, 10);
}

/**
 * Calendar arithmetic on a YYYY-MM-DD string, with no timezone in it at all.
 * Anchored at explicit UTC midnight, so these are safe on any machine and are
 * the right tool once `mytToday()` has decided what "today" is.
 */
function isoAddDays(dateIso, days){
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Day of week of a YYYY-MM-DD calendar date, 0 = Sunday. */
function isoDayOfWeek(dateIso){ return new Date(`${dateIso}T00:00:00Z`).getUTCDay(); }

/** A MYT calendar date as "Sun 24 Aug", read at explicit UTC midnight so the
 *  machine's own timezone cannot shift the weekday. */
const ADMIN_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const ADMIN_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function mytDayLabel(dateIso){
  if(!dateIso) return '';
  const d = new Date(`${dateIso}T00:00:00Z`);
  if(!Number.isFinite(d.getTime())) return dateIso;
  return `${ADMIN_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${ADMIN_MONTHS[d.getUTCMonth()]}`;
}

// ─── Unsaved work: ONE guard for the whole admin ──────────────────────
//
// The admin had no dirty tracking of any kind: `loadTab()` replaces
// `#adminContent`, so tapping another sidebar tab discarded every pending
// Checklist or Settings edit silently, with no warning and nothing to recover
// from. The explicit-Save model stays — nothing here writes anything.
//
// A tab OPTS IN by calling `watchUnsaved()` with a `read()` that snapshots its
// editable state and a `count(baseline, current)` that says how many changes
// that represents. Diffing against a baseline (rather than setting a flag on
// first keystroke) is what makes the guard stay quiet when an edit is typed and
// then undone.
let _unsaved = null;   // { tab, label, read, count, save, baseline }

// `baseline` is explicit for a tab that re-renders itself in place (the
// Checklist rebuilds its whole DOM on every reorder), where snapshotting at
// registration time would silently re-baseline and lose the pending count.
function watchUnsaved({ tab, label, read, count, save, baseline }){
  _unsaved = {
    tab, label: label || tab, read, count: count || countLeafChanges, save,
    baseline: baseline !== undefined ? baseline : read(),
  };
  renderUnsavedIndicators();
}

/**
 * Re-baseline after a successful save — that work is no longer at risk.
 *
 * `keys` re-baselines only part of the snapshot, which the Settings tab needs:
 * it has two independent Save buttons, and saving the pre-order templates must
 * not quietly mark a pending café-status edit as written.
 */
function markUnsavedSaved(keys){
  if(_unsaved){
    const current = _unsaved.read();
    if(!keys) _unsaved.baseline = current;
    else for(const k of keys) _unsaved.baseline[k] = current[k];
  }
  renderUnsavedIndicators();
}

/** Drop the watch (tab left, or its state deliberately discarded). */
function clearUnsaved(tab){
  if(_unsaved && (!tab || _unsaved.tab === tab)) _unsaved = null;
  renderUnsavedIndicators();
}

/** How many pending changes the watched tab is holding. 0 when nothing differs. */
function unsavedCount(){
  if(!_unsaved) return 0;
  try{ return _unsaved.count(_unsaved.baseline, _unsaved.read()) || 0; }
  catch(e){ return 0; }   // a half-rendered tab must never block navigation
}

function unsavedLabel(n){ return `${n} unsaved change${n === 1 ? '' : 's'}`; }

/**
 * Generic change count: leaves that differ between two snapshots. Suits a flat
 * settings object and nested arrays whose order is not itself meaningful. A tab
 * whose rows can be reordered supplies its own counter instead (see
 * admin-checklist.js) — index-wise diffing would report a reorder as a dozen
 * changes.
 */
function countLeafChanges(a, b){
  if(a === b) return 0;
  const aObj = a && typeof a === 'object', bObj = b && typeof b === 'object';
  if(!aObj || !bObj) return String(a) === String(b) ? 0 : 1;
  if(Array.isArray(a) || Array.isArray(b)){
    const av = Array.isArray(a) ? a : [], bv = Array.isArray(b) ? b : [];
    let n = Math.abs(av.length - bv.length);
    for(let i = 0; i < Math.min(av.length, bv.length); i++) n += countLeafChanges(av[i], bv[i]);
    return n;
  }
  let n = 0;
  for(const k of new Set([...Object.keys(a), ...Object.keys(b)])) n += countLeafChanges(a[k], b[k]);
  return n;
}

/** The warning dot on the tab holding unsaved work, plus any live save bar. */
function renderUnsavedIndicators(){
  const n = unsavedCount();
  app.querySelectorAll('.sidebar-nav button[data-tab]').forEach(btn=>{
    const dot = btn.querySelector('.nav-dot');
    if(!dot) return;
    const on = !!(_unsaved && _unsaved.tab === btn.dataset.tab && n > 0);
    dot.hidden = !on;
    if(on) dot.title = unsavedLabel(n);
  });
  const bar = document.querySelector('[data-save-state]');
  if(bar && typeof bar._render === 'function') bar._render(n);
}

/**
 * Run `proceed` — but if the watched tab is holding changes, ask first.
 *
 * Deliberately a modal: it is the one moment where continuing destroys work,
 * and the alternative (a toast you can tap past) is what we are fixing.
 */
function guardUnsaved(proceed){
  const n = unsavedCount();
  if(!n){ clearUnsaved(); proceed(); return; }
  const tabName = _unsaved.label;
  const canSave = typeof _unsaved.save === 'function';
  const overlay = document.createElement('div');
  overlay.className = 'admin-guard-overlay';
  overlay.innerHTML = `<div class="admin-guard" role="dialog" aria-modal="true" aria-labelledby="guardTitle">
    <h3 id="guardTitle">Leave without saving?</h3>
    <p><strong>${n}</strong> unsaved change${n === 1 ? '' : 's'} on the ${escapeHtml(tabName)} tab.
       Nothing has been written yet — leaving now loses ${n === 1 ? 'it' : 'them'}.</p>
    <div class="admin-guard-actions">
      <button class="pos-btn pos-btn-primary pos-btn-sm" data-guard="stay">Keep editing</button>
      ${canSave ? '<button class="pos-btn pos-btn-sm" data-guard="save">Save, then leave</button>' : ''}
      <button class="pos-btn pos-btn-sm admin-danger-quiet" data-guard="discard">Discard ${n}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-guard="stay"]').focus();

  const close = ()=> overlay.remove();
  overlay.onclick = e => { if(e.target === overlay) close(); };
  overlay.querySelector('[data-guard="stay"]').onclick = close;
  overlay.querySelector('[data-guard="discard"]').onclick = ()=>{
    close(); clearUnsaved(); proceed();
  };
  const saveBtn = overlay.querySelector('[data-guard="save"]');
  if(saveBtn) saveBtn.onclick = async()=>{
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    // Only leave if the save actually landed — otherwise the guard was the last
    // thing standing between the operator and losing the work.
    const ok = await Promise.resolve(_unsaved.save()).catch(()=>false);
    if(ok === false){ saveBtn.disabled = false; saveBtn.textContent = 'Save, then leave'; return; }
    close(); clearUnsaved(); proceed();
  };
}

// Reload / close / back. The browser shows its own wording here; all we control
// is whether it asks at all.
window.addEventListener('beforeunload', e => {
  if(unsavedCount() > 0){ e.preventDefault(); e.returnValue = ''; }
});

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
//
// The 14 destinations are chunked into three labelled groups so the list reads
// as three decisions rather than one wall, and — the part that actually
// mattered at 1024x768 — the identity row and the footer are PINNED flex
// children while only `.sidebar-nav` scrolls. See the comment on
// `.admin-sidebar` in admin.css for the measurements.
const ADMIN_NAV = [
  ['Sunday', [
    ['dashboard', '📊', 'Dashboard'],
    ['menu',      '🍽️', 'Menu'],
    ['checklist', '✅', 'Checklist'],
    ['reports',   '📈', 'Reports'],
  ]],
  ['Setup', [
    ['ingredients', '🧪', 'Ingredients'],
    ['planogram',   '📷', 'Planogram'],
    ['display',     '📺', 'Display'],
    ['verses',      '✝️', 'Verses'],
    ['settings',    '⚙️', 'Settings'],
  ]],
  ['People &amp; links', [
    ['users',     '👥', 'Users'],
    ['vouchers',  '🎟️', 'Vouchers'],
    ['preorder',  '🔗', 'Pre-Order Links'],
    ['stafflink', '🎫', 'Staff Link'],
    ['customers', '👤', 'Customers'],
  ]],
];

function navGroupsHtml(){
  return ADMIN_NAV.map(([label, items], gi) => {
    const id = `navGroup${gi}`;
    return `<p class="sidebar-group-label" id="${id}">${label}</p>
    <div class="sidebar-group" role="group" aria-labelledby="${id}">
      ${items.map(([tab, ico, text]) => `<button data-tab="${tab}"${tab === currentTab ? ' class="active"' : ''}>
        <span class="nav-ico" aria-hidden="true">${ico}</span><span class="nav-txt">${text}</span>
        <span class="nav-dot" hidden></span>
      </button>`).join('')}
    </div>`;
  }).join('');
}

function renderApp(){
  app.innerHTML = `<aside class="admin-sidebar" id="adminSidebar">
  <div class="sidebar-top">
    <span class="sidebar-who">
      <span class="sidebar-who-name">👤 ${escapeHtml(currentUser)}</span>
      <span class="sidebar-who-role">Admin</span>
    </span>
    <button class="sidebar-close" id="sidebarClose" aria-label="Close menu">✕</button>
  </div>
  <nav class="sidebar-nav" aria-label="Admin sections">
    ${navGroupsHtml()}
  </nav>
  <div class="sidebar-footer">
    <a href="pos" class="pos-btn pos-btn-sm" style="text-decoration:none;display:flex;align-items:center;justify-content:center">Go to POS →</a>
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
      if(btn.dataset.tab === currentTab) return;
      // Switching tab replaces #adminContent, which is where unsaved edits live.
      guardUnsaved(()=>{
        app.querySelectorAll('.sidebar-nav button').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        currentTab = btn.dataset.tab;
        loadTab();
        if(window.innerWidth < 900){
          document.getElementById('adminSidebar').classList.remove('open');
          document.getElementById('adminOverlay').style.display='';
        }
      });
    };
  });
  app.querySelector('.nav-logout').onclick = ()=> guardUnsaved(logout);
  loadTab();
}

function loadTab(){
  const c = $('#adminContent');
  // Whatever was being edited is gone with the container. By here the guard has
  // already had its say (kept, saved or discarded), so drop the watch and let
  // the incoming tab register its own.
  clearUnsaved();
  switch(currentTab){
    case 'dashboard': loadDashboard(c); break;
    case 'menu': loadMenu(c); break;
    case 'users': loadUsers(c); break;
    case 'ingredients': loadIngredients(c); break;
    case 'checklist': loadChecklist(c); break;
    case 'planogram': loadPlanogram(c); break;
    case 'vouchers': loadVouchers(c); break;
    case 'preorder': loadPreorderCodes(c); break;
    case 'stafflink': loadStaffLink(c); break;
    case 'display': loadDisplay(c); break;
    case 'customers': loadCustomers(c); break;
    case 'reports': loadReportsTab(c); break;
    case 'settings': loadSettings(c); break;
    case 'verses': loadVerses(c); break;
  }
}

// --- Reports (mounted in-page, like every other tab) ---
// Two earlier approaches were wrong: an iframe of reports.html duplicated its
// header and sidebar inside admin's chrome, and navigating away broke the
// single-page pattern the other tabs follow.
//
// reports.js now exposes RLCReports.mount(host), so the same code renders both
// the standalone page and this tab. reports.html remains reachable directly.
function loadReportsTab(container) {
  if (!window.RLCReports || typeof window.RLCReports.mount !== 'function') {
    // Script missing (cache miss, or not in the sw.js SHELL yet) — offer the
    // standalone page rather than showing an empty tab.
    container.innerHTML = '<div class="admin-empty"><p>Reports module failed to load. '
      + '<a href="reports.html">Open Reports directly</a></p></div>';
    return;
  }
  container.innerHTML = '';
  window.RLCReports.mount(container);
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
            <div class="admin-card-title">${escapeHtml(u.name||u.userId)}</div>
            <div class="admin-card-subtitle">${u.lastLoginAt ? 'Last login: '+new Date(u.lastLoginAt).toLocaleString() : 'Never logged in'}</div>
          </div>
          <div class="admin-card-actions">
            <span class="admin-card-badge ${badge}">${escapeHtml(u.role)}</span>
            <span class="admin-card-badge ${u.isActive!==false?'badge-active':'badge-inactive'}">${u.isActive!==false?'Active':'Inactive'}</span>
            <button class="pos-btn pos-btn-sm" data-edit-user="${escapeAttr(u.userId)}">Edit</button>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-user="${escapeAttr(u.userId)}">Delete</button>
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
      <div class="admin-form-group"><label>Name</label><input id="ufName" class="pos-input" value="${escapeAttr(user?.name||'')}"></div>
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
    // escapeAttr matters here for a mundane reason as well as safety: a
    // presigned S3 URL is full of `&`, and an unescaped one in an attribute is
    // an ambiguous ampersand the parser may decode as an entity.
    if(data.url) el.innerHTML = `<img src="${escapeAttr(data.url)}" style="max-width:100%;max-height:200px;border-radius:var(--radius);border:1px solid var(--cream-dark)"><p style="font-size:.75rem;color:var(--text-light);margin-top:4px">Uploaded: ${new Date(data.uploadedAt).toLocaleDateString()}</p>`;
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
          <!-- Uses the admin toggle-switch component, not pos-switch: one
               switch across the whole admin, and it carries the 44px hit area. -->
          <label class="toggle-switch" title="Celebration mode — all eligible drinks at the flat price">
            <input type="checkbox" id="setCelebration" ${settings.celebrationMode?'checked':''} aria-label="Celebration mode">
            <span class="toggle-slider"></span>
          </label>
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
      markUnsavedSaved(['cafeStatus','celebrationMode','celebrationPrice',
                        'orderExpiryMinutes','archiveAfterMinutes']);
    } catch(e){ showError('Failed to save settings'); }
  };

  // Pre-Order Templates block (loaded via loadSettings). Skipped when the
  // template endpoint returned null (failure) so the main settings page
  // stays usable even if the templates row is broken.
  if (templates) {
    renderPreorderTemplatesSection(container.querySelector('#preorderTemplatesSection'), templates);
  }

  // ─── Unsaved-work watch ─────────────────────────────────────────────
  // Both save buttons on this tab stay exactly as they were; this only makes
  // leaving the tab with pending edits ask first. Registered AFTER the
  // templates block so its inputs exist for the baseline snapshot.
  const readSettingsState = ()=>{
    const q = sel => container.querySelector(sel);
    const optCbs = [...container.querySelectorAll('#tplOptionList input[data-tpl-opt]')];
    return {
      cafeStatus: q('#setCafeStatus') ? q('#setCafeStatus').value : '',
      celebrationMode: !!(q('#setCelebration') && q('#setCelebration').checked),
      celebrationPrice: q('#setCelebrationPrice') ? q('#setCelebrationPrice').value : '',
      orderExpiryMinutes: q('#setExpiry') ? q('#setExpiry').value : '',
      archiveAfterMinutes: q('#setArchive') ? q('#setArchive').value : '',
      bannerMessage: q('#tplBanner') ? q('#tplBanner').value : '',
      eligibleItemKeywords: _preorderTplKeywords.slice(),
      collectionOptions: _preorderTplCollectionOpts.slice(),
      // The excluded-option checkboxes are rendered by an async menu fetch, so
      // before it lands fall back to the saved value — the same reasoning as the
      // save handler's "an unrendered list is not an empty list". Sorted because
      // the render orders by price while the stored array does not, and a
      // reordering is not a change.
      excludedOptions: (optCbs.length
        ? optCbs.filter(cb => cb.checked).map(cb => cb.dataset.tplOpt)
        : (templates && Array.isArray(templates.excludedOptions) ? templates.excludedOptions : [])
      ).slice().sort(),
    };
  };
  // No `save` here on purpose: this tab has TWO independent Save buttons
  // (Settings and Templates) and the guard must not decide to write both.
  watchUnsaved({ tab:'settings', label:'Settings', read: readSettingsState });
  container.addEventListener('input', renderUnsavedIndicators);
  container.addEventListener('change', renderUnsavedIndicators);
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

      <div class="admin-form-group">
        <label>Excluded Options (default)</label>
        <p style="font-size:.75rem;color:var(--text-light);margin:2px 0 6px">Options pre-ticked as blocked on a NEW link — e.g. Oat Milk, which is free on pre-orders and costly. Each link can still be adjusted individually.</p>
        <div id="tplOptionList" style="max-height:200px;overflow-y:auto;border:1px solid var(--cream-dark);border-radius:8px;padding:8px 12px;background:var(--card)">
          <div class="loading">Loading options…</div>
        </div>
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
        <button type="button" class="pos-btn pos-btn-sm admin-danger-quiet" data-kw-remove="${i}" aria-label="Remove keyword">✕</button>
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
        <button type="button" class="pos-btn pos-btn-sm admin-danger-quiet" data-opt-remove="${i}" aria-label="Remove option" ${_preorderTplCollectionOpts.length <= 1 ? 'disabled title="Need at least one option"' : ''}>✕</button>
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

  // ─── Excluded options (default for new links) ──────────────────────
  // Checkbox list of every distinct "Group:Option" across the active drinks,
  // deduplicated: Oat Milk appears on several drinks but is one choice here.
  // Fetched separately because the settings tab does not otherwise load the menu.
  const tplExcluded = new Set(
    (Array.isArray(templates.excludedOptions) ? templates.excludedOptions : []).map(String)
  );
  api('GET', '/api/admin/menu').then(data => {
    const listEl = host.querySelector('#tplOptionList');
    if (!listEl) return;
    const items = (Array.isArray(data) ? data : data.items || [])
      .filter(m => m.category === 'DRINK' && m.isActive !== false);

    const seen = new Map();   // key -> { group, option, price, type, items[] }
    for (const m of items) {
      for (const g of (Array.isArray(m.variantGroups) ? m.variantGroups : [])) {
        for (const o of (Array.isArray(g.options) ? g.options : [])) {
          const group = String(g.group || '').trim();
          const option = String(o.name || '').trim();
          if (!group || !option) continue;
          const key = `${group}:${option}`;
          const e = seen.get(key) || { group, option, price: Number(o.price || 0), type: g.type || 'single', items: [] };
          e.items.push(m.name || '');
          seen.set(key, e);
        }
      }
    }

    if (!seen.size) {
      listEl.innerHTML = '<div style="color:var(--text-light);padding:4px 0">No drink options in the menu.</div>';
      return;
    }

    // Paid options first — those are the ones that cost the café on a free
    // pre-order, so they are what an admin is looking for.
    const entries = [...seen.entries()].sort((a, b) =>
      (b[1].price - a[1].price) || a[0].localeCompare(b[0]));

    listEl.innerHTML = entries.map(([key, e]) => {
      const priceTag = e.price ? ` <span style="color:var(--text-light);font-size:.85rem">+RM ${e.price.toFixed(2)}</span>` : '';
      const onWhat = e.items.length > 2 ? `${e.items.length} drinks` : e.items.map(escapeHtml).join(', ');
      // The whole row is the hit area — the bare checkbox was 13px wide, 32 of
      // them, on a tablet.
      return `<label class="admin-check-row">
        <input type="checkbox" data-tpl-opt="${escapeAttr(key)}" data-tpl-type="${escapeAttr(e.type)}" data-tpl-group="${escapeAttr(e.group)}"${tplExcluded.has(key) ? ' checked' : ''}>
        <span>${escapeHtml(e.group)}: <strong>${escapeHtml(e.option)}</strong>${priceTag}
          <span style="color:var(--text-light);font-size:.8rem"> — ${onWhat}</span></span>
      </label>`;
    }).join('');
  }).catch(() => {
    const listEl = host.querySelector('#tplOptionList');
    // A menu fetch failure must not make the rest of the form unusable, but the
    // checkboxes are the only record of the saved value, so warn rather than
    // silently saving an empty list.
    if (listEl) listEl.innerHTML = '<div style="color:var(--danger);padding:4px 0">Could not load drink options — saving now would leave this list unchanged.</div>';
  });

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

    // The checkboxes ARE the value, so an unrendered list (menu fetch failed)
    // must not be read as "block nothing" — that would silently wipe the saved
    // default. Fall back to what was loaded instead.
    const optCbs = [...host.querySelectorAll('#tplOptionList input[data-tpl-opt]')];
    const excludedOptions = optCbs.length
      ? optCbs.filter(cb => cb.checked).map(cb => cb.dataset.tplOpt)
      : (Array.isArray(templates.excludedOptions) ? templates.excludedOptions : []);

    // A `single` group must keep one option: excluding every choice in e.g.
    // Temperature would make the drink unorderable on every new link. Mirrors
    // the same guard on the per-link form.
    const byGroup = {};
    for (const cb of optCbs) {
      const g = cb.dataset.tplGroup;
      (byGroup[g] = byGroup[g] || { type: cb.dataset.tplType, total: 0, excluded: 0 });
      byGroup[g].total++;
      if (cb.checked) byGroup[g].excluded++;
    }
    for (const [g, info] of Object.entries(byGroup)) {
      if (info.type === 'single' && info.total > 0 && info.excluded === info.total) {
        showError(`"${g}" is a required choice — leave at least one option available`);
        return;
      }
    }

    try {
      await api('PUT', '/api/admin/settings/preorder-templates', {
        bannerMessage, eligibleItemKeywords, collectionOptions, excludedOptions,
      });
      showSuccess('Templates saved');
      markUnsavedSaved(['bannerMessage','eligibleItemKeywords',
                        'collectionOptions','excludedOptions']);
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
    <h3 style="margin-bottom:14px;color:var(--brand-ink)">Today's Summary — ${daily.date||'—'}</h3>
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
    html += '<h3 style="margin:24px 0 14px;color:var(--brand-ink)">Session Comparison</h3>';
    html += `<div style="display:flex;gap:16px;flex-wrap:wrap">${sessionCard('Session 1 (10:15-11:30)',s1,s1Better)}${sessionCard('Session 2 (12:45-13:30)',s2,s2Better)}</div>`;
  }

  if(popular.length){
    html += '<h3 style="margin:24px 0 14px;color:var(--brand-ink)">Popular Items Today</h3>';
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
    html += `<h3 style="margin:32px 0 14px;color:var(--brand-ink)">Weekly Report — ${fmtDate(weekly.startDate)} to ${fmtDate(weekly.endDate)}</h3>
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
    html += `<h3 style="margin:32px 0 14px;color:var(--brand-ink)">📊 Monthly Summary — ${monthly.period}</h3>
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
  html += `<h3 style="margin:24px 0 14px;color:var(--brand-ink)">🛒 Restock Shopping List</h3>
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
    html += `<h3 style="margin:32px 0 14px;color:var(--brand-ink)">💰 Discount & Offset Summary</h3>`;
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

