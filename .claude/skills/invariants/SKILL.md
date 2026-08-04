---
name: invariants
description: Reviewable invariants for RLC Café POS — the do-not-duplicate list, storage conventions, API response shape, path-parameter handling, auth and release rules, each written as a checkable assertion with the production bug it prevents. Use when reviewing a diff, before deploying, or when adding code that touches money, order status, versions, or routing.
---

# Invariants

Authoritative content: read `.kiro/skills/invariants/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before continuing.

**Found a new class of production bug?** Add the assertion and the bug it
prevents to `.kiro/skills/invariants/SKILL.md` — this list is the accumulated
scar tissue and is only useful if it keeps growing.
