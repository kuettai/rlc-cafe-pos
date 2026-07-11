// pos-history.js — History modal + filters
// Depends on: pos.js (api, showError)

// --- Order History ---
async function openHistory(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:600px"><button class="pos-modal-close">✕</button><h3>Order History (Today)</h3><div class="loading">Loading...</div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

  try{
    const data = await api('GET','/api/pos/orders?all=true');
    const allOrders = (Array.isArray(data) ? data : data.orders || [])
      .filter(o => ['ARCHIVED','EXPIRED','CANCELLED','READY'].includes(o.status));
    allOrders.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));

    // Client-side filter state: default hides CANCELLED so the operator
    // sees "what actually served" first. Toggle to see refunds/rejects
    // separately, or All to compare.
    let historyFilter = 'NON_CANCELLED';   // NON_CANCELLED | CANCELLED | ALL

    function filtered() {
      if (historyFilter === 'CANCELLED') return allOrders.filter(o => o.status === 'CANCELLED');
      if (historyFilter === 'NON_CANCELLED') return allOrders.filter(o => o.status !== 'CANCELLED');
      return allOrders;
    }

    function itemHtml(o){
      const items = (o.items||[]).map(i=>`${i.quantity||i.qty||1}x ${i.name}`).join(', ');
      const statusClass = o.status==='CANCELLED'||o.status==='EXPIRED' ? 'badge-inactive' : 'badge-active';
      const oid = o.orderId || o.id;
      const canCancel = (o.status === 'READY' || o.status === 'ARCHIVED');
      return `<div class="pos-history-item">
        <div class="pos-history-header">
          <strong>${o.customerName||'Guest'}</strong>
          <span class="admin-card-badge ${statusClass}">${o.status}</span>
        </div>
        <div class="pos-history-details">${items}</div>
        ${o.cancelReason ? `<div style="font-size:.75rem;color:var(--text-light,#7A6355);margin-top:4px">Cancelled: ${o.cancelReason}${o.cancelledBy?' · by '+o.cancelledBy:''}</div>` : ''}
        <div class="pos-history-footer">
          <span>RM ${(o.total||o.totalAmount||0).toFixed(2)}</span>
          <span>${new Date(o.createdAt).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit'})}</span>
          <button class="pos-btn pos-btn-sm" data-reorder='${JSON.stringify({name:o.customerName,items:o.items})}'>Reorder</button>
          ${canCancel ? `<button class="pos-btn pos-btn-sm pos-btn-danger" data-cancel-completed="${oid}">Cancel / Refund</button>` : ''}
        </div>
      </div>`;
    }

    function renderHistory(){
      const content = modal.querySelector('.pos-modal');
      const counts = {
        NON_CANCELLED: allOrders.filter(o => o.status !== 'CANCELLED').length,
        CANCELLED:     allOrders.filter(o => o.status === 'CANCELLED').length,
        ALL:           allOrders.length,
      };
      const list = filtered();
      const filterRow = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px">
        <button class="pos-btn pos-btn-sm ${historyFilter==='NON_CANCELLED'?'pos-btn-primary':''}" data-hf="NON_CANCELLED">Non-Cancelled (${counts.NON_CANCELLED})</button>
        <button class="pos-btn pos-btn-sm ${historyFilter==='CANCELLED'?'pos-btn-primary':''}" data-hf="CANCELLED">Cancelled (${counts.CANCELLED})</button>
        <button class="pos-btn pos-btn-sm ${historyFilter==='ALL'?'pos-btn-primary':''}" data-hf="ALL">All (${counts.ALL})</button>
      </div>`;

      if (!allOrders.length){
        content.innerHTML = `<button class="pos-modal-close">✕</button><h3>Order History (Today)</h3>${filterRow}<div style="padding:24px;text-align:center;color:var(--text-light,#7A6355)">No completed orders yet</div>`;
      } else if (!list.length) {
        content.innerHTML = `<button class="pos-modal-close">✕</button><h3>Order History (Today)</h3>${filterRow}<div style="padding:24px;text-align:center;color:var(--text-light,#7A6355)">No orders match this filter.</div>`;
      } else {
        content.innerHTML = `<button class="pos-modal-close">✕</button><h3>Order History (Today)</h3>${filterRow}
          <div class="pos-history-list">${list.map(itemHtml).join('')}</div>`;
      }

      // Re-wire close, filter buttons, and per-item actions after every render.
      content.querySelector('.pos-modal-close').onclick=()=>modal.remove();
      content.querySelectorAll('[data-hf]').forEach(btn=>{
        btn.onclick = ()=>{ historyFilter = btn.dataset.hf; renderHistory(); };
      });
      content.querySelectorAll('[data-reorder]').forEach(btn=>btn.onclick=async()=>{
        const data = JSON.parse(btn.dataset.reorder);
        try{
          await api('POST','/api/pos/orders',{customerName:data.name||'Walk-up', items:(data.items||[]).map(i=>({menuItemId:i.menuItemId,name:i.name,variant:i.variant,qty:i.quantity||i.qty||1,price:i.price||i.unitPrice||0}))});
          modal.remove();
          fetchOrders();
        } catch(e){ showError('Reorder failed'); }
      });
      content.querySelectorAll('[data-cancel-completed]').forEach(btn=>{
        btn.onclick = ()=> showCancelCompletedDialog(btn.dataset.cancelCompleted, modal);
      });
    }

    renderHistory();
  } catch(e){ showError('Failed to load history'); modal.remove(); }
}

