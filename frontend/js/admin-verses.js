// admin-verses.js — Bible Verses tab (Admin)
// Part of rlc-cafe-pos v1.55.0
// Depends on: admin.js (api, showError, showSuccess, showFormModal)

async function loadVerses(container) {
  container.innerHTML = '<div class="loading">Loading verses...</div>';
  try {
    const data = await api('GET', '/api/admin/verses');
    renderVersesSection(container, data.verses || []);
  } catch(e) { container.innerHTML = '<div class="admin-empty"><p>Failed to load verses</p></div>'; }
}

function renderVersesSection(container, verses) {
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>✝️ Bible Verses</h2>
      <button id="btnAddVerse" class="pos-btn pos-btn-primary pos-btn-sm">+ Add Verse</button>
    </div>
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:16px">
      One random verse is shown to customers after they place an order.
    </p>`;

  if (!verses.length) {
    html += '<p style="color:var(--text-light);padding:16px">No verses added yet.</p>';
  } else {
    html += verses.map(v => `<div class="admin-form" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:12px">
      <div style="flex:1">
        <span style="font-style:italic">"${v.text.length > 80 ? v.text.slice(0,80)+'...' : v.text}"</span>
        <br><small style="color:var(--primary);font-weight:600">— ${v.reference}</small>
        ${v.isActive === false ? ' <span class="admin-card-badge badge-disabled">Disabled</span>' : ''}
      </div>
      <div style="display:flex;gap:6px">
        <button class="pos-btn pos-btn-sm" data-toggle-verse="${v.verseId}" data-active="${v.isActive !== false}">${v.isActive !== false ? 'Disable' : 'Enable'}</button>
        <button class="pos-btn pos-btn-sm" style="color:var(--danger)" data-del-verse="${v.verseId}">✕</button>
      </div>
    </div>`).join('');
  }
  html += '</div>';
  container.innerHTML = html;

  // Event handlers
  document.getElementById('btnAddVerse').onclick = () => openVerseForm(container);
  container.querySelectorAll('[data-toggle-verse]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.toggleVerse;
      const nowActive = btn.dataset.active === 'true';
      try { await api('PUT', `/api/admin/verses/${id}`, { isActive: !nowActive }); loadVerses(container); }
      catch(e) { showError('Failed to toggle verse'); }
    };
  });
  container.querySelectorAll('[data-del-verse]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Delete this verse?')) return;
      try { await api('DELETE', `/api/admin/verses/${btn.dataset.delVerse}`); loadVerses(container); }
      catch(e) { showError('Failed to delete verse'); }
    };
  });
}

function openVerseForm(container) {
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.style.marginBottom = '16px';
  form.innerHTML = `
    <h3 style="margin-bottom:12px">Add Bible Verse</h3>
    <textarea id="verseText" class="pos-input" rows="3" placeholder="Verse text (e.g. Come to me, all you who are weary...)" required style="width:100%;margin-bottom:10px"></textarea>
    <input id="verseRef" class="pos-input" placeholder="Reference (e.g. Matthew 11:28)" required style="width:100%;margin-bottom:12px">
    <div style="display:flex;gap:8px">
      <button type="submit" class="pos-btn pos-btn-primary pos-btn-sm">Save</button>
      <button type="button" class="pos-btn pos-btn-sm" id="verseCancelBtn">Cancel</button>
    </div>`;
  showFormModal(form);
  form.querySelector('#verseCancelBtn').onclick = () => form._overlay.remove();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = form.querySelector('#verseText').value.trim();
    const reference = form.querySelector('#verseRef').value.trim();
    if (!text || !reference) return;
    try {
      await api('POST', '/api/admin/verses', { text, reference });
      form._overlay.remove();
      loadVerses(container);
      showSuccess('Verse added');
    } catch(e) { showError('Failed to add verse'); }
  };
}
