/**
 * Opening times — `backend/src/lib/opening-hours.ts` plus the two new helpers in
 * `backend/src/lib/date.ts`.
 *
 * This module is the SINGLE SOURCE OF TRUTH for when the café opens; the times
 * used to be hardcoded, differently, in three frontend places. So this suite is
 * the specification for three separate things:
 *
 *  1. `validateOpeningHours` — the write-path contract. One case per rule, each
 *     asserting the SPECIFIC admin-facing `error` string. `ok:false` alone is not
 *     an assertion: every message names a session and a field, and an admin who
 *     mistypes a time has nothing else to go on.
 *  2. `readOpeningHours` — absent falls back silently (the legitimate state of
 *     every settings record in production today), present-but-invalid falls back
 *     LOUDLY. The `console.warn` is the behaviour under test, not noise: a
 *     feature that degrades silently on bad config is the defect that killed web
 *     push for weeks (`invariants` skill, "A FEATURE DISABLED BY MISSING CONFIG
 *     LOGS, LOUDLY").
 *  3. `describeOpeningState` — the Malaysian wall-clock decision, always with an
 *     INJECTED `now`. Never the machine's clock and never the ambient timezone:
 *     `npm test` is `TZ=UTC jest`, and a test that reads the same way in MYT and
 *     UTC is the reason the "Saturday" end-of-day emails shipped.
 *
 * The load-bearing case is `2026-08-15T16:30:00Z` — 00:30 **Sunday** MYT while
 * still **Saturday** in UTC. It is the whole reason this decision lives in the
 * backend next to `lib/date.ts`, and it fails the instant anyone reads the
 * day-of-week off the UTC clock.
 *
 * Fully offline: pure functions, no mocks, no DynamoDB, no network, no
 * credentials. It creates no production record, so no `ZZTEST_` marker applies.
 */

import {
  DEFAULT_OPENING_HOURS,
  OpeningHours,
  OpeningSession,
  describeOpeningState,
  describeSessionsLabel,
  describeTimeLabel,
  readOpeningHours,
  validateOpeningHours,
} from '../src/lib/opening-hours';
import { addDaysIso, malaysiaDayStartUtc, malaysiaTimeUtc } from '../src/lib/date';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A valid session, overridable one field at a time. */
function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { label: 'After 1st service', opensAt: '10:15', closesAt: '11:30', ...overrides };
}

/** A valid `openingHours`, overridable one field at a time. */
function hours(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { serviceDays: [0], sessions: [session()], ...overrides };
}

/** The `error` the validator produced, or a marker that makes a wrong pass loud. */
function errorFor(raw: unknown): string {
  const result = validateOpeningHours(raw);
  return result.ok ? '<<UNEXPECTEDLY VALID>>' : result.error;
}

/** The normalised value, or throw — so a rejected fixture can never pass silently. */
function valueFor(raw: unknown): OpeningHours {
  const result = validateOpeningHours(raw);
  if (!result.ok) throw new Error(`expected valid, got: ${result.error}`);
  return result.value;
}

const SUNDAY = 0;

