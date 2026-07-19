const trackApp = document.getElementById('trackApp');
const errorBanner = document.getElementById('errorBanner');
const orderId = new URLSearchParams(window.location.search).get('id') || localStorage.getItem('lastOrderId');
let pollTimer = null;
let prevStatus = null;
let queueSize = 0;
let isEditing = false;

// --- Push Notification Subscription ---
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function offerPushSubscription(orderId, customerName) {
  if (!('PushManager' in window) || !('serviceWorker' in navigator)) return;
  if (Notification.permission === 'denied') return;

  // Show soft prompt above the tracking view. trackApp gets its innerHTML
  // fully rewritten on each poll, so the banner is inserted as a sibling
  // (before trackApp) to survive re-renders.
  const banner = document.createElement('div');
  banner.className = 'push-prompt';
  banner.innerHTML = `<div class="push-prompt-inner">
    <span>🔔 Want to know when your drink is ready?</span>
    <div class="push-prompt-btns">
      <button id="pushYes" class="pos-btn pos-btn-primary pos-btn-sm">Yes, notify me</button>
      <button id="pushNo" class="pos-btn pos-btn-sm">No thanks</button>
    </div>
  </div>`;
  trackApp.parentNode.insertBefore(banner, trackApp);

  banner.querySelector('#pushNo').onclick = () => banner.remove();
  banner.querySelector('#pushYes').onclick = async () => {
    banner.remove();
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      const reg = await navigator.serviceWorker.ready;
      const vapidRes = await fetch(`${API_BASE}/api/push/vapid-public-key`);
      const { publicKey } = await vapidRes.json();

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      await fetch(`${API_BASE}/api/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, subscription: sub.toJSON(), customerName }),
      });
    } catch (e) {
      console.error('Push subscription failed:', e);
    }
  };
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.add('show');
  setTimeout(() => errorBanner.classList.remove('show'), 4000);
}

function showSuccess(msg) {
  errorBanner.textContent = msg;
  errorBanner.style.background = 'var(--success, #2D8A4E)';
  errorBanner.classList.add('show');
  setTimeout(() => { errorBanner.classList.remove('show'); errorBanner.style.background = ''; }, 4000);
}

const STATUS_MAP = {
  PENDING: { text: 'Waiting for payment confirmation', icon: '⏳', step: 1 },
  PREPARING: { text: 'Your order is being prepared', icon: '☕', step: 2 },
  READY: { text: 'Your order is ready!', icon: '🎉', step: 3 },
  ARCHIVED: { text: 'Order collected — thank you!', icon: '✅', step: 3 },
  CANCELLED: { text: 'Order was cancelled', icon: '❌', step: 0 },
  EXPIRED: { text: 'Order has expired', icon: '⏰', step: 0 }
};

function renderOrder(order) {
  const s = STATUS_MAP[order.status] || STATUS_MAP.PENDING;
  const items = order.items || [];
  const total = order.totalPrice || order.totalAmount || items.reduce((sum, i) => sum + (i.price || i.unitPrice || 0) * (i.quantity || 1), 0);

  let html = '';

  if (s.step > 0) {
    html += `<div class="track-stepper">
      <div class="track-step ${s.step >= 1 ? 'active' : ''}"><div class="step-dot">1</div><div class="step-label">Payment</div></div>
      <div class="track-step-line ${s.step >= 2 ? 'active' : ''}"></div>
      <div class="track-step ${s.step >= 2 ? 'active' : ''}"><div class="step-dot">2</div><div class="step-label">Preparing</div></div>
      <div class="track-step-line ${s.step >= 3 ? 'active' : ''}"></div>
      <div class="track-step ${s.step >= 3 ? 'active' : ''}"><div class="step-dot">3</div><div class="step-label">Ready!</div></div>
    </div>`;
  }

  if (order.customerName) {
    html += `<p style="margin-bottom:8px;font-size:1.1rem;font-weight:600;color:var(--primary,#6B4226)">Hi, ${order.customerName}!</p>`;
  }

  if (['PENDING', 'PREPARING'].includes(order.status) && queueSize > 0) {
    html += `<div style="text-align:center;font-size:.85rem;color:var(--text-light,#7A6355);margin-bottom:12px">Queue: ${queueSize} order${queueSize > 1 ? 's' : ''} ahead · Est. wait ~${Math.max(3, queueSize * 3)} min</div>`;
  }

  html += `<div class="status-indicator status-${order.status}"><h2>${s.icon} ${s.text}</h2>`;
  if (order.status === 'PENDING') html += `<p style="margin-top:8px">Total: <strong>RM ${total.toFixed(2)}</strong></p>`;
  if (order.status === 'PREPARING') html += `<p style="margin-top:8px">Sit tight, your order is being made!</p>`;
  if (order.status === 'READY') html += `<p style="margin-top:8px">Collect your order at the counter</p>`;
  if (order.status === 'CANCELLED' && order.reason) html += `<p>${order.reason}</p>`;
  html += `</div>`;

  // Payment section when PENDING
  if (order.status === 'PENDING') {
    const hasReceipt = !!order.receiptUrl;
    html += `<div class="payment-section">
      <h3>💳 Payment</h3>
      <div class="pay-at-counter" style="background:var(--cream,#f9f5f0);border:1px solid var(--cream-dark,#e8e0d8);border-radius:12px;padding:20px;text-align:center">
        <div style="font-size:1.6rem;margin-bottom:6px">🏪</div>
        <p style="font-weight:700;color:var(--primary,#6B4226);font-size:1.05rem;margin-bottom:4px">Pay at the counter</p>
        <p style="color:var(--text,#3D2B1F);font-size:1.15rem;font-weight:700;margin:8px 0">RM ${total.toFixed(2)}</p>
        <p style="font-size:.82rem;color:var(--text-light,#7A6355)">Please show this order to the cashier when paying.</p>
      </div>
      <!--
        QR / bank-transfer flow disabled until real DuitNow details are wired up.
        The image below is a placeholder and the account numbers are dummy values.
        Re-enable once real payment details are in place.

        <div class="qr-container">
          <img src="img/qr-payment.svg" alt="DuitNow QR" class="qr-image" onerror="this.style.display='none'">
          <p class="qr-amount">Pay <strong>RM ${total.toFixed(2)}</strong></p>
          <p class="qr-hint">Scan with any banking app (DuitNow, TnG, etc.)</p>
          <div style="margin-top:12px;padding:10px;background:var(--cream,#f9f5f0);border-radius:8px;font-size:.82rem;color:var(--text-light,#7A6355)">
            <strong>RLC Café</strong><br>
            <span style="display:inline-flex;align-items:center;gap:6px;margin-top:6px">DuitNow: <code>...</code></span>
          </div>
        </div>
      -->
      ${hasReceipt ? `<div class="receipt-uploaded">
        <span>✅ Receipt uploaded (RM ${order.receiptAmount?.toFixed(2) || '?'})</span>
        <p style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:4px">Waiting for cashier to verify</p>
      </div>` : `<div class="receipt-upload-area">
        <p style="margin-bottom:14px;font-weight:600;color:var(--text,#3D2B1F)">Paid online instead? Upload your receipt:</p>
        <label class="upload-btn" for="receiptInput" style="display:block;text-align:center;width:100%;padding:16px;font-size:1.05rem">📷 Upload Payment Screenshot</label>
        <p style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:8px;text-align:center">Instant AI verification — cashier gets notified automatically</p>
        <input type="file" id="receiptInput" accept="image/*" style="display:none">
        <button id="btnShowCounter" style="display:block;margin:20px auto 0;background:none;border:none;color:var(--text-light,#7A6355);font-size:.85rem;cursor:pointer;text-decoration:underline;padding:8px">Or show payment to cashier at counter →</button>
        <div id="uploadStatus"></div>
      </div>`}
    </div>`;
  }

  // Inline bible verse — fetched and rendered below payment section
  if (order.status === 'PENDING') {
    html += `<div id="verseInlineSlot"></div>`;
  }

  if (order.flaggedItems && order.flaggedItems.length) {
    html += `<div class="flagged-warning" role="alert"><strong>⚠️ Some items became unavailable:</strong><ul>`;
    order.flaggedItems.forEach(f => { html += `<li>${f}</li>`; });
    html += `</ul><a href="index">Update your order</a></div>`;
  }

  html += `<div class="order-details"><h3>Order Details</h3>`;
  if (order.notes) html += `<div style="background:var(--cream,#f9f5f0);padding:10px 12px;border-radius:8px;font-size:.85rem;margin-bottom:10px">📝 ${order.notes}</div>`;
  html += `<ul id="orderItemsList">`;
  items.forEach((i, idx) => {
    const label = i.variant ? `${i.name} (${i.variant})` : i.name;
    html += `<li><span>${label} × ${i.quantity || 1}</span><span>RM ${((i.price || i.unitPrice || 0) * (i.quantity || 1)).toFixed(2)}</span></li>`;
  });
  html += `</ul><div class="order-total">Total: RM ${total.toFixed(2)}</div></div>`;

  if (order.status === 'PENDING') {
    html += `<div class="order-actions-row">
      <button class="edit-btn" id="editBtn">✏️ Edit Order</button>
      <button class="cancel-btn" id="cancelBtn">Cancel Order</button>
    </div>`;
  }

  if (['READY', 'ARCHIVED', 'CANCELLED', 'EXPIRED'].includes(order.status)) {
    html += `<a href="index" style="display:inline-block;margin-top:20px;color:var(--primary,#6B4226);font-weight:600;text-decoration:underline">← Back to Menu</a>`;
  }

  html += `<a href="track" style="display:block;margin-top:12px;color:var(--text-light,#7A6355);font-size:.9rem;text-decoration:underline">My Orders</a>`;

  // Slot for the past-orders section — populated async by renderPastOrders
  // after this innerHTML swap so the current order paints immediately.
  html += `<div id="pastOrders"></div>`;

  trackApp.innerHTML = html;

  // Kick off the past-orders fetch (silent no-op when there's no profile).
  renderPastOrders(document.getElementById('pastOrders'), order.orderId);

  // Fetch and render inline bible verse when PENDING
  if (order.status === 'PENDING') {
    const verseSlot = document.getElementById('verseInlineSlot');
    if (verseSlot) {
      fetch(`${API_BASE}/api/verses/random`)
        .then(r => r.json())
        .then(data => {
          if (data.verse) {
            verseSlot.innerHTML = `<div class="verse-inline">
              <p class="verse-inline-text">"${data.verse.text}"</p>
              <p class="verse-inline-ref">— ${data.verse.reference}</p>
            </div>`;
          }
        })
        .catch(() => {});
    }
  }

  // Bind receipt upload
  document.getElementById('receiptInput')?.addEventListener('change', handleReceiptUpload);

  // Bind show to cashier
  document.getElementById('btnShowCounter')?.addEventListener('click', () => {
    const statusEl = document.getElementById('uploadStatus');
    if (statusEl) statusEl.innerHTML = '<div style="margin-top:14px;padding:16px;background:var(--cream,#f9f5f0);border-radius:10px;text-align:center"><p style="font-size:1.3rem;margin-bottom:8px">🙋</p><p style="font-weight:700;font-size:1.05rem;color:var(--primary,#6B4226)">Show your payment screen to the cashier now</p><p style="font-size:.85rem;color:var(--text-light,#7A6355);margin-top:6px">The cashier will tap "Payment Confirmed" on their end.<br>This page will update automatically.</p></div>';
    clearInterval(pollTimer);
    setTimeout(() => { pollTimer = setInterval(pollOrder, 7000); pollOrder(); }, 8000);
  });

  // Bind cancel
  document.getElementById('cancelBtn')?.addEventListener('click', async () => {
    const prompt = order.receiptUrl
      ? "You've already uploaded a payment receipt. Cancellation may require a refund from the cashier. Continue?"
      : 'Cancel this order?';
    if (!confirm(prompt)) return;
    try {
      const res = await fetch(`${API_BASE}/api/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' })
      });
      if (res.status === 409) {
        showError('This order can no longer be modified.');
      }
      pollOrder();
    } catch { showError('Failed to cancel, try again'); }
  });

  // Bind edit
  document.getElementById('editBtn')?.addEventListener('click', () => {
    enterEditMode(order);
  });

  if (['READY', 'ARCHIVED', 'CANCELLED', 'EXPIRED'].includes(order.status)) {
    clearInterval(pollTimer);
  }
}

