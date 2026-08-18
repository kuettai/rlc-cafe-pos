// admin-checklist.js — Checklist configuration
// Depends on: admin.js (api, showError, showSuccess, $, escapeAttr)

// --- Checklist ---
//
// The baseline lives at MODULE level, not in the render closure: this tab
// re-renders its whole DOM on every reorder, add and remove, so a baseline
// captured at render time would keep resetting and the unsaved count would
// always read zero. Set once per load, from what the server actually holds.
let _clBaseline = null;

/** Comparable snapshot of the three lists — the shape the Save button sends. */
function clSnapshot(open, close, handover){
  const one = list => (list||[]).map(i=>({
    id: i.id || '', label: i.label || '', type: i.type || 'checkbox', enabled: i.enabled !== false,
  }));
  return { open: one(open), close: one(close), handover: one(handover) };
}

/**
 * Pending-change count for the leave guard and the save bar.
 *
 * Counted per FIELD, matched by item id, with a reorder counting as one change
 * for the whole phase — the generic index-wise counter would report moving one
 * row up as a dozen changes, which makes the number worthless.
 */
function countChecklistChanges(base, now){
  let n = 0;
  for (const phase of ['open','close','handover']) {
    const A = (base && base[phase]) || [];
    const B = (now && now[phase]) || [];
    const key = (it, i) => it.id || `@${i}`;
    const aBy = new Map(A.map((it,i)=>[key(it,i), it]));
    const bBy = new Map(B.map((it,i)=>[key(it,i), it]));
    for (const k of aBy.keys()) if (!bBy.has(k)) n++;               // removed
    for (const [k, b] of bBy) {
      const a = aBy.get(k);
      if (!a) { n++; continue; }                                    // added
      if (a.label !== b.label) n++;
      if (a.type !== b.type) n++;
      if (a.enabled !== b.enabled) n++;
    }
    // Order, over the rows both snapshots share, counted once.
    const aOrder = A.map(key).filter(k=>bBy.has(k)).join('|');
    const bOrder = B.map(key).filter(k=>aBy.has(k)).join('|');
    if (aOrder !== bOrder) n++;
  }
  return n;
}

async function loadChecklist(container){
  container.innerHTML = '<div class="loading">Loading checklist config...</div>';
  try{
    const data = await api('GET','/api/admin/checklist/config');
    _clBaseline = clSnapshot(data.open, data.close, data.handover);
    renderChecklistAdmin(container, data);
  } catch(e){
    _clBaseline = null;
    container.innerHTML = '<div class="admin-empty">'
      + '<p>Could not load the checklist configuration.</p>'
      + '<p style="font-size:.85rem">Your saved checklist is untouched — nothing was overwritten.</p>'
      + '<button class="pos-btn pos-btn-sm pos-btn-primary" id="clRetry">Try again</button></div>';
    const retry = container.querySelector('#clRetry');
    if (retry) retry.onclick = ()=> loadChecklist(container);
  }
}

