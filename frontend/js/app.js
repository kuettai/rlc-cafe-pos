const app = document.getElementById('app');
const cartBar = document.getElementById('cartBar');
const cartOverlay = document.getElementById('cartOverlay');
const cartItems = document.getElementById('cartItems');
const cartCount = document.getElementById('cartCount');
const cartTotal = document.getElementById('cartTotal');
const cartTotalExpanded = document.getElementById('cartTotalExpanded');
const cartSubmit = document.getElementById('cartSubmit');
const errorBanner = document.getElementById('errorBanner');




// Escape all five HTML-significant characters. Free text the customer types
// (per-item notes) is rendered back into the cart row, including into a quoted
// value="…" attribute, so it must be escaped at every render site. Same
// implementation as track.js and pos.js — there is no shared util module here
// and adding one would mean a new file in the sw.js SHELL array.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let menu = [];
let cart = JSON.parse(localStorage.getItem('cart') || '[]');
function saveCart(){ localStorage.setItem('cart', JSON.stringify(cart)); }

// One cart line per drink, always `qty: 1`, so every line can carry its own
// per-item note ("less sugar" on the second of three lattes). Lines are no
// longer merged by id + variant anywhere in this file.
//
// Carts restored from localStorage were written by an older shell that DID
// merge, so they can hold lines with qty > 1. Expand them once, here at load,
// rather than teaching every downstream site to handle both shapes. Legacy
// lines carry no note by definition, so the copies are indistinguishable.
(function expandLegacyMergedCartLines(){
  if (!cart.some(c => (Number(c.qty) || 1) > 1)) return;
  const expanded = [];
  cart.forEach(c => {
    const n = Math.max(1, Math.floor(Number(c.qty) || 1));
    for (let i = 0; i < n; i++) expanded.push({ ...c, qty: 1 });
  });
  cart = expanded;
  saveCart();
})();
let queueSize = 0;
let celebrationMode = false;
let celebrationPrice = 5;
let menuLayout = localStorage.getItem('menuLayout') || 'list';
let menuFilter = '';
let menuCategory = 'ALL';
let customerProfile = JSON.parse(localStorage.getItem('customerProfile') || 'null');
let featuredDrink = null;  // from /api/cafe/status

// ─── Pre-order mode ─────────────────────────────────────────────────
// Activated when the customer opens the page with ?code=<PREORDER_CODE>.
// In this mode: drinks-only, prices shown but zeroed on submit, café-open
// check bypassed, collection-time picker required.
const _preorderCodeParam = new URLSearchParams(window.location.search).get('code');
let preorderMode = false;
let preorderCode = null;
let preorderInfo = null;   // { name, serviceDate, opensAt, expiresAt } from validate endpoint
let collectionTime = '';   // e.g. "9:15 AM" — required before submit in preorder mode

// ─── Staff mode ─────────────────────────────────────────────────────
// The same ?code= param is resolved against two namespaces: pre-order codes
// first (unchanged behaviour), then staff codes. A valid staff code prices
// DRINKs at the flat staff price and leaves FOOD alone — the rule itself lives
// in CafePricing (mirror of backend/src/lib/pricing.ts), never inline here.
//
// Unlike a pre-order link, staff mode does NOT bypass the café-open check, does
// NOT restrict the menu to drinks, and the order still lands PENDING for the
// cashier to confirm.
let staffMode = false;
let staffCode = null;
let staffInfo = null;      // { code, label } from the validate endpoint

// 15-minute slots from 9:00 AM to 2:00 PM (inclusive), formatted 12-hour.
function generateCollectionSlots() {
  const slots = [];
  // 09:00 through 14:00 in 15-min steps.
  for (let mins = 9 * 60; mins <= 14 * 60; mins += 15) {
    const h24 = Math.floor(mins / 60);
    const m = mins % 60;
    const h12 = ((h24 + 11) % 12) + 1;
    const suffix = h24 < 12 ? 'AM' : 'PM';
    slots.push(`${h12}:${String(m).padStart(2, '0')} ${suffix}`);
  }
  return slots;
}

// Strip leading emoji + whitespace from a display name. The DynamoDB items
// have legacy emoji prefixes (e.g. "☕ Latte", "🍔 Food") which are now
// redundant since each item has a real image. The slug helper below already
// drops emoji as a side-effect, so image lookups still work either way; this
// helper is purely for display text.
/**
 * Strip variant options the active pre-order campaign excludes, e.g. no Oat Milk
 * on a ministry link (`excludedOptions: ["Milk:Oat Milk"]`).
 *
 * Returns the item unchanged outside pre-order mode. The filtering itself lives
 * in RLCVariants (variants.js) because track.html's pre-order edit flow needs
 * exactly the same rule — variant selection is a single source of truth, so this
 * is only the "when", not the "how". Degrades to the unfiltered item if a stale
 * cached variants.js predates the helper; the backend refuses the option either
 * way.
 */
