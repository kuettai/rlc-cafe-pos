# RLC Café POS — Project

PWA for a church café at Oasis of Care (RLC), Petaling Jaya, Malaysia. Replaced
Loyverse POS. Customer self-ordering, real-time order management, inventory.

## Stack
- **Frontend:** vanilla HTML/CSS/JS PWA, no framework, GitHub Pages
- **Backend:** single AWS Lambda (Node/TypeScript) behind API Gateway proxy
  integration, with an internal router in `backend/src/index.ts`
- **Database:** DynamoDB, 7 tables (orders, menu, ingredients, users, settings,
  customers, vouchers)
- **IaC:** AWS CDK (TypeScript), `infra/`
- **Region:** ap-southeast-5, account 956288449190 (hardcoded in `infra/bin/infra.ts`)
- **Repo:** https://github.com/kuettai/rlc-cafe-pos

## Surfaces
| Page | Purpose |
|---|---|
| `index.html` | Customer ordering |
| `track.html` | Order tracking (7s polling) + receipt upload |
| `pos.html` | Cashier POS |
| `admin.html` | Admin dashboard |
| `reports.html` | Reports |
| `display.html` | TV display board + promo slideshow |

Live at https://153.oasisofcare.org/ (CNAME), API at
`https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod/`.

## Layout
```
backend/src/     index.ts (router), expiry.ts (EventBridge cron — Sundays
                 01:00-09:00 UTC every 30min, + a Wednesday stock run; expiry,
                 auto-archive, low-stock alert, end-of-day revenue summary)
  lib/           db, auth (JWT/PIN), audit, phone, push, email, pricing,
                 date (Malaysia UTC+8 — the only place that conversion lives),
                 daily-summary (end-of-day revenue email body + send),
                 ssm-config (the only reader of /rlc-cafe/ runtime config —
                 one paginated, 5-min-cached fetch shared by email + VAPID)
  routes/        auth, cafe, menu, orders, pos, admin, checklist, receipt,
                 planogram, customers, vouchers, preorder, staffcode, push,
                 display, verses
frontend/js/     app, track, pos*, admin* (incl. admin-stafflink), display,
                 variants, pricing, changelog
infra/lib/       infra-stack.ts — DynamoDB, Lambda, API GW, S3, Bedrock perms
scripts/         one-off data migrations + release tooling
docs/            requirements, architecture, deployment, update-YYYYMMDD.md
```

## Operating context
- Sundays only: 10:15–11:30 (S1) and 12:45–13:30 (S2)
- 2–3 volunteers per shift (1 cashier, 1–2 baristas)
- Payment: Maybank QR (DuitNow), verified by cashier; receipts parsed by Bedrock
- Menu: ~10 drinks with variant groups (Temperature / Milk / Flavor) + food
- Pricing rules (celebration, staff, pastor, newcomer) live in ONE place:
  `backend/src/lib/pricing.ts`, mirrored for display only in
  `frontend/js/pricing.js`. Never reimplement them inline — see
  `backend/tests/pricing.test.ts` for the specification.

## Runtime configuration
Anything the Lambdas need beyond table names lives in **SSM Parameter Store**
under `/rlc-cafe/` (region `ap-southeast-5`), read through
`backend/src/lib/ssm-config.ts` — one paginated fetch of the whole prefix, cached
5 minutes per warm sandbox:

| Parameter | Type | Consumer |
|---|---|---|
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | SecureString | `lib/email.ts` |
| `NOTIFICATION_EMAIL` | String | `lib/email.ts` |
| `VAPID_PRIVATE_KEY` | SecureString | `lib/push.ts` |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | String | `lib/push.ts` |

**Not** Lambda environment variables, on purpose: the VAPID keys used to be env
vars that the CDK stack defaulted to `''`, so any `cdk deploy` from a shell that
had not exported them wiped web push — silently, for weeks. `JWT_SECRET` is the
one remaining env-var secret (deploy environment, `requireSecret()` fails synth
rather than defaulting); `ORIGIN_VERIFY_SECRET` is required only when
`ENFORCE_ORIGIN_HEADER=true`. Full table and rotation steps:
`docs/deployment.md` → *Runtime configuration*.

## Local development
```bash
npx http-server frontend -p 3001   # frontend against the LIVE API
cd backend && npm test             # jest
cd backend && npx tsc              # typecheck
```

## Test credentials
**Not stored in this repo.** Integration tests, Playwright journeys and the
maintenance scripts read them from the environment:

| Variable | Purpose |
|---|---|
| `TEST_ADMIN_USER` / `TEST_ADMIN_PIN` | ADMIN login |
| `TEST_CASHIER_USER` / `TEST_CASHIER_PIN` | CASHIER login |

Suites that need them skip cleanly when the variables are unset. Ask an admin
for values, or create a throwaway volunteer in Admin → Volunteers. Never commit
them.

## Reference material
Loaded on demand as skills, not always in context:
- `.kiro/skills/db-schemas/SKILL.md` — DynamoDB table schemas
- `.kiro/skills/api-reference/SKILL.md` — API endpoint reference

Feature history by sprint: `docs/feature-history.md`.
