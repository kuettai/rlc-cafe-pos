module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Supplies a test-only JWT_SECRET; src/lib/auth.ts refuses to sign or verify
  // without a strong one.
  setupFiles: ['<rootDir>/tests/setup.ts'],
};