function applyPreorderOptionExclusions(item) {
  if (!preorderMode) return item;
  if (!window.RLCVariants || typeof RLCVariants.applyOptionExclusions !== 'function') return item;
  return RLCVariants.applyOptionExclusions(item, preorderInfo?.excludedOptions);
}

function stripEmoji(name) {
  return String(name || '').replace(/^[\p{Emoji}\p{Emoji_Component}\s]+/u, '').trim();
}

// Build a slug for the menu image filename.
//   "Latte"               → "latte"
//   "Hot Chocolate"       → "hot-chocolate"
//   "Citrus Black (Iced)" → "citrus-black"   (parenthetical suffixes stripped)
//   "Fruit Tea (Hot)"     → "fruit-tea"
// Returns '' for empty/missing names so callers can skip the <img> tag.
function slugifyMenuName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')   // strip "(Hot)", "(Iced)" etc.
    .replace(/[^a-z0-9]+/g, '-')        // any other non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '');           // trim leading/trailing hyphens
}

// Curated one-liner taglines shown under the item name on the customer
// ordering page. Keyed by the same slug as the image filename. Items not
// listed here render with no tagline (graceful fallback).
const MENU_DESCRIPTIONS = {
  'latte': 'Your personality but in a cup ☕',
  'mocha': "For when you can't decide between coffee and chocolate — so both",
  'citrus-black': 'Espresso went on a tropical vacation',
  'hot-chocolate': "A warm hug that doesn't ask awkward questions",
  'iced-chocolate': 'Dessert energy, zero guilt',
  'matcha-latte': 'Main character in a Studio Ghibli film',
  'chai-latte': 'Rest for the weary, spice for the bold ☕',
  'butterfly-pea-soda': 'Pretty enough for your IG story',
  'passion-fruit-soda': 'Summer in a glass, no passport needed',
  'lemon-soda': 'When life gives you lemons, add sparkles ✨',
  'orange-soda': 'Vitamin C but make it fun',
  'fruit-tea': 'Adulting, but make it refreshing',
  'ribena-tonic': 'New creation, same childhood taste 💜',
  'raspberry-iced-tea': "Sweet, tart, and doesn't take itself too seriously",
};

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

// ─── Staff-mode price display ───────────────────────────────────────
// Every number below comes from window.CafePricing (the mirror of
// backend/src/lib/pricing.ts). No discount arithmetic lives in this file: the
// backend re-prices the order on submit and its number is the one charged.
// If pricing.js is missing (stale cached shell), these degrade to gross prices
// rather than throwing.
function staffPricingOpts() {
  return { customerClass: 'STAFF', celebrationMode, celebrationPrice };
}

/** Net + gross unit price for a menu item as listed (no variants selected). */
function staffItemPrice(item) {
  const gross = Number(item.basePrice) || 0;
  if (!window.CafePricing) return { unitPrice: gross, grossUnitPrice: gross };
  return CafePricing.priceCartLine({
    price: gross,
    category: item.category,
    basePrice: gross,
    celebrationEligible: item.celebrationEligible === true,
  }, staffPricingOpts());
}

/**
 * Shape a stored cart line for CafePricing, which wants the GROSS unit price.
 * `price` on a cart line already has celebration pricing folded in, so
 * `grossPrice` (written by bindItemEvents) is used when present. The live menu
 * item wins for category/basePrice/eligibility; a line left over from an older
 * shell may not carry them.
 */
function cartLineForPricing(c) {
  const m = menu.find(i => i.id === c.id);
  return {
    price: Number(c.grossPrice != null ? c.grossPrice : c.price) || 0,
    qty: c.qty,
    category: (m && m.category) || c.category || 'DRINK',
    basePrice: Number(m ? m.basePrice : (c.basePrice != null ? c.basePrice : c.price)) || 0,
    celebrationEligible: m ? m.celebrationEligible === true : c.celebrationEligible === true,
  };
}

