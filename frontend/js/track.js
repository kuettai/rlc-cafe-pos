const trackApp = document.getElementById('trackApp');
const errorBanner = document.getElementById('errorBanner');
const orderId = new URLSearchParams(window.location.search).get('id');
let pollTimer = null;

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

  html += `<div class="status-indicator status-${order.status}"><h2>${s.icon} ${s.text}</h2>`;
  if (order.status === 'PENDING') html += `<p style="margin-top:8px">Total: <strong>RM ${total.toFixed(2)}</strong></p>`;
  if (order.status === 'PREPARING') html += `<p style="margin-top:8px">Sit tight, your order is being made!</p>`;
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
      </div>
      ${hasReceipt ? `<div class="receipt-uploaded">
        <span>✅ Receipt uploaded (RM ${order.receiptAmount?.toFixed(2) || '?'})</span>
        <p style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:4px">Waiting for cashier to verify</p>
      </div>` : `<div class="receipt-upload-area">
        <p>After paying, upload your receipt screenshot:</p>
        <label class="upload-btn" for="receiptInput">📷 Upload Receipt</label>
        <input type="file" id="receiptInput" accept="image/*" capture="environment" style="display:none">
        <div id="uploadStatus"></div>
      </div>`}
    </div>`;
  }

  if (order.flaggedItems && order.flaggedItems.length) {
    html += `<div class="flagged-warning" role="alert"><strong>⚠️ Some items became unavailable:</strong><ul>`;
    order.flaggedItems.forEach(f => { html += `<li>${f}</li>`; });
    html += `</ul><a href="index.html">Update your order</a></div>`;
  }

  html += `<div class="order-details"><h3>Order Details</h3><ul>`;
  items.forEach(i => {
    const label = i.variant ? `${i.name} (${i.variant})` : i.name;
    html += `<li><span>${label} × ${i.quantity || 1}</span><span>RM ${((i.price || i.unitPrice || 0) * (i.quantity || 1)).toFixed(2)}</span></li>`;
  });
  html += `</ul><div class="order-total">Total: RM ${total.toFixed(2)}</div></div>`;

  if (order.status === 'PENDING') {
    html += `<button class="cancel-btn" id="cancelBtn">Cancel Order</button>`;
  }

  if (['READY', 'CANCELLED', 'EXPIRED'].includes(order.status)) {
    html += `<a href="index.html" style="display:inline-block;margin-top:20px;color:var(--primary,#6B4226);font-weight:600;text-decoration:underline">← Back to Menu</a>`;
  }

  trackApp.innerHTML = html;

  // Bind receipt upload
  document.getElementById('receiptInput')?.addEventListener('change', handleReceiptUpload);

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
      if (statusEl) statusEl.innerHTML = `<p class="upload-error">❌ ${data.error || 'Upload failed'}</p>
        <label class="upload-btn" for="receiptInput" style="margin-top:8px">📷 Try Again</label>`;
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
    const res = await fetch(`${API_BASE}/api/orders/${orderId}`);
    if (!res.ok) throw new Error();
    renderOrder(await res.json());
  } catch {
    showError('Connection error, retrying...');
  }
}

if (!orderId) {
  trackApp.innerHTML = '<div class="closed-msg"><h2>No order found</h2><p><a href="index.html">Back to menu</a></p></div>';
} else {
  pollOrder();
  pollTimer = setInterval(pollOrder, 7000);
}
