// pos-stock.js — Stock count GUI (manual + planogram)
// Depends on: pos.js (api, showError, showSuccessToast)

// --- Manual Stock Count GUI ---
// Cashier flow: pick a location (or ALL), see current stock for every
// ingredient, adjust with +/- or direct entry, hit Save. Backend persists
// new counts and records a snapshot for admin backtrace.
async function openManualStockCount(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:640px;max-height:90vh;display:flex;flex-direction:column;padding:0">
    <div style="padding:16px 20px;border-bottom:1px solid var(--cream-dark,#E7DFD5);display:flex;justify-content:space-between;align-items:center;gap:12px">
      <h3 style="margin:0">📦 Stock Count</h3>
      <button class="pos-modal-close" id="mscClose" style="position:static">✕</button>
    </div>
    <div style="padding:12px 20px;border-bottom:1px solid var(--cream-dark,#E7DFD5);display:flex;gap:8px;flex-wrap:wrap" id="mscFilters">
      <button class="pos-btn pos-btn-sm pos-btn-primary" data-msc-loc="ALL">All</button>
      <button class="pos-btn pos-btn-sm" data-msc-loc="FRIDGE">🧊 Fridge</button>
      <button class="pos-btn pos-btn-sm" data-msc-loc="STOREROOM">🗄️ Storeroom</button>
    </div>
    <div id="mscBody" style="flex:1;overflow-y:auto;padding:12px 20px">
      <div class="loading">Loading ingredients…</div>
    </div>
    <div style="padding:14px 20px;border-top:1px solid var(--cream-dark,#E7DFD5);display:flex;justify-content:space-between;align-items:center;gap:12px">
      <span id="mscHint" style="font-size:.8rem;color:var(--text-light,#7A6355)"></span>
      <button class="pos-btn pos-btn-primary pos-btn-lg" id="mscSave" disabled>Save Stock Count</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#mscClose').onclick = ()=> modal.remove();
  modal.onclick = e => { if(e.target === modal) modal.remove(); };

  let ingredients = [];
  let filter = 'ALL';
  // Working values, keyed by ingredientId. Populated from currentStock on
  // load; +/- and direct entry mutate this map only. Save reads it back.
  const workingCounts = {};
  // Track which ids have been touched, so hint can show diff count.
  const dirty = new Set();

  try {
    const data = await api('GET','/api/pos/ingredients');
    ingredients = data.ingredients || [];
    for (const ing of ingredients) workingCounts[ing.ingredientId] = ing.currentStock;
  } catch (e) {
    modal.querySelector('#mscBody').innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger,#B00020)">Failed to load ingredients</div>';
    return;
  }

  function stepFor(unit){
    // Fractional units (bottles, liters) get 0.5 step; discrete/gram units get 1.
    const u = (unit || '').toLowerCase();
    if (u === 'bottle' || u === 'bottles' || u === 'l' || u === 'liter' || u === 'liters') return 0.5;
    return 1;
  }

  function render(){
    const body = modal.querySelector('#mscBody');
    // Items marked BOTH appear under either Fridge or Storeroom filter (and ALL).
    const filtered = filter === 'ALL'
      ? ingredients
      : ingredients.filter(i => {
          const loc = i.storageLocation || '';
          return loc === filter || loc === 'BOTH';
        });
    // Disabled ingredients (isActive === false) sink to the bottom. Cashiers
    // can still count them (they're not removed from stock physically),
    // but they're visually muted.
    const sorted = filtered.slice().sort((a, b) => {
      const aA = a.isActive !== false ? 0 : 1;
      const bA = b.isActive !== false ? 0 : 1;
      return aA - bA;
    });
    if (!sorted.length){
      body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-light,#7A6355)">No ingredients in this location</div>';
      updateSaveState();
      return;
    }
    body.innerHTML = sorted.map(ing => {
      const val = workingCounts[ing.ingredientId];
      const step = stepFor(ing.unit);
      const isDirty = dirty.has(ing.ingredientId);
      const isActive = ing.isActive !== false;
      const last = ing.lastCountedAt ? `<div style="font-size:.7rem;color:var(--text-light,#7A6355);margin-top:2px">Last: ${new Date(ing.lastCountedAt).toLocaleString()}${ing.lastCountedBy?' by '+escapeHtmlPos(ing.lastCountedBy):''}</div>` : '';
      const disabledTag = isActive ? '' : ' <span style="font-size:.7rem;background:var(--danger-bg,#fef2f2);color:var(--danger,#C0392B);padding:1px 6px;border-radius:999px;font-weight:600">disabled</span>';
      return `<div class="msc-row${isActive ? '' : ' msc-row-disabled'}" data-id="${escapeHtmlPos(ing.ingredientId)}" style="padding:12px 0;border-bottom:1px solid #f0ebe4;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;${isActive?'':'opacity:.55'}">
        <div style="min-width:0">
          <div style="font-weight:600;color:${isDirty?'var(--primary,#6B4226)':'inherit'}">${escapeHtmlPos(ing.name)}${disabledTag} ${isDirty?'<span style="font-size:.7rem;color:var(--primary,#6B4226)">•edited</span>':''}</div>
          <div style="font-size:.75rem;color:var(--text-light,#7A6355)">${escapeHtmlPos(ing.storageLocation||'—')}</div>
          ${last}
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button class="pos-btn pos-btn-sm msc-dec" data-step="${step}" aria-label="Decrease">−</button>
          <input class="pos-input msc-input" type="number" inputmode="decimal" step="${step}" min="0" value="${val}" style="width:80px;text-align:center;margin:0" aria-label="${escapeHtmlPos(ing.name)} count">
          <button class="pos-btn pos-btn-sm msc-inc" data-step="${step}" aria-label="Increase">+</button>
          <span style="font-size:.8rem;color:var(--text-light,#7A6355);min-width:52px">${escapeHtmlPos(ing.unit||'')}</span>
        </div>
      </div>`;
    }).join('');

    // Wire up controls
    body.querySelectorAll('.msc-row').forEach(row => {
      const id = row.dataset.id;
      const input = row.querySelector('.msc-input');
      const dec = row.querySelector('.msc-dec');
      const inc = row.querySelector('.msc-inc');

      function commit(newVal){
        const n = Math.max(0, Number(newVal));
        if (!isFinite(n)) return;
        // Round to 2dp to avoid float drift (e.g., 0.1+0.2)
        workingCounts[id] = Math.round(n * 100) / 100;
        input.value = workingCounts[id];
        // Original = the loaded currentStock for that ingredient
        const original = ingredients.find(i => i.ingredientId === id)?.currentStock;
        if (workingCounts[id] !== original) dirty.add(id); else dirty.delete(id);
        // Update the "•edited" marker without a full re-render
        const marker = row.querySelector('span[style*="•edited"]');
        const title = row.querySelector('div[style^="font-weight"]');
        if (title){
          const isD = dirty.has(id);
          title.style.color = isD ? 'var(--primary,#6B4226)' : 'inherit';
          title.innerHTML = escapeHtmlPos(ingredients.find(i => i.ingredientId === id)?.name || '') +
            (isD ? ' <span style="font-size:.7rem;color:var(--primary,#6B4226)">•edited</span>' : '');
        }
        void marker; // (no-op — marker refreshed via innerHTML above)
        updateSaveState();
      }

      dec.onclick = ()=> commit(workingCounts[id] - Number(dec.dataset.step || 1));
      inc.onclick = ()=> commit(workingCounts[id] + Number(inc.dataset.step || 1));
      input.oninput = ()=> commit(input.value);
    });
    updateSaveState();
  }

  function updateSaveState(){
    const btn = modal.querySelector('#mscSave');
    const hint = modal.querySelector('#mscHint');
    if (dirty.size === 0){
      btn.disabled = false; // still allow save-all if user just wants to log a snapshot
      btn.textContent = 'Save Stock Count';
      hint.textContent = 'No changes yet';
    } else {
      btn.disabled = false;
      btn.textContent = `Save Stock Count (${dirty.size} changed)`;
      hint.textContent = `${dirty.size} item${dirty.size===1?'':'s'} changed`;
    }
  }

  // Filter buttons
  modal.querySelectorAll('[data-msc-loc]').forEach(btn => {
    btn.onclick = ()=>{
      filter = btn.dataset.mscLoc;
      modal.querySelectorAll('[data-msc-loc]').forEach(b => b.classList.toggle('pos-btn-primary', b.dataset.mscLoc === filter));
      render();
    };
  });

  modal.querySelector('#mscSave').onclick = async ()=>{
    const btn = modal.querySelector('#mscSave');
    // Send ALL counts (simpler, backend overwrites). Snapshot captures the
    // full picture at this point in time, which is what admin history needs.
    const counts = ingredients.map(i => ({ ingredientId: i.ingredientId, count: workingCounts[i.ingredientId] }));
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const result = await api('PUT','/api/pos/ingredients/bulk-update', { counts });
      showSuccessToast(`Stock count saved (${result.updated || counts.length} items)`);
      modal.remove();
    } catch (e){
      btn.disabled = false;
      btn.textContent = 'Save Stock Count';
      showError('Failed to save stock count');
    }
  };

  render();
}