function renderChecklistAdmin(container, config){
  // TWO LINES per row: the label input owns line 1 at full width, the controls
  // sit on line 2. `.cl-label{flex:1 1 180px}` left ~110px of visible text at
  // 1024x768, so not one of the 34 items could be read on the tab whose entire
  // purpose is editing their text.
  function renderPhase(phase, items){
    return items.map((item, i)=>{
      const enabled = item.enabled !== false;
      const last = i === items.length - 1;
      return `<div class="admin-card cl-row ${enabled?'':'is-disabled'}" data-cl-row>
      <div class="cl-line1">
        <span class="cl-handle" data-drag-phase="${phase}" title="Drag to reorder" aria-hidden="true">⠿</span>
        <span class="cl-num">${i+1}.</span>
        <input class="pos-input cl-label" value="${escapeAttr(item.label)}" data-phase="${phase}" data-idx="${i}" data-field="label" aria-label="Item ${i+1} label">
      </div>
      <div class="cl-line2">
        <select class="pos-input cl-type" data-phase="${phase}" data-idx="${i}" data-field="type" aria-label="Item ${i+1} response type">
          <option value="checkbox" ${item.type==='checkbox'?'selected':''}>Checkbox</option>
          <option value="text" ${item.type==='text'?'selected':''}>Text input</option>
          <option value="image" ${item.type==='image'?'selected':''}>Image upload</option>
        </select>
        <span class="cl-move-group">
          <button class="pos-btn pos-btn-sm cl-move" data-move-phase="${phase}" data-move-idx="${i}" data-move-dir="up" ${i===0?'disabled':''} title="Move up" aria-label="Move item up">▲</button>
          <button class="pos-btn pos-btn-sm cl-move" data-move-phase="${phase}" data-move-idx="${i}" data-move-dir="down" ${last?'disabled':''} title="Move down" aria-label="Move item down">▼</button>
        </span>
        <span class="cl-spacer"></span>
        <span class="cl-enable">
          <label class="toggle-switch" title="${enabled?'Shown on the POS — switch off to hide it without deleting it':'Hidden from the POS — switch on to show it'}">
            <input type="checkbox" data-phase="${phase}" data-idx="${i}" data-field="enabled" ${enabled?'checked':''} aria-label="Show item ${i+1} on the POS">
            <span class="toggle-slider"></span>
          </label>
          <span class="admin-sw-cap${enabled?'':' is-off'}">${enabled?'On the POS':'Hidden'}</span>
        </span>
        <button class="pos-btn pos-btn-sm admin-danger-quiet" data-remove-phase="${phase}" data-remove-idx="${i}">Remove</button>
      </div>
    </div>`;
    }).join('');
  }

  container.innerHTML = `<div class="admin-section">
    <div class="admin-section-header"><h2>✅ Checklist</h2></div>
    <p style="color:var(--ink-muted);font-size:.85rem;margin-bottom:16px;max-width:70ch">What the POS asks a volunteer to tick when opening, handing over and closing. Switch an item off to hide it without deleting it. Drag <span aria-hidden="true">⠿</span> or use ▲▼ to reorder. <strong>Nothing is written until you press Save.</strong></p>
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
      <p style="color:var(--ink-muted);font-size:.8rem;margin-bottom:8px">Shown to first-service staff before handing over to the second-service team.</p>
      <div id="handoverItems">${renderPhase('handover', config.handover||[])}</div>
      <button class="pos-btn pos-btn-sm" id="addHandoverItem" style="margin-top:10px">+ Add item</button>
    </div>
    <!-- Sticky: Save used to sit at the bottom of a 3943px page, with nothing
         anywhere on screen saying an edit was pending. -->
    <div class="admin-save-bar" data-save-state>
      <span class="admin-save-state" id="clSaveState">Everything saved.</span>
      <button class="pos-btn pos-btn-sm admin-danger-quiet" id="clDiscard" hidden>Discard changes</button>
      <button class="pos-btn pos-btn-primary pos-btn-sm" id="saveChecklist">Save Checklist</button>
    </div>
  </div>`;

  // Normalize: ensure every item has an 'enabled' field (default true) so the
  // toggle state round-trips even for legacy configs.
  let openItems = (config.open||[]).map(i=>({...i, enabled: i.enabled !== false}));
  let closeItems = (config.close||[]).map(i=>({...i, enabled: i.enabled !== false}));
  let handoverItems = (config.handover||[]).map(i=>({...i, enabled: i.enabled !== false}));

  const rerender = () => renderChecklistAdmin(container, {open:openItems, close:closeItems, handover:handoverItems});

  // ─── Unsaved work ───────────────────────────────────────────────────
  const snapshot = () => clSnapshot(openItems, closeItems, handoverItems);
  const saveBar = container.querySelector('[data-save-state]');
  const stateEl = container.querySelector('#clSaveState');
  const discardBtn = container.querySelector('#clDiscard');
  const saveBtn = container.querySelector('#saveChecklist');

  // renderUnsavedIndicators() calls this whenever the count may have moved.
  saveBar._render = (n)=>{
    stateEl.classList.toggle('is-dirty', n > 0);
    stateEl.innerHTML = n > 0
      ? `<strong>${n}</strong> unsaved change${n === 1 ? '' : 's'} — nothing is written yet.`
      : 'Everything saved.';
    discardBtn.hidden = n === 0;
    saveBtn.disabled = n === 0;
  };

  if (_clBaseline) {
    watchUnsaved({
      tab: 'checklist', label: 'Checklist',
      read: snapshot, count: countChecklistChanges, baseline: _clBaseline,
      save: ()=> saveChecklistNow(),
    });
  }
  // Typing a label or flipping a type is a change; keep the count live.
  container.addEventListener('input', renderUnsavedIndicators);
  container.addEventListener('change', renderUnsavedIndicators);
  renderUnsavedIndicators();

  discardBtn.onclick = ()=>{
    if (!_clBaseline) return;
    if (!confirm(`Discard ${countChecklistChanges(_clBaseline, snapshot())} unsaved change(s) and go back to the saved checklist?`)) return;
    renderChecklistAdmin(container, {
      open: _clBaseline.open.map(i=>({...i})),
      close: _clBaseline.close.map(i=>({...i})),
      handover: _clBaseline.handover.map(i=>({...i})),
    });
  };

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

  // Remove takes TWO taps. It used to splice the row on a single tap — no
  // confirm, no undo, 34 of them, six pixels from the enable toggle, on a
  // tablet. A dialog per row would be 34 dialogs, so the button arms itself
  // instead and disarms after four seconds.
  const disarmRemove = (b)=>{
    clearTimeout(b._armTimer);
    delete b.dataset.armed;
    b.classList.remove('admin-danger-armed');
    b.classList.add('admin-danger-quiet');
    b.textContent = 'Remove';
  };
  container.querySelectorAll('[data-remove-phase]').forEach(btn=>{
    btn.onclick=()=>{
      const phase = btn.dataset.removePhase;
      const idx = +btn.dataset.removeIdx;
      if (btn.dataset.armed === '1') {
        clearTimeout(btn._armTimer);
        listFor(phase).splice(idx,1);
        rerender();
        return;
      }
      container.querySelectorAll('[data-remove-phase][data-armed="1"]').forEach(disarmRemove);
      btn.dataset.armed = '1';
      btn.classList.remove('admin-danger-quiet');
      btn.classList.add('admin-danger-armed');
      btn.textContent = 'Remove — tap again';
      btn._armTimer = setTimeout(()=>disarmRemove(btn), 4000);
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
      // Re-render so the tinted styling reflects the new state
      rerender();
    };
  });

  /**
   * Write the three lists. Returns true only when the PUT landed, so the leave
   * guard's "Save, then leave" can refuse to leave on failure — that guard is
   * the last thing between the operator and losing the work.
   */
  async function saveChecklistNow(){
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
      // The saved lists are the new baseline — module level, so the next
      // re-render does not resurrect the old count. Re-rendering from them also
      // drops the blank rows `cleanList` just discarded, so the screen shows
      // exactly what the POS will now ask for.
      _clBaseline = clSnapshot(open, close, handover);
      showSuccess('Checklist saved');
      renderChecklistAdmin(container, {
        open: _clBaseline.open.map(i=>({...i})),
        close: _clBaseline.close.map(i=>({...i})),
        handover: _clBaseline.handover.map(i=>({...i})),
      });
      return true;
    } catch(e){
      showError('Could not save the checklist — your edits are still on screen');
      return false;
    }
  }

  saveBtn.onclick = ()=> saveChecklistNow();
}