function enterEditMode(order) {
  // Keep polling running but read-only — pollOrder() guards on isEditing
  // and only redraws (or bails out) when status drifts away from PENDING.
  isEditing = true;
  const items = [...(order.items || [])];
  let notes = order.notes || '';
  let menuCache = null;
  const listEl = document.getElementById('orderItemsList');
  const actionsRow = document.querySelector('.order-actions-row');

  // Inject "+ Add item" button + notes textarea between the items list and
  // the action buttons. Defensive cleanup in case a previous edit session
  // left a stray block behind.
  document.querySelectorAll('.edit-extras').forEach(el => el.remove());
  actionsRow.insertAdjacentHTML('beforebegin', `
    <div class="edit-extras" style="margin-top:14px">
      <button id="addItemBtn" type="button" style="width:100%;padding:12px;background:#fff;border:1px dashed var(--primary,#6B4226);color:var(--primary,#6B4226);border-radius:10px;font-size:.95rem;font-weight:600;cursor:pointer">+ Add item</button>
      <div style="margin-top:14px">
        <label for="editNotes" style="display:block;font-size:.85rem;color:var(--text-light,#7A6355);margin-bottom:4px">Notes (optional)</label>
        <textarea id="editNotes" maxlength="200" rows="2" placeholder="Special requests…" style="width:100%;padding:10px;border:1px solid var(--cream-dark,#ddd);border-radius:8px;font-size:.9rem;resize:none;font-family:inherit;box-sizing:border-box"></textarea>
        <div style="display:flex;justify-content:flex-end;font-size:.75rem;color:var(--text-light,#7A6355);margin-top:2px"><span id="editNotesCount">0</span>/200</div>
      </div>
    </div>
  `);

  // Set notes value via .value (not HTML) so user input is safe from injection.
  const notesEl = document.getElementById('editNotes');
  const notesCountEl = document.getElementById('editNotesCount');
  notesEl.value = notes;
  notesCountEl.textContent = notes.length;
  notesEl.addEventListener('input', () => {
    notes = notesEl.value;
    notesCountEl.textContent = notes.length;
  });

  document.getElementById('addItemBtn').addEventListener('click', openAddItemPicker);

  // Pre-load the menu so variant pickers can appear inline on items that
  // have variantGroups. The first re-render runs as soon as the menu lands.
  ensureMenuLoaded().then(() => renderEditItems());

  async function ensureMenuLoaded() {
    if (menuCache) return menuCache;
    try {
      const r = await fetch(`${API_BASE}/api/menu`);
      const data = await r.json();
      menuCache = (data.items || data || []).filter(m => m.isActive && m.isEnabledToday);
    } catch {
      menuCache = [];
    }
    return menuCache;
  }

  function lookupMenuItem(menuItemId) {
    return (menuCache || []).find(m => (m.menuItemId || m.id) === menuItemId);
  }

  function recomputeTotalRow() {
    const total = items.reduce((s, i) => s + (i.unitPrice || i.price || 0) * (i.quantity || 1), 0);
    const totalLi = listEl.querySelector('.edit-total');
    if (totalLi) totalLi.innerHTML = `<strong>New Total: RM ${total.toFixed(2)}</strong>`;
  }

  function renderEditItems() {
    const total = items.reduce((s, i) => s + (i.unitPrice || i.price || 0) * (i.quantity || 1), 0);
    listEl.innerHTML = items.map((i, idx) => {
      const label = i.variant ? `${i.name} (${i.variant})` : i.name;
      const menuItem = lookupMenuItem(i.menuItemId);
      const hasVariants = !!(menuItem && menuItem.variantGroups && menuItem.variantGroups.length);
      const toggleBtn = hasVariants
        ? `<button class="edit-variant-toggle" data-idx="${idx}" title="Edit variants" style="background:none;border:none;color:var(--primary,#6B4226);font-size:1rem;cursor:pointer;padding:4px 8px">▾</button>`
        : '';
      const pickerDiv = hasVariants
        ? `<div class="edit-variant-picker" data-idx="${idx}" style="display:none;margin-top:8px;padding:10px 12px;background:var(--cream,#f9f5f0);border-radius:8px"></div>`
        : '';
      return `<li class="edit-item-row" data-idx="${idx}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span class="edit-item-name">${label}</span>
          <div class="edit-item-controls">
            <button class="edit-qty-btn" data-idx="${idx}" data-action="dec">−</button>
            <span class="edit-qty">${i.quantity || 1}</span>
            <button class="edit-qty-btn" data-idx="${idx}" data-action="inc">+</button>
            <button class="edit-remove-btn" data-idx="${idx}">✕</button>
            ${toggleBtn}
          </div>
        </div>
        ${pickerDiv}
      </li>`;
    }).join('');
    listEl.innerHTML += `<li class="edit-total"><strong>New Total: RM ${total.toFixed(2)}</strong></li>`;

    listEl.querySelectorAll('.edit-qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        if (btn.dataset.action === 'inc') items[idx].quantity = (items[idx].quantity || 1) + 1;
        else {
          items[idx].quantity = (items[idx].quantity || 1) - 1;
          if (items[idx].quantity <= 0) items.splice(idx, 1);
        }
        renderEditItems();
      });
    });

    listEl.querySelectorAll('.edit-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        items.splice(parseInt(btn.dataset.idx), 1);
        renderEditItems();
      });
    });

    // Tap-to-expand variant picker per row.
    listEl.querySelectorAll('.edit-variant-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const row = btn.closest('.edit-item-row');
        const pickerEl = row.querySelector('.edit-variant-picker');
        if (!pickerEl) return;

        const isHidden = pickerEl.style.display === 'none' || !pickerEl.style.display;
        if (!isHidden) {
          pickerEl.style.display = 'none';
          btn.textContent = '▾';
          return;
        }

        const menuItem = lookupMenuItem(items[idx].menuItemId);
        if (!menuItem) {
          pickerEl.innerHTML = '<p style="color:var(--text-light,#7A6355);font-size:.85rem;margin:0">Variants unavailable</p>';
        } else {
          // Initial preselection comes from the working item's selectedVariants
          // if it was edited earlier in this session; otherwise the picker
          // defaults to the first option of each single-select group.
          const seed = { ...menuItem, selectedVariants: items[idx].selectedVariants || null };
          RLCVariants.renderVariantPicker(seed, pickerEl, (selected) => {
            items[idx].selectedVariants = selected;
            const variantSum = selected.reduce((s, v) => s + (v.price || 0), 0);
            items[idx].unitPrice = (menuItem.basePrice || 0) + variantSum;
            items[idx].variant = selected.map(v => v.option).join(', ') || null;
            // Update the displayed name + total in place — full re-render
            // would collapse the picker the user just opened.
            const nameEl = row.querySelector('.edit-item-name');
            if (nameEl) {
              nameEl.textContent = items[idx].variant
                ? `${items[idx].name} (${items[idx].variant})`
                : items[idx].name;
            }
            recomputeTotalRow();
          });
        }
        pickerEl.style.display = '';
        btn.textContent = '▴';
      });
    });
  }

  async function openAddItemPicker() {
    await ensureMenuLoaded();
    if (!menuCache.length) {
      showError('Menu unavailable');
      return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(61,43,31,.6);backdrop-filter:blur(4px);z-index:400;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML = `<div style="background:#fff;border-radius:16px;width:100%;max-width:440px;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 8px 24px rgba(74,44,23,.15)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--cream-dark,#ddd)">
        <h3 style="margin:0;color:var(--primary,#6B4226)">Add an item</h3>
        <button id="closePickerBtn" type="button" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-light,#7A6355);padding:4px 8px">✕</button>
      </div>
      <ul id="pickerItemsList" style="margin:0;padding:0;list-style:none;overflow-y:auto;flex:1"></ul>
    </div>`;
    document.body.appendChild(overlay);

    const pickerListEl = overlay.querySelector('#pickerItemsList');
    if (!menuCache.length) {
      pickerListEl.innerHTML = '<li style="padding:20px;text-align:center;color:var(--text-light,#7A6355)">No items available</li>';
    } else {
      pickerListEl.innerHTML = menuCache.map((m, idx) => `
        <li data-pick-idx="${idx}" style="padding:14px 20px;border-bottom:1px solid var(--cream-dark,#eee);cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px">
          <div style="flex:1;min-width:0"><div style="font-weight:600;color:var(--text,#3D2B1F)">${m.name}</div>${m.category ? `<div style="font-size:.75rem;color:var(--text-light,#7A6355);margin-top:2px">${m.category === 'DRINK' ? '🥤 Drink' : '🍔 Food'}</div>` : ''}</div>
          <span style="color:var(--primary,#6B4226);font-weight:700;white-space:nowrap">RM ${(m.basePrice || 0).toFixed(2)}</span>
        </li>
      `).join('');

      pickerListEl.querySelectorAll('li').forEach(li => {
        li.addEventListener('click', () => {
          const m = menuCache[parseInt(li.dataset.pickIdx)];
          // Add to working list with default variants (none). Backend
          // will revalidate and assign canonical variant labels on Save.
          items.push({
            menuItemId: m.menuItemId || m.id,
            name: m.name,
            variant: null,
            quantity: 1,
            unitPrice: m.basePrice || 0,
            category: m.category,
            selectedVariants: null,
          });
          overlay.remove();
          renderEditItems();
        });
      });
    }

    overlay.querySelector('#closePickerBtn').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  renderEditItems();

  actionsRow.innerHTML = `
    <button class="edit-btn" id="saveEditBtn" style="background:var(--primary,#6B4226);color:#fff;border-color:var(--primary,#6B4226)">💾 Save Changes</button>
    <button class="cancel-btn" id="cancelEditBtn" style="border-color:var(--text-light,#7A6355);color:var(--text-light,#7A6355)">Cancel Edit</button>
  `;

  document.getElementById('saveEditBtn').addEventListener('click', async () => {
    if (!items.length) { showError('Order must have at least one item'); return; }
    const btn = document.getElementById('saveEditBtn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const res = await fetch(`${API_BASE}/api/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          items: items.map(i => ({
            menuItemId: i.menuItemId,
            variant: i.variant,
            quantity: i.quantity || 1,
            selectedVariants: i.selectedVariants || null,
          })),
          notes,
        })
      });
      if (res.status === 409) {
        isEditing = false;
        showError('This order can no longer be modified.');
        pollOrder();
        return;
      }
      if (!res.ok) {
        const err = await res.json();
        showError(err.error || 'Failed to update order');
        btn.disabled = false;
        btn.textContent = '💾 Save Changes';
        return;
      }
      isEditing = false;
      showSuccess('Order updated!');
      pollOrder();
    } catch { showError('Connection error'); btn.disabled = false; btn.textContent = '💾 Save Changes'; }
  });

  document.getElementById('cancelEditBtn').addEventListener('click', () => {
    isEditing = false;
    pollOrder();
  });
}

