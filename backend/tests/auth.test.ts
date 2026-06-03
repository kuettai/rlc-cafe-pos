import { hashPin, comparePin, signToken, verifyToken } from '../src/lib/auth';

describe('Auth Library', () => {
  describe('hashPin / comparePin', () => {
    it('should hash a PIN and verify it correctly', () => {
      const pin = '123456';
      const hash = hashPin(pin);
      expect(hash).not.toBe(pin);
      expect(comparePin(pin, hash)).toBe(true);
    });

    it('should reject wrong PIN', () => {
      const hash = hashPin('123456');
      expect(comparePin('000000', hash)).toBe(false);
    });

    it('should produce different hashes for same PIN (salt)', () => {
      const h1 = hashPin('1234');
      const h2 = hashPin('1234');
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
