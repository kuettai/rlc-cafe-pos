/**
 * Malaysia-time date helpers.
 *
 * The café runs on Malaysian wall-clock time, so every "what day is it"
 * decision — a staff code's validity window, which orders belong to today's
 * service, which date an end-of-day summary is for — must be made in MYT and
 * never in UTC. Getting this wrong is not theoretical: the end-of-day summary
 * email used to derive its date from `new Date().toISOString()`, and the
 * emails for the 2026-08-02 and 2026-08-09 services went out headed
 * "Saturday, 1 August 2026" and "Saturday, 8 August 2026" respectively.
 *
 * This is the SINGLE SOURCE OF TRUTH for the conversion. It moved here from
 * `routes/staffcode.ts` when the end-of-day summary cron needed it too —
 * `staffcode.ts` re-exports it so existing imports keep working.
 */

/** Milliseconds in the fixed UTC+8 offset. MYT has no DST, so this is exact. */
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Today's calendar date in Malaysia time as YYYY-MM-DD.
 *
 * The date gate is a wall-clock decision made in the café, not in UTC: a code
 * ending "today" must stay valid until midnight local. MYT is UTC+8 with no
 * DST, so shifting the epoch by a fixed 8h and reading the UTC parts is exact.
 * Takes `now` so a test can pin the boundary.
 */
export function malaysiaToday(now: Date = new Date()): string {
  const myt = new Date(now.getTime() + MYT_OFFSET_MS);
  const y = myt.getUTCFullYear();
  const m = String(myt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(myt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The same instant shifted into MYT, for reading `getUTCDay()` / `getUTCHours()`
 * as Malaysian day-of-week and hour. Do not use this for anything that will be
 * serialised — the underlying epoch is deliberately wrong by 8 hours.
 */
export function malaysiaClock(now: Date = new Date()): Date {
  return new Date(now.getTime() + MYT_OFFSET_MS);
}

/**
 * The instant a Malaysian calendar date began, as a UTC ISO string.
 * `'2026-08-16'` → `'2026-08-15T16:00:00.000Z'`.
 *
 * Use this — never the bare `YYYY-MM-DD` — whenever a Malaysian day is compared
 * against a stored `createdAt`, because those are UTC ISO strings. Comparing
 * `createdAt >= '2026-08-16'` drops every order placed before 08:00 MYT (their
 * `createdAt` still reads `2026-08-15T…`), which on an early service would quietly
 * understate the day's revenue. The comparison is lexicographic on ISO strings,
 * which is valid as long as both sides are UTC and zero-padded.
 */
export function malaysiaDayStartUtc(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}
