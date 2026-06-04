import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './screenshots',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  use: {
    baseURL: 'https://153.oasisofcare.org',
    screenshot: 'off',
    trace: 'off',
  },
  projects: [
    {
      name: 'customer-mobile',
      testMatch: 'journey_customer/**',
      use: { ...devices['iPhone 12'], browserName: 'chromium' },
    },
    {
      name: 'cashier-tablet',
      testMatch: 'journey_cashier/**',
      use: { viewport: { width: 1024, height: 768 }, browserName: 'chromium' },
    },
    {
      name: 'admin-desktop',
      testMatch: 'journey_admin/**',
      use: { viewport: { width: 1280, height: 800 }, browserName: 'chromium' },
    },
  ],
});
