/**
 * Opening hours — THE single source of truth for when the café opens.
 *
 * ## Every `HH:MM` here is Malaysian wall-clock time (MYT, UTC+8)
 *
 * Stated once, here. Everything below points back to this paragraph rather than
 * repeating it. The stored strings carry no offset on purpose: they are what the
 * volunteer reads off the roster, they are unambiguous, and they sort
 * lexicographically, which is what makes the ordering and overlap checks below
 * one-liners. Turning one into a real instant goes only through
 * `malaysiaTimeUtc()` in `lib/date.ts`, which owns the offset — there is no
 * `+ 8 * 60 * 60 * 1000` and no `+08:00` literal in this file, and there must
 * not be.
 *
 * The boundary that earns this module its place in the backend: **00:30 on a
 * Sunday in MYT is still Saturday in UTC.** A UTC-derived day-of-week therefore
 * reports "not a service day" for the eight hours before 08:00 MYT on the one
 * day the café actually opens — the same fault that headed the end-of-day
 * summary emails for the 2026-08-02 and 2026-08-09 services "Saturday". So the
 * decision is made here, beside `lib/date.ts`, instead of in three disagreeing
 * hardcoded strings in the frontend (which is what it was), and being here it is
 * testable under `TZ=UTC jest` with an injected clock, which a browser-side copy
 * is not.
 *
 * ## What this is NOT
 *
 * **Opening hours are DESCRIPTIVE, never a gate.** `cafeStatus` — flipped by a
 * human in the POS — remains the only thing that decides whether an order is
 * accepted. Nothing here may refuse an order, and no route may start comparing
 * the clock against `openingHours` to decide whether the café is open. That is
 * the obvious next "improvement" and it is wrong: a service that starts late,
 * an extended session, or a one-off event would lock real customers out of a
 * café whose door is open and whose volunteers are standing behind the counter.
 */

import { malaysiaToday, malaysiaClock, malaysiaTimeUtc, addDaysIso } from './date';

/** One opening session, e.g. the window after the first service. Times are MYT — see the file header. */
export interface OpeningSession {
  /** Human label, e.g. `'After 1st service'`. Trimmed, 1–40 chars. */
  label: string;
  /** 24-hour `HH:MM` opening time. */
  opensAt: string;
  /** 24-hour `HH:MM` closing time, strictly after `opensAt`. */
  closesAt: string;
}

/** The whole `openingHours` attribute of `PK=SETTINGS, SK=CONFIG`. */
export interface OpeningHours {
  /** Day-of-week integers, 0 = Sunday … 6 = Saturday. Unique, ascending. */
  serviceDays: number[];
  /** 1–4 sessions, ascending and non-overlapping. */
  sessions: OpeningSession[];
}

/**
 * Deep-freeze an `OpeningHours` so a shared reference cannot be mutated.
 *
 * Needed because `readOpeningHours()` hands back `DEFAULT_OPENING_HOURS`
 * **by reference** on the common path, and a Lambda sandbox is reused across
 * requests: one caller pushing onto `.sessions` or sorting `.serviceDays` in
 * place would silently alter what every later request in that same sandbox
 * sees. Freezing (rather than copying on the way out) is deliberate — under
 * strict mode, which compiled ES modules always are, the mutation throws where
 * it happens instead of appearing to work in a unit test and corrupting a warm
 * production sandbox hours later.
 */
function freezeHours(hours: OpeningHours): OpeningHours {
  for (const session of hours.sessions) Object.freeze(session);
  Object.freeze(hours.sessions);
  Object.freeze(hours.serviceDays);
  Object.freeze(hours);
  return hours;
}

/**
 * The documented operating context (`.kiro/steering/project.md` line 50):
 * Sundays only, 10:15–11:30 after the first service and 12:45–13:30 after the
 * second. Frozen — see `freezeHours`.
 */