async function handleReceiptUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const statusEl = document.getElementById('uploadStatus');
  if (statusEl) statusEl.innerHTML = '<p class="upload-progress">Uploading & verifying...</p>';

  try {
    const base64 = await fileToBase64(file);
    const res = await fetch(`${API_BASE}/api/orders/${orderId}/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64 }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (statusEl) {
        statusEl.innerHTML = `<p class="upload-error">❌ ${data.error || 'Upload failed'}</p>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="upload-btn" id="retryUpload">📷 Try Again</button>
            <button class="upload-btn" id="showCashierFallback">🙋 Show to Cashier Instead</button>
          </div>
          <p style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:8px">Paid a different amount? Just show your payment screen to the cashier.</p>`;
        statusEl.querySelector('#retryUpload').onclick = () => {
          pollTimer = setInterval(pollOrder, 7000);
          pollOrder();
        };
        statusEl.querySelector('#showCashierFallback').onclick = () => {
          statusEl.innerHTML = '<div style="margin-top:14px;padding:16px;background:var(--cream,#f9f5f0);border-radius:10px;text-align:center"><p style="font-size:1.3rem;margin-bottom:8px">🙋</p><p style="font-weight:700;font-size:1.05rem;color:var(--primary,#6B4226)">Show your payment screen to the cashier now</p><p style="font-size:.85rem;color:var(--text-light,#7A6355);margin-top:6px">The cashier will tap "Payment Confirmed" on their end.<br>This page will update automatically.</p></div>';
          setTimeout(() => { pollTimer = setInterval(pollOrder, 7000); pollOrder(); }, 8000);
        };
      }
      clearInterval(pollTimer);
      return;
    }

    showSuccess('Receipt verified! Cashier will confirm shortly.');
    pollOrder();
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<p class="upload-error">❌ Connection error. Please try again.</p>';
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function pollOrder() {
  try {
    const [res, statusRes] = await Promise.all([
      fetch(`${API_BASE}/api/orders/${orderId}`),
      fetch(`${API_BASE}/api/cafe/status`)
    ]);
    if (!res.ok) throw new Error();
    const order = await res.json();
    if (statusRes.ok) { const s = await statusRes.json(); queueSize = s.queueSize || 0; }
    if (prevStatus && order.status !== prevStatus) {
      const msgs = { PREPARING: '☕ Your order is being prepared!', READY: '🎉 Your order is ready for pickup!' };
      if (order.status === 'READY') {
        setTimeout(() => document.querySelector('.status-indicator')?.classList.add('pulse'), 50);
      }
    }
    prevStatus = order.status;
    renderOrder(order);
  } catch {
    showError('Connection error, retrying...');
  }
}