/** MYT wall-clock helper for readability — asserts nothing, just names instants. */
function mytInstant(dateIso: string, hhmmss: string): Date {
  return new Date(`${dateIso}T${hhmmss}+08:00`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. validateOpeningHours — the write path
// ══════════════════════════════════════════════════════════════════════════════

describe('validateOpeningHours — the whole value', () => {
  it.each([
    ['a string', 'not an object'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', [{ label: 'x', opensAt: '10:15', closesAt: '11:30' }]],
  ])('rejects %s', (_name, raw) => {
    expect(errorFor(raw)).toBe('openingHours must be an object');
  });

  it('rejects null', () => {
    expect(errorFor(null)).toBe('openingHours must be an object');
  });

  it('rejects an empty object naming serviceDays first', () => {
    expect(errorFor({})).toBe('openingHours.serviceDays must be an array of day numbers');
  });
});

describe('validateOpeningHours — serviceDays', () => {
  it('rejects a missing serviceDays', () => {
    expect(errorFor({ sessions: [session()] })).toBe(
      'openingHours.serviceDays must be an array of day numbers'
    );
  });

  it.each([
    ['a number', 0],
    ['a string', '0'],
    ['null', null],
    ['an object', { 0: true }],
  ])('rejects a non-array serviceDays (%s)', (_name, serviceDays) => {
    expect(errorFor(hours({ serviceDays }))).toBe(
      'openingHours.serviceDays must be an array of day numbers'
    );
  });

  it('rejects an empty serviceDays', () => {
    expect(errorFor(hours({ serviceDays: [] }))).toBe(
      'openingHours.serviceDays must list at least one day'
    );
  });

  it('rejects more than 7 days', () => {
    expect(errorFor(hours({ serviceDays: [0, 1, 2, 3, 4, 5, 6, 0] }))).toBe(
      'openingHours.serviceDays cannot list more than 7 days'
    );
  });

  it('rejects day 7 (there is no eighth day)', () => {
    expect(errorFor(hours({ serviceDays: [7] }))).toBe(
      'openingHours.serviceDays values must be between 0 (Sunday) and 6 (Saturday)'
    );
  });

  it('rejects day -1', () => {
    expect(errorFor(hours({ serviceDays: [-1] }))).toBe(
      'openingHours.serviceDays values must be between 0 (Sunday) and 6 (Saturday)'
    );
  });

  it('rejects a fractional day (1.5)', () => {
    expect(errorFor(hours({ serviceDays: [1.5] }))).toBe(
      'openingHours.serviceDays must contain whole numbers (0 = Sunday … 6 = Saturday)'
    );
  });

  it.each([
    ['a numeric string', '0'],
    ['null', null],
    ['NaN', NaN],
  ])('rejects a non-number day (%s)', (_name, day) => {
    expect(errorFor(hours({ serviceDays: [day] }))).toBe(
      'openingHours.serviceDays must contain whole numbers (0 = Sunday … 6 = Saturday)'
    );
  });

  it('rejects a duplicated day and names the weekday', () => {
    expect(errorFor(hours({ serviceDays: [0, 0] }))).toBe(
      'openingHours.serviceDays lists Sunday more than once'
    );
    expect(errorFor(hours({ serviceDays: [3, 5, 3] }))).toBe(
      'openingHours.serviceDays lists Wednesday more than once'
    );
  });

  it('accepts all seven days', () => {
    expect(valueFor(hours({ serviceDays: [6, 5, 4, 3, 2, 1, 0] })).serviceDays).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });
});

describe('validateOpeningHours — sessions', () => {
  it('rejects a missing sessions', () => {
    expect(errorFor({ serviceDays: [SUNDAY] })).toBe(
      'openingHours.sessions must be an array of sessions'
    );
  });

  it.each([
    ['an object', { 0: session() }],
    ['a string', '10:15'],
    ['null', null],
  ])('rejects a non-array sessions (%s)', (_name, sessions) => {
    expect(errorFor(hours({ sessions }))).toBe(
      'openingHours.sessions must be an array of sessions'
    );
  });

  it('rejects an empty sessions', () => {
    expect(errorFor(hours({ sessions: [] }))).toBe(
      'openingHours.sessions must list at least one session'
    );
  });

  it('rejects 5 sessions (the cap is 4)', () => {
    const five = [
      session({ label: 'S1', opensAt: '08:00', closesAt: '08:30' }),
      session({ label: 'S2', opensAt: '09:00', closesAt: '09:30' }),
      session({ label: 'S3', opensAt: '10:00', closesAt: '10:30' }),
      session({ label: 'S4', opensAt: '11:00', closesAt: '11:30' }),
      session({ label: 'S5', opensAt: '12:00', closesAt: '12:30' }),
    ];
    expect(errorFor(hours({ sessions: five }))).toBe(
      'openingHours.sessions cannot have more than 4 sessions'
    );
  });

  it('accepts exactly 4 sessions', () => {
    const four = [
      session({ label: 'S1', opensAt: '08:00', closesAt: '08:30' }),
      session({ label: 'S2', opensAt: '09:00', closesAt: '09:30' }),
      session({ label: 'S3', opensAt: '10:00', closesAt: '10:30' }),
      session({ label: 'S4', opensAt: '11:00', closesAt: '11:30' }),
    ];
    expect(valueFor(hours({ sessions: four })).sessions).toHaveLength(4);
  });

  it.each([
    ['a string', 'After 1st service'],
    ['null', null],
    ['an array', ['10:15', '11:30']],
  ])('rejects a session that is not an object (%s) and names its INDEX', (_name, bad) => {
    expect(errorFor(hours({ sessions: [session(), bad] }))).toBe(
      'openingHours.sessions[1] must be an object'
    );
  });
});

describe('validateOpeningHours — session label', () => {
  it.each([
    ['a number', 1],
    ['null', null],
    ['undefined (missing)', undefined],
    ['an object', { text: 'After 1st service' }],
  ])('rejects a non-string label (%s)', (_name, label) => {
    expect(errorFor(hours({ sessions: [session({ label })] }))).toBe(
      'Session 1: label must be text'
    );
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a tab', '\t'],
  ])('rejects a %s label (measured after trimming)', (_name, label) => {
    expect(errorFor(hours({ sessions: [session({ label })] }))).toBe(
      'Session 1: label cannot be empty'
    );
  });

  it('rejects a 41-character label and accepts a 40-character one', () => {
    expect(errorFor(hours({ sessions: [session({ label: 'x'.repeat(41) })] }))).toBe(
      'Session 1: label cannot exceed 40 characters'
    );
    expect(valueFor(hours({ sessions: [session({ label: 'y'.repeat(40) })] })).sessions[0].label)
      .toBe('y'.repeat(40));
  });

  it('numbers the session 1-based in the message, not 0-based', () => {
    expect(
      errorFor(
        hours({
          sessions: [session(), session({ label: '', opensAt: '12:45', closesAt: '13:30' })],
        })
      )
    ).toBe('Session 2: label cannot be empty');
  });
});

describe('validateOpeningHours — opensAt / closesAt format', () => {
  const OPENS_MSG = 'Session 1 ("After 1st service"): opensAt must be a 24-hour time like "10:15"';
  const CLOSES_MSG = 'Session 1 ("After 1st service"): closesAt must be a 24-hour time like "11:30"';

  it.each([
    ['25:00 (hour out of range)', '25:00'],
    ['24:00 (there is no 24th hour)', '24:00'],
    ['9:5 (not zero-padded)', '9:5'],
    ['1015 (no colon)', '1015'],
    ['10:60 (minute out of range)', '10:60'],
    ['10:15:00 (seconds)', '10:15:00'],
    ['an empty string', ''],
    ['10:15 AM (12-hour with a period)', '10:15 AM'],
    ['10:15+08:00 (carries an offset)', '10:15+08:00'],
  ])('rejects opensAt %s', (_name, opensAt) => {
    expect(errorFor(hours({ sessions: [session({ opensAt })] }))).toBe(OPENS_MSG);
  });

  it.each([
    ['a number', 1015],
    ['null', null],
    ['undefined (missing)', undefined],
  ])('rejects a non-string opensAt (%s)', (_name, opensAt) => {
    expect(errorFor(hours({ sessions: [session({ opensAt })] }))).toBe(OPENS_MSG);
  });

  it.each([
    ['25:00', '25:00'],
    ['9:5', '9:5'],
    ['1130', '1130'],
  ])('rejects closesAt %s', (_name, closesAt) => {
    expect(errorFor(hours({ sessions: [session({ closesAt })] }))).toBe(CLOSES_MSG);
  });

  it('rejects a non-string closesAt (a number)', () => {
    expect(errorFor(hours({ sessions: [session({ closesAt: 1130 })] }))).toBe(CLOSES_MSG);
  });

  it('accepts the extremes 00:00 and 23:59', () => {
    const value = valueFor(hours({ sessions: [session({ opensAt: '00:00', closesAt: '23:59' })] }));
    expect(value.sessions[0]).toEqual({
      label: 'After 1st service',
      opensAt: '00:00',
      closesAt: '23:59',
    });
  });
});

describe('validateOpeningHours — session ordering', () => {
  it('rejects closesAt EQUAL to opensAt (a zero-length session)', () => {
    expect(errorFor(hours({ sessions: [session({ opensAt: '10:15', closesAt: '10:15' })] }))).toBe(
      'Session 1 ("After 1st service"): closesAt (10:15) must be after opensAt (10:15)'
    );
  });

  it('rejects closesAt BEFORE opensAt', () => {
    expect(errorFor(hours({ sessions: [session({ opensAt: '11:30', closesAt: '10:15' })] }))).toBe(
      'Session 1 ("After 1st service"): closesAt (10:15) must be after opensAt (11:30)'
    );
  });

  it('rejects sessions listed in DESCENDING order', () => {
    expect(
      errorFor(
        hours({
          sessions: [
            session({ label: 'After 2nd service', opensAt: '12:45', closesAt: '13:30' }),
            session({ label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' }),
          ],
        })
      )
    ).toBe(
      'Session 2 ("After 1st service") opens at 10:15, before session 1 ("After 2nd service") closes at 13:30 — sessions must be in order and must not overlap'
    );
  });

  it('rejects OVERLAPPING sessions', () => {
    expect(
      errorFor(
        hours({
          sessions: [
            session({ label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' }),
            session({ label: 'Overlaps', opensAt: '11:00', closesAt: '12:00' }),
          ],
        })
      )
    ).toBe(
      'Session 2 ("Overlaps") opens at 11:00, before session 1 ("After 1st service") closes at 11:30 — sessions must be in order and must not overlap'
    );
  });

  it('accepts back-to-back sessions that merely touch (opensAt === previous closesAt)', () => {
    const value = valueFor(
      hours({
        sessions: [
          session({ label: 'First', opensAt: '10:15', closesAt: '11:30' }),
          session({ label: 'Second', opensAt: '11:30', closesAt: '12:30' }),
        ],
      })
    );
    expect(value.sessions.map(s => s.opensAt)).toEqual(['10:15', '11:30']);
  });
});

describe('validateOpeningHours — a valid value round-trips NORMALISED', () => {
  it('sorts serviceDays, trims labels and drops unknown session keys', () => {
    const value = valueFor({
      serviceDays: [3, 0, 6],
      sessions: [
        {
          label: '  After 1st service  ',
          opensAt: '10:15',
          closesAt: '11:30',
          colour: 'red',
          note: 'ignored',
        },
        { label: '\tAfter 2nd service\n', opensAt: '12:45', closesAt: '13:30' },
      ],
    });

    expect(value).toEqual({
      serviceDays: [0, 3, 6],
      sessions: [
        { label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' },
        { label: 'After 2nd service', opensAt: '12:45', closesAt: '13:30' },
      ],
    });
    // Pin the key SET, not just the values — `toEqual` above would pass with an
    // extra `undefined`-valued key, and the point is that unknown keys are gone.
    expect(Object.keys(value.sessions[0]).sort()).toEqual(['closesAt', 'label', 'opensAt']);
  });

  it('does not mutate the caller\'s input', () => {
    const raw = { serviceDays: [3, 0], sessions: [session({ label: '  padded  ' })] };
    const snapshot = JSON.parse(JSON.stringify(raw));
    valueFor(raw);
    expect(raw).toEqual(snapshot);
  });

  it('accepts DEFAULT_OPENING_HOURS itself, unchanged', () => {
    expect(valueFor(DEFAULT_OPENING_HOURS)).toEqual(DEFAULT_OPENING_HOURS);
  });

  it('returns a FRESH value, not a reference to the shared default', () => {
    const value = valueFor(DEFAULT_OPENING_HOURS);
    expect(value).not.toBe(DEFAULT_OPENING_HOURS);
    expect(value.sessions).not.toBe(DEFAULT_OPENING_HOURS.sessions);
    expect(Object.isFrozen(value)).toBe(false); // a caller's own copy, safe to edit
  });

  it('DEFAULT_OPENING_HOURS is the documented schedule (Sundays, 10:15 and 12:45)', () => {
    expect(DEFAULT_OPENING_HOURS).toEqual({
      serviceDays: [0],
      sessions: [
        { label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' },
        { label: 'After 2nd service', opensAt: '12:45', closesAt: '13:30' },
      ],
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. readOpeningHours — the read path
// ══════════════════════════════════════════════════════════════════════════════

describe('DEFAULT_OPENING_HOURS is deep-frozen', () => {
  // `readOpeningHours()` hands this exact object back BY REFERENCE on the common
  // path, and a Lambda sandbox is reused across requests — so one caller sorting
  // `.serviceDays` in place would silently change what every later request in
  // that sandbox sees. Freezing makes the mutation throw where it happens.

  it('freezes the object, both arrays and every session', () => {
    expect(Object.isFrozen(DEFAULT_OPENING_HOURS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_OPENING_HOURS.serviceDays)).toBe(true);
    expect(Object.isFrozen(DEFAULT_OPENING_HOURS.sessions)).toBe(true);
    for (const s of DEFAULT_OPENING_HOURS.sessions) {
      expect(Object.isFrozen(s)).toBe(true);
    }
  });

  it('throws rather than silently accepting a mutation of the shared default', () => {
    const hoursRef = readOpeningHours(undefined);
    expect(hoursRef).toBe(DEFAULT_OPENING_HOURS); // by reference, as documented
    expect(() => { (hoursRef.sessions as OpeningSession[]).push(
      { label: 'Injected', opensAt: '20:00', closesAt: '21:00' }
    ); }).toThrow();
    expect(() => { (hoursRef.serviceDays as number[]).push(6); }).toThrow();
    expect(() => { (hoursRef.sessions[0] as { opensAt: string }).opensAt = '23:00'; }).toThrow();
    // …and the default is genuinely unchanged afterwards.
    expect(DEFAULT_OPENING_HOURS.sessions).toHaveLength(2);
    expect(DEFAULT_OPENING_HOURS.serviceDays).toEqual([0]);
    expect(DEFAULT_OPENING_HOURS.sessions[0].opensAt).toBe('10:15');
  });
});

describe('readOpeningHours', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('falls back to the default SILENTLY when the attribute is absent', () => {
    // The legitimate initial state of every settings record in production: the
    // attribute is new and no admin has saved one. A warning here would fire on
    // every request forever.
    expect(readOpeningHours({ PK: 'SETTINGS', SK: 'CONFIG', cafeStatus: 'OPEN' })).toEqual(
      DEFAULT_OPENING_HOURS
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back silently when the whole settings record is missing', () => {
    expect(readOpeningHours(undefined)).toEqual(DEFAULT_OPENING_HOURS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back silently on an explicit null', () => {
    expect(readOpeningHours({ PK: 'SETTINGS', SK: 'CONFIG', openingHours: null })).toEqual(
      DEFAULT_OPENING_HOURS
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the stored value NORMALISED when it is valid', () => {
    const result = readOpeningHours({
      PK: 'SETTINGS',
      SK: 'CONFIG',
      openingHours: {
        serviceDays: [6, 0],
        sessions: [{ label: '  Saturday brew  ', opensAt: '09:00', closesAt: '10:00' }],
      },
    });
    expect(result).toEqual({
      serviceDays: [0, 6],
      sessions: [{ label: 'Saturday brew', opensAt: '09:00', closesAt: '10:00' }],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the default LOUDLY when the stored value is invalid', () => {
    const result = readOpeningHours({
      PK: 'SETTINGS',
      SK: 'CONFIG',
      openingHours: {
        serviceDays: [0],
        sessions: [{ label: 'Broken', opensAt: '10:15', closesAt: '09:00' }],
      },
    });

    expect(result).toEqual(DEFAULT_OPENING_HOURS);
    expect(warn).toHaveBeenCalledTimes(1);

    const logged = String(warn.mock.calls[0][0]);
    // The log must NAME the problem, or it is undiagnosable from CloudWatch.
    expect(logged).toContain('closesAt (09:00) must be after opensAt (10:15)');
    // …and name the record it came from,
    expect(logged).toContain('PK=SETTINGS');
    expect(logged).toContain('SK=CONFIG');
    // …and say what customers are being shown instead.
    expect(logged).toContain('DEFAULT_OPENING_HOURS');
    expect(logged).toContain('10:15 AM & 12:45 PM');
  });

  it('warns with placeholders when the record has no PK/SK to name', () => {
    expect(readOpeningHours({ openingHours: 'nonsense' })).toEqual(DEFAULT_OPENING_HOURS);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain('PK=? SK=?');
    expect(logged).toContain('openingHours must be an object');
  });

  it.each([
    ['a string', 'Sundays 10:15'],
    ['a number', 1015],
    ['an empty object', {}],
    ['an empty sessions array', { serviceDays: [0], sessions: [] }],
    ['an unknown day number', { serviceDays: [9], sessions: [{ label: 'x', opensAt: '10:15', closesAt: '11:30' }] }],
  ])('falls back and warns for %s', (_name, openingHours) => {
    expect(readOpeningHours({ PK: 'SETTINGS', SK: 'CONFIG', openingHours })).toEqual(
      DEFAULT_OPENING_HOURS
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. describeOpeningState — the MYT decision, with a fixed injected clock
// ══════════════════════════════════════════════════════════════════════════════

describe('describeOpeningState — Sunday, the service day', () => {
  it('09:50 MYT: opens later today, 25 minutes away', () => {
    // 2026-08-16T01:50:00Z === 09:50 Sunday MYT.
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-16T01:50:00Z'));
    expect(state).toEqual({
      phase: 'BEFORE_FIRST_TODAY',
      opensLaterToday: true,
      nextOpenAt: '2026-08-16T02:15:00.000Z',
      minutesUntilNextOpen: 25,
      nextOpenTimeLabel: '10:15 AM',
      nextOpenDayLabel: 'today',
      nextServiceSessionsLabel: '10:15 AM & 12:45 PM, after each service',
      serviceDaysLabel: 'Sundays',
      currentSessionLabel: null,
      currentSessionClosesLabel: null,
    });
  });

  it('11:45 MYT, between the two sessions: next open is 12:45 PM today', () => {
    // 2026-08-16T03:45:00Z === 11:45 Sunday MYT — session 1 has closed (11:30).
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-16T03:45:00Z'));
    expect(state.phase).toBe('BETWEEN_SESSIONS');
    expect(state.opensLaterToday).toBe(true);
    expect(state.nextOpenTimeLabel).toBe('12:45 PM');
    expect(state.nextOpenDayLabel).toBe('today');
    expect(state.nextOpenAt).toBe('2026-08-16T04:45:00.000Z');
    expect(state.minutesUntilNextOpen).toBe(60);
  });

  it('15:00 MYT, after the last session: the next open is the FOLLOWING Sunday', () => {
    // 2026-08-16T07:00:00Z === 15:00 Sunday MYT.
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-16T07:00:00Z'));
    expect(state.phase).toBe('AFTER_LAST_TODAY');
    expect(state.opensLaterToday).toBe(false);
    expect(state.nextOpenAt).toBe('2026-08-23T02:15:00.000Z'); // Sunday + 7
    // 7 whole days minus the 4h45m already elapsed past 10:15 on this Sunday.
    expect(state.minutesUntilNextOpen).toBe(7 * 24 * 60 - 285);
    expect(state.nextOpenTimeLabel).toBe('10:15 AM');
    // NOT the bare weekday name: at exactly 7 days out "Sunday" reads as today.
    expect(state.nextOpenDayLabel).toBe('Sun 23 Aug');
  });

  it('13:29 MYT, still inside the LAST session, is WITHIN_SESSION and not AFTER_LAST_TODAY', () => {
    // Re-pinned when `WITHIN_SESSION` was added. Previously this read
    // AFTER_LAST_TODAY at 13:29 — a minute before the session was scheduled to
    // close — because the decision keyed off `opensAt` alone.
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '13:29:00'));
    expect(state.phase).toBe('WITHIN_SESSION');
    expect(state.currentSessionLabel).toBe('After 2nd service');
    expect(state.currentSessionClosesLabel).toBe('1:30 PM');
    // False, and correctly so: inside the LAST session there is genuinely no
    // further opening today, so the next one is next Sunday.
    expect(state.opensLaterToday).toBe(false);
    expect(state.nextOpenDayLabel).toBe('Sun 23 Aug');
  });
});

describe('describeOpeningState — WITHIN_SESSION, the volunteers-are-late case', () => {
  // The bug this phase fixed: at 10:20 on a Sunday, five minutes after a service
  // that started late, the old state said "opens at 12:45 PM" — telling a
  // congregant standing in the foyer to wait two and a half hours.

  it('10:20 MYT is WITHIN_SESSION and names the session and its scheduled close', () => {
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '10:20:00'));
    expect(state.phase).toBe('WITHIN_SESSION');
    expect(state.currentSessionLabel).toBe('After 1st service');
    expect(state.currentSessionClosesLabel).toBe('11:30 AM');
  });

  it('opensLaterToday stays TRUE inside session 1 — deliberately not agreeing with phase', () => {
    // These two fields answer different questions: "is there another opening to
    // wait for" (yes — 12:45) and "where am I now" (inside session 1). The
    // apparent inconsistency is the design; do NOT make one agree with the other.
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '10:20:00'));
    expect(state.phase).toBe('WITHIN_SESSION');
    expect(state.opensLaterToday).toBe(true);
    expect(state.nextOpenTimeLabel).toBe('12:45 PM'); // the next OPENING…
    expect(state.currentSessionClosesLabel).toBe('11:30 AM'); // …not this session's close
  });

  it('the current-session labels are NULL in every other phase', () => {
    const cases: Array<[string, string]> = [
      ['10:00:00', 'BEFORE_FIRST_TODAY'],
      ['11:45:00', 'BETWEEN_SESSIONS'],
      ['14:00:00', 'AFTER_LAST_TODAY'],
    ];
    for (const [hhmmss, expectedPhase] of cases) {
      const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', hhmmss));
      expect(state.phase).toBe(expectedPhase);
      // `null`, never `''` — a caller must not be able to render an empty string
      // as if it were a session name.
      expect(state.currentSessionLabel).toBeNull();
      expect(state.currentSessionClosesLabel).toBeNull();
    }
    const wednesday = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-19T04:00:00Z'));
    expect(wednesday.phase).toBe('NOT_SERVICE_DAY');
    expect(wednesday.currentSessionLabel).toBeNull();
    expect(wednesday.currentSessionClosesLabel).toBeNull();
  });
});

describe('describeOpeningState — the session-CLOSE boundary, half-open [opensAt, closesAt)', () => {
  it('one minute before session 1 closes, still WITHIN_SESSION', () => {
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '11:29:00'));
    expect(state.phase).toBe('WITHIN_SESSION');
    expect(state.currentSessionClosesLabel).toBe('11:30 AM');
  });

  it('at the EXACT instant session 1 closes, the session is over', () => {
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '11:30:00'));
    expect(state.phase).toBe('BETWEEN_SESSIONS');
    expect(state.currentSessionLabel).toBeNull();
    expect(state.currentSessionClosesLabel).toBeNull();
    expect(state.opensLaterToday).toBe(true);
    expect(state.nextOpenTimeLabel).toBe('12:45 PM');
  });

  it('one minute after session 1 closes, unchanged but a minute closer', () => {
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '11:31:00'));
    expect(state.phase).toBe('BETWEEN_SESSIONS');
    expect(state.minutesUntilNextOpen).toBe(74);
  });

  it('at the EXACT instant the LAST session closes, today is genuinely done', () => {
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '13:30:00'));
    expect(state.phase).toBe('AFTER_LAST_TODAY');
    expect(state.currentSessionLabel).toBeNull();
    expect(state.opensLaterToday).toBe(false);
  });

  it('one minute after the LAST session closes, still AFTER_LAST_TODAY', () => {
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '13:31:00'));
    expect(state.phase).toBe('AFTER_LAST_TODAY');
    expect(state.currentSessionLabel).toBeNull();
  });

  it('two ADJACENT sessions leave no gap: at the shared boundary you are inside the SECOND', () => {
    // This is why the interval is half-open rather than inclusive at both ends.
    // Inclusive would make 11:30 match both sessions; exclusive at both ends
    // would leave a one-minute hole where the café is neither open nor between.
    const adjacent: OpeningHours = {
      serviceDays: [0],
      sessions: [
        { label: 'First', opensAt: '10:15', closesAt: '11:30' },
        { label: 'Second', opensAt: '11:30', closesAt: '12:30' },
      ],
    };
    const state = describeOpeningState(adjacent, mytInstant('2026-08-16', '11:30:00'));
    expect(state.phase).toBe('WITHIN_SESSION');
    expect(state.currentSessionLabel).toBe('Second');
    expect(state.currentSessionClosesLabel).toBe('12:30 PM');
  });
});

describe('describeOpeningState — the UTC/MYT boundary', () => {
  it('00:30 Sunday MYT is a SERVICE DAY even though UTC still says Saturday', () => {
    const now = new Date('2026-08-15T16:30:00Z');
    // Guard the premise of the test itself, so it cannot silently stop testing
    // what it claims to: UTC says Saturday (6), MYT says Sunday (0).
    expect(now.getUTCDay()).toBe(6);
    expect(now.getUTCDate()).toBe(15);

    const state = describeOpeningState(DEFAULT_OPENING_HOURS, now);
    expect(state.phase).toBe('BEFORE_FIRST_TODAY');
    expect(state.opensLaterToday).toBe(true);
    expect(state.nextOpenDayLabel).toBe('today');
    expect(state.nextOpenTimeLabel).toBe('10:15 AM');
    expect(state.nextOpenAt).toBe('2026-08-16T02:15:00.000Z');
    expect(state.minutesUntilNextOpen).toBe(585); // 9h45m
  });

  it('23:30 Saturday MYT is NOT a service day even though UTC already says Sunday', () => {
    // The mirror image: 2026-08-15T15:30:00Z is Saturday 23:30 MYT, and UTC is
    // still Saturday — so use the instant one hour later, 2026-08-15T16:00Z is
    // Sunday MYT. The genuine mirror is a Saturday-only schedule read late on a
    // Saturday UTC evening.
    const now = new Date('2026-08-22T16:30:00Z'); // 00:30 Sunday MYT again
    const saturdayOnly: OpeningHours = {
      serviceDays: [6],
      sessions: [{ label: 'Saturday brew', opensAt: '09:00', closesAt: '10:00' }],
    };
    const state = describeOpeningState(saturdayOnly, now);
    // MYT day is Sunday, so a Saturday-only café is closed — a UTC read would
    // have said Saturday and wrongly reported "opens later today".
    expect(state.phase).toBe('NOT_SERVICE_DAY');
    expect(state.opensLaterToday).toBe(false);
    expect(state.nextOpenDayLabel).toBe('Saturday');
    expect(state.nextOpenAt).toBe('2026-08-29T01:00:00.000Z');
  });

  it('08:00 MYT is midnight UTC of the same MYT date', () => {
    // A UTC-derived "today" flips here; MYT does not.
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-16T00:00:00Z'));
    expect(state.phase).toBe('BEFORE_FIRST_TODAY');
    expect(state.nextOpenAt).toBe('2026-08-16T02:15:00.000Z');
    expect(state.minutesUntilNextOpen).toBe(135);
  });
});

describe('describeOpeningState — a non-service day', () => {
  it('Wednesday: NOT_SERVICE_DAY, next open the coming Sunday, named as a weekday', () => {
    // 2026-08-19T04:00:00Z === 12:00 Wednesday MYT.
    const now = new Date('2026-08-19T04:00:00Z');
    expect(now.getUTCDay()).toBe(3); // premise guard
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, now);
    expect(state.phase).toBe('NOT_SERVICE_DAY');
    expect(state.opensLaterToday).toBe(false);
    expect(state.nextOpenAt).toBe('2026-08-23T02:15:00.000Z');
    expect(state.nextOpenDayLabel).toBe('Sunday'); // 4 days out, unambiguous
    expect(state.minutesUntilNextOpen).toBe(5655);
  });

  it('Saturday: the next open is TOMORROW', () => {
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-22', '15:00:00'));
    expect(state.phase).toBe('NOT_SERVICE_DAY');
    expect(state.nextOpenDayLabel).toBe('tomorrow');
    expect(state.nextOpenAt).toBe('2026-08-23T02:15:00.000Z');
  });
});

describe('describeOpeningState — the session-open boundary, pinned deliberately', () => {
  // The implementation compares `opensAt > nowHhmm` on zero-padded HH:MM, so a
  // session whose opensAt equals the current MINUTE counts as ALREADY OPEN. That
  // is a deliberate choice, and these three cases exist to make flipping it to
  // `>=` fail loudly rather than silently changing what the closed screen says.

  it('at the exact instant session 1 opens, it is OPEN and no longer "next"', () => {
    // 2026-08-16T02:15:00Z === 10:15:00 Sunday MYT exactly. The interval is
    // half-open, so the session is already in progress at exactly `opensAt`.
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-16T02:15:00Z'));
    expect(state.phase).toBe('WITHIN_SESSION');
    expect(state.currentSessionLabel).toBe('After 1st service');
    expect(state.opensLaterToday).toBe(true);
    expect(state.nextOpenTimeLabel).toBe('12:45 PM');
    expect(state.nextOpenAt).toBe('2026-08-16T04:45:00.000Z');
    expect(state.minutesUntilNextOpen).toBe(150);
  });

  it('one minute after session 1 opens, the answer is unchanged but a minute closer', () => {
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-16T02:16:00Z'));
    expect(state.phase).toBe('WITHIN_SESSION');
    expect(state.nextOpenTimeLabel).toBe('12:45 PM');
    expect(state.minutesUntilNextOpen).toBe(149);
  });

  it('one minute BEFORE session 1 opens, session 1 is still next', () => {
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-16T02:14:00Z'));
    expect(state.phase).toBe('BEFORE_FIRST_TODAY');
    expect(state.nextOpenTimeLabel).toBe('10:15 AM');
    expect(state.minutesUntilNextOpen).toBe(1);
  });

  it('seconds within the opening minute do not flip the decision, and minutes floor at 0', () => {
    // 10:14:50 MYT — still before the open, but under a minute away.
    const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '10:14:50'));
    expect(state.phase).toBe('BEFORE_FIRST_TODAY');
    expect(state.opensLaterToday).toBe(true);
    expect(state.minutesUntilNextOpen).toBe(0);
    // 10:15:30 MYT — thirty seconds INTO the session, already open.
    const after = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', '10:15:30'));
    expect(after.phase).toBe('WITHIN_SESSION');
    expect(after.nextOpenTimeLabel).toBe('12:45 PM');
  });

  it('minutesUntilNextOpen is never negative', () => {
    for (const hhmmss of ['00:00:00', '10:14:59', '10:15:00', '13:30:00', '23:59:59']) {
      const state = describeOpeningState(DEFAULT_OPENING_HOURS, mytInstant('2026-08-16', hhmmss));
      expect(state.minutesUntilNextOpen).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('describeOpeningState — multi-day and multi-session schedules', () => {
  const sunAndWed: OpeningHours = {
    serviceDays: [0, 3],
    sessions: [
      { label: 'Morning', opensAt: '09:00', closesAt: '10:00' },
      { label: 'Evening', opensAt: '19:00', closesAt: '20:00' },
    ],
  };

  it('picks the nearer of two service days', () => {
    // Monday 2026-08-17 12:00 MYT → next service day is Wednesday.
    const state = describeOpeningState(sunAndWed, mytInstant('2026-08-17', '12:00:00'));
    expect(state.phase).toBe('NOT_SERVICE_DAY');
    expect(state.nextOpenDayLabel).toBe('Wednesday');
    expect(state.nextOpenAt).toBe('2026-08-19T01:00:00.000Z'); // 09:00 MYT Wed
    expect(state.serviceDaysLabel).toBe('Sundays & Wednesdays');
  });

  it('labels a schedule with no shared session wording as bare times', () => {
    const state = describeOpeningState(sunAndWed, mytInstant('2026-08-16', '08:00:00'));
    expect(state.nextServiceSessionsLabel).toBe('9:00 AM & 7:00 PM');
  });

  it('an every-day schedule opens TOMORROW once today is done', () => {
    const everyDay: OpeningHours = {
      serviceDays: [0, 1, 2, 3, 4, 5, 6],
      sessions: [{ label: 'All day', opensAt: '08:00', closesAt: '18:00' }],
    };
    const state = describeOpeningState(everyDay, mytInstant('2026-08-19', '20:00:00'));
    expect(state.phase).toBe('AFTER_LAST_TODAY');
    expect(state.nextOpenDayLabel).toBe('tomorrow');
    expect(state.serviceDaysLabel).toBe('every day');
    expect(state.nextServiceSessionsLabel).toBe('8:00 AM, All day');
  });

  it('a single-session Sunday schedule names the session in the label', () => {
    const oneSession: OpeningHours = {
      serviceDays: [0],
      sessions: [{ label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' }],
    };
    const state = describeOpeningState(oneSession, mytInstant('2026-08-16', '08:00:00'));
    expect(state.nextServiceSessionsLabel).toBe('10:15 AM, After 1st service');
  });
});

describe('describeOpeningState — an unusable config is not silently degraded', () => {
  it('warns and reports nulls when no service day can be found', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Unreachable through `validateOpeningHours` (serviceDays is non-empty
      // after validation), so this pins the defensive branch rather than a
      // reachable state. The rule it protects: a feature that cannot answer must
      // say so in the log, never return a plausible-looking wrong answer.
      const broken = { serviceDays: [], sessions: DEFAULT_OPENING_HOURS.sessions } as OpeningHours;
      const state = describeOpeningState(broken, new Date('2026-08-16T01:50:00Z'));

      expect(state.phase).toBe('NOT_SERVICE_DAY');
      expect(state.opensLaterToday).toBe(false);
      expect(state.nextOpenAt).toBeNull();
      expect(state.minutesUntilNextOpen).toBeNull();
      expect(state.nextOpenTimeLabel).toBe('');
      expect(state.nextOpenDayLabel).toBe('');
      // Both null, and unavoidably so: this branch needs an empty `serviceDays`
      // to be reached, and an empty `serviceDays` means no session can be in
      // progress. The `currentSession ? … : null` guard there has no reachable
      // true side — see the note in the report.
      expect(state.currentSessionLabel).toBeNull();
      expect(state.currentSessionClosesLabel).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('No service day found within 7 days');
      expect(String(warn.mock.calls[0][0])).toContain('2026-08-16');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('describeOpeningState — uses the injected clock, not the machine clock', () => {
  it('two different injected instants give two different answers under a frozen system clock', () => {
    jest.useFakeTimers();
    try {
      // Pin the system clock to a Wednesday. If the implementation ever reads
      // `new Date()` instead of `now`, both calls below return the same thing.
      jest.setSystemTime(new Date('2026-08-19T04:00:00Z'));
      const sunday = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-16T01:50:00Z'));
      const wednesday = describeOpeningState(DEFAULT_OPENING_HOURS, new Date('2026-08-19T04:00:00Z'));
      expect(sunday.phase).toBe('BEFORE_FIRST_TODAY');
      expect(wednesday.phase).toBe('NOT_SERVICE_DAY');
      expect(sunday.minutesUntilNextOpen).toBe(25);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ─── Exported label helpers ───────────────────────────────────────────────────

describe('describeTimeLabel', () => {
  it.each([
    ['00:00', '12:00 AM'],
    ['00:30', '12:30 AM'],
    ['09:05', '9:05 AM'],
    ['10:15', '10:15 AM'],
    ['11:59', '11:59 AM'],
    ['12:00', '12:00 PM'],
    ['12:45', '12:45 PM'],
    ['13:30', '1:30 PM'],
    ['23:59', '11:59 PM'],
  ])('%s → %s', (hhmm, expected) => {
    expect(describeTimeLabel(hhmm)).toBe(expected);
  });
});

describe('describeSessionsLabel', () => {
  it('one session: time then its own label', () => {
    expect(describeSessionsLabel([{ label: 'After 1st service', opensAt: '10:15', closesAt: '11:30' }]))
      .toBe('10:15 AM, After 1st service');
  });

  it('two sessions sharing trailing words: the shared word is used', () => {
    expect(describeSessionsLabel(DEFAULT_OPENING_HOURS.sessions))
      .toBe('10:15 AM & 12:45 PM, after each service');
  });

  it('three sessions read as a list', () => {
    expect(
      describeSessionsLabel([
        { label: 'Early service', opensAt: '08:00', closesAt: '09:00' },
        { label: 'Mid service', opensAt: '10:00', closesAt: '11:00' },
        { label: 'Late service', opensAt: '12:00', closesAt: '13:00' },
      ])
    ).toBe('8:00 AM, 10:00 AM & 12:00 PM, after each service');
  });

  it('sessions sharing nothing degrade to bare times rather than asserting a phrase', () => {
    expect(
      describeSessionsLabel([
        { label: 'Morning', opensAt: '09:00', closesAt: '10:00' },
        { label: 'Afternoon', opensAt: '14:00', closesAt: '15:00' },
      ])
    ).toBe('9:00 AM & 2:00 PM');
  });

  it('IDENTICAL labels say nothing distinguishing, so they degrade to bare times', () => {
    expect(
      describeSessionsLabel([
        { label: 'Service', opensAt: '09:00', closesAt: '10:00' },
        { label: 'Service', opensAt: '14:00', closesAt: '15:00' },
      ])
    ).toBe('9:00 AM & 2:00 PM');
  });

  it('an empty session list is an empty label', () => {
    expect(describeSessionsLabel([])).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. lib/date.ts — the new helpers, and a regression guard on the old one
// ══════════════════════════════════════════════════════════════════════════════

describe('malaysiaTimeUtc', () => {
  it.each([
    ['2026-08-16', '10:15', '2026-08-16T02:15:00.000Z'],
    ['2026-08-16', '12:45', '2026-08-16T04:45:00.000Z'],
    ['2026-08-16', '00:00', '2026-08-15T16:00:00.000Z'], // crosses back a UTC day
    ['2026-08-16', '07:59', '2026-08-15T23:59:00.000Z'],
    ['2026-08-16', '08:00', '2026-08-16T00:00:00.000Z'], // MYT 08:00 is UTC midnight
    ['2026-08-16', '23:59', '2026-08-16T15:59:00.000Z'],
    ['2027-01-01', '00:00', '2026-12-31T16:00:00.000Z'], // crosses a year
  ])('(%s, %s) → %s', (dateIso, hhmm, expected) => {
    expect(malaysiaTimeUtc(dateIso, hhmm)).toBe(expected);
  });

  it('round-trips back to the same MYT wall clock', () => {
    const iso = malaysiaTimeUtc('2026-08-16', '10:15');
    // +8h then read the UTC parts — the same trick `malaysiaClock` uses.
    const myt = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
    expect(myt.getUTCHours()).toBe(10);
    expect(myt.getUTCMinutes()).toBe(15);
    expect(myt.getUTCDate()).toBe(16);
  });
});

describe('addDaysIso', () => {
  it.each([
    ['2026-08-16', 0, '2026-08-16'],
    ['2026-08-16', 1, '2026-08-17'],
    ['2026-08-16', 7, '2026-08-23'],
    ['2026-08-31', 1, '2026-09-01'], // month end
    ['2026-12-31', 1, '2027-01-01'], // year end
    ['2026-03-01', -1, '2026-02-28'], // backwards, non-leap
    ['2024-02-28', 1, '2024-02-29'], // leap year
    ['2024-02-29', 1, '2024-03-01'],
    ['2026-08-16', 365, '2027-08-16'],
  ])('(%s, %i) → %s', (dateIso, days, expected) => {
    expect(addDaysIso(dateIso, days)).toBe(expected);
  });

  it('is pure calendar arithmetic and applies no timezone shift', () => {
    // If it ever gained an offset, +1 day from a date would not be that date + 1.
    expect(addDaysIso('2026-08-16', 1)).toBe('2026-08-17');
    expect(addDaysIso(addDaysIso('2026-08-16', 1), -1)).toBe('2026-08-16');
  });
});

describe('malaysiaDayStartUtc — regression guard (it now DELEGATES to malaysiaTimeUtc)', () => {
  // Literal expected values, computed independently of the implementation.
  // Asserting `malaysiaDayStartUtc(d) === malaysiaTimeUtc(d, '00:00')` would be
  // vacuous now that one calls the other — it would pass however both are broken.
  it.each([
    ['2026-08-16', '2026-08-15T16:00:00.000Z'],
    ['2026-08-02', '2026-08-01T16:00:00.000Z'],
    ['2026-01-01', '2025-12-31T16:00:00.000Z'],
    ['2024-02-29', '2024-02-28T16:00:00.000Z'],
    ['2026-12-31', '2026-12-30T16:00:00.000Z'],
  ])('%s → %s', (date, expected) => {
    expect(malaysiaDayStartUtc(date)).toBe(expected);
  });

  it('is always 16:00 UTC of the PREVIOUS calendar day', () => {
    for (const date of ['2026-08-16', '2026-02-01', '2026-11-30']) {
      const result = malaysiaDayStartUtc(date);
      expect(result.endsWith('T16:00:00.000Z')).toBe(true);
      expect(result.slice(0, 10)).toBe(addDaysIso(date, -1));
    }
  });
});