export const DEFAULT_OPENING_HOURS: OpeningHours = freezeHours({
  serviceDays: [0],
  sessions: [
    { label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' },
    { label: 'After 2nd service', opensAt: '12:45', closesAt: '13:30' },
  ],
});

const MAX_SESSIONS = 4;
const MAX_LABEL_LENGTH = 40;

/** Strict 24-hour `HH:MM`. Rejects `'9:5'`, `'1015'`, `'25:00'`, `'10:60'`. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Weekday and month names are built from arrays rather than `Intl` /
// `toLocaleString`. An unqualified `toLocaleDateString` renders in the ambient
// process zone, which on Lambda is UTC — that is precisely how the end-of-day
// summary emails for the 2026-08-02 and 2026-08-09 services went out headed
// "Saturday". Same style as `frontend/js/admin.js:130-137`.
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─────────────────────────────────────────────────────────────────────────────
// Validation (write path)
// ─────────────────────────────────────────────────────────────────────────────

type ValidationResult =
  | { ok: true; value: OpeningHours }
  | { ok: false; error: string };

function fail(error: string): ValidationResult {
  return { ok: false, error };
}

/**
 * Validate an untrusted `openingHours` value, e.g. straight off a
 * `PUT /api/admin/settings` body or out of a stored settings record.
 *
 * Every `error` is admin-facing, so each rule gets its own readable message —
 * an admin who mistypes a time needs to know which session and which field.
 * On success the returned value is NORMALISED (`serviceDays` sorted ascending,
 * labels trimmed, only the three known session keys kept) and is what callers
 * must persist; persisting the raw input would store un-normalised data that
 * later reads then have to cope with.
 */
export function validateOpeningHours(raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('openingHours must be an object');
  }
  const input = raw as Record<string, unknown>;

  // ── serviceDays ──
  const rawDays = input.serviceDays;
  if (!Array.isArray(rawDays)) {
    return fail('openingHours.serviceDays must be an array of day numbers');
  }
  if (rawDays.length === 0) {
    return fail('openingHours.serviceDays must list at least one day');
  }
  if (rawDays.length > 7) {
    return fail('openingHours.serviceDays cannot list more than 7 days');
  }
  const days: number[] = [];
  for (const day of rawDays) {
    if (typeof day !== 'number' || !Number.isInteger(day)) {
      return fail('openingHours.serviceDays must contain whole numbers (0 = Sunday … 6 = Saturday)');
    }
    if (day < 0 || day > 6) {
      return fail('openingHours.serviceDays values must be between 0 (Sunday) and 6 (Saturday)');
    }
    if (days.includes(day)) {
      return fail(`openingHours.serviceDays lists ${WEEKDAYS_LONG[day]} more than once`);
    }
    days.push(day);
  }
  days.sort((a, b) => a - b);

  // ── sessions ──
  const rawSessions = input.sessions;
  if (!Array.isArray(rawSessions)) {
    return fail('openingHours.sessions must be an array of sessions');
  }
  if (rawSessions.length === 0) {
    return fail('openingHours.sessions must list at least one session');
  }
  if (rawSessions.length > MAX_SESSIONS) {
    return fail(`openingHours.sessions cannot have more than ${MAX_SESSIONS} sessions`);
  }

  const sessions: OpeningSession[] = [];
  for (let i = 0; i < rawSessions.length; i++) {
    const n = i + 1; // 1-based for the admin-facing message
    const rawSession = rawSessions[i];
    if (rawSession === null || typeof rawSession !== 'object' || Array.isArray(rawSession)) {
      return fail(`openingHours.sessions[${i}] must be an object`);
    }
    const s = rawSession as Record<string, unknown>;

    if (typeof s.label !== 'string') {
      return fail(`Session ${n}: label must be text`);
    }
    const label = s.label.trim();
    if (label.length === 0) {
      return fail(`Session ${n}: label cannot be empty`);
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return fail(`Session ${n}: label cannot exceed ${MAX_LABEL_LENGTH} characters`);
    }

    if (typeof s.opensAt !== 'string' || !HHMM.test(s.opensAt)) {
      return fail(`Session ${n} ("${label}"): opensAt must be a 24-hour time like "10:15"`);
    }
    if (typeof s.closesAt !== 'string' || !HHMM.test(s.closesAt)) {
      return fail(`Session ${n} ("${label}"): closesAt must be a 24-hour time like "11:30"`);
    }
    // Lexicographic comparison is exact for zero-padded HH:MM.
    if (s.closesAt <= s.opensAt) {
      return fail(`Session ${n} ("${label}"): closesAt (${s.closesAt}) must be after opensAt (${s.opensAt})`);
    }

    const previous = sessions[i - 1];
    if (previous && s.opensAt < previous.closesAt) {
      return fail(
        `Session ${n} ("${label}") opens at ${s.opensAt}, before session ${i} ("${previous.label}") closes at ${previous.closesAt} — sessions must be in order and must not overlap`
      );
    }

    sessions.push({ label, opensAt: s.opensAt, closesAt: s.closesAt });
  }

  return { ok: true, value: { serviceDays: days, sessions } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull `openingHours` off a settings record, falling back to the default.
 *
 * **Absent → the default, silently.** That is the legitimate initial state of
 * every settings record that exists today: the attribute is new, no admin has
 * saved one yet, and the default *is* the café's real schedule. A warning there
 * would fire on every request forever and train everyone to ignore the log.
 *
 * **Present but invalid → the default, LOUDLY.** A stored value that fails
 * validation means the café is showing times nobody configured, which is a
 * feature silently degrading on bad config — the thing the `invariants` skill
 * forbids (web push died for weeks behind a silent skip). The log names the
 * validation error and the record it came from so it is diagnosable from
 * CloudWatch alone; the API response stays minimal, as ever.
 *
 * Both fallback paths return the shared frozen `DEFAULT_OPENING_HOURS`, so a
 * caller cannot mutate it and poison later requests in the same warm sandbox.
 */
export function readOpeningHours(settingsItem: Record<string, unknown> | undefined): OpeningHours {
  const stored = settingsItem?.openingHours;
  if (stored === undefined || stored === null) return DEFAULT_OPENING_HOURS;

  const result = validateOpeningHours(stored);
  if (result.ok) return result.value;

  const pk = typeof settingsItem?.PK === 'string' ? settingsItem.PK : '?';
  const sk = typeof settingsItem?.SK === 'string' ? settingsItem.SK : '?';
  console.warn(
    `[opening-hours] Stored openingHours on settings record PK=${pk} SK=${sk} is invalid: ` +
    `${result.error}. Falling back to DEFAULT_OPENING_HOURS ` +
    `(${describeSessionsLabel(DEFAULT_OPENING_HOURS.sessions)}). ` +
    `Fix it in Admin → Settings; customers are being shown the default, not what is stored.`
  );
  return DEFAULT_OPENING_HOURS;
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision
// ─────────────────────────────────────────────────────────────────────────────

export interface OpeningState {
  /**
   * Where the clock sits relative to the schedule.
   *
   * - `BEFORE_FIRST_TODAY` — a service day, before the first session opens.
   * - `WITHIN_SESSION` — a service day and the clock is INSIDE a configured
   *   session, i.e. the café is scheduled to be serving right now. Note what
   *   this does and does not claim: the schedule says open, and `cafeStatus`
   *   (which is the only real answer) may still say CLOSED. That combination is
   *   the ordinary case of volunteers a few minutes late to open, or closing
   *   early because they ran out. The payload deliberately cannot tell those two
   *   apart, so nothing here may assert "running late" — see
   *   `currentSessionClosesLabel`.
   * - `BETWEEN_SESSIONS` — a service day, in the gap between two sessions.
   * - `AFTER_LAST_TODAY` — a service day, past the last session's `closesAt`.
   * - `NOT_SERVICE_DAY` — not a service day in MYT at all.
   */
  phase: 'BEFORE_FIRST_TODAY' | 'WITHIN_SESSION' | 'BETWEEN_SESSIONS' | 'AFTER_LAST_TODAY' | 'NOT_SERVICE_DAY';
  /**
   * Whether a session still OPENS later today. The headline decision the
   * customer closed screen branches on.
   *
   * Deliberately independent of `phase`: at 10:20, inside session 1 of two, this
   * is `true` (session 2 opens at 12:45) while `phase` is `WITHIN_SESSION`. That
   * looks like an inconsistency and is not — the two answer different questions,
   * "is there another opening to wait for" and "where am I now". Do not
   * "fix" one to agree with the other. Inside the LAST session it is `false`,
   * because there is genuinely no further opening today.
   */
  opensLaterToday: boolean;
  /** Absolute UTC ISO instant of the next session open. */
  nextOpenAt: string | null;
  /** Rounded minutes from `now`, floored at 0. `null` when `nextOpenAt` is. */
  minutesUntilNextOpen: number | null;
  /** `'10:15 AM'` — the next OPENING, never the current session's close. */
  nextOpenTimeLabel: string;
  /** `'today'` | `'tomorrow'` | `'Sunday'` | `'Sun 30 Aug'` */
  nextOpenDayLabel: string;
  /** `'10:15 AM & 12:45 PM, after each service'` */
  nextServiceSessionsLabel: string;
  /** `'Sundays'` */
  serviceDaysLabel: string;
  /**
   * The label of the session the clock is inside, e.g. `'After 1st service'`.
   * `null` in every phase other than `WITHIN_SESSION` — a nullable field rather
   * than `''` so a caller cannot render an empty string as if it were a name.
   */
  currentSessionLabel: string | null;
  /**
   * When the session the clock is inside is scheduled to close, e.g.
   * `'11:30 AM'`. `null` outside `WITHIN_SESSION`.
   *
   * This exists so the closed screen can say something true in both directions
   * — "scheduled to be open until 11:30 AM, but the counter is closed at the
   * moment" covers late-to-open and closed-early equally, which is required
   * because the data cannot distinguish them.
   */
  currentSessionClosesLabel: string | null;
}

/**
 * Describe where the clock is relative to the café's opening hours.
 *
 * Pure: everything comes from `hours` plus the injected `now`, so a test can pin
 * any instant, including the UTC/MYT boundary. Timezone handling and the
 * descriptive-not-a-gate rule are both in the file header.
 */
export function describeOpeningState(hours: OpeningHours, now: Date = new Date()): OpeningState {
  const todayIso = malaysiaToday(now);
  const myt = malaysiaClock(now);
  const nowHhmm = `${pad2(myt.getUTCHours())}:${pad2(myt.getUTCMinutes())}`;
  const todayDow = myt.getUTCDay();

  const serviceDaysLabel = describeServiceDaysLabel(hours.serviceDays);

  if (hours.serviceDays.includes(todayDow)) {
    // Is the clock INSIDE a session? Checked before the "what opens next" scan,
    // and the ONLY reader of `closesAt` — without it the field is validated,
    // normalised and stored while having no observable effect anywhere, which
    // also means a mistyped `closesAt` that passes validation is untestable.
    //
    // Half-open interval [opensAt, closesAt): open at exactly `opensAt`, closed
    // at exactly `closesAt`. That is what makes two adjacent sessions
    // (…–11:30, 11:30–…) unambiguous at 11:30 and leaves no one-minute gap.
    // Validation guarantees sessions are ascending and non-overlapping, so at
    // most one can match and `find` returning the first is exact.
    const current = hours.sessions.find(s => s.opensAt <= nowHhmm && nowHhmm < s.closesAt) || null;

    // What opens NEXT today. Lexicographic on zero-padded HH:MM, so "strictly in
    // the future" is a plain `>`: a session whose opensAt equals the current
    // minute has already opened.
    const index = hours.sessions.findIndex(s => s.opensAt > nowHhmm);
    if (index >= 0) {
      return buildState({
        // Inside a session wins over the gap-based phases. It cannot collide
        // with BEFORE_FIRST_TODAY — being inside a session means the first
        // session has already opened — so that value keeps its exact meaning.
        phase: current ? 'WITHIN_SESSION' : (index === 0 ? 'BEFORE_FIRST_TODAY' : 'BETWEEN_SESSIONS'),
        opensLaterToday: true,
        dateIso: todayIso,
        dayOffset: 0,
        session: hours.sessions[index],
        sessionsOnThatDay: hours.sessions,
        serviceDaysLabel,
        currentSession: current,
        now,
      });
    }

    // Nothing else opens today. Either we are inside the LAST session — still
    // scheduled to be serving, so WITHIN_SESSION, not AFTER_LAST_TODAY — or the
    // last session has closed and today is genuinely done. Both take their next
    // opening from a later service day.
    return nextDayState(current ? 'WITHIN_SESSION' : 'AFTER_LAST_TODAY', hours, todayIso, serviceDaysLabel, now, current);
  }

  return nextDayState('NOT_SERVICE_DAY', hours, todayIso, serviceDaysLabel, now, null);
}

/**
 * Search forward for the next service day and describe its first session.
 * `serviceDays` is non-empty after validation, so a match always exists within
 * 7 days — the loop bound is 7, not "until found", so a future bug cannot spin.
 */
function nextDayState(
  phase: 'WITHIN_SESSION' | 'AFTER_LAST_TODAY' | 'NOT_SERVICE_DAY',
  hours: OpeningHours,
  todayIso: string,
  serviceDaysLabel: string,
  now: Date,
  currentSession: OpeningSession | null
): OpeningState {
  for (let offset = 1; offset <= 7; offset++) {
    const dateIso = addDaysIso(todayIso, offset);
    // Day-of-week read at explicit UTC midnight of a MYT calendar date:
    // `malaysiaToday()` already decided the date, so this is plain calendar
    // arithmetic and must NOT be shifted again.
    const dow = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
    if (!hours.serviceDays.includes(dow)) continue;
    return buildState({
      phase,
      opensLaterToday: false,
      dateIso,
      dayOffset: offset,
      session: hours.sessions[0],
      sessionsOnThatDay: hours.sessions,
      serviceDaysLabel,
      currentSession,
      now,
    });
  }

  // Unreachable with a validated OpeningHours (non-empty serviceDays). Not a
  // silent fallback: if it ever fires, the config is broken and the log has to
  // say so, per the no-silently-degraded-feature rule.
  console.warn(
    `[opening-hours] No service day found within 7 days of ${todayIso} (MYT calendar date, ` +
    `derived from now=${now.toISOString()}). Looked in openingHours.serviceDays=` +
    `[${hours.serviceDays.join(',')}] (expected at least one integer, 0=Sunday … 6=Saturday); ` +
    `openingHours.sessions has ${hours.sessions.length} session(s); phase=${phase}. ` +
    `openingHours is unusable: the next opening time cannot be reported, so the customer ` +
    `closed screen will show no opening time at all. This branch should be unreachable — a ` +
    `value that came through validateOpeningHours()/readOpeningHours() always has a non-empty ` +
    `serviceDays — so reaching it means an unvalidated OpeningHours was passed straight to ` +
    `describeOpeningState().`
  );
  return {
    phase,
    opensLaterToday: false,
    nextOpenAt: null,
    minutesUntilNextOpen: null,
    nextOpenTimeLabel: '',
    nextOpenDayLabel: '',
    nextServiceSessionsLabel: '',
    serviceDaysLabel,
    // Preserved even here: the schedule for the session in progress is still
    // known and still true, and it is the only honest thing left to render.
    currentSessionLabel: currentSession ? currentSession.label : null,
    currentSessionClosesLabel: currentSession ? describeTimeLabel(currentSession.closesAt) : null,
  };
}

function buildState(args: {
  phase: OpeningState['phase'];
  opensLaterToday: boolean;
  dateIso: string;
  dayOffset: number;
  /** The session that opens NEXT — not the one in progress. */
  session: OpeningSession;
  sessionsOnThatDay: OpeningSession[];
  serviceDaysLabel: string;
  /** The session the clock is inside, or `null`. Only source of the current* labels. */
  currentSession: OpeningSession | null;
  now: Date;
}): OpeningState {
  const nextOpenAt = malaysiaTimeUtc(args.dateIso, args.session.opensAt);
  const minutes = Math.round((new Date(nextOpenAt).getTime() - args.now.getTime()) / 60000);
  return {
    phase: args.phase,
    opensLaterToday: args.opensLaterToday,
    nextOpenAt,
    minutesUntilNextOpen: Math.max(0, minutes),
    nextOpenTimeLabel: describeTimeLabel(args.session.opensAt),
    nextOpenDayLabel: describeDayLabel(args.dateIso, args.dayOffset),
    nextServiceSessionsLabel: describeSessionsLabel(args.sessionsOnThatDay),
    serviceDaysLabel: args.serviceDaysLabel,
    currentSessionLabel: args.currentSession ? args.currentSession.label : null,
    currentSessionClosesLabel: args.currentSession ? describeTimeLabel(args.currentSession.closesAt) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Labels — all built from the data, none hardcoded
// ─────────────────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `'10:15'` → `'10:15 AM'`, `'12:45'` → `'12:45 PM'`, `'00:30'` → `'12:30 AM'`. */
export function describeTimeLabel(hhmm: string): string {
  const hour = Number(hhmm.slice(0, 2));
  const minute = hhmm.slice(3, 5);
  const period = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minute} ${period}`;
}

/**
 * `'today'` / `'tomorrow'` / a weekday name / `'Sun 30 Aug'`.
 *
 * A weekday name is only unambiguous strictly inside the coming week: at an
 * offset of exactly 7 days "Sunday" would be read as *this* Sunday, i.e. today,
 * which is the common case for `AFTER_LAST_TODAY` on a Sunday-only schedule. So
 * 7 or more days out gets the dated form instead.
 */
function describeDayLabel(dateIso: string, dayOffset: number): string {
  if (dayOffset === 0) return 'today';
  if (dayOffset === 1) return 'tomorrow';
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (dayOffset < 7) return WEEKDAYS_LONG[d.getUTCDay()];
  return `${WEEKDAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** `[0]` → `'Sundays'`; `[0,3]` → `'Sundays & Wednesdays'`; all seven → `'every day'`. */
function describeServiceDaysLabel(days: number[]): string {
  if (days.length === 7) return 'every day';
  return joinWithAmpersand(days.map(d => `${WEEKDAYS_LONG[d]}s`));
}

/**
 * The sessions of a service day, as a phrase.
 *
 * Built from the stored data, never a hardcoded schedule — the whole point of
 * this module is that `'Opens 10:15 AM & 12:45 PM'` stops being a literal in
 * `frontend/js/app.js`. Three shapes:
 *
 *  - one session   → `'10:15 AM, After 1st service'`
 *  - many, sharing trailing words in their labels
 *                  → `'10:15 AM & 12:45 PM, after each service'`
 *  - many, sharing nothing → `'10:15 AM & 12:45 PM'`
 *
 * The middle case is why the shared suffix is computed rather than assumed:
 * `'After 1st service'` / `'After 2nd service'` share `'service'`, so the phrase
 * follows the labels an admin actually typed. Rename the sessions to
 * `'Morning'` / `'Afternoon'` and it degrades to the bare times rather than
 * asserting something the data does not say.
 */
export function describeSessionsLabel(sessions: OpeningSession[]): string {
  const times = joinWithAmpersand(sessions.map(s => describeTimeLabel(s.opensAt)));
  if (sessions.length === 0) return '';
  if (sessions.length === 1) return `${times}, ${sessions[0].label}`;
  const shared = commonTrailingWords(sessions.map(s => s.label));
  return shared ? `${times}, after each ${shared}` : times;
}

/** `['a','b','c']` → `'a, b & c'`. */
function joinWithAmpersand(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

/**
 * The words every label ends with, compared case-insensitively and returned in
 * the first label's own casing (lowercased, since it is used mid-sentence).
 * `['After 1st service','After 2nd service']` → `'service'`.
 * `['Morning','Afternoon']` → `''`.
 */
function commonTrailingWords(labels: string[]): string {
  const wordLists = labels.map(l => l.split(/\s+/).filter(Boolean));
  if (wordLists.some(w => w.length === 0)) return '';
  const shortest = Math.min(...wordLists.map(w => w.length));
  let count = 0;
  while (count < shortest) {
    const candidate = wordLists[0][wordLists[0].length - 1 - count].toLowerCase();
    const allMatch = wordLists.every(w => w[w.length - 1 - count].toLowerCase() === candidate);
    if (!allMatch) break;
    count++;
  }
  // A label that is entirely the shared phrase means the labels are identical,
  // which says nothing distinguishing — treat it as no shared suffix.
  if (count === 0 || count === shortest) return '';
  return wordLists[0].slice(wordLists[0].length - count).join(' ').toLowerCase();
}
