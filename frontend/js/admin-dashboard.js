// admin-dashboard.js — Dashboard rendering
// Depends on: admin.js (api, showError, $, authHeaders)

// --- Dashboard ---
// Today-only operational view. Historical/weekly/monthly analytics live on
// reports.html (linked from the sidebar's "📈 Reports" button).
//
// Two zones, deliberately unequal in weight:
//   Zone 1 "Right now"  — live service state, dense, dark strip. Rendered ONLY
//                         when the selected date is the real today; "right now"
//                         is meaningless for a past Sunday.
//   Zone 2 "Today so far" — analysis. Revenue headline, then three charts, then
//                         the detail sections.
// All spacing/colour lives in admin.css (`.admin-dashboard` scope). Keep it
// there: inline styles are what flattened the old hierarchy.

// Track selected date globally for the dashboard
let dashboardSelectedDate = new Date().toISOString().slice(0, 10);

function computePastSundays() {
  const sundays = [];
  const today = new Date();
  const d = new Date(today);
  // Go back to find the most recent past Sunday
  d.setDate(d.getDate() - ((d.getDay() === 0) ? 7 : d.getDay()));
  for (let i = 0; i < 13; i++) {
    sundays.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() - 7);
  }
  return sundays;
}

async function loadDashboard(container){
  container.innerHTML = '<div class="loading">Loading dashboard...</div>';
  dashboardSelectedDate = new Date().toISOString().slice(0, 10);
  await fetchAndRenderDashboard(container);
}

