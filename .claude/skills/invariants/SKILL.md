---
name: invariants
description: Reviewable invariants for RLC Café POS — the do-not-duplicate list (including Malaysia-time date conversion and dead code left behind by an early return), storage conventions, who may authorise a discount (cashier-selected vs customer-requested vs system-only), the pre-order ISO expiresAt exception, create/edit parity (a restriction enforced on create must be re-enforced on edit), bulk mutating routes and collection-route dispatch, API response shape, path-parameter handling, no un-awaited work after a handler returns (Lambda freezes the sandbox) and date-keyed markers for at-most-once cron side effects, auth and release rules, and test teeth (a guard is untested unless a fixture reaches it; a test that depends on the machine timezone is not a test). Each is a checkable assertion with the production bug it prevents. Use when reviewing a diff, writing or judging tests, before deploying, or when adding code that touches money, discounts, order status, expiry, pre-orders, emails, background or scheduled work, timezones, versions, or routing.
---

# Invariants

Authoritative content: read `.kiro/skills/invariants/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before continuing.

**Found a new class of production bug?** Add the assertion and the bug it
prevents to `.kiro/skills/invariants/SKILL.md` — this list is the accumulated
scar tissue and is only useful if it keeps growing.
