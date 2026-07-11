// admin-dashboard.js — Dashboard rendering
// Depends on: admin.js (api, showError, $, authHeaders)

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
    const [daily, sessions, discounts, ingredients, checklistLogs, stockHistory, featuredAudit] = await Promise.all([
      api('GET','/api/admin/reports/daily'),
      api('GET','/api/admin/reports/sessions'),
      api('GET','/api/admin/reports/discounts'),
      api('GET','/api/pos/ingredients'),
      // Activity trail sources — /checklist/logs returns all logs, we
      // filter to today client-side. /stock-history?date= returns snapshots
      // for one date; missing endpoints return safe empty results.
      api('GET','/api/admin/checklist/logs').catch(() => ({ logs: [] })),
      api('GET', `/api/admin/stock-history?date=${encodeURIComponent(todayIso)}`).catch(() => ({ snapshots: [] })),
      api('GET','/api/admin/featured-drink/audit').catch(() => ({ entries: [] })),
    ]);
    renderDashboard(container, { daily, sessions, discounts, ingredients, checklistLogs, stockHistory, featuredAudit, todayIso });
  } catch(e){
    container.innerHTML = '<div class="admin-empty"><p>Failed to load dashboard</p></div>';
  }
}

function renderDashboard(container, data){
  const { daily, sessions, discounts, ingredients, checklistLogs, stockHistory, featuredAudit, todayIso } = data;
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
    ${featuredAuditHtml(featuredAudit)}
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


// ─── Featured Drink Audit (Dashboard) ──────────────────────────────────────
function featuredAuditHtml(auditRes) {
  const entries = Array.isArray(auditRes?.entries) ? auditRes.entries : [];
  if (!entries.length) return '';

  const fmtTime = ts => {
    try { const d = new Date(ts); return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
    catch(e){ return ''; }
  };

  const rows = entries.map(e => {
    const icon = e.action === 'FEATURE' ? '⭐' : '✖️';
    const label = e.action === 'FEATURE' ? `Featured <strong>${e.menuItemName || '?'}</strong>` : 'Removed featured drink';
    return `<div style="padding:6px 0;border-bottom:1px solid var(--cream-dark,#eee);display:flex;justify-content:space-between;align-items:center">
      <span>${icon} ${label}</span>
      <span style="font-size:.8rem;color:var(--text-light)">${fmtTime(e.timestamp)} · ${e.user || 'Unknown'}</span>
    </div>`;
  }).join('');

  return `
    <h3 style="margin:24px 0 12px;color:var(--primary)">⭐ Featured Drink Audit</h3>
    <div class="admin-form">${rows}</div>`;
}
