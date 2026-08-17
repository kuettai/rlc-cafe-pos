---
name: test-suites
description: How to run the RLC Café POS test suites safely — which are offline and which write to the live production café, why it must be `npm test` (`TZ=UTC jest`) and never a bare `npx jest`, the ZZTEST_ prefix every test-created record must carry, the reserved test phone range, the Sunday-afternoon end-of-day-email hazard, and the cleanup procedure afterwards. Use before running any test, adding a suite that writes data, or cleaning up after a live run.
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

**Adding a suite that writes data, or a new marker?** Update
`.kiro/skills/test-suites/SKILL.md` and `scripts/test-markers.cjs` together.
