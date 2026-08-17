---
name: order-lifecycle
description: Order status state machine for RLC Café POS — valid transitions, guard conditions, the approve-time reprice (including the staff-link price revert), the ministry pre-order PENDING → PREPARING "release to barista" (single and bulk), the expiresAt/TTL rules and who may expire a pre-order, and food counter (foodReserved / foodQuantityToday) accounting on each transition. Use when changing order status, adding a transition, touching expiry or pre-orders, or debugging vanished orders or drifted food counts.
---

# Order Lifecycle

Authoritative content: read `.kiro/skills/order-lifecycle/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before continuing.

**Adding or changing a transition?** Update the transition table in
`.kiro/skills/order-lifecycle/SKILL.md` in the same change.
