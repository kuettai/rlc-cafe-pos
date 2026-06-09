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
 *
 *   window.renderVariantPicker(item, container, onChange)   — alias
 *   window.getSelectedVariants(itemId)                      — by-id lookup
 *   window.getSelectedVariant(itemId)                       — legacy by-id
 */
(function () {
  'use strict';

  /**
   * Build the selector HTML for a menu item.
   *
   * @param {Object} item  Menu item with .variantGroups or legacy .variants.
   * @param {Object} [opts]
   * @param {String} [opts.itemId]      Override for data-item-id (default: item.id || item.menuItemId).
   * @param {Array}  [opts.preselected] [{group, option}] entries to mark active.
   *                                    When omitted, single-select groups default to the first option.
   * @returns {String} HTML markup. Empty string if the item has no variants.
   */
  function pickerHtml(item, opts) {
    opts = opts || {};
    const itemId = opts.itemId || item.id || item.menuItemId;
    const preselected = opts.preselected || [];
    const explicit = preselected.length > 0;
    const isPre = (g, n) => preselected.some(p => p.group === g && p.option === n);

    let html = '';
    if (item.variantGroups && item.variantGroups.length) {
      html += `<div class="variant-groups" data-item-id="${itemId}">`;
      item.variantGroups.forEach(g => {
        html += `<div class="variant-group" data-group="${g.group}" data-type="${g.type}">`;
        g.options.forEach((o, i) => {
          const priceTag = o.price ? ` (+RM${o.price})` : '';
          const active = explicit
            ? isPre(g.group, o.name)
            : (g.type === 'single' && i === 0);
          html += `<button class="vg-btn ${active ? 'active' : ''}" data-option="${o.name}" data-price="${o.price || 0}">${o.name}${priceTag}</button>`;
        });
        html += `</div>`;
      });
      html += `</div>`;
    } else if (item.variants && item.variants.length) {
      html += `<div class="variants" data-item-id="${itemId}">`;
      item.variants.forEach((v, i) => {
        const active = i === 0;
        const priceTag = v.priceModifier ? ` (+RM${v.priceModifier})` : '';
        html += `<button class="${active ? 'active' : ''}" data-variant="${v.id}" aria-pressed="${active}">${v.name}${priceTag}</button>`;
      });
      html += `</div>`;
    }
    return html;
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
        if (group.dataset.type === 'single') {
          group.querySelectorAll('.vg-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        } else {
          btn.classList.toggle('active');
        }
        fire(btn.closest('.variant-groups') || rootEl);
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
  };
  window.renderVariantPicker = renderVariantPicker;
  window.getSelectedVariants = getSelectedVariants;
  window.getSelectedVariant = getSelectedVariant;
})();
