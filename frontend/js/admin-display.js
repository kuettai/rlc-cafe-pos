// admin-display.js — Display slide management (TV screen promo images).
// Depends on: admin.js (api, showError, showSuccess, showFormModal, $, escapeHtml, escapeAttr, authHeaders).
//
// Workflow:
//   1. Admin picks an image file.
//   2. Client-side resize/compress (see resizeImage below) — keeps
//      uploads under ~500 KB and 1280 px wide.
//   3. GET /api/admin/display/upload-url → presigned S3 PUT URL.
//   4. PUT the resized blob to S3.
//   5. POST /api/admin/display/slides with the returned imageUrl,
//      start date, expiry date, title, sort order.
//
// Deletion doesn't remove the S3 object (cheap; safer to leave).

async function loadDisplay(container){
  container.innerHTML = '<div class="loading">Loading slides...</div>';
  try {
    const [data, settings] = await Promise.all([
      api('GET', '/api/admin/display/slides'),
      api('GET', '/api/admin/settings'),
    ]);
    renderDisplaySection(container, data.slides || [], settings);
  } catch(e){
    container.innerHTML = '<div class="admin-empty"><p>Failed to load slides</p></div>';
  }
}

function slideStatus(slide, todayIso){
  // todayIso is YYYY-MM-DD. startDate/expiryDate are inclusive.
  if (slide.startDate && todayIso < slide.startDate) return { label:'Scheduled', cls:'badge-cashier' };
  if (slide.expiryDate && todayIso > slide.expiryDate) return { label:'Expired',   cls:'badge-inactive' };
  return { label:'Active', cls:'badge-active' };
}

function renderDisplaySection(container, slides, settings){
  const todayIso = new Date().toISOString().split('T')[0];
  const fallbackUrl = settings.displayFallbackVideoUrl || '';

  let html = `<div class="admin-section">
    <div class="admin-section-header">
      <h2>📺 Display Slides</h2>
      <button class="pos-btn pos-btn-primary" id="btnAddSlide">+ Upload Slide</button>
    </div>
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:16px">
      Promo images shown on the café TV display. Recommended: 16:9 landscape, 1280×720 px.
      Images larger than 1280 px wide are auto-resized on upload; files over ~500 KB are re-compressed.
    </p>`;

  if (!slides.length){
    html += '<div class="admin-empty"><p>No slides uploaded yet. The display will show the default branding.</p></div>';
  } else {
    slides.forEach(s => {
      const st = slideStatus(s, todayIso);
      const preview = s.imageUrl
        ? `<img src="${escapeAttr(s.imageUrl)}" alt="" style="width:120px;height:68px;object-fit:cover;border-radius:6px;background:#111;flex-shrink:0" onerror="this.style.display='none'">`
        : '';
      html += `<div class="admin-card">
        <div class="admin-card-header" style="align-items:center;gap:12px">
          ${preview}
          <div style="min-width:0;flex:1">
            <div class="admin-card-title">${escapeHtml(s.title || '(untitled)')}</div>
            <div class="admin-card-subtitle">
              Sort: ${Number(s.sortOrder || 0)} · Runs: ${escapeHtml(s.startDate || '—')} → ${escapeHtml(s.expiryDate || '—')}
              <div style="margin-top:4px;font-family:monospace;font-size:.75rem;color:var(--text-light);word-break:break-all">${escapeHtml(s.imageUrl || '')}</div>
            </div>
          </div>
          <div class="admin-card-actions" style="flex-shrink:0">
            <span class="admin-card-badge ${st.cls}">${st.label}</span>
            <button class="pos-btn pos-btn-sm pos-btn-danger" data-del-slide="${escapeAttr(s.slideId)}">Delete</button>
          </div>
        </div>
      </div>`;
    });
  }

  const displayMode = settings.displayMode || 'slides';
  html += `</div>
  <div class="admin-section" style="margin-top:24px">
    <div class="admin-section-header"><h2>🎬 Display Mode</h2></div>
    <p style="color:var(--text-light);font-size:.85rem;margin-bottom:12px">
      Choose what the TV promo panel shows. You can switch between uploaded slides or a YouTube video.
    </p>
    <div class="admin-form">
      <div class="admin-form-group">
        <label>Mode</label>
        <div style="display:flex;gap:12px;margin-bottom:12px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="radio" name="displayMode" value="slides" ${displayMode === 'slides' ? 'checked' : ''}> Uploaded Slides
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="radio" name="displayMode" value="youtube" ${displayMode === 'youtube' ? 'checked' : ''}> YouTube Video
          </label>
        </div>
      </div>
      <div class="admin-form-group" id="youtubeUrlGroup">
        <label>YouTube URL</label>
        <input id="fallbackVideoUrl" class="pos-input" placeholder="https://www.youtube.com/watch?v=..." value="${escapeAttr(fallbackUrl)}">
        <p style="font-size:.75rem;color:var(--text-light);margin-top:4px">Accepts watch URLs (youtube.com/watch?v=...) or short URLs (youtu.be/...). Plays muted on loop.</p>
      </div>
      <div class="admin-form-actions" style="margin-top:12px">
        <button class="pos-btn pos-btn-primary" id="btnSaveDisplayMode">Save Display Settings</button>
      </div>
    </div>
  </div>`;

  container.innerHTML = html;

  $('#btnAddSlide').onclick = () => openSlideUploadForm(container);

  $('#btnSaveDisplayMode').onclick = async () => {
    const mode = container.querySelector('input[name="displayMode"]:checked')?.value || 'slides';
    const url = container.querySelector('#fallbackVideoUrl').value.trim();
    try {
      await api('PUT', '/api/admin/settings', { displayMode: mode, displayFallbackVideoUrl: url });
      showSuccess('Display settings saved');
    } catch(e) { showError('Failed to save display settings'); }
  };

  container.querySelectorAll('[data-del-slide]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.delSlide;
      if (!confirm('Delete this slide? The image will stop showing on the TV.')) return;
      try {
        await api('DELETE', `/api/admin/display/slides/${encodeURIComponent(id)}`);
        loadDisplay(container);
      } catch(e){ showError('Delete failed'); }
    };
  });
}

