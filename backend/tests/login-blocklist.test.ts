import { isBlockedIdentifier, BLOCKED_LOGIN_PATTERNS } from '../src/routes/auth';

describe('isBlockedIdentifier', () => {
  it('blocks the bare reserved name in any casing', () => {
    for (const v of ['admin', 'Admin', 'ADMIN', 'aDmIn']) {
      expect(isBlockedIdentifier(v)).toBe(true);
    }
  });

  it('blocks the seed account userId in any casing', () => {
    for (const v of ['admin-001', 'Admin-001', 'ADMIN-001', 'admin-002']) {
      expect(isBlockedIdentifier(v)).toBe(true);
    }
  });

  it('blocks despite surrounding whitespace', () => {
    expect(isBlockedIdentifier('  admin  ')).toBe(true);
    expect(isBlockedIdentifier('\tAdmin-001\n')).toBe(true);
  });

  it('blocks anything else beginning with the reserved prefix', () => {
    expect(isBlockedIdentifier('administrator')).toBe(true);
    expect(isBlockedIdentifier('admin_backup')).toBe(true);
  });

  it('allows real volunteer identifiers', () => {
    for (const v of [
      'Sarah', 'KuetTai', 'Roy4608', 'Meiyii5122', 'Nicole6338',
      'f7026cd0-1917-48ae-a943-b81f1c4ad5a1',
      'badmin',        // contains but does not start with the prefix
      'sysadmin',      // ditto
    ]) {
      expect(isBlockedIdentifier(v)).toBe(false);
    }
  });

  it('handles non-string and empty input without throwing', () => {
    for (const v of [undefined, null, '', '   ', 0, 42, {}, []]) {
      expect(isBlockedIdentifier(v)).toBe(false);
    }
  });

  it('exposes the pattern list for review', () => {
    expect(BLOCKED_LOGIN_PATTERNS.length).toBeGreaterThan(0);
    expect(BLOCKED_LOGIN_PATTERNS.every(p => p instanceof RegExp)).toBe(true);
  });
});
