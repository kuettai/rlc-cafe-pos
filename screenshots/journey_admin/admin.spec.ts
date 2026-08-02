import { test, expect } from '@playwright/test';

// Credentials are never committed — set them in the environment:
//   TEST_ADMIN_USER=... TEST_ADMIN_PIN=... npx playwright test
const ADMIN_USER = process.env.TEST_ADMIN_USER || '';
const ADMIN_PIN = process.env.TEST_ADMIN_PIN || '';

test.describe('Admin Journey', () => {
  test.describe.configure({ mode: 'serial' });

  test.skip(!ADMIN_USER || !ADMIN_PIN, 'TEST_ADMIN_USER / TEST_ADMIN_PIN not set');

  let page: any;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('01 - Login page', async () => {
    await page.goto('https://153.oasisofcare.org/admin.html');
    await page.waitForSelector('#loginForm');
    await page.screenshot({ path: 'screenshots/journey_admin/01-login.png', fullPage: true });
  });

  test('02 - Menu tab (default after login)', async () => {
    await page.fill('#loginUser', ADMIN_USER);
    await page.fill('#loginPin', ADMIN_PIN);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('[data-tab="menu"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'screenshots/journey_admin/02-menu-tab.png', fullPage: true });
  });

  test('03 - Ingredients tab', async () => {
    await page.click('[data-tab="ingredients"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'screenshots/journey_admin/03-ingredients-tab.png', fullPage: true });
  });

  test('04 - Users tab', async () => {
    await page.click('[data-tab="users"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'screenshots/journey_admin/04-users-tab.png', fullPage: true });
  });

  test('05 - Reports tab', async () => {
    await page.click('[data-tab="reports"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'screenshots/journey_admin/05-reports-tab.png', fullPage: true });
  });

  test('06 - Settings tab', async () => {
    await page.click('[data-tab="settings"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'screenshots/journey_admin/06-settings-tab.png', fullPage: true });
  });

  test('07 - Checklist tab', async () => {
    await page.click('[data-tab="checklist"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'screenshots/journey_admin/07-checklist-tab.png', fullPage: true });
  });

  test('08 - Planogram tab', async () => {
    await page.click('[data-tab="planogram"]');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'screenshots/journey_admin/08-planogram-tab.png', fullPage: true });
  });
});
