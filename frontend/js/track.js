const trackApp = document.getElementById('trackApp');
const errorBanner = document.getElementById('errorBanner');
const orderId = new URLSearchParams(window.location.search).get('id');
let pollTimer = null;

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.add('show');
  setTimeout(() => errorBanner.classList.remove('show'), 4000);
}

const STATUS_MAP = {
  PENDING: { text: 'Waiting for payment confirmation', icon: '⏳' },
  PREPARING: { text: 'Your order is being prepared ☕', icon: '☕' },
  READY: { text: 'Your order is ready! 🎉', icon: '🎉' },
  CANCELLED: { text: 'Order was cancelled', icon: '❌' },
  EXPIRED: { text: 'Order was cancelled', icon: '❌' }
};

function renderOrder(order) {
  const s = STATUS_MAP[order.status] || STATUS_MAP.PENDING;
  const items = order.items || [];
  const total = order.totalPrice || items.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0);

  let html = `<div class="status-indicator status-${order.status}"><h2>${s.icon} ${s.text}</h2>`;
  if (order.status === 'PENDING') html += `<p style="margin-top:8px">Total: <strong>RM ${total.toFixed(2)}</strong> — please complete payment</p>`;
  if (order.status === 'CANCELLED' && order.reason) html += `<p>${order.reason}</p>`;
  html += `</div>`;

  if (order.flaggedItems && order.flaggedItems.length) {
    html += `<div class="flagged-warning" role="alert"><strong>⚠️ Some items became unavailable:</strong><ul>`;
    order.flaggedItems.forEach(f => { html += `<li>${f}</li>`; });
    html += `</ul><a href="index.html">Update your order</a></div>`;
  }

  html += `<div class="order-details"><h3>Order Details</h3><ul>`;
  items.forEach(i => {
    const label = i.variant ? `${i.name} (${i.variant})` : i.name;
    html += `<li><span>${label} × ${i.quantity || 1}</span><span>RM ${((i.price || 0) * (i.quantity || 1)).toFixed(2)}</span></li>`;
  });
  html += `</ul><div class="order-total">Total: RM ${total.toFixed(2)}</div></div>`;

  if (order.status === 'PENDING') {
    html += `<button class="cancel-btn" id="cancelBtn">Cancel Order</button>`;
  }

  trackApp.innerHTML = html;

  document.getElementById('cancelBtn')?.addEventListener('click', async () => {
    if (!confirm('Cancel this order?')) return;
    try {
      await fetch(`${API_BASE}/api/orders/${orderId}/cancel`, { method: 'POST' });
      pollOrder();
    } catch { showError('Failed to cancel, try again'); }
  });

  if (['READY', 'CANCELLED', 'EXPIRED'].includes(order.status)) {
    clearInterval(pollTimer);
  }
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
