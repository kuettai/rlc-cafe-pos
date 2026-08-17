// admin-stafflink.js — the single staff-price link (?code=<CODE>)
// Depends on: admin.js (api, showError, showSuccess, $)
//
// One record, always edited in place — there is exactly one staff code, so
// there is no list, no "+ Add" and no delete. If the backend has none yet the
// form renders with sensible defaults and the first Save creates it.
//
// A staff link lets someone REQUEST the staff price (drinks at RM5, food at
// full price). It does not grant it: the order still lands PENDING and the
// cashier confirms at approve. The price itself is decided by
// backend/src/lib/pricing.ts — nothing here computes money.

// Ambiguity-free alphabet: no 0/O, no 1/I/L, so a code written on a whiteboard
// cannot be mistyped into a different one. Matches the backend's alphabet.
const STAFF_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const STAFF_CODE_MIN = 3;
const STAFF_CODE_MAX = 16;
const STAFF_LINK_BASE = 'https://153.oasisofcare.org/';

function sanitizeStaffCode(value) {
  return String(value || '')
    .toUpperCase()
    .split('')
    .filter(ch => STAFF_CODE_ALPHABET.indexOf(ch) !== -1)
    .join('')
    .slice(0, STAFF_CODE_MAX);
}

/** Local YYYY-MM-DD. Local, not UTC: the café runs in MYT (UTC+8), where a
 *  UTC date would report "yesterday" all morning. */
function staffTodayIso() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Status pill, mirroring the backend's validate rules: disabled beats dates,
 * and both date bounds are inclusive.
 */
function staffLinkStatus(rec, todayIso) {
  if (!rec || !rec.code) return { label: 'Not set up', cls: 'badge-inactive' };
  if (rec.isActive === false) return { label: 'Disabled', cls: 'badge-inactive' };
  if (rec.startDate && todayIso < rec.startDate) return { label: 'Not yet', cls: 'badge-cashier' };
  if (rec.endDate && todayIso > rec.endDate) return { label: 'Expired', cls: 'badge-inactive' };
  return { label: 'Active', cls: 'badge-active' };
}

function staffLinkFor(code) {
  return `${STAFF_LINK_BASE}?code=${encodeURIComponent(code || '')}`;
}

async function loadStaffLink(container) {
  container.innerHTML = '<div class="loading">Loading staff link...</div>';
  try {
    const data = await api('GET', '/api/admin/staff-code');
    // Tolerate a shape we don't expect rather than throwing — an old shell may
    // be talking to a newer API.
    renderStaffLink(container, (data && data.staffCode) || null);
  } catch (e) {
    container.innerHTML = `<div class="admin-section">
      <div class="admin-section-header"><h2>🎫 Staff Link</h2></div>
      <div class="admin-empty"><p>Failed to load the staff code.</p>
        <button class="pos-btn pos-btn-sm" id="slRetry">Retry</button></div>
    </div>`;
    const retry = container.querySelector('#slRetry');
    if (retry) retry.onclick = () => loadStaffLink(container);
  }
}

