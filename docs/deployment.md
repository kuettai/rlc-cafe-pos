# Deployment Guide — RLC Café POS

## Pre-deploy Checklist

1. **Bump the version in all six places** (they must match, or the footer will
   claim a version the cache isn't serving):
   - `frontend/sw.js` → `CACHE_NAME` (e.g. `rlc-cafe-v1.62.0`)
   - `frontend/index.html` → `.app-version` span
   - `frontend/pos.html` → `.app-version` span
   - `frontend/admin.html` → `.app-version` span
   - `frontend/reports.html` → `.app-version` span
   - `frontend/changelog.json` → new entry at the top

2. **`frontend/changelog.json`** — add the entry at the top:
   ```json
   {"version": "v1.XX.0", "date": "YYYY-MM-DD", "changes": ["Change 1", "Change 2"]}
   ```
   Only user-visible changes belong here. `admin.html` and `reports.html` load
   `js/changelog.js`, which turns the `.app-version` footer into a "What's new?"
   button that renders this file. `pos.html` and `index.html` show the version
   but deliberately do not load the changelog modal.

3. **Add any new JS/CSS files to the `SHELL` array in `sw.js`**, or they won't
   be precached and offline loads will miss them.

4. **Compile the backend**:
   ```bash
   cd backend && npx tsc
   ```
   Fix all type errors first.

5. **Run the tests**:
   ```bash
   cd backend && npm test
   ```
   Note: `tests/integration.test.ts` runs against the **live API** and needs the
   café to be OPEN for the order-flow cases to pass.

## Deploy Backend

```bash
# From project root
npm run deploy:backend
# equivalent to:
cd infra && npx cdk deploy --require-approval never
```

Deploys the Lambda + API Gateway stack to `ap-southeast-5`
(account 956288449190, hardcoded in `infra/bin/infra.ts`). Requires AWS
credentials. CDK bundles TypeScript with local esbuild — no Docker needed.

## Runtime configuration (SSM Parameter Store)

Everything the Lambdas need at runtime beyond table names lives in **SSM
Parameter Store** under the prefix `/rlc-cafe/`, region `ap-southeast-5`. It is
read by `backend/src/lib/ssm-config.ts`, which fetches the whole prefix once per
5 minutes per warm sandbox (paginated) and caches it. Both Lambda roles hold
`ssm:GetParametersByPath` + `ssm:GetParameter` on `arn:aws:ssm:*:*:parameter/rlc-cafe/*`.

| Parameter | Type | Used by | Purpose |
|---|---|---|---|
| `/rlc-cafe/GMAIL_USER` | SecureString | `lib/email.ts` | Gmail SMTP sender account |
| `/rlc-cafe/GMAIL_APP_PASSWORD` | SecureString | `lib/email.ts` | Gmail app password |
| `/rlc-cafe/NOTIFICATION_EMAIL` | String | `lib/email.ts` | recipient of low-stock + end-of-day summary |
| `/rlc-cafe/VAPID_PUBLIC_KEY` | String | `lib/push.ts` | Web Push public key; served by `GET /api/push/vapid-public-key`, so **not** secret |
| `/rlc-cafe/VAPID_PRIVATE_KEY` | SecureString | `lib/push.ts` | Web Push private key — signs every notification |
| `/rlc-cafe/VAPID_SUBJECT` | String | `lib/push.ts` | operator contact sent to push services; a `mailto:` or `https:` URL on a domain we own. Defaults to `https://153.oasisofcare.org` if absent |

`/rlc-cafe/jwt-secret` also exists but is **not read by any code** — `JWT_SECRET`
still comes from the deploy environment (see below).

### Why these are not Lambda environment variables

The VAPID keys used to be env vars that `infra-stack.ts` defaulted to `''`. Any
`cdk deploy` from a shell that had not exported them therefore **overwrote the
live keys with empty strings**, and `lib/push.ts` skipped sending "silently" —
no error, no log. Web push was dead in production for weeks; customers tapped
"Notify me" on `track.html`, granted browser notification permission, and
received nothing. Nothing in the deploy path can wipe an SSM parameter, so
runtime config belongs there. Do not reintroduce a `VAPID_*` env var.

### Rotating the VAPID keys

Safe to rotate: push subscriptions carry a 24h TTL and are re-created on the
next visit. Never print the private key or write it into the repo.

```bash
# Generates a keypair and puts both parameters. Prints the PUBLIC key only.
node -e "
const w=require('./backend/node_modules/web-push');
const {SSMClient,PutParameterCommand}=require('./backend/node_modules/@aws-sdk/client-ssm');
const ssm=new SSMClient({region:'ap-southeast-5'});const k=w.generateVAPIDKeys();
(async()=>{
  await ssm.send(new PutParameterCommand({Name:'/rlc-cafe/VAPID_PUBLIC_KEY',Value:k.publicKey,Type:'String',Overwrite:true}));
  await ssm.send(new PutParameterCommand({Name:'/rlc-cafe/VAPID_PRIVATE_KEY',Value:k.privateKey,Type:'SecureString',Overwrite:true}));
  console.log('public:',k.publicKey,'private length:',k.privateKey.length);
})();"
```

No redeploy is needed — the next cold start (or the 5-minute cache expiry) picks
it up. Verify with:

```bash
curl -s https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod/api/push/vapid-public-key
```

A `500 {"error":"VAPID not configured"}` means the parameters are missing or
web-push rejected them; `/aws/lambda/rlc-cafe-api` will carry a `[PUSH]` line
saying which.

### Deploy-environment secrets (not in SSM)

| Variable | Required | Behaviour if unset |
|---|---|---|
| `JWT_SECRET` | always | **synth fails** (`requireSecret`) — rotating it invalidates every outstanding login token |
| `ORIGIN_VERIFY_SECRET` | only when `ENFORCE_ORIGIN_HEADER=true` | **synth fails**; when enforcement is off the variable is not emitted at all |
| `ENFORCE_ORIGIN_HEADER` | no | `'false'` — CloudFront origin verification stays off |

Neither secret may ever be defaulted to a literal in `infra-stack.ts`: this repo
is public, and both `CHANGE_ME_BEFORE_DEPLOY` (JWT) and
`CHANGE_ME_WHEN_CLOUDFRONT_ENABLED` (origin verify) were once committed values
that would have been trivially forgeable.

## Deploy Frontend

Served by **GitHub Pages** at https://153.oasisofcare.org/ (CNAME), not
CloudFront — the CloudFront stack was removed in v49. See
`docs/cloudfront-migration.md` for that history.

```bash
npm run deploy:frontend
# equivalent to:
git add frontend && git commit -m "vX.XX.0 — description" && git push
```

`.github/workflows/deploy-pages.yml` triggers on push to `master` **only when
files under `frontend/**` change** (or via manual `workflow_dispatch`). It
uploads the `frontend/` directory as-is — there is no build step. Changes to
`backend/`, `infra/`, `docs/` or `scripts/` will not trigger a frontend deploy.

**Test locally before pushing** — the local page talks to the live API:

```bash
npx http-server frontend -p 3001    # or: npm run dev  (serve, port 3000)
```

## Post-deploy

- **Run any data/seed scripts**:
  ```bash
  node scripts/<script-name>.mjs
  ```
- **Verify** the version in the page footer matches what you shipped.
- **Service worker**: the new `CACHE_NAME` busts the old cache on next visit.
  Admin and POS pages also have a check-for-update prompt. If a device is stuck,
  hard-reload or clear site data.

## Versioning Convention

- `Major.Minor.Patch`, e.g. `v1.62.0`
- **Minor** bump for features, **Patch** for bug fixes
- Frontend and backend share one version number; the backend has no independent
  semantic version — breaking API changes go in the session update doc
- `changelog.json` is the source of truth for release history

## Session Notes

Each work session gets `docs/update-YYYYMMDD.md` covering analysis, findings,
fixes, and open items.
