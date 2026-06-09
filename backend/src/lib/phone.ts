/**
 * Malaysian phone number normalizer.
 *
 * Accepts a variety of user-entered formats and produces a single canonical
 * representation: digits-only, with a leading `0`, 10–11 digits long.
 *
 * Examples (all → "0168089999"):
 *   "0168089999"        → "0168089999"
 *   "+60168089999"      → "0168089999"
 *   "60168089999"       → "0168089999"
 *   "+168089999"        → "0168089999"   (missing country code, treated as local)
 *   "016-808-9999"      → "0168089999"
 *   "016 808 9999"      → "0168089999"
 *
 * Rules:
 *   1. Strip all non-digit characters.
 *   2. If the result starts with the Malaysia country code "60" and is at
 *      least 10 digits long, drop the "60" prefix.
 *   3. If the result does not start with "0", prepend "0".
 *   4. Validate length: must be 10 or 11 digits (Malaysian local format with
 *      leading 0). Anything else returns `null`.
 *
 * Records previously stored in canonical "0168089999" form pass through
 * unchanged, so existing data remains addressable.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;

  let digits = String(input).replace(/[^0-9]/g, '');
  if (!digits) return null;

  // Strip Malaysia country code "60" only when it could plausibly be one
  // (≥10 digits total — a bare "60..." short number is left alone so it
  // still fails validation rather than being silently mangled).
  if (digits.length >= 10 && digits.startsWith('60')) {
    digits = digits.slice(2);
  }

  // Ensure local-format leading zero.
  if (!digits.startsWith('0')) {
    digits = '0' + digits;
  }

  // Malaysian mobile/local: 10–11 digits including the leading 0.
  if (digits.length < 10 || digits.length > 11) return null;

  return digits;
}
