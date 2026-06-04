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
let cart = JSON.parse(localStorage.getItem('cart') || '[]');
function saveCart(){ localStorage.setItem('cart', JSON.stringify(cart)); }
let queueSize = 0;
let celebrationMode = false;
let celebrationPrice = 5;
let menuLayout = localStorage.getItem('menuLayout') || 'list';
let menuFilter = '';
let menuCategory = 'ALL';

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

  // Only build the shell if it doesn't exist yet
  if (!document.getElementById('menuItems')) {
    let shell = '';
    shell += `<section class="name-section"><label for="nameInput">Your Name</label><div style="display:flex;gap:8px;align-items:center"><input type="text" id="nameInput" value="${name}" placeholder="Enter your name" aria-required="true" style="flex:1"><a href="track" class="layout-toggle" aria-label="My Orders" title="My Orders" style="text-decoration:none">📋</a><button id="layoutToggle" class="layout-toggle" aria-label="Toggle view">${menuLayout === 'grid' ? '☰' : '⊞'}</button></div></section>`;
    shell += `<div class="menu-filter"><input type="text" id="menuSearch" placeholder="🔍 Search menu..." value="${menuFilter}" class="menu-search-input"><div class="menu-filter-tabs"><button class="menu-filter-tab${menuCategory==='ALL'?' active':''}" data-cat="ALL">All</button><button class="menu-filter-tab${menuCategory==='DRINK'?' active':''}" data-cat="DRINK">🥤 Drinks</button><button class="menu-filter-tab${menuCategory==='FOOD'?' active':''}" data-cat="FOOD">🍔 Food</button></div></div>`;
    if (celebrationMode) {
      shell += `<div class="celebration-banner" aria-live="polite">🎉 Celebration Day! Selected drinks at <strong>RM ${celebrationPrice.toFixed(2)}</strong></div>`;
    }
    if (queueSize > 0) {
      const estMin = Math.max(3, queueSize * 3);
      shell += `<div class="queue-info" aria-live="polite">☕ ${queueSize} order${queueSize > 1 ? 's' : ''} ahead · est. wait ~${estMin} min</div>`;
    }
    shell += `<div id="menuItems"></div>`;
    app.innerHTML = shell;
    bindShellEvents();
  }

  // Render only the menu items
  const categories = ['DRINK', 'FOOD'];
  const filteredMenu = menu.filter(i => {
    if (menuCategory !== 'ALL' && i.category !== menuCategory) return false;
    if (menuFilter && !i.name.toLowerCase().includes(menuFilter.toLowerCase())) return false;
    return true;
  });
  const filteredGrouped = {};
  categories.forEach(c => { filteredGrouped[c] = filteredMenu.filter(i => i.category === c); });

  let html = '';
  categories.forEach(cat => {
    if (!filteredGrouped[cat].length) return;
    filteredGrouped[cat].sort((a, b) => {
      const pinDiff = (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
      if (pinDiff !== 0) return pinDiff;
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
    html += `<h2 class="category-title">${cat === 'DRINK' ? '🥤 Drinks' : '🍔 Food'}</h2>`;
    html += `<div class="${menuLayout === 'grid' ? 'menu-grid' : ''}">`;
    filteredGrouped[cat].forEach(item => {
      const avail = getAvailable(item);
      const soldOut = item.category === 'FOOD' && avail <= 0;
      const qty = cart.filter(c => c.id === item.id).reduce((s, c) => s + c.qty, 0);

      const displayPrice = (celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true) ? celebrationPrice : item.basePrice;
      html += `<div class="menu-item${item.isPinned ? ' menu-item-pinned' : ''}${soldOut ? ' sold-out' : ''}" data-id="${item.id}">`;
      html += `<div class="item-header"><span class="item-name">${item.isPinned ? '⭐ ' : ''}${item.name}</span><span class="item-price">${celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true ? '<s style="opacity:.5;font-size:.8em">RM '+item.basePrice.toFixed(2)+'</s> ' : ''}RM ${displayPrice.toFixed(2)}</span></div>`;
      if (item.description) {
        html += `<div style="font-size:.82rem;color:var(--text-light,#7A6355);margin-bottom:8px">${item.description}</div>`;
      }

      if (item.category === 'FOOD' && avail !== Infinity) {
        html += `<div class="item-stock">${soldOut ? 'Sold out' : avail + ' left'}</div>`;
      }

      if (item.variants && item.variants.length) {
        html += `<div class="variants" data-item-id="${item.id}">`;
        item.variants.forEach((v, i) => {
          const isActive = cart.some(c => c.id === item.id && c.variant === v.id) || (i === 0 && !cart.some(c => c.id === item.id));
          const priceTag = v.priceModifier ? ` (+RM${v.priceModifier})` : '';
          html += `<button class="${isActive ? 'active' : ''}" data-variant="${v.id}" aria-pressed="${isActive}">${v.name}${priceTag}</button>`;
        });
        html += `</div>`;
      }

      html += `<div class="qty-controls">`;
      html += `<button aria-label="Decrease ${item.name}" data-action="dec" data-id="${item.id}">−</button>`;
      html += `<span aria-live="polite">${qty}</span>`;
      html += `<button aria-label="Increase ${item.name}" data-action="inc" data-id="${item.id}" ${soldOut || (avail <= qty && item.category === 'FOOD') ? 'disabled' : ''}>+</button>`;
      html += `</div></div>`;
    });
    html += `</div>`;
  });

  document.getElementById('menuItems').innerHTML = html;
  bindItemEvents();
  updateCartBar();
}

let searchDebounceTimer = null;

function bindShellEvents() {
  document.getElementById('nameInput')?.addEventListener('input', e => {
    localStorage.setItem('customerName', e.target.value.trim());
  });

  document.getElementById('menuSearch')?.addEventListener('input', e => {
    menuFilter = e.target.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      const el = document.getElementById('menuSearch');
      const pos = el?.selectionStart;
      renderMenu();
      const newEl = document.getElementById('menuSearch');
      if (newEl && pos !== null) {
        newEl.value = menuFilter;
        newEl.setSelectionRange(pos, pos);
        newEl.focus();
      }
    }, 150);
  });

  document.querySelectorAll('.menu-filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      menuCategory = btn.dataset.cat;
      document.querySelectorAll('.menu-filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderMenu();
    });
  });

  document.getElementById('layoutToggle')?.addEventListener('click', () => {
    menuLayout = menuLayout === 'list' ? 'grid' : 'list';
    localStorage.setItem('menuLayout', menuLayout);
    document.getElementById('layoutToggle').textContent = menuLayout === 'grid' ? '☰' : '⊞';
    renderMenu();
  });
}

