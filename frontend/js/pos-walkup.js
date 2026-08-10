// pos-walkup.js — Walk-up order flow
// Depends on: pos.js (api, showError, fetchOrders, celebrationMode,
// celebrationPrice), pricing.js (CafePricing)

// --- Walk-up Order ---
async function openWalkup(){
  let menu=[];
  try{ const d=await api('GET','/api/menu'); menu=Array.isArray(d)?d:d.items||[]; } catch(e){ showError('Failed to load menu'); return; }
  const cart=[];
  let wkFilter = '';
  let wkCategory = 'ALL';
  // Discount is preserved across re-renders since renderWalkup() rewrites
  // innerHTML each time. Kept in closure state so the pill selection sticks
  // when a user adds items or searches after picking a discount.
  let selectedDiscount = '';

  // Menu layout: 'list' (compact rows) or 'grid' (large tap targets).
  // Persisted per device — older cashiers prefer the bigger blocks, and the
  // preference should survive closing the modal and reloading the page.
  let wkLayout = localStorage.getItem('walkup_layout') === 'grid' ? 'grid' : 'list';

  /**
   * Pending variant selection per menu item: { [menuItemId]: { [group]: option } }
   *
   * Walk-up used to render every option of every group as a flat row of
   * buttons, each of which immediately pushed its own cart line. A Latte has a
   * Temperature group (single) AND a Milk group (optional), so tapping "Iced"
   * then "Oat Milk" produced TWO drinks — "Latte (Iced)" and "Latte (Oat Milk)"
   * — instead of one iced latte with oat milk.
   *
   * Selections are now held here and combined when "+" is pressed, matching the
   * semantics the customer page gets from variants.js: `single` groups hold
   * exactly one option (defaulted to the first), `optional`/`multi` groups can
   * be toggled off entirely.
   */
  const pendingVariants = {};

  function groupsOf(item){
    if (item.variantGroups && item.variantGroups.length) return item.variantGroups;
    // Legacy flat `variants` array: treat as one single-select group so the
    // same selection model covers both shapes.
    if (item.variants && item.variants.length) {
      return [{
        group: 'Option',
        type: 'single',
        options: item.variants.map(v => ({ name: v.name || v.id || String(v), price: v.priceModifier || 0 })),
      }];
    }
    return [];
  }

  /** Current selection for an item, defaulting single groups to their first option. */
  function selectionFor(item){
    const id = item.menuItemId || item.id;
    const groups = groupsOf(item);
    if (!pendingVariants[id]) {
      const init = {};
      for (const g of groups) if (g.type === 'single' && g.options.length) init[g.group] = g.options[0].name;
      pendingVariants[id] = init;
    }
    return pendingVariants[id];
  }

  /** Resolve a selection into the shape the cart and the API expect. */
  function resolveSelection(item){
    const sel = selectionFor(item);
    const groups = groupsOf(item);
    const selectedVariants = [];
    let priceDelta = 0;
    for (const g of groups) {
      const chosen = sel[g.group];
      if (!chosen) continue;                       // optional group left off
      const opt = g.options.find(o => o.name === chosen);
      if (!opt) continue;
      selectedVariants.push({ group: g.group, option: opt.name, price: Number(opt.price || 0) });
      priceDelta += Number(opt.price || 0);
    }
    return {
      selectedVariants,
      priceDelta,
      // Display label, e.g. "Iced, Oat Milk". Null when nothing is selected so
      // the cart shows a bare item name.
      label: selectedVariants.length ? selectedVariants.map(v => v.option).join(', ') : null,
    };
  }

  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';

  // Price the cart the same way the backend will (cheapest applicable rule per
  // line, never stacked) so the cashier is quoted the amount actually charged.
  function priceWalkupCart(){
    return CafePricing.priceCart(cart, {
      celebrationMode: typeof celebrationMode !== 'undefined' ? celebrationMode : false,
      celebrationPrice: typeof celebrationPrice !== 'undefined' ? celebrationPrice : 5,
      customerClass: selectedDiscount,
    });
  }

  // Cart markup shared by the full render and the targeted cart update, so the
  // two can't drift. Struck-out gross is shown wherever a discount applied.
  function cartInnerHtml(){
    const priced = priceWalkupCart();
    const items = cart.map((c,i)=>{
      const p = priced.lines[i];
      const lineNet = p.unitPrice * p.qty;
      const lineGross = p.grossUnitPrice * p.qty;
      const priceHtml = lineNet < lineGross
        ? `<span class="pos-cart-item-price"><s class="pos-cart-item-gross">RM${lineGross.toFixed(2)}</s> RM${lineNet.toFixed(2)}</span>`
        : `<span class="pos-cart-item-price">RM${lineNet.toFixed(2)}</span>`;
      return `<li><span class="pos-cart-item-name">${c.name}${c.variant?' ('+c.variant+')':''}</span><span class="pos-cart-item-controls"><button data-ri="${i}" class="pos-qty-btn pos-qty-minus" aria-label="Decrease quantity">−</button><span class="pos-qty-value">${c.qty}</span><button data-ri="${i}" class="pos-qty-btn pos-qty-plus" aria-label="Increase quantity">+</button>${priceHtml}<button data-ri="${i}" class="pos-remove-item" aria-label="Remove item">✕</button></span></li>`;
    }).join('');

    let heading = 'Cart';
    if (cart.length) {
      heading += priced.discounted
        ? ` — <s class="pos-cart-item-gross">RM${priced.gross.toFixed(2)}</s> RM${priced.total.toFixed(2)}`
        : ` — RM${priced.total.toFixed(2)}`;
    }
    const savings = cart.length && priced.discounted
      ? `<div class="pos-cart-savings" role="status" aria-live="polite">${priced.rules.join(' + ')} discount −RM${priced.offset.toFixed(2)}</div>`
      : '';

    return `<h4>${heading}</h4><ul>${items||'<li>Empty</li>'}</ul>${savings}`;
  }

  // Sort by popularity (items ordered more often appear first)
  const orderHistory = JSON.parse(localStorage.getItem('walkup_item_counts')||'{}');
  menu.sort((a,b)=>{
    const aCount = orderHistory[a.menuItemId||a.id]||0;
    const bCount = orderHistory[b.menuItemId||b.id]||0;
    if(bCount !== aCount) return bCount - aCount;
    return (a.sortOrder||0)-(b.sortOrder||0);
  });

  function filteredMenu(){
    return menu.filter(m=>{
      if(m.isEnabledToday === false) return false;
      if(wkCategory !== 'ALL' && m.category !== wkCategory) return false;
      if(wkFilter && !m.name.toLowerCase().includes(wkFilter)) return false;
      return true;
    });
  }

  /**
   * Stash the free-text fields before a full re-render.
   *
   * renderWalkup() rewrites innerHTML, so anything typed into the name or notes
   * inputs is lost unless it is captured first. Notes used to be dropped on
   * every search keystroke or category switch.
   */
  function preserveInputs(){
    cart._name  = modal.querySelector('#wkName')?.value  ?? cart._name  ?? '';
    cart._notes = modal.querySelector('#wkNotes')?.value ?? cart._notes ?? '';
  }

  function renderWalkup(){
    // Preserve menu scroll position across re-renders
    const prevMenuScroll = modal.querySelector('.pos-walkup-menu')?.scrollTop || 0;

    const filtered = filteredMenu();

    modal.innerHTML=`<div class="pos-modal pos-modal-walkup">
      <button class="pos-modal-close">✕</button>
      <h3>Walk-up Order</h3>
      <div class="pos-walkup-grid">
        <div class="pos-walkup-col-left">
          <input id="wkName" class="pos-input" placeholder="Customer name" value="${cart._name||''}" style="margin-bottom:12px">
          <input id="wkSearch" class="pos-input" placeholder="Search menu..." value="${wkFilter}" style="margin-bottom:8px">
          <div class="pos-walkup-filters">
            <button class="pos-btn pos-btn-sm ${wkCategory==='ALL'?'active':''}" data-wk-cat="ALL">All</button>
            <button class="pos-btn pos-btn-sm ${wkCategory==='DRINK'?'active':''}" data-wk-cat="DRINK">Drinks</button>
            <button class="pos-btn pos-btn-sm ${wkCategory==='FOOD'?'active':''}" data-wk-cat="FOOD">Food</button>
            <span class="pos-walkup-layout-toggle">
              <button class="pos-btn pos-btn-sm ${wkLayout==='list'?'active':''}" data-wk-layout="list" aria-label="List layout" title="Compact list">☰</button>
              <button class="pos-btn pos-btn-sm ${wkLayout==='grid'?'active':''}" data-wk-layout="grid" aria-label="Block layout" title="Large blocks">▦</button>
            </span>
          </div>
          <div class="pos-walkup-menu pos-walkup-menu-${wkLayout}">${filtered.length ? filtered.map(m=>{
            const mid = m.menuItemId||m.id;
            const price = m.basePrice || m.price || 0;
            const isFood     = m.category === 'FOOD';
            const hasQty     = isFood && typeof m.foodQuantityToday === 'number';
            const available  = hasQty ? Math.max(0, (m.foodQuantityToday||0) - (m.foodReserved||0)) : null;
            const soldOut    = hasQty && available <= 0;
            const stockLabel = !hasQty ? '' :
              soldOut ? ' <span class="pos-walkup-stock pos-walkup-stock-out">(Sold Out)</span>'
                      : ` <span class="pos-walkup-stock">(${available} left)</span>`;

            // One toggle row per variant GROUP, so a Temperature choice and a
            // Milk choice combine into a single drink instead of two lines.
            // Buttons only mark selection; nothing is added until "+".
            const sel = selectionFor(m);
            const variantHtml = groupsOf(m).map(g=>{
              const opts = g.options.map(o=>{
                const active = sel[g.group] === o.name;
                return `<button class="pos-variant-btn${active?' active':''}" role="checkbox" aria-checked="${active?'true':'false'}"`
                  + ` data-mid="${mid}" data-group="${g.group}" data-type="${g.type}" data-v="${o.name}" data-vp="${o.price||0}"`
                  + `${soldOut?' disabled':''}>${o.name}${o.price ? ' +'+o.price : ''}</button>`;
              }).join('');
              return `<span class="pos-variant-group" data-group="${g.group}"><span class="pos-variant-group-label">${g.group}</span>${opts}</span>`;
            }).join('');

            // Live unit price including the current variant selection, so the
            // cashier can read the price before committing the line.
            const unit = price + resolveSelection(m).priceDelta;
            const priceLabel = price ? ` - RM${unit.toFixed(2)}` : '';

            return `<div class="pos-walkup-item${soldOut?' pos-walkup-item-soldout':''}" data-mid="${mid}">`
              + `<span class="pos-walkup-item-name">${m.name}${priceLabel}${stockLabel}</span>`
              + `${variantHtml}`
              + `<button class="pos-add-btn" data-mid="${mid}" data-mname="${m.name}" data-mp="${price}"${soldOut?' disabled aria-disabled="true"':''}>+</button>`
              + `</div>`;
          }).join('') : '<div style="padding:16px;text-align:center;color:var(--text-light,#7A6355)">No items match</div>'}</div>
        </div>
        <div class="pos-walkup-col-right">
          <!-- Only this section scrolls. The discount chips and Submit button
               below sit in a pinned footer so they are always reachable. -->
          <div class="pos-walkup-cart-scroll">
            <div class="pos-walkup-cart">${cartInnerHtml()}</div>
            <input id="wkNotes" class="pos-input" placeholder="Special requests (less sugar, extra hot)" value="${cart._notes||''}">
          </div>
          <div class="pos-walkup-actions">
            <fieldset class="pos-chip-group" id="wkDiscountGroup" aria-label="Discount">
              <legend class="pos-chip-legend">Discount</legend>
              ${[
                {value:'',         label:'No Discount'},
                {value:'STAFF',    label:'Staff (RM5)'},
                {value:'PASTOR',   label:'Pastor (Free)'},
                {value:'NEWCOMER', label:'Newcomer (Free)'},
              ].map(o=>`<label class="pos-chip"><input type="radio" name="wkDiscount" value="${o.value}" ${selectedDiscount===o.value?'checked':''}><span>${o.label}</span></label>`).join('')}
            </fieldset>
            <button id="wkSubmit" class="pos-btn pos-btn-primary pos-btn-lg" ${cart.length?'':'disabled'}>Submit Order</button>
          </div>
        </div>
      </div>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

    // Restore menu scroll position
    const menuEl = modal.querySelector('.pos-walkup-menu');
    if (menuEl && prevMenuScroll) menuEl.scrollTop = prevMenuScroll;

    modal.querySelector('#wkSearch').oninput=e=>{
      wkFilter=e.target.value.toLowerCase();
      preserveInputs();
      renderWalkup();
      modal.querySelector('#wkSearch').focus();
    };

    modal.querySelectorAll('[data-wk-cat]').forEach(btn=>btn.onclick=()=>{
      wkCategory=btn.dataset.wkCat;
      preserveInputs();
      renderWalkup();
    });

    // Layout switch — remembered per device for the next order.
    modal.querySelectorAll('[data-wk-layout]').forEach(btn=>btn.onclick=()=>{
      wkLayout = btn.dataset.wkLayout === 'grid' ? 'grid' : 'list';
      localStorage.setItem('walkup_layout', wkLayout);
      preserveInputs();
      renderWalkup();
    });

    // "+" commits ONE line combining every group's current selection.
    modal.querySelectorAll('.pos-add-btn').forEach(b=>b.onclick=()=>{
      const item = menu.find(m=>(m.menuItemId||m.id)===b.dataset.mid) || {};
      const basePrice = item.basePrice || item.price || +b.dataset.mp || 0;
      const { selectedVariants, priceDelta, label } = resolveSelection(item);

      // Same variant combination on an existing line just bumps its quantity.
      // Compared by label so "Iced, Oat Milk" is distinct from plain "Iced".
      const existing = cart.find(c=>c.menuItemId===b.dataset.mid && (c.variant||null)===label);
      if(existing){ existing.qty++; }
      else {
        cart.push({
          name:b.dataset.mname, menuItemId:b.dataset.mid,
          price: basePrice + priceDelta, qty:1,
          variant: label,
          selectedVariants,
          // Needed to price the line the way the backend will.
          category:item.category||'DRINK',
          celebrationEligible:item.celebrationEligible===true,
          basePrice:basePrice,
        });
      }
      updateCart();
    });

    // Variant buttons only TOGGLE selection — they no longer add to the cart.
    // `single` groups always keep exactly one option; `optional`/`multi` groups
    // can be switched off by tapping the active option again.
    modal.querySelectorAll('.pos-variant-btn').forEach(b=>b.onclick=()=>{
      const mid = b.dataset.mid;
      const item = menu.find(m=>(m.menuItemId||m.id)===mid);
      if(!item) return;
      const sel = selectionFor(item);
      const group = b.dataset.group;
      const isSingle = b.dataset.type === 'single';
      if (sel[group] === b.dataset.v && !isSingle) delete sel[group];
      else sel[group] = b.dataset.v;
      // Repaint just this row: keeps the menu scroll position and avoids
      // rebuilding the whole modal on every tap.
      updateMenuRow(mid);
    });
    modal.querySelectorAll('.pos-remove-item').forEach(b=>b.onclick=()=>{ cart.splice(+b.dataset.ri,1); updateCart(); });
    modal.querySelectorAll('.pos-qty-minus').forEach(b=>b.onclick=()=>{ const i=+b.dataset.ri; if(cart[i].qty>1) cart[i].qty--; else cart.splice(i,1); updateCart(); });
    modal.querySelectorAll('.pos-qty-plus').forEach(b=>b.onclick=()=>{ const i=+b.dataset.ri; cart[i].qty++; updateCart(); });

    modal.querySelectorAll('input[name="wkDiscount"]').forEach(r=>{
      // Repaint the cart so the cashier sees the discounted total immediately.
      r.onchange=()=>{ if(r.checked){ selectedDiscount = r.value; updateCart(); } };
    });

    const submitBtn=modal.querySelector('#wkSubmit');
    if(submitBtn) submitBtn.onclick=async()=>{
      const name=modal.querySelector('#wkName').value||'Walk-up';
      const disc=(modal.querySelector('input[name="wkDiscount"]:checked')?.value)||undefined;
      const notes=modal.querySelector('#wkNotes')?.value||'';
      try{
        await api('POST','/api/pos/orders',{customerName:name, items:cart.map(c=>({menuItemId:c.menuItemId,name:c.name,variant:c.variant,selectedVariants:c.selectedVariants||[],quantity:c.qty,price:c.price})), discountType:disc, notes});
        // Track item popularity for favourites sorting
        const counts = JSON.parse(localStorage.getItem('walkup_item_counts')||'{}');
        cart.forEach(c=>{ counts[c.menuItemId] = (counts[c.menuItemId]||0) + c.qty; });
        localStorage.setItem('walkup_item_counts', JSON.stringify(counts));
        modal.remove(); fetchOrders();
      } catch(e){ showError('Failed to submit order'); }
    };
  }
  /**
   * Repaint one menu row's variant buttons and unit price in place.
   *
   * Toggling a variant must not re-render the whole modal: that would blow away
   * the customer-name and notes inputs mid-typing and reset the menu scroll.
   */
  function updateMenuRow(mid){
    const row = modal.querySelector(`.pos-walkup-item[data-mid="${mid}"]`);
    const item = menu.find(m=>(m.menuItemId||m.id)===mid);
    if(!row || !item) return;

    const sel = selectionFor(item);
    row.querySelectorAll('.pos-variant-btn').forEach(btn=>{
      const active = sel[btn.dataset.group] === btn.dataset.v;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    const nameEl = row.querySelector('.pos-walkup-item-name');
    const base = item.basePrice || item.price || 0;
    if (nameEl && base) {
      const unit = base + resolveSelection(item).priceDelta;
      // Rebuild the label, preserving any stock suffix already rendered.
      const stock = nameEl.querySelector('.pos-walkup-stock');
      nameEl.textContent = `${item.name} - RM${unit.toFixed(2)}`;
      if (stock) nameEl.appendChild(stock);
    }
  }

  function updateCart(){
    const cartEl = modal.querySelector('.pos-walkup-cart');
    if(!cartEl) return;
    cartEl.innerHTML = cartInnerHtml();
    // Rebind cart buttons
    cartEl.querySelectorAll('.pos-remove-item').forEach(b=>b.onclick=()=>{ cart.splice(+b.dataset.ri,1); updateCart(); });
    cartEl.querySelectorAll('.pos-qty-minus').forEach(b=>b.onclick=()=>{ const i=+b.dataset.ri; if(cart[i].qty>1) cart[i].qty--; else cart.splice(i,1); updateCart(); });
    cartEl.querySelectorAll('.pos-qty-plus').forEach(b=>b.onclick=()=>{ const i=+b.dataset.ri; cart[i].qty++; updateCart(); });
    // Update submit button state
    const submitBtn=modal.querySelector('#wkSubmit');
    if(submitBtn) submitBtn.disabled = !cart.length;
  }

  renderWalkup();
  document.body.appendChild(modal);
}

