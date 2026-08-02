/**
 * Jest setup — runs before each test file.
 *
 * `signToken`/`verifyToken` fail closed without a strong JWT_SECRET (see
 * src/lib/auth.ts), so supply a test-only value. This is NOT a real secret and
 * must never match a deployed one. Individual suites override it as needed.
 */
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'jest-test-secret-do-not-use-in-any-environment-0123456789';
