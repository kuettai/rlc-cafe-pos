import { test, expect, Page } from '@playwright/test';

const BASE_URL = 'https://153.oasisofcare.org/pos.html';
const DIR = 'screenshots/journey_cashier';

test.describe('Cashier Journey', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test('01 - Login page', async () => {
    await page.goto(BASE_URL);
    await page.waitForSelector('#loginForm');
    await page.screenshot({ path: `${DIR}/01-login.png`, fullPage: true });
  });

  test('02 - Dashboard after login', async () => {
    await page.fill('#loginUser', 'Sarah');
    await page.fill('#loginPin', '1234');
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector('.pos-topbar');
    await page.waitForTimeout(1500);

    // If café is closed, open it
    const openBtn = page.locator('#btnCafeToggle');
    const btnText = await openBtn.textContent();
    if (btnText && btnText.includes('Open')) {
      await openBtn.click();
      await page.waitForTimeout(500);
      // Handle checklist if it appears
      const checkboxes = page.locator('.pos-modal-overlay input[type="checkbox"]');
      const count = await checkboxes.count();
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          await checkboxes.nth(i).check();
        }
        await page.waitForTimeout(300);
        // Click the open/confirm button in the modal
        const confirmBtn = page.locator('.pos-modal-overlay button:has-text("Open"), .pos-modal-overlay button:has-text("Confirm")');
        if (await confirmBtn.count() > 0) {
          await confirmBtn.first().click();
        }
      }
      await page.waitForTimeout(1500);
    }

    await page.waitForSelector('#orderBoard');
    await page.screenshot({ path: `${DIR}/02-dashboard.png`, fullPage: true });
  });

  test('03 - Order cards', async () => {
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${DIR}/03-order-card.png`, fullPage: true });
  });

  test('04 - Order detail modal', async () => {
    const card = page.locator('.pos-card').first();
    if (await card.count() > 0) {
      await card.click();
      await page.waitForSelector('.pos-modal-overlay');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${DIR}/04-order-detail.png`, fullPage: true });
    } else {
      await page.screenshot({ path: `${DIR}/04-order-detail.png`, fullPage: true });
    }
  });

  test('05 - Walk-up modal', async () => {
    // Close any open modal
    const overlay = page.locator('.pos-modal-overlay');
    if (await overlay.count() > 0) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    await page.click('#btnWalkup');
    await page.waitForSelector('.pos-modal-walkup');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/05-walkup-modal.png`, fullPage: true });
  });

  test('06 - Walk-up cart with item', async () => {
    const addBtn = page.locator('.pos-modal-walkup .pos-add-btn').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${DIR}/06-walkup-cart.png`, fullPage: true });
  });

  test('07 - Menu panel', async () => {
    await page.locator('.pos-modal-overlay .pos-modal-close').click();
    await page.waitForTimeout(500);

    await page.click('#btnMenu');
    await page.waitForSelector('.pos-menu-toggles');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${DIR}/07-menu-panel.png`, fullPage: true });
  });

  test('08 - Prep view', async () => {
    await page.locator('.pos-modal-overlay .pos-modal-close').click();
    await page.waitForTimeout(500);

    await page.click('#btnPrep');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${DIR}/08-prep-view.png`, fullPage: true });
  });

  test('09 - History', async () => {
    await page.locator('.pos-modal-overlay .pos-modal-close').click();
    await page.waitForTimeout(500);

    await page.click('#btnHistory');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${DIR}/09-history.png`, fullPage: true });
  });

  test('10 - Stats bar', async () => {
    await page.locator('.pos-modal-overlay .pos-modal-close').click();
    await page.waitForTimeout(500);

    const stats = page.locator('#posStats');
    await stats.screenshot({ path: `${DIR}/10-stats.png` });
  });
});
