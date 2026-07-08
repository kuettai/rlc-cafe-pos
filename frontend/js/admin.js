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
    <button id="navReports" type="button">📈 Reports</button>
    <button data-tab="settings">⚙️ Settings</button>
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
    case 'settings': loadSettings(c); break;
    // Historical reports (weekly/monthly) live on reports.html — sidebar
    // link `navReports` handles that navigation directly.
  }
}

// --- Dashboard ---
// Today-only operational view. Historical/weekly/monthly analytics live on
// reports.html (linked from the sidebar's "📈 Reports" button).
async function loadDashboard(container){
  container.innerHTML = '<div class="loading">Loading dashboard...</div>';
  await fetchAndRenderDashboard(container);
}

async function fetchAndRenderDashboard(container){
  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const [daily, sessions, discounts, ingredients, checklistLogs, stockHistory] = await Promise.all([
      api('GET','/api/admin/reports/daily'),
      api('GET','/api/admin/reports/sessions'),
      api('GET','/api/admin/reports/discounts'),
      api('GET','/api/pos/ingredients'),
      // Activity trail sources — /checklist/logs returns all logs, we
      // filter to today client-side. /stock-history?date= returns snapshots
      // for one date; missing endpoints return safe empty results.
      api('GET','/api/admin/checklist/logs').catch(() => ({ logs: [] })),
      api('GET', `/api/admin/stock-history?date=${encodeURIComponent(todayIso)}`).catch(() => ({ snapshots: [] })),
    ]);
    renderDashboard(container, { daily, sessions, discounts, ingredients, checklistLogs, stockHistory, todayIso });
  } catch(e){
    container.innerHTML = '<div class="admin-empty"><p>Failed to load dashboard</p></div>';
  }
}

function renderDashboard(container, data){
  const { daily, sessions, discounts, ingredients, checklistLogs, stockHistory, todayIso } = data;
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const allOrders = Array.isArray(daily?.orders) ? daily.orders : [];
  const todaysOrders = allOrders.filter(o => (o.createdAt || '').startsWith(today));

  // ─── (a) Stats: derive counts from today's orders ───────────────────
  const c = { PENDING: 0, PREPARING: 0, READY: 0, ARCHIVED: 0, CANCELLED: 0, EXPIRED: 0 };
  for (const o of todaysOrders) if (c[o.status] !== undefined) c[o.status]++;
  const pending    = c.PENDING;
  const preparing  = c.PREPARING;
  const completed  = c.READY + c.ARCHIVED;
  const totalCard  = pending + preparing + completed; // excludes CANCELLED/EXPIRED
  const revenue    = Number(daily?.totalRevenue || 0);

  // ─── (b) Session comparison ────────────────────────────────────────
  const s1 = sessions?.session1 || {};
  const s2 = sessions?.session2 || {};
  const s1Rev = Number(s1.revenue || 0);
  const s2Rev = Number(s2.revenue || 0);
  const s1Highlight = s1Rev >= s2Rev && s1Rev > 0;
  const s2Highlight = s2Rev >  s1Rev;

  // ─── (c) Today's discounts table ───────────────────────────────────
  // Types shown in a fixed order; labels match POS discount badges.
  const discountTypes = [
    ['NEWCOMER',          'Newcomer'],
    ['STAFF',             'Staff'],
    ['PASTOR',            'Pastor'],
    ['CELEBRATION',       'Celebration'],
    ['MINISTRY_PREORDER', 'Pre-Order'],
    ['VOUCHER',           'Voucher'],
  ];
  const discountSummary = discounts?.summary || {};
  const totalDiscOrders = Number(discounts?.totalDiscountedOrders || 0);
  const totalDiscOffset = Number(discounts?.totalOffset || 0);

  // ─── (d) Top items today ───────────────────────────────────────────
  const itemCounts = {};
  for (const o of todaysOrders) {
    // Only count served items (avoid inflating with rejected/expired).
    if (o.status !== 'ARCHIVED' && o.status !== 'READY') continue;
    for (const it of o.items || []) {
      const name = stripLeadingEmoji(it.name || '?') || '(unknown)';
      const key = it.variant ? `${name} (${it.variant})` : name;
      itemCounts[key] = (itemCounts[key] || 0) + Number(it.quantity || it.qty || 1);
    }
  }
  const topItems = Object.entries(itemCounts)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 10);

  // ─── (e) Low stock alerts ──────────────────────────────────────────
  // Disabled ingredients are sorted to the bottom and tagged so the
  // operator can see them but knows they aren't in play.
  const ingList = ingredients?.ingredients || [];
  const lowStock = ingList
    .filter(i =>
      typeof i.lowStockThreshold === 'number' &&
      i.lowStockThreshold > 0 &&
      Number(i.currentStock || 0) <= i.lowStockThreshold
    )
    .sort((a, b) => {
      const aActive = a.isActive !== false ? 0 : 1;
      const bActive = b.isActive !== false ? 0 : 1;
      return aActive - bActive;
    });

  // ─── Compose HTML ──────────────────────────────────────────────────
  let html = `<div class="admin-section">
    <div class="admin-section-header" style="align-items:center">
      <h2>📊 Today's Dashboard</h2>
      <button class="pos-btn pos-btn-sm" id="btnDashboardRefresh" style="display:flex;align-items:center;gap:6px">🔄 Refresh</button>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px">
      <div class="admin-stat-card"><div class="stat-value">${totalCard}</div><div class="stat-label">Total Orders</div></div>
      <div class="admin-stat-card"><div class="stat-value">RM ${revenue.toFixed(2)}</div><div class="stat-label">Revenue</div></div>
      <div class="admin-stat-card"><div class="stat-value">${pending}</div><div class="stat-label">Pending</div></div>
      <div class="admin-stat-card"><div class="stat-value">${preparing}</div><div class="stat-label">Preparing</div></div>
      <div class="admin-stat-card"><div class="stat-value">${completed}</div><div class="stat-label">Completed</div></div>
    </div>

    <h3 style="margin:8px 0 12px;color:var(--primary)">⏱ Session Comparison</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:24px">
      ${sessionCardHtml('Session 1', '8:00 – 11:30 MYT', s1, s1Highlight)}
      ${sessionCardHtml('Session 2', '11:31 – 14:00 MYT', s2, s2Highlight)}
    </div>

    <h3 style="margin:8px 0 12px;color:var(--primary)">💰 Today's Discounts</h3>
    <div class="admin-form" style="margin-bottom:24px">
      <table style="width:100%;border-collapse:collapse">
        <tr style="border-bottom:2px solid var(--cream-dark)">
          <th style="text-align:left;padding:8px 0">Type</th>
          <th style="text-align:right;padding:8px 0">Orders</th>
          <th style="text-align:right;padding:8px 0">Offset (RM)</th>
        </tr>
        ${discountTypes.map(([key, label]) => {
          const row = discountSummary[key] || { count: 0, totalOffset: 0 };
          return `<tr style="border-bottom:1px solid var(--cream-dark)">
            <td style="padding:8px 0">${label}</td>
            <td style="text-align:right">${row.count}</td>
            <td style="text-align:right">${Number(row.totalOffset||0).toFixed(2)}</td>
          </tr>`;
        }).join('')}
        <tr style="border-top:2px solid var(--cream-dark);font-weight:700">
          <td style="padding:8px 0">Total</td>
          <td style="text-align:right">${totalDiscOrders}</td>
          <td style="text-align:right">${totalDiscOffset.toFixed(2)}</td>
        </tr>
      </table>
    </div>

    <h3 style="margin:8px 0 12px;color:var(--primary)">🏆 Top Items Today</h3>
    <div class="admin-form" style="margin-bottom:${lowStock.length ? '24px' : '0'}">
      ${topItems.length
        ? topItems.map(([name, qty], i) =>
            `<div style="padding:6px 0;${i < topItems.length-1 ? 'border-bottom:1px solid var(--cream-dark)' : ''}">
              ${i + 1}. ${escapeHtml(name)} — <strong>${qty}</strong> sold
            </div>`
          ).join('')
        : '<div style="color:var(--text-light);padding:8px 0">No items served yet today.</div>'}
    </div>

    ${lowStock.length ? `
      <h3 style="margin:8px 0 12px;color:var(--warning,#B45309)">⚠️ Low Stock</h3>
      <div class="admin-form">
        ${lowStock.map(i => {
          const disabled = i.isActive === false;
          return `<div style="padding:6px 0;border-bottom:1px solid var(--cream-dark);display:flex;justify-content:space-between;${disabled?'opacity:.55':''}">
            <span>${escapeHtml(stripLeadingEmoji(i.name))}${disabled ? ' <span class="admin-card-badge badge-disabled" style="margin-left:6px">Disabled</span>' : ''}</span>
            <span style="font-weight:600">${Number(i.currentStock||0)} ${escapeHtml(i.unit||'')} <span style="color:var(--text-light);font-weight:400">(threshold ${i.lowStockThreshold})${disabled ? ' · ingredient disabled' : ''}</span></span>
          </div>`;
        }).join('')}
      </div>
    ` : ''}

    ${activityLogHtml(checklistLogs, stockHistory, today)}
    ${latestSnapshotHtml(stockHistory)}
  </div>`;

  container.innerHTML = html;

  container.querySelector('#btnDashboardRefresh').onclick = () => {
    container.innerHTML = '<div class="loading">Refreshing...</div>';
    fetchAndRenderDashboard(container);
  };
}

