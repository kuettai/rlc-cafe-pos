---
name: invariants
description: Reviewable invariants for RLC Café POS — the do-not-duplicate list (including dead code left behind by an early return), storage conventions, who may authorise a discount (cashier-selected vs customer-requested vs system-only), the pre-order ISO expiresAt exception, create/edit parity (a restriction enforced on create must be re-enforced on edit), bulk mutating routes and collection-route dispatch, API response shape, path-parameter handling, auth and release rules, and test teeth (a guard is untested unless a fixture reaches it), each written as a checkable assertion with the production bug it prevents. Use when reviewing a diff, writing or judging tests, before deploying, or when adding code that touches money, discounts, order status, expiry, pre-orders, versions, or routing.
---

# Invariants

Authoritative content: read `.kiro/skills/invariants/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before continuing.

**Found a new class of production bug?** Add the assertion and the bug it
prevents to `.kiro/skills/invariants/SKILL.md` — this list is the accumulated
scar tissue and is only useful if it keeps growing.
