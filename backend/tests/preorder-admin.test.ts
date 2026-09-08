/**
 * Pre-order LINKS, the admin side — `backend/src/routes/preorder.ts`.
 *
 * Four suites already exercise this file, all of them THROUGH `routes/orders.ts`
 * (they own those areas; nothing here re-tests them):
 *
 *   - `preorder-excluded-options.test.ts` — `optionKey` / `normalizeExcludedOptions`
 *     as units, and `createOrder` refusing an excluded variant.
 *   - `preorder-collection-time.test.ts` — `DEFAULT_COLLECTION_OPTIONS` as consumed
 *     by `resolveCollectionTime`.
 *   - `preorder-pending.test.ts` / `preorder-pending-gaps.test.ts` — `getPreorderCode`
 *     as reached from `modifyOrder` / the expiry cron.
 *
 * None of them calls `handleAdminPreorder`, so the entire CRUD surface an admin
 * uses to MINT a link — and the public `GET /preorder/validate` that a customer's
 * link hits — was uncovered (18.09% statements before this file). That is the gap
 * covered here: code allocation, the four route verbs, every validation branch,
 * and the exact record written.
 *
 * `handleValidatePreorder` is included even though it is the public half, because
 * `resolveTemplate` / `resolveNextSundayLabel` (the `{$SUNDAY}` banner variable)
 * are module-private and that endpoint is their only caller.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and it
 * is mocked, so this suite needs no credentials, makes no network call and writes
 * nothing to production — hence **no `ZZTEST_` marker applies** (that rule covers
 * suites that create real records; the `Put`/`Update` objects here are mock call
 * arguments the assertions read and discard).
 *
 * Every assertion is on what the handler PRODUCED: the response body it returned,
 * the `Item` it would have Put, the `UpdateExpression` /
 * `ExpressionAttributeValues` it built, or the `Key` it read — never on the
 * fixture the test itself constructed.
 *
 * The clock is pinned with `jest.setSystemTime` throughout. `createPreorderCode`,
 * `updatePreorderCode`, `handleValidatePreorder` and `resolveNextSundayLabel` all
 * take their "now" from the wall clock with no injection point, and a test whose
 * result depends on the machine's date or zone is not a test — see `invariants`,
 * Test teeth. Where an injected clock DOES exist (`validatePreorderCode(code, now)`)
 * it is used in preference.
 */

const mockDbSend = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  INGREDIENTS_TABLE: 'test-ingredients',
  USERS_TABLE: 'test-users',
  SETTINGS_TABLE: 'test-settings',
  CUSTOMERS_TABLE: 'test-customers',
  VOUCHERS_TABLE: 'test-vouchers',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
  DeleteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Delete' })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  handleAdminPreorder,
  handleValidatePreorder,
  getPreorderCode,
  validatePreorderCode,
  optionKey,
  normalizeExcludedOptions,
  DEFAULT_COLLECTION_OPTIONS,
} = require('../src/routes/preorder');

/**
 * `require`, not `import * as`, deliberately: with `esModuleInterop` an
 * `import *` of a CommonJS module is copied through `__importStar`, and a spy on
 * the copy would not be seen by `preorder.ts`'s own `crypto_1.randomBytes(...)`.
 * `require` hands back the live module object both files share.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Wednesday 2026-09-02, 12:00 MYT. Not a Sunday — the next one is 6 Sep. */
const WED_NOON_MYT = new Date('2026-09-02T04:00:00Z');
const WED_NOON_ISO = '2026-09-02T04:00:00.000Z';

/** Sunday 2026-09-06, 12:00 MYT. "Today IS Sunday". */
const SUN_NOON_MYT = new Date('2026-09-06T04:00:00Z');
/** Monday 2026-09-07, 00:30 MYT — still SUNDAY in UTC. */
const MON_0030_MYT = new Date('2026-09-06T16:30:00Z');
/** Wednesday 2026-09-30, 12:00 MYT — the next Sunday is in the following month. */
const WED_SEP30_MYT = new Date('2026-09-30T04:00:00Z');

/**
 * The generator's alphabet, restated. It is module-private in `preorder.ts`, and
 * the point of the shape assertions below is that a code contains no character a
 * volunteer could misread — 0/O, 1/I/L are absent by design.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SHAPE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/** A valid create body; every field the route accepts, so tests subtract rather than add. */
function createBody(overrides: Record<string, any> = {}) {
  return {
    name: 'Music team',
    opensAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-09-06T00:00:00.000Z',
    serviceDate: '2026-09-06',
    ...overrides,
  };
}

/** A stored link record, as `createPreorderCode` would have written it. */
function codeRecord(overrides: Record<string, any> = {}) {
  return {
    PK: 'PREORDER_CODE#ABC23456', SK: 'META', code: 'ABC23456', name: 'Music team',
    opensAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-09-06T00:00:00.000Z',
    serviceDate: '2026-09-06',
    serviceEndTime: '2026-09-06T07:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'Admin',
    isActive: true,
    bannerMessage: '',
    eligibleItems: [],
    collectionOptions: DEFAULT_COLLECTION_OPTIONS.slice(),
    excludedOptions: [],
    ...overrides,
  };
}

// ─── Events ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    httpMethod: 'GET', path: '/api/admin/preorder-codes', body: null,
    headers: {}, queryStringParameters: null, pathParameters: null,
    ...overrides,
  } as any;
}

function postEvent(body: unknown) {
  return makeEvent({
    httpMethod: 'POST',
    body: typeof body === 'string' || body === null ? body : JSON.stringify(body),
  });
}

function putEvent(code: string, body: unknown) {
  return makeEvent({
    httpMethod: 'PUT',
    path: `/api/admin/preorder-codes/${code}`,
    body: typeof body === 'string' || body === null ? body : JSON.stringify(body),
  });
}

function deleteEvent(code: string, queryStringParameters: Record<string, string> | null = null) {
  return makeEvent({
    httpMethod: 'DELETE',
    path: `/api/admin/preorder-codes/${code}`,
    queryStringParameters,
  });
}

function validateEvent(code?: string) {
  return makeEvent({
    path: '/api/preorder/validate',
    queryStringParameters: code === undefined ? null : { code },
  });
}

// ─── Staging ──────────────────────────────────────────────────────────────────

/**
 * Staging for `createPreorderCode`. `collisions: n` makes the FIRST n candidate
 * lookups come back occupied, which is the only way to reach the retry loop and
 * its allocation-failure exit — a queued `mockResolvedValueOnce` could not,
 * because the candidate code is random and the test never learns it in advance.
 */
function stageCreate(opts: { collisions?: number } = {}) {
  const collisions = opts.collisions ?? 0;
  let seen = 0;
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd !== 'Get') return {};
    seen++;
    return seen <= collisions ? { Item: { PK: cmd.Key.PK, SK: 'META' } } : {};
  });
}

/**
 * Staging for the read-then-write routes. `updatePreorderCode` issues TWO Gets
 * with the identical Key — the existence check and the post-write re-read — so
 * they are answered by call ORDER; keying on the Key alone could not tell them
 * apart, and the re-read returning nothing is a real branch.
 * Pass `afterUpdate: null` for that case.
 */
function stageRecord(existing: any, afterUpdate: any = existing) {
  let getCount = 0;
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__cmd !== 'Get') return {};
    getCount++;
    const item = getCount === 1 ? existing : afterUpdate;
    return item ? { Item: item } : {};
  });
}

function stageScan(Items: any[] | undefined) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => (cmd.__cmd === 'Scan' ? { Items } : {}));
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function gets() { return cmds().filter((c) => c.__cmd === 'Get'); }
function puts() { return cmds().filter((c) => c.__cmd === 'Put'); }
function updates() { return cmds().filter((c) => c.__cmd === 'Update'); }
function deletes() { return cmds().filter((c) => c.__cmd === 'Delete'); }
function scans() { return cmds().filter((c) => c.__cmd === 'Scan'); }
/** The record the route would have written. */
function written() { return puts()[0]?.Item; }
/** The candidate codes the route actually probed, in order. */
function candidates() {
  return gets().map((g) => String(g.Key.PK).replace('PREORDER_CODE#', ''));
}

