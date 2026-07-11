// pos-voucher.js — Voucher redemption flow
// Depends on: pos.js (api, showError, fetchOrders, showSuccessToast, escapeHtmlPos)

// --- Voucher redemption (cashier-driven) ---
//
// Single re-rendering modal that walks the cashier through three steps:
//   1. phone entry
//   2. voucher list (eligible + past) for that phone
//   3. menu picker (filtered to drinks or food per voucher type) + variant picker
//
// All UI state is local to the modal — closing it cleanly resets everything.
function openVoucherFlow(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  document.body.appendChild(modal);

  const state = {
    step: 'phone',     // 'phone' | 'list' | 'pick' | 'summary'
    rawPhone: '',
    phone: '',
    customerName: '',
    eligible: [],
    past: [],
    selectedVoucher: null,
    allMenuItems: [],  // full menu fetched once when a voucher is chosen
    // For single-item vouchers: slots=[{category:'DRINK'|'FOOD',label}], picks length 1.
    // For FREE_COMBO: slots=[{category:'DRINK',label:'drink'},{category:'FOOD',label:'food'}].
    slots: [],
    picks: [],         // parallel to slots — { menuItem, selectedVariants } | null
    pickIndex: 0,
  };

  modal.onclick = e => { if(e.target === modal) modal.remove(); };

  function setStep(step){ state.step = step; render(); }

  function render(){
    if(state.step === 'phone')   return renderPhone();
    if(state.step === 'list')    return renderList();
    if(state.step === 'pick')    return renderPick();
    if(state.step === 'summary') return renderSummary();
  }

  // ── Step 1: phone entry ──────────────────────────────────────────
  function renderPhone(){
    modal.innerHTML = `<div class="pos-modal" style="max-width:420px">
      <button class="pos-modal-close">✕</button>
      <h3>🎟️ Redeem Voucher</h3>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:8px 0 14px">
        Enter the customer's phone number to look up their vouchers.
      </p>
      <input id="vfPhone" type="tel" inputmode="tel" autocomplete="off"
             class="pos-input" placeholder="0168089999"
             value="${state.rawPhone}" style="margin-bottom:12px">
      <button id="vfLookup" class="pos-btn pos-btn-primary pos-btn-lg" style="width:100%">Look up</button>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    const phoneInput = modal.querySelector('#vfPhone');
    phoneInput.focus();
    phoneInput.select();

    const submit = async ()=>{
      const raw = phoneInput.value.trim();
      if(!raw){ showError('Phone number required'); return; }
      const normalized = (typeof window.normalizePhone === 'function')
        ? window.normalizePhone(raw)
        : raw.replace(/[^0-9]/g, '');
      if(!normalized){ showError('Invalid phone number'); return; }
      state.rawPhone = raw;
      state.phone = normalized;
      await lookupVouchers();
    };

    modal.querySelector('#vfLookup').onclick = submit;
    phoneInput.onkeydown = (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); submit(); } };
  }

  async function lookupVouchers(){
    modal.innerHTML = `<div class="pos-modal" style="max-width:420px;text-align:center">
      <p style="margin:24px 0;color:var(--text-light,#7A6355)">Looking up vouchers…</p>
    </div>`;
    try{
      const data = await api('GET', `/api/pos/vouchers/${encodeURIComponent(state.phone)}`);
      state.eligible = data.eligible || [];
      state.past = data.past || [];
      state.customerName = (state.eligible[0]?.name) || (state.past[0]?.name) || '';
      setStep('list');
    } catch(e){
      showError('Failed to look up vouchers');
      setStep('phone');
    }
  }

  // ── Step 2: voucher list ─────────────────────────────────────────
  function renderList(){
    const eligibleHtml = state.eligible.length
      ? state.eligible.map(v => voucherCardHtml(v, true)).join('')
      : '<p style="text-align:center;color:var(--text-light,#7A6355);padding:16px 0;font-size:.9rem">No eligible vouchers.</p>';

    const pastHtml = state.past.length
      ? `<h4 style="margin:20px 0 8px;color:var(--text-light,#7A6355);font-size:.9rem">Past (${state.past.length})</h4>` +
        state.past.map(v => voucherCardHtml(v, false)).join('')
      : '';

    const headline = state.customerName
      ? `${state.phone} · ${escapeHtmlPos(state.customerName)}`
      : state.phone;

    modal.innerHTML = `<div class="pos-modal" style="max-width:520px;max-height:85vh;overflow-y:auto">
      <button class="pos-modal-close">✕</button>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <button class="pos-btn pos-btn-sm pos-btn-outline" id="vfBack">← Back</button>
        <h3 style="margin:0;flex:1">${headline}</h3>
      </div>
      ${state.eligible.length === 0 && state.past.length === 0
        ? '<p style="text-align:center;color:var(--text-light,#7A6355);padding:32px 0">No vouchers found for this number.</p>'
        : `<h4 style="margin:12px 0 8px;font-size:.9rem">Available (${state.eligible.length})</h4>${eligibleHtml}${pastHtml}`}
    </div>`;

    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    modal.querySelector('#vfBack').onclick = ()=> setStep('phone');

    modal.querySelectorAll('[data-redeem-id]').forEach(btn => {
      btn.onclick = ()=>{
        const v = state.eligible.find(x => x.voucherId === btn.dataset.redeemId);
        if(!v) return;
        state.selectedVoucher = v;
        // Build the pick slots based on voucher type.
        if(v.voucherType === 'FREE_COMBO'){
          state.slots = [
            { category: 'DRINK', label: 'drink' },
            { category: 'FOOD',  label: 'food'  },
          ];
        } else if(v.voucherType === 'FREE_FOOD'){
          state.slots = [{ category: 'FOOD', label: 'food' }];
        } else {
          state.slots = [{ category: 'DRINK', label: 'drink' }];
        }
        state.picks = state.slots.map(()=> null);
        state.pickIndex = 0;
        loadMenuForVoucher();
      };
    });
  }

  function voucherCardHtml(v, isEligible){
    let typeBadge;
    if(v.voucherType === 'FREE_DRINK'){
      typeBadge = '<span class="pos-card-tag" style="background:#3B82F6;color:#fff">🥤 FREE DRINK</span>';
    } else if(v.voucherType === 'FREE_FOOD'){
      typeBadge = '<span class="pos-card-tag" style="background:#F59E0B;color:#fff">🍪 FREE FOOD</span>';
    } else {
      typeBadge = '<span class="pos-card-tag" style="background:#7C3AED;color:#fff">🥤🍪 FREE COMBO</span>';
    }

    const opacity = isEligible ? '1' : '.55';
    const cursor  = isEligible ? 'default' : 'default';

    let bottom = '';
    if(isEligible){
      const expiresAt = v.expiresAt ? new Date(v.expiresAt) : null;
      const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / (24*60*60*1000)) : null;
      const expiryText = expiresAt
        ? (daysLeft <= 0 ? 'Expires today' :
           daysLeft === 1 ? 'Expires tomorrow' :
           `Expires in ${daysLeft} days (${expiresAt.toLocaleDateString()})`)
        : '';
      bottom = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
        <span style="font-size:.8rem;color:var(--text-light,#7A6355)">${expiryText}</span>
        <button class="pos-btn pos-btn-primary pos-btn-sm" data-redeem-id="${v.voucherId}">Use →</button>
      </div>`;
    } else {
      const display = v.displayStatus || v.status;
      let detail = '';
      if(display === 'REDEEMED'){
        const when = v.redeemedAt ? new Date(v.redeemedAt).toLocaleDateString() : '';
        const what = v.menuItemName ? `${escapeHtmlPos(v.menuItemName)}${v.variant ? ' ('+escapeHtmlPos(v.variant)+')' : ''}` : '';
        detail = `Redeemed ${when}${what ? ' · '+what : ''}`;
      } else if(display === 'EXPIRED'){
        const when = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : '';
        detail = `Expired ${when}`;
      }
      bottom = `<div style="font-size:.8rem;color:var(--text-light,#7A6355);margin-top:6px">${detail}</div>`;
    }

    return `<div class="pos-card" style="opacity:${opacity};cursor:${cursor};margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${typeBadge}<strong>${escapeHtmlPos(v.campaignName || 'Voucher')}</strong></div>
      ${v.note ? '<div style="font-size:.8rem;color:var(--text-light,#7A6355)">'+escapeHtmlPos(v.note)+'</div>' : ''}
      ${bottom}
    </div>`;
  }

  // ── Step 3: item picker ──────────────────────────────────────────
  async function loadMenuForVoucher(){
    modal.innerHTML = `<div class="pos-modal" style="max-width:420px;text-align:center">
      <p style="margin:24px 0;color:var(--text-light,#7A6355)">Loading menu…</p>
    </div>`;
    try{
      const data = await api('GET', '/api/menu');
      const all = Array.isArray(data) ? data : (data.items || []);
      state.allMenuItems = all
        .filter(m => m.isActive !== false && m.isEnabledToday !== false)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || ''));
      setStep('pick');
    } catch(e){
      showError('Failed to load menu');
      setStep('list');
    }
  }

  function renderPick(){
    const v = state.selectedVoucher;
    const isCombo = v.voucherType === 'FREE_COMBO';
    const slot = state.slots[state.pickIndex];
    const pick = state.picks[state.pickIndex]; // current pick (may be null)
    const isLastSlot = state.pickIndex === state.slots.length - 1;

    // Heading + step indicator (only meaningful for combo).
    let typeLabel;
    if(v.voucherType === 'FREE_DRINK')      typeLabel = '🥤 FREE DRINK';
    else if(v.voucherType === 'FREE_FOOD')  typeLabel = '🍪 FREE FOOD';
    else                                    typeLabel = '🥤🍪 FREE COMBO';
    const stepLabel = isCombo
      ? `<span style="color:var(--text-light,#7A6355);font-size:.85rem;margin-left:8px">Step ${state.pickIndex + 1} of ${state.slots.length}: pick a ${slot.label}</span>`
      : '';

    const filtered = state.allMenuItems.filter(m => m.category === slot.category);
    const itemsHtml = filtered.length
      ? filtered.map(m => {
          const id = m.menuItemId || m.id;
          const isSelected = pick && (pick.menuItem.menuItemId || pick.menuItem.id) === id;
          const price = m.basePrice || 0;
          return `<div class="pos-card" data-pick-id="${id}" style="cursor:pointer;margin-bottom:6px;${isSelected ? 'border:2px solid var(--primary,#6B4226)' : ''}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <strong>${escapeHtmlPos(m.name)}</strong>
              <span style="color:var(--text-light,#7A6355);font-size:.85rem">RM ${price.toFixed(2)}</span>
            </div>
          </div>`;
        }).join('')
      : '<p style="text-align:center;color:var(--text-light,#7A6355);padding:24px 0">No items available.</p>';

    let variantHtml = '';
    if(pick){
      const m = pick.menuItem;
      const hasVariants = (m.variantGroups && m.variantGroups.length) || (m.variants && m.variants.length);
      if(hasVariants){
        variantHtml = `<div style="margin-top:12px;padding:12px;background:var(--cream-lighter,#FAF6F0);border-radius:var(--radius,8px)">
          <div style="font-size:.85rem;font-weight:600;margin-bottom:6px">Pick options</div>
          <div id="vfVariantHost"></div>
        </div>`;
      }
    }

    // Header back-button: combo step 2+ goes to step 1; otherwise back to list.
    const backLabel = (isCombo && state.pickIndex > 0) ? '← Back' : '← Vouchers';
    // Primary button label: last slot in combo says "Review →"; single-item says "Confirm Redemption".
    const primaryLabel = isCombo
      ? (isLastSlot ? 'Review →' : 'Next →')
      : 'Confirm Redemption';
    const primaryClass = (isCombo && !isLastSlot) ? 'pos-btn pos-btn-outline pos-btn-lg' : 'pos-btn pos-btn-primary pos-btn-lg';

    modal.innerHTML = `<div class="pos-modal" style="max-width:520px;max-height:85vh;overflow-y:auto">
      <button class="pos-modal-close">✕</button>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <button class="pos-btn pos-btn-sm pos-btn-outline" id="vfBackList">${backLabel}</button>
        <h3 style="margin:0;flex:1">${typeLabel}${stepLabel}</h3>
      </div>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:4px 0 12px">
        ${escapeHtmlPos(v.campaignName || '')} · ${state.phone}${state.customerName ? ' · '+escapeHtmlPos(state.customerName) : ''}
      </p>
      <div style="max-height:45vh;overflow-y:auto;margin-bottom:12px">${itemsHtml}</div>
      ${variantHtml}
      <div style="margin-top:14px;display:flex;gap:8px">
        <button class="${primaryClass}" id="vfConfirm" style="flex:1" ${pick ? '' : 'disabled'}>
          ${primaryLabel}
        </button>
      </div>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    modal.querySelector('#vfBackList').onclick = ()=>{
      if(isCombo && state.pickIndex > 0){
        state.pickIndex -= 1;
        setStep('pick');
      } else {
        setStep('list');
      }
    };

    modal.querySelectorAll('[data-pick-id]').forEach(card => {
      card.onclick = ()=>{
        const id = card.dataset.pickId;
        const m = state.allMenuItems.find(item => (item.menuItemId || item.id) === id) || null;
        if(!m) return;
        state.picks[state.pickIndex] = { menuItem: m, selectedVariants: [] };
        renderPick(); // re-render to show variants + enable next/confirm
      };
    });

    // Wire variant picker via the shared module if present.
    const variantHost = modal.querySelector('#vfVariantHost');
    if(variantHost && pick && window.RLCVariants){
      window.RLCVariants.renderVariantPicker(pick.menuItem, variantHost, (selected)=>{
        // Mutate the pick in place — same object referenced from state.picks.
        pick.selectedVariants = selected || [];
      });
    }

    modal.querySelector('#vfConfirm').onclick = ()=>{
      if(!pick) return;
      // Validate single-select variant groups have an option chosen.
      const m = pick.menuItem;
      if(m.variantGroups && m.variantGroups.length){
        const required = m.variantGroups.filter(g => g.type === 'single').map(g => g.group);
        const chosen = new Set((pick.selectedVariants || []).map(sv => sv.group));
        for(const g of required){
          if(!chosen.has(g)){ showError(`Pick a ${g} option`); return; }
        }
      }

      if(isCombo && !isLastSlot){
        state.pickIndex += 1;
        setStep('pick');
      } else if(isCombo && isLastSlot){
        setStep('summary');
      } else {
        confirmRedeem();
      }
    };
  }

  // ── Step 4: combo summary (combo only) ───────────────────────────
  function renderSummary(){
    const v = state.selectedVoucher;
    const rows = state.picks.map((p, i) => {
      const m = p.menuItem;
      const price = m.basePrice + (p.selectedVariants || []).reduce((s, sv) => s + (sv.price || 0), 0);
      const vlabel = (p.selectedVariants || []).map(sv => sv.option).filter(Boolean).join(', ');
      return `<div class="pos-card" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:.75rem;color:var(--text-light,#7A6355);text-transform:uppercase;letter-spacing:.05em">${escapeHtmlPos(state.slots[i].label)}</div>
            <strong>${escapeHtmlPos(m.name)}</strong>
            ${vlabel ? '<div style="font-size:.85rem;color:var(--text-light,#7A6355)">'+escapeHtmlPos(vlabel)+'</div>' : ''}
          </div>
          <span style="color:var(--text-light,#7A6355);font-size:.85rem;text-decoration:line-through">RM ${price.toFixed(2)}</span>
        </div>
      </div>`;
    }).join('');

    const total = state.picks.reduce((s, p) => {
      return s + (p.menuItem.basePrice || 0) + (p.selectedVariants || []).reduce((a, sv) => a + (sv.price || 0), 0);
    }, 0);

    modal.innerHTML = `<div class="pos-modal" style="max-width:520px;max-height:85vh;overflow-y:auto">
      <button class="pos-modal-close">✕</button>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <button class="pos-btn pos-btn-sm pos-btn-outline" id="vfBackPick">← Back</button>
        <h3 style="margin:0;flex:1">🥤🍪 Review Redemption</h3>
      </div>
      <p style="font-size:.85rem;color:var(--text-light,#7A6355);margin:4px 0 12px">
        ${escapeHtmlPos(v.campaignName || '')} · ${state.phone}${state.customerName ? ' · '+escapeHtmlPos(state.customerName) : ''}
      </p>
      ${rows}
      <div style="text-align:right;margin:12px 0;font-size:.95rem">
        Total value: <strong>RM ${total.toFixed(2)}</strong> — voucher covers everything
      </div>
      <button class="pos-btn pos-btn-primary pos-btn-lg" id="vfConfirm" style="width:100%">Confirm Redemption</button>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    modal.querySelector('#vfBackPick').onclick = ()=>{
      state.pickIndex = state.slots.length - 1;
      setStep('pick');
    };
    modal.querySelector('#vfConfirm').onclick = confirmRedeem;
  }

  // ── Confirm + redeem ─────────────────────────────────────────────
  async function confirmRedeem(){
    if(!state.selectedVoucher) return;
    if(state.picks.some(p => !p)) return;

    const btn = modal.querySelector('#vfConfirm');
    if(btn){ btn.disabled = true; btn.textContent = 'Redeeming…'; }

    try{
      await api('POST', '/api/pos/vouchers/redeem', {
        voucherId: state.selectedVoucher.voucherId,
        phone: state.phone,
        customerName: state.customerName || state.selectedVoucher.name || '',
        items: state.picks.map(p => ({
          menuItemId: p.menuItem.menuItemId || p.menuItem.id,
          selectedVariants: p.selectedVariants || [],
        })),
      });
      modal.remove();
      try{ playReadySound(); } catch(e){}
      showSuccessToast('Voucher redeemed — order created');
      try{ fetchOrders(); } catch(e){}
    } catch(e){
      const msg = String(e && e.message || '');
      if(msg.includes('already redeemed') || msg.includes('expired')){
        showError('Voucher is no longer valid');
        await lookupVouchers();
      } else {
        showError('Redemption failed');
        if(btn){ btn.disabled = false; btn.textContent = 'Confirm Redemption'; }
      }
    }
  }

  render();
}

// Reuse the existing toast host pattern but with a success palette.
