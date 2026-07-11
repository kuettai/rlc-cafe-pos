# Deployment Guide — RLC Café POS

## Pre-deploy Checklist

1. **Update version** in all places:
   - `frontend/sw.js` → `CACHE_NAME` (e.g. `rlc-cafe-v1.53.0`)
   - `frontend/index.html` → `.app-version` span
   - `frontend/pos.html` → `.app-version` span
   - `frontend/admin.html` → `.app-version` span

2. **Update `frontend/changelog.json`** — add a new entry at the top:
   ```json
   {"version": "v1.XX.0", "date": "YYYY-MM-DD", "changes": ["Description of change 1", "Description of change 2"]}
   ```

3. **Add new files to `sw.js` SHELL array** (if any new JS/CSS files were created).

4. **Compile backend TypeScript**:
   ```bash
   cd backend && npx tsc
   ```
   Fix any type errors before proceeding.

## Deploy Backend

```bash
# From project root
npm run deploy:backend
# OR manually:
cd infra && npx cdk deploy --require-approval never
```

This deploys the Lambda + API Gateway stack to `ap-southeast-5`.

## Deploy Frontend

Frontend is served via CloudFront + S3 (or Amplify). Deploy via git:

```bash
npm run deploy:frontend
# OR manually:
git add frontend && git commit -m "vX.XX.0 — description" && git push
```

CloudFront invalidation happens automatically via the CI pipeline.

## Post-deploy

- **Run seed scripts** (if any):
  ```bash
  cd backend && node ../scripts/<script-name>.mjs
  ```
- **Verify** by opening the live URL and checking the version in the footer.
- **Force SW update**: If users are stuck on old cache, the new `CACHE_NAME` triggers automatic cache busting on next visit.

## Versioning Convention

- **Major.Minor.Patch**: e.g. `v1.53.0`
- **Minor** bump for new features
- **Patch** bump for bug fixes
- Frontend and backend share the same version number
- `changelog.json` is the single source of truth for release history
