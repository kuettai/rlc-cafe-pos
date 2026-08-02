# Screenshot Journeys

Automated screenshot capture for deck walkthrough presentations.

## Setup

```bash
npm install -D @playwright/test
npx playwright install chromium
```

## Run All Journeys

```bash
npx playwright test
```

## Run Individual Journeys

```bash
npx playwright test --project=customer-mobile
npx playwright test --project=cashier-tablet
npx playwright test --project=admin-desktop
```

## Output

Screenshots are saved to:
- `screenshots/journey_customer/*.png` — Customer ordering flow (iPhone 12 viewport)
- `screenshots/journey_cashier/*.png` — Cashier POS flow (iPad viewport)
- `screenshots/journey_admin/*.png` — Admin dashboard flow (Desktop viewport)

## Notes

- Tests run against the live site (https://153.oasisofcare.org)
- Café must be OPEN for customer journey to capture the menu
- Test credentials come from the environment: `TEST_ADMIN_USER`/`TEST_ADMIN_PIN`
  and `TEST_CASHIER_USER`/`TEST_CASHIER_PIN`. Specs fail fast if unset.
- Screenshots use `fullPage: true` for complete page captures
- Run with `--headed` to watch: `npx playwright test --headed`
