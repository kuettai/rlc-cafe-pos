import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

/**
 * Values that must never be accepted as a signing secret. `default-secret` was
 * the old in-code fallback and `CHANGE_ME_BEFORE_DEPLOY` was the value actually
 * deployed — both are published in the public repository, which made every
 * ADMIN token forgeable by anyone who read the source. Refusing them is a
 * tripwire against that regressing.
 */
const PLACEHOLDER_SECRETS = new Set([
  'default-secret',
  'CHANGE_ME_BEFORE_DEPLOY',
  'CHANGE_ME',
  'changeme',
  'secret',
]);

const MIN_SECRET_LENGTH = 32;

/**
 * Resolve the signing secret, failing closed.
 *
 * Deliberately throws rather than falling back: an API that is down is
 * recoverable, whereas an API signing tokens with a publicly known secret
 * silently grants anyone ADMIN access. Read lazily (not at module load) so the
 * failure surfaces per-request and is visible in logs.
 *
 * Generate one with:  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
 */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || PLACEHOLDER_SECRETS.has(secret) || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      'JWT_SECRET is missing, a known placeholder, or shorter than '
      + `${MIN_SECRET_LENGTH} characters — refusing to sign or verify tokens.`,
    );
  }
  return secret;
}

export interface TokenPayload {
  userId: string;
  name: string;
  role: string;
}

// 8h covers a full Sunday including setup and close-down. Rotating JWT_SECRET
// invalidates every outstanding token immediately — that is the only way to
// revoke one, since nothing re-checks the user record per request.
export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '8h' });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, getJwtSecret()) as TokenPayload;
}

export function hashPin(pin: string): string {
  return bcrypt.hashSync(pin, 10);
}

export function comparePin(pin: string, hash: string): boolean {
  return bcrypt.compareSync(pin, hash);
}
