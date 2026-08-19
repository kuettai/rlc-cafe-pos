---
name: test-suites
description: How to run the RLC Café POS test suites safely — which are offline and which write to the live production café (and the 3 ungated read-only live GETs in `integration.test.ts` that run on every `npm test`), why every test file must be a MODULE (`export {};`) or ts-jest silently drops a whole suite on a cold cache while warm runs stay green, why it must be `npm test` (`TZ=UTC jest`) and never a bare `npx jest`, the ZZTEST_ prefix every test-created record must carry, the reserved test phone range, the Sunday-afternoon end-of-day-email hazard, why a Playwright `page.route()` block does NOT stop writes (service workers bypass it — this already took a menu item off the live customer menu) the `serviceWorkers:'block'` + positive-control harness rule and the two classes of read-only browser probe (fixture probe: 0 production-host requests; live probe: 0 non-GET, aborted and counted), why a banned-word or leaked-value scan must walk visible text nodes rather than `document.body.textContent`, and the cleanup procedure afterwards. Use before running any test, adding a suite that writes data, driving any frontend page in a real browser against the live API, or cleaning up after a live run.
---

# Test Suites

Authoritative content: read `.kiro/skills/test-suites/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before running any test.

**Short version:** run `npm test` (which is `TZ=UTC jest`) — not a bare
`npx jest`, which drops the UTC pin that stops timezone bugs hiding on a
Malaysian dev machine. `integration.test.ts` and the Playwright journeys write to
the **live production café** — ask first, then clean up with
`scripts/cleanup-test-data.mjs`. Every test-created record must be stamped from
`scripts/test-markers.cjs`; never hardcode a marker string. Do not run the live
suites on a Sunday afternoon: the close now leaves the cron to email the real
end-of-day summary, and a test run burns that date's single send.

**About to drive a page in a real browser against the live API?** A
`page.route()` write-block **does not work here** — service workers bypass it and
every page registers one. That is not theoretical: on 2026-08-18 a "read-only"
probe took ☕ Latte off the live customer menu. Use
`browser.newContext({ serviceWorkers: 'block' })` **and** a positive control that
throws when interception never fired. Read the box at the top of the `.kiro` file
first.

**Adding a suite that writes data, or a new marker?** Update
`.kiro/skills/test-suites/SKILL.md` and `scripts/test-markers.cjs` together.
