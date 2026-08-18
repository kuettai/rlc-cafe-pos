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

  // How many are still outstanding. One helper, so the progress counter, the submit
  // label, the hint and the enabled state can never quote different numbers.
  function outstanding(){ return items.filter(i => !checked[i.id]?.checked).length; }

  /**
   * Is the phase complete?
   *
   * `items.length > 0 &&` is the load-bearing half. Without it an EMPTY config —
   * a settings record that was never seeded, or one wiped by an admin edit —
   * makes `[].every(...)` return true, so the button enables with nothing to
   * check. WITH it, an empty config disables ☀️ Open Café forever and the café
   * cannot be opened at all, with no message explaining why: the modal is simply
   * an empty box and a dead button. Both branches are wrong, so the length is
   * now checked SEPARATELY (see `configMissing` below) and reported.
   */
  function allDone(){ return items.length > 0 && outstanding() === 0; }
  const configMissing = items.length === 0;

  function renderChecklistModal(){
    const done = items.length - outstanding();
    const left = outstanding();
    const pct = items.length ? Math.round(done / items.length * 100) : 0;
    const submitLabel = configMissing
      ? submitLabelFor(phase)
      : `${submitLabelFor(phase)}${left ? ` — ${left} item${left>1?'s':''} left` : ''}`;
    modal.innerHTML = `<div class="pos-modal pos-modal-checklist" style="max-width:560px">
      <button class="pos-modal-close">✕</button>
      <h3>${titleFor(phase)}</h3>
      <p style="font-size:.85rem;color:var(--ink-muted);margin:8px 0 14px">${subtitleFor(phase)}</p>
      ${configMissing ? '' : `
      <!-- How many are done, as a number AND as a bar. The list is 12 items on the
           open phase and only ~8 fitted the old panel, so "have I finished?" was a
           question the panel could not answer. -->
      <div class="checklist-progress">
        <span class="pos-cl-count">${done} of ${items.length} done</span>
        <span class="pos-cl-track" role="progressbar" aria-valuenow="${done}" aria-valuemin="0" aria-valuemax="${items.length}"><span class="pos-cl-fill" style="--cl-progress:${(pct / 100).toFixed(4)}"></span></span>
      </div>`}
      <div class="checklist-items" id="clScroll">
        ${configMissing ? `<p style="padding:18px 4px;font-size:.9rem;color:var(--stale-ink);font-weight:700">
          ⚠️ No ${phase} checklist is configured, so there is nothing to tick. An admin
          needs to add the items under Admin → Checklists. Until then use the button
          below — it is not gated on a list that does not exist.
        </p>` : items.map(item => {
          const isDone = checked[item.id]?.checked;
          const doneBy = checked[item.id]?.completedBy;
          const doneAt = checked[item.id]?.completedAt;
          const timeStr = doneAt ? new Date(doneAt).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit'}) : '';
          return `<div class="checklist-row ${isDone?'done':''}" data-row-id="${escapeHtmlPos(item.id)}">
            <label class="checklist-label">
              <input type="checkbox" data-item-id="${escapeHtmlPos(item.id)}" ${isDone?'checked':''}>
              <span>${escapeHtmlPos(item.name || item.label)}</span>
              ${item.type === 'image' ? '<span class="checklist-badge">📷</span>' : ''}
              ${item.type === 'text' ? '<span class="checklist-badge">✏️</span>' : ''}
            </label>
            ${isDone ? `<span class="checklist-meta">${escapeHtmlPos(doneBy)} · ${escapeHtmlPos(timeStr)}</span>` : ''}
          </div>`;
        }).join('')}
      </div>
      ${configMissing ? '' : '<div class="checklist-more" id="clMore" aria-hidden="true"></div>'}
      <div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:10px">
        <!-- NOT disabled, and not aria-disabled either. A disabled button cannot
             receive a click, so tapping it with items outstanding did literally
             nothing and gave no reason - which is the whole complaint. aria-disabled
             only moves the lie: assistive tech (and Playwright) would still announce
             it as unavailable while it responds to a tap.
             So it is an ENABLED button that reports its own blocker: the label names
             the count, .is-blocked gives it the inert appearance, aria-describedby
             points at the hint so the reason is announced, and a tap scrolls to and
             highlights the first item still to do. -->
        <button id="clSubmit" class="pos-btn pos-btn-primary pos-btn-lg${allDone() || configMissing ? '' : ' is-blocked'}"
          style="flex:1 1 240px" aria-describedby="clHint">
          ${submitLabel}
        </button>
        <button id="clCancel" class="pos-btn pos-btn-lg" style="flex:0 0 auto">Cancel</button>
        <p class="checklist-hint" id="clHint">${
          configMissing ? 'Nothing to tick — the list is empty.'
          : left ? `Tick the last ${left} item${left>1?'s':''} and this button turns on.`
          : 'All done — tap to continue.'
        }</p>
      </div>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.querySelector('#clCancel').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

    // "There is more below", with an honest count, worded so it cannot be misread
    // as the "items left" number on the submit button. Four of twelve items were
    // off-screen with nothing saying so — and the hidden four included "Enable menu
    // items & food quantities in POS", i.e. the café could be opened with the menu
    // switched off.
    const scroller = modal.querySelector('#clScroll');
    const more = modal.querySelector('#clMore');
    if(scroller && more){
      const updateMore = ()=>{
        const hiddenPx = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        const rows = [...scroller.querySelectorAll('.checklist-row')];
        // Measured against the scrollport's own rect, NOT `offsetTop`: the rows'
        // offsetParent is the positioned .pos-modal, so offsetTop is unrelated to
        // scrollTop and the count came out as zero every time. Rects also mean rows
        // that wrap to two lines on a narrow tablet are counted correctly, which a
        // fixed row-height divisor would not manage.
        const port = scroller.getBoundingClientRect();
        const hidden = rows.filter(r => r.getBoundingClientRect().bottom > port.bottom + 1).length;
        if(hiddenPx > 2 && hidden > 0){
          more.textContent = `▼ Scroll down — ${hidden} more below`;
          more.classList.remove('is-end');
        } else {
          more.textContent = '▲ End of the list';
          more.classList.add('is-end');
        }
      };
      scroller.addEventListener('scroll', updateMore);
      // On the FIRST render the modal has not been appended to the document yet
      // (see the tail of openChecklist), so every rect is 0×0 and the affordance
      // read "End of the list" over a list with six items below the fold. Measure
      // once now for the re-render case and again after layout for the first.
      updateMore();
      requestAnimationFrame(updateMore);
      // Rows wrap differently once the fonts settle and the modal can be resized
      // by the on-screen keyboard on a tablet.
      if(typeof ResizeObserver === 'function'){
        new ResizeObserver(updateMore).observe(scroller);
      }
    }

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
              // Full re-render: the counter, the progress bar, the submit label and
              // the "N more below" line all have to move together, and patching four
              // nodes by hand is how they drift apart.
              renderChecklistModal();
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
        // Re-render so the count, the bar, the label and the scroll affordance all
        // agree. The scroll position is restored below so the list does not jump
        // back to the top after every tick.
        const keepScroll = scroller ? scroller.scrollTop : 0;
        renderChecklistModal();
        const again = modal.querySelector('#clScroll');
        if(again) again.scrollTop = keepScroll;
      };
    });

    // Scroll to the first outstanding item and flash it. Called when the submit is
    // tapped while still blocked — instead of the tap being swallowed.
    function nudgeFirstOutstanding(){
      const firstId = (items.find(i => !checked[i.id]?.checked) || {}).id;
      const row = firstId != null
        ? modal.querySelector(`.checklist-row[data-row-id="${CSS.escape(String(firstId))}"]`)
        : null;
      if(row){
        row.scrollIntoView({ block: 'center' });
        row.classList.add('is-nudge');
        setTimeout(()=> row.classList.remove('is-nudge'), 1600);
      }
      const hint = modal.querySelector('#clHint');
      const left = outstanding();
      if(hint) hint.textContent =
        `Not yet — ${left} item${left>1?'s':''} still to do. The next one is highlighted above.`;
    }

    const submitBtn = modal.querySelector('#clSubmit');
    if(submitBtn) submitBtn.onclick=async()=>{
      // Blocked, but answering — the button is genuinely enabled so the tap lands.
      if(submitBtn.classList.contains('is-blocked')){ nudgeFirstOutstanding(); return; }
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

