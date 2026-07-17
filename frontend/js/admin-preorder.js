// admin-preorder.js — Pre-order links management + templates
// Depends on: admin.js (api, showError, showSuccess, showFormModal, $)

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
  // Cache the list keyed by code so the Edit button can pre-fill the form
  // without a second network round-trip.
  container._codesByCode = {};
  codes.forEach(c => { if (c && c.code) container._codesByCode[c.code] = c; });
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
            <button class="pos-btn pos-btn-sm" data-edit-code="${escapeAttr(c.code)}">✏️ Edit</button>
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
  container.querySelectorAll('[data-edit-code]').forEach(btn => {
    btn.onclick = () => {
      const code = btn.dataset.editCode;
      const existing = container._codesByCode && container._codesByCode[code];
      if (!existing) { showError('Code not found in current view — refresh and retry'); return; }
      openPreorderForm(container, existing);
    };
  });
}

function openPreorderForm(container, existingCode){
  const isEdit = !!(existingCode && existingCode.code);
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

  // ─── Resolve initial field values (edit vs create) ────────────────
  const initialName = isEdit
    ? String(existingCode.name || '')
    : `Sunday ${nextSunday.toLocaleDateString(undefined,{day:'numeric',month:'short'})} Service`;
  const initialServiceDate = isEdit && existingCode.serviceDate ? existingCode.serviceDate : serviceDate;
  const initialOpensLocal = isEdit && existingCode.opensAt
    ? toLocalInput(new Date(existingCode.opensAt))
    : toLocalInput(now);
  const initialExpiresLocal = isEdit && existingCode.expiresAt
    ? toLocalInput(new Date(existingCode.expiresAt))
    : toLocalInput(expiresGuess);
  const initialBanner = isEdit ? String(existingCode.bannerMessage || '') : '';

  // Fetch admin menu (all active DRINKs) for the eligibility checkboxes,
  // and the current default templates in parallel. Both kicked off eagerly;
  // the form renders as they arrive.
  const menuP = api('GET', '/api/admin/menu').then(d => (Array.isArray(d) ? d : d.items || []).filter(m => m.category === 'DRINK')).catch(() => []);
  const templatesP = api('GET', '/api/admin/settings/preorder-templates').catch(() => ({
    // Backstop defaults (also the backend defaults) so a failing endpoint
    // still gives the operator a usable form.
    bannerMessage: 'Ministry Pre-Order — Kindly select one drink\n{$SUNDAY} Service · Collect {$SUNDAY}',
    eligibleItemKeywords: ['latte', 'long black', 'decaf', 'soda', 'tea', 'mineral water'],
    collectionOptions: ['After 1st Service', 'After 2nd Service'],
  }));
  // Collection-option working state (mutated by wirePreorderForm).
  // In edit mode seed from the existing code; otherwise start with the
  // hardcoded default and let the templates fetch overwrite.
  let collectionOpts = isEdit && Array.isArray(existingCode.collectionOptions) && existingCode.collectionOptions.length
    ? existingCode.collectionOptions.slice()
    : ['After 1st Service', 'After 2nd Service'];

  // Placeholder shell — the drink list slot gets populated once menuP settles.
  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>${isEdit ? 'Edit Pre-Order Link' : 'Create Pre-Order Link'}</h3>
    ${isEdit ? `<p style="color:var(--text-light);font-size:.85rem;margin-top:-4px">Code: <strong style="font-family:monospace;letter-spacing:.05em">${escapeHtml(existingCode.code)}</strong></p>` : ''}
    <div class="admin-form-group"><label>Event Name</label>
      <input id="pfName" class="pos-input" placeholder="e.g. Sunday 6 Jul Service" value="${escapeAttr(initialName)}">
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Service Date</label>
        <input id="pfDate" type="date" class="pos-input" value="${initialServiceDate}">
      </div>
      <div class="admin-form-group"><label>Opens At</label>
        <input id="pfOpens" type="datetime-local" class="pos-input" value="${initialOpensLocal}">
      </div>
      <div class="admin-form-group"><label>Expires At</label>
        <input id="pfExpires" type="datetime-local" class="pos-input" value="${initialExpiresLocal}">
      </div>
    </div>
    <p style="font-size:.8rem;color:var(--text-light);margin-top:4px">
      Service auto-cutoff is fixed at 3PM MYT on service date — pre-orders auto-expire then.
    </p>

    <div class="admin-form-group">
      <label>Banner Message <span style="color:var(--text-light);font-weight:400">(optional, max 200 chars)</span></label>
      <textarea id="pfBanner" class="pos-input" rows="3" maxlength="200" placeholder="Ministry Pre-Order — Kindly select one drink&#10;{$SUNDAY} Service · Collect {$SUNDAY}" style="min-height:60px;font-family:inherit">${escapeHtml(initialBanner)}</textarea>
      <p style="font-size:.75rem;color:var(--text-light);margin-top:4px">Use <code>{$SUNDAY}</code> to auto-insert the next Sunday date (e.g. "Sunday, 12 Jul"). Leave blank for the default template.</p>
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
      <p style="font-size:.75rem;color:var(--text-light);margin-top:4px">${isEdit
        ? 'Currently-eligible drinks are pre-checked. Uncheck to restrict; check all (or none) to allow every drink.'
        : 'Defaults to the ministry list (Latte / Long Black / Decaf / Soda / Tea / Mineral Water). Adjust as needed.'}</p>
    </div>

    <div class="admin-form-group">
      <label>Collection Options <span style="color:var(--text-light);font-weight:400">(radio choices on the customer page)</span></label>
      <div id="pfCollectionList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px"></div>
      <button type="button" class="pos-btn pos-btn-sm" id="pfAddOpt">+ Add option</button>
    </div>

    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="pfSubmit">${isEdit ? 'Save Changes' : 'Create Link'}</button>
      <button class="pos-btn" id="pfCancel">Cancel</button>
    </div>`;

  showFormModal(form);
  wirePreorderForm(form, container, menuP, collectionOpts, templatesP, existingCode || null);
}

function wirePreorderForm(form, container, menuP, collectionOpts, templatesP, existingCode) {
  const isEdit = !!(existingCode && existingCode.code);
  // Templates seed the form defaults; applied at the bottom of this
  // function after all local helpers are defined so we can reuse them.
  // Fallback keyword list matches what the backend returns by default.
  form._eligibleKeywords = ['latte', 'long black', 'decaf', 'soda', 'tea', 'mineral water'];
  // In edit mode, the existing whitelist is the source of truth for which
  // drinks should be pre-checked (rather than keyword matching). An empty
  // list means "no restriction" — check them all.
  const existingEligible = isEdit && Array.isArray(existingCode.eligibleItems)
    ? existingCode.eligibleItems
    : null;


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
    form._drinks = drinks; // cached for applyDrinkDefaultChecks re-tick
    // In edit mode with an explicit whitelist, only those IDs are checked.
    // An empty existing list means "all" — check everything to reflect that.
    const editEligibleSet = existingEligible
      ? new Set(existingEligible.map(String))
      : null;
    const editAllowAll = isEdit && existingEligible && existingEligible.length === 0;
    listEl.innerHTML = drinks
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(m => {
        const id = m.menuItemId || m.id;
        let checked;
        if (isEdit) {
          checked = editAllowAll || (editEligibleSet && editEligibleSet.has(String(id)));
        } else {
          checked = matchesEligibilityKeywords(m.name, form._eligibleKeywords);
        }
        return `<label style="display:flex;gap:8px;align-items:center;padding:4px 0;font-weight:400">
          <input type="checkbox" data-drink-id="${escapeAttr(id)}"${checked ? ' checked' : ''}>
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
      const payload = {
        name, serviceDate, opensAt, expiresAt,
        bannerMessage,
        eligibleItems,
        collectionOptions,
      };
      const result = isEdit
        ? await api('PUT', `/api/admin/preorder-codes/${encodeURIComponent(existingCode.code)}`, payload)
        : await api('POST', '/api/admin/preorder-codes', payload);
      form._overlay.remove();
      showSuccess(isEdit ? `Updated: ${result.code || existingCode.code}` : `Link created: ${result.code}`);
      loadPreorderCodes(container);
    } catch(e){ showError(isEdit ? 'Failed to save changes' : 'Failed to create link'); }
  };

  // ─── Apply template defaults (fired after all helpers exist) ──────
  // Runs asynchronously; the form is already interactive by the time
  // this settles. Only overwrites empty textareas so a fast typist's
  // input isn't clobbered by a late-arriving template. In edit mode we
  // skip template application entirely — the existing code's values are
  // the source of truth.
  templatesP.then(templates => {
    if (!templates || isEdit) return;
    if (typeof templates.bannerMessage === 'string' && !form.querySelector('#pfBanner').value) {
      form.querySelector('#pfBanner').value = templates.bannerMessage;
    }
    if (Array.isArray(templates.collectionOptions) && templates.collectionOptions.length) {
      collectionOpts.length = 0;
      for (const o of templates.collectionOptions) collectionOpts.push(o);
      renderCollectionOpts();
    }
    if (Array.isArray(templates.eligibleItemKeywords)) {
      form._eligibleKeywords = templates.eligibleItemKeywords.map(k => String(k || '').toLowerCase());
      // If drinks landed before templates, re-tick to match new keywords.
      applyDrinkDefaultChecks(form);
    }
  });
}

/** Case-insensitive substring match — used by the pre-check logic on the
 *  eligible-drinks checkboxes AND by applyDrinkDefaultChecks below. */
function matchesEligibilityKeywords(name, keywords) {
  if (!Array.isArray(keywords) || !keywords.length) return false;
  const n = String(name || '').toLowerCase();
  return keywords.some(kw => kw && n.includes(String(kw).toLowerCase()));
}

/** Re-apply the "checked" state on already-rendered drink checkboxes.
 *  Called when the template keyword list arrives after the drinks have
 *  already rendered (async race). Only mutates checkboxes; leaves any
 *  manual clicks the admin made in the meantime alone by ONLY setting
 *  checked=true where the keyword matches — never unchecking. */
function applyDrinkDefaultChecks(form) {
  const drinks = form._drinks;
  if (!Array.isArray(drinks) || !drinks.length) return;
  const kws = form._eligibleKeywords || [];
  drinks.forEach(m => {
    const id = m.menuItemId || m.id;
    const cb = form.querySelector(`input[data-drink-id="${CSS.escape(String(id))}"]`);
    if (!cb) return;
    if (matchesEligibilityKeywords(m.name, kws)) cb.checked = true;
  });
}

