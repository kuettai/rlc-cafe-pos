const app = document.getElementById('app');
const cartBar = document.getElementById('cartBar');
const cartOverlay = document.getElementById('cartOverlay');
const cartItems = document.getElementById('cartItems');
const cartCount = document.getElementById('cartCount');
const cartTotal = document.getElementById('cartTotal');
const cartTotalExpanded = document.getElementById('cartTotalExpanded');
const cartSubmit = document.getElementById('cartSubmit');
const errorBanner = document.getElementById('errorBanner');

let menu = [];
let cart = [];
let queueSize = 0;

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.add('show');
  setTimeout(() => errorBanner.classList.remove('show'), 4000);
}

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function getAvailable(item) {
  return item.category === 'FOOD' ? (item.foodQuantityToday || 0) - (item.foodReserved || 0) : Infinity;
}

function renderMenu() {
  const name = localStorage.getItem('customerName') || '';
  const categories = ['DRINKS', 'FOOD'];
  const grouped = {};
  categories.forEach(c => { grouped[c] = menu.filter(i => i.category === c); });

  let html = `<section class="name-section"><label for="nameInput">Your Name</label><input type="text" id="nameInput" value="${name}" placeholder="Enter your name" aria-required="true"></section>`;

  if (queueSize > 0) {
    html += `<div class="queue-info" aria-live="polite">${queueSize} drink${queueSize > 1 ? 's' : ''} ahead of you, expect slight delay</div>`;
  }

  categories.forEach(cat => {
    if (!grouped[cat].length) return;
    html += `<h2 class="category-title">${cat === 'DRINKS' ? '🥤 Drinks' : '🍔 Food'}</h2>`;
    grouped[cat].forEach(item => {
      const avail = getAvailable(item);
      const cartItem = cart.find(c => c.id === item.id && c.variant === (item.variants ? item.variants[0] : null));
      const qty = cart.filter(c => c.id === item.id).reduce((s, c) => s + c.qty, 0);

      html += `<div class="menu-item" data-id="${item.id}">`;
      html += `<div class="item-header"><span class="item-name">${item.name}</span><span class="item-price">RM ${item.basePrice.toFixed(2)}</span></div>`;

      if (item.category === 'FOOD' && avail !== Infinity) {
        html += `<div class="item-stock">${avail > 0 ? avail + ' left' : 'Sold out'}</div>`;
      }

      if (item.variants && item.variants.length) {
        html += `<div class="variants" data-item-id="${item.id}">`;
        item.variants.forEach((v, i) => {
          const isActive = cart.some(c => c.id === item.id && c.variant === v);
          html += `<button class="${isActive ? 'active' : ''}" data-variant="${v}" aria-pressed="${isActive}">${v}</button>`;
        });
        html += `</div>`;
      }

      html += `<div class="qty-controls">`;
      html += `<button aria-label="Decrease ${item.name}" data-action="dec" data-id="${item.id}">−</button>`;
      html += `<span aria-live="polite">${qty}</span>`;
      html += `<button aria-label="Increase ${item.name}" data-action="inc" data-id="${item.id}" ${avail <= qty && item.category === 'FOOD' ? 'disabled' : ''}>+</button>`;
      html += `</div></div>`;
    });
  });

  app.innerHTML = html;
  bindMenuEvents();
  updateCartBar();
}

function getSelectedVariant(itemId) {
  const variantContainer = document.querySelector(`.variants[data-item-id="${itemId}"]`);
  if (!variantContainer) return null;
  const active = variantContainer.querySelector('.active');
  return active ? active.dataset.variant : variantContainer.querySelector('button')?.dataset.variant || null;
}

function bindMenuEvents() {
  document.getElementById('nameInput')?.addEventListener('input', e => {
    localStorage.setItem('customerName', e.target.value.trim());
  });

  document.querySelectorAll('.variants button').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.variants');
      container.querySelectorAll('button').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    });
  });

  document.querySelectorAll('.qty-controls button').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const item = menu.find(m => m.id === id);
      const variant = getSelectedVariant(id);

      if (action === 'inc') {
        const existing = cart.find(c => c.id === id && c.variant === variant);
        const totalQty = cart.filter(c => c.id === id).reduce((s, c) => s + c.qty, 0);
        if (item.category === 'FOOD' && totalQty >= getAvailable(item)) return;
        if (existing) { existing.qty++; } else { cart.push({ id, name: item.name, variant, price: item.basePrice, qty: 1 }); }
      } else {
        const existing = cart.find(c => c.id === id && c.variant === variant);
        if (existing) { existing.qty--; if (existing.qty <= 0) cart = cart.filter(c => c !== existing); }
      }
      renderMenu();
    });
  });
}

