// admin-checklist.js — Checklist configuration
// Depends on: admin.js (api, showError, showSuccess, $)

// --- Checklist ---
async function loadChecklist(container){
  container.innerHTML = '<div class="loading">Loading checklist config...</div>';
  try{
    const data = await api('GET','/api/admin/checklist/config');
    renderChecklistAdmin(container, data);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load checklist</p></div>'; }
}

function renderChecklistAdmin(container, config){
  function renderPhase(phase, items){
    return items.map((item, i)=>{
      const enabled = item.enabled !== false;
      return `<div class="admin-card ${enabled?'':'is-disabled'}" style="display:flex;align-items:center;gap:12px;padding:12px 16px">
      <span style="min-width:24px;color:var(--text-light);font-weight:600">${i+1}.</span>
      <input class="pos-input" style="flex:1;margin:0" value="${item.label}" data-phase="${phase}" data-idx="${i}" data-field="label">
      <select class="pos-input" style="width:120px;margin:0" data-phase="${phase}" data-idx="${i}" data-field="type">
        <option value="checkbox" ${item.type==='checkbox'?'selected':''}>Checkbox</option>
        <option value="text" ${item.type==='text'?'selected':''}>Text input</option>
        <option value="image" ${item.type==='image'?'selected':''}>Image upload</option>
      </select>
      <label class="toggle-switch" title="${enabled?'Enabled — click to hide from POS':'Disabled — click to enable'}">
        <input type="checkbox" data-phase="${phase}" data-idx="${i}" data-field="enabled" ${enabled?'checked':''}>
        <span class="toggle-slider"></span>
      </label>
      <button class="pos-btn pos-btn-sm pos-btn-danger" data-remove-phase="${phase}" data-remove-idx="${i}" style="min-width:36px">✕</button>
    </div>`;
    }).join('');
  }

  container.innerHTML = `<div class="admin-section">
    <div class="admin-section-header"><h2>Checklist Configuration</h2></div>
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:16px">Toggle an item off to hide it from the POS open/close/handover flow without deleting it.</p>
    <div class="admin-form">
      <h3 style="margin-bottom:12px">☀️ Open Checklist</h3>
      <div id="openItems">${renderPhase('open', config.open||[])}</div>
      <button class="pos-btn pos-btn-sm" id="addOpenItem" style="margin-top:10px">+ Add item</button>
    </div>
    <div class="admin-form" style="margin-top:16px">
      <h3 style="margin-bottom:12px">🌙 Close Checklist</h3>
      <div id="closeItems">${renderPhase('close', config.close||[])}</div>
      <button class="pos-btn pos-btn-sm" id="addCloseItem" style="margin-top:10px">+ Add item</button>
    </div>
    <div class="admin-form" style="margin-top:16px">
      <h3 style="margin-bottom:12px">🔄 Handover Checklist</h3>
      <p style="color:var(--text-light);font-size:.8rem;margin-bottom:8px">Shown to first-service staff before handing over to the second-service team.</p>
      <div id="handoverItems">${renderPhase('handover', config.handover||[])}</div>
      <button class="pos-btn pos-btn-sm" id="addHandoverItem" style="margin-top:10px">+ Add item</button>
    </div>
    <div class="admin-form-actions" style="margin-top:20px">
      <button class="pos-btn pos-btn-primary" id="saveChecklist">Save Checklist</button>
    </div>
  </div>`;

  // Normalize: ensure every item has an 'enabled' field (default true) so the
  // toggle state round-trips even for legacy configs.
  let openItems = (config.open||[]).map(i=>({...i, enabled: i.enabled !== false}));
  let closeItems = (config.close||[]).map(i=>({...i, enabled: i.enabled !== false}));
  let handoverItems = (config.handover||[]).map(i=>({...i, enabled: i.enabled !== false}));

  const rerender = () => renderChecklistAdmin(container, {open:openItems, close:closeItems, handover:handoverItems});

  container.querySelector('#addOpenItem').onclick=()=>{
    openItems.push({id:`open-${Date.now()}`, label:'', type:'checkbox', enabled:true});
    rerender();
  };
  container.querySelector('#addCloseItem').onclick=()=>{
    closeItems.push({id:`close-${Date.now()}`, label:'', type:'checkbox', enabled:true});
    rerender();
  };
  container.querySelector('#addHandoverItem').onclick=()=>{
    handoverItems.push({id:`handover-${Date.now()}`, label:'', type:'checkbox', enabled:true});
    rerender();
  };

  const listFor = (phase) => phase==='open' ? openItems : phase==='close' ? closeItems : handoverItems;

  container.querySelectorAll('[data-remove-phase]').forEach(btn=>{
    btn.onclick=()=>{
      const phase = btn.dataset.removePhase;
      const idx = +btn.dataset.removeIdx;
      listFor(phase).splice(idx,1);
      rerender();
    };
  });

  container.querySelectorAll('input[data-field="label"]').forEach(inp=>{
    inp.oninput=()=>{
      const idx = +inp.dataset.idx;
      listFor(inp.dataset.phase)[idx].label = inp.value;
    };
  });

  container.querySelectorAll('select[data-field="type"]').forEach(sel=>{
    sel.onchange=()=>{
      const idx = +sel.dataset.idx;
      listFor(sel.dataset.phase)[idx].type = sel.value;
    };
  });

  container.querySelectorAll('input[data-field="enabled"]').forEach(inp=>{
    inp.onchange=()=>{
      const idx = +inp.dataset.idx;
      listFor(inp.dataset.phase)[idx].enabled = inp.checked;
      // Re-render so the greyed-out styling reflects the new state
      rerender();
    };
  });

  container.querySelector('#saveChecklist').onclick=async()=>{
    const cleanList = (list, prefix) => list.filter(i=>i.label.trim()).map((item,i)=>({
      ...item,
      id:item.id||`${prefix}-${i+1}`,
      label:item.label.trim(),
      enabled: item.enabled !== false,
    }));
    const open = cleanList(openItems, 'open');
    const close = cleanList(closeItems, 'close');
    const handover = cleanList(handoverItems, 'handover');
    try{
      await api('PUT','/api/admin/checklist/config', {open, close, handover});
      showSuccess('Checklist saved');
    } catch(e){ showError('Failed to save checklist'); }
  };
}

