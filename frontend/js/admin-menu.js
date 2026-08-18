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

// Persisted across re-renders so a toggle-active click (which reloads the
// menu list) doesn't reset the operator's filter selection.
let menuCategoryFilter = 'ALL';   // ALL | DRINK | FOOD
let menuStatusFilter   = 'ALL';   // ALL | ACTIVE | INACTIVE

function renderMenuSection(container, items){
  const filteredItems = items.filter(item => {
    if (menuCategoryFilter !== 'ALL' && item.category !== menuCategoryFilter) return false;
    const isActive = item.isActive !== false;
    if (menuStatusFilter === 'ACTIVE'   && !isActive) return false;
    if (menuStatusFilter === 'INACTIVE' &&  isActive) return false;
    return true;
  });

  const drinkCount   = items.filter(i => i.category === 'DRINK').length;
  const foodCount    = items.filter(i => i.category === 'FOOD').length;
  const activeCount  = items.filter(i => i.isActive !== false).length;
  const inactiveCount = items.length - activeCount;

  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Menu Items</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddMenu">+ Add Item</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <button class="pos-btn pos-btn-sm" id="btnEnableDrinks">✅ Enable All Drinks</button>
      <button class="pos-btn pos-btn-sm" id="btnEnableFood">✅ Enable All Food</button>
      <button class="pos-btn pos-btn-sm pos-btn-danger" id="btnDisableAll">❌ Disable All</button>
    </div>
    <div class="admin-filter-row">
      <span class="admin-filter-label">Category</span>
      <button class="pos-btn pos-btn-sm ${menuCategoryFilter==='ALL'?'pos-btn-primary':''}"   data-menu-cat="ALL">All (${items.length})</button>
      <button class="pos-btn pos-btn-sm ${menuCategoryFilter==='DRINK'?'pos-btn-primary':''}" data-menu-cat="DRINK">🥤 Drinks Only (${drinkCount})</button>
      <button class="pos-btn pos-btn-sm ${menuCategoryFilter==='FOOD'?'pos-btn-primary':''}"  data-menu-cat="FOOD">🍔 Foods Only (${foodCount})</button>
    </div>
    <div class="admin-filter-row" style="margin-bottom:16px">
      <span class="admin-filter-label">Status</span>
      <button class="pos-btn pos-btn-sm ${menuStatusFilter==='ALL'?'pos-btn-primary':''}"      data-menu-status="ALL">All</button>
      <button class="pos-btn pos-btn-sm ${menuStatusFilter==='ACTIVE'?'pos-btn-primary':''}"   data-menu-status="ACTIVE">✅ Enabled Only (${activeCount})</button>
      <button class="pos-btn pos-btn-sm ${menuStatusFilter==='INACTIVE'?'pos-btn-primary':''}" data-menu-status="INACTIVE">❌ Disabled Only (${inactiveCount})</button>
    </div>`;
  if(!items.length){
    html += '<div class="admin-empty"><p>No menu items yet</p></div>';
  } else if (!filteredItems.length){
    html += `<div class="admin-empty"><p>No items match the current filters.<br><button class="pos-btn pos-btn-sm" id="menuFilterReset" style="margin-top:8px">Reset filters</button></p></div>`;
  } else {
    filteredItems.forEach(item=>{
      const badge = item.category === 'DRINK' ? 'badge-drink' : 'badge-food';
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
      const isActive = item.isActive !== false;
      const id = item.menuItemId || item.id;
      html += `<div class="admin-card ${isActive?'':'is-disabled'}">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${escapeHtml(item.name)}</div>
            <div class="admin-card-subtitle">RM ${(item.basePrice||0).toFixed(2)}${variants ? ' · '+escapeHtml(variants) : ''}</div>
          </div>
          <div class="admin-card-actions">
            <span class="admin-card-badge ${badge}">${escapeHtml(item.category)}</span>
            ${item.category==='DRINK' ? `<span class="admin-card-badge ${item.celebrationEligible===true?'badge-active':'badge-inactive'}">${item.celebrationEligible===true?'🎉 RM5':'No 🎉'}</span>` : ''}
            ${isActive ? '' : '<span class="admin-card-badge badge-disabled">Disabled</span>'}
            <label class="toggle-switch" title="${isActive?'Click to disable':'Click to enable'}">
              <input type="checkbox" data-toggle-menu="${escapeAttr(id)}" ${isActive?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
            <button class="pos-btn pos-btn-sm" data-edit-menu="${escapeAttr(id)}">Edit</button>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-menu="${escapeAttr(id)}">Delete</button>
          </div>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;

  $('#btnAddMenu').onclick = ()=> openMenuForm(container, null, items);
  $('#btnEnableDrinks').onclick = async()=>{ try{ await api('PUT','/api/admin/menu/bulk-toggle',{enable:true,category:'DRINK'}); loadMenu(container); }catch(e){ showError('Failed'); } };
  $('#btnEnableFood').onclick = async()=>{ try{ await api('PUT','/api/admin/menu/bulk-toggle',{enable:true,category:'FOOD'}); loadMenu(container); }catch(e){ showError('Failed'); } };
  $('#btnDisableAll').onclick = async()=>{ try{ await api('PUT','/api/admin/menu/bulk-toggle',{enable:false}); loadMenu(container); }catch(e){ showError('Failed'); } };

  container.querySelectorAll('[data-menu-cat]').forEach(btn=>{
    btn.onclick = ()=>{
      menuCategoryFilter = btn.dataset.menuCat;
      renderMenuSection(container, items);
    };
  });
  container.querySelectorAll('[data-menu-status]').forEach(btn=>{
    btn.onclick = ()=>{
      menuStatusFilter = btn.dataset.menuStatus;
      renderMenuSection(container, items);
    };
  });
  const resetBtn = container.querySelector('#menuFilterReset');
  if (resetBtn) resetBtn.onclick = ()=>{
    menuCategoryFilter = 'ALL';
    menuStatusFilter = 'ALL';
    renderMenuSection(container, items);
  };

  container.querySelectorAll('[data-toggle-menu]').forEach(input=>{
    input.onchange = async()=>{
      const id = input.dataset.toggleMenu;
      // Optimistically disable to prevent double-click
      input.disabled = true;
      try{
        await api('PUT',`/api/admin/menu/${id}/toggle-active`, {});
        loadMenu(container);
      } catch(e){
        showError('Toggle failed');
        input.checked = !input.checked;
        input.disabled = false;
      }
    };
  });
  container.querySelectorAll('[data-edit-menu]').forEach(btn=>{
    btn.onclick=()=>{ const item=items.find(i=>(i.menuItemId||i.id)===btn.dataset.editMenu); openMenuForm(container, item, items); };
  });
  container.querySelectorAll('[data-del-menu]').forEach(btn=>{
    btn.onclick=async()=>{
      if(!confirm('Delete this menu item?')) return;
      try{ await api('DELETE',`/api/admin/menu/${btn.dataset.delMenu}`); loadMenu(container); } catch(e){ showError('Delete failed'); }
    };
  });
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

