// admin-ingredients.js — Ingredients + stock history
// Depends on: admin.js (api, showError, showFormModal, showSuccess, $)

// --- Ingredients ---
async function loadIngredients(container){
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

function renderIngredientsSection(container, items, menuItems, recipes){
  // Items marked BOTH appear under either Fridge or Storeroom filter (and ALL),
  // matching the POS stock-count filter behavior.
  const filtered = ingLocationFilter === 'ALL'
    ? items
    : items.filter(i => i.storageLocation === ingLocationFilter || i.storageLocation === 'BOTH');
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Ingredients</h2>
      <div style="display:flex;gap:8px">
        <button class="pos-btn pos-btn-sm" id="btnStockHistory">📋 Stock History</button>
        <button class="pos-btn pos-btn-primary" id="btnAddIngredient">+ Add Ingredient</button>
      </div>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:16px">
      <button class="pos-btn pos-btn-sm ${ingLocationFilter==='ALL'?'active':''}" data-ing-loc="ALL">All</button>
      <button class="pos-btn pos-btn-sm ${ingLocationFilter==='FRIDGE'?'active':''}" data-ing-loc="FRIDGE">🧊 Fridge</button>
      <button class="pos-btn pos-btn-sm ${ingLocationFilter==='STOREROOM'?'active':''}" data-ing-loc="STOREROOM">🗄️ Storeroom</button>
    </div>`;
  if(!filtered.length){
    html += '<div class="admin-empty"><p>No ingredients in this location</p></div>';
  } else {
    // Sort: active first, disabled at the bottom. Within each group, keep
    // the DB order so the admin can still spot low-stock among actives.
    const sorted = filtered.slice().sort((a, b) => {
      const aActive = a.isActive !== false ? 0 : 1;
      const bActive = b.isActive !== false ? 0 : 1;
      return aActive - bActive;
    });
    sorted.forEach(ing=>{
      const isActive = ing.isActive !== false;
      const isLow = isActive && ing.currentStock <= (ing.lowStockThreshold||0);
      const usageLabel = ing.usageUnit ? ` · recipe unit: ${ing.usageUnit}` : '';
      html += `<div class="admin-card ${isActive ? '' : 'is-disabled'}">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${ing.name}${isActive ? '' : ' <span class="admin-card-badge badge-disabled" style="margin-left:6px">Disabled</span>'}</div>
            <div class="admin-card-subtitle">${ing.currentStock} ${ing.unit} · ${ing.storageLocation||'—'}${usageLabel}${isActive ? '' : ' · <em>drinks that use this should be disabled from the Menu tab</em>'}</div>
          </div>
          <div class="admin-card-actions">
            ${isLow ? '<span class="admin-card-badge badge-inactive">Low Stock</span>' : ''}
            <label class="toggle-switch" title="${isActive?'Click to disable':'Click to enable'}">
              <input type="checkbox" data-toggle-ing="${ing.ingredientId}" ${isActive?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
            <button class="pos-btn pos-btn-sm" data-edit-ing="${ing.ingredientId}">Edit</button>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-ing="${ing.ingredientId}">Delete</button>
          </div>
        </div>
      </div>`;
    });
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
        return `${r.quantity}${ing?.usageUnit||''} ${ing?.name||'?'}`;
      }).join(', ') || '<em style="color:var(--text-light)">not set</em>';
      const overrideCount = variantRecipes.length;
      html += `<div class="admin-card" style="padding:12px 16px">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title" style="font-size:.95rem">${mi.name}</div>
            <div class="admin-card-subtitle">Base: ${baseStr}${overrideCount ? ` · ${overrideCount} variant override(s)` : ''}</div>
          </div>
          <button class="pos-btn pos-btn-sm" data-edit-recipe="${id}">Edit</button>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;

  $('#btnAddIngredient').onclick = ()=> openIngredientForm(container, null, items);
  $('#btnStockHistory').onclick = ()=> openStockHistoryModal();
  container.querySelectorAll('[data-ing-loc]').forEach(btn=>{
    btn.onclick=()=>{
      ingLocationFilter = btn.dataset.ingLoc;
      renderIngredientsSection(container, items, menuItems, recipes);
    };
  });
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

  function ingSelect(row, idx, prefix){
    return `<select class="pos-input" data-prefix="${prefix}" data-ri="${idx}" data-rf="ingredientId" style="flex:2">
      <option value="">-- Select --</option>
      ${ingredients.map(ing=>`<option value="${ing.ingredientId}" ${ing.ingredientId===row.ingredientId?'selected':''}>${ing.name} (${ing.usageUnit||ing.unit})</option>`).join('')}
    </select>`;
  }

  function renderRows(rows, prefix){
    return rows.map((r,i)=>`<div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
      ${ingSelect(r,i,prefix)}
      <input type="number" step="0.1" class="pos-input" data-prefix="${prefix}" data-ri="${i}" data-rf="quantity" value="${r.quantity||''}" placeholder="Qty" style="flex:1">
      <button class="pos-btn pos-btn-sm pos-btn-danger" data-prefix="${prefix}" data-rr="${i}" style="min-width:32px">✕</button>
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
        variantHtml += `<div style="margin-bottom:12px;padding:10px;background:var(--cream,#f9f5f0);border-radius:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><strong style="font-size:.9rem">${vname}</strong><button class="pos-btn pos-btn-sm" data-add-override="${vid}">+ Add</button></div>
          <div data-override-list="${vid}">${rows.length ? renderRows(rows, `v_${vid}`) : '<span style="font-size:.8rem;color:var(--text-light)">No override — uses base recipe</span>'}</div>
        </div>`;
      });
    }

    form.innerHTML = `<h3>Recipe: ${menuItem.name}</h3>
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

    // Bind variant overrides
    variants.forEach(v=>{
      const vid = v.id||v.name||v;
      const prefix = `v_${vid}`;
      form.querySelectorAll(`[data-prefix="${prefix}"][data-rf="ingredientId"]`).forEach(s=>s.onchange=()=>{ variantOverrides[vid][+s.dataset.ri].ingredientId=s.value; });
      form.querySelectorAll(`[data-prefix="${prefix}"][data-rf="quantity"]`).forEach(inp=>inp.oninput=()=>{ variantOverrides[vid][+inp.dataset.ri].quantity=+inp.value; });
      form.querySelectorAll(`[data-prefix="${prefix}"][data-rr]`).forEach(btn=>btn.onclick=()=>{ variantOverrides[vid].splice(+btn.dataset.rr,1); render(); });
      form.querySelector(`[data-add-override="${vid}"]`).onclick=()=>{ if(!variantOverrides[vid]) variantOverrides[vid]=[]; variantOverrides[vid].push({ingredientId:'',quantity:0}); render(); };
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
      <div class="admin-form-group"><label>Name</label><input id="ifName" class="pos-input" value="${ing?.name||''}"></div>
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
    <div style="padding:16px 20px;border-bottom:1px solid var(--cream-dark,#E7DFD5);display:flex;justify-content:space-between;align-items:center;gap:12px">
      <h3 style="margin:0">📋 Stock Count History</h3>
      <button class="pos-modal-close" id="shClose" style="position:static">✕</button>
    </div>
    <div style="padding:12px 20px;border-bottom:1px solid var(--cream-dark,#E7DFD5);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="pos-btn pos-btn-sm" id="shPrev">‹ Prev</button>
      <input type="date" id="shDate" class="pos-input" style="margin:0;max-width:180px">
      <button class="pos-btn pos-btn-sm" id="shNext">Next ›</button>
      <span id="shDateInfo" style="font-size:.8rem;color:var(--text-light,#7A6355);margin-left:auto"></span>
    </div>
    <div id="shBody" style="flex:1;overflow-y:auto;padding:16px 20px">
      <div class="loading">Loading…</div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if(e.target === overlay) overlay.remove(); };
  overlay.querySelector('#shClose').onclick = ()=> overlay.remove();

  const dateInput = overlay.querySelector('#shDate');
  const today = new Date().toISOString().split('T')[0];
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
          <td style="padding:6px 8px;color:var(--text-light,#7A6355)">${escapeHtml(c.unit || '')}</td>
          <td style="padding:6px 8px;color:var(--text-light,#7A6355)">${escapeHtml(c.storageLocation || '—')}</td>
        </tr>`).join('');
        const ts = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—';
        return `<div class="admin-card" style="margin-bottom:14px;padding:14px 16px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:10px">
            <div>
              <div style="font-weight:700">${escapeHtml(ts)}</div>
              <div style="font-size:.8rem;color:var(--text-light,#7A6355)">Submitted by ${escapeHtml(s.submittedBy || 'Unknown')} · ${(s.counts||[]).length} item(s)</div>
            </div>
          </div>
          <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.9rem">
            <thead><tr style="background:#f7f5f2;text-align:left">
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