// ─── Past Orders (server-authoritative, requires a customer profile) ───

/**
 * Renders "📋 My Past Orders" into `hostEl`. No-op when the browser has
 * no customerProfile with a phone (returning-customer flow), so the
 * section only appears once a profile has been saved.
 *
 * `excludeOrderId` prevents duplicating the currently-tracked order in the
 * list (that order is already shown by renderOrder above the section).
 */
async function renderPastOrders(hostEl, excludeOrderId) {
  if (!hostEl) return;
  let profile;
  try { profile = JSON.parse(localStorage.getItem('customerProfile') || 'null'); } catch { profile = null; }
  if (!profile || !profile.phone) {
    hostEl.innerHTML = '';
    return;
  }
  hostEl.innerHTML = '<div class="loading" style="padding:14px;color:var(--text-light,#7A6355)">Loading past orders…</div>';
  let orders = [];
  try {
    const res = await fetch(`${API_BASE}/api/customers/${encodeURIComponent(profile.phone)}/orders`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    orders = Array.isArray(data.orders) ? data.orders : [];
  } catch (_e) {
    hostEl.innerHTML = '<div style="margin-top:24px;padding:12px;color:var(--text-light,#7A6355);font-size:.9rem">Could not load past orders.</div>';
    return;
  }
  if (excludeOrderId) orders = orders.filter(o => o.orderId !== excludeOrderId);

  if (!orders.length) {
    hostEl.innerHTML = `
      <h3 style="margin:24px 0 12px;color:var(--primary,#6B4226)">📋 My Past Orders</h3>
      <div style="padding:14px;color:var(--text-light,#7A6355);font-size:.9rem;border:1px solid var(--cream-dark,#E7DFD5);border-radius:10px">No past orders yet.</div>`;
    return;
  }

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const stripEmoji = s => String(s || '').replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u, '').trim();

  const rows = orders.map(o => {
    const d = new Date(o.createdAt);
    const dateStr = isNaN(d.getTime())
      ? '—'
      : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const items = (o.items || []).map(i => {
      const qty = i.quantity || i.qty || 1;
      const name = stripEmoji(i.name || '?');
      const v = i.variant ? ` (${i.variant})` : '';
      return `${qty}× ${name}${v}`;
    }).join(', ') || '—';
    const status = String(o.status || '').toUpperCase();
    // Buckets: happy path = green ✅; cancelled/expired = red with strike; others = neutral.
    const cancelled = status === 'CANCELLED' || status === 'EXPIRED';
    const completed = status === 'ARCHIVED' || status === 'READY';
    const badge = cancelled
      ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#FEE2E2;color:#7F1D1D;font-size:.72rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase">${status}</span>`
      : completed
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#D1FAE5;color:#065F46;font-size:.72rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase">Completed</span>`
        : `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#F3F4F6;color:#374151;font-size:.72rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase">${status || '—'}</span>`;
    const amountStyle = cancelled
      ? 'color:var(--text-light,#7A6355);text-decoration:line-through'
      : 'color:var(--primary,#6B4226);font-weight:700';
    return `<a href="track?id=${encodeURIComponent(o.orderId)}" style="display:block;text-decoration:none;color:inherit;margin-bottom:10px;padding:12px 14px;border:1px solid var(--cream-dark,#E7DFD5);border-radius:10px;background:#fff">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <span style="font-weight:600">${esc(dateStr)}</span>
        <span style="${amountStyle}">RM ${Number(o.totalAmount || 0).toFixed(2)}</span>
      </div>
      <div style="font-size:.88rem;color:var(--text,#3D2B1F);margin-top:4px">${esc(items)}</div>
      <div style="margin-top:6px">${badge}</div>
    </a>`;
  }).join('');

  hostEl.innerHTML = `
    <h3 style="margin:24px 0 12px;color:var(--primary,#6B4226)">📋 My Past Orders</h3>
    ${rows}`;
}

