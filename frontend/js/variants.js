/**
 * Shared variant picker for RLC Café.
 *
 * Renders the same selector UI used by the customer ordering page (app.js)
 * and the order tracking edit mode (track.js). Supports the new variantGroups
 * format (Temperature single-select, Milk optional, Flavor single, etc.) and
 * the legacy flat `variants` array still present on a few records.
 *
 * Public API (attached to `window`):
 *   RLCVariants.pickerHtml(item, opts)   → returns HTML string
 *   RLCVariants.bindPicker(rootEl, onChange)
 *   RLCVariants.renderVariantPicker(item, container, onChange)
 *   RLCVariants.getSelectedVariantsFromContainer(container)
 *   RLCVariants.applyOptionExclusions(item, excludedOptions)
 *
 *   window.renderVariantPicker(item, container, onChange)   — alias
 *   window.getSelectedVariants(itemId)                      — by-id lookup
 *   window.getSelectedVariant(itemId)                       — legacy by-id
 */
(function () {
  'use strict';

  /**
   * Escape all five HTML-significant characters, so the same helper is safe in a
   * quoted attribute as well as in text.
   *
   * Module-private on purpose, and NOT a fifth page-bundle copy: this file is
   * loaded by index.html, track.html AND pos.html, whose bundles each name their
   * own escaper differently (`escHtml`, `escHtml`, `escapeHtmlPos`). Borrowing a
   * sibling global would emit raw HTML on whichever page does not happen to
   * define that name. Variant markup is built in exactly one place, so its
   * escaping lives in exactly one place too.
   *
   * Every string below is admin-controlled (Admin → Menu → Option Groups) and
   * renders into every customer's and cashier's browser, so it is escaped at
   * every site, not just the newest one.
   */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Shown in the collapsed summary when nothing is selected yet.
  const CHOOSE_HINT = 'Choose your options';

  /** Selected option names inside a `.variant-groups` wrapper, in group order. */
  function chosenOptionNames(wrapEl) {
    return getSelectedVariantsFromContainer(wrapEl).map(v => v.option);
  }

  /**
   * Rewrite the collapsed one-line summary from the live selection.
   * Writes `textContent`, so the value must NOT be escaped first.
   */
  function refreshChosenSummary(wrapEl) {
    if (!wrapEl) return;
    const out = wrapEl.querySelector('.variant-chosen-text');
    if (!out) return;
    const picked = chosenOptionNames(wrapEl);
    out.textContent = picked.length ? picked.join(' · ') : CHOOSE_HINT;
  }

  /**
   * Build the selector HTML for a menu item.
   *
   * Every group prints its NAME. Without it a first-timer sees three anonymous
   * pill rows — `[Hot][Iced]` `[Soy Milk]` `[Normal][Less][None]` — and cannot
   * tell "normal" *what*. The group name is also the row's accessible name, and
   * every option carries `aria-pressed` (the legacy `.variants` path below always
   * did, so the newer markup used to be the less accessible of the two).
   *
   * @param {Object} item  Menu item with .variantGroups or legacy .variants.
   * @param {Object} [opts]
   * @param {String} [opts.itemId]      Override for data-item-id (default: item.id || item.menuItemId).
   * @param {Array}  [opts.preselected] [{group, option}] entries to mark active.
   *                                    When omitted, single-select groups default to the first option.
   * @param {Boolean} [opts.collapsible] Render the groups behind a one-line
   *                                    "chosen options" summary with a Change
   *                                    disclosure. Opt-in: the customer menu
   *                                    lists 14 cards and cannot afford three
   *                                    open pill rows on each, while the order-edit
   *                                    and voucher pickers show one item at a time
   *                                    and want the choices visible immediately.
   * @returns {String} HTML markup. Empty string if the item has no variants.
   */
  function pickerHtml(item, opts) {
    opts = opts || {};
    const itemId = opts.itemId || item.id || item.menuItemId;
    const preselected = opts.preselected || [];
    const explicit = preselected.length > 0;
    const isPre = (g, n) => preselected.some(p => p.group === g && p.option === n);
    const collapsible = opts.collapsible === true;

    let html = '';
    if (item.variantGroups && item.variantGroups.length) {
      const chosen = [];
      let groups = '';
      item.variantGroups.forEach(g => {
        // 'single' is the one type that must end up with exactly one option
        // chosen; anything else (today: 'optional') may legitimately end up empty,
        // which is what the customer needs told — the group is otherwise
        // indistinguishable from a single-select they have failed to answer.
        const single = g.type === 'single';
        groups += `<div class="variant-group-block">`;
        groups += `<span class="variant-group-label">${esc(g.group)}${single ? '' : ' <em>optional</em>'}</span>`;
        groups += `<div class="variant-group" role="group" aria-label="${esc(g.group)}${single ? '' : ' (optional)'}" data-group="${esc(g.group)}" data-type="${esc(g.type)}">`;
        (g.options || []).forEach((o, i) => {
          const priceTag = o.price ? ` (+RM${esc(o.price)})` : '';
          const active = explicit
            ? isPre(g.group, o.name)
            : (single && i === 0);
          if (active) chosen.push(o.name);
          groups += `<button type="button" class="vg-btn ${active ? 'active' : ''}" aria-pressed="${active}" data-option="${esc(o.name)}" data-price="${esc(o.price || 0)}">${esc(o.name)}${priceTag}</button>`;
        });
        groups += `</div></div>`;
      });

      html += `<div class="variant-groups${collapsible ? ' is-collapsible' : ''}" data-item-id="${esc(itemId)}">`;
      if (collapsible) {
        const listId = `vg-list-${itemId}`;
        html += `<div class="variant-chosen">
          <span class="variant-chosen-text">${esc(chosen.length ? chosen.join(' · ') : CHOOSE_HINT)}</span>
          <button type="button" class="variant-chosen-toggle" aria-expanded="false" aria-controls="${esc(listId)}">Change</button>
        </div>`;
        html += `<div class="variant-group-list" id="${esc(listId)}" hidden>${groups}</div>`;
      } else {
        html += groups;
      }
      html += `</div>`;
    } else if (item.variants && item.variants.length) {
      html += `<div class="variants" data-item-id="${esc(itemId)}">`;
      item.variants.forEach((v, i) => {
        const active = i === 0;
        const priceTag = v.priceModifier ? ` (+RM${esc(v.priceModifier)})` : '';
        html += `<button type="button" class="${active ? 'active' : ''}" data-variant="${esc(v.id)}" aria-pressed="${active}">${esc(v.name)}${priceTag}</button>`;
      });
      html += `</div>`;
    }
    return html;
  }

  /**
   * Strip variant options a pre-order campaign excludes, e.g. no Oat Milk on a
   * ministry link (`excludedOptions: ["Milk:Oat Milk"]`).
   *
   * Lives here rather than in a page module because two surfaces need it — the
   * customer ordering page (app.js) and the pre-order edit flow on track.html
   * (track.js) — and variant selection is a single source of truth. Callers own
   * the decision of WHEN it applies; this function only knows how.
   *
   * Returns the item unchanged (same object identity) when nothing is excluded,
   * so the normal customer flow is untouched. A group left with no options is
   * dropped entirely rather than rendered empty.
   *
   * This only HIDES choices — createOrder / the order-update path enforce the
   * same rule server-side, so a crafted payload is still refused.
   *
   * @param {Object} item
   * @param {Array<String>} excludedOptions  "Group:Option" pairs.
   */
  function applyOptionExclusions(item, excludedOptions) {
    if (!item) return item;
    const excluded = Array.isArray(excludedOptions) ? excludedOptions : [];
    if (!excluded.length) return item;

    const blocked = new Set(excluded.map(String));
    const isBlocked = (group, option) =>
      blocked.has(`${String(group == null ? '' : group).trim()}:${String(option == null ? '' : option).trim()}`);

    const out = { ...item };

    if (Array.isArray(item.variantGroups) && item.variantGroups.length) {
      out.variantGroups = item.variantGroups
        .map(g => ({ ...g, options: (g.options || []).filter(o => !isBlocked(g.group, o.name)) }))
        .filter(g => g.options.length > 0);
    }

    // Legacy flat variants carry no group, so match on the option half.
    if (Array.isArray(item.variants) && item.variants.length) {
      const blockedNames = new Set([...blocked].map(b => b.slice(b.indexOf(':') + 1)));
      out.variants = item.variants.filter(v => !blockedNames.has(String(v.name || v.id || v).trim()));
    }

    return out;
  }

  /**
   * Read the selected variants out of a container (or any of its descendants).
   *
   * @param {HTMLElement} container
   * @returns {Array<{group, option, price}>}  Empty array if no .variant-group found.
   */
  function getSelectedVariantsFromContainer(container) {
    if (!container) return [];
    const out = [];
    container.querySelectorAll('.variant-group').forEach(g => {
      const group = g.dataset.group;
      g.querySelectorAll('.vg-btn.active').forEach(btn => {
        out.push({
          group,
          option: btn.dataset.option,
          price: parseFloat(btn.dataset.price) || 0,
        });
      });
    });
    return out;
  }

  /**
   * Wire click handlers on every variant button inside `rootEl`.
   * Handles both new (.vg-btn within .variant-group) and legacy (.variants > button) markup.
   * Calls onChange(selected[]) after every change, scoped to the changed widget.
   */
  function bindPicker(rootEl, onChange) {
    if (!rootEl) return;
    function fire(scopeEl) {
      if (typeof onChange === 'function') {
        onChange(getSelectedVariantsFromContainer(scopeEl));
      }
    }

    rootEl.querySelectorAll('.vg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.variant-group');
        // `.active` drives the styling and every existing reader
        // (getSelectedVariantsFromContainer, getSelectedVariant); `aria-pressed`
        // is kept in lockstep with it so the state is announced and so the
        // non-colour ✓ cue in the stylesheet has something to hang off.
        if (group.dataset.type === 'single') {
          group.querySelectorAll('.vg-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
          });
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
        } else {
          const on = !btn.classList.contains('active');
          btn.classList.toggle('active', on);
          btn.setAttribute('aria-pressed', String(on));
        }
        const wrap = btn.closest('.variant-groups');
        refreshChosenSummary(wrap);
        fire(wrap || rootEl);
      });
    });

    // Collapsed picker: one disclosure per card. No-op when pickerHtml was called
    // without `collapsible`, since the toggle is not in the markup at all.
    rootEl.querySelectorAll('.variant-chosen-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const wrap = btn.closest('.variant-groups');
        const list = wrap && wrap.querySelector('.variant-group-list');
        if (!list) return;
        const opening = list.hasAttribute('hidden');
        if (opening) list.removeAttribute('hidden');
        else list.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', String(opening));
        btn.textContent = opening ? 'Done' : 'Change';
      });
    });

    const legacyContainers = rootEl.matches && rootEl.matches('.variants')
      ? [rootEl]
      : Array.from(rootEl.querySelectorAll('.variants'));
    legacyContainers.forEach(c => {
      c.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          c.querySelectorAll('button').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
          });
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
          fire(c);
        });
      });
    });
  }

  /**
   * High-level: render the picker into `container` and wire events. If the
   * passed item carries `selectedVariants`, those are used as the initial
   * preselection so the picker reflects the customer's prior choice.
   *
   * Calls onChange once immediately with the initial selection so callers
   * can derive price/labels without an extra read.
   */
  function renderVariantPicker(item, container, onChange) {
    if (!container) return;
    container.innerHTML = pickerHtml(item, {
      itemId: item.id || item.menuItemId,
      preselected: (item.selectedVariants || []).map(sv => ({
        group: sv.group,
        option: sv.option,
      })),
    });
    bindPicker(container, onChange);
    if (typeof onChange === 'function') {
      onChange(getSelectedVariantsFromContainer(container));
    }
  }

  // ── Compat helpers used by app.js's existing inline cart code ──────────
  function getSelectedVariants(itemId) {
    return getSelectedVariantsFromContainer(
      document.querySelector(`.variant-groups[data-item-id="${itemId}"]`)
    );
  }
  function getSelectedVariant(itemId) {
    const c = document.querySelector(`.variants[data-item-id="${itemId}"]`);
    if (!c) return null;
    const active = c.querySelector('.active');
    return active ? active.dataset.variant : (c.querySelector('button')?.dataset.variant || null);
  }

  window.RLCVariants = {
    pickerHtml,
    bindPicker,
    renderVariantPicker,
    getSelectedVariantsFromContainer,
    applyOptionExclusions,
  };
  window.renderVariantPicker = renderVariantPicker;
  window.getSelectedVariants = getSelectedVariants;
  window.getSelectedVariant = getSelectedVariant;
})();
