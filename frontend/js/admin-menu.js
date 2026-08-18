// admin-menu.js — Menu CRUD, filters, toggle
// Depends on: admin.js (api, showError, showFormModal, $, escapeHtml, escapeAttr)

// --- Menu Management ---
async function loadMenu(container){
  container.innerHTML = '<div class="loading">Loading menu...</div>';
  try{
    // Use admin endpoint so we see inactive items too
    const data = await api('GET','/api/admin/menu');
    const items = (Array.isArray(data) ? data : data.items || []);
    renderMenuSection(container, items);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load menu</p></div>'; }
}

// Persisted across re-renders so a toggle click (which reloads the menu list)
// doesn't reset the operator's filter selection.
let menuCategoryFilter = 'ALL';   // ALL | DRINK | FOOD
let menuStateFilter    = 'ALL';   // ALL | TODAY | NOT_TODAY | OFF_MENU

/**
 * TWO FLAGS, NAMED, on every row.
 *
 * This screen edits two different things with two different lifetimes:
 *
 *   isActive        "On the menu"   — the permanent catalogue. Survives the day.
 *                                     PUT /api/admin/menu/{id}/toggle-active
 *   isEnabledToday  "Serving today" — reset every service by the cashier.
 *                                     PUT /api/pos/menu/{id}/toggle
 *
 * It used to edit BOTH with one visual language and DRAW only the first: the
 * row switch wrote `isActive`, the three bulk buttons wrote `isEnabledToday`,
 * and every badge, count, filter and grey-out rendered `isActive` alone. So
 * "❌ Disable All" silently changed all 33 items with no confirmation, no toast
 * and not one pixel of visible difference; "Enabled Only (32)" counted
 * catalogue items, which an operator reasonably read as "32 are being served
 * today"; and an item could be `isActive:true` yet invisible to customers with
 * nothing on the screen able to say why.
 *
 * Both flags are read with `=== true`, not `!== false`, because that is what
 * decides whether a customer can order the item: `GET /api/menu` filters
 * `isActive = true AND isEnabledToday = true`, so a record MISSING either
 * attribute is invisible to customers and must not be drawn as available here.
 */
const onTheMenu   = item => item.isActive === true;
const servingNow  = item => item.isActive === true && item.isEnabledToday === true;
const offForToday = item => item.isActive === true && item.isEnabledToday !== true;

function menuItemState(item){
  if(!onTheMenu(item)) return 'OFF_MENU';
  return servingNow(item) ? 'TODAY' : 'NOT_TODAY';
}

/** One row: the item, both flags, and the reason it is or is not orderable. */
function menuRowHtml(item){
  const state = menuItemState(item);
  const id = item.menuItemId || item.id;
  // Summarise the live option groups, e.g. "Temperature: Hot/Iced".
  // This line previously read only the legacy flat `variants` array, so
  // every drink on the menu showed nothing — none of them use it.
  // Both summaries stay PLAIN TEXT and are escaped once where they are
  // interpolated below — so a group or option name containing < or " cannot
  // reach innerHTML raw.
  const groupSummary = (item.variantGroups||[])
    .map(g => `${g.group}: ${(g.options||[]).map(o=>o.name).join('/')}`)
    .join(' · ');
  const legacySummary = (item.variants||[]).map(v=>v.name||v).join(', ');
  const variants = groupSummary || legacySummary;
  // Celebration eligibility rides in the meta line rather than as a badge. The
  // "No 🎉" badge it replaces sat on a danger tint, so an ordinary
  // full-price drink read as an error — and the two badges beside it (category,
  // eligibility) crowded the item NAME into an ellipsis at 1024px. The category
  // badge is gone entirely: the rows are grouped under a category header now,
  // so it repeated the heading eight rows above it.
  const meta = `RM ${(item.basePrice||0).toFixed(2)}`
    + (variants ? ` · ${variants}` : '')
    + (item.celebrationEligible === true ? ' · 🎉 RM5 on celebration day' : '');

  const pill = state === 'OFF_MENU'
    ? '<span class="admin-pill admin-pill-shelved">Off the menu</span>'
    : state === 'TODAY'
      ? '<span class="admin-pill admin-pill-live">Serving today</span>'
      : '<span class="admin-pill admin-pill-off">Not today</span>';

  // The cashier sets these in the POS; showing them here explains why a food
  // item that is switched on can still be unavailable.
  const qty = (item.category === 'FOOD' && state === 'TODAY')
    ? `<span class="admin-pill admin-pill-qty">${Number(item.foodQuantityToday||0)} left${
        Number(item.foodReserved||0) ? ` · ${Number(item.foodReserved)} reserved` : ''}</span>`
    : '';

  // The whole point of naming the flags: say why an item nobody can order is
  // nevertheless sitting in the catalogue.
  const why = state === 'OFF_MENU'
    ? '<div class="admin-row-why">Off the menu entirely — put it back before it can be served.</div>'
    : state === 'NOT_TODAY'
      ? '<div class="admin-row-why">On the menu, but not being served today — customers cannot order it.</div>'
      : '';

  return `<div class="admin-card admin-menu-row ${state === 'OFF_MENU' ? 'is-disabled' : ''}">
    <div class="admin-card-header">
      <div class="admin-card-id">
        <div class="admin-card-title" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</div>
        <div class="admin-card-subtitle" title="${escapeAttr(meta)}">${escapeHtml(meta)}</div>
        ${why}
      </div>
      <div class="admin-card-actions">
        ${qty}
        ${pill}
        <span class="admin-sw">
          <label class="toggle-switch" title="${onTheMenu(item)?'On the menu — switch off to remove it from the catalogue':'Off the menu — switch on to put it back'}">
            <input type="checkbox" data-toggle-active="${escapeAttr(id)}"
              aria-label="Keep ${escapeAttr(item.name)} on the menu" ${onTheMenu(item)?'checked':''}>
            <span class="toggle-slider"></span>
          </label>
          <span class="admin-sw-cap">On menu</span>
        </span>
        <span class="admin-sw">
          <label class="toggle-switch" title="${onTheMenu(item)
            ? (servingNow(item) ? 'Being served today — switch off to stop for today only' : 'Not being served today — switch on to serve it')
            : 'Put it back on the menu first'}">
            <input type="checkbox" data-toggle-today="${escapeAttr(id)}"
              aria-label="Serve ${escapeAttr(item.name)} today"
              ${servingNow(item)?'checked':''} ${onTheMenu(item)?'':'disabled'}>
            <span class="toggle-slider"></span>
          </label>
          <span class="admin-sw-cap${onTheMenu(item)?'':' is-off'}">Today</span>
        </span>
        <button class="pos-btn pos-btn-sm" data-edit-menu="${escapeAttr(id)}">Edit</button>
        <button class="pos-btn pos-btn-sm admin-danger-quiet" data-del-menu="${escapeAttr(id)}">Delete</button>
      </div>
    </div>
  </div>`;
}

function renderMenuSection(container, items){
  const filteredItems = items.filter(item => {
    if (menuCategoryFilter !== 'ALL' && item.category !== menuCategoryFilter) return false;
    if (menuStateFilter !== 'ALL' && menuItemState(item) !== menuStateFilter) return false;
    return true;
  });

  const drinkCount = items.filter(i => i.category === 'DRINK').length;
  const foodCount  = items.filter(i => i.category === 'FOOD').length;
  // Counts say WHICH flag they count. All three are over the whole menu; the
  // "Showing" line below the filters is the one that follows the filters.
  const servingCount  = items.filter(servingNow).length;
  const notTodayCount = items.filter(offForToday).length;
  const offMenuCount  = items.filter(i => !onTheMenu(i)).length;

  const chip = (on) => `pos-btn pos-btn-sm ${on ? 'pos-btn-primary' : ''}`;

  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>🍽️ Menu</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddMenu">+ Add Item</button>
    </div>
    <p class="admin-form-hint" style="margin:-8px 0 14px;max-width:70ch">Two separate things:
      whether an item is <strong>on the menu at all</strong>, and whether it is
      <strong>being served today</strong>. Customers only see an item when both are on.</p>

    <div class="admin-daystrip">
      <span class="dash-live-title">${escapeHtml(mytDayLabel(mytToday()))}</span>
      <div class="dash-live-metrics">
        <div class="dash-live-metric"><span class="dash-live-value">${servingCount}</span><span class="dash-live-label">serving today</span></div>
        <div class="dash-live-metric"><span class="dash-live-value">${notTodayCount}</span><span class="dash-live-label">on the menu, off today</span></div>
        <div class="dash-live-metric"><span class="dash-live-value">${offMenuCount}</span><span class="dash-live-label">off the menu</span></div>
      </div>
    </div>

    <div class="admin-bulk">
      <div class="admin-bulk-row">
        <span class="admin-bulk-label">Serve today</span>
        <button class="pos-btn pos-btn-sm" data-bulk="on:DRINK">🥤 All drinks</button>
        <button class="pos-btn pos-btn-sm" data-bulk="on:FOOD">🍔 All food</button>
        <button class="pos-btn pos-btn-sm" data-bulk="on:">Everything</button>
      </div>
      <div class="admin-bulk-row">
        <span class="admin-bulk-label">Stop serving today</span>
        <button class="pos-btn pos-btn-sm admin-danger-quiet" data-bulk="off:DRINK">🥤 All drinks</button>
        <button class="pos-btn pos-btn-sm admin-danger-quiet" data-bulk="off:FOOD">🍔 All food</button>
        <button class="pos-btn pos-btn-sm admin-danger-quiet" data-bulk="off:">Everything</button>
      </div>
      <p class="admin-bulk-hint">These six change the <strong>Today</strong> switch only. The catalogue is
        untouched — an item taken off the menu stays off.</p>
    </div>

    <div class="admin-filter-row">
      <span class="admin-filter-label">Category</span>
      <button class="${chip(menuCategoryFilter==='ALL')}"   data-menu-cat="ALL">All (${items.length})</button>
      <button class="${chip(menuCategoryFilter==='DRINK')}" data-menu-cat="DRINK">🥤 Drinks (${drinkCount})</button>
      <button class="${chip(menuCategoryFilter==='FOOD')}"  data-menu-cat="FOOD">🍔 Food (${foodCount})</button>
    </div>
    <div class="admin-filter-row">
      <span class="admin-filter-label">State</span>
      <button class="${chip(menuStateFilter==='ALL')}"       data-menu-state="ALL">All</button>
      <button class="${chip(menuStateFilter==='TODAY')}"     data-menu-state="TODAY">Serving today (${servingCount})</button>
      <button class="${chip(menuStateFilter==='NOT_TODAY')}" data-menu-state="NOT_TODAY">Not today (${notTodayCount})</button>
      <button class="${chip(menuStateFilter==='OFF_MENU')}"  data-menu-state="OFF_MENU">Off the menu (${offMenuCount})</button>
    </div>`;

  if(!items.length){
    html += '<div class="admin-empty"><p>No menu items yet</p></div>';
  } else if (!filteredItems.length){
    html += `<div class="admin-empty">
      <p>No items match <strong>${escapeHtml(filterDescription())}</strong>.</p>
      <button class="pos-btn pos-btn-sm" id="menuFilterReset">Show every item</button>
    </div>`;
  } else {
    html += `<p class="admin-count-line">Showing <strong>${filteredItems.length}</strong> item${filteredItems.length===1?'':'s'}
      · <strong>${filteredItems.filter(onTheMenu).length}</strong> on the menu
      · <strong>${filteredItems.filter(servingNow).length}</strong> serving today</p>`;

    // Drinks and food interleave by sortOrder in one flat list, so group them
    // under sticky headers rather than making the operator scan for the badge.
    for (const [category, label] of [['DRINK','🥤 Drinks'], ['FOOD','🍔 Food']]) {
      const group = filteredItems.filter(i => i.category === category);
      if (!group.length) continue;
      html += `<div class="admin-group-head">
        <span>${label}</span>
        <span class="admin-group-n">${group.filter(servingNow).length} of ${group.length} serving today</span>
      </div>`;
      html += group.map(menuRowHtml).join('');
    }
    // Anything with an unexpected category still has to be reachable.
    const other = filteredItems.filter(i => i.category !== 'DRINK' && i.category !== 'FOOD');
    if (other.length) {
      html += `<div class="admin-group-head"><span>Uncategorised</span>
        <span class="admin-group-n">${other.length} item${other.length===1?'':'s'}</span></div>`;
      html += other.map(menuRowHtml).join('');
    }
  }
  html += '</div>';
  container.innerHTML = html;

  $('#btnAddMenu').onclick = ()=> openMenuForm(container, null, items);

  container.querySelectorAll('[data-bulk]').forEach(btn=>{
    const [dir, category] = btn.dataset.bulk.split(':');
    btn.onclick = ()=> bulkSetServingToday(container, items, dir === 'on', category || null);
  });

  container.querySelectorAll('[data-menu-cat]').forEach(btn=>{
    btn.onclick = ()=>{
      menuCategoryFilter = btn.dataset.menuCat;
      renderMenuSection(container, items);
    };
  });
  container.querySelectorAll('[data-menu-state]').forEach(btn=>{
    btn.onclick = ()=>{
      menuStateFilter = btn.dataset.menuState;
      renderMenuSection(container, items);
    };
  });
  const resetBtn = container.querySelector('#menuFilterReset');
  if (resetBtn) resetBtn.onclick = ()=>{
    menuCategoryFilter = 'ALL';
    menuStateFilter = 'ALL';
    renderMenuSection(container, items);
  };

  // "On menu" — the permanent catalogue flag.
  container.querySelectorAll('[data-toggle-active]').forEach(input=>{
    input.onchange = ()=> runRowToggle(container, input,
      `/api/admin/menu/${input.dataset.toggleActive}/toggle-active`);
  });
  // "Today" — the per-service flag. Deliberately the SAME endpoint the POS
  // uses, because that one also flags PENDING orders containing the item when
  // it goes off; writing isEnabledToday through the generic admin PUT would
  // skip that and strand orders the barista can no longer make.
  container.querySelectorAll('[data-toggle-today]').forEach(input=>{
    input.onchange = ()=> runRowToggle(container, input,
      `/api/pos/menu/${input.dataset.toggleToday}/toggle`);
  });

  container.querySelectorAll('[data-edit-menu]').forEach(btn=>{
    btn.onclick=()=>{ const item=items.find(i=>(i.menuItemId||i.id)===btn.dataset.editMenu); openMenuForm(container, item, items); };
  });
  container.querySelectorAll('[data-del-menu]').forEach(btn=>{
    btn.onclick=async()=>{
      const item = items.find(i=>(i.menuItemId||i.id)===btn.dataset.delMenu);
      const name = (item && item.name) || 'this item';
      // Names the item, and names the alternative — most "deletes" here only
      // meant "not today", and one of these sits on every one of 33 rows.
      if(!confirm(`Delete "${name}" permanently?\n\nThis removes the item, its price and its option groups from the catalogue. `
        + `To stop serving it just for today, switch "Today" off instead.`)) return;
      try{
        await api('DELETE',`/api/admin/menu/${btn.dataset.delMenu}`);
        showSuccess(`"${name}" deleted`);
        loadMenu(container);
      } catch(e){ showError(`Could not delete "${name}"`); }
    };
  });
}

/** Human description of the active filters, for the empty state. */
function filterDescription(){
  const cat = { ALL:'', DRINK:'drinks', FOOD:'food' }[menuCategoryFilter] || '';
  const state = {
    ALL:'', TODAY:'serving today', NOT_TODAY:'on the menu but not today', OFF_MENU:'off the menu',
  }[menuStateFilter] || '';
  if (cat && state) return `${cat} ${state}`;
  return cat || state || 'these filters';
}

/**
 * One row switch → one request → reload.
 *
 * The checkbox is disabled while in flight (a double tap used to send two
 * toggles, which for a toggle endpoint means landing back where you started),
 * and reverted in place on failure so the row never shows a state the server
 * did not accept.
 */
async function runRowToggle(container, input, path){
  input.disabled = true;
  try{
    await api('PUT', path, {});
    loadMenu(container);
  } catch(e){
    showError('Could not change that — nothing was saved');
    input.checked = !input.checked;
    input.disabled = false;
  }
}

/**
 * Bulk day-flag change. Confirms in the destructive direction and always says
 * what happened afterwards.
 *
 * The old "❌ Disable All" was a single unconfirmed press that set the day flag
 * on every item, drew no change at all, and needed TWO presses to undo (drinks,
 * then food). Both directions now take a category, so every one of these has a
 * one-press inverse sitting directly above or below it.
 */
async function bulkSetServingToday(container, items, enable, category){
  // The endpoint matches on category alone, so this is exactly its scope —
  // including items that are off the menu, whose day flag changes invisibly.
  const affected = items.filter(i => !category || i.category === category);
  const scope = category === 'DRINK' ? 'drink' : category === 'FOOD' ? 'food item' : 'item';
  const n = affected.length;
  const visible = affected.filter(servingNow).length;

  // Naming the number ALREADY off is the honest case the old button hid: it
  // reported nothing, changed nothing visible, and left the operator guessing.
  const effect = visible === 0
    ? `Nothing is being served today, so this changes nothing that customers can see.`
    : `${visible} ${visible === 1 ? 'item is' : 'items are'} being served right now and will stop, `
      + `so customers cannot order ${visible === 1 ? 'it' : 'them'} until "Today" is switched back on.`;
  if (!enable && !confirm(`Stop serving ${n} ${scope}${n === 1 ? '' : 's'} today?\n\n`
    + `${effect} Nothing is removed from the catalogue.`)) return;

  try{
    const body = { enable };
    if (category) body.category = category;
    const res = await api('PUT','/api/admin/menu/bulk-toggle', body);
    const updated = Number.isFinite(res && res.updated) ? res.updated : n;
    showSuccess(enable
      ? `Now serving ${updated} ${scope}${updated === 1 ? '' : 's'} today`
      : `Stopped serving ${updated} ${scope}${updated === 1 ? '' : 's'} today`);
    loadMenu(container);
  } catch(e){
    showError(enable ? 'Could not switch those on — nothing changed'
                     : 'Could not switch those off — nothing changed');
  }
}

/**
 * Option groups for a menu item, e.g. Temperature → Hot / Iced (+1).
 *
 * `variantGroups` is the live format every drink uses; the flat `variants`
 * array is legacy and no item on the menu still uses it. The editor used to
 * expose only `variants`, so a Latte's Hot / Iced / Oat Milk were invisible
 * here and could only be changed by running a script — and anything added
 * through the old "+ Add Variant" control went into a field the customer page
 * ignores, because variants.js prefers variantGroups whenever it is present.
 *
 * Types:
 *   single   — exactly one option must be chosen (Temperature)
 *   optional — zero or one (Oat Milk as an add-on)
 *   multi    — any number
 */
const VG_TYPES = [
  { value: 'single',   label: 'Single — must pick one' },
  { value: 'optional', label: 'Optional — can skip' },
  { value: 'multi',    label: 'Multi — pick any number' },
];

// The local `mfEsc` escaper is gone: `escapeHtml` / `escapeAttr` now live in
// admin.js, which loads before this file, so there is no ordering problem left
// to work around and one escaper to keep correct.

function openMenuForm(container, item, allItems){
  const isEdit = !!item;

  // Deep copy so Cancel genuinely discards edits rather than mutating the
  // cached menu item in place.
  let currentGroups = JSON.parse(JSON.stringify(item?.variantGroups || []));
  // Legacy flat variants, kept only so an item that still has them isn't
  // silently stripped on save. Not editable any more.
  const legacyVariants = item?.variants || [];

  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>${isEdit?'Edit':'Add'} Menu Item</h3>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Name</label><input id="mfName" class="pos-input" value="${escapeAttr(item?.name||'')}"></div>
      <div class="admin-form-group"><label>Category</label><select id="mfCategory" class="pos-input"><option value="DRINK" ${item?.category==='DRINK'?'selected':''}>Drink</option><option value="FOOD" ${item?.category==='FOOD'?'selected':''}>Food</option></select></div>
    </div>
    <div class="admin-form-group"><label>Description</label><input id="mfDesc" class="pos-input" value="${escapeAttr(item?.description||'')}" placeholder="Short description (optional)"></div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Base Price (RM)</label><input id="mfPrice" type="number" step="0.5" class="pos-input" value="${item?.basePrice||''}"></div>
      <div class="admin-form-group"><label>Sort Order</label><input id="mfSort" type="number" class="pos-input" value="${item?.sortOrder||0}"></div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Celebration Eligible</label><select id="mfCelebration" class="pos-input"><option value="false" ${item?.celebrationEligible!==true?'selected':''}>No — always normal price</option><option value="true" ${item?.celebrationEligible===true?'selected':''}>Yes — RM5 on celebration day</option></select></div>
    </div>
    <div class="admin-form-group">
      <label>Option Groups</label>
      <p class="admin-form-hint">What the customer chooses — e.g. a Temperature group with Hot and Iced (+RM1). Prices add to the base price.</p>
      <div id="vgList" class="vg-list"></div>
      <button class="pos-btn pos-btn-sm" id="btnAddGroup" style="margin-top:8px">+ Add Option Group</button>
      ${legacyVariants.length ? `<p class="admin-form-hint" style="margin-top:8px">Note: this item also has ${legacyVariants.length} old-style variant(s) (${legacyVariants.map(v=>escapeHtml(v.name||String(v))).join(', ')}). They are kept as-is; option groups above take precedence.</p>` : ''}
    </div>
    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="mfSubmit">${isEdit?'Save Changes':'Add Item'}</button>
      <button class="pos-btn" id="mfCancel">Cancel</button>
    </div>`;

  // 900px comes from showFormModal's default now — no per-form override needed.
  showFormModal(form);

  /**
   * Repaint the whole group list.
   *
   * Inputs are re-created on every change, so each handler writes to
   * `currentGroups` and only re-renders when the STRUCTURE changes (a group or
   * option added/removed). Typing updates the model without a repaint, which
   * would otherwise steal focus mid-word.
   */
  function refreshGroups(){
    const list = form.querySelector('#vgList');
    if (!currentGroups.length) {
      list.innerHTML = '<p class="admin-form-hint">No option groups — the customer just adds this item as-is.</p>';
      return;
    }

    list.innerHTML = currentGroups.map((g, gi) => {
      const opts = (g.options || []).map((o, oi) => `
        <div class="vg-option-row">
          <input class="pos-input" placeholder="Option name (e.g. Iced)" value="${escapeAttr(o.name)}" data-gi="${gi}" data-oi="${oi}" data-of="name">
          <input class="pos-input" type="number" step="0.5" placeholder="+RM" value="${Number(o.price || 0)}" data-gi="${gi}" data-oi="${oi}" data-of="price" aria-label="Extra price">
          <button class="remove-variant" data-rm-opt="${gi}:${oi}" aria-label="Remove option">✕</button>
        </div>`).join('');

      return `<div class="vg-group">
        <div class="vg-group-head">
          <input class="pos-input" placeholder="Group name (e.g. Temperature)" value="${escapeAttr(g.group)}" data-gi="${gi}" data-gf="group" aria-label="Group name">
          <select class="pos-input" data-gi="${gi}" data-gf="type" aria-label="Selection type">
            ${VG_TYPES.map(t=>`<option value="${t.value}" ${(g.type||'single')===t.value?'selected':''}>${t.label}</option>`).join('')}
          </select>
          <button class="pos-btn pos-btn-sm" data-rm-group="${gi}" aria-label="Remove group">Remove group</button>
        </div>
        <div class="vg-options">${opts || '<p class="admin-form-hint">No options yet.</p>'}</div>
        <button class="pos-btn pos-btn-sm" data-add-opt="${gi}" style="margin-top:6px">+ Add Option</button>
      </div>`;
    }).join('');

    // Text/number/select edits mutate the model in place — no re-render, so
    // the caret stays where the admin is typing.
    list.querySelectorAll('[data-gf]').forEach(el=>{
      const handler = () => {
        const g = currentGroups[+el.dataset.gi];
        if (g) g[el.dataset.gf] = el.value;
      };
      if (el.tagName === 'SELECT') el.onchange = handler; else el.oninput = handler;
    });
    list.querySelectorAll('[data-of]').forEach(inp=>inp.oninput=()=>{
      const g = currentGroups[+inp.dataset.gi];
      const o = g && g.options[+inp.dataset.oi];
      if (!o) return;
      o[inp.dataset.of] = inp.dataset.of === 'price' ? (+inp.value || 0) : inp.value;
    });

    // Structural changes DO re-render.
    list.querySelectorAll('[data-add-opt]').forEach(btn=>btn.onclick=()=>{
      const g = currentGroups[+btn.dataset.addOpt];
      (g.options = g.options || []).push({ name: '', price: 0 });
      refreshGroups();
    });
    list.querySelectorAll('[data-rm-opt]').forEach(btn=>btn.onclick=()=>{
      const [gi, oi] = btn.dataset.rmOpt.split(':').map(Number);
      currentGroups[gi].options.splice(oi, 1);
      refreshGroups();
    });
    list.querySelectorAll('[data-rm-group]').forEach(btn=>btn.onclick=()=>{
      const gi = +btn.dataset.rmGroup;
      const name = currentGroups[gi].group || 'this group';
      if (!confirm(`Remove "${name}" and all its options?`)) return;
      currentGroups.splice(gi, 1);
      refreshGroups();
    });
  }

  form.querySelector('#btnAddGroup').onclick=()=>{
    currentGroups.push({ group: '', type: 'single', options: [{ name: '', price: 0 }] });
    refreshGroups();
  };

  refreshGroups();

  form.querySelector('#mfCancel').onclick=()=>{ form._overlay.remove(); };
  form.querySelector('#mfSubmit').onclick=async()=>{
    const body = {
      name: form.querySelector('#mfName').value.trim(),
      description: form.querySelector('#mfDesc').value.trim(),
      category: form.querySelector('#mfCategory').value,
      basePrice: +form.querySelector('#mfPrice').value,
      sortOrder: +form.querySelector('#mfSort').value,
      celebrationEligible: form.querySelector('#mfCelebration').value === 'true',
      // Drop blank rows the admin left behind, and coerce prices to numbers so
      // DynamoDB stores them as N rather than S.
      variantGroups: currentGroups
        .map(g => ({
          group: String(g.group || '').trim(),
          type: VG_TYPES.some(t => t.value === g.type) ? g.type : 'single',
          options: (g.options || [])
            .filter(o => String(o.name || '').trim())
            .map(o => ({ name: String(o.name).trim(), price: Number(o.price) || 0 })),
        }))
        .filter(g => g.group && g.options.length),
    };
    // Preserve legacy flat variants untouched rather than dropping them; the
    // PUT overwrites whatever fields it is given.
    if (legacyVariants.length) body.variants = legacyVariants;

    if(!body.name || !body.basePrice){ showError('Name and price are required'); return; }

    // Validate before saving: a half-finished group would reach the customer
    // ordering page, where a `single` group with no options blocks the item.
    for (const g of currentGroups) {
      const named = (g.options || []).filter(o => String(o.name || '').trim());
      if (!String(g.group || '').trim() && named.length) {
        showError('Every option group needs a name'); return;
      }
      if (String(g.group || '').trim() && !named.length) {
        showError(`Group "${g.group}" needs at least one option`); return;
      }
      const seen = new Set();
      for (const o of named) {
        const key = o.name.trim().toLowerCase();
        if (seen.has(key)) { showError(`"${g.group}" has duplicate option "${o.name}"`); return; }
        seen.add(key);
      }
    }
    const groupNames = body.variantGroups.map(g => g.group.toLowerCase());
    if (new Set(groupNames).size !== groupNames.length) {
      showError('Two option groups share the same name'); return;
    }
    try{
      if(isEdit) await api('PUT',`/api/admin/menu/${item.menuItemId||item.id}`, body);
      else await api('POST','/api/admin/menu', body);
      form._overlay.remove();
      loadMenu(container);
    } catch(e){ showError('Save failed'); }
  };
}

