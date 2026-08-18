// admin-checklist.js — Checklist configuration
// Depends on: admin.js (api, showError, showSuccess, $, escapeAttr)

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
      const last = i === items.length - 1;
      return `<div class="admin-card cl-row ${enabled?'':'is-disabled'}" data-cl-row>
      <span class="cl-handle" data-drag-phase="${phase}" title="Drag to reorder" aria-hidden="true">⠿</span>
      <span class="cl-num">${i+1}.</span>
      <input class="pos-input cl-label" value="${escapeAttr(item.label)}" data-phase="${phase}" data-idx="${i}" data-field="label">
      <select class="pos-input cl-type" data-phase="${phase}" data-idx="${i}" data-field="type">
        <option value="checkbox" ${item.type==='checkbox'?'selected':''}>Checkbox</option>
        <option value="text" ${item.type==='text'?'selected':''}>Text input</option>
        <option value="image" ${item.type==='image'?'selected':''}>Image upload</option>
      </select>
      <span class="cl-move-group">
        <button class="pos-btn pos-btn-sm cl-move" data-move-phase="${phase}" data-move-idx="${i}" data-move-dir="up" ${i===0?'disabled':''} title="Move up" aria-label="Move item up">▲</button>
        <button class="pos-btn pos-btn-sm cl-move" data-move-phase="${phase}" data-move-idx="${i}" data-move-dir="down" ${last?'disabled':''} title="Move down" aria-label="Move item down">▼</button>
      </span>
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
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:16px">Toggle an item off to hide it from the POS open/close/handover flow without deleting it. Drag <span aria-hidden="true">⠿</span> or use ▲▼ to change the order items appear in on the POS — then Save Checklist.</p>
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

  // --- Reordering ---------------------------------------------------------
  // Order is purely array position (there is no sortOrder field), and the POS
  // renders the same array, so reordering is a splice + rerender. Nothing
  // persists until Save Checklist, exactly like label/type/enabled edits.

  // Move within one phase only. Each phase has its own container element, so a
  // row can never cross into another phase.
  function moveItem(phase, from, to){
    const list = listFor(phase);
    if (to < 0 || to >= list.length || from === to) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
    rerender();
  }

  container.querySelectorAll('.cl-move').forEach(btn=>{
    btn.onclick=()=>{
      const phase = btn.dataset.movePhase;
      const from = +btn.dataset.moveIdx;
      const to = btn.dataset.moveDir === 'up' ? from - 1 : from + 1;
      moveItem(phase, from, to);
      // rerender() replaced the DOM, so put focus back on the same arrow of the
      // row that just moved — lets a cashier tap ▲ repeatedly on the tablet.
      const moved = container.querySelector(
        `[data-move-phase="${phase}"][data-move-idx="${to}"][data-move-dir="${btn.dataset.moveDir}"]`);
      if (moved && !moved.disabled) moved.focus();
    };
  });

  // Drag-to-reorder using POINTER events, not HTML5 drag: native drag is
  // unreliable on the counter iPad. The gesture starts on the ⠿ handle only, so
  // selecting text in a row's label input never begins a drag.
  let drag = null;

  function renumber(parent){
    const rows = Array.from(parent.children);
    rows.forEach((row, i)=>{
      const num = row.querySelector('.cl-num');
      if (num) num.textContent = `${i+1}.`;
      const up = row.querySelector('[data-move-dir="up"]');
      const down = row.querySelector('[data-move-dir="down"]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === rows.length - 1;
    });
  }

  // Move the row in the DOM, then re-anchor the drag origin so the row stays
  // visually under the finger even though its layout position changed.
  function reanchor(e, move){
    const el = drag.el;
    const visualTop = el.getBoundingClientRect().top;
    el.style.transform = '';
    move();
    const naturalTop = el.getBoundingClientRect().top;
    drag.startY = e.clientY - (visualTop - naturalTop);
    el.style.transform = `translateY(${e.clientY - drag.startY}px)`;
    renumber(el.parentNode);
  }

  function onDragMove(e){
    if (!drag || e.pointerId !== drag.pointerId) return;
    const el = drag.el;
    const dy = e.clientY - drag.startY;
    if (!drag.active){
      if (Math.abs(dy) < 5) return;   // tap tolerance — a tap on the handle is a no-op
      drag.active = true;
      el.classList.add('is-dragging');
    }
    el.style.transform = `translateY(${dy}px)`;

    // Crossing a neighbour's midpoint moves the row one slot. The row gap gives
    // hysteresis, so it cannot oscillate between two slots.
    const rect = el.getBoundingClientRect();
    const prev = el.previousElementSibling;
    if (prev){
      const p = prev.getBoundingClientRect();
      if (rect.top < p.top + p.height / 2) return reanchor(e, ()=>el.parentNode.insertBefore(el, prev));
    }
    const next = el.nextElementSibling;
    if (next){
      const n = next.getBoundingClientRect();
      if (rect.bottom > n.bottom - n.height / 2) return reanchor(e, ()=>el.parentNode.insertBefore(el, next.nextSibling));
    }
  }

  function detachDrag(){
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragCancel);
  }

  function finishDrag(commit){
    const { el, handle, pointerId, phase, fromIdx, active } = drag;
    detachDrag();
    try{ handle.releasePointerCapture(pointerId); } catch(_){}
    el.style.transform = '';
    el.classList.remove('is-dragging');
    drag = null;
    if (!active) return;            // never moved — leave the DOM alone
    const toIdx = Array.from(el.parentNode.children).indexOf(el);
    if (commit && toIdx > -1 && toIdx !== fromIdx){
      const list = listFor(phase);
      list.splice(toIdx, 0, list.splice(fromIdx, 1)[0]);
    }
    // Rerender either way: on commit it refreshes data-idx/numbering, on cancel
    // it restores the DOM to match the arrays.
    rerender();
  }

  function onDragEnd(e){ if (drag && e.pointerId === drag.pointerId) finishDrag(true); }
  function onDragCancel(e){ if (drag && e.pointerId === drag.pointerId) finishDrag(false); }

  container.querySelectorAll('.cl-handle').forEach(handle=>{
    handle.addEventListener('pointerdown', e=>{
      if (drag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const el = handle.closest('[data-cl-row]');
      if (!el) return;
      e.preventDefault();           // no text selection, no iOS long-press menu
      drag = {
        handle, el, pointerId: e.pointerId,
        phase: handle.dataset.dragPhase,
        fromIdx: Array.from(el.parentNode.children).indexOf(el),
        startY: e.clientY,
        active: false,
      };
      try{ handle.setPointerCapture(e.pointerId); } catch(_){}
      // Listen on window as well so the gesture survives leaving the handle even
      // if pointer capture is unavailable.
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragEnd);
      window.addEventListener('pointercancel', onDragCancel);
    });
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