// --- Planogram Stock Count ---
async function openStockCount(location){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:560px">
    <button class="pos-modal-close">✕</button>
    <h3>📷 Stock Count — ${location === 'fridge' ? 'Fridge' : 'Storeroom'}</h3>
    <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:8px 0 16px">Take 1-3 photos. AI will count your stock.</p>
    <div id="stockPhotos" class="stock-photos"></div>
    <div style="display:flex;gap:10px;margin:16px 0">
      <label class="pos-btn pos-btn-primary" for="stockCameraInput" style="flex:1;text-align:center;cursor:pointer">📷 Take Photo</label>
      <input type="file" id="stockCameraInput" accept="image/*" capture="environment" style="display:none" multiple>
    </div>
    <button id="stockAnalyze" class="pos-btn pos-btn-primary pos-btn-lg" disabled style="width:100%">Analyze Stock</button>
    <div id="stockResults"></div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

  let photos = [];

  modal.querySelector('#stockCameraInput').onchange = (e)=>{
    const files = Array.from(e.target.files);
    files.forEach(file=>{
      const reader = new FileReader();
      reader.onload = ()=>{
        photos.push(reader.result);
        renderPhotos();
      };
      reader.readAsDataURL(file);
    });
  };

  function renderPhotos(){
    const container = modal.querySelector('#stockPhotos');
    container.innerHTML = photos.map((p,i)=>`<div class="stock-photo-thumb">
      <img src="${p}" alt="Photo ${i+1}">
      <button data-remove-photo="${i}">✕</button>
    </div>`).join('') || '<p style="color:var(--text-light,#7A6355);text-align:center">No photos yet</p>';
    container.querySelectorAll('[data-remove-photo]').forEach(btn=>btn.onclick=()=>{
      photos.splice(+btn.dataset.removePhoto, 1);
      renderPhotos();
    });
    modal.querySelector('#stockAnalyze').disabled = photos.length === 0;
  }

  modal.querySelector('#stockAnalyze').onclick = async()=>{
    const btn = modal.querySelector('#stockAnalyze');
    const resultsEl = modal.querySelector('#stockResults');
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    resultsEl.innerHTML = '<p style="text-align:center;color:var(--primary,#6B4226)">🤖 AI is counting your stock...</p>';

    try{
      const data = await api('POST','/api/pos/planogram/analyze',{ location, images: photos });
      const counts = data.counts || [];
      const ingredients = data.ingredients || [];
      const logId = data.logId || null;

      let html = '<div class="stock-results-list"><h4 style="margin:16px 0 12px;color:var(--primary,#6B4226)">Results — adjust if needed</h4>';
      counts.forEach((item,i)=>{
        const match = ingredients.find(ing=>ing.name.toLowerCase().includes(item.name.toLowerCase()));
        const confidence = item.confidence === 'high' ? '🟢' : item.confidence === 'medium' ? '🟡' : '🔴';
        html += `<div class="stock-result-row">
          <span class="stock-result-name">${confidence} ${item.name}</span>
          <input type="number" step="0.1" class="stock-result-input" value="${item.count}" data-idx="${i}" data-ing-id="${match?.ingredientId||''}">
          ${item.notes ? `<span class="stock-result-note">${item.notes}</span>` : ''}
        </div>`;
      });
      html += `<button id="stockConfirm" class="pos-btn pos-btn-primary pos-btn-lg" style="width:100%;margin-top:16px">✓ Confirm & Save</button></div>`;
      resultsEl.innerHTML = html;
      btn.textContent = 'Re-analyze';
      btn.disabled = false;

      resultsEl.querySelector('#stockConfirm').onclick = async()=>{
        const inputs = resultsEl.querySelectorAll('.stock-result-input');
        const updates = [];
        inputs.forEach(inp=>{
          if(inp.dataset.ingId) updates.push({ ingredientId: inp.dataset.ingId, count: +inp.value });
        });
        try{
          await api('POST','/api/pos/planogram/confirm',{ counts: updates, logId });
          showError(''); // clear any error
          modal.querySelector('.pos-modal').innerHTML = `<div style="text-align:center;padding:40px"><div style="font-size:2rem;margin-bottom:12px">✅</div><h3 style="color:var(--primary,#6B4226)">Stock Updated!</h3><p style="color:var(--text-light,#7A6355);margin-top:8px">${updates.length} items saved</p><button class="pos-btn pos-btn-primary" id="stockDone" style="margin-top:20px">Done</button></div>`;
          modal.querySelector('#stockDone').onclick=()=>modal.remove();
        } catch(e){ showError('Failed to save stock'); }
      };
    } catch(e){
      resultsEl.innerHTML = `<p style="color:var(--danger,#C0392B);text-align:center">Failed to analyze. Please try again.</p>`;
      btn.textContent = 'Retry Analysis';
      btn.disabled = false;
    }
  };

  renderPhotos();
}