function renderMenu() {
  const name = localStorage.getItem('customerName') || '';

  // Only build the shell if it doesn't exist yet
  if (!document.getElementById('menuItems')) {
    let shell = '';
    // Pre-order banner takes precedence over the celebration banner —
    // ministry volunteers already order for free, so celebration pricing
    // is moot in this mode.
    if (preorderMode) {
      // Custom banner takes precedence when the admin has set one on the
      // campaign; otherwise fall back to the default two-line template.
      const svcDateDisplay = preorderInfo?.serviceDate
        ? new Date(preorderInfo.serviceDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
        : '';
      const label = preorderInfo?.name ? String(preorderInfo.name) : 'Sunday Service';
      const esc = s => String(s || '').replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
      const customBanner = preorderInfo?.bannerMessage;
      let bannerBody;
      if (customBanner) {
        // Preserve line breaks the admin used in the textarea.
        const lines = String(customBanner).split(/\r?\n/).map(esc);
        bannerBody = lines.map((line, i) =>
          i === 0
            ? `<div><strong>${line}</strong></div>`
            : `<div class="preorder-banner-sub">${line}</div>`
        ).join('');
      } else {
        bannerBody =
          `<div><strong>Ministry Pre-Order</strong> — Kindly select one drink</div>` +
          `<div class="preorder-banner-sub">${esc(label)}${svcDateDisplay ? ' · Collect ' + svcDateDisplay : ''}</div>`;
      }
      shell += `<div class="preorder-banner" role="status" aria-live="polite">
        <span class="preorder-banner-icon">🎉</span>
        <div class="preorder-banner-text">${bannerBody}</div>
      </div>`;
    }
    // Staff-link banner. States the deal plainly — drinks at the staff price,
    // food unchanged — and that the cashier still confirms it, so nobody is
    // surprised at the counter.
    if (staffMode) {
      const esc = s => String(s || '').replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
      const staffPrice = Number(window.CafePricing?.STAFF_DRINK_PRICE ?? 5);
      const label = staffInfo?.label ? esc(staffInfo.label) : '';
      shell += `<div class="staff-banner" role="status" aria-live="polite">
        <span class="staff-banner-icon">🎫</span>
        <div class="staff-banner-text">
          <div><strong>Staff price</strong> — drinks RM ${staffPrice.toFixed(2)} each, food at full price</div>
          <div class="staff-banner-sub">${label ? label + ' · ' : ''}The cashier confirms staff price when you pay.</div>
        </div>
      </div>`;
    }
    if (customerProfile) {
      shell += `<section class="name-section"><div class="profile-badge"><span class="profile-icon">👤</span><span class="profile-name">${customerProfile.name}</span><span class="profile-orders">${customerProfile.orderCount || 0} orders</span><button id="profileLogout" class="profile-logout">✕</button></div><div style="display:flex;gap:8px;align-items:center;margin-top:8px"><a href="track" class="layout-toggle" aria-label="My Orders" title="My Orders" style="text-decoration:none">📋</a><button id="layoutToggle" class="layout-toggle" aria-label="Toggle view">${menuLayout === 'grid' ? '☰' : '⊞'}</button></div></section>`;
    } else {
      shell += `<section class="name-section"><label for="nameInput">Your Name</label><div style="display:flex;gap:8px;align-items:center"><input type="text" id="nameInput" value="${name}" placeholder="Enter your name" aria-required="true" style="flex:1"><a href="track" class="layout-toggle" aria-label="My Orders" title="My Orders" style="text-decoration:none">📋</a><button id="layoutToggle" class="layout-toggle" aria-label="Toggle view">${menuLayout === 'grid' ? '☰' : '⊞'}</button></div><button id="returningBtn" class="returning-btn">Returning customer? Tap here</button></section>`;
    }
    // Collection-time picker — required in pre-order mode. Sits between
    // the name section and the menu filter so it's hard to miss. Options
    // come from the campaign's `collectionOptions`; default to the two
    // service slots if the campaign didn't customize.
    if (preorderMode) {
      const opts = Array.isArray(preorderInfo?.collectionOptions) && preorderInfo.collectionOptions.length
        ? preorderInfo.collectionOptions
        : ['After 1st Service', 'After 2nd Service'];
      const escAttr = s => String(s || '').replace(/"/g, '&quot;');
      const escText = s => String(s || '').replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
      shell += `<section class="collection-section">
        <label>Collection Time <span style="color:var(--danger,#C0392B)">*</span></label>
        <div class="collection-radios">
          ${opts.map(t => `<label class="collection-radio">
            <input type="radio" name="collectionTime" value="${escAttr(t)}"${collectionTime === t ? ' checked' : ''}>
            <span>${escText(t)}</span>
          </label>`).join('')}
        </div>
        <p class="collection-hint">Drinks are prepared to be ready around this time.</p>
      </section>`;
    }
    shell += `<div class="menu-filter"><input type="text" id="menuSearch" placeholder="🔍 Search menu..." value="${menuFilter}" class="menu-search-input"><div class="menu-filter-tabs"><button class="menu-filter-tab${menuCategory==='ALL'?' active':''}" data-cat="ALL">All</button><button class="menu-filter-tab${menuCategory==='DRINK'?' active':''}" data-cat="DRINK">Drinks</button>${preorderMode ? '' : `<button class="menu-filter-tab${menuCategory==='FOOD'?' active':''}" data-cat="FOOD">Food</button>`}</div></div>`;
    if (!preorderMode && celebrationMode) {
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
    // Pre-order mode is drinks-only, regardless of the tab selection.
    if (preorderMode && i.category !== 'DRINK') return false;
    // If the campaign restricts to specific menuItemIds, enforce it here
    // too (belt-and-braces — backend also validates at order creation).
    if (preorderMode && Array.isArray(preorderInfo?.eligibleItems) && preorderInfo.eligibleItems.length > 0) {
      if (!preorderInfo.eligibleItems.includes(i.id)) return false;
    }
    if (menuCategory !== 'ALL' && i.category !== menuCategory) return false;
    if (menuFilter && !i.name.toLowerCase().includes(menuFilter.toLowerCase())) return false;
    return true;
  });
  const filteredGrouped = {};
  categories.forEach(c => { filteredGrouped[c] = filteredMenu.filter(i => i.category === c); });

  let html = '';

  // ─── Featured Drink Hero ───────────────────────────────────────────
  if (featuredDrink && !preorderMode) {
    const featItem = menu.find(i => i.id === featuredDrink.menuItemId);
    if (featItem) {
      const featSlug = slugifyMenuName(featItem.name);
      const featDisplayName = stripEmoji(featItem.name);
      const featPrice = (celebrationMode && featItem.celebrationEligible === true) ? celebrationPrice : featItem.basePrice;
      const featQty = cart.filter(c => c.id === featItem.id).reduce((s, c) => s + c.qty, 0);
      html += `<div class="featured-drink-hero" data-id="${featItem.id}">
        <div class="featured-badge">⭐ Featured Today</div>
        <img class="featured-img" src="img/menu/${featSlug}.png" alt="${featDisplayName}" loading="lazy" onerror="this.style.display='none'">
        <div class="featured-info">
          <div class="featured-name">${featDisplayName}</div>
          <div class="featured-price">RM ${featPrice.toFixed(2)}</div>
        </div>
        <div class="qty-controls">
          <button aria-label="Decrease ${featDisplayName}" data-action="dec" data-id="${featItem.id}">−</button>
          <span aria-live="polite">${featQty}</span>
          <button aria-label="Increase ${featDisplayName}" data-action="inc" data-id="${featItem.id}">+</button>
        </div>
      </div>`;
    }
  }

  categories.forEach(cat => {
    if (!filteredGrouped[cat].length) return;
    filteredGrouped[cat].sort((a, b) => {
      const pinDiff = (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
      if (pinDiff !== 0) return pinDiff;
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
    html += `<h2 class="category-title">${cat === 'DRINK' ? 'Drinks' : 'Food'}</h2>`;
    html += `<div class="${menuLayout === 'grid' ? 'menu-grid' : ''}">`;
    filteredGrouped[cat].forEach(item => {
      const avail = getAvailable(item);
      const soldOut = item.category === 'FOOD' && avail <= 0;
      const qty = cart.filter(c => c.id === item.id).reduce((s, c) => s + c.qty, 0);

      const displayPrice = (celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true) ? celebrationPrice : item.basePrice;
      const slug = slugifyMenuName(item.name);
      const displayName = stripEmoji(item.name);
      const tagline = MENU_DESCRIPTIONS[slug];
      let priceHtml;
      if (preorderMode) {
        // Ministry pre-order: real price is struck through and a FREE badge sits next to it.
        priceHtml = `<s style="opacity:.5">RM ${item.basePrice.toFixed(2)}</s> <span class="free-badge">FREE</span>`;
      } else if (staffMode) {
        // Same strike-through pattern as celebration mode. FOOD comes back at
        // gross from CafePricing, so it renders exactly as it does normally.
        const sp = staffItemPrice(item);
        priceHtml = `${sp.unitPrice < sp.grossUnitPrice ? '<s style="opacity:.5;font-size:.8em">RM '+sp.grossUnitPrice.toFixed(2)+'</s> ' : ''}RM ${sp.unitPrice.toFixed(2)}`;
      } else {
        priceHtml = `${celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true ? '<s style="opacity:.5;font-size:.8em">RM '+item.basePrice.toFixed(2)+'</s> ' : ''}RM ${displayPrice.toFixed(2)}`;
      }

      html += `<div class="menu-item${item.isPinned ? ' menu-item-pinned' : ''}${soldOut ? ' sold-out' : ''}" data-id="${item.id}">`;

      // Top row: image + info (name, tagline, description, price, stock)
      html += `<div class="menu-item-header">`;
      if (slug) {
        html += `<img class="menu-item-img" src="img/menu/${slug}.png" alt="" loading="lazy" onerror="this.style.display='none'">`;
      }
      html += `<div class="menu-item-info">`;
      html += `<div class="item-name">${item.isPinned ? '⭐ ' : ''}${displayName}</div>`;
      if (tagline) {
        html += `<p class="menu-item-desc">${tagline}</p>`;
      }
      if (item.description) {
        html += `<div class="item-description">${item.description}</div>`;
      }
      html += `<div class="item-price">${priceHtml}</div>`;
      if (item.category === 'FOOD' && avail !== Infinity) {
        html += `<div class="item-stock">${soldOut ? 'Sold out' : avail + ' left'}</div>`;
      }
      html += `</div></div>`; // /info /header

      // Middle row: variant pickers (full-width, separated by top border).
      // On a pre-order link, options the campaign excludes are stripped first so
      // the customer never sees a choice the backend would reject.
      const pickerItem = applyPreorderOptionExclusions(item);
      if ((pickerItem.variantGroups && pickerItem.variantGroups.length) ||
          (pickerItem.variants && pickerItem.variants.length)) {
        html += RLCVariants.pickerHtml(pickerItem, { itemId: item.id });
      }

      // Bottom row: qty controls (centered, separated by top border)
      html += `<div class="qty-controls">`;
      html += `<button aria-label="Decrease ${displayName}" data-action="dec" data-id="${item.id}">−</button>`;
      html += `<span aria-live="polite">${qty}</span>`;
      html += `<button aria-label="Increase ${displayName}" data-action="inc" data-id="${item.id}" ${soldOut || (avail <= qty && item.category === 'FOOD') ? 'disabled' : ''}>+</button>`;
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

  document.getElementById('returningBtn')?.addEventListener('click', showPhoneLookup);
  document.getElementById('profileLogout')?.addEventListener('click', () => {
    customerProfile = null;
    localStorage.removeItem('customerProfile');
    localStorage.removeItem('customerName');
    app.innerHTML = '';
    renderMenu();
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

  document.querySelectorAll('input[name="collectionTime"]').forEach(radio => {
    radio.addEventListener('change', e => {
      if (e.target.checked) collectionTime = e.target.value;
    });
  });

  document.getElementById('layoutToggle')?.addEventListener('click', () => {
    menuLayout = menuLayout === 'list' ? 'grid' : 'list';
    localStorage.setItem('menuLayout', menuLayout);
    document.getElementById('layoutToggle').textContent = menuLayout === 'grid' ? '☰' : '⊞';
    renderMenu();
  });
}

function bindItemEvents() {
  // Variant buttons (both new variant-groups and legacy .variants markup)
  // are wired by the shared module so the customer page and the order edit
  // page behave identically.
  const menuRoot = document.getElementById('menuItems');
  if (menuRoot && window.RLCVariants) RLCVariants.bindPicker(menuRoot);

  document.querySelectorAll('.qty-controls button').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const item = menu.find(m => m.id === id);

      if (action === 'inc') {
        const totalQty = cart.filter(c => c.id === id).reduce((s, c) => s + c.qty, 0);
        if (item.category === 'FOOD' && totalQty >= getAvailable(item)) return;

        let price, variantKey, variantLabel;
        // Gross unit price (base + variant modifiers, celebration NOT applied) —
        // what CafePricing needs as its incumbent candidate. Kept alongside
        // `price` rather than replacing it, so the non-staff cart total is
        // untouched.
        let grossPrice;
        const selectedVariants = getSelectedVariants(id);
        if (selectedVariants.length) {
          // Bug 5 fix: paid variant modifiers apply on top of celebrationPrice.
          // Celebration only replaces the base, not the variant surcharges.
          const variantExtra = selectedVariants.reduce((s, v) => s + v.price, 0);
          const basePrice = (celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true) ? celebrationPrice : item.basePrice;
          price = basePrice + variantExtra;
          grossPrice = item.basePrice + variantExtra;
          variantKey = selectedVariants.map(v => v.option).join(',');
          variantLabel = selectedVariants.map(v => v.option).join(', ');
        } else {
          const variant = getSelectedVariant(id);
          const variantObj = item.variants?.find(v => v.id === variant);
          const basePrice = (celebrationMode && item.category === 'DRINK' && item.celebrationEligible === true) ? celebrationPrice : item.basePrice;
          price = basePrice + (variantObj?.priceModifier || 0);
          grossPrice = item.basePrice + (variantObj?.priceModifier || 0);
          variantKey = variant;
          variantLabel = variantObj?.name || variant;
        }

        // No merging: every add is its own line at qty 1 so it can hold its own
        // note. The card's quantity badge sums qty across matching lines, which
        // stays correct precisely because every line is 1.
        cart.push({ id, name: stripEmoji(item.name), variant: variantKey, variantName: variantLabel, selectedVariants: selectedVariants.length ? selectedVariants : undefined, price, qty: 1, grossPrice, category: item.category, basePrice: item.basePrice, celebrationEligible: item.celebrationEligible === true });
        saveCart();
      } else {
        const selectedVariants = getSelectedVariants(id);
        const variantKey = selectedVariants.length ? selectedVariants.map(v => v.option).join(',') : getSelectedVariant(id);
        // With one line per drink there is no qty to decrement — [−] removes the
        // LAST line matching this id + variant (and with it that line's note).
        for (let n = cart.length - 1; n >= 0; n--) {
          if (cart[n].id === id && cart[n].variant === variantKey) { cart.splice(n, 1); break; }
        }
        saveCart();
      }
      renderMenu();
    });
  });
}

function updateCartBar() {
  const count = cart.reduce((s, c) => s + c.qty, 0);
  const total = cart.reduce((s, c) => s + c.qty * c.price, 0);
  // Staff mode: the net comes from CafePricing so the cart matches what the
  // backend will charge (drinks at the staff price, food untouched).
  const staffPriced = staffMode && window.CafePricing
    ? CafePricing.priceCart(cart.map(cartLineForPricing), staffPricingOpts())
    : null;
  const netTotal = staffPriced ? staffPriced.total : total;
  cartCount.textContent = `${count} item${count !== 1 ? 's' : ''}`;
  // Pre-order mode: total is always zero for the customer; show a hint.
  cartTotal.textContent = preorderMode ? 'FREE' : `RM ${netTotal.toFixed(2)}`;
  cartTotalExpanded.textContent = preorderMode
    ? 'Total: RM 0.00 (Ministry Pre-Order)'
    : staffPriced
      ? `Total: RM ${netTotal.toFixed(2)} (Staff price)`
      : `Total: RM ${total.toFixed(2)}`;
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
  // One row per drink: name, variant, an always-visible note input for THAT
  // drink, and ✕ to remove it. There are deliberately no −/+ controls — every
  // line is qty 1, so they could only ever show "1" and one of them would be a
  // dead control. Adding a second latte is a second row.
  //
  // NOTE_MAX mirrors the server's 80-char per-item cap; the server is the
  // authority and rejects anything longer with a 400.
  const NOTE_MAX = 80;
  cartItems.innerHTML = cart.map((c, i) => {
    const variantLabel = c.variantName || c.variant || '';
    const displayName = stripEmoji(c.name);
    return `<div class="cart-item">
      <div class="cart-item-main">
        <div class="cart-item-info"><div class="cart-item-name">${escHtml(displayName)}</div>${variantLabel ? `<div class="cart-item-variant">${escHtml(variantLabel)}</div>` : ''}</div>
        <div class="cart-item-actions">
          <button class="remove-btn" aria-label="Remove ${escHtml(displayName)}" data-cart-idx="${i}" data-cart-action="remove">✕</button>
        </div>
      </div>
      <input type="text" class="cart-item-note" maxlength="${NOTE_MAX}" data-cart-idx="${i}"
        placeholder="Note for this drink (e.g. less sugar)"
        aria-label="Note for ${escHtml(displayName)}" value="${escHtml(c.note || '')}">
    </div>`;
  }).join('') + `<label for="orderNotes" style="display:block;font-size:.85rem;font-weight:600;color:var(--text-light,#7A6355);margin-top:16px">Anything else about the whole order?</label><textarea id="orderNotes" placeholder="e.g. collecting for a group, please bag them together" style="width:100%;margin-top:6px;padding:10px;border:1px solid var(--cream-dark,#ddd);border-radius:8px;font-size:.9rem;resize:none;font-family:inherit;box-sizing:border-box" rows="2">${escHtml(localStorage.getItem('orderNotes') || '')}</textarea><p style="font-size:.82rem;color:var(--text-light,#7A6355);margin-top:12px;text-align:center">🏪 Pay at the counter after ordering</p>`;

  cartItems.querySelectorAll('button[data-cart-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.cartIdx);
      cart.splice(idx, 1);
      saveCart();
      renderCartPanel();
      updateCartBar();
      renderMenu();
    });
  });
  // Per-item note: update the model and persist on every keystroke, but never
  // re-render the panel — a re-render would destroy the input mid-typing and
  // lose focus and caret position. The panel is only rebuilt on add/remove.
  cartItems.querySelectorAll('.cart-item-note').forEach(input => {
    input.addEventListener('input', () => {
      const line = cart[parseInt(input.dataset.cartIdx)];
      if (!line) return;
      line.note = input.value;
      saveCart();
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

  if (preorderMode && !collectionTime) {
    showError('Please select a collection time');
    cartOverlay.classList.remove('open');
    document.querySelector('input[name="collectionTime"]')?.focus();
    return;
  }

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
    // `note` is per ITEM and omitted when empty — the backend caps it at 80
    // trimmed characters and 400s on anything longer, so it is never sent as ''.
    const items = cart.map(c => ({ menuItemId: c.id, variant: c.variant, selectedVariants: c.selectedVariants || [], quantity: c.qty, note: c.note?.trim() || undefined }));
    const orderPayload = { customerName: name, items, notes: document.getElementById('orderNotes')?.value?.trim() || '' };
    if (customerProfile?.phone) orderPayload.customerId = customerProfile.phone;
    if (preorderMode) {
      orderPayload.preorderCode = preorderCode;
      orderPayload.collectionTime = collectionTime;
    }
    // Staff link: send the code only. No collection time, and never alongside
    // preorderCode — the two modes are mutually exclusive by construction.
    if (staffMode) {
      orderPayload.staffCode = staffCode;
    }

    const res = await fetch(`${API_BASE}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayload)
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

    sessionStorage.setItem('push_offer_order', data.orderId);

    if (!customerProfile) {
      showRegistrationPrompt(data.orderId);
    } else {
      window.location.href = `track?id=${data.orderId}`;
    }
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

/**
 * Ask one validate endpoint about a code without throwing.
 *
 * Both endpoints answer 400 with `{ valid:false, reason }` for a code they don't
 * recognise, and apiFetch rejects on any non-2xx — which would lose the reason
 * and (before staff links existed) made every staff code look like a dead
 * pre-order link. Network failures come back as reason 'error'.
 */
async function validateLinkCode(path, code) {
  try {
    const res = await fetch(`${API_BASE}${path}?code=${encodeURIComponent(code)}`);
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty/HTML body — treat as invalid */ }
    if (res.ok && data && data.valid) return { valid: true, data };
    return { valid: false, reason: (data && data.reason) || 'invalid' };
  } catch (e) {
    return { valid: false, reason: 'error' };
  }
}

async function init() {
  try {
    // One ?code= param, two namespaces. Pre-order codes are checked first so
    // existing links behave exactly as before; only a code the pre-order
    // namespace does not recognise is tried as a staff code.
    if (_preorderCodeParam) {
      const pre = await validateLinkCode('/api/preorder/validate', _preorderCodeParam);
      if (pre.valid) {
        preorderMode = true;
        preorderCode = _preorderCodeParam.trim().toUpperCase();
        preorderInfo = pre.data;
        menuCategory = 'DRINK';
      } else if (pre.reason === 'expired' || pre.reason === 'not_yet') {
        // A real pre-order code, just outside its window — same message as before.
        showError('This pre-order link is no longer valid');
      } else {
        const st = await validateLinkCode('/api/staff-code/validate', _preorderCodeParam);
        if (st.valid) {
          staffMode = true;
          // The endpoint returns the canonical uppercased code, so ?code=staff
          // and ?code=STAFF both submit the same value.
          staffCode = st.data.code || _preorderCodeParam.trim().toUpperCase();
          staffInfo = st.data;
        } else if (st.reason === 'not_yet') {
          showError('This staff link is not active yet');
        } else if (st.reason === 'expired') {
          showError('This staff link has expired');
        } else {
          showError('This pre-order link is no longer valid');
        }
      }
    }

    const status = await apiFetch('/api/cafe/status');
    queueSize = status.queueSize || 0;
    celebrationMode = status.celebrationMode || false;
    celebrationPrice = status.celebrationPrice || 5;
    featuredDrink = status.featuredDrink || null;
    // Pre-order bypass: skip the café-closed lockout so ministry volunteers
    // can order ahead of Sunday service.
    if (!preorderMode && status.cafeStatus === 'CLOSED') {
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
    cart = cart.filter(c => {
      const m = menu.find(i => i.id === c.id);
      if (!m || !m.isActive || !m.isEnabledToday) return false;
      // In pre-order mode, drop any FOOD leftovers from a prior session.
      if (preorderMode && m.category !== 'DRINK') return false;
      return true;
    });
    if (cart.length !== prevLen) saveCart();
    renderMenu();
  } catch (e) {
    showError('Connection error, retrying...');
    setTimeout(init, 3000);
  }
}

function showPhoneLookup() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(61,43,31,.6);backdrop-filter:blur(4px);z-index:400;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `<div style="background:#fff;border-radius:var(--radius-xl,16px);padding:28px 24px;width:90%;max-width:340px;box-shadow:0 8px 24px rgba(74,44,23,.15)">
    <h3 style="color:var(--primary,#6B4226);margin-bottom:8px">Welcome back!</h3>
    <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin-bottom:16px">Enter your phone number to load your profile</p>
    <input id="phoneLookupInput" type="tel" placeholder="e.g. 0121234567" style="width:100%;padding:14px 16px;border:2px solid var(--accent-light,#E8C9A0);border-radius:12px;font-size:1rem;background:var(--cream,#FFF8F0)" autofocus>
    <div id="phoneLookupError" style="color:var(--danger,#C0392B);font-size:.85rem;margin-top:8px;display:none"></div>
    <button id="phoneLookupBtn" style="width:100%;padding:14px;margin-top:14px;background:linear-gradient(135deg,var(--primary,#6B4226),var(--primary-light,#8B5E3C));color:#fff;border:none;border-radius:12px;font-size:1.05rem;font-weight:700;cursor:pointer">Find My Profile</button>
    <button id="phoneLookupCancel" style="width:100%;padding:10px;margin-top:8px;background:none;border:none;color:var(--text-light,#7A6355);font-size:.9rem;cursor:pointer">Continue as guest</button>
  </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#phoneLookupInput');
  const btn = overlay.querySelector('#phoneLookupBtn');
  const errEl = overlay.querySelector('#phoneLookupError');
  const cancel = overlay.querySelector('#phoneLookupCancel');
  input.focus();

  async function doLookup() {
    const phone = normalizePhone(input.value);
    if (!phone) { errEl.textContent = 'Please enter a valid Malaysian phone number'; errEl.style.display = 'block'; return; }
    btn.disabled = true; btn.textContent = 'Looking up...';
    try {
      const res = await fetch(`${API_BASE}/api/customers/${phone}`);
      if (res.status === 404) { errEl.textContent = 'No profile found. Order as guest and register after!'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Find My Profile'; return; }
      if (!res.ok) throw new Error();
      const data = await res.json();
      customerProfile = data;
      localStorage.setItem('customerProfile', JSON.stringify(data));
      localStorage.setItem('customerName', data.name);
      overlay.remove();
      app.innerHTML = '';
      renderMenu();
    } catch { errEl.textContent = 'Connection error, try again'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Find My Profile'; }
  }

  btn.onclick = doLookup;
  input.onkeydown = e => { if (e.key === 'Enter') doLookup(); };
  cancel.onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
}

function showRegistrationPrompt(orderId) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(61,43,31,.6);backdrop-filter:blur(4px);z-index:400;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `<div style="background:#fff;border-radius:var(--radius-xl,16px);padding:28px 24px;width:90%;max-width:340px;box-shadow:0 8px 24px rgba(74,44,23,.15)">
    <h3 style="color:var(--primary,#6B4226);margin-bottom:4px">Save your profile?</h3>
    <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin-bottom:16px">Faster ordering next time + earn rewards 🎁</p>
    <input id="regPhone" type="tel" placeholder="Phone number (e.g. 0121234567)" style="width:100%;padding:14px 16px;border:2px solid var(--accent-light,#E8C9A0);border-radius:12px;font-size:1rem;background:var(--cream,#FFF8F0);margin-bottom:10px">
    <input id="regBirthday" type="text" placeholder="Birthday (MM-DD, optional)" style="width:100%;padding:14px 16px;border:2px solid var(--accent-light,#E8C9A0);border-radius:12px;font-size:1rem;background:var(--cream,#FFF8F0)">
    <div id="regError" style="color:var(--danger,#C0392B);font-size:.85rem;margin-top:8px;display:none"></div>
    <button id="regSubmit" style="width:100%;padding:14px;margin-top:14px;background:linear-gradient(135deg,var(--primary,#6B4226),var(--primary-light,#8B5E3C));color:#fff;border:none;border-radius:12px;font-size:1.05rem;font-weight:700;cursor:pointer">Save Profile</button>
    <button id="regSkip" style="width:100%;padding:10px;margin-top:8px;background:none;border:none;color:var(--text-light,#7A6355);font-size:.9rem;cursor:pointer">Maybe later</button>
  </div>`;
  document.body.appendChild(overlay);

  const phoneInput = overlay.querySelector('#regPhone');
  const birthdayInput = overlay.querySelector('#regBirthday');
  const btn = overlay.querySelector('#regSubmit');
  const errEl = overlay.querySelector('#regError');
  const skip = overlay.querySelector('#regSkip');
  phoneInput.focus();

  async function doRegister() {
    const phone = normalizePhone(phoneInput.value);
    if (!phone) { errEl.textContent = 'Please enter a valid Malaysian phone number'; errEl.style.display = 'block'; return; }
    const birthday = birthdayInput.value.trim();
    if (birthday && !/^\d{2}-\d{2}$/.test(birthday)) { errEl.textContent = 'Birthday format: MM-DD (e.g. 03-15)'; errEl.style.display = 'block'; return; }

    btn.disabled = true; btn.textContent = 'Saving...';
    const name = localStorage.getItem('customerName') || 'Guest';
    try {
      const res = await fetch(`${API_BASE}/api/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name, birthday: birthday || undefined, orderId })
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed'); }
      customerProfile = { phone, name, birthday, orderCount: 1, totalSpent: 0 };
      localStorage.setItem('customerProfile', JSON.stringify(customerProfile));
      overlay.remove();
      window.location.href = `track?id=${orderId}`;
    } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Save Profile'; }
  }

  btn.onclick = doRegister;
  phoneInput.onkeydown = e => { if (e.key === 'Enter') birthdayInput.focus(); };
  birthdayInput.onkeydown = e => { if (e.key === 'Enter') doRegister(); };
  skip.onclick = () => { overlay.remove(); window.location.href = `track?id=${orderId}`; };
  overlay.onclick = e => { if (e.target === overlay) { overlay.remove(); window.location.href = `track?id=${orderId}`; } };
}

init();
