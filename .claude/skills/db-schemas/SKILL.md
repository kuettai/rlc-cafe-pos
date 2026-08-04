---
name: db-schemas
description: DynamoDB table schemas for RLC Café POS — orders, menu, ingredients, users, settings, customers, vouchers. Partition/sort keys, GSIs, TTL attributes, and the record types stored in the settings table. Use when reading or writing DynamoDB records, adding attributes, or designing queries.
---

# DynamoDB Table Schemas

Authoritative content: read `.kiro/skills/db-schemas/SKILL.md`.

That file is shared with the Kiro IDE so there is one copy to maintain. Read it
now before continuing.

**Adding an attribute, table or GSI?** Update `.kiro/skills/db-schemas/SKILL.md`
in the same change.

Related: `order-lifecycle` (the `expiresAt` TTL rule and food counters),
`pricing-rules` (net/gross/offset money fields).
