// pos-walkup.js — Walk-up order flow
// Depends on: pos.js (api, showError, fetchOrders, celebrationMode)

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
  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';

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

  function renderWalkup(){
    const filtered = filteredMenu();
    const cartHtml=cart.map((c,i)=>`<li>${c.qty}x ${c.name}${c.variant?' ('+c.variant+')':''} <span style="color:var(--text-light,#7A6355);font-size:.85rem">RM${(c.price*c.qty).toFixed(2)}</span> <button data-ri="${i}" class="pos-remove-item">✕</button></li>`).join('');
    const cartTotal = cart.reduce((s,c)=>s+c.price*c.qty,0);

    modal.innerHTML=`<div class="pos-modal pos-modal-walkup">
      <button class="pos-modal-close">✕</button>
      <h3>Walk-up Order</h3>
      <input id="wkName" class="pos-input" placeholder="Customer name" value="${cart._name||''}" style="margin-bottom:12px">
      <input id="wkSearch" class="pos-input" placeholder="Search menu..." value="${wkFilter}" style="margin-bottom:8px">
      <div class="pos-walkup-filters">
        <button class="pos-btn pos-btn-sm ${wkCategory==='ALL'?'active':''}" data-wk-cat="ALL">All</button>
        <button class="pos-btn pos-btn-sm ${wkCategory==='DRINK'?'active':''}" data-wk-cat="DRINK">Drinks</button>
        <button class="pos-btn pos-btn-sm ${wkCategory==='FOOD'?'active':''}" data-wk-cat="FOOD">Food</button>
      </div>
      <div class="pos-walkup-menu">${filtered.length ? filtered.map(m=>{
        const price = m.basePrice || m.price || 0;
        let variantHtml = '';
        if(m.variantGroups && m.variantGroups.length){
          variantHtml = m.variantGroups.map(g=>g.options.map(o=>
            `<button class="pos-variant-btn" data-mid="${m.menuItemId||m.id}" data-group="${g.group}" data-type="${g.type}" data-v="${o.name}" data-vp="${o.price||0}">${o.name}${o.price ? ' +'+o.price : ''}</button>`
          ).join('')).join('');
        } else if(m.variants && m.variants.length){
          variantHtml = m.variants.map(v=>`<button class="pos-variant-btn" data-mid="${m.menuItemId||m.id}" data-v="${v.name||v.id}" data-vp="${v.priceModifier||0}">${v.name||v}${v.priceModifier ? ' +'+v.priceModifier : ''}</button>`).join('');
        }
        return `<div class="pos-walkup-item"><span>${m.name}${price ? ' - RM'+price.toFixed(2) : ''}</span>${variantHtml}<button class="pos-add-btn" data-mid="${m.menuItemId||m.id}" data-mname="${m.name}" data-mp="${price}">+</button></div>`;
      }).join('') : '<div style="padding:16px;text-align:center;color:var(--text-light,#7A6355)">No items match</div>'}</div>
      <div class="pos-walkup-cart"><h4>Cart${cart.length ? ' — RM'+cartTotal.toFixed(2) : ''}</h4><ul>${cartHtml||'<li>Empty</li>'}</ul></div>
      <input id="wkNotes" class="pos-input" placeholder="Special requests (less sugar, extra hot)" style="margin-bottom:12px">
      <fieldset class="pos-chip-group" id="wkDiscountGroup" aria-label="Discount">
        <legend class="pos-chip-legend">Discount</legend>
        ${[
          {value:'',         label:'No Discount'},
          {value:'STAFF',    label:'Staff (RM5)'},
          {value:'PASTOR',   label:'Pastor (Free)'},
          {value:'NEWCOMER', label:'Newcomer (Free)'},
        ].map(o=>`<label class="pos-chip"><input type="radio" name="wkDiscount" value="${o.value}" ${selectedDiscount===o.value?'checked':''}><span>${o.label}</span></label>`).join('')}
      </fieldset>
      <button id="wkSubmit" class="pos-btn pos-btn-primary pos-btn-lg" ${cart.length?'':'disabled'}>Submit Order</button></div>`;

    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

    modal.querySelector('#wkSearch').oninput=e=>{
      wkFilter=e.target.value.toLowerCase();
      cart._name=modal.querySelector('#wkName')?.value||'';
      renderWalkup();
      modal.querySelector('#wkSearch').focus();
    };

    modal.querySelectorAll('[data-wk-cat]').forEach(btn=>btn.onclick=()=>{
      wkCategory=btn.dataset.wkCat;
      cart._name=modal.querySelector('#wkName')?.value||'';
      renderWalkup();
    });

    modal.querySelectorAll('.pos-add-btn').forEach(b=>b.onclick=()=>{
      const existing = cart.find(c=>c.menuItemId===b.dataset.mid && !c.variant);
      if(existing){ existing.qty++; }
      else { cart.push({name:b.dataset.mname, menuItemId:b.dataset.mid, price:+b.dataset.mp, qty:1, variant:null}); }
      cart._name=modal.querySelector('#wkName')?.value||'';
      renderWalkup();
    });
    modal.querySelectorAll('.pos-variant-btn').forEach(b=>b.onclick=()=>{
      const item=menu.find(m=>(m.menuItemId||m.id)===b.dataset.mid);
      const basePrice = item.basePrice || item.price || 0;
      const variantPrice = basePrice + (+b.dataset.vp||0);
      const sv = [{group: b.dataset.group||'', option: b.dataset.v, price: +b.dataset.vp||0}];
      const existing = cart.find(c=>c.menuItemId===b.dataset.mid && c.variant===b.dataset.v);
      if(existing){ existing.qty++; }
      else { cart.push({name:item.name, menuItemId:b.dataset.mid, price:variantPrice, qty:1, variant:b.dataset.v, selectedVariants:sv}); }
      cart._name=modal.querySelector('#wkName')?.value||'';
      renderWalkup();
    });
    modal.querySelectorAll('.pos-remove-item').forEach(b=>b.onclick=()=>{ cart.splice(+b.dataset.ri,1); cart._name=modal.querySelector('#wkName')?.value||''; renderWalkup(); });

    modal.querySelectorAll('input[name="wkDiscount"]').forEach(r=>{
      r.onchange=()=>{ if(r.checked) selectedDiscount = r.value; };
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
  renderWalkup();
  document.body.appendChild(modal);
}

