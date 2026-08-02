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
