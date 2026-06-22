/**
 * Sales reports for RLC Café — admin-only.
 *
 * Data source: GET /api/admin/reports?startDate&endDate (returns orders
 * with status ARCHIVED / READY / CANCELLED+postCompletionCancel within
 * the range). All aggregation is done client-side so different views
 * stay in sync without re-fetching.
 *
 * Auth follows the same pattern as admin.js — sessionStorage-keyed JWT,
 * shared `pos_token` so a user logged in via admin.html stays logged in
 * here.
 */
(function () {
'use strict';

const $ = sel => document.querySelector(sel);
const app = $('#app');

let token = sessionStorage.getItem('pos_token');
let currentUser = sessionStorage.getItem('pos_user') || '';

// View state
let activeTab = 'summary';                                  // 'summary' | 'detail'
let selectedMonth = currentMonthStr();                       // 'YYYY-MM'
let detailStartDate = '';
let detailEndDate = '';
let cachedOrders = null;                                     // last fetch
let cachedRange = null;                                      // {start, end}

// ─── Helpers ──────────────────────────────────────────────────────────

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function api(method, path) {
  const res = await fetch(`${API_BASE}${path}`, { method, headers: authHeaders() });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

function showError(msg) {
  const b = $('#errorBanner');
  if (!b) return;
  b.textContent = msg;
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), 4000);
}

function rm(n) {
  const v = Number(n) || 0;
  return `RM ${v.toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** First and last day of a YYYY-MM month, in local time. */
function monthBounds(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end   = new Date(y, m, 0);   // day 0 of next month = last day of this
  return {
    start, end,
    startStr: `${y}-${pad2(m)}-${pad2(1)}`,
    endStr:   `${y}-${pad2(m)}-${pad2(end.getDate())}`,
  };
}

/** Sundays in a YYYY-MM month, returned as YYYY-MM-DD strings (local). */
function sundaysInMonth(yyyymm) {
  const { start, end } = monthBounds(yyyymm);
  const out = [];
  const d = new Date(start);
  while (d <= end) {
    if (d.getDay() === 0) {
      out.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Local-date string (YYYY-MM-DD) for an ISO timestamp, in the browser's TZ. */
function localDateStr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function logout() {
  token = null;
  currentUser = '';
  sessionStorage.removeItem('pos_token');
  sessionStorage.removeItem('pos_user');
  renderLogin();
}

// ─── Auth ─────────────────────────────────────────────────────────────

function renderLogin() {
  app.innerHTML = `<div class="admin-login">
    <h2>Reports Login</h2>
    <p>Admin access required</p>
    <form id="loginForm">
      <input id="loginUser" placeholder="Your name (e.g. Admin)" required autocomplete="username" class="pos-input">
      <input id="loginPin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" required class="pos-input">
      <button type="submit" class="pos-btn pos-btn-primary" style="width:100%">Login</button>
    </form>
    <p style="margin-top:14px;font-size:.85rem"><a href="admin.html" style="color:var(--primary,#6B4226)">← Back to Admin</a></p>
  </div>`;

  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: $('#loginUser').value, pin: $('#loginPin').value }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data.role !== 'ADMIN') { showError('Admin access required'); return; }
      token = data.token;
      currentUser = data.name || 'Admin';
      sessionStorage.setItem('pos_token', token);
      sessionStorage.setItem('pos_user', currentUser);
      renderApp();
    } catch (e) { showError('Invalid credentials'); }
  };
}

// ─── App shell ────────────────────────────────────────────────────────

function renderApp() {
  app.innerHTML = `<main class="admin-main" style="display:block">
    <div class="admin-section" style="margin-bottom:16px">
      <div class="admin-section-header" style="flex-wrap:wrap;gap:12px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <h2 style="margin:0">📊 Sales Reports</h2>
          <span style="color:var(--text-light,#7A6355);font-size:.9rem">Logged in as ${escapeHtml(currentUser)}</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label style="font-size:.85rem;color:var(--text-light,#7A6355)">Month
            <input type="month" id="rptMonth" value="${selectedMonth}" class="pos-input" style="margin-left:6px;width:auto">
          </label>
          <button class="pos-btn pos-btn-sm" id="rptLogout">Logout</button>
        </div>
      </div>

      <div style="display:flex;gap:6px;margin-top:14px;border-bottom:1px solid var(--cream-dark,#E5DACB)">
        <button class="pos-btn pos-btn-sm" data-tab="summary" id="tabSummary">📈 Summary</button>
        <button class="pos-btn pos-btn-sm" data-tab="detail"  id="tabDetail">📋 Detail</button>
      </div>

      <div id="rptContent" style="margin-top:16px"></div>
    </div>
  </main>`;

  $('#rptMonth').onchange = (e) => {
    selectedMonth = e.target.value || currentMonthStr();
    cachedOrders = null; // force re-fetch
    loadActiveTab();
  };
  $('#rptLogout').onclick = logout;
  $('#tabSummary').onclick = () => switchTab('summary');
  $('#tabDetail').onclick  = () => switchTab('detail');

  highlightTab();
  loadActiveTab();
}

function switchTab(tab) {
  activeTab = tab;
  highlightTab();
  loadActiveTab();
}

function highlightTab() {
  ['summary', 'detail'].forEach(t => {
    const b = document.querySelector(`[data-tab="${t}"]`);
    if (!b) return;
    if (t === activeTab) b.classList.add('pos-btn-primary');
    else b.classList.remove('pos-btn-primary');
  });
}

async function loadActiveTab() {
  const target = $('#rptContent');
  if (!target) return;
  target.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await ensureMonthData();
  } catch (e) {
    target.innerHTML = '<div class="admin-empty"><p>Failed to load orders</p></div>';
    return;
  }
  if (activeTab === 'summary') renderSummary(target);
  else renderDetail(target);
}

/** Fetch the month's orders if not already cached for the current month. */
async function ensureMonthData() {
  const { startStr, endStr } = monthBounds(selectedMonth);
  if (cachedOrders && cachedRange && cachedRange.start === startStr && cachedRange.end === endStr) {
    return;
  }
  const data = await api('GET', `/api/admin/reports?startDate=${startStr}&endDate=${endStr}`);
  cachedOrders = data.orders || [];
  cachedRange = { start: startStr, end: endStr };
  // Default the detail tab's date inputs to the selected month bounds.
  detailStartDate = startStr;
  detailEndDate = endStr;
}

// ─── Summary tab ──────────────────────────────────────────────────────

function renderSummary(container) {
  const sundays = sundaysInMonth(selectedMonth);
  const orders = cachedOrders || [];

  // Group orders by their local createdAt date.
  const byDate = {};
  for (const o of orders) {
    const d = localDateStr(o.createdAt);
    (byDate[d] = byDate[d] || []).push(o);
  }

  // Per-Sunday metrics + totals.
  const cols = sundays.map(d => buildSummaryCol(byDate[d] || []));
  const totalCol = aggregateCols(cols);

  if (!sundays.length) {
    container.innerHTML = '<div class="admin-empty"><p>No Sundays in this month — pick another month.</p></div>';
    return;
  }

  const headerCells = [
    '<th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--cream-dark,#E5DACB)">Metric</th>',
    ...sundays.map(d => `<th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--cream-dark,#E5DACB);font-variant-numeric:tabular-nums">${formatSundayHeader(d)}</th>`),
    '<th style="text-align:right;padding:8px 10px;border-bottom:2px solid var(--cream-dark,#E5DACB);font-variant-numeric:tabular-nums">Total</th>',
  ].join('');

  const rowDef = [
    { key: 'gross',    label: 'Gross Sales',         fmt: rm,    pos: true  },
    { key: 'discount', label: 'Less Discounts',      fmt: v => '-' + rm(v), pos: false },
    { key: 'net',      label: 'Net Sales',           fmt: rm,    pos: true,  bold: true },
    { key: 'refund',   label: 'Refunds',             fmt: v => '-' + rm(v), pos: false },
    { key: 'adjusted', label: 'Adjusted Net Sales',  fmt: rm,    pos: true,  bold: true },
    { key: 'count',    label: 'Order Count',         fmt: v => String(Math.round(v)) },
    { key: 'aov',      label: 'Avg Order Value',     fmt: rm },
  ];

  const rowsHtml = rowDef.map(r => {
    const cells = [
      `<td style="padding:6px 10px;${r.bold ? 'font-weight:700' : ''}">${r.label}</td>`,
      ...cols.map(c => {
        const v = c[r.key] || 0;
        const muted = v === 0 ? 'color:var(--text-light,#7A6355)' : '';
        return `<td style="text-align:right;padding:6px 10px;font-variant-numeric:tabular-nums;${r.bold ? 'font-weight:700;' : ''}${muted}">${r.fmt(v)}</td>`;
      }),
      (() => {
        const v = totalCol[r.key] || 0;
        return `<td style="text-align:right;padding:6px 10px;font-variant-numeric:tabular-nums;border-left:1px solid var(--cream-dark,#E5DACB);${r.bold ? 'font-weight:700;' : ''}">${r.fmt(v)}</td>`;
      })(),
    ].join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  container.innerHTML = `
    <div style="overflow-x:auto">
      <table style="border-collapse:collapse;width:100%;min-width:640px">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <p style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:12px">
      Gross / Net based on ARCHIVED + READY orders. Refunds = post-completion cancellations.
      Discounts include all <code>discountOffset</code> values (NEWCOMER, STAFF, PASTOR, CELEBRATION, VOUCHER).
    </p>
  `;
}

/** Aggregate one column of the summary from a list of orders for a single day. */
function buildSummaryCol(orders) {
  let gross = 0, discount = 0, refund = 0, count = 0;
  for (const o of orders) {
    const total = Number(o.totalAmount || 0);
    const off = Number(o.discountOffset || 0);
    if (o.postCompletionCancel === true) {
      // Refund line — was previously counted as a sale, now reverted.
      refund += total;
    } else if (o.status === 'ARCHIVED' || o.status === 'READY') {
      gross    += total + off; // total is already net-of-discount; gross = net + discount
      discount += off;
      count    += 1;
    }
    // Pure CANCELLED without postCompletionCancel: not counted (never a sale).
  }
  const net = gross - discount;
  const adjusted = net - refund;
  const aov = count > 0 ? (net / count) : 0;
  return { gross, discount, net, refund, adjusted, count, aov };
}

function aggregateCols(cols) {
  const total = { gross: 0, discount: 0, net: 0, refund: 0, adjusted: 0, count: 0, aov: 0 };
  for (const c of cols) {
    total.gross    += c.gross;
    total.discount += c.discount;
    total.net      += c.net;
    total.refund   += c.refund;
    total.adjusted += c.adjusted;
    total.count    += c.count;
  }
  total.aov = total.count > 0 ? (total.net / total.count) : 0;
  return total;
}

function formatSundayHeader(d) {
  // d is YYYY-MM-DD; render as "Sun 02 Jun" using local time.
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(y, m - 1, day);
  const month = dt.toLocaleString('en-MY', { month: 'short' });
  return `Sun ${pad2(day)} ${month}`;
}

// ─── Detail tab ───────────────────────────────────────────────────────

function renderDetail(container) {
  container.innerHTML = `
    <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:14px">
      <label style="display:flex;flex-direction:column;font-size:.85rem;color:var(--text-light,#7A6355)">
        From <input id="dtFrom" type="date" class="pos-input" value="${detailStartDate}">
      </label>
      <label style="display:flex;flex-direction:column;font-size:.85rem;color:var(--text-light,#7A6355)">
        To <input id="dtTo" type="date" class="pos-input" value="${detailEndDate}">
      </label>
      <button class="pos-btn pos-btn-primary pos-btn-sm" id="dtFilter">Filter</button>
      <button class="pos-btn pos-btn-sm" id="dtCsv">⬇ Download CSV</button>
    </div>
    <div id="dtTableHost"></div>
  `;

  $('#dtFilter').onclick = async () => {
    const f = $('#dtFrom').value, t = $('#dtTo').value;
    if (!f || !t) { showError('Pick both from and to dates'); return; }
    if (t < f)    { showError('To date must be on or after From date'); return; }
    detailStartDate = f;
    detailEndDate = t;
    // If the requested range is outside the cached month, refetch.
    if (!cachedRange || f < cachedRange.start || t > cachedRange.end) {
      $('#dtTableHost').innerHTML = '<div class="loading">Loading…</div>';
      try {
        const data = await api('GET', `/api/admin/reports?startDate=${f}&endDate=${t}`);
        cachedOrders = data.orders || [];
        cachedRange = { start: f, end: t };
      } catch (e) {
        showError('Failed to load orders');
        return;
      }
    }
    renderDetailTable();
  };

  $('#dtCsv').onclick = downloadDetailCsv;

  renderDetailTable();
}

function visibleDetailOrders() {
  const orders = cachedOrders || [];
  const f = detailStartDate, t = detailEndDate;
  return orders
    .filter(o => {
      const d = localDateStr(o.createdAt);
      return d >= f && d <= t;
    })
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function renderDetailTable() {
  const host = $('#dtTableHost');
  if (!host) return;
  const rows = visibleDetailOrders();

  if (!rows.length) {
    host.innerHTML = '<div class="admin-empty"><p>No orders in this range.</p></div>';
    return;
  }

  const head = [
    'Date / Time', 'Order ID', 'Items', 'Gross (RM)', 'Discount (RM)', 'Net (RM)', 'Status', 'Customer',
  ].map(h => `<th style="text-align:left;padding:8px 10px;border-bottom:2px solid var(--cream-dark,#E5DACB)">${h}</th>`).join('');

  const body = rows.map(o => {
    const isRefund = o.postCompletionCancel === true;
    const items = (o.items || []).map(i => {
      const v = i.variant ? ` (${i.variant})` : '';
      return `${i.name}${v}`;
    }).join(', ');
    const total = Number(o.totalAmount || 0);
    const off = Number(o.discountOffset || 0);
    const gross = total + off;
    const status = isRefund
      ? `CANCELLED (refund)${o.cancelReason ? ' — ' + escapeHtml(o.cancelReason) : ''}`
      : escapeHtml(o.status || '');
    const rowStyle = isRefund
      ? 'background:#FEE2E2;color:#7F1D1D'
      : '';
    const idShort = String(o.orderId || '').slice(0, 8);

    return `<tr style="${rowStyle}">
      <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${new Date(o.createdAt).toLocaleString('en-MY')}</td>
      <td style="padding:6px 10px;font-family:monospace;font-size:.85rem">${escapeHtml(idShort)}</td>
      <td style="padding:6px 10px">${escapeHtml(items)}</td>
      <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${gross.toFixed(2)}</td>
      <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${off.toFixed(2)}</td>
      <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${total.toFixed(2)}</td>
      <td style="padding:6px 10px">${status}</td>
      <td style="padding:6px 10px">${escapeHtml(o.customerName || '')}</td>
    </tr>`;
  }).join('');

  host.innerHTML = `
    <div style="overflow-x:auto">
      <table style="border-collapse:collapse;width:100%;min-width:880px">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:10px">${rows.length} row${rows.length === 1 ? '' : 's'}.</p>
  `;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadDetailCsv() {
  const rows = visibleDetailOrders();
  const headers = ['Date/Time', 'OrderId', 'Items', 'GrossRM', 'DiscountRM', 'NetRM', 'Status', 'CancelReason', 'Customer'];
  const lines = [headers.map(csvEscape).join(',')];
  for (const o of rows) {
    const items = (o.items || []).map(i => i.name + (i.variant ? ` (${i.variant})` : '')).join(', ');
    const total = Number(o.totalAmount || 0);
    const off = Number(o.discountOffset || 0);
    const gross = total + off;
    const status = o.postCompletionCancel === true ? 'CANCELLED (refund)' : (o.status || '');
    lines.push([
      new Date(o.createdAt).toISOString(),
      o.orderId || '',
      items,
      gross.toFixed(2),
      off.toFixed(2),
      total.toFixed(2),
      status,
      o.cancelReason || '',
      o.customerName || '',
    ].map(csvEscape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rlc-cafe-report-${detailStartDate}_to_${detailEndDate}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
}

// ─── Init ─────────────────────────────────────────────────────────────

token ? renderApp() : renderLogin();

})();