function getSelectedVariant(itemId) {
  const variantContainer = document.querySelector(`.variants[data-item-id="${itemId}"]`);
  if (!variantContainer) return null;
  const active = variantContainer.querySelector('.active');
  return active ? active.dataset.variant : variantContainer.querySelector('button')?.dataset.variant || null;
}

function bindItemEvents() {
  document.querySelectorAll('.variants button').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.variants');
      container.querySelectorAll('button').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      const itemId = container.dataset.itemId;
      const item = menu.find(m => m.id === itemId);
      const variantObj = item.variants?.find(v => v.id === btn.dataset.variant);
      const basePrice = (celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true) ? celebrationPrice : item.basePrice;
      const price = basePrice + ((celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true) ? 0 : (variantObj?.priceModifier || 0));
      const priceSpan = container.closest('.menu-item').querySelector('.item-price');
      priceSpan.innerHTML = `${celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true ? '<s style="opacity:.5;font-size:.8em">RM '+item.basePrice.toFixed(2)+'</s> ' : ''}RM ${price.toFixed(2)}`;
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
        const variantObj = item.variants?.find(v => v.id === variant);
        const basePrice = (celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true) ? celebrationPrice : item.basePrice;
        const price = basePrice + ((celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true) ? 0 : (variantObj?.priceModifier || 0));
        if (existing) { existing.qty++; } else { cart.push({ id, name: item.name, variant, variantName: variantObj?.name || variant, price, qty: 1 }); }
        saveCart();
      } else {
        const existing = cart.find(c => c.id === id && c.variant === variant);
        if (existing) { existing.qty--; if (existing.qty <= 0) cart = cart.filter(c => c !== existing); }
        saveCart();
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
  const wasHidden = cartBar.classList.contains('hidden');
  cartBar.classList.toggle('hidden', count === 0);
  if (wasHidden && count > 0) {
    cartBar.classList.add('bounce');
    setTimeout(() => cartBar.classList.remove('bounce'), 600);
  }
}

