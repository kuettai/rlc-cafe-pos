---
name: pricing-rules
description: Discount and pricing rules for RLC Café POS — the cheapest-candidate-wins algorithm, CELEBRATION / STAFF / PASTOR / NEWCOMER / BLESSING / PREORDER classes, which menu categories each class may discount (PASTOR, NEWCOMER and BLESSING discount FOOD as well as DRINK; STAFF, PREORDER and CELEBRATION are DRINK-only — "FOOD is never discounted" is withdrawn), the one `classAppliesToCategory` / `CLASS_CATEGORIES` allowlist that owns that scope, the four cashier-selectable classes including the BLESSING full-waiver fallback for comping a whole order when no named class fits, the customer-requested STAFF price from the staff link and how it is reverted on approve, the system-only PREORDER class for free ministry pre-orders and its MINISTRY_PREORDER discountType, why WHO DECIDES rather than the size of the discount is what keeps PREORDER out of `parseCustomerClass` while BLESSING is admitted, net vs gross vs offset storage, and the reprice-on-approve path. Use when touching prices, discounts, totals, reports that aggregate money, the staff link, ministry pre-orders, comped or free orders, or the walk-up cart.
---

# Pricing & Discounts

Authoritative content: read `.kiro/skills/pricing-rules/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before continuing.

Code source of truth is `backend/src/lib/pricing.ts`; the executable spec is
`backend/tests/pricing.test.ts`. **Changing a rule?** Update the skill file too.
