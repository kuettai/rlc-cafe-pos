const trackApp = document.getElementById('trackApp');
const errorBanner = document.getElementById('errorBanner');
const orderId = new URLSearchParams(window.location.search).get('id') || localStorage.getItem('lastOrderId');
let pollTimer = null;
let prevStatus = null;
let queueSize = 0;

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
      <div class="qr-container">
        <img src="img/qr-payment.svg" alt="DuitNow QR" class="qr-image" onerror="this.style.display='none'">
        <p class="qr-amount">Pay <strong>RM ${total.toFixed(2)}</strong></p>
        <p class="qr-hint">Scan with any banking app (DuitNow, TnG, etc.)</p>
        <div style="margin-top:12px;padding:10px;background:var(--cream,#f9f5f0);border-radius:8px;font-size:.82rem;color:var(--text-light,#7A6355)">
          <strong>RLC Café</strong> · DuitNow: 0123456789<br>Bank: Maybank · Acc: 1234-5678-9012
        </div>
      </div>
      ${hasReceipt ? `<div class="receipt-uploaded">
        <span>✅ Receipt uploaded (RM ${order.receiptAmount?.toFixed(2) || '?'})</span>
        <p style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:4px">Waiting for cashier to verify</p>
      </div>` : `<div class="receipt-upload-area">
        <p style="margin-bottom:12px">After paying, choose one option:</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="upload-btn" for="receiptInput">📷 Upload Receipt</label>
          <button class="upload-btn" id="btnShowCounter">🙋 Show to Cashier</button>
        </div>
        <input type="file" id="receiptInput" accept="image/*" capture="environment" style="display:none">
        <p style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:12px">💡 You can upload your receipt screenshot for auto-verification, or show your payment confirmation to the cashier directly.</p>
        <div id="uploadStatus"></div>
      </div>`}
    </div>`;
  }

  if (order.flaggedItems && order.flaggedItems.length) {
    html += `<div class="flagged-warning" role="alert"><strong>⚠️ Some items became unavailable:</strong><ul>`;
    order.flaggedItems.forEach(f => { html += `<li>${f}</li>`; });
    html += `</ul><a href="index">Update your order</a></div>`;
  }

  html += `<div class="order-details"><h3>Order Details</h3>`;
  if (order.notes) html += `<div style="background:var(--cream,#f9f5f0);padding:10px 12px;border-radius:8px;font-size:.85rem;margin-bottom:10px">📝 ${order.notes}</div>`;
  html += `<ul>`;
  items.forEach(i => {
    const label = i.variant ? `${i.name} (${i.variant})` : i.name;
    html += `<li><span>${label} × ${i.quantity || 1}</span><span>RM ${((i.price || i.unitPrice || 0) * (i.quantity || 1)).toFixed(2)}</span></li>`;
  });
  html += `</ul><div class="order-total">Total: RM ${total.toFixed(2)}</div></div>`;

  if (order.status === 'PENDING') {
    html += `<button class="cancel-btn" id="cancelBtn">Cancel Order</button>`;
  }

  if (['READY', 'CANCELLED', 'EXPIRED'].includes(order.status)) {
    html += `<a href="index" style="display:inline-block;margin-top:20px;color:var(--primary,#6B4226);font-weight:600;text-decoration:underline">← Back to Menu</a>`;
  }

  html += `<a href="track" style="display:block;margin-top:12px;color:var(--text-light,#7A6355);font-size:.9rem;text-decoration:underline">My Orders</a>`;

  trackApp.innerHTML = html;

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
    if (!confirm('Cancel this order?')) return;
    try {
      await fetch(`${API_BASE}/api/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' })
      });
      pollOrder();
    } catch { showError('Failed to cancel, try again'); }
  });

  if (['READY', 'CANCELLED', 'EXPIRED'].includes(order.status)) {
    clearInterval(pollTimer);
  }
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
      if (msgs[order.status] && Notification.permission === 'granted') {
        new Notification('CafePOS', { body: msgs[order.status] });
      }
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

  // History
  if (history.length) {
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
}

if (!orderId) {
  renderOrderHistory();
} else {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  pollOrder();
  pollTimer = setInterval(pollOrder, 7000);
}
