/**
 * Malaysian phone number normalizer (browser).
 *
 * Mirrors backend/src/lib/phone.ts. Keep the two implementations in sync.
 *
 * All of the following normalize to "0168089999":
 *   "0168089999"
 *   "+60168089999"
 *   "60168089999"
 *   "+168089999"
 *   "016-808-9999"
 *   "016 808 9999"
 *
 * Returns null for empty / non-numeric / out-of-range input.
 * Output is always digits-only, leading 0, 10-11 chars.
 */
function normalizePhone(input) {
  if (!input) return null;

  let digits = String(input).replace(/[^0-9]/g, '');
  if (!digits) return null;

  if (digits.length >= 10 && digits.startsWith('60')) {
    digits = digits.slice(2);
  }

  if (!digits.startsWith('0')) {
    digits = '0' + digits;
  }

  if (digits.length < 10 || digits.length > 11) return null;

  return digits;
}

// Expose globally so app.js (and any future page) can use it.
window.normalizePhone = normalizePhone;
