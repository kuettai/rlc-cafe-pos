// admin-vouchers.js — Voucher campaigns, assign, CSV
// Depends on: admin.js (api, showError, showSuccess, showFormModal, $)

// --- Vouchers ---
async function loadVouchers(container){
  return loadVoucherCampaignList(container);
}

async function loadVoucherCampaignList(container){
  container.innerHTML = '<div class="loading">Loading campaigns...</div>';
  try{
    const data = await api('GET','/api/admin/vouchers/campaigns');
    const campaigns = data.campaigns || [];
    renderVoucherCampaignList(container, campaigns);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load campaigns</p></div>'; }
}

function renderVoucherCampaignList(container, campaigns){
  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>Voucher Campaigns</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddCampaign">+ New Campaign</button>
    </div>`;

  if(!campaigns.length){
    html += '<div class="admin-empty"><p>No campaigns yet. Create one to start issuing vouchers.</p></div>';
  } else {
    campaigns.forEach(c => {
      const expiry = c.expiryMode === 'DAYS_FROM_ISSUE'
        ? `${c.expiryDays} days from issue`
        : `Fixed: ${new Date(c.expiryDate).toLocaleDateString()}`;
      const typeBadge = c.voucherType === 'FREE_DRINK' ? 'badge-drink'
                       : c.voucherType === 'FREE_FOOD'  ? 'badge-food'
                       : 'badge-active';
      const typeIcon  = c.voucherType === 'FREE_DRINK' ? '🥤'
                       : c.voucherType === 'FREE_FOOD'  ? '🍪'
                       : '🥤🍪';
      const issued = c.issuedCount || 0;
      const redeemed = c.redeemedCount || 0;
      html += `<div class="admin-card" data-campaign-id="${c.campaignId}" style="cursor:pointer">
        <div class="admin-card-header">
          <div>
            <div class="admin-card-title">${typeIcon} ${escapeHtml(c.name)}</div>
            <div class="admin-card-subtitle">
              ${expiry} · Issued: <strong>${issued}</strong> · Redeemed: <strong>${redeemed}</strong>
              ${c.description ? '<br><span style="color:var(--text-light)">'+escapeHtml(c.description)+'</span>' : ''}
            </div>
          </div>
          <div class="admin-card-actions">
            <span class="admin-card-badge ${typeBadge}">${c.voucherType.replace('_',' ')}</span>
            <span class="admin-card-badge ${c.status==='ACTIVE'?'badge-active':'badge-inactive'}">${c.status||'ACTIVE'}</span>
            <button class="pos-btn pos-btn-sm" data-view-campaign="${c.campaignId}">View</button>
          </div>
        </div>
      </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;

  $('#btnAddCampaign').onclick = ()=> openCampaignForm(container);

  container.querySelectorAll('[data-view-campaign]').forEach(btn=>{
    btn.onclick = (e)=>{
      e.stopPropagation();
      loadVoucherCampaignDetail(container, btn.dataset.viewCampaign);
    };
  });
  container.querySelectorAll('[data-campaign-id]').forEach(card=>{
    card.onclick = ()=>{
      loadVoucherCampaignDetail(container, card.dataset.campaignId);
    };
  });
}

function openCampaignForm(container){
  const form = document.createElement('div');
  form.className = 'admin-form';
  form.innerHTML = `<h3>New Voucher Campaign</h3>
    <div class="admin-form-group">
      <label>Name</label>
      <input id="cfName" class="pos-input" placeholder="e.g. Christmas 2026 Free Drink">
    </div>
    <div class="admin-form-group">
      <label>Description (optional)</label>
      <textarea id="cfDesc" class="pos-input" rows="2" placeholder="Internal note for admin context"></textarea>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group">
        <label>Voucher Type</label>
        <select id="cfType" class="pos-input">
          <option value="FREE_DRINK">🥤 FREE_DRINK — any drink + add-ons free</option>
          <option value="FREE_FOOD">🍪 FREE_FOOD — any food item free</option>
          <option value="FREE_COMBO">🥤🍪 FREE_COMBO — one drink + one food free</option>
        </select>
      </div>
    </div>
    <div class="admin-form-group">
      <label>Expiry</label>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
        <label style="font-weight:normal;display:flex;align-items:center;gap:8px">
          <input type="radio" name="cfExpiryMode" value="DAYS_FROM_ISSUE" checked>
          Days from issue
          <input id="cfExpiryDays" type="number" min="1" max="3650" value="30" class="pos-input" style="width:100px;margin-left:8px"> days
        </label>
        <label style="font-weight:normal;display:flex;align-items:center;gap:8px">
          <input type="radio" name="cfExpiryMode" value="FIXED_DATE">
          Fixed date
          <input id="cfExpiryDate" type="date" class="pos-input" style="margin-left:8px">
        </label>
      </div>
    </div>
    <div class="admin-form-actions">
      <button class="pos-btn pos-btn-primary" id="cfSubmit">Create Campaign</button>
      <button class="pos-btn" id="cfCancel">Cancel</button>
    </div>`;

  showFormModal(form);

  form.querySelector('#cfCancel').onclick = ()=> form._overlay.remove();
  form.querySelector('#cfSubmit').onclick = async()=>{
    const name = form.querySelector('#cfName').value.trim();
    const description = form.querySelector('#cfDesc').value.trim();
    const type = form.querySelector('#cfType').value;
    const mode = form.querySelector('input[name="cfExpiryMode"]:checked').value;
    let expiryValue;

    if(mode === 'DAYS_FROM_ISSUE'){
      const days = parseInt(form.querySelector('#cfExpiryDays').value, 10);
      if(!days || days < 1){ showError('Enter a valid number of days'); return; }
      expiryValue = days;
    } else {
      const dateStr = form.querySelector('#cfExpiryDate').value;
      if(!dateStr){ showError('Pick a fixed expiry date'); return; }
      // Treat date input as end-of-day local time so "valid through 2026-12-31" works as expected.
      const d = new Date(dateStr + 'T23:59:59');
      if(d.getTime() <= Date.now()){ showError('Expiry date must be in the future'); return; }
      expiryValue = d.toISOString();
    }

    if(!name){ showError('Name is required'); return; }

    try{
      await api('POST','/api/admin/vouchers/campaigns', {
        name, description, type, expiryMode: mode, expiryValue
      });
      form._overlay.remove();
      showSuccess('Campaign created');
      loadVoucherCampaignList(container);
    } catch(e){
      showError('Failed to create campaign');
    }
  };
}

async function loadVoucherCampaignDetail(container, campaignId){
  container.innerHTML = '<div class="loading">Loading campaign...</div>';
  try{
    const data = await api('GET',`/api/admin/vouchers/campaigns/${encodeURIComponent(campaignId)}`);
    renderVoucherCampaignDetail(container, data.campaign, data.stats || {}, data.vouchers || []);
  } catch(e){ container.innerHTML = '<div class="admin-empty"><p>Failed to load campaign</p></div>'; }
}

function renderVoucherCampaignDetail(container, campaign, stats, vouchers){
  const expiry = campaign.expiryMode === 'DAYS_FROM_ISSUE'
    ? `${campaign.expiryDays} days from issue`
    : `Fixed: ${new Date(campaign.expiryDate).toLocaleString()}`;
  const typeIcon = campaign.voucherType === 'FREE_DRINK' ? '🥤'
                  : campaign.voucherType === 'FREE_FOOD'  ? '🍪'
                  : '🥤🍪';

  let html = `<div class="admin-section">
    <div style="margin-bottom:16px">
      <button class="pos-btn pos-btn-sm" id="btnBackToCampaigns">← Back to campaigns</button>
    </div>
    <div class="admin-section-header">
      <h2>${typeIcon} ${escapeHtml(campaign.name)}</h2>
    </div>
    <div class="admin-card" style="margin-bottom:20px">
      <div class="admin-card-subtitle">
        <strong>${campaign.voucherType.replace('_',' ')}</strong> · ${expiry}<br>
        ${campaign.description ? escapeHtml(campaign.description)+'<br>' : ''}
        Total: <strong>${stats.total||0}</strong> ·
        Issued: <strong style="color:var(--success)">${stats.issued||0}</strong> ·
        Redeemed: <strong>${stats.redeemed||0}</strong> ·
        Expired: <strong style="color:var(--text-light)">${stats.expired||0}</strong>
      </div>
    </div>

    <div class="admin-form" style="margin-bottom:20px">
      <h3 style="margin-bottom:12px">Assign one voucher</h3>
      <div class="admin-form-row">
        <div class="admin-form-group">
          <label>Phone</label>
          <input id="avPhone" class="pos-input" placeholder="0168089999">
        </div>
        <div class="admin-form-group">
          <label>Name (optional)</label>
          <input id="avName" class="pos-input" placeholder="Aunty Jane">
        </div>
      </div>
      <div class="admin-form-group">
        <label>Note (optional)</label>
        <input id="avNote" class="pos-input" placeholder="Birthday gift">
      </div>
      <div class="admin-form-actions">
        <button class="pos-btn pos-btn-primary" id="avSubmit">Assign</button>
      </div>
    </div>

    <div class="admin-form" style="margin-bottom:20px">
      <h3 style="margin-bottom:8px">Bulk upload (CSV)</h3>
      <p style="color:var(--text-light);font-size:.85rem;margin-bottom:12px">
        Format: <code>phone,name,note</code> header row, max 1000 rows.
      </p>
      <input type="file" id="csvFile" accept=".csv,text/csv" class="pos-input">
      <div class="admin-form-actions">
        <button class="pos-btn pos-btn-primary" id="csvSubmit">Upload</button>
      </div>
      <div id="csvResult" style="margin-top:10px"></div>
    </div>

    <h3 style="margin:20px 0 10px">Issued vouchers (${vouchers.length})</h3>
    <input id="vSearch" class="pos-input" placeholder="Filter by phone or name" style="margin-bottom:12px">
    <div id="voucherList"></div>
  </div>`;

  container.innerHTML = html;

  container.querySelector('#btnBackToCampaigns').onclick = ()=>{
    loadVoucherCampaignList(container);
  };

  container.querySelector('#avSubmit').onclick = async()=>{
    const phone = container.querySelector('#avPhone').value.trim();
    const name = container.querySelector('#avName').value.trim();
    const note = container.querySelector('#avNote').value.trim();
    if(!phone){ showError('Phone required'); return; }
    try{
      await api('POST',`/api/admin/vouchers/campaigns/${encodeURIComponent(campaign.campaignId)}/assign`, { phone, name, note });
      container.querySelector('#avPhone').value = '';
      container.querySelector('#avName').value = '';
      container.querySelector('#avNote').value = '';
      showSuccess('Voucher assigned');
      loadVoucherCampaignDetail(container, campaign.campaignId);
    } catch(e){
      showError('Assignment failed (invalid phone or duplicate)');
    }
  };

  container.querySelector('#csvSubmit').onclick = async()=>{
    const file = container.querySelector('#csvFile').files[0];
    const resultEl = container.querySelector('#csvResult');
    if(!file){ showError('Pick a CSV file first'); return; }
    resultEl.innerHTML = '<span style="color:var(--text-light)">Uploading...</span>';
    try{
      const text = await file.text();
      const data = await api('POST',`/api/admin/vouchers/campaigns/${encodeURIComponent(campaign.campaignId)}/assign-csv`, { csv: text });
      const issued = data.issued || 0;
      const skipped = data.skipped || [];
      let msg = `<div style="color:var(--success);margin-bottom:6px">${issued} issued${skipped.length?', '+skipped.length+' skipped':''}.</div>`;
      if(skipped.length){
        msg += '<details style="font-size:.85rem;color:var(--text-light)"><summary>Show skipped rows</summary><ul style="margin-top:6px">';
        skipped.slice(0, 50).forEach(s=>{
          msg += `<li>Row ${s.row||'?'} — ${escapeHtml(s.phone||'(empty)')} — ${escapeHtml(s.reason)}</li>`;
        });
        if(skipped.length > 50) msg += `<li>...and ${skipped.length - 50} more</li>`;
        msg += '</ul></details>';
      }
      resultEl.innerHTML = msg;
      container.querySelector('#csvFile').value = '';
      // Refresh the voucher list portion only (keep CSV result visible).
      const fresh = await api('GET',`/api/admin/vouchers/campaigns/${encodeURIComponent(campaign.campaignId)}`);
      renderVoucherTable(container, fresh.vouchers || [], campaign.campaignId, '');
    } catch(e){
      resultEl.innerHTML = '<span style="color:var(--warning)">Upload failed</span>';
    }
  };

  const search = container.querySelector('#vSearch');
  search.oninput = ()=> renderVoucherTable(container, vouchers, campaign.campaignId, search.value.toLowerCase());
  renderVoucherTable(container, vouchers, campaign.campaignId, '');
}

function renderVoucherTable(container, vouchers, campaignId, filter){
  const list = container.querySelector('#voucherList');
  if(!list) return;
  const now = Math.floor(Date.now() / 1000);
  const filtered = filter
    ? vouchers.filter(v => (v.phone||'').toLowerCase().includes(filter) || (v.name||'').toLowerCase().includes(filter))
    : vouchers;

  if(!filtered.length){
    list.innerHTML = '<div class="admin-empty"><p>No vouchers match.</p></div>';
    return;
  }

  // Sort: ISSUED+active first, then REDEEMED, then EXPIRED, then by issuedAt desc.
  const rank = v => {
    const expired = v.status === 'ISSUED' && (v.expiresAtEpoch || 0) <= now;
    if(v.status === 'ISSUED' && !expired) return 0;
    if(v.status === 'REDEEMED') return 1;
    return 2;
  };
  filtered.sort((a,b)=>{
    const ra = rank(a), rb = rank(b);
    if(ra !== rb) return ra - rb;
    return (b.issuedAt||'').localeCompare(a.issuedAt||'');
  });

  let html = `<table style="width:100%;border-collapse:collapse">
    <tr style="border-bottom:2px solid var(--cream-dark);text-align:left">
      <th style="padding:8px 0">Phone</th>
      <th style="padding:8px 0">Name</th>
      <th style="padding:8px 0">Status</th>
      <th style="padding:8px 0">Issued</th>
      <th style="padding:8px 0">Expires / Redeemed</th>
      <th style="padding:8px 0;text-align:right">Action</th>
    </tr>`;
  filtered.forEach(v=>{
    const expired = v.status === 'ISSUED' && (v.expiresAtEpoch || 0) <= now;
    let statusBadge, statusClass, expiryCell;
    if(v.status === 'REDEEMED'){
      statusBadge = 'REDEEMED'; statusClass = 'badge-inactive';
      expiryCell = v.redeemedAt
        ? `${new Date(v.redeemedAt).toLocaleDateString()}${v.menuItemName?'<br><span style="font-size:.75rem;color:var(--text-light)">'+escapeHtml(v.menuItemName)+(v.variant?' ('+escapeHtml(v.variant)+')':'')+'</span>':''}`
        : '—';
    } else if(expired){
      statusBadge = 'EXPIRED'; statusClass = 'badge-inactive';
      expiryCell = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : '—';
    } else {
      statusBadge = 'ISSUED'; statusClass = 'badge-active';
      expiryCell = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString() : '—';
    }
    const action = (v.status === 'ISSUED' && !expired)
      ? `<button class="pos-btn pos-btn-sm pos-btn-danger" data-revoke-id="${v.voucherId}" data-revoke-phone="${escapeAttr(v.phone)}">Revoke</button>`
      : '';
    html += `<tr style="border-bottom:1px solid var(--cream-dark)">
      <td style="padding:8px 0">${escapeHtml(v.phone||'')}</td>
      <td style="padding:8px 0">${escapeHtml(v.name||'—')}</td>
      <td style="padding:8px 0"><span class="admin-card-badge ${statusClass}">${statusBadge}</span></td>
      <td style="padding:8px 0">${v.issuedAt ? new Date(v.issuedAt).toLocaleDateString() : '—'}</td>
      <td style="padding:8px 0">${expiryCell}</td>
      <td style="padding:8px 0;text-align:right">${action}</td>
    </tr>`;
  });
  html += '</table>';
  list.innerHTML = html;

  list.querySelectorAll('[data-revoke-id]').forEach(btn=>{
    btn.onclick = async()=>{
      const voucherId = btn.dataset.revokeId;
      const phone = btn.dataset.revokePhone;
      if(!confirm('Revoke this voucher? This cannot be undone.')) return;
      try{
        await api('DELETE',`/api/admin/vouchers/${encodeURIComponent(voucherId)}?phone=${encodeURIComponent(phone)}`);
        showSuccess('Voucher revoked');
        loadVoucherCampaignDetail(container, campaignId);
      } catch(e){
        showError('Revoke failed');
      }
    };
  });
}

function escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeAttr(s){ return escapeHtml(s); }

// Strip only leading emoji + whitespace — safe for plain-text exports
// (clipboard, CSV) that would otherwise carry rendering-fragile characters.
// Anchored pattern; a global \p{Emoji} replace would also strip digits and
// other legitimate characters that Unicode treats as emoji-capable.
function stripLeadingEmoji(s) {
  return String(s || '').replace(/^[\p{Emoji}\p{Emoji_Component}\s]+/u, '').trim();
}