function renderCartPanel() {
  if (!cart.length) { cartItems.innerHTML = '<p>Cart is empty</p>'; cartSubmit.disabled = true; return; }
  cartSubmit.disabled = false;
  cartItems.innerHTML = cart.map((c, i) => {
    const variantLabel = c.variantName || c.variant || '';
    return `<div class="cart-item">
      <div class="cart-item-info"><div class="cart-item-name">${c.name}</div>${variantLabel ? `<div class="cart-item-variant">${variantLabel}</div>` : ''}</div>
      <div class="cart-item-actions">
        <button aria-label="Decrease" data-cart-idx="${i}" data-cart-action="dec">−</button>
        <span>${c.qty}</span>
        <button aria-label="Increase" data-cart-idx="${i}" data-cart-action="inc">+</button>
        <button class="remove-btn" aria-label="Remove" data-cart-idx="${i}" data-cart-action="remove">✕</button>
      </div>
    </div>`;
  }).join('') + `<textarea id="orderNotes" placeholder="Special requests (e.g. less sugar, extra hot)" style="width:100%;margin-top:12px;padding:10px;border:1px solid var(--cream-dark,#ddd);border-radius:8px;font-size:.9rem;resize:none;font-family:inherit" rows="2">${localStorage.getItem('orderNotes') || ''}</textarea><p style="font-size:.82rem;color:var(--text-light,#7A6355);margin-top:12px;text-align:center">💳 Payment via DuitNow QR after ordering</p>`;

  cartItems.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.cartIdx);
      const action = btn.dataset.cartAction;
      if (action === 'inc') cart[idx].qty++;
      else if (action === 'dec') { cart[idx].qty--; if (cart[idx].qty <= 0) cart.splice(idx, 1); }
      else cart.splice(idx, 1);
      saveCart();
      renderCartPanel();
      updateCartBar();
      renderMenu();
    });
  });
  document.getElementById('orderNotes')?.addEventListener('input', e => {
    localStorage.setItem('orderNotes', e.target.value);
  });
}

cartBar.addEventListener('click', () => { cartOverlay.classList.add('open'); renderCartPanel(); });
cartOverlay.addEventListener('click', e => { if (e.target === cartOverlay) cartOverlay.classList.remove('open'); });
document.getElementById('cartClose')?.addEventListener('click', () => { cartOverlay.classList.remove('open'); });

