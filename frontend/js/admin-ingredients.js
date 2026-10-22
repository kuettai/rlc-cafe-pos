// admin-ingredients.js — Ingredients + stock history
// Depends on: admin.js (api, showError, showFormModal, showSuccess, $,
//             escapeHtml, escapeAttr)

// --- Ingredients ---
async function loadIngredients(container){
  ingRearrange = null; // a fresh load always leaves Rearrange mode
  container.innerHTML = '<div class="loading">Loading ingredients...</div>';
  try{
    const [data, menuData, recipeData] = await Promise.all([
      api('GET','/api/pos/inventory'),
      api('GET','/api/menu'),
      api('GET','/api/admin/recipes')
    ]);
    const all = Array.isArray(data) ? data : data.ingredients || [];
    const items = all.filter(i => i.PK && i.PK.startsWith('INGREDIENT#') && i.SK === 'META');
    const menuItems = Array.isArray(menuData) ? menuData : menuData.items || [];
    const recipes = recipeData.recipes || [];
    renderIngredientsSection(container, items, menuItems, recipes);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load ingredients</p></div>'; }
}

let ingLocationFilter = 'ALL';
// Low Stock is a subfilter: it narrows whichever location is selected rather
// than replacing it.
let ingLowStockOnly = false;

// Rearrange mode: null when off, else { order: [ingredientId…], dirty }.
// Nothing is written until Save — drag/↑↓ only reorder this working list.
let ingRearrange = null;

// Same rule as the "Low Stock" badge: disabled ingredients are never low.
function isIngredientLow(ing){
  return ing.isActive !== false && ing.currentStock <= (ing.lowStockThreshold||0);
}

function renderIngredientsSection(container, items, menuItems, recipes){
  // Items marked BOTH appear under either Fridge or Storeroom filter (and ALL),
  // matching the POS stock-count filter behavior.
  const byLocation = ingLocationFilter === 'ALL'
    ? items
    : items.filter(i => i.storageLocation === ingLocationFilter || i.storageLocation === 'BOTH');
  const lowCount = byLocation.filter(isIngredientLow).length;
  const rearranging = !!ingRearrange;
  // Rearrange works on the WHOLE list (a filtered subset has no unambiguous
  // place in the full sequence), in the working order.
  const filtered = rearranging
    ? ingRearrange.order.map(id => items.find(i => i.ingredientId === id)).filter(Boolean)
    : (ingLowStockOnly ? byLocation.filter(isIngredientLow) : byLocation);
  const headerButtons = rearranging
    ? `<button class="pos-btn pos-btn-sm" id="btnRearrangeCancel">Cancel</button>
        <button class="pos-btn pos-btn-primary" id="btnRearrangeSave" ${ingRearrange.dirty?'':'disabled'}>Save Order</button>`
    : `<button class="pos-btn pos-btn-sm" id="btnStockHistory">📋 Stock History</button>
        <button class="pos-btn pos-btn-sm" id="btnRearrange" ${items.length < 2 ? 'disabled' : ''}>↕ Rearrange</button>
        <button class="pos-btn pos-btn-primary" id="btnAddIngredient">+ Add Ingredient</button>`;
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Ingredients</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${headerButtons}
      </div>
    </div>
    ${rearranging ? `<p class="admin-rearrange-hint">Drag <span aria-hidden="true">⠿</span> or use ↑ ↓ to set the POS Stock Count order, then Save Order. Disabled ingredients stay at the bottom.</p>` : ''}
    <div style="display:flex;gap:6px;margin-bottom:16px;${rearranging ? 'display:none' : ''}">
      <button class="pos-btn pos-btn-sm ${ingLocationFilter==='ALL'?'active':''}" data-ing-loc="ALL">All</button>
      <button class="pos-btn pos-btn-sm ${ingLocationFilter==='FRIDGE'?'active':''}" data-ing-loc="FRIDGE">🧊 Fridge</button>
      <button class="pos-btn pos-btn-sm ${ingLocationFilter==='STOREROOM'?'active':''}" data-ing-loc="STOREROOM">🗄️ Storeroom</button>
      <span style="width:1px;background:var(--rule);margin:0 4px" aria-hidden="true"></span>
      <button class="pos-btn pos-btn-sm ${ingLowStockOnly?'active':''}" id="btnIngLowOnly" aria-pressed="${ingLowStockOnly}">Low Stock (${lowCount})</button>
    </div>`;
  if(!filtered.length){
    html += `<div class="admin-empty"><p>${ingLowStockOnly ? 'No low-stock ingredients in this location' : 'No ingredients in this location'}</p></div>`;
  } else {
    html += '<div id="ingList">';
    // Sort: active first, disabled at the bottom. Within each group, keep
    // the server order — Sort Order, then location, then name — which is the
    // same sequence POS → Stock Count shows.
    const sorted = filtered.slice().sort((a, b) => {
      const aActive = a.isActive !== false ? 0 : 1;
      const bActive = b.isActive !== false ? 0 : 1;
      return aActive - bActive;
    });
    sorted.forEach((ing, idx)=>{
      const isActive = ing.isActive !== false;
      const isLow = isIngredientLow(ing);
      const usageLabel = ing.usageUnit ? ` · recipe unit: ${escapeHtml(ing.usageUnit)}` : '';
      // In Rearrange mode show the position Save will write, not the stored one.
      const orderLabel = rearranging ? `#${idx + 1} · `
        : Number.isFinite(ing.sortOrder) ? `#${Number(ing.sortOrder)} · ` : '';
      const dis = rearranging ? 'disabled' : '';
      const group = isActive ? 'active' : 'disabled';
      const moveCtl = rearranging ? `<div class="admin-rearrange-ctl">
            <button class="pos-btn pos-btn-sm" data-move-ing="${escapeAttr(ing.ingredientId)}" data-dir="-1" aria-label="Move ${escapeAttr(ing.name)} up">↑</button>
            <button class="pos-btn pos-btn-sm" data-move-ing="${escapeAttr(ing.ingredientId)}" data-dir="1" aria-label="Move ${escapeAttr(ing.name)} down">↓</button>
          </div>` : '';
      html += `<div class="admin-card admin-ing-row ${isActive ? '' : 'is-disabled'}${rearranging ? ' is-rearranging' : ''}" data-ing-id="${escapeAttr(ing.ingredientId)}" data-ing-group="${group}">
        <div class="admin-card-header">
          ${rearranging ? `<span class="admin-drag-handle" data-drag-ing title="Drag to reorder" aria-hidden="true">⠿</span>` : ''}
          <div class="admin-card-id">
            <div class="admin-card-title">${escapeHtml(ing.name)}${isActive ? '' : ' <span class="admin-card-badge badge-disabled" style="margin-left:6px">Disabled</span>'}</div>
            <div class="admin-card-subtitle">${orderLabel}${Number(ing.currentStock||0)} ${escapeHtml(ing.unit)} · ${escapeHtml(ing.storageLocation||'—')}${usageLabel}${isActive ? '' : ' · <em>drinks that use this should be disabled from the Menu tab</em>'}</div>
          </div>
          <div class="admin-card-actions">
            ${isLow ? '<span class="admin-card-badge badge-inactive">Low Stock</span>' : ''}
            <label class="toggle-switch" title="${isActive?'Click to disable':'Click to enable'}">
              <input type="checkbox" data-toggle-ing="${escapeAttr(ing.ingredientId)}" ${isActive?'checked':''} ${dis}>
              <span class="toggle-slider"></span>
            </label>
            <button class="pos-btn pos-btn-sm" data-edit-ing="${escapeAttr(ing.ingredientId)}" ${dis}>Edit</button>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-ing="${escapeAttr(ing.ingredientId)}" ${dis}>Delete</button>
            ${moveCtl}
          </div>
        </div>
      </div>`;
    });
    html += '</div>';
  }
  html += '</div>';

  // Recipes section — one line per menu item
  html += `<div class="admin-section" style="margin-top:24px">
    <div class="admin-section-header"><h2>Recipes</h2></div>
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:14px">Define base ingredients + variant overrides per menu item</p>`;
  if(!menuItems.length || !items.length){
    html += '<div class="admin-empty"><p>Add menu items and ingredients first</p></div>';
  } else {
    menuItems.forEach(mi=>{
      const id = mi.menuItemId||mi.id;
      const baseRecipe = recipes.filter(r=>r.PK===`RECIPE#${id}#default`);
      const variantRecipes = recipes.filter(r=>r.PK.startsWith(`RECIPE#${id}#`) && r.PK!==`RECIPE#${id}#default`);
      const baseStr = baseRecipe.map(r=>{
        const ing = items.find(i=>i.ingredientId===r.ingredientId);
        return `${Number(r.quantity||0)}${escapeHtml(ing?.usageUnit||'')} ${escapeHtml(ing?.name||'?')}`;
      }).join(', ') || '<em style="color:var(--text-light)">not set</em>';
      const overrideCount = variantRecipes.length;
      html += `<div class="admin-card" style="padding:12px 16px">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title" style="font-size:.95rem">${escapeHtml(mi.name)}</div>
            <div class="admin-card-subtitle">Base: ${baseStr}${overrideCount ? ` · ${overrideCount} variant override(s)` : ''}</div>
          </div>
          <button class="pos-btn pos-btn-sm" data-edit-recipe="${escapeAttr(id)}" ${rearranging?'disabled':''}>Edit</button>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;

  if (rearranging){
    bindIngredientRearrange(container, items, menuItems, recipes);
    return; // every other control is disabled; bind nothing else
  }

  $('#btnRearrange').onclick = ()=>{
    // Start from what the admin sees under "All": server order, disabled last.
    const ordered = items.slice().sort((a, b) => (a.isActive !== false ? 0 : 1) - (b.isActive !== false ? 0 : 1));
    ingRearrange = { order: ordered.map(i => i.ingredientId), dirty: false };
    renderIngredientsSection(container, items, menuItems, recipes);
  };
  $('#btnAddIngredient').onclick = ()=> openIngredientForm(container, null, items);
  $('#btnStockHistory').onclick = ()=> openStockHistoryModal();
  container.querySelectorAll('[data-ing-loc]').forEach(btn=>{
    btn.onclick=()=>{
      ingLocationFilter = btn.dataset.ingLoc;
      renderIngredientsSection(container, items, menuItems, recipes);
    };
  });
  $('#btnIngLowOnly').onclick = ()=>{
    ingLowStockOnly = !ingLowStockOnly;
    renderIngredientsSection(container, items, menuItems, recipes);
  };
  container.querySelectorAll('[data-edit-ing]').forEach(btn=>{
    btn.onclick=()=>{ const ing=items.find(i=>i.ingredientId===btn.dataset.editIng); openIngredientForm(container, ing, items); };
  });
  container.querySelectorAll('[data-del-ing]').forEach(btn=>{
    btn.onclick=async()=>{
      if(!confirm('Delete this ingredient?')) return;
      try{ await api('DELETE',`/api/admin/ingredients/${btn.dataset.delIng}`); loadIngredients(container); } catch(e){ showError('Delete failed'); }
    };
  });
  container.querySelectorAll('[data-toggle-ing]').forEach(input=>{
    input.onchange = async()=>{
      const id = input.dataset.toggleIng;
      input.disabled = true;
      try{
        await api('PUT', `/api/admin/ingredients/${id}/toggle-active`, {});
        loadIngredients(container);
      } catch(e){
        showError('Toggle failed');
        input.checked = !input.checked;
        input.disabled = false;
      }
    };
  });
  container.querySelectorAll('[data-edit-recipe]').forEach(btn=>{
    btn.onclick=()=>{
      const mi = menuItems.find(m=>(m.menuItemId||m.id)===btn.dataset.editRecipe);
      openRecipeForm(container, mi, items, recipes, menuItems);
    };
  });
}

// Rearrange-mode wiring. Drag uses pointer events on the ⠿ handle (works for
// mouse, touch and pen; HTML5 drag-and-drop does not work on touch screens).
// A card only moves within its own group, because disabled ingredients are
// always shown at the bottom — letting one be dragged up would look accepted
// and then snap back after Save.
function bindIngredientRearrange(container, items, menuItems, recipes){
  const list = container.querySelector('#ingList');
  const rerender = () => renderIngredientsSection(container, items, menuItems, recipes);
  const syncFromDom = () => {
    const next = [...list.querySelectorAll('[data-ing-id]')].map(c => c.dataset.ingId);
    if (next.join('|') !== ingRearrange.order.join('|')){
      ingRearrange.order = next;
      ingRearrange.dirty = true;
      container.querySelector('#btnRearrangeSave').disabled = false;
    }
  };

  container.querySelector('#btnRearrangeCancel').onclick = ()=>{
    if (ingRearrange.dirty && !confirm('Discard the new order?')) return;
    ingRearrange = null;
    rerender();
  };

  container.querySelector('#btnRearrangeSave').onclick = async ()=>{
    const btn = container.querySelector('#btnRearrangeSave');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try{
      const r = await api('PUT', '/api/admin/ingredients/reorder', { order: ingRearrange.order });
      // A row deleted in another tab mid-rearrange is reported, not recreated.
      if (r.missing && r.missing.length) showError(`${r.missing.length} ingredient(s) no longer exist and were skipped`);
      else showSuccess('Ingredient order saved');
      loadIngredients(container);
    } catch(e){
      btn.disabled = false;
      btn.textContent = 'Save Order';
      showError('Failed to save order — nothing was changed');
    }
  };

  if (!list) return;

  // ↑ / ↓ — the keyboard and fallback path. Re-render, then return focus to
  // the same button so repeated presses keep moving the same ingredient.
  list.querySelectorAll('[data-move-ing]').forEach(btn=>{
    btn.onclick = ()=>{
      const card = btn.closest('[data-ing-id]');
      const dir = Number(btn.dataset.dir);
      const peer = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
      if (!peer || peer.dataset.ingGroup !== card.dataset.ingGroup) return;
      if (dir < 0) list.insertBefore(card, peer); else list.insertBefore(peer, card);
      syncFromDom();
      rerender();
      const again = container.querySelector(`[data-move-ing="${CSS.escape(card.dataset.ingId)}"][data-dir="${dir}"]`);
      if (again) again.focus();
    };
  });

  list.querySelectorAll('[data-drag-ing]').forEach(handle=>{
    handle.onpointerdown = e=>{
      if (e.button !== 0) return;
      e.preventDefault();
      const card = handle.closest('[data-ing-id]');

      // Listen on document, not the handle: moving the card re-parents the
      // handle, which silently releases pointer capture, so a handle listener
      // stops hearing moves after the first swap.
      const move = ev=>{
        if (ev.pointerId !== e.pointerId) return;
        ev.preventDefault();
        const peers = [...list.querySelectorAll(`[data-ing-group="${card.dataset.ingGroup}"]`)].filter(c => c !== card);
        if (!peers.length) return;
        const before = peers.find(c => { const r = c.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        if (before) { if (card.nextElementSibling !== before) list.insertBefore(card, before); }
        else {
          const last = peers[peers.length - 1];
          if (last.nextElementSibling !== card) list.insertBefore(card, last.nextElementSibling);
        }
        // Edge auto-scroll so a long list can be dragged past the fold.
        const edge = 60;
        if (ev.clientY < edge) window.scrollBy(0, -12);
        else if (ev.clientY > window.innerHeight - edge) window.scrollBy(0, 12);
      };
      const end = ev=>{
        if (ev.pointerId !== e.pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        card.classList.remove('is-dragging');
        syncFromDom();
        rerender(); // refresh ↑/↓ wiring against the new DOM order
      };
      card.classList.add('is-dragging');
      document.addEventListener('pointermove', move, { passive: false });
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    };
  });
}

function openRecipeForm(container, menuItem, ingredients, allRecipes, menuItems){
  const id = menuItem.menuItemId||menuItem.id;
  const variants = menuItem.variants||[];
  const baseExisting = allRecipes.filter(r=>r.PK===`RECIPE#${id}#default`);
  let baseRows = baseExisting.map(r=>({ingredientId:r.ingredientId, quantity:r.quantity}));
  if(!baseRows.length) baseRows.push({ingredientId:'', quantity:0});

  // Variant overrides: {variantId: [{ingredientId, quantity, action:'add'|'replace'}]}
  let variantOverrides = {};
  variants.forEach(v=>{
    const vid = v.id||v.name||v;
    const existing = allRecipes.filter(r=>r.PK===`RECIPE#${id}#${vid}`);
    variantOverrides[vid] = existing.map(r=>({ingredientId:r.ingredientId, quantity:r.quantity}));
  });

  const form = document.createElement('div');
  form.className = 'admin-form';

  // `prefix` carries a variant id that can be a free-text legacy variant NAME,
  // so it is escaped like any other admin-entered value. The DOM attribute value
  // is unchanged by escaping, so the `[data-prefix="…"]` lookups below still
  // match — see the note there about the selector side.
  function ingSelect(row, idx, prefix){
    return `<select class="pos-input" data-prefix="${escapeAttr(prefix)}" data-ri="${idx}" data-rf="ingredientId" style="flex:2">
      <option value="">-- Select --</option>
      ${ingredients.map(ing=>`<option value="${escapeAttr(ing.ingredientId)}" ${ing.ingredientId===row.ingredientId?'selected':''}>${escapeHtml(ing.name)} (${escapeHtml(ing.usageUnit||ing.unit)})</option>`).join('')}
    </select>`;
  }

  function renderRows(rows, prefix){
    return rows.map((r,i)=>`<div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
      ${ingSelect(r,i,prefix)}
      <input type="number" step="0.1" class="pos-input" data-prefix="${escapeAttr(prefix)}" data-ri="${i}" data-rf="quantity" value="${r.quantity||''}" placeholder="Qty" style="flex:1">
      <button class="pos-btn pos-btn-sm pos-btn-danger" data-prefix="${escapeAttr(prefix)}" data-rr="${i}" style="min-width:32px">✕</button>
    </div>`).join('');
  }

  function render(){
    let variantHtml = '';
    if(variants.length){
      variantHtml = `<h4 style="margin-top:16px;margin-bottom:8px">Variant Overrides <span style="font-size:.8rem;color:var(--text-light)">(leave empty = use base only)</span></h4>`;
      variants.forEach(v=>{
        const vid = v.id||v.name||v;
        const vname = v.name||v;
        const rows = variantOverrides[vid]||[];
        variantHtml += `<div style="margin-bottom:12px;padding:10px;background:var(--cream);border-radius:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><strong style="font-size:.9rem">${escapeHtml(vname)}</strong><button class="pos-btn pos-btn-sm" data-add-override="${escapeAttr(vid)}">+ Add</button></div>
          <div data-override-list="${escapeAttr(vid)}">${rows.length ? renderRows(rows, `v_${vid}`) : '<span style="font-size:.8rem;color:var(--text-light)">No override — uses base recipe</span>'}</div>
        </div>`;
      });
    }

    form.innerHTML = `<h3>Recipe: ${escapeHtml(menuItem.name)}</h3>
      <h4 style="margin-bottom:8px">Base Ingredients</h4>
      <div id="baseRows">${renderRows(baseRows, 'base')}</div>
      <button class="pos-btn pos-btn-sm" id="addBaseRow" style="margin-top:6px">+ Add Ingredient</button>
      ${variantHtml}
      <div class="admin-form-actions" style="margin-top:16px">
        <button class="pos-btn pos-btn-primary" id="saveRecipe">Save Recipe</button>
        <button class="pos-btn" id="cancelRecipe">Cancel</button>
      </div>`;

    // Bind base
    form.querySelectorAll('[data-prefix="base"][data-rf="ingredientId"]').forEach(s=>s.onchange=()=>{ baseRows[+s.dataset.ri].ingredientId=s.value; });
    form.querySelectorAll('[data-prefix="base"][data-rf="quantity"]').forEach(inp=>inp.oninput=()=>{ baseRows[+inp.dataset.ri].quantity=+inp.value; });
    form.querySelectorAll('[data-prefix="base"][data-rr]').forEach(btn=>btn.onclick=()=>{ baseRows.splice(+btn.dataset.rr,1); if(!baseRows.length) baseRows.push({ingredientId:'',quantity:0}); render(); });
    form.querySelector('#addBaseRow').onclick=()=>{ baseRows.push({ingredientId:'',quantity:0}); render(); };

    // Bind variant overrides.
    // `vid` is free text (a legacy variant name when the variant has no id), so
    // it goes through CSS.escape before it is spliced into a SELECTOR — escaping
    // the HTML above protects the markup, but an unescaped quote here is a
    // SyntaxError that takes the whole recipe form down. Same treatment as
    // admin-preorder.js's `input[data-drink-id="…"]` lookup.
    variants.forEach(v=>{
      const vid = v.id||v.name||v;
      const prefix = CSS.escape(`v_${vid}`);
      form.querySelectorAll(`[data-prefix="${prefix}"][data-rf="ingredientId"]`).forEach(s=>s.onchange=()=>{ variantOverrides[vid][+s.dataset.ri].ingredientId=s.value; });
      form.querySelectorAll(`[data-prefix="${prefix}"][data-rf="quantity"]`).forEach(inp=>inp.oninput=()=>{ variantOverrides[vid][+inp.dataset.ri].quantity=+inp.value; });
      form.querySelectorAll(`[data-prefix="${prefix}"][data-rr]`).forEach(btn=>btn.onclick=()=>{ variantOverrides[vid].splice(+btn.dataset.rr,1); render(); });
      form.querySelector(`[data-add-override="${CSS.escape(String(vid))}"]`).onclick=()=>{ if(!variantOverrides[vid]) variantOverrides[vid]=[]; variantOverrides[vid].push({ingredientId:'',quantity:0}); render(); };
    });

    form.querySelector('#cancelRecipe').onclick=()=>form._overlay.remove();
    form.querySelector('#saveRecipe').onclick=async()=>{
      try{
        // Save base
        const baseValid = baseRows.filter(r=>r.ingredientId && r.quantity>0);
        await api('POST','/api/admin/recipes',{ menuItemId:id, variantId:null, ingredients:baseValid });
        // Save variant overrides
        for(const v of variants){
          const vid = v.id||v.name||v;
          const rows = (variantOverrides[vid]||[]).filter(r=>r.ingredientId && r.quantity>0);
          await api('POST','/api/admin/recipes',{ menuItemId:id, variantId:vid, ingredients:rows });
        }
        form._overlay.remove();
        loadIngredients(container);
      } catch(e){ showError('Failed to save recipe'); }
    };
  }
  render();
  showFormModal(form);
}

function openIngredientForm(container, ing, allItems){
  const isEdit = !!ing;
  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>${isEdit?'Edit':'Add'} Ingredient</h3>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Name</label><input id="ifName" class="pos-input" value="${escapeAttr(ing?.name||'')}"></div>
      <div class="admin-form-group"><label>Stock Unit (how you count it)</label><select id="ifUnit" class="pos-input">
        <option value="bottles" ${ing?.unit==='bottles'?'selected':''}>bottles</option>
        <option value="bags" ${ing?.unit==='bags'?'selected':''}>bags</option>
        <option value="box" ${ing?.unit==='box'?'selected':''}>box</option>
        <option value="pieces" ${ing?.unit==='pieces'?'selected':''}>pieces</option>
      </select></div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Usage Unit (per drink recipe)</label><select id="ifUsageUnit" class="pos-input">
        <option value="ml" ${ing?.usageUnit==='ml'?'selected':''}>ml</option>
        <option value="g" ${ing?.usageUnit==='g'?'selected':''}>g</option>
        <option value="spoons" ${ing?.usageUnit==='spoons'?'selected':''}>spoons</option>
        <option value="pieces" ${ing?.usageUnit==='pieces'?'selected':''}>pieces</option>
      </select></div>
      <div class="admin-form-group"><label>Storage Location</label><select id="ifLocation" class="pos-input">
        <option value="FRIDGE" ${ing?.storageLocation==='FRIDGE'?'selected':''}>Fridge</option>
        <option value="STOREROOM" ${ing?.storageLocation==='STOREROOM'?'selected':''}>Storeroom</option>
        <option value="BOTH" ${ing?.storageLocation==='BOTH'?'selected':''}>Both</option>
      </select></div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Current Stock</label><input id="ifStock" type="number" step="0.1" class="pos-input" value="${ing?.currentStock||0}"></div>
      <div class="admin-form-group"><label>Low Stock Threshold</label><input id="ifThreshold" type="number" step="0.1" class="pos-input" value="${ing?.lowStockThreshold||0}"></div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Sort Order (Stock Count position)</label><input id="ifSort" type="number" step="1" min="0" class="pos-input" placeholder="Blank = after numbered items" value="${Number.isFinite(ing?.sortOrder) ? Number(ing.sortOrder) : ''}" style="max-width:220px"></div>
    </div>
    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="ifSubmit">${isEdit?'Save Changes':'Add Ingredient'}</button>
      <button class="pos-btn" id="ifCancel">Cancel</button>
    </div>`;

  showFormModal(form);
  form.querySelector('#ifCancel').onclick=()=>form._overlay.remove();
  form.querySelector('#ifSubmit').onclick=async()=>{
    const body = {
      name: form.querySelector('#ifName').value.trim(),
      unit: form.querySelector('#ifUnit').value,
      usageUnit: form.querySelector('#ifUsageUnit').value,
      currentStock: +form.querySelector('#ifStock').value,
      lowStockThreshold: +form.querySelector('#ifThreshold').value,
      storageLocation: form.querySelector('#ifLocation').value
    };
    // Blank clears the position (null, not 0) so the item drops back below
    // every numbered one instead of jumping to the top.
    const sortRaw = form.querySelector('#ifSort').value.trim();
    body.sortOrder = sortRaw === '' ? null : parseInt(sortRaw, 10);
    if(body.sortOrder !== null && !Number.isFinite(body.sortOrder)){ showError('Sort Order must be a whole number'); return; }
    if(!body.name){ showError('Name is required'); return; }
    try{
      if(isEdit) await api('PUT',`/api/admin/ingredients/${ing.ingredientId}`, body);
      else await api('POST','/api/admin/ingredients', body);
      form._overlay.remove();
      loadIngredients(container);
    } catch(e){ showError('Save failed'); }
  };
}


// --- Stock History Modal ---
// Browse cashier-submitted stock-count snapshots by date. Shows each
// snapshot's counts in a table (name / count / unit / location).
async function openStockHistoryModal(){
  const overlay = document.createElement('div');
  overlay.className = 'pos-modal-overlay';
  overlay.innerHTML = `<div class="pos-modal" style="max-width:820px;max-height:90vh;display:flex;flex-direction:column;padding:0">
    <div style="padding:16px 20px;border-bottom:1px solid var(--cream-dark);display:flex;justify-content:space-between;align-items:center;gap:12px">
      <h3 style="margin:0">📋 Stock Count History</h3>
      <button class="pos-modal-close" id="shClose" style="position:static">✕</button>
    </div>
    <div style="padding:12px 20px;border-bottom:1px solid var(--cream-dark);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="pos-btn pos-btn-sm" id="shPrev">‹ Prev</button>
      <input type="date" id="shDate" class="pos-input" style="margin:0;max-width:180px">
      <button class="pos-btn pos-btn-sm" id="shNext">Next ›</button>
      <span id="shDateInfo" style="font-size:.8rem;color:var(--text-light);margin-left:auto"></span>
    </div>
    <div id="shBody" style="flex:1;overflow-y:auto;padding:16px 20px">
      <div class="loading">Loading…</div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if(e.target === overlay) overlay.remove(); };
  overlay.querySelector('#shClose').onclick = ()=> overlay.remove();

  const dateInput = overlay.querySelector('#shDate');
  // MYT: the snapshot dates are keyed by the café's calendar day, so opening
  // this before 08:00 used to land on yesterday and look like missing data.
  const today = mytToday();
  dateInput.value = today;

  // Load list of dates that have snapshots (used for the count summary + hints)
  let snapshotDates = [];
  try {
    const meta = await api('GET','/api/admin/stock-history/snapshots');
    snapshotDates = meta.dates || [];
  } catch(e){ /* non-fatal */ }

  function updateInfo(){
    const info = overlay.querySelector('#shDateInfo');
    if (!snapshotDates.length){ info.textContent = 'No snapshots yet'; return; }
    const total = snapshotDates.reduce((s, d) => s + (d.count || 0), 0);
    info.textContent = `${snapshotDates.length} day(s), ${total} snapshot(s) total`;
  }
  updateInfo();

  async function load(date){
    const body = overlay.querySelector('#shBody');
    body.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const data = await api('GET', `/api/admin/stock-history?date=${encodeURIComponent(date)}`);
      const snapshots = data.snapshots || [];
      if (!snapshots.length){
        body.innerHTML = `<div class="admin-empty" style="padding:40px 20px;text-align:center"><p>No stock counts recorded on ${escapeHtml(date)}</p></div>`;
        return;
      }
      body.innerHTML = snapshots.map(s => {
        const rows = (s.counts || []).map(c => `<tr>
          <td style="padding:6px 8px">${escapeHtml(c.name || '?')}</td>
          <td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums">${escapeHtml(String(c.count ?? '—'))}</td>
          <td style="padding:6px 8px;color:var(--text-light)">${escapeHtml(c.unit || '')}</td>
          <td style="padding:6px 8px;color:var(--text-light)">${escapeHtml(c.storageLocation || '—')}</td>
        </tr>`).join('');
        const ts = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—';
        return `<div class="admin-card" style="margin-bottom:14px;padding:14px 16px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:10px">
            <div>
              <div style="font-weight:700">${escapeHtml(ts)}</div>
              <div style="font-size:.8rem;color:var(--text-light)">Submitted by ${escapeHtml(s.submittedBy || 'Unknown')} · ${(s.counts||[]).length} item(s)</div>
            </div>
          </div>
          <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.9rem">
            <thead><tr style="background:var(--quiet);text-align:left">
              <th style="padding:6px 8px">Item</th>
              <th style="padding:6px 8px;text-align:right">Count</th>
              <th style="padding:6px 8px">Unit</th>
              <th style="padding:6px 8px">Location</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </div>`;
      }).join('');
    } catch(e){
      body.innerHTML = '<div class="admin-empty" style="padding:40px 20px;text-align:center;color:var(--danger)"><p>Failed to load stock history</p></div>';
    }
  }

  function shiftDate(days){
    const d = new Date(dateInput.value + 'T00:00:00Z');
    if (isNaN(d.getTime())) return;
    d.setUTCDate(d.getUTCDate() + days);
    dateInput.value = d.toISOString().split('T')[0];
    load(dateInput.value);
  }

  dateInput.onchange = ()=> load(dateInput.value);
  overlay.querySelector('#shPrev').onclick = ()=> shiftDate(-1);
  overlay.querySelector('#shNext').onclick = ()=> shiftDate(1);

  load(today);
}