function updateCartBar() {
  const count = cart.reduce((s, c) => s + c.qty, 0);
  const total = cart.reduce((s, c) => s + c.qty * c.price, 0);
  cartCount.textContent = `${count} item${count !== 1 ? 's' : ''}`;
  cartTotal.textContent = `RM ${total.toFixed(2)}`;
  cartTotalExpanded.textContent = `Total: RM ${total.toFixed(2)}`;
  cartBar.classList.toggle('hidden', count === 0);
}

function renderCartPanel() {
  if (!cart.length) { cartItems.innerHTML = '<p>Cart is empty</p>'; cartSubmit.disabled = true; return; }
  cartSubmit.disabled = false;
  cartItems.innerHTML = cart.map((c, i) => `
    <div class="cart-item">
      <div class="cart-item-info"><div class="cart-item-name">${c.name}</div>${c.variant ? `<div class="cart-item-variant">${c.variant}</div>` : ''}</div>
      <div class="cart-item-actions">
        <button aria-label="Decrease" data-cart-idx="${i}" data-cart-action="dec">−</button>
        <span>${c.qty}</span>
        <button aria-label="Increase" data-cart-idx="${i}" data-cart-action="inc">+</button>
        <button class="remove-btn" aria-label="Remove" data-cart-idx="${i}" data-cart-action="remove">✕</button>
      </div>
    </div>`).join('');

  cartItems.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.cartIdx);
      const action = btn.dataset.cartAction;
      if (action === 'inc') cart[idx].qty++;
      else if (action === 'dec') { cart[idx].qty--; if (cart[idx].qty <= 0) cart.splice(idx, 1); }
      else cart.splice(idx, 1);
      renderCartPanel();
      updateCartBar();
      renderMenu();
    });
  });
}

cartBar.addEventListener('click', () => { cartOverlay.classList.add('open'); renderCartPanel(); });
cartOverlay.addEventListener('click', e => { if (e.target === cartOverlay) cartOverlay.classList.remove('open'); });

cartSubmit.addEventListener('click', async () => {
  const name = localStorage.getItem('customerName')?.trim();
  if (!name) { showError('Please enter your name first'); cartOverlay.classList.remove('open'); document.getElementById('nameInput')?.focus(); return; }
  if (!cart.length) return;

  cartSubmit.disabled = true;
  cartSubmit.textContent = 'Placing order...';

  try {
    const items = cart.map(c => ({ menuItemId: c.id, variant: c.variant, quantity: c.qty }));
    const res = await fetch(`${API_BASE}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: name, items })
    });
    const data = await res.json();
    if (!res.ok) { showError(data.message || 'Order failed, please try again'); await loadMenu(); renderMenu(); return; }
    cart = [];
    window.location.href = `track.html?id=${data.orderId}`;
  } catch (e) {
    showError('Connection error, please try again');
  } finally {
    cartSubmit.disabled = false;
    cartSubmit.textContent = 'Place Order';
  }
});

async function loadMenu() {
  const data = await apiFetch('/api/menu');
  menu = data.items || data;
  queueSize = data.queueSize || 0;
}

async function init() {
  try {
    const status = await apiFetch('/api/cafe/status');
    if (status.status === 'CLOSED') {
      app.innerHTML = `<div class="closed-msg"><h2>Café is closed</h2><p>See you next Sunday! ☕</p><p style="margin-top:12px;font-size:.9rem">📍 Lot 5, Jalan 51A/221, 46100 PJ</p></div>`;
      return;
    }
    await loadMenu();
    renderMenu();
  } catch (e) {
    showError('Connection error, retrying...');
    setTimeout(init, 3000);
  }
}

init();
