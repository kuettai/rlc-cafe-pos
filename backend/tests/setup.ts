/**
 * Jest setup — runs before each test file.
 *
 * `signToken`/`verifyToken` fail closed without a strong JWT_SECRET (see
 * src/lib/auth.ts), so supply a test-only value. This is NOT a real secret and
 * must never match a deployed one. Individual suites override it as needed.
 */
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'jest-test-secret-do-not-use-in-any-environment-0123456789';

/**
 * Lambda runs in UTC; the dev machines are in `Asia/Kuala_Lumpur`. That gap hid
 * a real production bug: `formatDate` in lib/email.ts formatted the end-of-day
 * date with no `timeZone` option, so it rendered in the runtime's zone. Locally
 * that is MYT and looks perfect; on Lambda it is UTC and lands 8 hours earlier,
 * which is why the summaries for the 2026-08-02 and 2026-08-09 Sunday services
 * went out headed "Saturday". A test written on a Malaysian laptop could not
 * see it.
 *
 * `npm test` therefore runs `TZ=UTC jest` so the suite matches production.
 * Assigning `process.env.TZ` HERE does not work — by the time setupFiles runs,
 * Node has already resolved and cached the process timezone, so the variable
 * changes but `Intl.DateTimeFormat().resolvedOptions().timeZone` does not. It
 * has to come from the environment before the process starts.
 *
 * Anything genuinely timezone-sensitive must convert explicitly rather than rely
 * on the ambient zone: `malaysiaToday` / `malaysiaClock` / `malaysiaDayStartUtc`
 * in lib/date.ts. Suites that assert on rendered local dates should emulate the
 * runtime themselves (see tests/email-date.test.ts) so they pass or fail the
 * same way wherever they run.
 */
if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'UTC') {
  // eslint-disable-next-line no-console
  console.warn(
    '[jest] Not running in UTC (%s). Lambda is UTC — use `npm test`, not a bare `jest`, ' +
    'or timezone bugs can hide.',
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
}