function sessionCardHtml(name, timeRange, s, highlight){
  const revenue = Number(s?.revenue || 0);
  const count = Number(s?.orderCount || 0);
  const avg = Number(s?.avgOrderValue || 0);
  const top = (s?.topItems || [])[0];
  const topLabel = top ? `${stripLeadingEmoji(top.name || '')} (${top.count})` : '—';
  const border = highlight ? '2px solid var(--primary,#6B4226)' : '1px solid var(--cream-dark,#E7DFD5)';
  const bg = highlight ? 'linear-gradient(135deg,#FEF3C7 0%,#FEF9E7 100%)' : '#fff';
  return `<div class="admin-card" style="border:${border};background:${bg};padding:14px 16px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
      <div>
        <div class="admin-card-title">${name}${highlight ? ' 🏆' : ''}</div>
        <div class="admin-card-subtitle">${timeRange}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:.9rem">
      <div><span style="color:var(--text-light)">Orders:</span> <strong>${count}</strong></div>
      <div><span style="color:var(--text-light)">Revenue:</span> <strong>RM ${revenue.toFixed(2)}</strong></div>
      <div><span style="color:var(--text-light)">Avg:</span> <strong>RM ${avg.toFixed(2)}</strong></div>
      <div><span style="color:var(--text-light)">Top:</span> <strong>${escapeHtml(topLabel)}</strong></div>
    </div>
  </div>`;
}

// ─── Activity Log helpers (Dashboard) ────────────────────────────────

/** Derive completion time + user for a checklist phase log. Returns null
 *  when the phase isn't fully completed yet. Uses the LAST checked item's
 *  timestamp as the phase completion event — that's the moment the phase
 *  actually finished.  */
