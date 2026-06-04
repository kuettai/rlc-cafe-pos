import { test, expect, Page, Browser } from '@playwright/test';

const BASE_URL = 'https://153.oasisofcare.org/';
const SCREENSHOT_DIR = 'screenshots/journey_customer/';

test.describe('Customer Journey', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let browser: Browser;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      screenshot: undefined,
    });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('01 - Menu browse', async () => {
    await page.goto(BASE_URL);
    const closed = await page.locator('text=/closed/i').isVisible().catch(() => false);
    if (closed) {
      console.log('Café is closed');
      await page.screenshot({ path: `${SCREENSHOT_DIR}01-cafe-closed.png`, fullPage: true });
      return;
    }
    await page.waitForSelector('.menu-item', { timeout: 15000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}01-menu-browse.png`, fullPage: true });
  });

  test('02 - Celebration banner', async () => {
    const celebration = await page.locator('[class*=celebration], [class*=Celebration], .celebration-banner').first();
    if (await celebration.isVisible().catch(() => false)) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}02-menu-celebration.png`, fullPage: true });
    } else {
      console.log('No celebration mode active, skipping');
    }
  });

  test('03 - Item variant selection', async () => {
    const variantBtn = page.locator('.variants button').first();
    await variantBtn.click();
    await page.screenshot({ path: `${SCREENSHOT_DIR}03-item-variant.png`, fullPage: true });
  });

  test('04 - Add to cart', async () => {
    const addBtn = page.locator('.qty-controls button[data-action="inc"]').first();
    await addBtn.click();
    await page.waitForSelector('#cartBar', { state: 'visible' });
    await page.screenshot({ path: `${SCREENSHOT_DIR}04-cart-add.png`, fullPage: true });
  });

  test('05 - Open cart panel', async () => {
    await page.locator('#cartBar').click();
    await page.waitForSelector('#cartOverlay', { state: 'visible' });
    await page.screenshot({ path: `${SCREENSHOT_DIR}05-cart-open.png`, fullPage: true });
  });

  test('06 - Fill name and ready to submit', async () => {
    await page.locator('#nameInput').fill('Demo Customer');
    await page.screenshot({ path: `${SCREENSHOT_DIR}06-cart-submit.png`, fullPage: true });
  });

  test('07 - Submit order and tracking page', async () => {
    await page.locator('#cartSubmit').click();
    await page.waitForURL(/track\?id=/, { timeout: 15000 });
    await page.waitForSelector('.track-stepper', { timeout: 10000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}07-order-tracking.png`, fullPage: true });
  });

  test('08 - Order pending details', async () => {
    await page.screenshot({ path: `${SCREENSHOT_DIR}08-order-pending.png`, fullPage: true });
  });

  test('09 - Cancel button visible', async () => {
    await page.waitForSelector('.cancel-btn', { state: 'visible' });
    await page.screenshot({ path: `${SCREENSHOT_DIR}09-order-cancel.png`, fullPage: true });
  });

  test('Cleanup - Cancel order', async () => {
    page.on('dialog', dialog => dialog.accept());
    await page.locator('.cancel-btn').click();
    await page.waitForTimeout(1000);
  });
});
