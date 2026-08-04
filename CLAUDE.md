# RLC Café POS — Agent Entry Point

PWA for a church café (Oasis of Care, Petaling Jaya). Vanilla JS frontend on
GitHub Pages, one AWS Lambda backend, DynamoDB, CDK. Live Sundays only.

## Read these first

Project context lives in `.kiro/steering/` and is **not** auto-loaded by Claude
Code. Read them at the start of any non-trivial task:

| File | Contents |
|---|---|
| `.kiro/steering/project.md` | stack, surfaces, layout, local dev, test credentials |
| `.kiro/steering/conventions.md` | coding rules, load-bearing decisions, single sources of truth |
| `.kiro/steering/release-checklist.md` | the six version markers, deploy paths |

Feature history by sprint: `docs/feature-history.md`. Session notes:
`docs/update-YYYYMMDD.md`.

## Agents

Delegate to the specialist rather than working across the whole repo. Start with
`pos-orchestrator` for anything spanning more than one layer.

| Agent | Scope |
|---|---|
| `pos-orchestrator` | plans multi-layer work, delegates, enforces the release checklist |
| `backend-api` | `backend/src/**` — router, routes, lib |
| `frontend-pwa` | `frontend/**` — pages, JS, service worker |
| `data-dynamo` | table schemas, queries, `scripts/*.mjs` migrations |
| `release-manager` | version bump, changelog, CI, deploy, session notes |
| `qa-verifier` | `backend/tests/**`, Playwright journeys, live-API integration runs |

## Skills

Load on demand (`.kiro/skills/` authoritative, `.claude/skills/` are pointers):

`api-reference`, `db-schemas`, `order-lifecycle`, `pricing-rules`, `invariants`,
`release-flow`, `test-suites`.

## Rules that bite

1. **Version lives in six files.** Never hand-edit. `npm run version:bump`,
   verify with `npm run version:check`.
2. **New `frontend/js` or `frontend/css` file?** Add it to the `SHELL` array in
   `frontend/sw.js` or it is never precached.
3. **Pricing/discounts:** only `backend/src/lib/pricing.ts`. Never inline.
4. **`expiresAt` only on PENDING orders.** Writing it on any other status lets
   DynamoDB TTL silently delete live or archived orders.
5. **`totalAmount` is NET.** `grossAmount` undiscounted, `discountOffset` the
   reduction. All aggregations assume this.
6. **Path params:** the per-route dispatcher parses `event.path` and assigns
   `event.pathParameters` itself. API Gateway proxy integration does not
   populate it.
7. **Live API.** `backend/tests/integration.test.ts` and the Playwright journeys
   hit production and need the café OPEN. They create real records, each stamped
   with the `ZZTEST_` prefix from `scripts/test-markers.cjs` — clean up with
   `scripts/cleanup-test-data.mjs`. See the `test-suites` skill first.
8. **Region `ap-southeast-5`**, account `956288449190`.

## Commands

```bash
npx http-server frontend -p 3001    # frontend against the LIVE API
cd backend && npx tsc && npm test   # typecheck + jest
npm run version:check               # six markers + SHELL coverage
npm run deploy:backend              # cdk deploy
npm run deploy:frontend             # git push; Actions publishes Pages
```
