---
name: test-suites
description: How to run the RLC Café POS test suites safely — which are offline and which write to the live production café, the ZZTEST_ prefix every test-created record must carry, the reserved test phone range, and the cleanup procedure afterwards. Use before running any test, adding a suite that writes data, or cleaning up after a live run.
---

# Test Suites

Authoritative content: read `.kiro/skills/test-suites/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before running any test.

**Short version:** `npx jest --testPathIgnorePatterns integration` is safe.
`integration.test.ts` and the Playwright journeys write to the **live production
café** — ask first, then clean up with `scripts/cleanup-test-data.mjs`. Every
test-created record must be stamped from `scripts/test-markers.cjs`; never
hardcode a marker string.

**Adding a suite that writes data, or a new marker?** Update
`.kiro/skills/test-suites/SKILL.md` and `scripts/test-markers.cjs` together.
