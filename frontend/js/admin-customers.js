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
            <th class="sortable-col" data-sort="phone" style="padding:10px 12px;cursor:pointer;white-space:nowrap">Phone${arrow('phone')}</th>
            <th class="sortable-col" data-sort="name" style="padding:10px 12px;cursor:pointer;white-space:nowrap">Name${arrow('name')}</th>
            <th class="sortable-col" data-sort="orderCount" style="padding:10px 12px;cursor:pointer;white-space:nowrap;text-align:right">Orders${arrow('orderCount')}</th>
            <th class="sortable-col" data-sort="totalSpent" style="padding:10px 12px;cursor:pointer;white-space:nowrap;text-align:right">Total Spent (RM)${arrow('totalSpent')}</th>
            <th class="sortable-col" data-sort="lastOrderAt" style="padding:10px 12px;cursor:pointer;white-space:nowrap">Last Visit${arrow('lastOrderAt')}</th>
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
  searchInput.focus();

  // Sort column headers
  container.querySelectorAll('.sortable-col').forEach(th => {
    th.onclick = () => {
      const field = th.dataset.sort;
      let newDir = 'desc';
      if (field === sortField) {
        newDir = sortDir === 'desc' ? 'asc' : 'desc';
      }
      renderCustomersSection(container, customers, field, newDir, searchInput.value.trim());
    };
  });
}
