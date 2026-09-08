import { logAuth } from '../src/lib/audit';

/**
 * `logAuth` is the only record of who logged in and from where (added after an
 * unattributable ADMIN login on 2026-08-02), so the exact shape of the line
 * matters — a forensic grep is written against it. These tests assert the
 * whole string, not a substring.
 *
 * `logOrder`'s identical `extra` loop is already covered by orders.test.ts /
 * planogram.test.ts; only the `[AUTH]` half is exercised here.
 */
describe('logAuth', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  /** The single string handed to console.log. */
  const line = (): string => {
    expect(logSpy).toHaveBeenCalledTimes(1);
    return logSpy.mock.calls[0][0] as string;
  };

  describe('the line prefix', () => {
    it('logs prefix and outcome when no extra is passed at all', () => {
      logAuth('SUCCESS');
      expect(line()).toBe('[AUTH] SUCCESS');
    });

    it('logs prefix and outcome for an empty extra object', () => {
      logAuth('FAILED', {});
      expect(line()).toBe('[AUTH] FAILED');
    });

    it('appends key=value pairs in insertion order', () => {
      logAuth('BLOCKED', { id: 'admin', ip: '1.2.3.4', ua: 'curl/8.4' });
      expect(line()).toBe('[AUTH] BLOCKED id=admin ip=1.2.3.4 ua=curl/8.4');
    });
  });

  describe('empty values are elided', () => {
    it('skips an undefined value', () => {
      logAuth('FAILED', { id: 'admin', ip: undefined });
      expect(line()).toBe('[AUTH] FAILED id=admin');
    });

    it('skips a null value', () => {
      logAuth('FAILED', { id: 'admin', ip: null });
      expect(line()).toBe('[AUTH] FAILED id=admin');
    });

    it('skips an empty-string value', () => {
      logAuth('FAILED', { id: 'admin', ua: '' });
      expect(line()).toBe('[AUTH] FAILED id=admin');
    });

    it('skips every empty value while keeping the ones between them', () => {
      logAuth('SUCCESS', {
        a: undefined,
        id: 'cashier',
        b: null,
        ip: '10.0.0.9',
        c: '',
      });
      expect(line()).toBe('[AUTH] SUCCESS id=cashier ip=10.0.0.9');
    });

    it('leaves no double space or trailing space when a value is elided', () => {
      logAuth('SUCCESS', { id: 'admin', ip: undefined, ua: null });
      const s = line();
      expect(s).not.toMatch(/ {2}/);
      expect(s).toBe(s.trim());
    });
  });

  describe('falsy-but-present values are kept', () => {
    it('keeps 0 (it is not an empty value)', () => {
      logAuth('BLOCKED', { attemptsLeft: 0 });
      expect(line()).toBe('[AUTH] BLOCKED attemptsLeft=0');
    });

    it('keeps false', () => {
      logAuth('FAILED', { remembered: false });
      expect(line()).toBe('[AUTH] FAILED remembered=false');
    });
  });

  describe('object values are JSON.stringified', () => {
    it('stringifies a plain object', () => {
      logAuth('BLOCKED', { block: { until: '2026-09-02T01:00:00Z', tries: 5 } });
      expect(line()).toBe(
        '[AUTH] BLOCKED block={"until":"2026-09-02T01:00:00Z","tries":5}',
      );
    });

    it('stringifies an array', () => {
      logAuth('SUCCESS', { roles: ['ADMIN', 'CASHIER'] });
      expect(line()).toBe('[AUTH] SUCCESS roles=["ADMIN","CASHIER"]');
    });

    it('stringifies an empty object rather than eliding it', () => {
      logAuth('SUCCESS', { meta: {} });
      expect(line()).toBe('[AUTH] SUCCESS meta={}');
    });

    it('does not use the [object Object] form String() would give', () => {
      logAuth('SUCCESS', { meta: { a: 1 } });
      expect(line()).not.toContain('[object Object]');
    });
  });

  describe('primitive values go through String()', () => {
    it('renders a number', () => {
      logAuth('FAILED', { attempts: 3 });
      expect(line()).toBe('[AUTH] FAILED attempts=3');
    });

    it('renders a boolean', () => {
      logAuth('SUCCESS', { firstLogin: true });
      expect(line()).toBe('[AUTH] SUCCESS firstLogin=true');
    });

    it('renders a string as-is', () => {
      logAuth('SUCCESS', { id: 'ZZTEST_Admin' });
      expect(line()).toBe('[AUTH] SUCCESS id=ZZTEST_Admin');
    });
  });

  describe('one call is one line', () => {
    it('emits exactly one console.log per call, whatever extra holds', () => {
      logAuth('SUCCESS', { id: 'admin', ip: '1.2.3.4', meta: { x: 1 }, gone: null });
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(line()).toBe('[AUTH] SUCCESS id=admin ip=1.2.3.4 meta={"x":1}');
    });
  });
});
