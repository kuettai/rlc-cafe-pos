#!/usr/bin/env node
/**
 * bump-version.mjs — set the app version in all six places at once.
 *
 * Doing this by hand means six edits and one of them gets forgotten (see
 * docs/update-20260802.md). This writes them together, or not at all.
 *
 * Usage:
 *   node scripts/bump-version.mjs 1.63.0 --change "Fixed X" --change "Added Y"
 *   node scripts/bump-version.mjs patch  --change "Fixed X"
 *   node scripts/bump-version.mjs minor  --change "Added Y" --dry-run
 *
 * The first argument is either an explicit X.Y.Z or one of `major`/`minor`/
 * `patch` to increment from the current version.
 *
 * A changelog entry is required. If `frontend/changelog.json` already has a top
 * entry for the target version, it is left alone and `--change` is optional;
 * otherwise at least one `--change` must be supplied. Changelog text is written
 * by a human on purpose — it is what users read in the What's new? modal.
 *
 * Nothing is written unless every file parses and every replacement matches.
 * Run `node scripts/check-version-sync.mjs` afterwards to confirm.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FRONTEND = join(ROOT, 'frontend');
const HTML_PAGES = ['index.html', 'pos.html', 'admin.html', 'reports.html'];

// ─── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const target = argv.find(a => !a.startsWith('--'));
const changes = [];
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--change' || argv[i] === '-c') && argv[i + 1]) changes.push(argv[++i]);
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!target) {
  die('Usage: node scripts/bump-version.mjs <X.Y.Z|major|minor|patch> --change "..."');
}

// ─── current version (sw.js is the reference) ────────────────────────────────
const swPath = join(FRONTEND, 'sw.js');
if (!existsSync(swPath)) die('frontend/sw.js not found');
let sw = readFileSync(swPath, 'utf8');
const swMatch = sw.match(/(const\s+CACHE_NAME\s*=\s*['"]rlc-cafe-v)([0-9]+\.[0-9]+\.[0-9]+)(['"])/);
if (!swMatch) die("frontend/sw.js: could not find CACHE_NAME = 'rlc-cafe-vX.Y.Z'");
const current = swMatch[2];

// ─── resolve target version ──────────────────────────────────────────────────
let next;
if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(target)) {
  next = target;
} else if (['major', 'minor', 'patch'].includes(target)) {
  const [maj, min, pat] = current.split('.').map(Number);
  next = target === 'major' ? `${maj + 1}.0.0`
       : target === 'minor' ? `${maj}.${min + 1}.0`
       : `${maj}.${min}.${pat + 1}`;
} else {
  die(`Invalid version "${target}" — expected X.Y.Z, major, minor, or patch`);
}

if (next === current) die(`Version is already ${current}; nothing to do`);

// ─── changelog ───────────────────────────────────────────────────────────────
const clPath = join(FRONTEND, 'changelog.json');
if (!existsSync(clPath)) die('frontend/changelog.json not found');
let changelog;
try {
  changelog = JSON.parse(readFileSync(clPath, 'utf8'));
} catch (e) {
  die(`frontend/changelog.json: invalid JSON — ${e.message}`);
}
if (!Array.isArray(changelog)) die('frontend/changelog.json: expected an array');

const today = new Date().toISOString().slice(0, 10);
const hasEntry = changelog[0] && changelog[0].version === `v${next}`;

if (!hasEntry && changes.length === 0) {
  die(`No changelog entry for v${next}. Supply at least one --change "description", `
    + 'or add the entry to frontend/changelog.json first.');
}

if (hasEntry && changes.length) {
  changelog[0].changes.push(...changes);
  changelog[0].date = today;
} else if (!hasEntry) {
  changelog.unshift({ version: `v${next}`, date: today, changes });
}

// ─── stage all edits in memory, verifying each match ─────────────────────────
const writes = [];

sw = sw.replace(swMatch[0], `${swMatch[1]}${next}${swMatch[3]}`);
writes.push([swPath, sw, `sw.js CACHE_NAME → rlc-cafe-v${next}`]);

for (const page of HTML_PAGES) {
  const p = join(FRONTEND, page);
  if (!existsSync(p)) die(`frontend/${page} not found`);
  const html = readFileSync(p, 'utf8');
  const re = /(class=["']app-version["'][^>]*>\s*v)([0-9]+\.[0-9]+\.[0-9]+)(\s*<)/;
  if (!re.test(html)) die(`frontend/${page}: no <span class="app-version">vX.Y.Z</span> found`);
  writes.push([p, html.replace(re, `$1${next}$3`), `${page} .app-version → v${next}`]);
}

// Match the existing single-line-per-entry formatting of changelog.json so the
// diff stays readable.
const clText = '[' + changelog.map(e => JSON.stringify(e)).join(',\n') + ']\n';
writes.push([clPath, clText, `changelog.json → v${next} (${changelog[0].changes.length} change(s))`]);

// ─── report + write ──────────────────────────────────────────────────────────
console.log(`${current} → ${next}\n`);
for (const [, , label] of writes) console.log(`  ${label}`);

if (DRY) {
  console.log('\nDry run — nothing written.');
  process.exit(0);
}

for (const [p, content] of writes) writeFileSync(p, content, 'utf8');

console.log(`\n✓ Bumped to v${next}. Verify with: node scripts/check-version-sync.mjs`);
console.log('  Remember: new JS/CSS files must also be added to the SHELL array in sw.js.');