async function create(body: unknown, actor = 'Admin') {
  const res = await handleAdminPreorder(postEvent(body), actor);
  return { res, body: JSON.parse(res.body) };
}

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  jest.setSystemTime(WED_NOON_MYT);
  mockDbSend.mockReset();
});

// ══════════════════════════════════════════════════════════════════════════════
// Code allocation
// ══════════════════════════════════════════════════════════════════════════════

describe('code generation — shape, collision retry, allocation failure', () => {
  it('mints an 8-character code from the unambiguous alphabet and keys the record on it', async () => {
    stageCreate();

    const { res, body } = await create(createBody());

    expect(res.statusCode).toBe(201);
    expect(body.code).toMatch(CODE_SHAPE);
    // The code, the partition key, the response and the shareable link must all
    // carry the SAME value — a mismatch mints a link that resolves to nothing.
    expect(written().code).toBe(body.code);
    expect(written().PK).toBe(`PREORDER_CODE#${body.code}`);
    expect(written().SK).toBe('META');
    expect(body.link).toBe(`https://153.oasisofcare.org/?code=${body.code}`);
    // Exactly one uniqueness probe on the happy path.
    expect(gets()).toHaveLength(1);
    expect(gets()[0].Key).toEqual({ PK: `PREORDER_CODE#${body.code}`, SK: 'META' });
    expect(gets()[0].TableName).toBe('test-settings');
  });

  it('never emits a character a volunteer could misread (no 0/O, 1/I/L)', async () => {
    // The codes are read aloud and typed by hand off a printed slip, so this is
    // the whole reason the alphabet is not plain base32.
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      stageCreate();
      const { body } = await create(createBody());
      expect(body.code).toMatch(CODE_SHAPE);
      for (const ch of body.code) expect(CODE_ALPHABET).toContain(ch);
      seen.add(body.code);
    }
    // 30^8 combos — 25 draws colliding would mean the bytes are not random.
    expect(seen.size).toBe(25);
  });

  it('maps each random byte through the alphabet modulo its length', async () => {
    // Pinned deterministically so the mapping itself is asserted, not just the
    // shape: 0→A, 30→9 (last symbol), 31→A (wraps), 255→H (255 % 31 === 7).
    const spy = jest.spyOn(nodeCrypto, 'randomBytes')
      .mockReturnValueOnce(Buffer.from([0, 1, 2, 30, 31, 32, 255, 62]));
    try {
      stageCreate();
      const { body } = await create(createBody());
      expect(body.code).toBe('ABC9ABHA');
      expect(spy).toHaveBeenCalledWith(8);
      expect(written().PK).toBe('PREORDER_CODE#ABC9ABHA');
    } finally {
      spy.mockRestore();
    }
  });

  it('retries on a collision and stores the SECOND candidate', async () => {
    stageCreate({ collisions: 1 });

    const { res, body } = await create(createBody());

    expect(res.statusCode).toBe(201);
    const probed = candidates();
    expect(probed).toHaveLength(2);
    // Asserted against the codes the route itself probed, so this cannot pass by
    // accident: the occupied first candidate must have been abandoned.
    expect(body.code).toBe(probed[1]);
    expect(body.code).not.toBe(probed[0]);
    expect(written().code).toBe(probed[1]);
  });

  it('still succeeds when the FIRST FOUR candidates are taken (the loop runs 5 times)', async () => {
    stageCreate({ collisions: 4 });

    const { res, body } = await create(createBody());

    expect(res.statusCode).toBe(201);
    expect(gets()).toHaveLength(5);
    expect(body.code).toBe(candidates()[4]);
  });

  it('gives up with 500 after five collisions and writes NOTHING', async () => {
    stageCreate({ collisions: 5 });

    const { res, body } = await create(createBody());

    expect(res.statusCode).toBe(500);
    expect(body).toEqual({ error: 'Failed to allocate a unique code — try again' });
    expect(gets()).toHaveLength(5);
    // The empty-string `code` must not be persisted as a real link.
    expect(puts()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST — validation
// ══════════════════════════════════════════════════════════════════════════════

describe('createPreorderCode — every field is validated BEFORE a code is allocated', () => {
  // All five guards sit ahead of the generation loop, so a rejected request must
  // not even probe the table. Asserting "no reads at all" is what pins that
  // ordering; asserting only the 400 would pass with the guards at the bottom.
  it.each([
    ['a null body',                     null,                                         'name is required'],
    ['an empty body',                   {},                                           'name is required'],
    ['a missing name',                  createBody({ name: undefined }),              'name is required'],
    ['a whitespace-only name',          createBody({ name: '   ' }),                  'name is required'],
    ['a non-string name',               createBody({ name: 42 }),                     'name is required'],
    ['a missing opensAt',               createBody({ opensAt: undefined }),           'opensAt is required (ISO datetime)'],
    ['an empty opensAt',                createBody({ opensAt: '' }),                  'opensAt is required (ISO datetime)'],
    ['a non-string opensAt',            createBody({ opensAt: 1234567890 }),          'opensAt is required (ISO datetime)'],
    ['a missing expiresAt',             createBody({ expiresAt: undefined }),         'expiresAt is required (ISO datetime)'],
    ['a non-string expiresAt',          createBody({ expiresAt: { at: 'x' } }),       'expiresAt is required (ISO datetime)'],
    ['a missing serviceDate',           createBody({ serviceDate: undefined }),       'serviceDate must be YYYY-MM-DD'],
    ['a non-string serviceDate',        createBody({ serviceDate: 20260906 }),        'serviceDate must be YYYY-MM-DD'],
    ['a D-M-Y serviceDate',             createBody({ serviceDate: '06-09-2026' }),    'serviceDate must be YYYY-MM-DD'],
    ['an unpadded serviceDate',         createBody({ serviceDate: '2026-9-6' }),      'serviceDate must be YYYY-MM-DD'],
    ['a serviceDate with a time',       createBody({ serviceDate: '2026-09-06T00:00' }), 'serviceDate must be YYYY-MM-DD'],
    ['expiresAt BEFORE opensAt',        createBody({ expiresAt: '2026-09-01T00:00:00.000Z' }), 'expiresAt must be after opensAt'],
    ['expiresAt EQUAL to opensAt',      createBody({ expiresAt: '2026-09-02T00:00:00.000Z' }), 'expiresAt must be after opensAt'],
    ['a 201-character bannerMessage',   createBody({ bannerMessage: 'n'.repeat(201) }), 'bannerMessage cannot exceed 200 characters'],
  ])('rejects %s with 400, and reads nothing', async (_label, body, expected) => {
    stageCreate();

    const { res, body: out } = await create(body);

    expect(res.statusCode).toBe(400);
    expect(out).toEqual({ error: expected });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('accepts the boundary cases the rejections above bracket', async () => {
    // Without these the 400s could be passing for an unrelated reason.
    for (const body of [
      createBody({ bannerMessage: 'n'.repeat(200) }),
      createBody({ serviceDate: '  2026-09-06  ' }),   // trimmed, then matched
      createBody({ expiresAt: '2026-09-02T00:00:00.001Z' }), // 1ms after opensAt
    ]) {
      stageCreate();
      const { res } = await create(body);
      expect(res.statusCode).toBe(201);
    }
  });

  /**
   * ⚠️ FINDING — `backend/src/routes/preorder.ts:227`.
   *
   *   if (Date.parse(opensAt) >= Date.parse(expiresAt)) return res(400, …)
   *
   * `Date.parse` returns `NaN` for anything unparseable and `NaN >= NaN` is
   * `false`, so the ordering guard SILENTLY PASSES whenever either side is not a
   * date. Nothing else checks the format — the two fields are only tested for
   * being non-empty strings — so `opensAt: 'tomorrow'` is stored verbatim.
   *
   * The consequence is not cosmetic: `validatePreorderCode` compares them as
   * STRINGS (`nowIso < item.opensAt`), and every non-digit sorts above an ISO
   * timestamp, so the link answers `not_yet` forever. The admin sees 201 and a
   * working-looking URL; the ministry sees "not open yet" until someone thinks to
   * re-read the record. This test PINS TODAY'S BEHAVIOUR, it does not endorse it.
   */
  it('DOES NOT reject an unparseable opensAt / expiresAt (finding — bricks the link)', async () => {
    stageCreate();

    const { res, body } = await create(createBody({
      opensAt: 'tomorrow morning', expiresAt: 'after church',
    }));

    expect(res.statusCode).toBe(201);
    const minted = written();
    expect(minted.opensAt).toBe('tomorrow morning');
    expect(minted.expiresAt).toBe('after church');

    // And the downstream cost, demonstrated rather than asserted about: the link
    // this route just minted can never open.
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({ Item: minted });
    expect(await validatePreorderCode(minted.code, WED_NOON_MYT))
      .toEqual({ valid: false, reason: 'not_yet' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST — the stored record
// ══════════════════════════════════════════════════════════════════════════════

describe('createPreorderCode — the record it writes', () => {
  it('writes exactly the documented shape, and nothing else', async () => {
    stageCreate();

    const { res, body } = await create(createBody({
      name: '  Music team  ',
      bannerMessage: '  Pre-order for {$SUNDAY}  ',
      eligibleItems: ['latte', 'mocha'],
      collectionOptions: ['Before Service'],
      excludedOptions: ['Milk:Oat Milk'],
    }), 'Mei Yii');

    expect(res.statusCode).toBe(201);
    const item = written();

    expect(Object.keys(item).sort()).toEqual([
      'PK', 'SK', 'bannerMessage', 'code', 'collectionOptions', 'createdAt',
      'createdBy', 'eligibleItems', 'excludedOptions', 'expiresAt', 'isActive',
      'name', 'opensAt', 'serviceDate', 'serviceEndTime',
    ]);
    expect(item.name).toBe('Music team');                 // trimmed
    expect(item.bannerMessage).toBe('Pre-order for {$SUNDAY}'); // trimmed, UNRESOLVED on disk
    expect(item.isActive).toBe(true);
    expect(item.createdBy).toBe('Mei Yii');
    expect(item.createdAt).toBe(WED_NOON_ISO);
    expect(item.serviceDate).toBe('2026-09-06');
    // 15:00 MYT on the service date == 07:00Z. This is the ONLY input to
    // `expirePreOrders()`, via the order's ISO expiresAt.
    expect(item.serviceEndTime).toBe('2026-09-06T07:00:00.000Z');
    expect(puts()[0].TableName).toBe('test-settings');

    // The response is the stored item plus the link — no extra, no omissions.
    const { link, ...echoed } = body;
    expect(echoed).toEqual(item);
    expect(link).toBe(`https://153.oasisofcare.org/?code=${item.code}`);
  });

  it("stamps createdBy 'Unknown' when the actor is empty", async () => {
    stageCreate();
    await create(createBody(), '');
    expect(written().createdBy).toBe('Unknown');
  });

  it('recomputes serviceEndTime from whatever serviceDate is given', async () => {
    stageCreate();
    await create(createBody({ serviceDate: '2027-01-03', expiresAt: '2027-01-03T00:00:00.000Z' }));
    expect(written().serviceEndTime).toBe('2027-01-03T07:00:00.000Z');
  });

  it('defaults all four optional fields when the body omits them', async () => {
    stageCreate();

    await create(createBody());
    const item = written();

    expect(item.bannerMessage).toBe('');
    expect(item.eligibleItems).toEqual([]);        // empty = "all active drinks"
    expect(item.excludedOptions).toEqual([]);
    expect(item.collectionOptions).toEqual(DEFAULT_COLLECTION_OPTIONS);
    // A COPY of the module constant, not the constant itself — a shared array
    // would let one campaign's edit reach into the defaults for every other.
    expect(item.collectionOptions).not.toBe(DEFAULT_COLLECTION_OPTIONS);
  });

  it('normalises eligibleItems: trimmed, de-duplicated, no blanks, no non-strings', async () => {
    stageCreate();

    await create(createBody({
      eligibleItems: ['  latte  ', 'latte', '', '   ', 7, null, 'mocha'],
    }));

    expect(written().eligibleItems).toEqual(['latte', 'mocha']);
  });

  it.each([
    ['a non-array', 'latte'],
    ['null', null],
    ['an object', { latte: true }],
  ])('stores an empty eligibleItems for %s', async (_label, eligibleItems) => {
    stageCreate();
    await create(createBody({ eligibleItems }));
    expect(written().eligibleItems).toEqual([]);
  });

  it('normalises collectionOptions: trimmed, blanks dropped, capped at 60 characters', async () => {
    stageCreate();

    await create(createBody({
      collectionOptions: ['  After 1st Service  ', '', 9, 'x'.repeat(70)],
    }));

    const opts = written().collectionOptions;
    expect(opts[0]).toBe('After 1st Service');
    expect(opts[1]).toBe('x'.repeat(60));
    expect(opts).toHaveLength(2);
  });

  it.each([
    ['an empty array',        []],
    ['only blanks',           ['  ', '']],
    ['only non-strings',      [1, null, {}]],
    ['a non-array',           'After 1st Service'],
  ])('falls back to DEFAULT_COLLECTION_OPTIONS for %s', async (_label, collectionOptions) => {
    // A link with no usable options must still offer the customer a picker, or
    // `resolveCollectionTime` has nothing to validate against.
    stageCreate();
    await create(createBody({ collectionOptions }));
    expect(written().collectionOptions).toEqual(DEFAULT_COLLECTION_OPTIONS);
  });

  it('normalises excludedOptions through the shared helper', async () => {
    // `normalizeExcludedOptions` is unit-tested in preorder-excluded-options.test.ts;
    // what is pinned here is that the ADMIN WRITE PATH runs the raw body through it,
    // rather than storing half-formed keys that could never match at order time.
    stageCreate();

    await create(createBody({
      excludedOptions: ['  Milk  :  Oat Milk  ', 'Milk:Oat Milk', 'Milk:', ':Oat', 'NoColon', 7],
    }));

    expect(written().excludedOptions).toEqual(['Milk:Oat Milk']);
    expect(written().excludedOptions).toEqual(
      normalizeExcludedOptions(['Milk : Oat Milk ', 'Milk:Oat Milk', 'Milk:', ':Oat', 'NoColon', 7]),
    );
  });

  it('keeps a bannerMessage that trims down to 200 characters (measured TRIMMED)', async () => {
    // The counterpart assertion is in the update block below, where the same
    // input is REJECTED — the two paths do not agree.
    stageCreate();

    const { res } = await create(createBody({ bannerMessage: `${'n'.repeat(195)}${' '.repeat(15)}` }));

    expect(res.statusCode).toBe(201);
    expect(written().bannerMessage).toBe('n'.repeat(195));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET — list
// ══════════════════════════════════════════════════════════════════════════════

describe('listPreorderCodes', () => {
  it('scans the PREORDER_CODE# prefix only', async () => {
    stageScan([]);

    const res = await handleAdminPreorder(makeEvent(), 'Admin');

    expect(res.statusCode).toBe(200);
    expect(scans()).toHaveLength(1);
    expect(scans()[0].TableName).toBe('test-settings');
    expect(scans()[0].FilterExpression).toBe('begins_with(PK, :prefix)');
    expect(scans()[0].ExpressionAttributeValues).toEqual({ ':prefix': 'PREORDER_CODE#' });
  });

  it('returns newest-first by createdAt, each with its link', async () => {
    stageScan([
      codeRecord({ code: 'OLD11111', createdAt: '2026-08-01T00:00:00.000Z' }),
      codeRecord({ code: 'NEW33333', createdAt: '2026-09-01T00:00:00.000Z' }),
      codeRecord({ code: 'MID22222', createdAt: '2026-08-15T00:00:00.000Z' }),
    ]);

    const res = await handleAdminPreorder(makeEvent(), 'Admin');
    const { codes } = JSON.parse(res.body);

    expect(codes.map((c: any) => c.code)).toEqual(['NEW33333', 'MID22222', 'OLD11111']);
    expect(codes.map((c: any) => c.link)).toEqual([
      'https://153.oasisofcare.org/?code=NEW33333',
      'https://153.oasisofcare.org/?code=MID22222',
      'https://153.oasisofcare.org/?code=OLD11111',
    ]);
    // The rest of each record is passed through untouched.
    expect(codes[0].serviceEndTime).toBe('2026-09-06T07:00:00.000Z');
  });

  it('sorts a record with NO createdAt last instead of throwing', async () => {
    // Records predating the field, and the `(a.createdAt || '')` fallback.
    const { createdAt, ...noCreatedAt } = codeRecord({ code: 'LEGACY11' });
    stageScan([noCreatedAt, codeRecord({ code: 'DATED111', createdAt: '2026-08-01T00:00:00.000Z' })]);

    const { codes } = JSON.parse((await handleAdminPreorder(makeEvent(), 'Admin')).body);

    expect(codes.map((c: any) => c.code)).toEqual(['DATED111', 'LEGACY11']);

    // Same two records, arriving from the scan in the opposite order — the
    // comparator's other side must fall back too, or the result depends on the
    // (unordered) scan order rather than on createdAt.
    stageScan([codeRecord({ code: 'DATED111', createdAt: '2026-08-01T00:00:00.000Z' }), noCreatedAt]);
    const reversed = JSON.parse((await handleAdminPreorder(makeEvent(), 'Admin')).body);
    expect(reversed.codes.map((c: any) => c.code)).toEqual(['DATED111', 'LEGACY11']);
  });

  it('URL-encodes the code into the link', async () => {
    stageScan([codeRecord({ code: 'A B&C' })]);
    const { codes } = JSON.parse((await handleAdminPreorder(makeEvent(), 'Admin')).body);
    expect(codes[0].link).toBe('https://153.oasisofcare.org/?code=A%20B%26C');
  });

  it('returns an empty array when the scan yields no Items key at all', async () => {
    stageScan(undefined);
    const res = await handleAdminPreorder(makeEvent(), 'Admin');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ codes: [] });
  });

  it('writes nothing — listing is a read', async () => {
    stageScan([codeRecord()]);
    await handleAdminPreorder(makeEvent(), 'Admin');
    expect([...puts(), ...updates(), ...deletes()]).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE — soft deactivate and hard delete
// ══════════════════════════════════════════════════════════════════════════════

describe('deactivatePreorderCode (soft DELETE)', () => {
  it('404s an unknown code without writing', async () => {
    stageRecord(undefined);

    const res = await handleAdminPreorder(deleteEvent('ABC23456'), 'Admin');

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'code not found' });
    expect(updates()).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it('flips isActive to false and keeps the record (audit trail of used links)', async () => {
    stageRecord(codeRecord());

    const res = await handleAdminPreorder(deleteEvent('ABC23456'), 'Admin');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ code: 'ABC23456', isActive: false });
    expect(updates()).toHaveLength(1);
    expect(updates()[0].TableName).toBe('test-settings');
    expect(updates()[0].Key).toEqual({ PK: 'PREORDER_CODE#ABC23456', SK: 'META' });
    expect(updates()[0].UpdateExpression).toBe('SET isActive = :f');
    expect(updates()[0].ExpressionAttributeValues).toEqual({ ':f': false });
    // Soft: the row survives, because a deactivated link's restrictions still
    // apply to orders already placed through it.
    expect(deletes()).toHaveLength(0);
  });

  it('uppercases and URL-decodes the code from the path', async () => {
    stageRecord(codeRecord());

    const res = await handleAdminPreorder(deleteEvent('abc%32%33456'), 'Admin');

    expect(res.statusCode).toBe(200);
    expect(gets()[0].Key).toEqual({ PK: 'PREORDER_CODE#ABC23456', SK: 'META' });
    expect(JSON.parse(res.body).code).toBe('ABC23456');
  });

  it.each([['hard=0', '0'], ['hard=true', 'true'], ['hard= (empty)', '']])(
    'treats %s as a SOFT delete — only the exact string "1" hard-deletes',
    async (_label, hard) => {
      stageRecord(codeRecord());
      const res = await handleAdminPreorder(deleteEvent('ABC23456', { hard }), 'Admin');
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).isActive).toBe(false);
      expect(deletes()).toHaveLength(0);
    },
  );
});

describe('hardDeletePreorderCode (DELETE ?hard=1)', () => {
  it('deletes the row outright', async () => {
    stageRecord(codeRecord());

    const res = await handleAdminPreorder(deleteEvent('ABC23456', { hard: '1' }), 'Admin');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ code: 'ABC23456', deleted: true });
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].TableName).toBe('test-settings');
    expect(deletes()[0].Key).toEqual({ PK: 'PREORDER_CODE#ABC23456', SK: 'META' });
    expect(updates()).toHaveLength(0);
  });

  /**
   * Observation (not a defect): the hard path is deliberately asymmetric with the
   * soft one — it issues NO existence check, so an unknown code answers
   * `200 {deleted:true}` rather than the soft path's `404`. Idempotent, but worth
   * pinning: a hard delete of a mistyped code reports success.
   */
  it('reports success for a code that never existed, and never reads first', async () => {
    stageRecord(undefined);

    const res = await handleAdminPreorder(deleteEvent('NOSUCH11', { hard: '1' }), 'Admin');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ code: 'NOSUCH11', deleted: true });
    expect(gets()).toHaveLength(0);
    expect(deletes()).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT — partial update
// ══════════════════════════════════════════════════════════════════════════════

describe('updatePreorderCode — existence and the empty-update guard', () => {
  it('404s an unknown code before building any expression', async () => {
    stageRecord(undefined);

    const res = await handleAdminPreorder(putEvent('ABC23456', { name: 'Renamed' }), 'Admin');

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Pre-order code not found' });
    expect(updates()).toHaveLength(0);
    expect(gets()).toHaveLength(1);
  });

  it.each([
    ['an empty body',                    {}],
    ['only unrecognised keys',           { colour: 'red', code: 'HACKED11', PK: 'x' }],
    ['a blank name',                     { name: '   ' }],
    ['a non-string name',                { name: 7 }],
    ['an empty opensAt',                 { opensAt: '' }],
    ['a non-boolean isActive',           { isActive: 'false' }],
    ['a non-array eligibleItems',        { eligibleItems: 'latte' }],
  ])('400s "No fields to update" for %s, and writes nothing', async (_label, body) => {
    stageRecord(codeRecord());

    const res = await handleAdminPreorder(putEvent('ABC23456', body), 'Admin');

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'No fields to update' });
    expect(updates()).toHaveLength(0);
    // `code` and `PK` are not updatable fields — an attempt to rename the key is
    // simply not in the allowed set.
    expect(mockDbSend.mock.calls.every((c) => c[0].__cmd === 'Get')).toBe(true);
  });
});

describe('updatePreorderCode — each field independently', () => {
  /** Run one partial update and hand back the expression the route built. */
  async function update(body: Record<string, any>, actor = 'Admin', existing = codeRecord()) {
    stageRecord(existing);
    const res = await handleAdminPreorder(putEvent('ABC23456', body), actor);
    return { res, out: JSON.parse(res.body), cmd: updates()[0] };
  }

  it.each([
    ['name',              { name: '  Choir  ' },                       '#n = :n',                    ':n',  'Choir'],
    ['opensAt',           { opensAt: '2026-09-03T00:00:00.000Z' },      'opensAt = :oa',              ':oa', '2026-09-03T00:00:00.000Z'],
    ['expiresAt',         { expiresAt: '2026-09-07T00:00:00.000Z' },    'expiresAt = :ea',            ':ea', '2026-09-07T00:00:00.000Z'],
    ['bannerMessage',     { bannerMessage: '  Order for {$SUNDAY}  ' }, 'bannerMessage = :bm',        ':bm', 'Order for {$SUNDAY}'],
    ['isActive false',    { isActive: false },                          'isActive = :ia',             ':ia', false],
    ['isActive true',     { isActive: true },                           'isActive = :ia',             ':ia', true],
  ])('updates %s alone', async (_label, body, clause, key, expected) => {
    const { res, cmd } = await update(body);

    expect(res.statusCode).toBe(200);
    expect(cmd.TableName).toBe('test-settings');
    expect(cmd.Key).toEqual({ PK: 'PREORDER_CODE#ABC23456', SK: 'META' });
    expect(cmd.UpdateExpression).toContain(clause);
    expect(cmd.ExpressionAttributeValues[key]).toEqual(expected);
    // Nothing else was touched.
    expect(Object.keys(cmd.ExpressionAttributeValues).sort()).toEqual([key, ':ua', ':ub'].sort());
  });

  it('aliases the reserved word `name` and supplies the alias map only then', async () => {
    const withName = await update({ name: 'Choir' });
    expect(withName.cmd.ExpressionAttributeNames).toEqual({ '#n': 'name' });

    const withoutName = await update({ isActive: false });
    // Omitted entirely rather than sent empty — DynamoDB rejects an empty map.
    expect(withoutName.cmd.ExpressionAttributeNames).toBeUndefined();
  });

  it('recomputes serviceEndTime whenever serviceDate changes', async () => {
    // The 15:00 MYT cutoff would otherwise point at the old date, and it is the
    // only thing that ever expires a pre-order placed through this link.
    const { cmd } = await update({ serviceDate: '2026-09-13' });

    expect(cmd.UpdateExpression).toContain('serviceDate = :sd');
    expect(cmd.UpdateExpression).toContain('serviceEndTime = :set');
    expect(cmd.ExpressionAttributeValues[':sd']).toBe('2026-09-13');
    expect(cmd.ExpressionAttributeValues[':set']).toBe('2026-09-13T07:00:00.000Z');
  });

  it('normalises eligibleItems on update exactly as on create', async () => {
    const { cmd } = await update({ eligibleItems: ['  latte ', 'latte', '', 5, 'mocha'] });
    expect(cmd.UpdateExpression).toContain('eligibleItems = :ei');
    expect(cmd.ExpressionAttributeValues[':ei']).toEqual(['latte', 'mocha']);
  });

  it('clears eligibleItems with an explicit empty array (back to "all drinks")', async () => {
    const { cmd } = await update({ eligibleItems: [] });
    expect(cmd.ExpressionAttributeValues[':ei']).toEqual([]);
  });

  it('normalises excludedOptions on update exactly as on create', async () => {
    const { cmd } = await update({ excludedOptions: ['Milk : Oat Milk', 'Milk:Oat Milk', 'Bad'] });
    expect(cmd.UpdateExpression).toContain('excludedOptions = :xo');
    expect(cmd.ExpressionAttributeValues[':xo']).toEqual(['Milk:Oat Milk']);
  });

  it('normalises collectionOptions and falls back to the defaults when all are blank', async () => {
    const ok = await update({ collectionOptions: [' Before Service ', 'y'.repeat(70), '', 3] });
    expect(ok.cmd.UpdateExpression).toContain('collectionOptions = :co');
    expect(ok.cmd.ExpressionAttributeValues[':co']).toEqual(['Before Service', 'y'.repeat(60)]);

    const empty = await update({ collectionOptions: ['  ', ''] });
    expect(empty.cmd.ExpressionAttributeValues[':co']).toEqual(DEFAULT_COLLECTION_OPTIONS);
    expect(empty.cmd.ExpressionAttributeValues[':co']).not.toBe(DEFAULT_COLLECTION_OPTIONS);
  });

  it('always stamps updatedAt and updatedBy, defaulting the actor to Unknown', async () => {
    const named = await update({ isActive: false }, 'Mei Yii');
    expect(named.cmd.UpdateExpression).toContain('updatedAt = :ua');
    expect(named.cmd.UpdateExpression).toContain('updatedBy = :ub');
    expect(named.cmd.ExpressionAttributeValues[':ua']).toBe(WED_NOON_ISO);
    expect(named.cmd.ExpressionAttributeValues[':ub']).toBe('Mei Yii');

    const anonymous = await update({ isActive: false }, '');
    expect(anonymous.cmd.ExpressionAttributeValues[':ub']).toBe('Unknown');
  });

  it('writes every supplied field in ONE UpdateCommand', async () => {
    const { res, cmd } = await update({
      name: 'Choir', opensAt: '2026-09-03T00:00:00.000Z', expiresAt: '2026-09-07T00:00:00.000Z',
      serviceDate: '2026-09-13', bannerMessage: 'Hi', eligibleItems: ['latte'],
      excludedOptions: ['Milk:Oat Milk'], collectionOptions: ['Before Service'], isActive: false,
    });

    expect(res.statusCode).toBe(200);
    expect(updates()).toHaveLength(1);
    expect(cmd.UpdateExpression.startsWith('SET ')).toBe(true);
    for (const clause of [
      '#n = :n', 'opensAt = :oa', 'expiresAt = :ea', 'serviceDate = :sd',
      'serviceEndTime = :set', 'bannerMessage = :bm', 'eligibleItems = :ei',
      'excludedOptions = :xo', 'collectionOptions = :co', 'isActive = :ia',
      'updatedAt = :ua', 'updatedBy = :ub',
    ]) {
      expect(cmd.UpdateExpression).toContain(clause);
    }
  });

  it('re-reads the record afterwards and returns it with the link', async () => {
    stageRecord(codeRecord(), codeRecord({ name: 'Choir', isActive: false }));

    const res = await handleAdminPreorder(putEvent('abc23456', { name: 'Choir' }), 'Admin');
    const out = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    // Two Gets on the SAME key: the existence check, then the fresh read.
    expect(gets()).toHaveLength(2);
    expect(gets()[0].Key).toEqual({ PK: 'PREORDER_CODE#ABC23456', SK: 'META' });
    expect(gets()[1].Key).toEqual(gets()[0].Key);
    expect(out.name).toBe('Choir');
    expect(out.isActive).toBe(false);
    expect(out.link).toBe('https://153.oasisofcare.org/?code=ABC23456');
  });

  it('falls back to a minimal body when the re-read comes back empty', async () => {
    // Eventual consistency, or the row deleted between the write and the read.
    // The write already succeeded, so this must not become an error.
    stageRecord(codeRecord(), null);

    const res = await handleAdminPreorder(putEvent('ABC23456', { name: 'Choir' }), 'Admin');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ code: 'ABC23456', updated: true });
    expect(updates()).toHaveLength(1);
  });
});

describe('updatePreorderCode — the ordering guard and the two parity gaps', () => {
  async function update(body: Record<string, any>, existing = codeRecord()) {
    stageRecord(existing);
    const res = await handleAdminPreorder(putEvent('ABC23456', body), 'Admin');
    return { res, out: JSON.parse(res.body) };
  }

  it.each([
    ['inverted', '2026-09-07T00:00:00.000Z', '2026-09-03T00:00:00.000Z'],
    ['equal',    '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z'],
  ])('rejects %s opensAt/expiresAt sent TOGETHER, before any write', async (_label, opensAt, expiresAt) => {
    const { res, out } = await update({ opensAt, expiresAt });

    expect(res.statusCode).toBe(400);
    expect(out).toEqual({ error: 'expiresAt must be after opensAt' });
    expect(updates()).toHaveLength(0);
  });

  it('accepts a correctly ordered pair (the control)', async () => {
    const { res } = await update({
      opensAt: '2026-09-03T00:00:00.000Z', expiresAt: '2026-09-07T00:00:00.000Z',
    });
    expect(res.statusCode).toBe(200);
    expect(updates()).toHaveLength(1);
  });

  /**
   * ⚠️ FINDING — `backend/src/routes/preorder.ts:397-400`.
   *
   *   if (typeof body.opensAt === 'string' && typeof body.expiresAt === 'string'
   *       && Date.parse(body.opensAt) >= Date.parse(body.expiresAt)) …
   *
   * The guard fires only when BOTH fields are in the same request. This is a
   * PARTIAL update route, so the ordinary way to move one edge of the window is
   * to send just that edge — and then nothing is checked, even though the stored
   * counterpart is right there in `existing.Item` (read three lines earlier for
   * the 404). `opensAt < expiresAt` is an invariant of the record, not of the
   * request, so it should be evaluated against the merged result.
   *
   * Effect: `PUT {opensAt: <after the stored expiresAt>}` stores an inverted
   * window. `validatePreorderCode` tests `opensAt` first, so the link answers
   * `not_yet` for ever — the same dead-link outcome as the create-side finding
   * above, reached from the edit path. Same shape as the create/edit parity class
   * in the `invariants` skill: a rule enforced on create, skipped on edit.
   *
   * PINS TODAY'S BEHAVIOUR.
   */
  it('DOES NOT guard the ordering when only ONE side is sent (finding — inverts the window)', async () => {
    const stored = codeRecord({
      opensAt: '2026-09-02T00:00:00.000Z', expiresAt: '2026-09-06T00:00:00.000Z',
    });

    // opensAt moved to a month AFTER the stored expiresAt.
    const late = await update({ opensAt: '2026-10-01T00:00:00.000Z' }, stored);
    expect(late.res.statusCode).toBe(200);
    expect(updates()[0].ExpressionAttributeValues[':oa']).toBe('2026-10-01T00:00:00.000Z');
    expect(updates()[0].UpdateExpression).not.toContain('expiresAt');

    // …and the mirror: expiresAt pulled BEFORE the stored opensAt.
    const early = await update({ expiresAt: '2026-08-01T00:00:00.000Z' }, stored);
    expect(early.res.statusCode).toBe(200);
    expect(updates()[0].ExpressionAttributeValues[':ea']).toBe('2026-08-01T00:00:00.000Z');
  });

  /**
   * ⚠️ FINDING — `preorder.ts:368` vs `:232`.
   *
   * Create measures the bannerMessage cap on the TRIMMED value
   * (`rawBanner = body.bannerMessage.trim()`, then `rawBanner.length > 200`);
   * update measures the RAW one (`body.bannerMessage.length > 200`) and trims
   * only when storing. So one input is accepted by create and refused by update.
   *
   * Exactly the "a length budget measures the same thing on both paths" rule from
   * the `invariants` skill, and the visible symptom is the worst kind: the admin
   * saves a banner successfully, edits an unrelated field later, and is told the
   * banner is too long.
   */
  it('measures the bannerMessage cap UNTRIMMED on update but TRIMMED on create (finding)', async () => {
    const trailingSpaces = `${'n'.repeat(195)}${' '.repeat(15)}`;   // 210 raw, 195 trimmed

    const onUpdate = await update({ bannerMessage: trailingSpaces });
    expect(onUpdate.res.statusCode).toBe(400);
    expect(onUpdate.out).toEqual({ error: 'bannerMessage cannot exceed 200 characters' });
    expect(updates()).toHaveLength(0);

    // The same string, same field, other path → accepted.
    stageCreate();
    const onCreate = await create(createBody({ bannerMessage: trailingSpaces }));
    expect(onCreate.res.statusCode).toBe(201);
  });

  it('accepts and trims a bannerMessage at the raw 200-character boundary', async () => {
    const { res } = await update({ bannerMessage: `${'n'.repeat(199)} ` });
    expect(res.statusCode).toBe(200);
    expect(updates()[0].ExpressionAttributeValues[':bm']).toBe('n'.repeat(199));
  });

  it('accepts an explicitly EMPTY bannerMessage (clearing the banner)', async () => {
    // `typeof … === 'string'` rather than a truthiness test, so '' is a real edit.
    const { res } = await update({ bannerMessage: '' });
    expect(res.statusCode).toBe(200);
    expect(updates()[0].ExpressionAttributeValues[':bm']).toBe('');
  });

  /**
   * ⚠️ FINDING — `preorder.ts:363`.
   *
   * Create 400s a serviceDate that is not `YYYY-MM-DD`; update tests the same
   * regex but as a CONDITION for including the field, so a malformed value is
   * silently dropped. Sent alongside another field the request returns 200 and
   * the admin has no way to tell the date did not change — and `serviceEndTime`
   * stays pinned to the old service, which is what expires orders on the link.
   *
   * PINS TODAY'S BEHAVIOUR.
   */
  it('SILENTLY IGNORES a malformed serviceDate instead of 400ing (finding)', async () => {
    const { res } = await update({ name: 'Choir', serviceDate: '13-09-2026' });

    expect(res.statusCode).toBe(200);
    expect(updates()[0].UpdateExpression).toContain('#n = :n');
    expect(updates()[0].UpdateExpression).not.toContain('serviceDate');
    expect(updates()[0].UpdateExpression).not.toContain('serviceEndTime');
    expect(updates()[0].ExpressionAttributeValues).not.toHaveProperty(':sd');

    // Alone, it degrades to the confusing-but-safe "No fields to update".
    const alone = await update({ serviceDate: '13-09-2026' });
    expect(alone.res.statusCode).toBe(400);
    expect(alone.out).toEqual({ error: 'No fields to update' });
  });

  it('checks the ordering AFTER the empty-update guard', async () => {
    // Both guards are reachable in one request; the 400 that comes back tells you
    // which runs first, and "No fields to update" would be the wrong diagnosis.
    const { res, out } = await update({
      opensAt: '2026-09-07T00:00:00.000Z', expiresAt: '2026-09-03T00:00:00.000Z',
    });
    expect(res.statusCode).toBe(400);
    expect(out.error).toBe('expiresAt must be after opensAt');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getPreorderCode — the un-gated lookup
// ══════════════════════════════════════════════════════════════════════════════

describe('getPreorderCode', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['undefined',       undefined],
    ['null',            null],
    ['a number',        12345678],
    ['an object',       { code: 'ABC23456' }],
  ])('returns null for %s without touching the table', async (_label, code) => {
    mockDbSend.mockReset();
    expect(await getPreorderCode(code)).toBeNull();
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('trims and uppercases before keying the settings table', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({ Item: codeRecord() });

    const out = await getPreorderCode('  abc23456  ');

    expect(gets()[0].TableName).toBe('test-settings');
    expect(gets()[0].Key).toEqual({ PK: 'PREORDER_CODE#ABC23456', SK: 'META' });
    expect(out.code).toBe('ABC23456');
  });

  it('returns null when the record does not exist', async () => {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({});
    expect(await getPreorderCode('ABC23456')).toBeNull();
  });

  it('does NOT filter a deactivated link, and applies no time window', async () => {
    // The documented difference from `validatePreorderCode`: a customer editing a
    // still-PENDING pre-order after the link closed must still have the link's
    // restrictions read, not be refused outright.
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue({
      Item: codeRecord({ isActive: false, opensAt: '2099-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:00.000Z' }),
    });

    const out = await getPreorderCode('ABC23456');

    expect(out).not.toBeNull();
    expect(out.isActive).toBe(false);
    expect(out.excludedOptions).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// validatePreorderCode — the four outcomes
// ══════════════════════════════════════════════════════════════════════════════

describe('validatePreorderCode', () => {
  function stageOne(Item: any) {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue(Item ? { Item } : {});
  }

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['undefined',       undefined],
    ['null',            null],
    ['a number',        12345678],
  ])('reports invalid for %s without reading', async (_label, code) => {
    mockDbSend.mockReset();
    expect(await validatePreorderCode(code, WED_NOON_MYT)).toEqual({ valid: false, reason: 'invalid' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('reports invalid for a code with no record', async () => {
    stageOne(undefined);
    expect(await validatePreorderCode('ABC23456', WED_NOON_MYT)).toEqual({ valid: false, reason: 'invalid' });
  });

  it('reports invalid — not "expired" — for a DEACTIVATED link inside its window', async () => {
    // The reason string is customer-visible copy; a deactivated link must not
    // claim to have expired.
    stageOne(codeRecord({ isActive: false }));
    expect(await validatePreorderCode('ABC23456', WED_NOON_MYT)).toEqual({ valid: false, reason: 'invalid' });
  });

  it('reports not_yet before opensAt and expired after expiresAt', async () => {
    stageOne(codeRecord({ opensAt: '2026-09-05T00:00:00.000Z' }));
    expect(await validatePreorderCode('ABC23456', WED_NOON_MYT)).toEqual({ valid: false, reason: 'not_yet' });

    stageOne(codeRecord({ expiresAt: '2026-09-01T00:00:00.000Z' }));
    expect(await validatePreorderCode('ABC23456', WED_NOON_MYT)).toEqual({ valid: false, reason: 'expired' });
  });

  it('is INCLUSIVE at both edges of the window', async () => {
    // The comparisons are `<` and `>`, so the instants themselves are open.
    stageOne(codeRecord({ opensAt: WED_NOON_ISO }));
    expect((await validatePreorderCode('ABC23456', WED_NOON_MYT)).valid).toBe(true);

    stageOne(codeRecord({ expiresAt: WED_NOON_ISO }));
    expect((await validatePreorderCode('ABC23456', WED_NOON_MYT)).valid).toBe(true);
  });

  it('treats an absent opensAt / expiresAt as unbounded on that side', async () => {
    const { opensAt, expiresAt, ...noWindow } = codeRecord();
    stageOne(noWindow);
    expect((await validatePreorderCode('ABC23456', new Date('1999-01-01T00:00:00Z'))).valid).toBe(true);
    stageOne(noWindow);
    expect((await validatePreorderCode('ABC23456', new Date('2099-01-01T00:00:00Z'))).valid).toBe(true);
  });

  it('treats an absent isActive as active (records predating the flag)', async () => {
    const { isActive, ...legacy } = codeRecord();
    stageOne(legacy);
    expect((await validatePreorderCode('ABC23456', WED_NOON_MYT)).valid).toBe(true);
  });

  it('returns the whole record on success, keyed off the trimmed/uppercased code', async () => {
    stageOne(codeRecord({ eligibleItems: ['latte'] }));

    const out = await validatePreorderCode('  abc23456 ', WED_NOON_MYT);

    expect(out.valid).toBe(true);
    expect(gets()[0].Key).toEqual({ PK: 'PREORDER_CODE#ABC23456', SK: 'META' });
    expect(out.code.code).toBe('ABC23456');
    expect(out.code.eligibleItems).toEqual(['latte']);
  });

  it('defaults its clock to now when none is injected', async () => {
    stageOne(codeRecord({ opensAt: '2026-09-05T00:00:00.000Z' }));
    // Fake clock is Wednesday 2 Sep, so the link is not open yet.
    expect(await validatePreorderCode('ABC23456')).toEqual({ valid: false, reason: 'not_yet' });

    jest.setSystemTime(SUN_NOON_MYT);
    stageOne(codeRecord({ opensAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-07T00:00:00.000Z' }));
    expect((await validatePreorderCode('ABC23456')).valid).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// {$SUNDAY} — resolveNextSundayLabel / resolveTemplate
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Reached through `GET /preorder/validate`, its only caller. Every case pins the
 * clock: the label is derived from the wall clock in MALAYSIA time, so a test
 * that let the machine supply either the date or the zone would assert nothing.
 */
describe('the {$SUNDAY} banner variable resolves in Malaysia time', () => {
  async function bannerAt(now: Date, bannerMessage: string | undefined) {
    jest.setSystemTime(now);
    mockDbSend.mockReset();
    // Window deliberately wide: these cases vary the CLOCK, so the link must stay
    // open at every instant under test or the assertion would be about expiry.
    mockDbSend.mockResolvedValue({
      Item: codeRecord({
        bannerMessage,
        opensAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
    });
    const res = await handleValidatePreorder(validateEvent('ABC23456'));
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).bannerMessage;
  }

  it('resolves to the UPCOMING Sunday on a weekday', async () => {
    expect(await bannerAt(WED_NOON_MYT, 'Pre-order for {$SUNDAY}'))
      .toBe('Pre-order for Sunday, 6 Sep');
  });

  it('resolves to TODAY when today is already Sunday', async () => {
    // `(7 - dow) % 7` — drop the modulo and this becomes next week, advertising a
    // date a week away to someone standing in the foyer on the day.
    expect(await bannerAt(SUN_NOON_MYT, '{$SUNDAY}')).toBe('Sunday, 6 Sep');
  });

  it('reads the MYT weekday, not the UTC one: 00:30 Monday MYT is next Sunday', async () => {
    // 2026-09-06T16:30Z is still SUNDAY in UTC but already Monday in Malaysia.
    // Reading the UTC day here would advertise yesterday's date.
    expect(await bannerAt(MON_0030_MYT, '{$SUNDAY}')).toBe('Sunday, 13 Sep');
  });

  it('crosses a month boundary', async () => {
    expect(await bannerAt(WED_SEP30_MYT, '{$SUNDAY}')).toBe('Sunday, 4 Oct');
  });

  it('replaces EVERY occurrence, not just the first', async () => {
    expect(await bannerAt(WED_NOON_MYT, '{$SUNDAY}: collect on {$SUNDAY}'))
      .toBe('Sunday, 6 Sep: collect on Sunday, 6 Sep');
  });

  it('passes a banner with no placeholder through byte-for-byte', async () => {
    expect(await bannerAt(WED_NOON_MYT, 'Ministry pre-orders only')).toBe('Ministry pre-orders only');
    // A near-miss must not be substituted either.
    expect(await bannerAt(WED_NOON_MYT, '{SUNDAY} and $SUNDAY')).toBe('{SUNDAY} and $SUNDAY');
  });

  it.each([['an empty banner', ''], ['an absent banner', undefined]])(
    'returns an empty string for %s',
    async (_label, banner) => { expect(await bannerAt(WED_NOON_MYT, banner)).toBe(''); },
  );

  it('leaves the STORED value unresolved — resolution is per-view', async () => {
    // The label is deliberately view-time-relative, so the template must survive
    // in the record. Baking it in at create time would freeze last week's date.
    stageCreate();
    await create(createBody({ bannerMessage: 'Pre-order for {$SUNDAY}' }));
    expect(written().bannerMessage).toBe('Pre-order for {$SUNDAY}');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/preorder/validate — the public contract
// ══════════════════════════════════════════════════════════════════════════════

describe('handleValidatePreorder', () => {
  function stageOne(Item: any) {
    mockDbSend.mockReset();
    mockDbSend.mockResolvedValue(Item ? { Item } : {});
  }

  it('returns the eight fields the customer page reads', async () => {
    stageOne(codeRecord({
      bannerMessage: 'Order for {$SUNDAY}',
      eligibleItems: ['latte'],
      excludedOptions: ['Milk:Oat Milk'],
      collectionOptions: ['Before Service'],
    }));

    const res = await handleValidatePreorder(validateEvent('abc23456'));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      valid: true,
      name: 'Music team',
      opensAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-09-06T00:00:00.000Z',
      serviceDate: '2026-09-06',
      bannerMessage: 'Order for Sunday, 6 Sep',
      eligibleItems: ['latte'],
      excludedOptions: ['Milk:Oat Milk'],
      collectionOptions: ['Before Service'],
    });
  });

  it.each([
    ['absent',      undefined],
    ['null',        null],
    ['a string',    'latte'],
    ['an object',   { latte: true }],
  ])('serves an ARRAY for eligibleItems/excludedOptions when the record has %s', async (_label, value) => {
    // Never null: the client relies on Array.isArray().
    stageOne(codeRecord({ eligibleItems: value, excludedOptions: value }));

    const body = JSON.parse((await handleValidatePreorder(validateEvent('ABC23456'))).body);

    expect(body.eligibleItems).toEqual([]);
    expect(body.excludedOptions).toEqual([]);
  });

  it.each([
    ['absent',        undefined],
    ['empty',         []],
    ['not an array',  'Before Service'],
  ])('falls back to DEFAULT_COLLECTION_OPTIONS when collectionOptions is %s', async (_label, value) => {
    // The picker must always have something to render, and it must be the same
    // list `resolveCollectionTime` validates against.
    stageOne(codeRecord({ collectionOptions: value }));

    const body = JSON.parse((await handleValidatePreorder(validateEvent('ABC23456'))).body);

    expect(body.collectionOptions).toEqual(DEFAULT_COLLECTION_OPTIONS);
  });

  it.each([
    ['an unknown code',   codeRecord({}),  'invalid',  { exists: false }],
    ['a deactivated one', codeRecord({ isActive: false }), 'invalid', {}],
    ['one not yet open',  codeRecord({ opensAt: '2026-09-05T00:00:00.000Z' }), 'not_yet', {}],
    ['an expired one',    codeRecord({ expiresAt: '2026-09-01T00:00:00.000Z' }), 'expired', {}],
  ])('returns 400 with the reason for %s', async (_label, record, reason, opts: any) => {
    stageOne(opts.exists === false ? undefined : record);

    const res = await handleValidatePreorder(validateEvent('ABC23456'));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ valid: false, reason });
  });

  it('treats a missing code query parameter as invalid, with no read', async () => {
    mockDbSend.mockReset();

    const res = await handleValidatePreorder(validateEvent());

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ valid: false, reason: 'invalid' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a POST to the right path', { httpMethod: 'POST', path: '/api/preorder/validate' }],
    ['a GET to another path',    { httpMethod: 'GET', path: '/api/preorder/validate/extra' }],
    ['a GET to the admin path',  { httpMethod: 'GET', path: '/api/admin/preorder-codes' }],
  ])('404s %s', async (_label, overrides) => {
    mockDbSend.mockReset();

    const res = await handleValidatePreorder(makeEvent({ ...overrides, queryStringParameters: { code: 'ABC23456' } }));

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('writes nothing — validation is a read', async () => {
    stageOne(codeRecord());
    await handleValidatePreorder(validateEvent('ABC23456'));
    expect([...puts(), ...updates(), ...deletes()]).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// handleAdminPreorder — dispatch and the error envelope
// ══════════════════════════════════════════════════════════════════════════════

describe('handleAdminPreorder — path dispatch', () => {
  it('POST /admin/preorder-codes → create', async () => {
    stageCreate();
    const res = await handleAdminPreorder(postEvent(createBody()), 'Admin');
    expect(res.statusCode).toBe(201);
    expect(puts()).toHaveLength(1);
  });

  it('GET /admin/preorder-codes → list', async () => {
    stageScan([codeRecord()]);
    const res = await handleAdminPreorder(makeEvent(), 'Admin');
    expect(res.statusCode).toBe(200);
    expect(scans()).toHaveLength(1);
  });

  it('PUT /admin/preorder-codes/<code> → update', async () => {
    stageRecord(codeRecord());
    const res = await handleAdminPreorder(putEvent('ABC23456', { isActive: false }), 'Admin');
    expect(res.statusCode).toBe(200);
    expect(updates()).toHaveLength(1);
  });

  it('DELETE /admin/preorder-codes/<code> → deactivate', async () => {
    stageRecord(codeRecord());
    const res = await handleAdminPreorder(deleteEvent('ABC23456'), 'Admin');
    expect(res.statusCode).toBe(200);
    expect(updates()).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
  });

  it('DELETE /admin/preorder-codes/<code>?hard=1 → hard delete', async () => {
    stageRecord(codeRecord());
    const res = await handleAdminPreorder(deleteEvent('ABC23456', { hard: '1' }), 'Admin');
    expect(res.statusCode).toBe(200);
    expect(deletes()).toHaveLength(1);
    expect(updates()).toHaveLength(0);
  });

  it('dispatches on a STAGE-PREFIXED path too (endsWith, not equality)', async () => {
    stageScan([]);
    const res = await handleAdminPreorder(makeEvent({ path: '/prod/api/admin/preorder-codes' }), 'Admin');
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['PATCH on the collection',        { httpMethod: 'PATCH' }],
    ['PUT on the collection',          { httpMethod: 'PUT', body: '{"name":"x"}' }],
    ['DELETE on the collection',       { httpMethod: 'DELETE' }],
    ['GET on a single code',           { path: '/api/admin/preorder-codes/ABC23456' }],
    ['POST on a single code',          { httpMethod: 'POST', path: '/api/admin/preorder-codes/ABC23456', body: '{}' }],
    ['a trailing slash',               { httpMethod: 'DELETE', path: '/api/admin/preorder-codes/' }],
    ['a nested path',                  { httpMethod: 'PUT', path: '/api/admin/preorder-codes/ABC23456/extra', body: '{}' }],
    ['a lookalike path',               { path: '/api/admin/preorder-codes-export' }],
  ])('404s %s and touches nothing', async (_label, overrides) => {
    mockDbSend.mockReset();

    const res = await handleAdminPreorder(makeEvent(overrides), 'Admin');

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('threads the actor through to createdBy and updatedBy', async () => {
    stageCreate();
    await handleAdminPreorder(postEvent(createBody()), 'Mei Yii');
    expect(written().createdBy).toBe('Mei Yii');

    stageRecord(codeRecord());
    await handleAdminPreorder(putEvent('ABC23456', { isActive: false }), 'Sarah');
    expect(updates()[0].ExpressionAttributeValues[':ub']).toBe('Sarah');
  });
});

describe('handleAdminPreorder — the catch-all envelope', () => {
  it("surfaces a failed read as 500 with the error's message", async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));

    const res = await handleAdminPreorder(makeEvent(), 'Admin');

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'ProvisionedThroughputExceeded' });
  });

  it("falls back to 'Internal error' when the thrown value is not an Error", async () => {
    mockDbSend.mockReset();
    mockDbSend.mockRejectedValue('a bare string');

    const res = await handleAdminPreorder(makeEvent(), 'Admin');

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal error' });
  });

  it('catches a failure on each write route', async () => {
    for (const event of [
      postEvent(createBody()),
      putEvent('ABC23456', { isActive: false }),
      deleteEvent('ABC23456'),
      deleteEvent('ABC23456', { hard: '1' }),
    ]) {
      mockDbSend.mockReset();
      mockDbSend.mockRejectedValue(new Error('boom'));
      const res = await handleAdminPreorder(event, 'Admin');
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'boom' });
    }
  });

  /**
   * Minor observation: a malformed JSON body reaches the catch as a `SyntaxError`
   * and surfaces as 500 with the parser's message, where 400 would be the honest
   * answer for a client error. Recorded rather than asserted as correct; the
   * important half is that nothing was written.
   */
  it('answers 500 (not 400) for a malformed JSON body, and writes nothing', async () => {
    stageCreate();

    const res = await handleAdminPreorder(postEvent('{"name": '), 'Admin');

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });

  it('treats a null body as an empty object rather than throwing', async () => {
    stageCreate();
    const res = await handleAdminPreorder(postEvent(null), 'Admin');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'name is required' });

    // Same on the update path, which parses its own body.
    stageRecord(codeRecord());
    const put = await handleAdminPreorder(putEvent('ABC23456', null), 'Admin');
    expect(put.statusCode).toBe(400);
    expect(JSON.parse(put.body)).toEqual({ error: 'No fields to update' });
    expect(updates()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// optionKey — the gaps left by preorder-excluded-options.test.ts
// ══════════════════════════════════════════════════════════════════════════════

/**
 * That suite owns the main contract (trimming, dropping half-formed keys,
 * de-duplication, non-array input, an option name containing a colon). Only the
 * cases it does not reach are added here, so there is one owner per behaviour.
 */
describe('optionKey / normalizeExcludedOptions — remaining edges', () => {
  it('coerces null and undefined halves to empty strings', async () => {
    expect(optionKey(null, undefined)).toBe(':');
    expect(optionKey(undefined, 'Oat Milk')).toBe(':Oat Milk');
    expect(optionKey('Milk', null)).toBe('Milk:');
  });

  it('coerces non-string halves rather than throwing', async () => {
    expect(optionKey(7, true)).toBe('7:true');
  });

  it('drops an entry whose halves are only whitespace', async () => {
    // Trimmed to nothing, so it would never match any variant.
    expect(normalizeExcludedOptions(['  :  ', ' :Oat Milk', 'Milk: '])).toEqual([]);
  });

  it('ignores non-string entries mixed in with good ones', async () => {
    expect(normalizeExcludedOptions([7, null, undefined, {}, ['Milk:Oat Milk'], 'Milk:Oat Milk']))
      .toEqual(['Milk:Oat Milk']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
