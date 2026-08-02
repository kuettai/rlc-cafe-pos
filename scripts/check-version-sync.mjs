#!/usr/bin/env node
/**
 * check-version-sync.mjs — verify every version marker agrees.
 *
 * The app version lives in six places. If they drift, the footer advertises a
 * version the service worker isn't serving, and the changelog modal shows notes
 * for a release the user doesn't have.
 *
 *   frontend/sw.js                  CACHE_NAME = 'rlc-cafe-vX.Y.Z'
 *   frontend/index.html             <span class="app-version">vX.Y.Z</span>
 *   frontend/pos.html               same
 *   frontend/admin.html             same
 *   frontend/reports.html           same
 *   frontend/changelog.json         top entry .version
 *
 * Also checks that every file in the sw.js SHELL array exists, and that every
 * frontend js/css file is listed in SHELL — a new file that isn't precached
 * breaks offline loads.
 *
 * Usage:
 *   node scripts/check-version-sync.mjs
 *
 * Exit 0 if consistent, 1 otherwise. Run by CI before the Pages deploy and by
 * the `predeploy:frontend` npm hook.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FRONTEND = join(ROOT, 'frontend');

const HTML_PAGES = ['index.html', 'pos.html', 'admin.html', 'reports.html'];

const problems = [];
const markers = [];

function read(rel) {
  const abs = join(FRONTEND, rel);
  if (!existsSync(abs)) {
    problems.push(`Missing file: frontend/${rel}`);
    return null;
  }
  return readFileSync(abs, 'utf8');
}

// ─── sw.js CACHE_NAME ────────────────────────────────────────────────────────
const sw = read('sw.js');
let swVersion = null;
if (sw) {
  const m = sw.match(/const\s+CACHE_NAME\s*=\s*['"]rlc-cafe-v([0-9]+\.[0-9]+\.[0-9]+)['"]/);
  if (!m) problems.push("frontend/sw.js: could not find CACHE_NAME = 'rlc-cafe-vX.Y.Z'");
  else { swVersion = m[1]; markers.push({ where: 'sw.js CACHE_NAME', version: `v${m[1]}` }); }
}

// ─── .app-version spans ──────────────────────────────────────────────────────
for (const page of HTML_PAGES) {
  const html = read(page);
  if (!html) continue;
  const all = [...html.matchAll(/class=["']app-version["'][^>]*>\s*v([0-9]+\.[0-9]+\.[0-9]+)\s*</g)];
  if (all.length === 0) {
    problems.push(`frontend/${page}: no <span class="app-version">vX.Y.Z</span> found`);
    continue;
  }
  if (all.length > 1) problems.push(`frontend/${page}: ${all.length} .app-version spans found, expected 1`);
  markers.push({ where: `${page} .app-version`, version: `v${all[0][1]}` });
}

// ─── changelog.json top entry ────────────────────────────────────────────────
const changelogRaw = read('changelog.json');
let changelog = null;
if (changelogRaw) {
  try {
    changelog = JSON.parse(changelogRaw);
    if (!Array.isArray(changelog) || changelog.length === 0) {
      problems.push('frontend/changelog.json: expected a non-empty array');
    } else {
      const top = changelog[0];
      const m = String(top.version || '').match(/^v([0-9]+\.[0-9]+\.[0-9]+)$/);
      if (!m) problems.push(`frontend/changelog.json: top entry version "${top.version}" is not vX.Y.Z`);
      else markers.push({ where: 'changelog.json[0].version', version: `v${m[1]}` });
      if (!Array.isArray(top.changes) || top.changes.length === 0) {
        problems.push('frontend/changelog.json: top entry has no changes listed');
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(top.date || ''))) {
        problems.push(`frontend/changelog.json: top entry date "${top.date}" is not YYYY-MM-DD`);
      }
    }
  } catch (e) {
    problems.push(`frontend/changelog.json: invalid JSON — ${e.message}`);
  }
}

// ─── all markers must agree ──────────────────────────────────────────────────
const distinct = [...new Set(markers.map(m => m.version))];
if (distinct.length > 1) {
  problems.push(`Version mismatch across ${markers.length} markers: ${distinct.join(', ')}`);
}

// ─── sw.js SHELL coverage ────────────────────────────────────────────────────
if (sw) {
  const shellMatch = sw.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\]/);
  if (!shellMatch) {
    problems.push('frontend/sw.js: could not parse the SHELL array');
  } else {
    const listed = [...shellMatch[1].matchAll(/['"]\.\/([^'"]+)['"]/g)].map(m => m[1]);

    for (const rel of listed) {
      if (!existsSync(join(FRONTEND, rel))) {
        problems.push(`sw.js SHELL lists a file that does not exist: ${rel}`);
      }
    }

    // Every shipped js/css asset should be precached.
    const assets = [];
    for (const dir of ['js', 'css']) {
      const abs = join(FRONTEND, dir);
      if (!existsSync(abs)) continue;
      for (const f of readdirSync(abs)) {
        if (/\.(js|css)$/.test(f)) assets.push(`${dir}/${f}`);
      }
    }
    const listedSet = new Set(listed);
    for (const a of assets) {
      if (!listedSet.has(a)) problems.push(`sw.js SHELL is missing shipped asset: ${a}`);
    }

    // Every versioned page should be precached too. Deliberately limited to the
    // pages carrying an .app-version marker so legacy/dev pages (prep.html,
    // seed-ingredients.html) don't produce noise.
    for (const page of HTML_PAGES) {
      if (!listedSet.has(page) && !(page === 'index.html' && listed.includes(''))) {
        problems.push(`sw.js SHELL is missing page: ${page}`);
      }
    }
  }
}

// ─── report ──────────────────────────────────────────────────────────────────
const pad = Math.max(...markers.map(m => m.where.length), 10);
for (const m of markers) {
  console.log(`  ${m.where.padEnd(pad)}  ${m.version}`);
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nFix with: node scripts/bump-version.mjs <version>');
  process.exit(1);
}

console.log(`\n✓ All ${markers.length} version markers agree (${distinct[0]}), SHELL complete.`);