function promptName() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(61,43,31,.6);backdrop-filter:blur(4px);z-index:400;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `<div style="background:#fff;border-radius:var(--radius-xl,16px);padding:28px 24px;width:90%;max-width:340px;box-shadow:0 8px 24px rgba(74,44,23,.15)">
      <h3 style="color:var(--primary,#6B4226);margin-bottom:8px">What's your name?</h3>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin-bottom:16px">So we can call you when your order is ready ☕</p>
      <input id="promptNameInput" type="text" placeholder="Your name" style="width:100%;padding:14px 16px;border:2px solid var(--accent-light,#E8C9A0);border-radius:12px;font-size:1rem;background:var(--cream,#FFF8F0)" autofocus>
      <button id="promptNameOk" style="width:100%;padding:14px;margin-top:14px;background:linear-gradient(135deg,var(--primary,#6B4226),var(--primary-light,#8B5E3C));color:#fff;border:none;border-radius:12px;font-size:1.05rem;font-weight:700;cursor:pointer">Continue</button>
    </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#promptNameInput');
    const btn = overlay.querySelector('#promptNameOk');
    input.focus();
    const submit = () => { const v = input.value.trim(); if (v) { overlay.remove(); resolve(v); } else { input.style.borderColor = 'var(--danger,#C0392B)'; } };
    btn.onclick = submit;
    input.onkeydown = e => { if (e.key === 'Enter') submit(); };
    overlay.onclick = e => { if (e.target === overlay) { overlay.remove(); resolve(null); } };
  });
}

cartSubmit.addEventListener('click', async () => {
  let name = localStorage.getItem('customerName')?.trim();
  if (!name) {
    name = await promptName();
    if (!name) return;
    localStorage.setItem('customerName', name);
    const nameInput = document.getElementById('nameInput');
    if (nameInput) nameInput.value = name;
  }
  if (!cart.length) return;

  const existingOrderId = localStorage.getItem('lastOrderId');
  if (existingOrderId) {
    try {
      const check = await fetch(`${API_BASE}/api/orders/${existingOrderId}`);
      if (check.ok) {
        const existing = await check.json();
        if (['PENDING', 'PREPARING'].includes(existing.status)) {
          if (!confirm('You have an active order. Place another one?')) {
            window.location.href = `track?id=${existingOrderId}`;
            return;
          }
        }
      }
    } catch(e) {}
  }

  cartSubmit.disabled = true;
  cartSubmit.textContent = 'Placing order...';

  try {
    const items = cart.map(c => ({ menuItemId: c.id, variant: c.variant, quantity: c.qty }));
    const res = await fetch(`${API_BASE}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerName: name, items, notes: document.getElementById('orderNotes')?.value?.trim() || '' })
    });
    const data = await res.json();
    if (!res.ok) { showError(data.message || 'Order failed, please try again'); await loadMenu(); renderMenu(); return; }
    cart = [];
    saveCart();
    localStorage.removeItem('orderNotes');
    const orderHistory = JSON.parse(localStorage.getItem('orderHistory') || '[]');
    orderHistory.unshift({ orderId: data.orderId, date: new Date().toISOString(), total: data.totalAmount });
    localStorage.setItem('orderHistory', JSON.stringify(orderHistory.slice(0, 50)));
    localStorage.setItem('lastOrderId', data.orderId);
    cartOverlay.classList.remove('open');
    window.location.href = `track?id=${data.orderId}`;
  } catch (e) {
    showError('Connection error, please try again');
  } finally {
    cartSubmit.disabled = false;
    cartSubmit.textContent = 'Place Order';
  }
});

async function loadMenu() {
  const data = await apiFetch('/api/menu');
  menu = (data.items || data).map(i => ({ ...i, id: i.menuItemId })).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
}

async function init() {
  try {
    const status = await apiFetch('/api/cafe/status');
    queueSize = status.queueSize || 0;
    celebrationMode = status.celebrationMode || false;
    celebrationPrice = status.celebrationPrice || 5;
    if (status.cafeStatus === 'CLOSED') {
      app.innerHTML = `<div class="closed-msg">
        <h2>Café is closed</h2>
        <p>See you next Sunday! ☕</p>
        <p style="margin-top:16px;font-size:.9rem;color:var(--text-light)">⏰ Opens 10:15 AM & 12:45 PM</p>
        <p style="margin-top:8px;font-size:.85rem">📍 Lot 5, Jalan 51A/221, 46100 PJ</p>
        <p style="margin-top:20px"><a href="track" style="color:var(--primary,#6B4226);font-weight:600;text-decoration:underline">Track an existing order →</a></p>
      </div>`;
      return;
    }
    await loadMenu();
    const prevLen = cart.length;
    cart = cart.filter(c => { const m = menu.find(i => i.id === c.id); return m && m.isActive && m.isEnabledToday; });
    if (cart.length !== prevLen) saveCart();
    renderMenu();
  } catch (e) {
    showError('Connection error, retrying...');
    setTimeout(init, 3000);
  }
}

init();
