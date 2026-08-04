---
name: pricing-rules
description: Discount and pricing rules for RLC Café POS — the cheapest-candidate-wins algorithm, CELEBRATION / STAFF / PASTOR / NEWCOMER classes, net vs gross vs offset storage, and the reprice-on-approve path. Use when touching prices, discounts, totals, reports that aggregate money, or the walk-up cart.
---

# Pricing & Discounts

Authoritative content: read `.kiro/skills/pricing-rules/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before continuing.

Code source of truth is `backend/src/lib/pricing.ts`; the executable spec is
`backend/tests/pricing.test.ts`. **Changing a rule?** Update the skill file too.
