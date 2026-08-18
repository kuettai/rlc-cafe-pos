// admin-customers.js — Customer list view for admin panel.
// Depends on: admin.js (api, showError, $, escapeHtml)

async function loadCustomers(container) {
  container.innerHTML = '<div class="loading">Loading customers...</div>';
  try {
    const data = await api('GET', '/api/admin/customers');
    renderCustomersSection(container, data.customers || []);
  } catch (e) {
    container.innerHTML = '<div class="admin-empty"><p>Failed to load customers</p></div>';
  }
}

function renderCustomersSection(container, customers, sortField = 'totalSpent', sortDir = 'desc', search = '') {
  // Filter
  const filtered = search
    ? customers.filter(c =>
        (c.name || '').toLowerCase().includes(search.toLowerCase()) ||
        (c.phone || '').includes(search)
      )
    : customers;

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    let av = a[sortField], bv = b[sortField];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const arrow = (field) => {
    if (field !== sortField) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  // Sortable headers are real controls: reachable by Tab, operable by Enter or
  // Space, and announced with their current direction. They were click-only
  // `<th>`s with no tabindex, role or aria-sort, so sorting was unavailable to
  // anyone not using a pointer.
  const th = (field, label, extra) => `<th class="sortable-col" data-sort="${field}"
    tabindex="0" role="button"
    aria-sort="${field === sortField ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}"
    aria-label="Sort by ${label}${field === sortField ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}"
    style="padding:10px 12px;white-space:nowrap${extra || ''}">${label}${arrow(field)}</th>`;

  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>👤 Customers</h2>
      <span style="color:var(--text-light);font-size:.85rem">${filtered.length} customer${filtered.length !== 1 ? 's' : ''}</span>
    </div>
    <div style="margin-bottom:16px">
      <input id="customerSearch" class="pos-input" placeholder="Search by name or phone..." value="${escapeHtml(search)}" style="max-width:320px">
    </div>`;

  if (!sorted.length) {
    html += '<div class="admin-empty"><p>No customers found.</p></div>';
  } else {
    html += `<div style="overflow-x:auto">
      <table class="admin-table" style="width:100%;border-collapse:collapse;font-size:.9rem">
        <thead>
          <tr style="border-bottom:2px solid var(--cream-dark);text-align:left">
            ${th('phone', 'Phone')}
            ${th('name', 'Name')}
            ${th('orderCount', 'Orders', ';text-align:right')}
            ${th('totalSpent', 'Total Spent (RM)', ';text-align:right')}
            ${th('lastOrderAt', 'Last Visit')}
          </tr>
        </thead>
        <tbody>`;

    sorted.forEach(c => {
      const lastVisit = c.lastOrderAt
        ? new Date(c.lastOrderAt).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';
      html += `<tr style="border-bottom:1px solid var(--cream-dark)">
        <td style="padding:10px 12px;font-family:monospace;font-size:.85rem">${escapeHtml(c.phone)}</td>
        <td style="padding:10px 12px">${escapeHtml(c.name || '—')}</td>
        <td style="padding:10px 12px;text-align:right">${c.orderCount}</td>
        <td style="padding:10px 12px;text-align:right;font-weight:600">${(c.totalSpent || 0).toFixed(2)}</td>
        <td style="padding:10px 12px;color:var(--text-light)">${lastVisit}</td>
      </tr>`;
    });

    html += `</tbody></table></div>`;
  }

  html += '</div>';
  container.innerHTML = html;

  // Search input handler
  const searchInput = container.querySelector('#customerSearch');
  let searchTimeout = null;
  searchInput.oninput = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      renderCustomersSection(container, customers, sortField, sortDir, searchInput.value.trim());
    }, 300);
  };
  // Only take focus when the operator is already typing here — an unconditional
  // focus() on every re-render pops the iPad keyboard on entering the tab and
  // moves the caret to the end mid-edit.
  if (search) {
    searchInput.focus();
    const end = searchInput.value.length;
    try { searchInput.setSelectionRange(end, end); } catch (e) { /* not text-like */ }
  }

  // Sort column headers — pointer, Enter and Space all do the same thing.
  container.querySelectorAll('.sortable-col').forEach(cell => {
    const sort = () => {
      const field = cell.dataset.sort;
      let newDir = 'desc';
      if (field === sortField) {
        newDir = sortDir === 'desc' ? 'asc' : 'desc';
      }
      renderCustomersSection(container, customers, field, newDir, searchInput.value.trim());
      // The table was replaced; put focus back on the header just activated so
      // a keyboard user is not returned to the top of the page.
      const again = container.querySelector(`.sortable-col[data-sort="${field}"]`);
      if (again) again.focus();
    };
    cell.onclick = sort;
    cell.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); sort(); }
    };
  });
}