// --- Upload form ---
function openSlideUploadForm(container){
  const today = new Date().toISOString().split('T')[0];
  // Default expiry: 30 days out. Admins usually want a limited-run promo.
  const monthOut = new Date(Date.now() + 30 * 86400_000).toISOString().split('T')[0];

  const form = document.createElement('form');
  form.className = 'admin-form';
  form.innerHTML = `
    <h3 style="margin-bottom:12px">Upload Display Slide</h3>
    <p style="color:var(--text-light);font-size:.8rem;margin-bottom:12px">
      Recommended: 16:9 landscape, 1280×720 px. Larger images are auto-resized.
    </p>
    <div class="admin-form-group" style="margin-bottom:10px">
      <label>Image file</label>
      <input id="slideFile" type="file" accept="image/*" required class="pos-input">
      <div id="slidePreview" style="margin-top:8px;display:none">
        <img id="slidePreviewImg" style="max-width:100%;max-height:180px;border-radius:8px;background:#111">
        <div id="slideSizeInfo" style="font-size:.75rem;color:var(--text-light);margin-top:4px"></div>
      </div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Title (optional)</label><input id="slideTitle" class="pos-input" maxlength="80" placeholder="e.g. Christmas Special"></div>
      <div class="admin-form-group"><label>Sort order</label><input id="slideSort" type="number" class="pos-input" value="0" style="max-width:100px"></div>
    </div>
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Start date</label><input id="slideStart" type="date" class="pos-input" value="${today}" required></div>
      <div class="admin-form-group"><label>Expiry date</label><input id="slideExpiry" type="date" class="pos-input" value="${monthOut}" required></div>
    </div>
    <div class="admin-form-actions" style="margin-top:12px">
      <button type="submit" class="pos-btn pos-btn-primary" id="slideSubmit">Upload</button>
      <button type="button" class="pos-btn" id="slideCancel">Cancel</button>
    </div>
    <p id="slideProgress" style="margin-top:10px;font-size:.85rem;color:var(--text-light)"></p>
  `;
  showFormModal(form);

  // Cache the resized blob so pressing Upload doesn't re-resize.
  let resizedBlob = null;

  const fileInput = form.querySelector('#slideFile');
  const previewWrap = form.querySelector('#slidePreview');
  const previewImg = form.querySelector('#slidePreviewImg');
  const sizeInfo = form.querySelector('#slideSizeInfo');
  const progress = form.querySelector('#slideProgress');

  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { previewWrap.style.display = 'none'; resizedBlob = null; return; }
    progress.textContent = 'Resizing...';
    try {
      resizedBlob = await resizeImage(file);
      previewImg.src = URL.createObjectURL(resizedBlob);
      sizeInfo.textContent = `Original: ${(file.size / 1024).toFixed(0)} KB → Optimized: ${(resizedBlob.size / 1024).toFixed(0)} KB`;
      previewWrap.style.display = '';
      progress.textContent = '';
    } catch(e){
      progress.textContent = 'Failed to process image.';
      resizedBlob = null;
    }
  };

  form.querySelector('#slideCancel').onclick = () => form._overlay.remove();

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!resizedBlob) { showError('Pick an image first'); return; }

    const title      = form.querySelector('#slideTitle').value.trim();
    const startDate  = form.querySelector('#slideStart').value;
    const expiryDate = form.querySelector('#slideExpiry').value;
    const sortOrder  = parseInt(form.querySelector('#slideSort').value, 10) || 0;

    if (!startDate || !expiryDate){ showError('Start and expiry dates are required'); return; }
    if (expiryDate < startDate){ showError('Expiry must be on or after start date'); return; }

    const submitBtn = form.querySelector('#slideSubmit');
    submitBtn.disabled = true;

    try {
      // 1. Get a presigned S3 PUT URL. The filename is a hint only —
      //    the backend sanitizes it and namespaces it under display-slides/.
      progress.textContent = 'Requesting upload URL...';
      const filename = (fileInput.files[0].name || 'slide.jpg').replace(/[^A-Za-z0-9._-]/g, '_');
      const stampedName = `${Date.now()}-${filename.replace(/\.[^.]+$/, '')}.jpg`;
      const q = `filename=${encodeURIComponent(stampedName)}&contentType=image/jpeg`;
      const presign = await api('GET', `/api/admin/display/upload-url?${q}`);

      // 2. PUT the blob directly to S3. `fetch` with the presigned URL
      //    doesn't need any auth headers — the URL itself is the credential.
      progress.textContent = 'Uploading image...';
      const uploadRes = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: resizedBlob,
      });
      if (!uploadRes.ok) throw new Error('S3 upload failed');

      // 3. Record the slide.
      progress.textContent = 'Saving slide...';
      await api('POST', '/api/admin/display/slides', {
        imageUrl: presign.imageUrl,
        title, startDate, expiryDate, sortOrder,
      });

      form._overlay.remove();
      loadDisplay(container);
      showSuccess('Slide uploaded');
    } catch(err){
      console.error(err);
      progress.textContent = '';
      showError('Upload failed');
      submitBtn.disabled = false;
    }
  };
}

// --- Client-side image resize + compress ---
// Two-pass strategy:
//   Pass 1: encode as JPEG at high quality (0.92). If small enough, return.
//   Pass 2: fall back to `maxQuality` (0.8) to hit the size cap.
// Wider than `maxWidth` = downscale first, preserving aspect ratio.
async function resizeImage(file, maxWidth = 1280, maxQuality = 0.8, maxBytes = 500000){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxWidth){
        h = Math.round(h * maxWidth / w);
        w = maxWidth;
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      // White background so transparent PNGs don't render as black when
      // re-encoded to JPEG.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob(blob1 => {
        URL.revokeObjectURL(url);
        if (!blob1){ reject(new Error('toBlob returned null')); return; }
        if (blob1.size <= maxBytes){ resolve(blob1); return; }
        canvas.toBlob(blob2 => {
          if (!blob2){ reject(new Error('toBlob returned null')); return; }
          resolve(blob2);
        }, 'image/jpeg', maxQuality);
      }, 'image/jpeg', 0.92);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image load failed'));
    };
    img.src = url;
  });
}
