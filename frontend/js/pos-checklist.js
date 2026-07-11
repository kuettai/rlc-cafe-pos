// pos-checklist.js — Checklist + handover modal
// Depends on: pos.js (api, showError, renderMain, cafeOpen)

// --- Cafe toggle with checklist ---
async function toggleCafe(){
  const phase = cafeOpen ? 'close' : 'open';
  openChecklist(phase);
}

async function showShiftSummary(){
  try{
    const data = await api('GET','/api/pos/shift-summary');
    const modal = document.createElement('div');
    modal.className = 'pos-modal-overlay';
    modal.innerHTML = `<div class="pos-modal" style="max-width:360px;text-align:center">
      <h3 style="font-size:1.5rem;margin-bottom:8px">🎉 Great shift!</h3>
      <div style="border-top:2px solid var(--cream-dark,#eee);border-bottom:2px solid var(--cream-dark,#eee);padding:16px 0;margin:12px 0;text-align:left;font-size:1rem;line-height:2">
        <div>Orders processed: <strong>${data.totalOrders}</strong></div>
        <div>Revenue: <strong>RM ${data.totalRevenue}</strong></div>
        <div>Newcomers served: <strong>${data.newcomersServed}</strong> 🙏</div>
        <div>Most popular: <strong>☕ ${data.peakItem}</strong></div>
      </div>
      <p style="color:var(--text-light,#7A6355);margin-bottom:16px">See you next Sunday!</p>
      <button class="pos-btn pos-btn-primary" id="shiftSummaryClose">Close</button>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#shiftSummaryClose').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
  } catch(e){}
}

async function openChecklist(phase){
  let data;
  try{ data = await api('GET','/api/pos/checklist'); } catch(e){ showError('Failed to load checklist'); return; }
  const config = data.config || { open: [], close: [], handover: [] };
  const log = data.log || { open: { items: {} }, close: { items: {} }, handover: { items: {} } };
  const items = phase === 'open' ? config.open : phase === 'close' ? config.close : (config.handover || []);
  const checked = log[phase]?.items || {};

  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';

  function titleFor(p){
    if(p === 'open') return '☀️ Open Café Checklist';
    if(p === 'close') return '🌙 Close Café Checklist';
    return '🔄 Session Handover';
  }
  function submitLabelFor(p){
    if(p === 'open') return '☀️ Open Café';
    if(p === 'close') return '🌙 Close Café';
    return '🔄 Complete Handover';
  }
  function subtitleFor(p){
    if(p === 'open') return 'Complete all items before opening';
    if(p === 'close') return 'Complete all items before closing';
    return 'Complete all items to hand over to the next service team';
  }

  function renderChecklistModal(){
    const allChecked = items.length > 0 && items.every(i => checked[i.id]?.checked);
    modal.innerHTML = `<div class="pos-modal" style="max-width:520px">
      <button class="pos-modal-close">✕</button>
      <h3>${titleFor(phase)}</h3>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:8px 0 16px">${subtitleFor(phase)}</p>
      <div class="checklist-items">
        ${items.map(item => {
          const isDone = checked[item.id]?.checked;
          const doneBy = checked[item.id]?.completedBy;
          const doneAt = checked[item.id]?.completedAt;
          const timeStr = doneAt ? new Date(doneAt).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit'}) : '';
          return `<div class="checklist-row ${isDone?'done':''}">
            <label class="checklist-label">
              <input type="checkbox" data-item-id="${item.id}" ${isDone?'checked':''}>
              <span>${item.name || item.label}</span>
              ${item.type === 'image' ? '<span class="checklist-badge">📷</span>' : ''}
              ${item.type === 'text' ? '<span class="checklist-badge">✏️</span>' : ''}
            </label>
            ${isDone ? `<span class="checklist-meta">${doneBy} · ${timeStr}</span>` : ''}
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:20px;display:flex;gap:10px">
        <button id="clSubmit" class="pos-btn pos-btn-primary pos-btn-lg" ${allChecked?'':'disabled'}>
          ${submitLabelFor(phase)}
        </button>
        <button id="clCancel" class="pos-btn pos-btn-lg">Cancel</button>
      </div>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.querySelector('#clCancel').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

    modal.querySelectorAll('input[type=checkbox]').forEach(cb=>{
      cb.onchange=async()=>{
        const itemId = cb.dataset.itemId;
        const item = items.find(i=>i.id===itemId);
        if(cb.checked){
          if(item.type === 'image'){
            cb.checked = false;
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.capture = 'environment';
            fileInput.onchange = async () => {
              if(!fileInput.files?.length) return;
              checked[itemId] = { checked: true, completedBy: currentUser, completedAt: new Date().toISOString() };
              api('PUT','/api/pos/checklist/check',{ phase, itemId, completedBy: currentUser }).catch(()=>{});
              cb.checked = true;
              const row = cb.closest('.checklist-row');
              row.classList.add('done');
              const allChecked = items.every(i => checked[i.id]?.checked);
              const submitBtn = modal.querySelector('#clSubmit');
              if(submitBtn) submitBtn.disabled = !allChecked;
            };
            fileInput.click();
            return;
          }
          try{
            await api('PUT','/api/pos/checklist/check',{ phase, itemId, completedBy: currentUser });
            checked[itemId] = { checked: true, completedBy: currentUser, completedAt: new Date().toISOString() };
          } catch(e){ cb.checked = false; showError('Failed to save'); return; }
        } else {
          try{
            await api('PUT','/api/pos/checklist/uncheck',{ phase, itemId });
            delete checked[itemId];
          } catch(e){ cb.checked = true; showError('Failed to save'); return; }
        }
        const allChecked = items.every(i => checked[i.id]?.checked);
        const submitBtn = modal.querySelector('#clSubmit');
        if(submitBtn) submitBtn.disabled = !allChecked;
        const row = cb.closest('.checklist-row');
        if(cb.checked){ row.classList.add('done'); } else { row.classList.remove('done'); }
      };
    });

    const submitBtn = modal.querySelector('#clSubmit');
    if(submitBtn) submitBtn.onclick=async()=>{
      if(phase === 'handover'){
        // Handover: no cafe state change, just confirm + logout.
        submitBtn.disabled = true;
        submitBtn.textContent = 'Handover complete. Logging out...';
        setTimeout(()=>{
          modal.remove();
          logout();
        }, 900);
        return;
      }
      if(phase === 'close'){
        const activeCount = orders.filter(o=>o.status==='PENDING'||o.status==='PREPARING').length;
        if(activeCount > 0 && !confirm(`This will expire ${activeCount} active order(s). Continue?`)) return;
      }
      try{
        cafeOpen = phase === 'open';
        await api('PUT',`/api/pos/cafe/${phase}`);
        modal.remove();
        if(phase === 'close') await showShiftSummary();
        renderMain();
      } catch(e){ cafeOpen = !cafeOpen; showError('Failed to toggle café'); }
    };
  }

  renderChecklistModal();
  document.body.appendChild(modal);
}

