/**
 * Guards `scripts/test-markers.cjs` — the shared definition of how
 * test-created production records are tagged.
 *
 * This is the contract between the live-write suites (which stamp records) and
 * `scripts/cleanup-test-data.mjs` (which finds them by the same prefix). Before
 * it existed, the match strings were duplicated as literals in both places and
 * the Playwright customer journey used a third spelling ("Demo Customer"), so
 * its orders were invisible to cleanup and stayed in the Sunday figures.
 */

import { normalizePhone } from '../src/lib/phone';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const markers = require('../../scripts/test-markers.cjs');

const { TEST_PREFIX, MARKERS, isTestRecord, phoneFor, isTestPhone } = markers;

describe('test markers', () => {
  it('every marker value carries the prefix', () => {
    for (const [key, value] of Object.entries(MARKERS)) {
      expect(typeof value).toBe('string');
      expect(value as string).toContain(TEST_PREFIX);
    }
  });

  it('recognises a marked record', () => {
    expect(isTestRecord({ customerName: MARKERS.customerName })).toBe(true);
    expect(isTestRecord({ approvedBy: MARKERS.approvedBy })).toBe(true);
    expect(isTestRecord({ customerName: MARKERS.walkUpName })).toBe(true);
  });

  it('does not match a real record', () => {
    expect(isTestRecord({ customerName: 'Alice', approvedBy: 'Grace' })).toBe(false);
    expect(isTestRecord({})).toBe(false);
    expect(isTestRecord(null)).toBe(false);
    // A name that merely contains the prefix mid-string is not a test record.
    expect(isTestRecord({ customerName: `Real ${TEST_PREFIX}x` })).toBe(false);
  });
});

describe('reserved test phone range', () => {
  it('is already canonical — normalizePhone leaves it unchanged', () => {
    for (const n of [0, 1, 42, 99]) {
      const phone = phoneFor(n);
      expect(normalizePhone(phone)).toBe(phone);
    }
  });

  it('recognises the stored canonical form', () => {
    // The form cleanup actually reads out of DynamoDB.
    expect(isTestPhone(phoneFor(7))).toBe(true);
  });

  it('recognises the same number entered in any accepted format', () => {
    // Each of these normalises to 0119900007, so cleanup must catch them all.
    for (const input of ['+60119900007', '60119900007', '011-9900 007', '0119900007']) {
      expect(normalizePhone(input)).toBe(phoneFor(7));
      expect(isTestPhone(input)).toBe(true);
    }
  });

  it('does not match a real customer number', () => {
    expect(isTestPhone('0168089999')).toBe(false);
    expect(isTestPhone('+60168089999')).toBe(false);
    expect(isTestPhone('')).toBe(false);
    expect(isTestPhone(undefined as any)).toBe(false);
  });

  it('pads the sequence so every number stays in range', () => {
    expect(phoneFor(0)).toBe('0119900000');
    expect(phoneFor(9)).toBe('0119900009');
    expect(phoneFor(99)).toBe('0119900099');
  });
});
