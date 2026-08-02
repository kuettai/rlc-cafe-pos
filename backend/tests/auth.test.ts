import { hashPin, comparePin, signToken, verifyToken } from '../src/lib/auth';

// signToken/verifyToken now refuse to operate without a strong JWT_SECRET, so
// the suite supplies one. Set before any token call; the secret is read lazily.
const ORIGINAL_SECRET = process.env.JWT_SECRET;
beforeAll(() => {
  process.env.JWT_SECRET = 'test-only-secret-not-used-anywhere-real-0123456789';
});
afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_SECRET;
});

describe('JWT secret handling (fails closed)', () => {
  const withSecret = (value: string | undefined, fn: () => void) => {
    const prev = process.env.JWT_SECRET;
    if (value === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = value;
    try { fn(); } finally { process.env.JWT_SECRET = prev; }
  };

  const payload = { userId: 'u1', name: 'Test', role: 'ADMIN' };

  it('refuses to sign when the secret is unset', () => {
    withSecret(undefined, () => expect(() => signToken(payload)).toThrow(/JWT_SECRET/));
  });

  it('refuses known placeholder secrets', () => {
    // Both of these were live at some point and are public in the repo.
    for (const bad of ['default-secret', 'CHANGE_ME_BEFORE_DEPLOY']) {
      withSecret(bad, () => expect(() => signToken(payload)).toThrow(/JWT_SECRET/));
    }
  });

  it('refuses a secret shorter than 32 characters', () => {
    withSecret('short-but-not-a-placeholder', () => {
      expect(() => signToken(payload)).toThrow(/JWT_SECRET/);
    });
  });

  it('refuses to verify a token signed with a rotated-away secret', () => {
    let token = '';
    withSecret('old-secret-value-0123456789012345678901', () => { token = signToken(payload); });
    withSecret('new-secret-value-0123456789012345678901', () => {
      expect(() => verifyToken(token)).toThrow();
    });
  });
});

describe('Auth Library', () => {
  // Arbitrary values — deliberately NOT any real PIN.
  const SAMPLE_PIN = '907531';
  const OTHER_PIN = '482260';

  describe('hashPin / comparePin', () => {
    it('should hash a PIN and verify it correctly', () => {
      const pin = SAMPLE_PIN;
      const hash = hashPin(pin);
      expect(hash).not.toBe(pin);
      expect(comparePin(pin, hash)).toBe(true);
    });

    it('should reject wrong PIN', () => {
      const hash = hashPin(SAMPLE_PIN);
      expect(comparePin(OTHER_PIN, hash)).toBe(false);
    });

    it('should produce different hashes for same PIN (salt)', () => {
      const h1 = hashPin(SAMPLE_PIN);
      const h2 = hashPin(SAMPLE_PIN);
      expect(h1).not.toBe(h2);
    });
  });

  describe('signToken / verifyToken', () => {
    it('should sign and verify a token', () => {
      const payload = { userId: 'user-1', name: 'Test', role: 'CASHIER' };
      const token = signToken(payload);
      const decoded = verifyToken(token);
      expect(decoded.userId).toBe('user-1');
      expect(decoded.name).toBe('Test');
      expect(decoded.role).toBe('CASHIER');
    });

    it('should reject an invalid token', () => {
      expect(() => verifyToken('invalid.token.here')).toThrow();
    });

    it('should include iat and exp in token', () => {
      const token = signToken({ userId: 'u1', name: 'N', role: 'ADMIN' });
      const decoded = verifyToken(token) as any;
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeDefined();
      expect(decoded.exp - decoded.iat).toBe(8 * 3600);
    });
  });
});
