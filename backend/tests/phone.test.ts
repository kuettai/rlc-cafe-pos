import { normalizePhone } from '../src/lib/phone';

describe('normalizePhone', () => {
  describe('canonical input is preserved', () => {
    it('keeps an already-canonical 10-digit local number', () => {
      expect(normalizePhone('0168089999')).toBe('0168089999');
    });

    it('keeps an already-canonical 11-digit local number (011-prefix)', () => {
      expect(normalizePhone('01168089999')).toBe('01168089999');
    });
  });

  describe('country code handling', () => {
    it('strips +60 prefix', () => {
      expect(normalizePhone('+60168089999')).toBe('0168089999');
    });

    it('strips bare 60 prefix', () => {
      expect(normalizePhone('60168089999')).toBe('0168089999');
    });

    it('strips +60 with separators', () => {
      expect(normalizePhone('+60 16-808 9999')).toBe('0168089999');
    });

    it('strips +60 for 11-digit numbers (601X-prefix)', () => {
      expect(normalizePhone('+601168089999')).toBe('01168089999');
    });
  });

  describe('separator handling', () => {
    it('strips dashes', () => {
      expect(normalizePhone('016-808-9999')).toBe('0168089999');
    });

    it('strips mixed dashes', () => {
      expect(normalizePhone('016-8089999')).toBe('0168089999');
    });

    it('strips spaces', () => {
      expect(normalizePhone('016 808 9999')).toBe('0168089999');
    });

    it('strips parentheses and dots', () => {
      expect(normalizePhone('(016).808.9999')).toBe('0168089999');
    });
  });

  describe('missing leading zero', () => {
    it('prepends 0 to a 9-digit number missing the leading 0', () => {
      expect(normalizePhone('168089999')).toBe('0168089999');
    });

    it('prepends 0 to a 10-digit 011-prefix number missing the leading 0', () => {
      expect(normalizePhone('1168089999')).toBe('01168089999');
    });

    it('handles +X without country code (treats as missing leading 0)', () => {
      expect(normalizePhone('+168089999')).toBe('0168089999');
    });
  });

  describe('all variants of the same number normalize to the same value', () => {
    const canonical = '0168089999';
    const variants = [
      '0168089999',
      '+60168089999',
      '60168089999',
      '+168089999',
      '016-808-9999',
      '016-8089999',
      '016 808 9999',
      '(016) 808-9999',
      '+60 16 808 9999',
    ];

    it.each(variants)('"%s" → 0168089999', (input) => {
      expect(normalizePhone(input)).toBe(canonical);
    });
  });

  describe('invalid input', () => {
    it('returns null for empty string', () => {
      expect(normalizePhone('')).toBeNull();
    });

    it('returns null for null', () => {
      expect(normalizePhone(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(normalizePhone(undefined)).toBeNull();
    });

    it('returns null for a string with no digits', () => {
      expect(normalizePhone('not-a-phone')).toBeNull();
    });

    it('returns null when too short (after normalization)', () => {
      expect(normalizePhone('12345')).toBeNull();
    });

    it('returns null when too long (after normalization)', () => {
      expect(normalizePhone('012345678901234')).toBeNull();
    });
  });
});
