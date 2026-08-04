/**
 * test-markers.cjs — the ONE definition of how test-created production records
 * are tagged.
 *
 * Every suite that writes to the live API stamps the records it creates with
 * `TEST_PREFIX`, and `cleanup-test-data.mjs` finds them by that same prefix. If
 * the two ever disagree, test records become invisible to cleanup and stay in
 * the Sunday figures forever — which is exactly what happened to the
 * "Demo Customer" orders created by the Playwright customer journey, because
 * cleanup matched only the integration suite's literals.
 *
 * CommonJS on purpose: it is `require`d by the ts-jest suites and the Playwright
 * specs, and default-imported by the ESM `.mjs` scripts. One file, three
 * runtimes, no duplication.
 *
 * Changing TEST_PREFIX orphans every record already written under the old one.
 * Run `node scripts/cleanup-test-data.mjs --all --apply` with the old value
 * first.
 */

/**
 * Prefix on every human-readable field of a test-created record.
 *
 * `ZZ` sorts last in any name-ordered list, so test rows collect at the bottom
 * of reports rather than in the middle of real customers.
 */
const TEST_PREFIX = 'ZZTEST_';

/** Fields that carry the prefix, and so are safe to match cleanup on. */
const MARKED_FIELDS = ['customerName', 'approvedBy'];

/** Ready-made values, so no suite invents its own spelling. */
const MARKERS = {
  /** Customer-submitted orders (public POST /api/orders, customer journey). */
  customerName: `${TEST_PREFIX}Customer`,
  /** Cashier/admin actor on approve, walk-up, reject. */
  approvedBy: `${TEST_PREFIX}Admin`,
  /** Walk-up orders created from the POS. */
  walkUpName: `${TEST_PREFIX}WalkUp`,
  /** Customer registration — see phoneFor() for the phone number. */
  customerRegistrationName: `${TEST_PREFIX}Registration`,
};

/** True if any marked field on this record carries the prefix. */
function isTestRecord(record) {
  if (!record) return false;
  return MARKED_FIELDS.some(f => typeof record[f] === 'string' && record[f].startsWith(TEST_PREFIX));
}

/**
 * Reserved phone range for test customers: 011-9900 0NN.
 *
 * Customer records key on a phone number, which cannot carry a text prefix, so
 * the range itself is the marker. This block is not issuable by a Malaysian
 * carrier, so it can never collide with a real customer.
 *
 * Returned in the **canonical** form produced by `normalizePhone` (digits only,
 * leading 0, 10 digits) — that is what is stored and what customer lookups key
 * on, so tests and cleanup must both speak it.
 */
const TEST_PHONE_RE = /^01199000\d{2}$/;

function phoneFor(n = 0) {
  return `01199000${String(n).padStart(2, '0')}`;
}

/**
 * True if this phone number is in the reserved test range.
 *
 * Applies the same normalisation as `backend/src/lib/phone.ts` first, so a
 * record written from `+60119900001` and one written from `011-9900 001` are
 * both recognised.
 */
function isTestPhone(phone) {
  if (typeof phone !== 'string') return false;
  let digits = phone.replace(/[^0-9]/g, '');
  if (digits.length >= 10 && digits.startsWith('60')) digits = digits.slice(2);
  if (!digits.startsWith('0')) digits = '0' + digits;
  return TEST_PHONE_RE.test(digits);
}

module.exports = {
  TEST_PREFIX,
  MARKED_FIELDS,
  MARKERS,
  TEST_PHONE_RE,
  isTestRecord,
  phoneFor,
  isTestPhone,
};
