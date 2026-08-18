---
name: invariants
description: Reviewable invariants for RLC Café POS — the do-not-duplicate list (including Malaysia-time date conversion and dead code left behind by an early return), storage conventions, who may authorise a discount (cashier-selected vs customer-requested vs system-only), the pre-order ISO expiresAt exception, create/edit parity (a restriction enforced on create must be re-enforced on edit), bulk mutating routes and collection-route dispatch, API response shape, path-parameter handling, no un-awaited work after a handler returns (Lambda freezes the sandbox) and date-keyed markers for at-most-once cron side effects, no silently-skipped feature when its config is missing (config in SSM, never a wipeable Lambda env default), auth and release rules, frontend HTML escaping (a customer-controlled string is escaped at every innerHTML render site, not just the newest one — and a textContent sink must not be escaped; `escapeHtml`/`escapeAttr` in `admin.js` are canonical for the whole admin bundle, `mfEsc` is gone), frontend state and motion rules (a failure state must not render identically to an empty success state, two distinct persisted flags must not share one visual language, a `[disabled]` control must look disabled, animate transform/opacity and never a layout property), Malaysia-time dates on the admin frontend via `mytToday()`, and test teeth (a guard is untested unless a fixture reaches it; a test that depends on the machine timezone is not a test). Each is a checkable assertion with the production bug it prevents. Use when reviewing a diff, writing or judging tests, before deploying, or when adding code that touches money, discounts, order status, expiry, pre-orders, collection times, item notes, emails, background or scheduled work, timezones, versions, routing, or the rendering of customer-supplied text into the DOM.
---

# Invariants

Authoritative content: read `.kiro/skills/invariants/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before continuing.

**Found a new class of production bug?** Add the assertion and the bug it
prevents to `.kiro/skills/invariants/SKILL.md` — this list is the accumulated
scar tissue and is only useful if it keeps growing.
