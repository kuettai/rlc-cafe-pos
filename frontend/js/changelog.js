/**
 * Changelog modal — shared between admin.html and reports.html.
 *
 * Wires up any `.app-version` element on the page so clicking it opens
 * a modal listing every entry from `changelog.json` (fetched on first
 * open, then cached in-memory). Uses inline styles + a private overlay
 * so it works on any page that includes this script without depending
 * on stylesheet additions.
 *
 * Deliberately NOT included on pos.html / index.html — only admin +
 * reports load this file (via <script src="js/changelog.js">).
 */
(function () {
  'use strict';

  let cachedEntries = null;              // Array<{version, date, changes[]}>
  let openOverlay = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function loadChangelog() {
    if (cachedEntries) return cachedEntries;
    // Relative path — works whether the site is served from `/` or a
    // sub-path (GitHub Pages custom domain etc.). Cache-busting is
    // handled by the service worker's version bump.
    const res = await fetch('changelog.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cachedEntries = await res.json();
    if (!Array.isArray(cachedEntries)) cachedEntries = [];
    return cachedEntries;
  }

  function renderEntry(e) {
    const changes = Array.isArray(e.changes) ? e.changes : [];
    const items = changes.map(c => `<li style="margin:2px 0">${esc(c)}</li>`).join('');
    return `
      <article style="padding:12px 14px;border-bottom:1px solid var(--cream-dark,#E5DACB)">
        <header style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px">
          <span style="font-weight:700;color:var(--primary,#6B4226);background:var(--cream,#F5EFE6);padding:2px 8px;border-radius:6px;font-size:.85rem">${esc(e.version || '?')}</span>
          <span style="color:var(--text-light,#7A6355);font-size:.8rem">${esc(e.date || '')}</span>
        </header>
        <ul style="margin:0;padding-left:20px;font-size:.9rem;line-height:1.45">${items}</ul>
      </article>`;
  }

  function close() {
    if (!openOverlay) return;
    document.removeEventListener('keydown', onKey);
    openOverlay.remove();
    openOverlay = null;
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  async function open() {
    if (openOverlay) return; // already open

    // Overlay + panel — inline styles so no CSS changes required.
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Changelog');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px';
    overlay.innerHTML = `
      <div style="background:#fff;color:var(--text,#2A1F17);border-radius:14px;max-width:640px;width:100%;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.25);overflow:hidden">
        <header style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--cream-dark,#E5DACB);background:var(--cream,#F5EFE6)">
          <h2 style="margin:0;font-size:1.1rem;color:var(--primary,#6B4226)">📋 Changelog</h2>
          <button type="button" data-changelog-close aria-label="Close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;padding:4px 10px;color:var(--text-light,#7A6355);line-height:1">✕</button>
        </header>
        <div data-changelog-body style="overflow-y:auto;flex:1;min-height:80px">
          <div style="padding:24px;text-align:center;color:var(--text-light,#7A6355)">Loading…</div>
        </div>
        <footer style="padding:10px 18px;border-top:1px solid var(--cream-dark,#E5DACB);background:var(--cream,#F5EFE6);font-size:.75rem;color:var(--text-light,#7A6355);text-align:right">Press Esc or click outside to close</footer>
      </div>`;

    // Click-outside-to-close (only when the mousedown started on the
    // overlay itself, not on child content — prevents accidental close
    // when text-selecting inside the modal and releasing outside).
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) close();
    });
    overlay.querySelector('[data-changelog-close]').addEventListener('click', close);

    document.body.appendChild(overlay);
    openOverlay = overlay;
    document.addEventListener('keydown', onKey);

    const body = overlay.querySelector('[data-changelog-body]');
    try {
      const entries = await loadChangelog();
      if (!entries.length) {
        body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-light,#7A6355)">No entries.</div>';
        return;
      }
      body.innerHTML = entries.map(renderEntry).join('');
    } catch (err) {
      body.innerHTML = `<div style="padding:24px;text-align:center;color:#B91C1C">Failed to load changelog: ${esc(err && err.message || 'error')}</div>`;
    }
  }

  function wire() {
    document.querySelectorAll('.app-version').forEach(el => {
      if (el.dataset.changelogWired === '1') return;
      el.dataset.changelogWired = '1';
      el.style.cursor = 'pointer';
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('title', 'View changelog');
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
