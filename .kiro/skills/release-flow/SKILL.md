---
name: release-flow
description: Release procedure for RLC Café POS — the six version markers, the sw.js SHELL precache array, changelog entry, the two asymmetric deploy paths (CDK backend vs GitHub Pages frontend), and the session-notes template. Use when bumping a version, shipping a change, adding a frontend asset, or a deploy failed the version check.
---

# Release Flow

Full runbook: `docs/deployment.md`. This skill is the part that gets forgotten.

## The version lives in six places

| File | Marker |
|---|---|
| `frontend/sw.js` | `CACHE_NAME = 'rlc-cafe-vX.Y.Z'` |
| `frontend/index.html` | `<span class="app-version">vX.Y.Z</span>` |
| `frontend/pos.html` | same |
| `frontend/admin.html` | same |
| `frontend/reports.html` | same |
| `frontend/changelog.json` | top entry `.version` (format `vX.Y.Z`) |

**Never hand-edit.**

```bash
npm run version:bump -- minor --change "User-visible description"
npm run version:check
```

`bump-version.mjs` writes all six or none, and requires a changelog entry.
`check-version-sync.mjs` verifies the six agree, that every file listed in the
`sw.js` `SHELL` array exists, and that every shipped `js`/`css` asset and
versioned page is precached.

Wired in as `predeploy:frontend` and as a required step in
`.github/workflows/deploy-pages.yml` — a mismatch fails the deploy rather than
shipping a footer that lies about what is cached. v1.62.0 shipped with four
stale markers before this existed.

Versioning: `Major.Minor.Patch`, minor for features, patch for fixes. Frontend
and backend share one number; the backend has no independent version — document
breaking API changes in the session update file.

## Adding a frontend asset

New `frontend/js/*.js` or `frontend/css/*.css` → add it to the `SHELL` array in
`frontend/sw.js`. Also add the `<script>` tag to whichever pages use it.
`version:check` fails otherwise.

## Pre-deploy checklist

- ☐ `npm run version:check` clean
- ☐ user-visible change present in `frontend/changelog.json` (renders in the
  "What's new?" modal on admin/reports)
- ☐ backend touched → `cd backend && npx tsc && npm test`
- ☐ `docs/update-YYYYMMDD.md` written
- ☐ no credentials or PINs in the diff

`backend/tests/integration.test.ts` hits the **live API** and needs the café
OPEN. It creates real production records — run `scripts/cleanup-test-data.mjs`
afterwards.

## Deploy — two independent paths

```bash
npm run deploy:backend    # cdk deploy → ap-southeast-5, account 956288449190
npm run deploy:frontend   # git push; Actions publishes to GitHub Pages
```

The Pages workflow **only triggers on pushes to `master` that touch
`frontend/**`**. A commit touching only `backend/`, `docs/` or `scripts/` will
not publish the frontend — and a frontend fix bundled into a backend-only commit
silently never ships.

Backend and frontend deploy separately, so order matters: ship a backend change
that the frontend depends on **first**, and keep new API responses
backwards-compatible while old cached frontends are still live (service worker
clients may hold the previous shell until they update).

## Session notes template

`docs/update-YYYYMMDD.md`:

```markdown
# Update YYYY-MM-DD

## Context
What prompted this session.

## Analysis
What was found, with file:line references.

## Changes
- path — what changed and why

## Verification
Commands run, results.

## Open items
Known gaps, follow-ups, anything left broken on purpose.
```

## If the deploy failed on version check

Read the reported problems — the script names each mismatch and each unprecached
asset. Fix by re-running `npm run version:bump`, not by editing markers. If only
the `SHELL` array is at fault, add the missing file to it and re-run
`version:check`.
