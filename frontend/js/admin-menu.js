// admin-menu.js — Menu CRUD, filters, toggle
// Depends on: admin.js (api, showError, showFormModal, $)

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
      const variants = (item.variants||[]).map(v=>v.name||v).join(', ');
      const isActive = item.isActive !== false;
      const id = item.menuItemId || item.id;
      html += `<div class="admin-card ${isActive?'':'is-disabled'}">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${item.name}</div>
            <div class="admin-card-subtitle">RM ${(item.basePrice||0).toFixed(2)}${variants ? ' · '+variants : ''}</div>
          </div>
          <div class="admin-card-actions">
            <span class="admin-card-badge ${badge}">${item.category}</span>
            ${item.category==='DRINK' ? `<span class="admin-card-badge ${item.celebrationEligible===true?'badge-active':'badge-inactive'}">${item.celebrationEligible===true?'🎉 RM5':'No 🎉'}</span>` : ''}
            ${isActive ? '' : '<span class="admin-card-badge badge-disabled">Disabled</span>'}
            <label class="toggle-switch" title="${isActive?'Click to disable':'Click to enable'}">
              <input type="checkbox" data-toggle-menu="${id}" ${isActive?'checked':''}>
              <span class="toggle-slider"></span>
            </label>
            <button class="pos-btn pos-btn-sm" data-edit-menu="${id}">Edit</button>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-menu="${id}">Delete</button>
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

function openMenuForm(container, item, allItems){
  const isEdit = !!item;
  const variants = item?.variants || [];
  let variantHtml = variants.map((v,i)=>`<div class="variant-row">
    <input class="pos-input" placeholder="Name" value="${v.name||''}" data-vi="${i}" data-vf="name">
    <input class="pos-input" placeholder="+Price" type="number" step="0.5" value="${v.priceModifier||0}" data-vi="${i}" data-vf="priceModifier">
    <button class="remove-variant" data-vri="${i}">✕</button></div>`).join('');

  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>${isEdit?'Edit':'Add'} Menu Item</h3>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Name</label><input id="mfName" class="pos-input" value="${item?.name||''}"></div>
      <div class="admin-form-group"><label>Category</label><select id="mfCategory" class="pos-input"><option value="DRINK" ${item?.category==='DRINK'?'selected':''}>Drink</option><option value="FOOD" ${item?.category==='FOOD'?'selected':''}>Food</option></select></div>
    </div>
    <div class="admin-form-group"><label>Description</label><input id="mfDesc" class="pos-input" value="${item?.description||''}" placeholder="Short description (optional)"></div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Base Price (RM)</label><input id="mfPrice" type="number" step="0.5" class="pos-input" value="${item?.basePrice||''}"></div>
      <div class="admin-form-group"><label>Sort Order</label><input id="mfSort" type="number" class="pos-input" value="${item?.sortOrder||0}"></div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Celebration Eligible</label><select id="mfCelebration" class="pos-input"><option value="false" ${item?.celebrationEligible!==true?'selected':''}>No — always normal price</option><option value="true" ${item?.celebrationEligible===true?'selected':''}>Yes — RM5 on celebration day</option></select></div>
    </div>
    <div class="admin-form-group"><label>Variants</label><div id="variantList" class="variant-list">${variantHtml}</div>
      <button class="pos-btn pos-btn-sm" id="btnAddVariant" style="margin-top:8px">+ Add Variant</button></div>
    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="mfSubmit">${isEdit?'Save Changes':'Add Item'}</button>
      <button class="pos-btn" id="mfCancel">Cancel</button>
    </div>`;

  showFormModal(form);
  let currentVariants = [...variants];

  form.querySelector('#btnAddVariant').onclick=()=>{
    currentVariants.push({name:'',priceModifier:0});
    refreshVariants();
  };

  function refreshVariants(){
    const list = form.querySelector('#variantList');
    list.innerHTML = currentVariants.map((v,i)=>`<div class="variant-row">
      <input class="pos-input" placeholder="Name" value="${v.name||''}" data-vi="${i}" data-vf="name">
      <input class="pos-input" placeholder="+Price" type="number" step="0.5" value="${v.priceModifier||0}" data-vi="${i}" data-vf="priceModifier">
      <button class="remove-variant" data-vri="${i}">✕</button></div>`).join('');
    list.querySelectorAll('input').forEach(inp=>inp.oninput=()=>{
      const idx=+inp.dataset.vi;
      const field=inp.dataset.vf;
      currentVariants[idx][field] = field==='priceModifier' ? +inp.value : inp.value;
    });
    list.querySelectorAll('.remove-variant').forEach(btn=>btn.onclick=()=>{
      currentVariants.splice(+btn.dataset.vri,1);
      refreshVariants();
    });
  }
  refreshVariants();

  form.querySelector('#mfCancel').onclick=()=>{ form._overlay.remove(); };
  form.querySelector('#mfSubmit').onclick=async()=>{
    const body = {
      name: form.querySelector('#mfName').value.trim(),
      description: form.querySelector('#mfDesc').value.trim(),
      category: form.querySelector('#mfCategory').value,
      basePrice: +form.querySelector('#mfPrice').value,
      sortOrder: +form.querySelector('#mfSort').value,
      celebrationEligible: form.querySelector('#mfCelebration').value === 'true',
      variants: currentVariants.filter(v=>v.name)
    };
    if(!body.name || !body.basePrice){ showError('Name and price are required'); return; }
    try{
      if(isEdit) await api('PUT',`/api/admin/menu/${item.menuItemId||item.id}`, body);
      else await api('POST','/api/admin/menu', body);
      form._overlay.remove();
      loadMenu(container);
    } catch(e){ showError('Save failed'); }
  };
}