function renderOrderHistory() {
  let history = JSON.parse(localStorage.getItem('orderHistory') || '[]');
  const lastId = localStorage.getItem('lastOrderId');

  // Seed history from lastOrderId if missing
  if (lastId && !history.find(o => o.orderId === lastId)) {
    history.unshift({ orderId: lastId, date: new Date().toISOString(), total: 0 });
    localStorage.setItem('orderHistory', JSON.stringify(history));
  }

  let html = '<h2 style="margin-bottom:16px">My Orders</h2>';

  // Show active order prominently if exists
  if (lastId) {
    html += `<a href="track?id=${lastId}" style="display:block;text-decoration:none;color:inherit;margin-bottom:16px;padding:16px;border:2px solid var(--primary,#6B4226);border-radius:10px;background:var(--cream,#f9f5f0)">
      <div style="font-weight:700;color:var(--primary,#6B4226)">📍 Current Order</div>
      <div style="font-size:.85rem;color:var(--text-light,#999);margin-top:4px">${lastId.slice(0,8)}… — tap to view status</div>
    </a>`;
  }

  // Server-side history (requires customer profile) goes into #pastOrders.
  // The localStorage `orderHistory` list is kept as a fallback for guests
  // who never registered a phone profile.
  let hasProfile = false;
  try { hasProfile = !!(JSON.parse(localStorage.getItem('customerProfile') || 'null')?.phone); } catch { hasProfile = false; }

  if (hasProfile) {
    html += '<div id="pastOrders"></div>';
  } else if (history.length) {
    html += '<h3 style="margin:16px 0 10px;font-size:.9rem;color:var(--text-light,#7A6355)">Order History</h3>';
    history.forEach(o => {
      const date = new Date(o.date).toLocaleDateString(undefined, { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
      html += `<a href="track?id=${o.orderId}" style="display:block;text-decoration:none;color:inherit;margin-bottom:10px;padding:14px 16px;border:1px solid var(--cream-dark,#ddd);border-radius:10px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600">${date}</span>
          <span style="color:var(--primary,#6B4226);font-weight:700">RM ${(o.total||0).toFixed(2)}</span>
        </div>
        <div style="font-size:.8rem;color:var(--text-light,#999);margin-top:4px">${o.orderId.slice(0,8)}…</div>
      </a>`;
    });
  } else if (!lastId) {
    html += '<p style="color:var(--text-light)">No orders yet</p>';
  }

  html += '<p style="margin-top:24px"><a href="index" style="color:var(--primary,#6B4226);font-weight:600">← Back to menu</a></p>';
  trackApp.innerHTML = html;

  // Populate the server-side history if the customer has a profile.
  if (hasProfile) {
    renderPastOrders(document.getElementById('pastOrders'), lastId || null);
  }
}

if (!orderId) {
  renderOrderHistory();
} else {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  pollOrder();
  pollTimer = setInterval(pollOrder, 7000);
}

// Offer a push subscription if the customer just placed an order and was
// redirected here from the ordering flow. app.js drops the orderId into
// sessionStorage right before navigating; we consume it once so refreshes
// don't re-prompt.
const pushOrderId = sessionStorage.getItem('push_offer_order');
if (pushOrderId) {
  sessionStorage.removeItem('push_offer_order');
  const name = localStorage.getItem('customerName') || '';
  offerPushSubscription(pushOrderId, name);
}
