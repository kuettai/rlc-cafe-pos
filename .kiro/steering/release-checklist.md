# Release Checklist

Full runbook: `docs/deployment.md`. This is the part that must not be forgotten.

## The version lives in SIX places and they must match

| File | Marker |
|---|---|
| `frontend/sw.js` | `CACHE_NAME = 'rlc-cafe-vX.Y.Z'` |
| `frontend/index.html` | `<span class="app-version">vX.Y.Z</span>` |
| `frontend/pos.html` | same |
| `frontend/admin.html` | same |
| `frontend/reports.html` | same |
| `frontend/changelog.json` | top entry `.version` |

**Do not edit them by hand.** Use:

```bash
npm run version:bump -- minor --change "User-visible description"
npm run version:check          # verifies all six + SHELL coverage
```

`npm run version:check` also runs automatically as `predeploy:frontend` and as a
required step in `.github/workflows/deploy-pages.yml` — a mismatch fails the
deploy rather than shipping a footer that lies about what is cached.

## Also required

- **New JS/CSS file?** Add it to the `SHELL` array in `frontend/sw.js` or it
  won't be precached. `version:check` enforces this.
- **User-visible change?** It belongs in `frontend/changelog.json` — that is what
  the "What's new?" modal in admin/reports renders.
- **Backend touched?** `cd backend && npx tsc && npm test` before deploying.
  Note `tests/integration.test.ts` hits the live API and needs the café OPEN.
- **Session notes:** create `docs/update-YYYYMMDD.md` with analysis, findings,
  fixes, and open items.

## Deploy

```bash
npm run deploy:backend    # cdk deploy → ap-southeast-5
npm run deploy:frontend   # git push; Actions publishes to GitHub Pages
```

The frontend workflow only triggers on pushes to `master` that touch
`frontend/**`. A commit touching only `backend/`, `docs/` or `scripts/` will not
publish the frontend.

## Versioning

`Major.Minor.Patch`. Minor for features, patch for fixes. Frontend and backend
share one number; the backend has no independent version — document breaking API
changes in the session update file.