async function fetchAndRenderDashboard(container){
  try {
    const dateParam = dashboardSelectedDate;
    const todayIso = dateParam;
    const dateQuery = `date=${encodeURIComponent(dateParam)}`;
    const [daily, sessions, discounts, ingredients, checklistLogs, stockHistory, featuredAudit] = await Promise.all([
      api('GET',`/api/admin/reports/daily?${dateQuery}`),
      api('GET',`/api/admin/reports/sessions?${dateQuery}`),
      api('GET',`/api/admin/reports/discounts?${dateQuery}`),
      api('GET','/api/pos/ingredients'),
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
  // Derived from the two figures on screen, so an operator can reproduce it.
  const avgOrder   = completed ? revenue / completed : 0;

  // Oldest PENDING order's age, in whole minutes. Zone 1 only.
  const nowMs = Date.now();
  let oldestPendingMin = null;
  for (const o of todaysOrders) {
    if (o.status !== 'PENDING' || !o.createdAt) continue;
    const t = new Date(o.createdAt).getTime();
    if (!isFinite(t)) continue;
    const mins = Math.max(0, Math.floor((nowMs - t) / 60000));
    if (oldestPendingMin === null || mins > oldestPendingMin) oldestPendingMin = mins;
  }

  // ─── (b) Session comparison ────────────────────────────────────────
  const s1 = sessions?.session1 || {};
  const s2 = sessions?.session2 || {};
  const s1Rev = Number(s1.revenue || 0);
  const s2Rev = Number(s2.revenue || 0);
  const s1Highlight = s1Rev >= s2Rev && s1Rev > 0;
  const s2Highlight = s2Rev >  s1Rev;
  // Feature 4: Use time ranges from API response
  const s1TimeRange = s1.timeRange || '8:00 – 11:30 MYT';
  const s2TimeRange = s2.timeRange || '11:31 – 14:00 MYT';

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
  const drinkBreakdown = discounts?.drinkBreakdown || {};
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

  // ─── (f) Order source split (chart A) ──────────────────────────────
  // Same basis as the headline order count: today's orders EXCLUDING
  // CANCELLED and EXPIRED, so the three segments sum to it exactly.
  // Precedence is explicit and defensive — the flags should be mutually
  // exclusive, but a pre-order raised at the counter would set both.
  const COUNTED_STATUSES = ['PENDING', 'PREPARING', 'READY', 'ARCHIVED'];
  const sourceCounts = { mobile: 0, walkin: 0, preorder: 0 };
  for (const o of todaysOrders) {
    if (!COUNTED_STATUSES.includes(o.status)) continue;
    if (o.isPreOrder === true) sourceCounts.preorder++;
    else if (o.isWalkUp === true) sourceCounts.walkin++;
    else sourceCounts.mobile++;
  }

  // ─── Date selector (Feature 6) ────────────────────────────────────
  const realToday = new Date().toISOString().slice(0, 10);
  const pastSundays = computePastSundays();
  let dateOptionsHtml = `<option value="${realToday}"${dashboardSelectedDate === realToday ? ' selected' : ''}>Today (${realToday})</option>`;
  for (const sun of pastSundays) {
    if (sun === realToday) continue; // avoid duplicate
    dateOptionsHtml += `<option value="${sun}"${dashboardSelectedDate === sun ? ' selected' : ''}>${sun} (Sun)</option>`;
  }

  // "Right now" only makes sense for the live day.
  const isLive = dashboardSelectedDate === realToday;
  const dateLabel = fmtDateLabel(dashboardSelectedDate);
  const zoneTitle = isLive ? 'Today so far' : dateLabel;
  // "Today's Discounts" is a lie when a past Sunday is selected, so the day
  // word only survives on the live day.
  const dayWord = isLive ? "Today's " : '';
  // Six days out of seven this dashboard has no orders at all. Rather than
  // four consecutive empty panels plus a table of zeroes, the whole analysis
  // zone collapses to one line. Low Stock is deliberately NOT part of this —
  // it is date-independent and it is what a weekday admin came for.
  const hasOrders = totalCard > 0 || revenue > 0;

  const analysisHtml = hasOrders ? `
      <h3 class="dash-zone-title">🗓 ${escapeHtml(zoneTitle)}</h3>

      <div class="dash-headline">
        <div class="dash-hero">
          <div class="dash-hero-label">Revenue</div>
          <div class="dash-hero-value">RM ${revenue.toFixed(2)}</div>
          <div class="dash-hero-note">Collected on completed orders, net of discounts.</div>
        </div>
        <div class="dash-support">
          <div class="dash-support-item">
            <span class="dash-support-value">${totalCard}</span>
            <span class="dash-support-label">Orders</span>
          </div>
          <div class="dash-support-item">
            <span class="dash-support-value">${completed}</span>
            <span class="dash-support-label">Completed</span>
          </div>
          <div class="dash-support-item">
            <span class="dash-support-value">RM ${avgOrder.toFixed(2)}</span>
            <span class="dash-support-label">Avg order</span>
          </div>
        </div>
      </div>

      ${orderSourceChartHtml(sourceCounts, totalCard)}
      ${topItemsChartHtml(topItems, dayWord)}
      ${sessionChartHtml(s1, s2, s1TimeRange, s2TimeRange, s1Highlight, s2Highlight)}

      <h3 class="dash-h3">💰 ${dayWord}Discounts</h3>
      <div class="dash-panel">
        <table class="dash-table">
          <thead>
            <tr>
              <th>Type</th>
              <th class="num">Orders</th>
              <th class="num">Offset (RM)</th>
            </tr>
          </thead>
          <tbody>
          ${discountTypes.map(([key, label]) => {
            const row = discountSummary[key] || { count: 0, totalOffset: 0 };
            const drinks = drinkBreakdown[key] || {};
            const drinkEntries = Object.entries(drinks);
            const drinkText = drinkEntries.map(([name, qty]) => `${name} ×${qty}`).join(', ');
            const hasBreakdown = drinkEntries.length > 0;
            const accordionId = `discount-accordion-${key}`;
            return `<tr class="discount-row ${hasBreakdown ? 'dash-row-toggle' : 'dash-row-static'}" data-accordion="${accordionId}">
              <td>${label}${hasBreakdown ? ' ▸' : ''}</td>
              <td class="num">${row.count}</td>
              <td class="num">${Number(row.totalOffset||0).toFixed(2)}</td>
            </tr>
            <tr id="${accordionId}" class="discount-breakdown dash-breakdown" style="display:none">
              <td colspan="3">${drinkText || '—'}</td>
            </tr>`;
          }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td class="num">${totalDiscOrders}</td>
              <td class="num">${totalDiscOffset.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
  ` : `
      <p class="dash-nodata">No orders on ${escapeHtml(dateLabel)}.</p>
  `;

  // ─── Compose HTML ──────────────────────────────────────────────────
  let html = `<div class="admin-section admin-dashboard">
    <div class="admin-section-header">
      <h2>📊 Dashboard</h2>
      <div class="dash-controls">
        <select id="dashboardDateSelect" class="dash-date-select" aria-label="Dashboard date">
          ${dateOptionsHtml}
        </select>
        <button class="pos-btn pos-btn-sm dash-refresh" id="btnDashboardRefresh">🔄 Refresh</button>
      </div>
    </div>

    ${isLive ? liveStripHtml(pending, preparing, oldestPendingMin) : ''}

    <div class="dash-zone">
      ${analysisHtml}

      ${lowStock.length ? `
        <h3 class="dash-h3 is-warning">⚠️ Low Stock</h3>
        <div class="dash-panel is-list">
          ${lowStock.map(i => {
            const disabled = i.isActive === false;
            return `<div class="dash-list-row${disabled ? ' is-dim' : ''}">
              <span>${escapeHtml(stripLeadingEmoji(i.name))}${disabled ? ' <span class="admin-card-badge badge-disabled">Disabled</span>' : ''}</span>
              <span class="dash-num">${Number(i.currentStock||0)} ${escapeHtml(i.unit||'')} <span class="dash-muted">(threshold ${i.lowStockThreshold})${disabled ? ' · ingredient disabled' : ''}</span></span>
            </div>`;
          }).join('')}
        </div>
      ` : ''}

      ${activityLogHtml(checklistLogs, stockHistory, today, dayWord, hasOrders)}
      ${featuredAuditHtml(featuredAudit)}
      ${latestSnapshotHtml(stockHistory)}
    </div>
  </div>`;

  container.innerHTML = html;

  // Feature 6: Date selector change handler
  const dateSelect = container.querySelector('#dashboardDateSelect');
  if (dateSelect) {
    dateSelect.onchange = () => {
      dashboardSelectedDate = dateSelect.value;
      container.innerHTML = '<div class="loading">Loading...</div>';
      fetchAndRenderDashboard(container);
    };
  }

  // Feature 7: Accordion click handlers for discount rows
  container.querySelectorAll('.discount-row').forEach(row => {
    row.onclick = () => {
      const accordionId = row.getAttribute('data-accordion');
      const breakdown = container.querySelector(`#${accordionId}`);
      if (breakdown) {
        const isVisible = breakdown.style.display !== 'none';
        breakdown.style.display = isVisible ? 'none' : 'table-row';
        // Toggle arrow indicator
        const td = row.querySelector('td');
        if (td) {
          td.innerHTML = td.innerHTML.replace(' ▸', '').replace(' ▾', '') + (isVisible ? ' ▸' : ' ▾');
        }
      }
    };
  });

  container.querySelector('#btnDashboardRefresh').onclick = () => {
    container.innerHTML = '<div class="loading">Refreshing...</div>';
    fetchAndRenderDashboard(container);
  };
}

/** Human date for the analysis zone heading on a past Sunday. */
function fmtDateLabel(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Zone 1: live strip ───────────────────────────────────────────────
/** Dense one-line service state. Rendered only for the real today — see
 *  renderDashboard's `isLive`. */
function liveStripHtml(pending, preparing, oldestPendingMin) {
  const wait = oldestPendingMin === null
    ? '<span class="dash-live-value">—</span><span class="dash-live-label">No pending orders</span>'
    : `<span class="dash-live-value">${oldestPendingMin}</span><span class="dash-live-label">min — oldest pending</span>`;
  return `<section class="dash-live" aria-label="Right now">
    <span class="dash-live-title">🔴 Right now</span>
    <div class="dash-live-metrics">
      <div class="dash-live-metric"><span class="dash-live-value">${pending}</span><span class="dash-live-label">Pending</span></div>
      <div class="dash-live-metric"><span class="dash-live-value">${preparing}</span><span class="dash-live-label">Preparing</span></div>
      <div class="dash-live-metric">${wait}</div>
    </div>
  </section>`;
}

// ─── Chart A: order source split ──────────────────────────────────────
/** One horizontal stacked bar, part-of-whole, derived client-side from the
 *  raw orders in the `daily` response. Legend + in-bar counts + a text
 *  equivalent table (which doubles as the reconciliation view: the three
 *  counts sum to the headline order count). */
function orderSourceChartHtml(counts, total) {
  const series = [
    { key: 'mobile',   label: 'Mobile',    cls: 'seg-mobile',   varName: '--src-mobile',   n: counts.mobile },
    { key: 'walkin',   label: 'Walk-in',   cls: 'seg-walkin',   varName: '--src-walkin',   n: counts.walkin },
    { key: 'preorder', label: 'Pre-order', cls: 'seg-preorder', varName: '--src-preorder', n: counts.preorder },
  ];

  if (!total) {
    return `
    <h3 class="dash-h3">📊 Order Source</h3>
    <div class="dash-panel">
      <p class="dash-empty">No orders on this date, so there is no split to show.</p>
    </div>`;
  }

  const pct = n => (n / total) * 100;
  const shown = series.filter(s => s.n > 0);

  const segs = shown.map((s, i) => {
    const p = pct(s.n);
    const rounded = Math.round(p);
    // Only label inside the segment when the text demonstrably fits.
    let inner = '';
    if (p >= 20) inner = `${s.n} · ${rounded}%`;
    else if (p >= 8) inner = `${s.n}`;
    const edge = `${i === 0 ? ' is-first' : ''}${i === shown.length - 1 ? ' is-last' : ''}`;
    return `<div class="dash-stack-seg ${s.cls}${edge}" style="flex-basis:${p.toFixed(2)}%">${inner}</div>`;
  }).join('');

  const legend = series.map(s =>
    `<li class="dash-legend-item"><span class="dash-swatch" style="background:var(${s.varName})"></span>${s.label}</li>`
  ).join('');

  const rows = series.map(s =>
    `<tr>
      <td><span class="dash-dot" style="background:var(${s.varName})"></span>${s.label}</td>
      <td class="num">${s.n}</td>
      <td class="num">${Math.round(pct(s.n))}%</td>
    </tr>`
  ).join('');

  const ariaParts = series.map(s => `${s.label} ${s.n}`).join(', ');

  return `
    <h3 class="dash-h3">📊 Order Source</h3>
    <div class="dash-panel">
      <p class="dash-caption">${total} orders on this date, excluding cancelled and expired — the same basis as the headline order count.</p>
      <ul class="dash-legend">${legend}</ul>
      <div class="dash-stack" role="img" aria-label="Order source split: ${ariaParts} of ${total} orders">${segs}</div>
      <table class="dash-table dash-table-compact">
        <caption>Order source, exact figures</caption>
        <thead><tr><th>Source</th><th class="num">Orders</th><th class="num">Share</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${total}</td><td class="num">100%</td></tr></tfoot>
      </table>
    </div>`;
}

// ─── Chart B: top items ───────────────────────────────────────────────
/** Horizontal bars, single series (so no legend — the heading names it).
 *  Same data and status filter as before: ARCHIVED + READY only. */
function topItemsChartHtml(topItems, dayWord) {
  const heading = dayWord ? 'Top Items Today' : 'Top Items';
  if (!topItems.length) {
    return `
    <h3 class="dash-h3">🏆 ${heading}</h3>
    <div class="dash-panel">
      <p class="dash-empty">No items served on this date.</p>
    </div>`;
  }
  const max = topItems[0][1] || 1;
  const rows = topItems.map(([name, qty]) => `
    <div class="dash-bar-row">
      <span class="dash-bar-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${((qty / max) * 100).toFixed(1)}%"></div></div>
      <span class="dash-bar-value">${qty}</span>
    </div>`).join('');
  return `
    <h3 class="dash-h3">🏆 ${heading} <span class="dash-h3-note">(qty sold)</span></h3>
    <div class="dash-panel">
      <div class="dash-bars">${rows}</div>
    </div>`;
}

// ─── Chart C: session comparison ──────────────────────────────────────
/** Orders and Revenue are different measures on different scales, so they get
 *  two small charts with independent scales — never one chart with two axes.
 *  Avg and top item stay as a footnote so no figure from the old cards is lost. */
function sessionChartHtml(s1, s2, s1TimeRange, s2TimeRange, s1Highlight, s2Highlight) {
  const a = {
    name: 'Session 1', cls: 'is-ses1', varName: '--ses-1', range: s1TimeRange, win: s1Highlight,
    orders: Number(s1?.orderCount || 0), revenue: Number(s1?.revenue || 0), avg: Number(s1?.avgOrderValue || 0),
    top: (s1?.topItems || [])[0],
  };
  const b = {
    name: 'Session 2', cls: 'is-ses2', varName: '--ses-2', range: s2TimeRange, win: s2Highlight,
    orders: Number(s2?.orderCount || 0), revenue: Number(s2?.revenue || 0), avg: Number(s2?.avgOrderValue || 0),
    top: (s2?.topItems || [])[0],
  };

  if (!a.orders && !b.orders && !a.revenue && !b.revenue) {
    return `
    <h3 class="dash-h3">⏱ Session Comparison</h3>
    <div class="dash-panel">
      <p class="dash-empty">Neither session recorded an order on this date.</p>
    </div>`;
  }

  const mini = (title, pick, fmt) => {
    const max = Math.max(pick(a), pick(b), 0);
    const row = s => {
      const w = max > 0 ? (pick(s) / max) * 100 : 0;
      return `<div class="dash-bar-row">
        <span class="dash-bar-name">${s.name.replace('Session ', 'S')}</span>
        <div class="dash-bar-track"><div class="dash-bar-fill ${s.cls}" style="width:${w.toFixed(1)}%"></div></div>
        <span class="dash-bar-value">${fmt(pick(s))}</span>
      </div>`;
    };
    return `<div class="dash-mini">
      <h4 class="dash-mini-title">${title}</h4>
      <div class="dash-bars">${row(a)}${row(b)}</div>
    </div>`;
  };

  // The 🏆 belongs to the legend, not to a bar: the winner is decided on
  // revenue, and the Orders chart can rank the other way round.
  const legend = [a, b].map(s =>
    `<li class="dash-legend-item">
      <span class="dash-swatch" style="background:var(${s.varName})"></span>
      ${s.name}${s.win ? ' 🏆 <span class="dash-legend-note">top revenue</span>' : ''}
      <span class="dash-legend-note">${escapeHtml(s.range)}</span>
    </li>`).join('');

  const notes = [a, b].map(s => {
    const topLabel = s.top ? `${stripLeadingEmoji(s.top.name || '')} (${s.top.count})` : '—';
    return `<div>${s.name}: avg <strong>RM ${s.avg.toFixed(2)}</strong> · top ${escapeHtml(topLabel)}</div>`;
  }).join('');

  return `
    <h3 class="dash-h3">⏱ Session Comparison</h3>
    <div class="dash-panel">
      <ul class="dash-legend">${legend}</ul>
      <div class="dash-minis">
        ${mini('Orders', s => s.orders, v => String(v))}
        ${mini('Revenue (RM)', s => s.revenue, v => v.toFixed(2))}
      </div>
      <div class="dash-notes">${notes}</div>
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

/** The one time formatter for this module. (There used to be a second,
 *  differently-formatted one shadowing it inside featuredAuditHtml.) */
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-MY', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Build the "Activity" section. Merges completed checklist phases
 *  (open / handover / close) and stock-count snapshots into a chronological
 *  timeline. `dayWord` is '' for a past date, so the heading and the empty
 *  state stop claiming "today". Suppressed entirely on a zero-order date with
 *  nothing recorded — that is part of the analysis-zone collapse. */
function activityLogHtml(checklistLogsRes, stockHistoryRes, today, dayWord, hasOrders) {
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

  // Nothing happened and nothing was sold: don't add an empty panel to a page
  // that already says "no orders on this date".
  if (!events.length && !hasOrders) return '';

  const body = events.length
    ? events.map(e => `<div class="dash-list-row">${escapeHtml(e.label)}</div>`).join('')
    : `<p class="dash-empty">No activity recorded ${dayWord ? 'today' : 'on this date'}.</p>`;

  return `
    <h3 class="dash-h3">📋 ${dayWord ? "Today's Activity" : 'Activity'}</h3>
    <div class="dash-panel is-list">${body}</div>`;
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
    .map(c => `<div class="dash-list-row">
      <span>${escapeHtml(stripLeadingEmoji(c.name || '?'))}</span>
      <span class="dash-num">${Number(c.count ?? 0)} ${escapeHtml(c.unit || '')}${c.storageLocation ? ` <span class="dash-muted">· ${escapeHtml(c.storageLocation)}</span>` : ''}</span>
    </div>`).join('');

  // Reference data, and long (20+ rows). Collapsed by default so it stops
  // dominating the page height; native <details> so keyboard and screen
  // readers get the disclosure for free. The summary keeps the row count plus
  // the existing timestamp/user context, so nothing is hidden without a trace.
  return `
    <details class="dash-details">
      <summary>
        <h3 class="dash-h3">📦 Latest Stock Count <span class="dash-h3-note">(${counts.length} items · ${fmtTime(latest.timestamp)} by ${escapeHtml(latest.submittedBy || 'Unknown')})</span></h3>
      </summary>
      <div class="dash-panel is-list">${rows}</div>
    </details>`;
}


// ─── Featured Drink Audit (Dashboard) ──────────────────────────────────────
function featuredAuditHtml(auditRes) {
  const entries = Array.isArray(auditRes?.entries) ? auditRes.entries : [];
  if (!entries.length) return '';

  const rows = entries.map(e => {
    const icon = e.action === 'FEATURE' ? '⭐' : '✖️';
    const label = e.action === 'FEATURE'
      ? `Featured <strong>${escapeHtml(e.menuItemName || '?')}</strong>`
      : 'Removed featured drink';
    return `<div class="dash-list-row">
      <span>${icon} ${label}</span>
      <span class="dash-muted dash-meta">${fmtTime(e.timestamp)} · ${escapeHtml(e.user || 'Unknown')}</span>
    </div>`;
  }).join('');

  return `
    <h3 class="dash-h3">⭐ Featured Drink Audit</h3>
    <div class="dash-panel is-list">${rows}</div>`;
}