function renderStaffLink(container, rec) {
  const isNew = !(rec && rec.code);
  // Defaults for the very first save: a code the admin will almost certainly
  // keep, enabled, no date limits.
  const code = sanitizeStaffCode(isNew ? 'STAFF' : rec.code);
  const label = isNew ? '' : String(rec.label || '');
  const isActive = isNew ? true : rec.isActive !== false;
  const startDate = isNew ? '' : String(rec.startDate || '');
  const endDate = isNew ? '' : String(rec.endDate || '');
  const st = staffLinkStatus({ code, isActive, startDate, endDate }, staffTodayIso());

  container.innerHTML = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>🎫 Staff Link</h2>
      <span class="admin-card-badge ${st.cls}" id="slStatus">${st.label}</span>
    </div>
    <p class="admin-form-hint">
      One code for all staff. Drinks are charged at the staff price; food is charged
      in full. Editing replaces the current code — the old link stops working.
      ${isNew ? '<strong>No code exists yet — Save to create one.</strong>' : ''}
    </p>

    <div class="admin-form-row">
      <div class="admin-form-group">
        <label for="slCode">Short code</label>
        <input id="slCode" class="pos-input" maxlength="${STAFF_CODE_MAX}"
               autocapitalize="characters" autocomplete="off" spellcheck="false"
               style="font-family:monospace;letter-spacing:.08em"
               value="${escapeAttr(code)}">
        <p class="admin-form-hint">${STAFF_CODE_MIN}–${STAFF_CODE_MAX} characters, saved in UPPERCASE.
          <strong>0, O, 1, I and L are not allowed</strong> — they are too easy to mis-read
          when the code is written down or read out.</p>
      </div>
      <div class="admin-form-group">
        <label for="slLabel">Label <span style="font-weight:400">(optional)</span></label>
        <input id="slLabel" class="pos-input" maxlength="60" placeholder="e.g. RLC Staff"
               value="${escapeAttr(label)}">
        <p class="admin-form-hint">Shown on the customer's banner, so staff know the link worked.</p>
      </div>
    </div>

    <div class="admin-form-row">
      <div class="admin-form-group">
        <label for="slStart">Start date <span style="font-weight:400">(optional)</span></label>
        <input id="slStart" type="date" class="pos-input" value="${escapeAttr(startDate)}">
      </div>
      <div class="admin-form-group">
        <label for="slEnd">End date <span style="font-weight:400">(optional)</span></label>
        <input id="slEnd" type="date" class="pos-input" value="${escapeAttr(endDate)}">
      </div>
    </div>
    <p class="admin-form-hint">Both dates are inclusive — the link works on the start
      date and on the end date. Leave either blank for no limit.</p>

    <div style="display:flex;align-items:center;gap:12px;margin:16px 0">
      <label class="toggle-switch" title="Enable or disable the staff link">
        <input type="checkbox" id="slActive"${isActive ? ' checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
      <label for="slActive" style="font-size:.9rem;font-weight:600;color:var(--text)">Enabled</label>
    </div>

    <div class="admin-form-group" style="margin-bottom:8px">
      <label>Link to share</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span id="slPreview" style="font-family:monospace;font-size:.8rem;color:var(--text-light);word-break:break-all;flex:1;min-width:200px">${escapeHtml(staffLinkFor(code))}</span>
        <button class="pos-btn pos-btn-sm" id="slCopy">📋 Copy</button>
      </div>
      <p class="admin-form-hint" id="slPreviewNote"></p>
    </div>

    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="slSave">Save</button>
    </div>

    <p class="admin-form-hint" style="margin-top:14px">
      ⚠️ Anyone who has this link can <strong>request</strong> the staff price — the link
      is not a password. The cashier is asked to confirm before the price sticks, and
      whoever approved is recorded on the order. Change the code if the link spreads
      beyond staff.
    </p>
  </div>`;

  const codeInput = container.querySelector('#slCode');
  const labelInput = container.querySelector('#slLabel');
  const startInput = container.querySelector('#slStart');
  const endInput = container.querySelector('#slEnd');
  const activeInput = container.querySelector('#slActive');
  const previewEl = container.querySelector('#slPreview');
  const noteEl = container.querySelector('#slPreviewNote');
  const statusEl = container.querySelector('#slStatus');
  const saveBtn = container.querySelector('#slSave');

  const currentCode = () => sanitizeStaffCode(codeInput.value);

  function refresh() {
    const c = currentCode();
    previewEl.textContent = staffLinkFor(c);
    noteEl.textContent = c.length < STAFF_CODE_MIN
      ? `Needs at least ${STAFF_CODE_MIN} characters before it can be saved.`
      : '';
    const s = staffLinkStatus({
      code: c,
      isActive: activeInput.checked,
      startDate: startInput.value,
      endDate: endInput.value,
    }, staffTodayIso());
    statusEl.textContent = s.label;
    statusEl.className = `admin-card-badge ${s.cls}`;
  }

  codeInput.oninput = () => {
    // Force-uppercase and drop disallowed characters as they are typed, keeping
    // the caret roughly where the admin left it.
    const raw = codeInput.value;
    const clean = sanitizeStaffCode(raw);
    if (clean !== raw) {
      const caret = Math.max(0, (codeInput.selectionStart || 0) - (raw.length - clean.length));
      codeInput.value = clean;
      try { codeInput.setSelectionRange(caret, caret); } catch (e) { /* unsupported input type */ }
    }
    refresh();
  };
  activeInput.onchange = refresh;
  startInput.onchange = refresh;
  endInput.onchange = refresh;
  refresh();

  container.querySelector('#slCopy').onclick = async () => {
    const btn = container.querySelector('#slCopy');
    const link = staffLinkFor(currentCode());
    try {
      await navigator.clipboard.writeText(link);
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
    } catch (e) {
      // Fallback: select-and-alert if the clipboard API is blocked
      window.prompt('Copy this link:', link);
    }
  };

  saveBtn.onclick = async () => {
    const c = currentCode();
    if (c.length < STAFF_CODE_MIN) {
      showError(`Staff code must be at least ${STAFF_CODE_MIN} characters (letters and digits, no 0/O/1/I/L)`);
      codeInput.focus();
      return;
    }
    const start = startInput.value;
    const end = endInput.value;
    if (start && end && end < start) {
      showError('End date cannot be before the start date');
      endInput.focus();
      return;
    }

    const payload = {
      code: c,
      label: labelInput.value.trim(),
      isActive: activeInput.checked,
      startDate: start,
      endDate: end,
    };
    saveBtn.disabled = true;
    const prev = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    try {
      const res = await api('PUT', '/api/admin/staff-code', payload);
      // Re-render from the server's record; fall back to what we sent if the
      // response shape is not what this build expects.
      renderStaffLink(container, (res && res.staffCode) || payload);
      showSuccess(`Staff link saved: ${c}`);
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = prev;
      showError('Failed to save the staff link');
    }
  };
}