function phaseCompletion(log) {
  if (!log || log.allCompleted !== true) return null;
  const entries = Object.values(log.items || {})
    .filter(i => i && i.checked && i.completedAt);
  if (!entries.length) return null;
  entries.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  const last = entries[entries.length - 1];
  return { at: last.completedAt, by: last.completedBy || 'Unknown' };
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-MY', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Build the "Today's Activity" section. Merges completed checklist phases
 *  (open / handover / close) and stock-count snapshots into a chronological
 *  timeline. Empty state included so the section renders even on a quiet day. */
function activityLogHtml(checklistLogsRes, stockHistoryRes, today) {
  const logs = Array.isArray(checklistLogsRes?.logs) ? checklistLogsRes.logs : [];
  const todaysLogs = logs.filter(l => l.date === today);
  const byPhase = { open: null, handover: null, close: null };
  for (const l of todaysLogs) {
    if (l.phase in byPhase) byPhase[l.phase] = l;
  }

  const events = [];
  const map = [
    ['open',     '✅ Opened'],
    ['handover', '🔄 Handover'],
    ['close',    '❌ Closed'],
  ];
  for (const [phase, label] of map) {
    const c = phaseCompletion(byPhase[phase]);
    if (c) events.push({ at: c.at, label: `${label} at ${fmtTime(c.at)} by ${c.by}` });
  }

  const snapshots = Array.isArray(stockHistoryRes?.snapshots) ? stockHistoryRes.snapshots : [];
  for (const s of snapshots) {
    if (!s?.timestamp) continue;
    events.push({
      at: s.timestamp,
      label: `📦 Stock count at ${fmtTime(s.timestamp)} by ${s.submittedBy || 'Unknown'}`,
    });
  }

  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const body = events.length
    ? events.map(e => `<div style="padding:6px 0;border-bottom:1px solid var(--cream-dark)">${escapeHtml(e.label)}</div>`).join('')
    : '<div style="color:var(--text-light);padding:8px 0">No activity recorded today.</div>';

  return `
    <h3 style="margin:24px 0 12px;color:var(--primary)">📋 Today's Activity</h3>
    <div class="admin-form">${body}</div>`;
}

/** "Latest Stock Snapshot" section — only rendered when there's at least
 *  one snapshot from today. Shows the most recent snapshot's counts. */
function latestSnapshotHtml(stockHistoryRes) {
  const snapshots = Array.isArray(stockHistoryRes?.snapshots) ? stockHistoryRes.snapshots : [];
  if (!snapshots.length) return '';
  // /stock-history query returns snapshots newest-first; be defensive and re-sort.
  const sorted = snapshots.slice().sort((a, b) =>
    String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  const latest = sorted[0];
  const counts = Array.isArray(latest?.counts) ? latest.counts : [];
  if (!counts.length) return '';

  const rows = counts
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map(c => `<div style="padding:5px 0;border-bottom:1px solid var(--cream-dark);display:flex;justify-content:space-between">
      <span>${escapeHtml(stripLeadingEmoji(c.name || '?'))}</span>
      <span style="font-weight:600">${Number(c.count ?? 0)} ${escapeHtml(c.unit || '')}${c.storageLocation ? ` <span style="color:var(--text-light);font-weight:400">· ${escapeHtml(c.storageLocation)}</span>` : ''}</span>
    </div>`).join('');

  return `
    <h3 style="margin:24px 0 12px;color:var(--primary)">📦 Latest Stock Count <span style="font-weight:400;color:var(--text-light);font-size:.85rem">(${fmtTime(latest.timestamp)} by ${escapeHtml(latest.submittedBy || 'Unknown')})</span></h3>
    <div class="admin-form">${rows}</div>`;
}

// --- Menu Management ---
async function loadMenu(container){
  container.innerHTML = '<div class="loading">Loading menu...</div>';
  try{
    // Use admin endpoint so we see inactive items too
    const data = await api('GET','/api/admin/menu');
    const items = (Array.isArray(data) ? data : data.items || []);
    renderMenuSection(container, items);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load menu</p></div>'; }
}

// Persisted across re-renders so a toggle-active click (which reloads the
// menu list) doesn't reset the operator's filter selection.
let menuCategoryFilter = 'ALL';   // ALL | DRINK | FOOD
let menuStatusFilter   = 'ALL';   // ALL | ACTIVE | INACTIVE

function renderMenuSection(container, items){
  const filteredItems = items.filter(item => {
    if (menuCategoryFilter !== 'ALL' && item.category !== menuCategoryFilter) return false;
    const isActive = item.isActive !== false;
    if (menuStatusFilter === 'ACTIVE'   && !isActive) return false;
    if (menuStatusFilter === 'INACTIVE' &&  isActive) return false;
    return true;
  });

  const drinkCount   = items.filter(i => i.category === 'DRINK').length;
  const foodCount    = items.filter(i => i.category === 'FOOD').length;
  const activeCount  = items.filter(i => i.isActive !== false).length;
  const inactiveCount = items.length - activeCount;

  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Menu Items</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddMenu">+ Add Item</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <button class="pos-btn pos-btn-sm" id="btnEnableDrinks">✅ Enable All Drinks</button>
      <button class="pos-btn pos-btn-sm" id="btnEnableFood">✅ Enable All Food</button>
      <button class="pos-btn pos-btn-sm pos-btn-danger" id="btnDisableAll">❌ Disable All</button>
    </div>
    <div class="admin-filter-row">
      <span class="admin-filter-label">Category</span>
      <button class="pos-btn pos-btn-sm ${menuCategoryFilter==='ALL'?'pos-btn-primary':''}"   data-menu-cat="ALL">All (${items.length})</button>
      <button class="pos-btn pos-btn-sm ${menuCategoryFilter==='DRINK'?'pos-btn-primary':''}" data-menu-cat="DRINK">🥤 Drinks Only (${drinkCount})</button>
      <button class="pos-btn pos-btn-sm ${menuCategoryFilter==='FOOD'?'pos-btn-primary':''}"  data-menu-cat="FOOD">🍔 Foods Only (${foodCount})</button>
    </div>
    <div class="admin-filter-row" style="margin-bottom:16px">
      <span class="admin-filter-label">Status</span>
      <button class="pos-btn pos-btn-sm ${menuStatusFilter==='ALL'?'pos-btn-primary':''}"      data-menu-status="ALL">All</button>
      <button class="pos-btn pos-btn-sm ${menuStatusFilter==='ACTIVE'?'pos-btn-primary':''}"   data-menu-status="ACTIVE">✅ Enabled Only (${activeCount})</button>
      <button class="pos-btn pos-btn-sm ${menuStatusFilter==='INACTIVE'?'pos-btn-primary':''}" data-menu-status="INACTIVE">❌ Disabled Only (${inactiveCount})</button>
    </div>`;
  if(!items.length){
    html += '<div class="admin-empty"><p>No menu items yet</p></div>';
  } else if (!filteredItems.length){
    html += `<div class="admin-empty"><p>No items match the current filters.<br><button class="pos-btn pos-btn-sm" id="menuFilterReset" style="margin-top:8px">Reset filters</button></p></div>`;
  } else {
    filteredItems.forEach(item=>{
      const badge = item.category === 'DRINK' ? 'badge-drink' : 'badge-food';
      const variants = (item.variants||[]).map(v=>v.name||v).join(', ');
      const isActive = item.isActive !== false;
      const id = item.menuItemId || item.id;
      html += `<div class="admin-card ${isActive?'':'is-disabled'}">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${item.name}</div>
            <div class="admin-card-subtitle">RM ${(item.basePrice||0).toFixed(2)}${variants ? ' · '+variants : ''}</div>
          </div>
          <div class="admin-card-actions">
            <span class="admin-card-badge ${badge}">${item.category}</span>
            ${item.category==='DRINK' ? `<span class="admin-card-badge ${item.celebrationEligible===true?'badge-active':'badge-inactive'}">${item.celebrationEligible===true?'🎉 RM5':'No 🎉'}</span>` : ''}
            ${isActive ? '' : '<span class="admin-card-badge badge-disabled">Disabled</span>'}
            <label class="toggle-switch" title="${isActive?'Click to disable':'Click to enable'}">
              <input type="checkbox" data-toggle-menu="${id}" ${isActive?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
            <button class="pos-btn pos-btn-sm" data-edit-menu="${id}">Edit</button>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-menu="${id}">Delete</button>
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

  container.querySelectorAll('[data-menu-cat]').forEach(btn=>{
    btn.onclick = ()=>{
      menuCategoryFilter = btn.dataset.menuCat;
      renderMenuSection(container, items);
    };
  });
  container.querySelectorAll('[data-menu-status]').forEach(btn=>{
    btn.onclick = ()=>{
      menuStatusFilter = btn.dataset.menuStatus;
      renderMenuSection(container, items);
    };
  });
  const resetBtn = container.querySelector('#menuFilterReset');
  if (resetBtn) resetBtn.onclick = ()=>{
    menuCategoryFilter = 'ALL';
    menuStatusFilter = 'ALL';
    renderMenuSection(container, items);
  };

  container.querySelectorAll('[data-toggle-menu]').forEach(input=>{
    input.onchange = async()=>{
      const id = input.dataset.toggleMenu;
      // Optimistically disable to prevent double-click
      input.disabled = true;
      try{
        await api('PUT',`/api/admin/menu/${id}/toggle-active`, {});
        loadMenu(container);
      } catch(e){
        showError('Toggle failed');
        input.checked = !input.checked;
        input.disabled = false;
      }
    };
  });
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
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Celebration Eligible</label><select id="mfCelebration" class="pos-input"><option value="false" ${item?.celebrationEligible!==true?'selected':''}>No — always normal price</option><option value="true" ${item?.celebrationEligible===true?'selected':''}>Yes — RM5 on celebration day</option></select></div>
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
      celebrationEligible: form.querySelector('#mfCelebration').value === 'true',
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

let ingLocationFilter = 'ALL';

function renderIngredientsSection(container, items, menuItems, recipes){
  // Items marked BOTH appear under either Fridge or Storeroom filter (and ALL),
  // matching the POS stock-count filter behavior.
  const filtered = ingLocationFilter === 'ALL'
    ? items
    : items.filter(i => i.storageLocation === ingLocationFilter || i.storageLocation === 'BOTH');
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Ingredients</h2>
      <div style="display:flex;gap:8px">
        <button class="pos-btn pos-btn-sm" id="btnStockHistory">📋 Stock History</button>
        <button class="pos-btn pos-btn-primary" id="btnAddIngredient">+ Add Ingredient</button>
      </div>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:16px">
      <button class="pos-btn pos-btn-sm ${ingLocationFilter==='ALL'?'active':''}" data-ing-loc="ALL">All</button>
      <button class="pos-btn pos-btn-sm ${ingLocationFilter==='FRIDGE'?'active':''}" data-ing-loc="FRIDGE">🧊 Fridge</button>
      <button class="pos-btn pos-btn-sm ${ingLocationFilter==='STOREROOM'?'active':''}" data-ing-loc="STOREROOM">🗄️ Storeroom</button>
    </div>`;
  if(!filtered.length){
    html += '<div class="admin-empty"><p>No ingredients in this location</p></div>';
  } else {
    // Sort: active first, disabled at the bottom. Within each group, keep
    // the DB order so the admin can still spot low-stock among actives.
    const sorted = filtered.slice().sort((a, b) => {
      const aActive = a.isActive !== false ? 0 : 1;
      const bActive = b.isActive !== false ? 0 : 1;
      return aActive - bActive;
    });
    sorted.forEach(ing=>{
      const isActive = ing.isActive !== false;
      const isLow = isActive && ing.currentStock <= (ing.lowStockThreshold||0);
      const usageLabel = ing.usageUnit ? ` · recipe unit: ${ing.usageUnit}` : '';
      html += `<div class="admin-card ${isActive ? '' : 'is-disabled'}">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${ing.name}${isActive ? '' : ' <span class="admin-card-badge badge-disabled" style="margin-left:6px">Disabled</span>'}</div>
            <div class="admin-card-subtitle">${ing.currentStock} ${ing.unit} · ${ing.storageLocation||'—'}${usageLabel}${isActive ? '' : ' · <em>drinks that use this should be disabled from the Menu tab</em>'}</div>
          </div>
          <div class="admin-card-actions">
            ${isLow ? '<span class="admin-card-badge badge-inactive">Low Stock</span>' : ''}
            <label class="toggle-switch" title="${isActive?'Click to disable':'Click to enable'}">
              <input type="checkbox" data-toggle-ing="${ing.ingredientId}" ${isActive?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
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
  $('#btnStockHistory').onclick = ()=> openStockHistoryModal();
  container.querySelectorAll('[data-ing-loc]').forEach(btn=>{
    btn.onclick=()=>{
      ingLocationFilter = btn.dataset.ingLoc;
      renderIngredientsSection(container, items, menuItems, recipes);
    };
  });
  container.querySelectorAll('[data-edit-ing]').forEach(btn=>{
    btn.onclick=()=>{ const ing=items.find(i=>i.ingredientId===btn.dataset.editIng); openIngredientForm(container, ing, items); };
  });
  container.querySelectorAll('[data-del-ing]').forEach(btn=>{
    btn.onclick=async()=>{
      if(!confirm('Delete this ingredient?')) return;
      try{ await api('DELETE',`/api/admin/ingredients/${btn.dataset.delIng}`); loadIngredients(container); } catch(e){ showError('Delete failed'); }
    };
  });
  container.querySelectorAll('[data-toggle-ing]').forEach(input=>{
    input.onchange = async()=>{
      const id = input.dataset.toggleIng;
      input.disabled = true;
      try{
        await api('PUT', `/api/admin/ingredients/${id}/toggle-active`, {});
        loadIngredients(container);
      } catch(e){
        showError('Toggle failed');
        input.checked = !input.checked;
        input.disabled = false;
      }
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
        <option value="BOTH" ${ing?.storageLocation==='BOTH'?'selected':''}>Both</option>
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
    return items.map((item, i)=>{
      const enabled = item.enabled !== false;
      return `<div class="admin-card ${enabled?'':'is-disabled'}" style="display:flex;align-items:center;gap:12px;padding:12px 16px">
      <span style="min-width:24px;color:var(--text-light);font-weight:600">${i+1}.</span>
      <input class="pos-input" style="flex:1;margin:0" value="${item.label}" data-phase="${phase}" data-idx="${i}" data-field="label">
      <select class="pos-input" style="width:120px;margin:0" data-phase="${phase}" data-idx="${i}" data-field="type">
        <option value="checkbox" ${item.type==='checkbox'?'selected':''}>Checkbox</option>
        <option value="text" ${item.type==='text'?'selected':''}>Text input</option>
        <option value="image" ${item.type==='image'?'selected':''}>Image upload</option>
      </select>
      <label class="toggle-switch" title="${enabled?'Enabled — click to hide from POS':'Disabled — click to enable'}">
        <input type="checkbox" data-phase="${phase}" data-idx="${i}" data-field="enabled" ${enabled?'checked':''}>
        <span class="toggle-slider"></span>
      </label>
      <button class="pos-btn pos-btn-sm pos-btn-danger" data-remove-phase="${phase}" data-remove-idx="${i}" style="min-width:36px">✕</button>
    </div>`;
    }).join('');
  }

  container.innerHTML = `<div class="admin-section">
    <div class="admin-section-header"><h2>Checklist Configuration</h2></div>
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:16px">Toggle an item off to hide it from the POS open/close/handover flow without deleting it.</p>
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
    <div class="admin-form" style="margin-top:16px">
      <h3 style="margin-bottom:12px">🔄 Handover Checklist</h3>
      <p style="color:var(--text-light);font-size:.8rem;margin-bottom:8px">Shown to first-service staff before handing over to the second-service team.</p>
      <div id="handoverItems">${renderPhase('handover', config.handover||[])}</div>
      <button class="pos-btn pos-btn-sm" id="addHandoverItem" style="margin-top:10px">+ Add item</button>
    </div>
    <div class="admin-form-actions" style="margin-top:20px">
      <button class="pos-btn pos-btn-primary" id="saveChecklist">Save Checklist</button>
    </div>
  </div>`;

  // Normalize: ensure every item has an 'enabled' field (default true) so the
  // toggle state round-trips even for legacy configs.
  let openItems = (config.open||[]).map(i=>({...i, enabled: i.enabled !== false}));
  let closeItems = (config.close||[]).map(i=>({...i, enabled: i.enabled !== false}));
  let handoverItems = (config.handover||[]).map(i=>({...i, enabled: i.enabled !== false}));

  const rerender = () => renderChecklistAdmin(container, {open:openItems, close:closeItems, handover:handoverItems});

  container.querySelector('#addOpenItem').onclick=()=>{
    openItems.push({id:`open-${Date.now()}`, label:'', type:'checkbox', enabled:true});
    rerender();
  };
  container.querySelector('#addCloseItem').onclick=()=>{
    closeItems.push({id:`close-${Date.now()}`, label:'', type:'checkbox', enabled:true});
    rerender();
  };
  container.querySelector('#addHandoverItem').onclick=()=>{
    handoverItems.push({id:`handover-${Date.now()}`, label:'', type:'checkbox', enabled:true});
    rerender();
  };

  const listFor = (phase) => phase==='open' ? openItems : phase==='close' ? closeItems : handoverItems;

  container.querySelectorAll('[data-remove-phase]').forEach(btn=>{
    btn.onclick=()=>{
      const phase = btn.dataset.removePhase;
      const idx = +btn.dataset.removeIdx;
      listFor(phase).splice(idx,1);
      rerender();
    };
  });

  container.querySelectorAll('input[data-field="label"]').forEach(inp=>{
    inp.oninput=()=>{
      const idx = +inp.dataset.idx;
      listFor(inp.dataset.phase)[idx].label = inp.value;
    };
  });

  container.querySelectorAll('select[data-field="type"]').forEach(sel=>{
    sel.onchange=()=>{
      const idx = +sel.dataset.idx;
      listFor(sel.dataset.phase)[idx].type = sel.value;
    };
  });

  container.querySelectorAll('input[data-field="enabled"]').forEach(inp=>{
    inp.onchange=()=>{
      const idx = +inp.dataset.idx;
      listFor(inp.dataset.phase)[idx].enabled = inp.checked;
      // Re-render so the greyed-out styling reflects the new state
      rerender();
    };
  });

  container.querySelector('#saveChecklist').onclick=async()=>{
    const cleanList = (list, prefix) => list.filter(i=>i.label.trim()).map((item,i)=>({
      ...item,
      id:item.id||`${prefix}-${i+1}`,
      label:item.label.trim(),
      enabled: item.enabled !== false,
    }));
    const open = cleanList(openItems, 'open');
    const close = cleanList(closeItems, 'close');
    const handover = cleanList(handoverItems, 'handover');
    try{
      await api('PUT','/api/admin/checklist/config', {open, close, handover});
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

// --- Vouchers ---
async function loadVouchers(container){
  return loadVoucherCampaignList(container);
}

async function loadVoucherCampaignList(container){
  container.innerHTML = '<div class="loading">Loading campaigns...</div>';
  try{
    const data = await api('GET','/api/admin/vouchers/campaigns');
    const campaigns = data.campaigns || [];
    renderVoucherCampaignList(container, campaigns);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load campaigns</p></div>'; }
}

function renderVoucherCampaignList(container, campaigns){
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Voucher Campaigns</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddCampaign">+ New Campaign</button>
    </div>`;

  if(!campaigns.length){
    html += '<div class="admin-empty"><p>No campaigns yet. Create one to start issuing vouchers.</p></div>';
  } else {
    campaigns.forEach(c => {
      const expiry = c.expiryMode === 'DAYS_FROM_ISSUE'
        ? `${c.expiryDays} days from issue`
        : `Fixed: ${new Date(c.expiryDate).toLocaleDateString()}`;
      const typeBadge = c.voucherType === 'FREE_DRINK' ? 'badge-drink'
                       : c.voucherType === 'FREE_FOOD'  ? 'badge-food'
                       : 'badge-active';
      const typeIcon  = c.voucherType === 'FREE_DRINK' ? '🥤'
                       : c.voucherType === 'FREE_FOOD'  ? '🍪'
                       : '🥤🍪';
      const issued = c.issuedCount || 0;
      const redeemed = c.redeemedCount || 0;
      html += `<div class="admin-card" data-campaign-id="${c.campaignId}" style="cursor:pointer">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${typeIcon} ${escapeHtml(c.name)}</div>
            <div class="admin-card-subtitle">
              ${expiry} · Issued: <strong>${issued}</strong> · Redeemed: <strong>${redeemed}</strong>
              ${c.description ? '<br><span style="color:var(--text-light)">'+escapeHtml(c.description)+'</span>' : ''}
            </div>
          </div>
          <div class="admin-card-actions">
            <span class="admin-card-badge ${typeBadge}">${c.voucherType.replace('_',' ')}</span>
            <span class="admin-card-badge ${c.status==='ACTIVE'?'badge-active':'badge-inactive'}">${c.status||'ACTIVE'}</span>
            <button class="pos-btn pos-btn-sm" data-view-campaign="${c.campaignId}">View</button>
          </div>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;

  $('#btnAddCampaign').onclick = ()=> openCampaignForm(container);

  container.querySelectorAll('[data-view-campaign]').forEach(btn=>{
    btn.onclick = (e)=>{
      e.stopPropagation();
      loadVoucherCampaignDetail(container, btn.dataset.viewCampaign);
    };
  });
  container.querySelectorAll('[data-campaign-id]').forEach(card=>{
    card.onclick = ()=>{
      loadVoucherCampaignDetail(container, card.dataset.campaignId);
    };
  });
}

function openCampaignForm(container){
  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>New Voucher Campaign</h3>
    <div class="admin-form-group">
      <label>Name</label>
      <input id="cfName" class="pos-input" placeholder="e.g. Christmas 2026 Free Drink">
    </div>
    <div class="admin-form-group">
      <label>Description (optional)</label>
      <textarea id="cfDesc" class="pos-input" rows="2" placeholder="Internal note for admin context"></textarea>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group">
        <label>Voucher Type</label>
        <select id="cfType" class="pos-input">
          <option value="FREE_DRINK">🥤 FREE_DRINK — any drink + add-ons free</option>
          <option value="FREE_FOOD">🍪 FREE_FOOD — any food item free</option>
          <option value="FREE_COMBO">🥤🍪 FREE_COMBO — one drink + one food free</option>
        </select>
      </div>
    </div>
    <div class="admin-form-group">
      <label>Expiry</label>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
        <label style="font-weight:normal;display:flex;align-items:center;gap:8px">
          <input type="radio" name="cfExpiryMode" value="DAYS_FROM_ISSUE" checked>
          Days from issue
          <input id="cfExpiryDays" type="number" min="1" max="3650" value="30" class="pos-input" style="width:100px;margin-left:8px"> days
        </label>
        <label style="font-weight:normal;display:flex;align-items:center;gap:8px">
          <input type="radio" name="cfExpiryMode" value="FIXED_DATE">
          Fixed date
          <input id="cfExpiryDate" type="date" class="pos-input" style="margin-left:8px">
        </label>
      </div>
    </div>
    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="cfSubmit">Create Campaign</button>
      <button class="pos-btn" id="cfCancel">Cancel</button>
    </div>`;

  showFormModal(form);

  form.querySelector('#cfCancel').onclick = ()=> form._overlay.remove();
  form.querySelector('#cfSubmit').onclick = async()=>{
    const name = form.querySelector('#cfName').value.trim();
    const description = form.querySelector('#cfDesc').value.trim();
    const type = form.querySelector('#cfType').value;
    const mode = form.querySelector('input[name="cfExpiryMode"]:checked').value;
    let expiryValue;

    if(mode === 'DAYS_FROM_ISSUE'){
      const days = parseInt(form.querySelector('#cfExpiryDays').value, 10);
      if(!days || days < 1){ showError('Enter a valid number of days'); return; }
      expiryValue = days;
    } else {
      const dateStr = form.querySelector('#cfExpiryDate').value;
      if(!dateStr){ showError('Pick a fixed expiry date'); return; }
      // Treat date input as end-of-day local time so "valid through 2026-12-31" works as expected.
      const d = new Date(dateStr + 'T23:59:59');
      if(d.getTime() <= Date.now()){ showError('Expiry date must be in the future'); return; }
      expiryValue = d.toISOString();
    }

    if(!name){ showError('Name is required'); return; }

    try{
      await api('POST','/api/admin/vouchers/campaigns', {
        name, description, type, expiryMode: mode, expiryValue
      });
      form._overlay.remove();
      showSuccess('Campaign created');
      loadVoucherCampaignList(container);
    } catch(e){
      showError('Failed to create campaign');
    }
  };
}

async function loadVoucherCampaignDetail(container, campaignId){
  container.innerHTML = '<div class="loading">Loading campaign...</div>';
  try{
    const data = await api('GET',`/api/admin/vouchers/campaigns/${encodeURIComponent(campaignId)}`);
    renderVoucherCampaignDetail(container, data.campaign, data.stats || {}, data.vouchers || []);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load campaign</p></div>'; }
}

function renderVoucherCampaignDetail(container, campaign, stats, vouchers){
  const expiry = campaign.expiryMode === 'DAYS_FROM_ISSUE'
    ? `${campaign.expiryDays} days from issue`
    : `Fixed: ${new Date(campaign.expiryDate).toLocaleString()}`;
  const typeIcon = campaign.voucherType === 'FREE_DRINK' ? '🥤'
                  : campaign.voucherType === 'FREE_FOOD'  ? '🍪'
                  : '🥤🍪';

  let html = `<div class="admin-section">
    <div style="margin-bottom:16px">
      <button class="pos-btn pos-btn-sm" id="btnBackToCampaigns">← Back to campaigns</button>
    </div>
    <div class="admin-section-header">
      <h2>${typeIcon} ${escapeHtml(campaign.name)}</h2>
    </div>
    <div class="admin-card" style="margin-bottom:20px">
      <div class="admin-card-subtitle">
        <strong>${campaign.voucherType.replace('_',' ')}</strong> · ${expiry}<br>
        ${campaign.description ? escapeHtml(campaign.description)+'<br>' : ''}
        Total: <strong>${stats.total||0}</strong> ·
        Issued: <strong style="color:var(--success)">${stats.issued||0}</strong> ·
        Redeemed: <strong>${stats.redeemed||0}</strong> ·
        Expired: <strong style="color:var(--text-light)">${stats.expired||0}</strong>
      </div>
    </div>

    <div class="admin-form" style="margin-bottom:20px">
      <h3 style="margin-bottom:12px">Assign one voucher</h3>
      <div class="admin-form-row">
        <div class="admin-form-group">
          <label>Phone</label>
          <input id="avPhone" class="pos-input" placeholder="0168089999">
        </div>
        <div class="admin-form-group">
          <label>Name (optional)</label>
          <input id="avName" class="pos-input" placeholder="Aunty Jane">
        </div>
      </div>
      <div class="admin-form-group">
        <label>Note (optional)</label>
        <input id="avNote" class="pos-input" placeholder="Birthday gift">
      </div>
      <div class="admin-form-actions">
        <button class="pos-btn pos-btn-primary" id="avSubmit">Assign</button>
      </div>
    </div>

    <div class="admin-form" style="margin-bottom:20px">
      <h3 style="margin-bottom:8px">Bulk upload (CSV)</h3>
      <p style="color:var(--text-light);font-size:.85rem;margin-bottom:12px">
        Format: <code>phone,name,note</code> header row, max 1000 rows.
      </p>
      <input type="file" id="csvFile" accept=".csv,text/csv" class="pos-input">
      <div class="admin-form-actions">
        <button class="pos-btn pos-btn-primary" id="csvSubmit">Upload</button>
      </div>
      <div id="csvResult" style="margin-top:10px"></div>
    </div>

    <h3 style="margin:20px 0 10px">Issued vouchers (${vouchers.length})</h3>
    <input id="vSearch" class="pos-input" placeholder="Filter by phone or name" style="margin-bottom:12px">
    <div id="voucherList"></div>
  </div>`;

  container.innerHTML = html;

  container.querySelector('#btnBackToCampaigns').onclick = ()=>{
    loadVoucherCampaignList(container);
  };

  container.querySelector('#avSubmit').onclick = async()=>{
    const phone = container.querySelector('#avPhone').value.trim();
    const name = container.querySelector('#avName').value.trim();
    const note = container.querySelector('#avNote').value.trim();
    if(!phone){ showError('Phone required'); return; }
    try{
      await api('POST',`/api/admin/vouchers/campaigns/${encodeURIComponent(campaign.campaignId)}/assign`, { phone, name, note });
      container.querySelector('#avPhone').value = '';
      container.querySelector('#avName').value = '';
      container.querySelector('#avNote').value = '';
      showSuccess('Voucher assigned');
      loadVoucherCampaignDetail(container, campaign.campaignId);
    } catch(e){
      showError('Assignment failed (invalid phone or duplicate)');
    }
  };

  container.querySelector('#csvSubmit').onclick = async()=>{
    const file = container.querySelector('#csvFile').files[0];
    const resultEl = container.querySelector('#csvResult');
    if(!file){ showError('Pick a CSV file first'); return; }
    resultEl.innerHTML = '<span style="color:var(--text-light)">Uploading...</span>';
    try{
      const text = await file.text();
      const data = await api('POST',`/api/admin/vouchers/campaigns/${encodeURIComponent(campaign.campaignId)}/assign-csv`, { csv: text });
      const issued = data.issued || 0;
      const skipped = data.skipped || [];
      let msg = `<div style="color:var(--success);margin-bottom:6px">${issued} issued${skipped.length?', '+skipped.length+' skipped':''}.</div>`;
      if(skipped.length){
        msg += '<details style="font-size:.85rem;color:var(--text-light)"><summary>Show skipped rows</summary><ul style="margin-top:6px">';
        skipped.slice(0, 50).forEach(s=>{
          msg += `<li>Row ${s.row||'?'} — ${escapeHtml(s.phone||'(empty)')} — ${escapeHtml(s.reason)}</li>`;
        });
        if(skipped.length > 50) msg += `<li>...and ${skipped.length - 50} more</li>`;
        msg += '</ul></details>';
      }
      resultEl.innerHTML = msg;
      container.querySelector('#csvFile').value = '';
      // Refresh the voucher list portion only (keep CSV result visible).
      const fresh = await api('GET',`/api/admin/vouchers/campaigns/${encodeURIComponent(campaign.campaignId)}`);
      renderVoucherTable(container, fresh.vouchers || [], campaign.campaignId, '');
    } catch(e){
      resultEl.innerHTML = '<span style="color:var(--warning)">Upload failed</span>';
    }
  };

  const search = container.querySelector('#vSearch');
  search.oninput = ()=> renderVoucherTable(container, vouchers, campaign.campaignId, search.value.toLowerCase());
  renderVoucherTable(container, vouchers, campaign.campaignId, '');
}

function renderVoucherTable(container, vouchers, campaignId, filter){
  const list = container.querySelector('#voucherList');
  if(!list) return;
  const now = Math.floor(Date.now() / 1000);
  const filtered = filter
    ? vouchers.filter(v => (v.phone||'').toLowerCase().includes(filter) || (v.name||'').toLowerCase().includes(filter))
    : vouchers;

  if(!filtered.length){
    list.innerHTML = '<div class="admin-empty"><p>No vouchers match.</p></div>';
    return;
  }

  // Sort: ISSUED+active first, then REDEEMED, then EXPIRED, then by issuedAt desc.
  const rank = v => {
    const expired = v.status === 'ISSUED' && (v.expiresAtEpoch || 0) <= now;
    if(v.status === 'ISSUED' && !expired) return 0;
    if(v.status === 'REDEEMED') return 1;
    return 2;
  };
  filtered.sort((a,b)=>{
    const ra = rank(a), rb = rank(b);
    if(ra !== rb) return ra - rb;
    return (b.issuedAt||'').localeCompare(a.issuedAt||'');
  });

  let html = `<table style="width:100%;border-collapse:collapse">
    <tr style="border-bottom:2px solid var(--cream-dark);text-align:left">
      <th style="padding:8px 0">Phone</th>
      <th style="padding:8px 0">Name</th>
      <th style="padding:8px 0">Status</th>
      <th style="padding:8px 0">Issued</th>
      <th style="padding:8px 0">Expires / Redeemed</th>
      <th style="padding:8px 0;text-align:right">Action</th>
    </tr>`;
  filtered.forEach(v=>{
    const expired = v.status === 'ISSUED' && (v.expiresAtEpoch || 0) <= now;
    let statusBadge, statusClass, expiryCell;
    if(v.status === 'REDEEMED'){
      statusBadge = 'REDEEMED'; statusClass = 'badge-inactive';
      expiryCell = v.redeemedAt
        ? `${new Date(v.redeemedAt).toLocaleDateString()}${v.menuItemName?'<br><span style="font-size:.75rem;color:var(--text-light)">'+escapeHtml(v.menuItemName)+(v.variant?' ('+escapeHtml(v.variant)+')':'')+'</span>':''}`
        : '—';
    } else if(expired){
      statusBadge = 'EXPIRED'; statusClass = 'badge-inactive';
      expiryCell = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : '—';
    } else {
      statusBadge = 'ISSUED'; statusClass = 'badge-active';
      expiryCell = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : '—';
    }
    const action = (v.status === 'ISSUED' && !expired)
      ? `<button class="pos-btn pos-btn-sm pos-btn-danger" data-revoke-id="${v.voucherId}" data-revoke-phone="${escapeAttr(v.phone)}">Revoke</button>`
      : '';
    html += `<tr style="border-bottom:1px solid var(--cream-dark)">
      <td style="padding:8px 0">${escapeHtml(v.phone||'')}</td>
      <td style="padding:8px 0">${escapeHtml(v.name||'—')}</td>
      <td style="padding:8px 0"><span class="admin-card-badge ${statusClass}">${statusBadge}</span></td>
      <td style="padding:8px 0">${v.issuedAt ? new Date(v.issuedAt).toLocaleDateString() : '—'}</td>
      <td style="padding:8px 0">${expiryCell}</td>
      <td style="padding:8px 0;text-align:right">${action}</td>
    </tr>`;
  });
  html += '</table>';
  list.innerHTML = html;

  list.querySelectorAll('[data-revoke-id]').forEach(btn=>{
    btn.onclick = async()=>{
      const voucherId = btn.dataset.revokeId;
      const phone = btn.dataset.revokePhone;
      if(!confirm('Revoke this voucher? This cannot be undone.')) return;
      try{
        await api('DELETE',`/api/admin/vouchers/${encodeURIComponent(voucherId)}?phone=${encodeURIComponent(phone)}`);
        showSuccess('Voucher revoked');
        loadVoucherCampaignDetail(container, campaignId);
      } catch(e){
        showError('Revoke failed');
      }
    };
  });
}

function escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeAttr(s){ return escapeHtml(s); }

// Strip only leading emoji + whitespace — safe for plain-text exports
// (clipboard, CSV) that would otherwise carry rendering-fragile characters.
// Anchored pattern; a global \p{Emoji} replace would also strip digits and
// other legitimate characters that Unicode treats as emoji-capable.
function stripLeadingEmoji(s) {
  return String(s || '').replace(/^[\p{Emoji}\p{Emoji_Component}\s]+/u, '').trim();
}

// --- Pre-Order Links ---
// Ministry volunteers pre-order free drinks via a link with an 8-char
// code. Admins create, view, and deactivate codes here.
async function loadPreorderCodes(container){
  container.innerHTML = '<div class="loading">Loading pre-order codes...</div>';
  try{
    const data = await api('GET','/api/admin/preorder-codes');
    renderPreorderCodes(container, data.codes || []);
  } catch(e){
    container.innerHTML = '<div class="admin-empty"><p>Failed to load pre-order codes</p></div>';
  }
}

function preorderStatus(code, nowIso){
  if (code.isActive === false) return { label: 'Deactivated', cls: 'badge-inactive' };
  if (code.opensAt && nowIso < code.opensAt) return { label: 'Not yet open', cls: 'badge-cashier' };
  if (code.expiresAt && nowIso > code.expiresAt) return { label: 'Expired', cls: 'badge-inactive' };
  return { label: 'Active', cls: 'badge-active' };
}

function fmtDT(iso){
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return escapeHtml(iso);
  return escapeHtml(d.toLocaleString());
}

function renderPreorderCodes(container, codes){
  const nowIso = new Date().toISOString();
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Pre-Order Links</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddPreorder">+ Create Link</button>
    </div>
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:16px">
      Share these links with ministry volunteers. Only drinks. Bypass café-open check.
    </p>`;
  if (!codes.length){
    html += '<div class="admin-empty"><p>No pre-order codes yet — create one for the next service.</p></div>';
  } else {
    codes.forEach(c => {
      const st = preorderStatus(c, nowIso);
      const link = c.link || `https://153.oasisofcare.org/?code=${encodeURIComponent(c.code)}`;
      const eligibleCount = Array.isArray(c.eligibleItems) ? c.eligibleItems.length : 0;
      const collectionOpts = Array.isArray(c.collectionOptions) ? c.collectionOptions : [];
      const customDetails = [
        c.bannerMessage ? `📢 Banner: ${escapeHtml(String(c.bannerMessage).slice(0, 80))}${String(c.bannerMessage).length > 80 ? '…' : ''}` : '',
        eligibleCount > 0 ? `🥤 Eligible drinks: ${eligibleCount} selected` : `🥤 Eligible drinks: all active`,
        collectionOpts.length ? `⏰ Collection: ${collectionOpts.map(escapeHtml).join(' | ')}` : '',
      ].filter(Boolean).map(s => `<div style="margin-top:2px">${s}</div>`).join('');
      html += `<div class="admin-card">
        <div class="admin-card-header">
          <div style="min-width:0;flex:1">
            <div class="admin-card-title">${escapeHtml(c.name || '(unnamed)')}</div>
            <div class="admin-card-subtitle">
              Code: <strong style="font-family:monospace;letter-spacing:.05em">${escapeHtml(c.code)}</strong>
              · Service: ${escapeHtml(c.serviceDate || '—')}
              · Opens: ${fmtDT(c.opensAt)}
              · Expires: ${fmtDT(c.expiresAt)}
              · Cutoff: ${fmtDT(c.serviceEndTime)}
              <div style="margin-top:6px;font-family:monospace;font-size:.75rem;color:var(--text-light);word-break:break-all">${escapeHtml(link)}</div>
              ${customDetails}
            </div>
          </div>
          <div class="admin-card-actions" style="flex-shrink:0">
            <span class="admin-card-badge ${st.cls}">${st.label}</span>
            <button class="pos-btn pos-btn-sm" data-copy-link="${escapeAttr(link)}">📋 Copy</button>
            ${c.isActive !== false ? `<button class="pos-btn pos-btn-sm pos-btn-danger" data-deactivate-code="${escapeAttr(c.code)}">Deactivate</button>` : ''}
          </div>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;

  $('#btnAddPreorder').onclick = () => openPreorderForm(container);
  container.querySelectorAll('[data-copy-link]').forEach(btn => {
    btn.onclick = async () => {
      const link = btn.dataset.copyLink;
      try {
        await navigator.clipboard.writeText(link);
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
      } catch(e){
        // Fallback: select-and-alert if clipboard API is blocked
        window.prompt('Copy this link:', link);
      }
    };
  });
  container.querySelectorAll('[data-deactivate-code]').forEach(btn => {
    btn.onclick = async () => {
      const code = btn.dataset.deactivateCode;
      if (!confirm(`Deactivate code ${code}?\nExisting orders remain, but new orders with this code will be rejected.`)) return;
      try {
        await api('DELETE', `/api/admin/preorder-codes/${encodeURIComponent(code)}`);
        loadPreorderCodes(container);
      } catch(e){ showError('Deactivate failed'); }
    };
  });
}

function openPreorderForm(container){
  // Default: opens now, expires 8 days from now, service date next Sunday
  const now = new Date();
  const nextSunday = new Date(now);
  const daysUntilSun = (7 - now.getDay()) % 7 || 7; // next Sunday, not today
  nextSunday.setDate(now.getDate() + daysUntilSun);
  const serviceDate = nextSunday.toISOString().split('T')[0];
  // datetime-local inputs want local ISO without timezone (YYYY-MM-DDTHH:MM)
  const toLocalInput = d => {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const expiresGuess = new Date(nextSunday);
  expiresGuess.setHours(15, 0, 0, 0); // Sunday 3PM local

  // Fetch admin menu (all active DRINKs) for the eligibility checkboxes.
  // Kicked off eagerly; the form renders once it arrives.
  const menuP = api('GET', '/api/admin/menu').then(d => (Array.isArray(d) ? d : d.items || []).filter(m => m.category === 'DRINK')).catch(() => []);
  // Collection-option working state (Change 3). Default to the same two
  // options the backend uses; admin can rename or add.
  let collectionOpts = ['After 1st Service', 'After 2nd Service'];

  // Placeholder shell — the drink list slot gets populated once menuP settles.
  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>Create Pre-Order Link</h3>
    <div class="admin-form-group"><label>Event Name</label>
      <input id="pfName" class="pos-input" placeholder="e.g. Sunday 6 Jul Service" value="Sunday ${nextSunday.toLocaleDateString(undefined,{day:'numeric',month:'short'})} Service">
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Service Date</label>
        <input id="pfDate" type="date" class="pos-input" value="${serviceDate}">
      </div>
      <div class="admin-form-group"><label>Opens At</label>
        <input id="pfOpens" type="datetime-local" class="pos-input" value="${toLocalInput(now)}">
      </div>
      <div class="admin-form-group"><label>Expires At</label>
        <input id="pfExpires" type="datetime-local" class="pos-input" value="${toLocalInput(expiresGuess)}">
      </div>
    </div>
    <p style="font-size:.8rem;color:var(--text-light);margin-top:4px">
      Service auto-cutoff is fixed at 3PM MYT on service date — pre-orders auto-expire then.
    </p>

    <div class="admin-form-group">
      <label>Banner Message <span style="color:var(--text-light);font-weight:400">(optional, max 200 chars)</span></label>
      <textarea id="pfBanner" class="pos-input" rows="3" maxlength="200" placeholder="Ministry Pre-Order — Kindly select one drink&#10;Sunday ${nextSunday.toLocaleDateString(undefined,{day:'numeric',month:'short'})} Service · Collect Sunday, ${nextSunday.toLocaleDateString(undefined,{day:'numeric',month:'short'})}" style="min-height:60px;font-family:inherit"></textarea>
      <p style="font-size:.75rem;color:var(--text-light);margin-top:4px">Leave blank to use the default template above.</p>
    </div>

    <div class="admin-form-group">
      <label style="display:flex;justify-content:space-between;align-items:center">
        <span>Eligible Drinks</span>
        <span style="font-weight:400">
          <button type="button" class="pos-btn pos-btn-sm" id="pfSelectAll">Select All</button>
          <button type="button" class="pos-btn pos-btn-sm" id="pfSelectNone">Select None</button>
        </span>
      </label>
      <div id="pfDrinkList" style="max-height:220px;overflow-y:auto;border:1px solid var(--cream-dark);border-radius:8px;padding:8px 12px;background:#fff">
        <div class="loading">Loading drinks…</div>
      </div>
      <p style="font-size:.75rem;color:var(--text-light);margin-top:4px">Uncheck items to exclude them. Empty selection = all drinks (backward compatible).</p>
    </div>

    <div class="admin-form-group">
      <label>Collection Options <span style="color:var(--text-light);font-weight:400">(radio choices on the customer page)</span></label>
      <div id="pfCollectionList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px"></div>
      <button type="button" class="pos-btn pos-btn-sm" id="pfAddOpt">+ Add option</button>
    </div>

    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="pfSubmit">Create Link</button>
      <button class="pos-btn" id="pfCancel">Cancel</button>
    </div>`;

  showFormModal(form);
  wirePreorderForm(form, container, menuP, collectionOpts);
}

function wirePreorderForm(form, container, menuP, collectionOpts) {
  // ─── Collection-options list ──────────────────────────────────────
  const renderCollectionOpts = () => {
    const listEl = form.querySelector('#pfCollectionList');
    listEl.innerHTML = collectionOpts.map((v, i) => `
      <div style="display:flex;gap:6px;align-items:center">
        <input class="pos-input" data-opt-idx="${i}" value="${escapeAttr(v)}" placeholder="e.g. After 1st Service" maxlength="60" style="flex:1;margin:0">
        <button type="button" class="pos-btn pos-btn-sm pos-btn-danger" data-opt-remove="${i}" ${collectionOpts.length <= 1 ? 'disabled title="Need at least one option"' : ''} style="min-width:36px">✕</button>
      </div>
    `).join('');
    // Update in-place on typing (avoid full re-render / focus loss).
    listEl.querySelectorAll('input[data-opt-idx]').forEach(inp => {
      inp.oninput = () => { collectionOpts[+inp.dataset.optIdx] = inp.value; };
    });
    listEl.querySelectorAll('[data-opt-remove]').forEach(btn => {
      btn.onclick = () => {
        collectionOpts.splice(+btn.dataset.optRemove, 1);
        renderCollectionOpts();
      };
    });
  };
  renderCollectionOpts();
  form.querySelector('#pfAddOpt').onclick = () => {
    collectionOpts.push('');
    renderCollectionOpts();
    // Focus the last input for immediate typing.
    const inputs = form.querySelectorAll('#pfCollectionList input');
    inputs[inputs.length - 1]?.focus();
  };

  // ─── Eligible drinks checkboxes ───────────────────────────────────
  menuP.then(drinks => {
    const listEl = form.querySelector('#pfDrinkList');
    if (!drinks.length) {
      listEl.innerHTML = '<div style="color:var(--text-light);padding:4px 0">No active drinks in the menu.</div>';
      return;
    }
    // Default: all checked (matches spec's "backward compatible: empty = all").
    listEl.innerHTML = drinks
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(m => {
        const id = m.menuItemId || m.id;
        return `<label style="display:flex;gap:8px;align-items:center;padding:4px 0;font-weight:400">
          <input type="checkbox" data-drink-id="${escapeAttr(id)}" checked>
          <span>${escapeHtml(m.name || '(unnamed)')} <span style="color:var(--text-light);font-size:.85rem">— RM ${Number(m.basePrice || 0).toFixed(2)}</span></span>
        </label>`;
      }).join('');
  });
  form.querySelector('#pfSelectAll').onclick = () => {
    form.querySelectorAll('#pfDrinkList input[data-drink-id]').forEach(cb => { cb.checked = true; });
  };
  form.querySelector('#pfSelectNone').onclick = () => {
    form.querySelectorAll('#pfDrinkList input[data-drink-id]').forEach(cb => { cb.checked = false; });
  };

  // ─── Cancel / Submit ──────────────────────────────────────────────
  form.querySelector('#pfCancel').onclick = () => form._overlay.remove();
  form.querySelector('#pfSubmit').onclick = async () => {
    const name = form.querySelector('#pfName').value.trim();
    const serviceDate = form.querySelector('#pfDate').value;
    const opensLocal = form.querySelector('#pfOpens').value;
    const expiresLocal = form.querySelector('#pfExpires').value;
    if (!name){ showError('Event name is required'); return; }
    if (!serviceDate){ showError('Service date is required'); return; }
    if (!opensLocal || !expiresLocal){ showError('Opens/Expires are required'); return; }
    const opensAt = new Date(opensLocal).toISOString();
    const expiresAt = new Date(expiresLocal).toISOString();
    if (new Date(opensAt) >= new Date(expiresAt)){
      showError('Expires must be after Opens');
      return;
    }

    const bannerMessage = form.querySelector('#pfBanner').value.trim();
    // Only send eligibleItems when user has restricted the selection. A
    // check-none-or-check-all state both mean "no restriction" per the
    // backend's contract (empty array). Prefer explicit whitelist only
    // when the operator has deselected at least one drink.
    const allCbs = form.querySelectorAll('#pfDrinkList input[data-drink-id]');
    const checked = [...allCbs].filter(cb => cb.checked).map(cb => cb.dataset.drinkId);
    const eligibleItems = allCbs.length && checked.length && checked.length < allCbs.length
      ? checked
      : [];
    const collectionOptions = collectionOpts.map(s => s.trim()).filter(Boolean);
    if (!collectionOptions.length){
      showError('At least one collection option is required');
      return;
    }

    try {
      const result = await api('POST', '/api/admin/preorder-codes', {
        name, serviceDate, opensAt, expiresAt,
        bannerMessage,
        eligibleItems,
        collectionOptions,
      });
      form._overlay.remove();
      showSuccess(`Link created: ${result.code}`);
      loadPreorderCodes(container);
    } catch(e){ showError('Failed to create link'); }
  };
}

// --- Stock History Modal ---
// Browse cashier-submitted stock-count snapshots by date. Shows each
// snapshot's counts in a table (name / count / unit / location).
async function openStockHistoryModal(){
  const overlay = document.createElement('div');
  overlay.className = 'pos-modal-overlay';
  overlay.innerHTML = `<div class="pos-modal" style="max-width:820px;max-height:90vh;display:flex;flex-direction:column;padding:0">
    <div style="padding:16px 20px;border-bottom:1px solid var(--cream-dark,#E7DFD5);display:flex;justify-content:space-between;align-items:center;gap:12px">
      <h3 style="margin:0">📋 Stock Count History</h3>
      <button class="pos-modal-close" id="shClose" style="position:static">✕</button>
    </div>
    <div style="padding:12px 20px;border-bottom:1px solid var(--cream-dark,#E7DFD5);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="pos-btn pos-btn-sm" id="shPrev">‹ Prev</button>
      <input type="date" id="shDate" class="pos-input" style="margin:0;max-width:180px">
      <button class="pos-btn pos-btn-sm" id="shNext">Next ›</button>
      <span id="shDateInfo" style="font-size:.8rem;color:var(--text-light,#7A6355);margin-left:auto"></span>
    </div>
    <div id="shBody" style="flex:1;overflow-y:auto;padding:16px 20px">
      <div class="loading">Loading…</div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if(e.target === overlay) overlay.remove(); };
  overlay.querySelector('#shClose').onclick = ()=> overlay.remove();

  const dateInput = overlay.querySelector('#shDate');
  const today = new Date().toISOString().split('T')[0];
  dateInput.value = today;

  // Load list of dates that have snapshots (used for the count summary + hints)
  let snapshotDates = [];
  try {
    const meta = await api('GET','/api/admin/stock-history/snapshots');
    snapshotDates = meta.dates || [];
  } catch(e){ /* non-fatal */ }

  function updateInfo(){
    const info = overlay.querySelector('#shDateInfo');
    if (!snapshotDates.length){ info.textContent = 'No snapshots yet'; return; }
    const total = snapshotDates.reduce((s, d) => s + (d.count || 0), 0);
    info.textContent = `${snapshotDates.length} day(s), ${total} snapshot(s) total`;
  }
  updateInfo();

  async function load(date){
    const body = overlay.querySelector('#shBody');
    body.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const data = await api('GET', `/api/admin/stock-history?date=${encodeURIComponent(date)}`);
      const snapshots = data.snapshots || [];
      if (!snapshots.length){
        body.innerHTML = `<div class="admin-empty" style="padding:40px 20px;text-align:center"><p>No stock counts recorded on ${escapeHtml(date)}</p></div>`;
        return;
      }
      body.innerHTML = snapshots.map(s => {
        const rows = (s.counts || []).map(c => `<tr>
          <td style="padding:6px 8px">${escapeHtml(c.name || '?')}</td>
          <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">${escapeHtml(String(c.count ?? '—'))}</td>
          <td style="padding:6px 8px;color:var(--text-light,#7A6355)">${escapeHtml(c.unit || '')}</td>
          <td style="padding:6px 8px;color:var(--text-light,#7A6355)">${escapeHtml(c.storageLocation || '—')}</td>
        </tr>`).join('');
        const ts = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—';
        return `<div class="admin-card" style="margin-bottom:14px;padding:14px 16px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:10px">
            <div>
              <div style="font-weight:700">${escapeHtml(ts)}</div>
              <div style="font-size:.8rem;color:var(--text-light,#7A6355)">Submitted by ${escapeHtml(s.submittedBy || 'Unknown')} · ${(s.counts||[]).length} item(s)</div>
            </div>
          </div>
          <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.9rem">
            <thead><tr style="background:#f7f5f2;text-align:left">
              <th style="padding:6px 8px">Item</th>
              <th style="padding:6px 8px;text-align:right">Count</th>
              <th style="padding:6px 8px">Unit</th>
              <th style="padding:6px 8px">Location</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </div>`;
      }).join('');
    } catch(e){
      body.innerHTML = '<div class="admin-empty" style="padding:40px 20px;text-align:center;color:var(--danger)"><p>Failed to load stock history</p></div>';
    }
  }

  function shiftDate(days){
    const d = new Date(dateInput.value + 'T00:00:00Z');
    if (isNaN(d.getTime())) return;
    d.setUTCDate(d.getUTCDate() + days);
    dateInput.value = d.toISOString().split('T')[0];
    load(dateInput.value);
  }

  dateInput.onchange = ()=> load(dateInput.value);
  overlay.querySelector('#shPrev').onclick = ()=> shiftDate(-1);
  overlay.querySelector('#shNext').onclick = ()=> shiftDate(1);

  load(today);
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
