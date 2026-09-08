/**
 * Vouchers — `backend/src/routes/vouchers.ts`, admin campaign management and the
 * POS redeem/void path. The largest route file in the backend that had no suite
 * of its own (2.71% covered, all of it incidental).
 *
 * What is load-bearing here, and therefore what this file pins:
 *
 *  1. **The redeem is atomic.** The voucher flip and the order create go out in
 *     ONE `TransactWriteCommand`, with a `ConditionExpression` on each half. A
 *     `TransactionCanceledException` must surface as a `409`, never a `500` and
 *     never a half-write — a voucher marked REDEEMED with no order is a customer
 *     who paid nothing and got nothing.
 *  2. **Voucher type gates the categories.** FREE_DRINK is one DRINK, FREE_FOOD
 *     one FOOD, FREE_COMBO exactly one of each. Both request shapes reach the
 *     same gate: the preferred `items[]` and the legacy single `menuItemId`.
 *  3. **A REDEEMED voucher can never be revoked** (409), because revoke deletes
 *     the record and the order would then reference nothing.
 *  4. **Expiry is derived, never written back.** `lookupByPhone` splits eligible
 *     from past and reports `displayStatus: 'EXPIRED'` without a write.
 *
 * Every assertion is on what the HANDLER produced — the parsed response body, or
 * the `Item` / `Key` / `UpdateExpression` / `TransactItems` of the command it
 * built. Never on the fixture the test itself constructed.
 *
 * Fully offline. `../src/lib/db` is the only DynamoDB client in the backend and
 * it is mocked; nothing is written to production, no credentials are read, so no
 * `ZZTEST_` marker applies (that rule covers suites that create real records).
 */

import { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbSend = jest.fn();

jest.mock('../src/lib/db', () => ({
  docClient: { send: mockDbSend },
  ORDERS_TABLE: 'test-orders',
  MENU_TABLE: 'test-menu',
  SETTINGS_TABLE: 'test-settings',
  INGREDIENTS_TABLE: 'test-ingredients',
  USERS_TABLE: 'test-users',
  CUSTOMERS_TABLE: 'test-customers',
  VOUCHERS_TABLE: 'test-vouchers',
  GetCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Get' })),
  PutCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Put' })),
  QueryCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Query' })),
  ScanCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Scan' })),
  UpdateCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Update' })),
  DeleteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'Delete' })),
  TransactWriteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'TransactWrite' })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleVouchers } = require('../src/routes/vouchers');

const VOUCHERS = 'test-vouchers';
const ORDERS = 'test-orders';
const MENU = 'test-menu';
const GSI = 'campaignId-issuedAt-index';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PHONE = '0168089999';

function campaign(overrides: Record<string, any> = {}) {
  return {
    PK: 'CAMPAIGN#c1', SK: 'META',
    campaignId: 'c1', name: 'Welcome Sunday', description: '',
    voucherType: 'FREE_DRINK', expiryMode: 'DAYS_FROM_ISSUE', expiryDays: 30,
    status: 'ACTIVE', issuedCount: 0, redeemedCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'Admin',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Far future / far past epochs, so nothing here depends on the wall clock. */
const FUTURE_EPOCH = Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000);
const PAST_EPOCH = Math.floor(Date.parse('2000-01-01T00:00:00.000Z') / 1000);

function voucher(overrides: Record<string, any> = {}) {
  return {
    PK: `VOUCHER#${PHONE}`, SK: 'VOUCHER#v1',
    voucherId: 'v1', campaignId: 'c1', campaignName: 'Welcome Sunday',
    phone: PHONE, voucherType: 'FREE_DRINK', status: 'ISSUED',
    issuedAt: '2026-08-01T00:00:00.000Z', issuedBy: 'Admin',
    expiresAt: '2099-01-01T00:00:00.000Z', expiresAtEpoch: FUTURE_EPOCH,
    ...overrides,
  };
}

const LATTE = {
  PK: 'MENU#latte-001', SK: 'META', menuItemId: 'latte-001', name: 'Latte',
  category: 'DRINK', basePrice: 8, isActive: true,
};
const COOKIE = {
  PK: 'MENU#cookie-001', SK: 'META', menuItemId: 'cookie-001', name: 'Cookie',
  category: 'FOOD', basePrice: 3, isActive: true,
};

function voucherOrder(overrides: Record<string, any> = {}) {
  return {
    PK: 'ORDER#o1', SK: 'META', orderId: 'o1',
    customerName: 'Mei Yii', discountType: 'VOUCHER', status: 'PREPARING',
    items: [{ menuItemId: 'latte-001', name: 'Latte', quantity: 1, unitPrice: 0, category: 'DRINK' }],
    totalAmount: 0, discountOffset: 8,
    ...overrides,
  };
}

// ─── The world ────────────────────────────────────────────────────────────────

interface World {
  campaigns?: Record<string, any>;
  /** Every voucher record in the table; queries filter it the way DynamoDB would. */
  vouchers?: any[];
  menu?: Record<string, any>;
  orders?: Record<string, any>;
  /** Return a bare `{}` (no `Items` key) from Query/Scan — the real SDK does. */
  bareResults?: boolean;
  /** Thrown from `docClient.send` for any command this returns an Error for. */
  failOn?: (cmd: any) => Error | null;
}

/**
 * Answer every read from a described world, keyed on the `TableName`, `IndexName`
 * and command the handler actually asked for — not a `mockResolvedValueOnce`
 * queue, which would let a fixture silently fill the wrong slot when a handler
 * issues several reads (`invariants`, Test teeth). `redeemVoucher` alone issues a
 * voucher Get plus one menu Get per requested item.
 */
function stage(world: World = {}) {
  mockDbSend.mockReset();
  mockDbSend.mockImplementation(async (cmd: any) => {
    const boom = world.failOn?.(cmd);
    if (boom) throw boom;

    if (cmd.__cmd === 'Get' && cmd.TableName === VOUCHERS) {
      const pk = String(cmd.Key?.PK || '');
      const sk = String(cmd.Key?.SK || '');
      if (sk === 'META') {
        const rec = world.campaigns?.[pk.replace('CAMPAIGN#', '')];
        return rec ? { Item: rec } : {};
      }
      const rec = (world.vouchers || []).find(
        (v) => `VOUCHER#${v.phone}` === pk && `VOUCHER#${v.voucherId}` === sk,
      );
      return rec ? { Item: rec } : {};
    }

    if (cmd.__cmd === 'Get' && cmd.TableName === MENU) {
      const rec = world.menu?.[String(cmd.Key?.PK || '')];
      return rec ? { Item: rec } : {};
    }

    if (cmd.__cmd === 'Get' && cmd.TableName === ORDERS) {
      const rec = world.orders?.[String(cmd.Key?.PK || '')];
      return rec ? { Item: rec } : {};
    }

    if (cmd.__cmd === 'Query' && cmd.IndexName === GSI) {
      if (world.bareResults) return {};
      const cid = cmd.ExpressionAttributeValues[':cid'];
      return { Items: (world.vouchers || []).filter((v) => v.campaignId === cid) };
    }

    if (cmd.__cmd === 'Query' && cmd.TableName === VOUCHERS) {
      if (world.bareResults) return {};
      const pk = cmd.ExpressionAttributeValues[':pk'];
      let items = (world.vouchers || []).filter((v) => `VOUCHER#${v.phone}` === pk);
      // `hasActiveVoucherInCampaign` pushes its narrowing into a FilterExpression,
      // which DynamoDB applies server-side — so the mock has to apply it too.
      const cid = cmd.ExpressionAttributeValues[':cid'];
      if (cid !== undefined) {
        items = items.filter((v) => v.campaignId === cid && v.status === 'ISSUED');
      }
      return { Items: items };
    }

    if (cmd.__cmd === 'Scan') {
      if (world.bareResults) return {};
      return { Items: Object.values(world.campaigns || {}) };
    }

    return {};
  });
}

function makeEvent(overrides: Record<string, any> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET', path: '/api/admin/vouchers/campaigns', body: null,
    headers: {}, multiValueHeaders: {}, isBase64Encoded: false,
    pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null,
    requestContext: {} as any, resource: '',
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function cmds() { return mockDbSend.mock.calls.map((c) => c[0]); }
function puts() { return cmds().filter((c) => c.__cmd === 'Put'); }
function updates() { return cmds().filter((c) => c.__cmd === 'Update'); }
function deletes() { return cmds().filter((c) => c.__cmd === 'Delete'); }
function transacts() { return cmds().filter((c) => c.__cmd === 'TransactWrite'); }
function writes() { return cmds().filter((c) => ['Put', 'Update', 'Delete', 'TransactWrite'].includes(c.__cmd)); }

/** Call the handler and return `[statusCode, parsedBody]`. */
async function call(event: APIGatewayProxyEvent, actor = 'Admin'): Promise<[number, any]> {
  const res = await handleVouchers(event, actor);
  expect(res.headers).toEqual({ 'Content-Type': 'application/json' });
  return [res.statusCode, JSON.parse(res.body)];
}

beforeEach(() => { stage(); });

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/admin/vouchers/campaigns — createCampaign
// ══════════════════════════════════════════════════════════════════════════════

const CAMPAIGNS_PATH = '/api/admin/vouchers/campaigns';

function createEvent(body: unknown) {
  return makeEvent({ httpMethod: 'POST', path: CAMPAIGNS_PATH, body: JSON.stringify(body) });
}

describe('POST /admin/vouchers/campaigns — createCampaign', () => {
  it('creates a DAYS_FROM_ISSUE campaign and writes the full record', async () => {
    const [code, body] = await call(createEvent({
      name: 'Welcome Sunday', type: 'FREE_DRINK',
      expiryMode: 'DAYS_FROM_ISSUE', expiryValue: 30,
      description: 'For first-time visitors',
    }), 'Mei Yii');

    expect(code).toBe(201);
    const item = puts()[0].Item;
    expect(puts()[0].TableName).toBe(VOUCHERS);
    expect(item.PK).toBe(`CAMPAIGN#${item.campaignId}`);
    expect(item.SK).toBe('META');
    expect(item.campaignId).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.voucherType).toBe('FREE_DRINK');   // `type` in, `voucherType` stored
    expect(item.expiryMode).toBe('DAYS_FROM_ISSUE');
    expect(item.expiryDays).toBe(30);
    expect(item.expiryDate).toBeUndefined();       // only one of the two is stored
    expect(item.status).toBe('ACTIVE');
    expect(item.issuedCount).toBe(0);
    expect(item.redeemedCount).toBe(0);
    expect(item.createdBy).toBe('Mei Yii');        // the actor, not the body
    expect(item.description).toBe('For first-time visitors');
    expect(item.createdAt).toBe(item.updatedAt);
    // The 201 body IS the stored item, so the admin list can render it unrefreshed.
    expect(body).toEqual(item);
  });

  it('creates a FIXED_DATE campaign, normalising expiryValue to an ISO instant', async () => {
    const [code, body] = await call(createEvent({
      name: 'Christmas', type: 'FREE_COMBO',
      expiryMode: 'FIXED_DATE', expiryValue: '2099-12-25',
    }));

    expect(code).toBe(201);
    expect(body.expiryDate).toBe('2099-12-25T00:00:00.000Z');
    expect(body.expiryDays).toBeUndefined();
    expect(body.voucherType).toBe('FREE_COMBO');
  });

  it('defaults description to an empty string when it is absent or not a string', async () => {
    await call(createEvent({ name: 'A', type: 'FREE_FOOD', expiryMode: 'DAYS_FROM_ISSUE', expiryValue: 1 }));
    expect(puts()[0].Item.description).toBe('');

    stage();
    await call(createEvent({ name: 'A', type: 'FREE_FOOD', expiryMode: 'DAYS_FROM_ISSUE', expiryValue: 1, description: 42 }));
    expect(puts()[0].Item.description).toBe('');
  });

  it('treats a missing body as an empty object', async () => {
    const [code, body] = await call(makeEvent({ httpMethod: 'POST', path: CAMPAIGNS_PATH, body: null }));
    expect(code).toBe(400);
    expect(body.error).toBe('name required');
  });

  it.each([
    ['no name', {}, 'name required'],
    ['a non-string name', { name: 7 }, 'name required'],
    ['no type', { name: 'A' }, 'type must be FREE_DRINK, FREE_FOOD, or FREE_COMBO'],
    ['an unknown type', { name: 'A', type: 'FREE_CAKE' }, 'type must be FREE_DRINK, FREE_FOOD, or FREE_COMBO'],
    ['a non-string type', { name: 'A', type: 3 }, 'type must be FREE_DRINK, FREE_FOOD, or FREE_COMBO'],
    ['no expiryMode', { name: 'A', type: 'FREE_DRINK' }, 'expiryMode must be DAYS_FROM_ISSUE or FIXED_DATE'],
    ['an unknown expiryMode', { name: 'A', type: 'FREE_DRINK', expiryMode: 'NEVER' }, 'expiryMode must be DAYS_FROM_ISSUE or FIXED_DATE'],
    ['a fractional expiryValue', { name: 'A', type: 'FREE_DRINK', expiryMode: 'DAYS_FROM_ISSUE', expiryValue: 1.5 }, 'expiryValue must be a positive integer (days)'],
    ['a zero expiryValue', { name: 'A', type: 'FREE_DRINK', expiryMode: 'DAYS_FROM_ISSUE', expiryValue: 0 }, 'expiryValue must be a positive integer (days)'],
    ['a negative expiryValue', { name: 'A', type: 'FREE_DRINK', expiryMode: 'DAYS_FROM_ISSUE', expiryValue: -5 }, 'expiryValue must be a positive integer (days)'],
    ['expiryValue over ten years', { name: 'A', type: 'FREE_DRINK', expiryMode: 'DAYS_FROM_ISSUE', expiryValue: 3651 }, 'expiryValue must be a positive integer (days)'],
    ['a non-numeric expiryValue', { name: 'A', type: 'FREE_DRINK', expiryMode: 'DAYS_FROM_ISSUE', expiryValue: 'thirty' }, 'expiryValue must be a positive integer (days)'],
    ['a non-string FIXED_DATE value', { name: 'A', type: 'FREE_DRINK', expiryMode: 'FIXED_DATE', expiryValue: 20991225 }, 'expiryValue must be ISO date string'],
    ['an unparseable FIXED_DATE value', { name: 'A', type: 'FREE_DRINK', expiryMode: 'FIXED_DATE', expiryValue: 'next Christmas' }, 'expiryValue is not a valid ISO date'],
    ['a FIXED_DATE in the past', { name: 'A', type: 'FREE_DRINK', expiryMode: 'FIXED_DATE', expiryValue: '2000-01-01' }, 'expiryValue must be in the future'],
  ])('rejects %s with 400 and writes NOTHING', async (_name, body, expected) => {
    const [code, parsed] = await call(createEvent(body));
    expect(code).toBe(400);
    expect(parsed).toEqual({ error: expected });
    // "No error thrown" is not an assertion — validation sits before the Put.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('accepts the boundary expiryValue of 3650 days', async () => {
    const [code, body] = await call(createEvent({
      name: 'A', type: 'FREE_DRINK', expiryMode: 'DAYS_FROM_ISSUE', expiryValue: 3650,
    }));
    expect(code).toBe(201);
    expect(body.expiryDays).toBe(3650);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/vouchers/campaigns — listCampaigns
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /admin/vouchers/campaigns — listCampaigns', () => {
  it('scans the CAMPAIGN# prefix and returns newest first', async () => {
    stage({
      campaigns: {
        old: campaign({ campaignId: 'old', name: 'Old', createdAt: '2026-01-01T00:00:00.000Z' }),
        new: campaign({ campaignId: 'new', name: 'New', createdAt: '2026-08-01T00:00:00.000Z' }),
      },
    });

    const [code, body] = await call(makeEvent({ httpMethod: 'GET', path: CAMPAIGNS_PATH }));

    expect(code).toBe(200);
    expect(body.campaigns.map((c: any) => c.campaignId)).toEqual(['new', 'old']);
    const scan = cmds()[0];
    expect(scan.__cmd).toBe('Scan');
    expect(scan.TableName).toBe(VOUCHERS);
    expect(scan.ExpressionAttributeValues).toEqual({ ':pk': 'CAMPAIGN#', ':sk': 'META' });
  });

  it('sorts a record with no createdAt last instead of throwing', async () => {
    const { createdAt, ...noDate } = campaign({ campaignId: 'nodate' });
    stage({ campaigns: { nodate: noDate, dated: campaign({ campaignId: 'dated' }) } });

    const [, body] = await call(makeEvent({ httpMethod: 'GET', path: CAMPAIGNS_PATH }));
    expect(body.campaigns.map((c: any) => c.campaignId)).toEqual(['dated', 'nodate']);
  });

  it('sorts a dateless record last from EITHER side of the comparator', async () => {
    // The comparator falls back on both operands, and which one it sees first
    // depends on the scan order — so both orientations have to be staged.
    const { createdAt, ...noDate } = campaign({ campaignId: 'nodate' });
    stage({
      campaigns: {
        early: campaign({ campaignId: 'early', createdAt: '2026-01-01T00:00:00.000Z' }),
        nodate: noDate,
        late: campaign({ campaignId: 'late', createdAt: '2026-09-01T00:00:00.000Z' }),
      },
    });
    const [, body] = await call(makeEvent({ httpMethod: 'GET', path: CAMPAIGNS_PATH }));
    expect(body.campaigns.map((c: any) => c.campaignId)).toEqual(['late', 'early', 'nodate']);
  });

  it('returns an empty array when the Scan comes back with no Items key', async () => {
    stage({ bareResults: true });
    const [code, body] = await call(makeEvent({ httpMethod: 'GET', path: CAMPAIGNS_PATH }));
    expect(code).toBe(200);
    expect(body).toEqual({ campaigns: [] });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/vouchers/campaigns/{id} — getCampaignDetail
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /admin/vouchers/campaigns/{id} — getCampaignDetail', () => {
  const detailEvent = () => makeEvent({ httpMethod: 'GET', path: `${CAMPAIGNS_PATH}/c1` });

  it('counts LIVE from the GSI rather than trusting the cached counters', async () => {
    // The cached counters are deliberately wrong here: the whole point of the GSI
    // query is that a revoke or a TTL can leave `issuedCount` stale.
    stage({
      campaigns: { c1: campaign({ issuedCount: 999, redeemedCount: 999 }) },
      vouchers: [
        voucher({ voucherId: 'a', status: 'ISSUED', expiresAtEpoch: FUTURE_EPOCH }),
        voucher({ voucherId: 'b', status: 'ISSUED', expiresAtEpoch: FUTURE_EPOCH }),
        voucher({ voucherId: 'c', status: 'REDEEMED', expiresAtEpoch: FUTURE_EPOCH }),
        voucher({ voucherId: 'd', status: 'ISSUED', expiresAtEpoch: PAST_EPOCH }),
        // No expiresAtEpoch at all — counts as expired, never as issued.
        voucher({ voucherId: 'e', status: 'ISSUED', expiresAtEpoch: undefined }),
        // A different campaign: the GSI key must exclude it.
        voucher({ voucherId: 'f', campaignId: 'other', status: 'ISSUED' }),
      ],
    });

    const [code, body] = await call(detailEvent());

    expect(code).toBe(200);
    expect(body.stats).toEqual({ total: 5, issued: 2, redeemed: 1, expired: 2 });
    expect(body.vouchers).toHaveLength(5);
    expect(body.campaign.campaignId).toBe('c1');

    const q = cmds().find((c) => c.__cmd === 'Query');
    expect(q.IndexName).toBe(GSI);
    expect(q.ExpressionAttributeValues).toEqual({ ':cid': 'c1' });
  });

  it('404s for an unknown campaign without querying the GSI', async () => {
    stage({ campaigns: {} });
    const [code, body] = await call(detailEvent());
    expect(code).toBe(404);
    expect(body).toEqual({ error: 'Campaign not found' });
    expect(cmds().filter((c) => c.__cmd === 'Query')).toHaveLength(0);
  });

  it('reports zeroes when the GSI query returns no Items key', async () => {
    stage({ campaigns: { c1: campaign() }, bareResults: true });
    const [, body] = await call(detailEvent());
    expect(body.stats).toEqual({ total: 0, issued: 0, redeemed: 0, expired: 0 });
    expect(body.vouchers).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/admin/vouchers/campaigns/{id}/assign — single assign
// ══════════════════════════════════════════════════════════════════════════════

function assignEvent(body: unknown, query: Record<string, string> | null = null) {
  return makeEvent({
    httpMethod: 'POST', path: `${CAMPAIGNS_PATH}/c1/assign`,
    body: JSON.stringify(body), queryStringParameters: query,
  });
}

describe('POST /admin/vouchers/campaigns/{id}/assign — single assign', () => {
  it('issues one voucher, keyed on the NORMALISED phone, and bumps the counter', async () => {
    stage({ campaigns: { c1: campaign() } });

    const [code, body] = await call(assignEvent({ phone: '+60 16-808 9999', name: 'Mei Yii', note: 'front row' }), 'Sarah');

    expect(code).toBe(201);
    expect(body.issued).toBe(1);
    expect(body.skipped).toEqual([]);

    const item = puts()[0].Item;
    expect(puts()[0].TableName).toBe(VOUCHERS);
    // Normalisation is the assertion: a voucher keyed on the raw string is
    // unfindable by `lookupByPhone`, which normalises before it queries.
    expect(item.PK).toBe(`VOUCHER#${PHONE}`);
    expect(item.phone).toBe(PHONE);
    expect(item.SK).toBe(`VOUCHER#${item.voucherId}`);
    expect(body.voucherId).toBe(item.voucherId);
    expect(item.status).toBe('ISSUED');
    expect(item.issuedBy).toBe('Sarah');
    expect(item.name).toBe('Mei Yii');
    expect(item.note).toBe('front row');
    // The campaign snapshot, so the POS can render without a second read.
    expect(item.campaignId).toBe('c1');
    expect(item.campaignName).toBe('Welcome Sunday');
    expect(item.voucherType).toBe('FREE_DRINK');
    // epoch and ISO must agree — the epoch is the TTL/eligibility field.
    expect(item.expiresAtEpoch).toBe(Math.floor(Date.parse(item.expiresAt) / 1000));

    const bump = updates()[0];
    expect(bump.Key).toEqual({ PK: 'CAMPAIGN#c1', SK: 'META' });
    expect(bump.UpdateExpression).toBe('ADD issuedCount :d SET updatedAt = :now');
    expect(bump.ExpressionAttributeValues[':d']).toBe(1);
  });

  it('omits name and note entirely when they are not supplied', async () => {
    stage({ campaigns: { c1: campaign() } });
    const [code] = await call(assignEvent({ phone: PHONE }));
    expect(code).toBe(201);
    const item = puts()[0].Item;
    expect('name' in item).toBe(false);
    expect('note' in item).toBe(false);
  });

  it('derives expiresAt from a DAYS_FROM_ISSUE campaign', async () => {
    stage({ campaigns: { c1: campaign({ expiryDays: 10 }) } });
    const before = Date.now();
    await call(assignEvent({ phone: PHONE }));
    const item = puts()[0].Item;
    const delta = Date.parse(item.expiresAt) - before;
    expect(delta).toBeGreaterThanOrEqual(10 * 86400 * 1000 - 5000);
    expect(delta).toBeLessThanOrEqual(10 * 86400 * 1000 + 5000);
  });

  it('treats a DAYS_FROM_ISSUE campaign with no expiryDays as expiring immediately', async () => {
    // Not reachable through `createCampaign` (it demands a positive integer), but
    // a hand-edited or half-migrated record hits the `|| 0` fallback, and the
    // voucher must not come out with an `Invalid Date`.
    const { expiryDays, ...noDays } = campaign();
    stage({ campaigns: { c1: noDays } });
    await call(assignEvent({ phone: PHONE }));
    const item = puts()[0].Item;
    expect(Number.isNaN(Date.parse(item.expiresAt))).toBe(false);
    expect(Math.abs(Date.parse(item.expiresAt) - Date.now())).toBeLessThan(5000);
  });

  it('takes expiresAt verbatim from a FIXED_DATE campaign', async () => {
    stage({ campaigns: { c1: campaign({ expiryMode: 'FIXED_DATE', expiryDate: '2099-12-25T00:00:00.000Z', expiryDays: undefined }) } });
    await call(assignEvent({ phone: PHONE }));
    const item = puts()[0].Item;
    expect(item.expiresAt).toBe('2099-12-25T00:00:00.000Z');
    expect(item.expiresAtEpoch).toBe(Math.floor(Date.parse('2099-12-25T00:00:00.000Z') / 1000));
  });

  it('refuses a duplicate: one unredeemed voucher per phone per campaign', async () => {
    stage({
      campaigns: { c1: campaign() },
      vouchers: [voucher({ voucherId: 'existing', status: 'ISSUED' })],
    });

    const [code, body] = await call(assignEvent({ phone: PHONE }));

    expect(code).toBe(400);
    expect(body.error).toBe('duplicate');
    expect(body.skipped).toEqual([{ phone: PHONE, reason: 'duplicate' }]);
    // The teeth: nothing was written, and the counter was not bumped either.
    expect(writes()).toHaveLength(0);
  });

  it('a REDEEMED voucher is not a duplicate — the FilterExpression names ISSUED', async () => {
    stage({
      campaigns: { c1: campaign() },
      vouchers: [voucher({ voucherId: 'spent', status: 'REDEEMED' })],
    });
    const [code] = await call(assignEvent({ phone: PHONE }));
    expect(code).toBe(201);

    const dupQuery = cmds().find((c) => c.__cmd === 'Query');
    expect(dupQuery.ExpressionAttributeValues[':issued']).toBe('ISSUED');
    expect(dupQuery.ExpressionAttributeValues[':cid']).toBe('c1');
    expect(dupQuery.ExpressionAttributeNames).toEqual({ '#s': 'status' });
  });

  it('?allowDuplicates=true issues a second voucher WITHOUT the duplicate query', async () => {
    stage({
      campaigns: { c1: campaign() },
      vouchers: [voucher({ voucherId: 'existing', status: 'ISSUED' })],
    });

    const [code, body] = await call(assignEvent({ phone: PHONE }, { allowDuplicates: 'true' }));

    expect(code).toBe(201);
    expect(body.issued).toBe(1);
    // The flag skips the check entirely; a query issued anyway would be a
    // needless read and would prove the branch had not been taken.
    expect(cmds().filter((c) => c.__cmd === 'Query')).toHaveLength(0);
    expect(puts()).toHaveLength(1);
  });

  it('any other allowDuplicates value keeps the check on (exact "true" only)', async () => {
    stage({
      campaigns: { c1: campaign() },
      vouchers: [voucher({ voucherId: 'existing', status: 'ISSUED' })],
    });
    const [code] = await call(assignEvent({ phone: PHONE }, { allowDuplicates: '1' }));
    expect(code).toBe(400);
    expect(writes()).toHaveLength(0);
  });

  it('skips an unnormalisable phone as invalid_phone and reports the RAW input', async () => {
    stage({ campaigns: { c1: campaign() } });
    const [code, body] = await call(assignEvent({ phone: '123' }));
    expect(code).toBe(400);
    expect(body.error).toBe('invalid_phone');
    // The raw value, so the admin can see what they typed.
    expect(body.skipped).toEqual([{ phone: '123', reason: 'invalid_phone' }]);
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['no phone', {}],
    ['an empty phone', { phone: '' }],
    ['a non-string phone', { phone: 60168089999 }],
  ])('rejects %s with 400 before reading the campaign', async (_n, body) => {
    stage({ campaigns: { c1: campaign() } });
    const [code, parsed] = await call(assignEvent(body));
    expect(code).toBe(400);
    expect(parsed).toEqual({ error: 'phone required' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('treats a null body as an empty object', async () => {
    stage({ campaigns: { c1: campaign() } });
    const [code, body] = await call(makeEvent({
      httpMethod: 'POST', path: `${CAMPAIGNS_PATH}/c1/assign`, body: null,
    }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'phone required' });
  });

  it('404s for an unknown campaign', async () => {
    stage({ campaigns: {} });
    const [code, body] = await call(assignEvent({ phone: PHONE }));
    expect(code).toBe(404);
    expect(body).toEqual({ error: 'Campaign not found' });
    expect(writes()).toHaveLength(0);
  });

  it('400s on a campaign that is not ACTIVE, with the menu of the phone valid', async () => {
    stage({ campaigns: { c1: campaign({ status: 'ARCHIVED' }) } });
    const [code, body] = await call(assignEvent({ phone: PHONE }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'Campaign is not active' });
    // A valid phone against a valid campaign id: if the status guard were
    // removed this request would issue a real voucher, so the absence of the
    // write is what pins the guard.
    expect(writes()).toHaveLength(0);
  });

  it('still returns 201 when the best-effort counter bump fails', async () => {
    // The live count comes from the GSI, so a failed counter must not lose the
    // voucher that was already written.
    stage({
      campaigns: { c1: campaign() },
      failOn: (c) => (c.__cmd === 'Update' ? new Error('throttled') : null),
    });
    const [code, body] = await call(assignEvent({ phone: PHONE }));
    expect(code).toBe(201);
    expect(body.issued).toBe(1);
    expect(puts()).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/admin/vouchers/campaigns/{id}/assign-csv — bulk assign
// ══════════════════════════════════════════════════════════════════════════════

function csvEvent(body: unknown, query: Record<string, string> | null = null) {
  return makeEvent({
    httpMethod: 'POST', path: `${CAMPAIGNS_PATH}/c1/assign-csv`,
    body: JSON.stringify(body), queryStringParameters: query,
  });
}

describe('POST /admin/vouchers/campaigns/{id}/assign-csv', () => {
  it('parses a plain-text CSV, honours the header order, and skips blanks and comments', async () => {
    stage({ campaigns: { c1: campaign() } });

    const csv = [
      '# Sunday welcome list',
      'note,phone,name',        // deliberately NOT the documented column order
      '',
      'front row,016 808 9999,Mei Yii',
      'back,0129990001,Ah Kim',
    ].join('\n');

    const [code, body] = await call(csvEvent({ csv }), 'Sarah');

    expect(code).toBe(200);
    expect(body.campaignId).toBe('c1');
    expect(body.issued).toBe(2);
    expect(body.skipped).toEqual([]);

    const items = puts().map((p) => p.Item);
    expect(items.map((i) => i.phone)).toEqual([PHONE, '0129990001']);
    expect(items.map((i) => i.name)).toEqual(['Mei Yii', 'Ah Kim']);
    expect(items.map((i) => i.note)).toEqual(['front row', 'back']);
    // One counter bump for the whole batch, not one per row.
    expect(updates()).toHaveLength(1);
    expect(updates()[0].ExpressionAttributeValues[':d']).toBe(2);
  });

  it('falls back to base64 when the payload has neither a comma nor a newline', async () => {
    stage({ campaigns: { c1: campaign() } });
    const csv = Buffer.from('phone,name\n0168089999,Mei Yii', 'utf-8').toString('base64');
    expect(csv).not.toContain(',');

    const [code, body] = await call(csvEvent({ csv }));

    expect(code).toBe(200);
    expect(body.issued).toBe(1);
    expect(puts()[0].Item.phone).toBe(PHONE);
    expect(puts()[0].Item.name).toBe('Mei Yii');
  });

  it('tolerates a row shorter than the header — the missing cells read as empty', async () => {
    stage({ campaigns: { c1: campaign() } });
    // Header declares three columns; the row supplies only the phone.
    const [code, body] = await call(csvEvent({ csv: 'phone,name,note\n0168089999' }));
    expect(code).toBe(200);
    expect(body.issued).toBe(1);
    const item = puts()[0].Item;
    expect(item.phone).toBe(PHONE);
    // Empty rather than `undefined`, so the optional attributes stay unwritten.
    expect('name' in item).toBe(false);
    expect('note' in item).toBe(false);
  });

  it('treats a null body as an empty object', async () => {
    stage({ campaigns: { c1: campaign() } });
    const [code, body] = await call(makeEvent({
      httpMethod: 'POST', path: `${CAMPAIGNS_PATH}/c1/assign-csv`, body: null,
    }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'csv field (string) required in body' });
  });

  it('leaves name and note empty when the header omits those columns', async () => {
    stage({ campaigns: { c1: campaign() } });
    // A single-column CSV has a newline but no comma — so it must NOT be treated
    // as base64 either.
    const [code, body] = await call(csvEvent({ csv: 'phone\n0168089999' }));
    expect(code).toBe(200);
    expect(body.issued).toBe(1);
    const item = puts()[0].Item;
    expect('name' in item).toBe(false);
    expect('note' in item).toBe(false);
  });

  it('reports a row with an empty phone cell as missing_phone, with its line number', async () => {
    stage({ campaigns: { c1: campaign() } });
    const csv = 'phone,name\n,Nameless\n0168089999,Mei Yii';

    const [code, body] = await call(csvEvent({ csv }));

    expect(code).toBe(200);
    expect(body.issued).toBe(1);
    expect(body.skipped).toEqual([{ row: 2, phone: '', reason: 'missing_phone' }]);
    expect(puts()).toHaveLength(1);
  });

  it('reports per-row invalid_phone and duplicate reasons alongside the successes', async () => {
    stage({
      campaigns: { c1: campaign() },
      vouchers: [voucher({ voucherId: 'existing', phone: '0129990001', status: 'ISSUED' })],
    });
    const csv = [
      'phone,name',
      '123,Too Short',
      '0129990001,Already Has One',
      '0168089999,Mei Yii',
    ].join('\n');

    const [code, body] = await call(csvEvent({ csv }));

    expect(code).toBe(200);
    expect(body.issued).toBe(1);
    expect(body.skipped).toEqual([
      { row: 2, phone: '123', reason: 'invalid_phone' },
      { row: 3, phone: '0129990001', reason: 'duplicate' },
    ]);
    expect(puts().map((p) => p.Item.phone)).toEqual([PHONE]);
    expect(updates()[0].ExpressionAttributeValues[':d']).toBe(1);
  });

  it('does not bump the counter when every row was skipped', async () => {
    stage({ campaigns: { c1: campaign() } });
    const [code, body] = await call(csvEvent({ csv: 'phone,name\n123,Bad\n,Empty' }));
    expect(code).toBe(200);
    expect(body.issued).toBe(0);
    expect(body.skipped).toHaveLength(2);
    expect(updates()).toHaveLength(0);
    expect(puts()).toHaveLength(0);
  });

  it('?allowDuplicates=true applies to every row of the batch', async () => {
    stage({
      campaigns: { c1: campaign() },
      vouchers: [voucher({ voucherId: 'existing', status: 'ISSUED' })],
    });
    const [code, body] = await call(csvEvent({ csv: 'phone\n0168089999\n0168089999' }, { allowDuplicates: 'true' }));
    expect(code).toBe(200);
    expect(body.issued).toBe(2);
    expect(cmds().filter((c) => c.__cmd === 'Query')).toHaveLength(0);
  });

  it(`rejects a CSV over the 1000-row cap and issues nothing at all`, async () => {
    stage({ campaigns: { c1: campaign() } });
    const rows = ['phone,name'];
    for (let i = 0; i < 1001; i++) rows.push(`01199000${String(i).padStart(3, '0')},Row ${i}`);

    const [code, body] = await call(csvEvent({ csv: rows.join('\n') }));

    expect(code).toBe(400);
    expect(body).toEqual({ error: 'CSV exceeds maximum 1000 rows' });
    // All-or-nothing: the cap is checked during the parse, before any write.
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('rejects a CSV whose header has no phone column', async () => {
    stage({ campaigns: { c1: campaign() } });
    const [code, body] = await call(csvEvent({ csv: 'mobile,name\n0168089999,Mei Yii' }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'CSV missing required "phone" column' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('accepts an upper-case PHONE header (the header is lower-cased)', async () => {
    stage({ campaigns: { c1: campaign() } });
    const [code, body] = await call(csvEvent({ csv: 'PHONE,Name\n0168089999,Mei Yii' }));
    expect(code).toBe(200);
    expect(body.issued).toBe(1);
    expect(puts()[0].Item.name).toBe('Mei Yii');
  });

  it.each([
    ['a missing csv field', {}],
    ['a non-string csv field', { csv: ['phone', '0168089999'] }],
    ['a null csv field', { csv: null }],
  ])('rejects %s with 400', async (_n, body) => {
    stage({ campaigns: { c1: campaign() } });
    const [code, parsed] = await call(csvEvent(body));
    expect(code).toBe(400);
    expect(parsed).toEqual({ error: 'csv field (string) required in body' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('404s for an unknown campaign, after a successful parse', async () => {
    stage({ campaigns: {} });
    const [code, body] = await call(csvEvent({ csv: 'phone\n0168089999' }));
    expect(code).toBe(404);
    expect(body).toEqual({ error: 'Campaign not found' });
    expect(writes()).toHaveLength(0);
  });

  it('400s on a campaign that is not ACTIVE, with a fully valid CSV staged', async () => {
    stage({ campaigns: { c1: campaign({ status: 'PAUSED' }) } });
    const [code, body] = await call(csvEvent({ csv: 'phone,name\n0168089999,Mei Yii' }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'Campaign is not active' });
    expect(writes()).toHaveLength(0);
  });

  it('parses an empty CSV to zero rows rather than erroring', async () => {
    stage({ campaigns: { c1: campaign() } });
    const [code, body] = await call(csvEvent({ csv: 'phone,name\n' }));
    expect(code).toBe(200);
    expect(body).toEqual({ campaignId: 'c1', issued: 0, skipped: [] });
  });

  it('handles CRLF line endings', async () => {
    stage({ campaigns: { c1: campaign() } });
    const [code, body] = await call(csvEvent({ csv: 'phone,name\r\n0168089999,Mei Yii\r\n' }));
    expect(code).toBe(200);
    expect(body.issued).toBe(1);
    expect(puts()[0].Item.name).toBe('Mei Yii');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/admin/vouchers/{id} — revokeVoucher
// ══════════════════════════════════════════════════════════════════════════════

function revokeEvent(voucherId: string, query: Record<string, string> | null) {
  return makeEvent({
    httpMethod: 'DELETE', path: `/api/admin/vouchers/${voucherId}`,
    queryStringParameters: query,
  });
}

describe('DELETE /admin/vouchers/{id} — revokeVoucher', () => {
  it('deletes the record and decrements the cached issued counter', async () => {
    stage({ vouchers: [voucher()] });

    const [code, body] = await call(revokeEvent('v1', { phone: '+60168089999' }));

    expect(code).toBe(200);
    expect(body).toEqual({ revoked: 'v1' });

    // PK is phone-scoped, so the query param must be normalised the same way
    // the issue path normalised it or the delete silently misses.
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].TableName).toBe(VOUCHERS);
    expect(deletes()[0].Key).toEqual({ PK: `VOUCHER#${PHONE}`, SK: 'VOUCHER#v1' });

    expect(updates()[0].Key).toEqual({ PK: 'CAMPAIGN#c1', SK: 'META' });
    expect(updates()[0].ExpressionAttributeValues[':d']).toBe(-1);
  });

  it('refuses to revoke a REDEEMED voucher with 409 and deletes nothing', async () => {
    // Deleting it would leave the redemption order pointing at nothing, and would
    // also decrement a counter for a voucher that was legitimately spent.
    stage({ vouchers: [voucher({ status: 'REDEEMED', orderId: 'o1' })] });

    const [code, body] = await call(revokeEvent('v1', { phone: PHONE }));

    expect(code).toBe(409);
    expect(body).toEqual({ error: 'Cannot revoke a redeemed voucher' });
    expect(writes()).toHaveLength(0);
  });

  it('404s when no such voucher exists for that phone', async () => {
    stage({ vouchers: [voucher({ voucherId: 'other' })] });
    const [code, body] = await call(revokeEvent('v1', { phone: PHONE }));
    expect(code).toBe(404);
    expect(body).toEqual({ error: 'Voucher not found' });
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['no query string at all', null, 'phone query parameter required'],
    ['an empty phone param', { phone: '' }, 'phone query parameter required'],
    ['no phone key', { campaignId: 'c1' }, 'phone query parameter required'],
    ['an unnormalisable phone', { phone: '123' }, 'invalid phone'],
  ])('rejects %s with 400 and never reads the table', async (_n, query, expected) => {
    stage({ vouchers: [voucher()] });
    const [code, body] = await call(revokeEvent('v1', query as any));
    expect(code).toBe(400);
    expect(body).toEqual({ error: expected });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('still reports 200 when the best-effort counter decrement fails', async () => {
    stage({
      vouchers: [voucher()],
      failOn: (c) => (c.__cmd === 'Update' ? new Error('throttled') : null),
    });
    const [code, body] = await call(revokeEvent('v1', { phone: PHONE }));
    expect(code).toBe(200);
    expect(body).toEqual({ revoked: 'v1' });
    expect(deletes()).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/pos/vouchers/{phone} — lookupByPhone
// ══════════════════════════════════════════════════════════════════════════════

function lookupEvent(phone: string) {
  return makeEvent({ httpMethod: 'GET', path: `/api/pos/vouchers/${phone}` });
}

describe('GET /pos/vouchers/{phone} — lookupByPhone', () => {
  it('splits eligible from past and DERIVES expiry without writing anything back', async () => {
    stage({
      vouchers: [
        voucher({ voucherId: 'soon', status: 'ISSUED', expiresAt: '2099-01-02T00:00:00.000Z', expiresAtEpoch: FUTURE_EPOCH + 86400 }),
        voucher({ voucherId: 'sooner', status: 'ISSUED', expiresAt: '2099-01-01T00:00:00.000Z', expiresAtEpoch: FUTURE_EPOCH }),
        voucher({ voucherId: 'stale', status: 'ISSUED', expiresAt: '2000-01-01T00:00:00.000Z', expiresAtEpoch: PAST_EPOCH, issuedAt: '2026-01-01T00:00:00.000Z' }),
        voucher({ voucherId: 'spent', status: 'REDEEMED', issuedAt: '2026-07-01T00:00:00.000Z', redeemedAt: '2026-07-02T00:00:00.000Z', redeemedBy: 'Sarah', orderId: 'o9', menuItemName: 'Latte', variant: 'Hot' }),
      ],
    });

    const [code, body] = await call(lookupEvent(PHONE));

    expect(code).toBe(200);
    expect(body.phone).toBe(PHONE);
    // Eligible sorted by expiry, soonest first — the cashier should spend the
    // one about to lapse.
    expect(body.eligible.map((v: any) => v.voucherId)).toEqual(['sooner', 'soon']);
    // Past sorted newest-issued first.
    expect(body.past.map((v: any) => v.voucherId)).toEqual(['spent', 'stale']);

    const stale = body.past.find((v: any) => v.voucherId === 'stale');
    expect(stale.status).toBe('ISSUED');          // the stored value is untouched
    expect(stale.displayStatus).toBe('EXPIRED');  // the derived one
    expect(body.past.find((v: any) => v.voucherId === 'spent').displayStatus).toBe('REDEEMED');

    // Derived, not written back — a lookup is a read.
    expect(writes()).toHaveLength(0);
  });

  it('URL-decodes the path segment and normalises it before querying', async () => {
    stage({ vouchers: [voucher()] });
    const [code, body] = await call(lookupEvent(encodeURIComponent('+60 16-808 9999')));
    expect(code).toBe(200);
    expect(body.phone).toBe(PHONE);
    expect(body.eligible).toHaveLength(1);

    const q = cmds()[0];
    expect(q.__cmd).toBe('Query');
    expect(q.ExpressionAttributeValues).toEqual({ ':pk': `VOUCHER#${PHONE}`, ':sk': 'VOUCHER#' });
  });

  it('projects a fixed field set — a raw record is never echoed', async () => {
    stage({
      vouchers: [
        voucher({ note: 'front row', name: 'Mei Yii', issuedBy: 'Admin' }),
        voucher({
          voucherId: 'spent', status: 'REDEEMED', name: 'Ah Kim',
          redeemedAt: '2026-07-02T00:00:00.000Z', redeemedBy: 'Sarah',
          orderId: 'o9', menuItemName: 'Latte', variant: 'Hot', note: 'n',
        }),
      ],
    });
    const [, body] = await call(lookupEvent(PHONE));

    // An ISSUED voucher has no redemption fields, and `JSON.stringify` drops the
    // undefined ones — so the eligible shape is the smaller of the two.
    expect(Object.keys(body.eligible[0]).sort()).toEqual([
      'campaignId', 'campaignName', 'expiresAt', 'expiresAtEpoch', 'issuedAt',
      'name', 'note', 'phone', 'status', 'voucherId', 'voucherType',
    ]);
    // A REDEEMED one carries the redemption snapshot, plus the derived state.
    expect(Object.keys(body.past[0]).sort()).toEqual([
      'campaignId', 'campaignName', 'displayStatus', 'expiresAt', 'expiresAtEpoch',
      'issuedAt', 'menuItemName', 'name', 'note', 'orderId', 'phone', 'redeemedAt',
      'redeemedBy', 'status', 'variant', 'voucherId', 'voucherType',
    ]);
    // PK/SK/issuedBy are internal and must not leak into the POS payload.
    for (const rec of [body.eligible[0], body.past[0]]) {
      expect('PK' in rec).toBe(false);
      expect('SK' in rec).toBe(false);
      expect('issuedBy' in rec).toBe(false);
    }
  });

  it('treats a voucher with no expiresAtEpoch as expired, not eligible', async () => {
    stage({ vouchers: [voucher({ expiresAtEpoch: undefined, expiresAt: undefined })] });
    const [, body] = await call(lookupEvent(PHONE));
    expect(body.eligible).toEqual([]);
    expect(body.past[0].displayStatus).toBe('EXPIRED');
  });

  it('sorts without throwing when expiresAt / issuedAt are absent', async () => {
    stage({
      vouchers: [
        voucher({ voucherId: 'a', expiresAt: undefined, expiresAtEpoch: FUTURE_EPOCH }),
        voucher({ voucherId: 'b', expiresAt: '2099-01-01T00:00:00.000Z', expiresAtEpoch: FUTURE_EPOCH }),
        voucher({ voucherId: 'c', status: 'REDEEMED', issuedAt: undefined }),
        voucher({ voucherId: 'd', status: 'REDEEMED' }),
      ],
    });
    const [code, body] = await call(lookupEvent(PHONE));
    expect(code).toBe(200);
    expect(body.eligible.map((v: any) => v.voucherId)).toEqual(['a', 'b']);
    expect(body.past.map((v: any) => v.voucherId)).toEqual(['d', 'c']);
  });

  it('sorts the same way with the dateless records staged FIRST', async () => {
    // Both sort comparators fall back on both operands; which side the missing
    // value lands on depends on the order DynamoDB returned, so both are staged.
    stage({
      vouchers: [
        voucher({ voucherId: 'b', expiresAt: '2099-01-01T00:00:00.000Z', expiresAtEpoch: FUTURE_EPOCH }),
        voucher({ voucherId: 'c', expiresAt: '2099-06-01T00:00:00.000Z', expiresAtEpoch: FUTURE_EPOCH }),
        voucher({ voucherId: 'a', expiresAt: undefined, expiresAtEpoch: FUTURE_EPOCH }),
        voucher({ voucherId: 'y', status: 'REDEEMED', issuedAt: '2026-07-01T00:00:00.000Z' }),
        voucher({ voucherId: 'z', status: 'REDEEMED', issuedAt: '2026-06-01T00:00:00.000Z' }),
        voucher({ voucherId: 'x', status: 'REDEEMED', issuedAt: undefined }),
      ],
    });
    const [code, body] = await call(lookupEvent(PHONE));
    expect(code).toBe(200);
    expect(body.eligible.map((v: any) => v.voucherId)).toEqual(['a', 'b', 'c']);
    expect(body.past.map((v: any) => v.voucherId)).toEqual(['y', 'z', 'x']);
  });

  it('returns empty lists when the Query has no Items key', async () => {
    stage({ bareResults: true });
    const [code, body] = await call(lookupEvent(PHONE));
    expect(code).toBe(200);
    expect(body).toEqual({ phone: PHONE, eligible: [], past: [] });
  });

  it('400s on an unnormalisable phone without touching the table', async () => {
    stage();
    const [code, body] = await call(lookupEvent('123'));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'invalid phone' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/pos/vouchers/redeem — redeemVoucher
// ══════════════════════════════════════════════════════════════════════════════

function redeemEvent(body: unknown) {
  return makeEvent({ httpMethod: 'POST', path: '/api/pos/vouchers/redeem', body: JSON.stringify(body) });
}

const MENU_WORLD = { 'MENU#latte-001': LATTE, 'MENU#cookie-001': COOKIE };

/** The two halves of the single atomic write. */
function transactHalves() {
  expect(transacts()).toHaveLength(1);
  const items = transacts()[0].TransactItems;
  expect(items).toHaveLength(2);
  return { flip: items[0].Update, create: items[1].Put };
}

describe('POST /pos/vouchers/redeem — the atomic redeem', () => {
  it('flips the voucher and creates the order in ONE TransactWrite', async () => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });

    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: '+60168089999',
      items: [{ menuItemId: 'latte-001', selectedVariants: [{ option: 'Hot', price: 0 }, { option: 'Extra shot', price: 2 }] }],
    }), 'Sarah');

    expect(code).toBe(201);
    const { flip, create } = transactHalves();

    // ── the voucher half ──
    expect(flip.TableName).toBe(VOUCHERS);
    expect(flip.Key).toEqual({ PK: `VOUCHER#${PHONE}`, SK: 'VOUCHER#v1' });
    // Both conditions matter: status stops a double redeem, expiry stops a
    // redemption of a voucher that lapsed between the lookup and the tap.
    expect(flip.ConditionExpression).toBe('#s = :issued AND expiresAtEpoch > :nowEpoch');
    expect(flip.ExpressionAttributeNames).toEqual({ '#s': 'status' });
    expect(flip.ExpressionAttributeValues[':redeemed']).toBe('REDEEMED');
    expect(flip.ExpressionAttributeValues[':issued']).toBe('ISSUED');
    expect(flip.ExpressionAttributeValues[':actor']).toBe('Sarah');
    expect(flip.ExpressionAttributeValues[':mid']).toBe('latte-001');
    expect(flip.ExpressionAttributeValues[':mname']).toBe('Latte (Hot, Extra shot)');
    expect(flip.ExpressionAttributeValues[':vlabel']).toBe('Hot, Extra shot');
    // Variant add-ons count towards what the voucher gave away: RM8 + RM2.
    expect(flip.ExpressionAttributeValues[':price']).toBe(10);
    expect(flip.ExpressionAttributeValues[':oid']).toBe(body.orderId);

    // ── the order half ──
    expect(create.TableName).toBe(ORDERS);
    expect(create.ConditionExpression).toBe('attribute_not_exists(PK)');
    const order = create.Item;
    expect(order.PK).toBe(`ORDER#${body.orderId}`);
    expect(order.status).toBe('PREPARING');
    expect(order.discountType).toBe('VOUCHER');
    expect(order.voucherId).toBe('v1');
    expect(order.voucherCampaignId).toBe('c1');
    expect(order.voucherType).toBe('FREE_DRINK');
    expect(order.voucherPhone).toBe(PHONE);
    expect(order.customerId).toBe(PHONE);
    expect(order.isWalkUp).toBe(true);
    expect(order.approvedBy).toBe('Sarah');
    // Money storage convention: totalAmount is NET (nothing collected),
    // discountOffset is the reduction — so the voucher's cost is reportable.
    expect(order.totalAmount).toBe(0);
    expect(order.discountOffset).toBe(10);
    expect(order.items).toEqual([{
      menuItemId: 'latte-001', name: 'Latte', variant: 'Hot, Extra shot',
      quantity: 1, unitPrice: 0, category: 'DRINK',
    }]);

    // ── the response ──
    expect(body.voucherId).toBe('v1');
    expect(body.status).toBe('REDEEMED');
    expect(body.discountAmount).toBe(10);
    expect(body.items).toEqual([{ menuItemId: 'latte-001', name: 'Latte', variant: 'Hot, Extra shot', category: 'DRINK' }]);

    // The redeemed counter is bumped only after the transaction succeeded.
    expect(updates()[0].UpdateExpression).toBe('ADD redeemedCount :d SET updatedAt = :now');
    expect(updates()[0].Key).toEqual({ PK: 'CAMPAIGN#c1', SK: 'META' });
  });

  it('accepts the LEGACY single-item shape and reaches the same gate', async () => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });

    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE,
      menuItemId: 'latte-001', selectedVariants: [{ option: 'Iced', price: 1 }],
    }));

    expect(code).toBe(201);
    expect(body.discountAmount).toBe(9);
    const { create } = transactHalves();
    expect(create.Item.items[0].variant).toBe('Iced');
  });

  it('prefers items[] over a menuItemId sent alongside it', async () => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE,
      items: [{ menuItemId: 'latte-001' }], menuItemId: 'cookie-001',
    }));
    expect(code).toBe(201);
    expect(body.items[0].menuItemId).toBe('latte-001');
  });

  it('falls through to menuItemId when items[] is an empty array', async () => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE, items: [], menuItemId: 'latte-001',
    }));
    expect(code).toBe(201);
    expect(body.items[0].menuItemId).toBe('latte-001');
  });

  it('stores a null variant and the plain name when no variants are chosen', async () => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    const { flip, create } = transactHalves();
    expect(create.Item.items[0].variant).toBeNull();
    expect(flip.ExpressionAttributeValues[':vlabel']).toBeNull();
    expect(flip.ExpressionAttributeValues[':mname']).toBe('Latte');
    expect(flip.ExpressionAttributeValues[':price']).toBe(8);
  });

  it('ignores a non-array selectedVariants on a COMBO (the guarded path)', async () => {
    // The `Array.isArray` guard in the pricing loop is the only reader of the
    // raw field; a truthy non-array prices as no add-ons and labels as null.
    // The single-item path is pinned separately, since it used to re-read the
    // raw field for its variant snapshot and crashed.
    stage({ vouchers: [voucher({ voucherType: 'FREE_COMBO' })], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE,
      items: [
        { menuItemId: 'latte-001', selectedVariants: 'Hot' },
        { menuItemId: 'cookie-001', selectedVariants: { option: 'Warm' } },
      ],
    }));
    expect(code).toBe(201);
    expect(body.items.map((i: any) => i.variant)).toEqual([null, null]);
    expect(body.discountAmount).toBe(11);
  });

  it('drops nameless variant options and falls back to a null label', async () => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE,
      items: [{ menuItemId: 'latte-001', selectedVariants: [{ price: 2 }] }],
    }));
    expect(code).toBe(201);
    expect(body.items[0].variant).toBeNull();
    // The price still counts even though the option had no label.
    expect(body.discountAmount).toBe(10);
  });

  it('treats a menu item with no basePrice as RM0 rather than NaN', async () => {
    const { basePrice, ...free } = LATTE;
    stage({ vouchers: [voucher()], menu: { 'MENU#latte-001': free } });
    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(code).toBe(201);
    expect(body.discountAmount).toBe(0);
  });

  it('names the customer from the body, then the voucher, then a constant', async () => {
    stage({ vouchers: [voucher({ name: 'Mei Yii' })], menu: MENU_WORLD });
    await call(redeemEvent({ voucherId: 'v1', phone: PHONE, customerName: 'Ah Kim', items: [{ menuItemId: 'latte-001' }] }));
    expect(transactHalves().create.Item.customerName).toBe('Ah Kim');

    stage({ vouchers: [voucher({ name: 'Mei Yii' })], menu: MENU_WORLD });
    await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(transactHalves().create.Item.customerName).toBe('Mei Yii');

    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(transactHalves().create.Item.customerName).toBe('Voucher Redemption');
  });

  it('still returns 201 when the best-effort redeemed counter fails', async () => {
    stage({
      vouchers: [voucher()], menu: MENU_WORLD,
      failOn: (c) => (c.__cmd === 'Update' ? new Error('throttled') : null),
    });
    const [code] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(code).toBe(201);
    expect(transacts()).toHaveLength(1);
  });
});

describe('POST /pos/vouchers/redeem — type / category gate', () => {
  it('FREE_COMBO builds a two-line order, joins the names and nulls the variant snapshot', async () => {
    stage({ vouchers: [voucher({ voucherType: 'FREE_COMBO' })], menu: MENU_WORLD });

    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE,
      items: [
        { menuItemId: 'cookie-001' },
        { menuItemId: 'latte-001', selectedVariants: [{ option: 'Hot' }] },
      ],
    }));

    expect(code).toBe(201);
    const { flip, create } = transactHalves();
    expect(create.Item.items.map((i: any) => i.category)).toEqual(['FOOD', 'DRINK']);
    expect(create.Item.discountOffset).toBe(11);            // RM3 + RM8
    expect(flip.ExpressionAttributeValues[':mname']).toBe('Cookie + Latte (Hot)');
    // Combo names already embed their variants, so the snapshot stays null —
    // old consumers read one variant field and two would be ambiguous.
    expect(flip.ExpressionAttributeValues[':vlabel']).toBeNull();
    expect(flip.ExpressionAttributeValues[':mid']).toBe('cookie-001'); // first item
    expect(body.items).toHaveLength(2);
  });

  it('accepts a FREE_COMBO in either order (the categories are sorted)', async () => {
    stage({ vouchers: [voucher({ voucherType: 'FREE_COMBO' })], menu: MENU_WORLD });
    const [code] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE,
      items: [{ menuItemId: 'latte-001' }, { menuItemId: 'cookie-001' }],
    }));
    expect(code).toBe(201);
  });

  it('redeems a FREE_FOOD voucher against a FOOD item', async () => {
    stage({ vouchers: [voucher({ voucherType: 'FREE_FOOD' })], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'cookie-001' }] }));
    expect(code).toBe(201);
    expect(body.discountAmount).toBe(3);
    expect(transactHalves().create.Item.voucherType).toBe('FREE_FOOD');
  });

  it.each([
    ['FREE_DRINK against a FOOD item', 'FREE_DRINK', ['cookie-001'], 'This voucher is for drinks only'],
    ['FREE_DRINK with two items', 'FREE_DRINK', ['latte-001', 'latte-001'], 'FREE_DRINK voucher takes exactly one item'],
    ['FREE_FOOD against a DRINK item', 'FREE_FOOD', ['latte-001'], 'This voucher is for food only'],
    ['FREE_FOOD with two items', 'FREE_FOOD', ['cookie-001', 'cookie-001'], 'FREE_FOOD voucher takes exactly one item'],
    ['FREE_COMBO with one item', 'FREE_COMBO', ['latte-001'], 'FREE_COMBO voucher requires exactly two items (one drink + one food)'],
    ['FREE_COMBO with three items', 'FREE_COMBO', ['latte-001', 'cookie-001', 'latte-001'], 'FREE_COMBO voucher requires exactly two items (one drink + one food)'],
    ['FREE_COMBO with two DRINKs', 'FREE_COMBO', ['latte-001', 'latte-001'], 'FREE_COMBO requires one DRINK and one FOOD item'],
    ['FREE_COMBO with two FOODs', 'FREE_COMBO', ['cookie-001', 'cookie-001'], 'FREE_COMBO requires one DRINK and one FOOD item'],
  ])('rejects %s with 400 and writes NOTHING', async (_n, voucherType, ids, expected) => {
    stage({ vouchers: [voucher({ voucherType })], menu: MENU_WORLD });

    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE, items: (ids as string[]).map((menuItemId) => ({ menuItemId })),
    }));

    expect(code).toBe(400);
    expect(body).toEqual({ error: expected });
    // A live, unexpired voucher and real menu items are staged, so if the gate
    // were dropped this request would flip the voucher and create a free order.
    expect(writes()).toHaveLength(0);
  });

  it('rejects an unknown voucherType — a hand-edited record cannot buy anything', async () => {
    stage({ vouchers: [voucher({ voucherType: 'FREE_EVERYTHING' })], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'Unknown voucher type' });
    expect(writes()).toHaveLength(0);
  });

  it('404s naming the menu item that was not found', async () => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'ghost-001' }] }));
    expect(code).toBe(404);
    expect(body).toEqual({ error: 'Menu item not found: ghost-001' });
    expect(writes()).toHaveLength(0);
  });

  it('400s on an inactive menu item, naming it', async () => {
    stage({ vouchers: [voucher()], menu: { 'MENU#latte-001': { ...LATTE, isActive: false } } });
    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'Menu item is not active: Latte' });
    expect(writes()).toHaveLength(0);
  });
});

describe('POST /pos/vouchers/redeem — request and voucher-state guards', () => {
  it.each([
    ['no voucherId', {}, 400, 'voucherId required'],
    ['no phone', { voucherId: 'v1' }, 400, 'phone required'],
    ['an unnormalisable phone', { voucherId: 'v1', phone: '123' }, 400, 'invalid phone'],
    ['neither items nor menuItemId', { voucherId: 'v1', phone: PHONE }, 400, 'items[] or menuItemId required'],
    ['an item with no menuItemId', { voucherId: 'v1', phone: PHONE, items: [{ quantity: 1 }] }, 400, 'each item must include menuItemId'],
    ['a null entry in items[]', { voucherId: 'v1', phone: PHONE, items: [null] }, 400, 'each item must include menuItemId'],
  ])('rejects %s with %i before reading anything', async (_n, body, status, expected) => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    const [code, parsed] = await call(redeemEvent(body));
    expect(code).toBe(status);
    expect(parsed).toEqual({ error: expected });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('treats a null body as an empty object', async () => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    const [code, body] = await call(makeEvent({
      httpMethod: 'POST', path: '/api/pos/vouchers/redeem', body: null,
    }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'voucherId required' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('404s for a voucher that does not exist on that phone', async () => {
    stage({ vouchers: [voucher({ voucherId: 'other' })], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(code).toBe(404);
    expect(body).toEqual({ error: 'Voucher not found' });
    expect(writes()).toHaveLength(0);
  });

  it.each([['REDEEMED'], ['REVOKED']])('409s on a %s voucher without reading the menu', async (status) => {
    stage({ vouchers: [voucher({ status })], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(code).toBe(409);
    expect(body).toEqual({ error: 'Voucher already redeemed or revoked' });
    expect(cmds().filter((c) => c.TableName === MENU)).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('409s on an expired voucher', async () => {
    stage({ vouchers: [voucher({ expiresAtEpoch: PAST_EPOCH })], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(code).toBe(409);
    expect(body).toEqual({ error: 'Voucher has expired' });
    expect(writes()).toHaveLength(0);
  });

  it('409s on a voucher with no expiresAtEpoch at all', async () => {
    stage({ vouchers: [voucher({ expiresAtEpoch: undefined })], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(code).toBe(409);
    expect(body).toEqual({ error: 'Voucher has expired' });
  });

  it('turns a TransactionCanceledException into a 409, not a 500', async () => {
    // The lost race: two cashiers on the same voucher, or a voucher that lapsed
    // between the lookup and the tap. DynamoDB cancels the whole transaction, so
    // neither half landed — the customer must see a conflict, not a server error,
    // and the redeemed counter must NOT be bumped for a redemption that failed.
    const cancelled: any = new Error('Transaction cancelled, please refer cancellation reasons');
    cancelled.name = 'TransactionCanceledException';
    stage({
      vouchers: [voucher()], menu: MENU_WORLD,
      failOn: (c) => (c.__cmd === 'TransactWrite' ? cancelled : null),
    });

    const [code, body] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));

    expect(code).toBe(409);
    expect(body).toEqual({
      error: 'Voucher could not be redeemed (already redeemed, expired, or order id conflict)',
    });
    expect(updates()).toHaveLength(0);
  });

  it('rethrows any other transaction failure so the router 500s honestly', async () => {
    // A throttle or an IAM failure is not a conflict; swallowing it as a 409
    // would tell the cashier the voucher was already used.
    const boom: any = new Error('ProvisionedThroughputExceededException');
    boom.name = 'ProvisionedThroughputExceededException';
    stage({
      vouchers: [voucher()], menu: MENU_WORLD,
      failOn: (c) => (c.__cmd === 'TransactWrite' ? boom : null),
    });

    await expect(
      handleVouchers(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }), 'Sarah'),
    ).rejects.toThrow('ProvisionedThroughputExceededException');
    expect(updates()).toHaveLength(0);
  });
});

describe('POST /pos/vouchers/redeem — three fixed defects, pinned so they cannot return', () => {
  // Each of the three below was a real defect in `vouchers.ts`, each violating a
  // documented invariant. They are now fixed and these tests assert the CORRECT
  // behaviour, so a regression fails here rather than in production.

  it('writes NO expiresAt on the PREPARING order it creates', async () => {
    // `invariants` → Order status: "Numeric `expiresAt` exists on PENDING orders
    // only. Missing `REMOVE expiresAt` on a transition out of PENDING means
    // DynamoDB TTL silently deletes a live or archived order." The order was
    // born PREPARING with a 60-minute numeric TTL, so a redemption not marked
    // READY within the hour was DELETED — no error, no log, and the voucher was
    // already REDEEMED so it could not be reissued.
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));

    const order = transactHalves().create.Item;
    expect(order.status).toBe('PREPARING');
    expect(order.expiresAt).toBeUndefined();
    expect(Object.keys(order)).not.toContain('expiresAt');
    // Nothing numeric that TTL could latch onto snuck in under another name.
    expect(Object.entries(order).filter(([, v]) => typeof v === 'number' && v > 1_000_000_000))
      .toEqual([]);
  });

  it('400s rather than crashing on a non-array selectedVariants (single-item path)', async () => {
    // The snapshot line re-read the SAME untrusted field with only `|| []`,
    // which does not catch a truthy non-array. A string `selectedVariants` threw
    // `selectedVariants.map is not a function` out of the handler — a 500, after
    // every validation gate had already passed. There is now one reader and one
    // guard, so the string is ignored exactly as it already was on the COMBO
    // path, and the redemption succeeds with a null variant label.
    stage({ vouchers: [voucher()], menu: MENU_WORLD });

    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE,
      items: [{ menuItemId: 'latte-001', selectedVariants: 'Hot' }],
    }), 'Sarah');

    expect(code).toBe(201);
    expect(body.items[0].variant).toBeNull();
    // No add-on price could be derived from a string, so only the base RM8.
    expect(body.discountAmount).toBe(8);
    const { flip, create } = transactHalves();
    expect(create.Item.items[0].variant).toBeNull();
    expect(flip.ExpressionAttributeValues[':vlabel']).toBeNull();
    expect(flip.ExpressionAttributeValues[':mname']).toBe('Latte');
  });

  it('does not crash on the legacy single-item shape either', async () => {
    // `body.selectedVariants` reaches the same snapshot line via the legacy
    // `{menuItemId, selectedVariants}` shape, so it needs the same guard.
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    const [code, body] = await call(redeemEvent({
      voucherId: 'v1', phone: PHONE, menuItemId: 'latte-001', selectedVariants: 'Iced',
    }));
    expect(code).toBe(201);
    expect(body.items[0].variant).toBeNull();
  });

  it('reserves foodReserved for a FREE_FOOD redemption', async () => {
    // Every other path that puts FOOD into a live order moves `foodReserved`
    // (`orders.ts:427`, `pos.ts:926`), and `markReady` (`pos.ts:75`) decrements
    // both `foodReserved` and `foodQuantityToday`. A redemption that never
    // incremented drove `foodReserved` NEGATIVE at ready, and the cookie it gave
    // away was still counted as available to the next customer.
    stage({ vouchers: [voucher({ voucherType: 'FREE_FOOD' })], menu: MENU_WORLD });
    await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'cookie-001' }] }));

    expect(transactHalves().create.Item.items[0].category).toBe('FOOD');

    const menuWrites = cmds().filter((c) => c.TableName === MENU && c.__cmd !== 'Get');
    expect(menuWrites).toHaveLength(1);
    expect(menuWrites[0].__cmd).toBe('Update');
    expect(menuWrites[0].Key).toEqual({ PK: 'MENU#cookie-001', SK: 'META' });
    expect(menuWrites[0].UpdateExpression).toBe('SET foodReserved = foodReserved + :q');
    expect(menuWrites[0].ExpressionAttributeValues).toEqual({ ':q': 1 });
  });

  it('reserves only the FOOD half of a FREE_COMBO', async () => {
    stage({ vouchers: [voucher({ voucherType: 'FREE_COMBO' })], menu: MENU_WORLD });
    await call(redeemEvent({
      voucherId: 'v1', phone: PHONE,
      items: [{ menuItemId: 'latte-001' }, { menuItemId: 'cookie-001' }],
    }));

    const menuWrites = cmds().filter((c) => c.TableName === MENU && c.__cmd !== 'Get');
    expect(menuWrites.map((c) => c.Key.PK)).toEqual(['MENU#cookie-001']);
  });

  it('reserves nothing for a FREE_DRINK redemption', async () => {
    stage({ vouchers: [voucher()], menu: MENU_WORLD });
    await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'latte-001' }] }));
    expect(cmds().filter((c) => c.TableName === MENU && c.__cmd !== 'Get')).toHaveLength(0);
  });

  it('reserves AFTER the transaction, so a lost race leaves no phantom reservation', async () => {
    // The reservation is a separate write from the atomic redeem. If the redeem
    // is cancelled the food must stay available — otherwise a contended voucher
    // burns stock for an order that was never created.
    const cancelled: any = new Error('Transaction cancelled');
    cancelled.name = 'TransactionCanceledException';
    stage({
      vouchers: [voucher({ voucherType: 'FREE_FOOD' })], menu: MENU_WORLD,
      failOn: (c) => (c.__cmd === 'TransactWrite' ? cancelled : null),
    });

    const [code] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'cookie-001' }] }));
    expect(code).toBe(409);
    expect(cmds().filter((c) => c.TableName === MENU && c.__cmd !== 'Get')).toHaveLength(0);
  });

  it('still returns 201 when the best-effort food reservation fails', async () => {
    // A legacy menu record with no `foodReserved` attribute must not fail a
    // redemption the customer has already been handed.
    stage({
      vouchers: [voucher({ voucherType: 'FREE_FOOD' })], menu: MENU_WORLD,
      failOn: (c) => (c.__cmd === 'Update' && c.TableName === MENU ? new Error('ValidationException') : null),
    });
    const [code] = await call(redeemEvent({ voucherId: 'v1', phone: PHONE, items: [{ menuItemId: 'cookie-001' }] }));
    expect(code).toBe(201);
    // The campaign counter bump still went out afterwards.
    expect(updates().filter((c) => c.TableName === VOUCHERS)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/pos/vouchers/void — voidRedemption
// ══════════════════════════════════════════════════════════════════════════════

function voidEvent(body: unknown) {
  return makeEvent({ httpMethod: 'POST', path: '/api/pos/vouchers/void', body: JSON.stringify(body) });
}

describe('POST /pos/vouchers/void — voidRedemption', () => {
  it('moves the order back to PENDING under a conditional update', async () => {
    stage({ orders: { 'ORDER#o1': voucherOrder() } });

    const [code, body] = await call(voidEvent({ orderId: 'o1' }));

    expect(code).toBe(200);
    expect(body).toEqual({ orderId: 'o1', status: 'PENDING' });

    const u = updates()[0];
    expect(u.TableName).toBe(ORDERS);
    expect(u.Key).toEqual({ PK: 'ORDER#o1', SK: 'META' });
    expect(u.UpdateExpression).toBe('SET #s = :pending, updatedAt = :now');
    expect(u.ConditionExpression).toBe('#s = :preparing');
    expect(u.ExpressionAttributeNames).toEqual({ '#s': 'status' });
    expect(u.ExpressionAttributeValues[':pending']).toBe('PENDING');
    expect(u.ExpressionAttributeValues[':preparing']).toBe('PREPARING');
  });

  it('does NOT un-redeem the voucher — a redeemed voucher is gone for good', async () => {
    // The resolved decision: voiding hands the order back to the cashier as a
    // normal editable order. Restoring the voucher would make it re-spendable.
    stage({ orders: { 'ORDER#o1': voucherOrder() }, vouchers: [voucher({ status: 'REDEEMED' })] });
    await call(voidEvent({ orderId: 'o1' }));
    expect(cmds().filter((c) => c.TableName === VOUCHERS)).toHaveLength(0);
    expect(updates()).toHaveLength(1);
  });

  it.each([['READY'], ['COLLECTED'], ['PENDING'], ['CANCELLED']])(
    '409s on a %s order — only PREPARING may be voided', async (status) => {
      stage({ orders: { 'ORDER#o1': voucherOrder({ status }) } });
      const [code, body] = await call(voidEvent({ orderId: 'o1' }));
      expect(code).toBe(409);
      expect(body).toEqual({ error: 'Order is no longer in PREPARING' });
      expect(writes()).toHaveLength(0);
    },
  );

  it('400s on an order that did not originate from a voucher', async () => {
    // A PREPARING money order is staged, so dropping this guard would reopen a
    // paid order for editing through the voucher namespace.
    stage({ orders: { 'ORDER#o1': voucherOrder({ discountType: 'NONE', totalAmount: 8 }) } });
    const [code, body] = await call(voidEvent({ orderId: 'o1' }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'Order did not originate from a voucher' });
    expect(writes()).toHaveLength(0);
  });

  it('404s for an unknown order', async () => {
    stage({ orders: {} });
    const [code, body] = await call(voidEvent({ orderId: 'nope' }));
    expect(code).toBe(404);
    expect(body).toEqual({ error: 'Order not found' });
    expect(writes()).toHaveLength(0);
  });

  it('400s with no orderId, before reading anything', async () => {
    stage({ orders: { 'ORDER#o1': voucherOrder() } });
    const [code, body] = await call(voidEvent({}));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'orderId required' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('treats a null body as an empty object', async () => {
    const [code, body] = await call(makeEvent({ httpMethod: 'POST', path: '/api/pos/vouchers/void', body: null }));
    expect(code).toBe(400);
    expect(body).toEqual({ error: 'orderId required' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Dispatch — handleVouchers itself
// ══════════════════════════════════════════════════════════════════════════════

describe('handleVouchers dispatch', () => {
  it.each([
    ['GET', '/api/admin/vouchers'],
    ['POST', '/api/admin/vouchers/campaigns/c1'],
    ['PUT', '/api/admin/vouchers/campaigns'],
    ['DELETE', '/api/admin/vouchers/campaigns/c1/assign'],
    ['GET', '/api/pos/vouchers/0168089999/extra'],
    ['POST', '/api/pos/vouchers/lookup'],
    ['GET', '/api/pos/vouchers'],
    ['PATCH', '/api/pos/vouchers/redeem'],
    ['GET', '/api/admin/vouchers/campaigns/c1/assign'],
  ])('404s on %s %s without touching the table', async (httpMethod, path) => {
    stage();
    const [code, body] = await call(makeEvent({ httpMethod, path }));
    expect(code).toBe(404);
    expect(body).toEqual({ error: 'Not found' });
    expect(mockDbSend).not.toHaveBeenCalled();
  });

  it('does not let /assign-csv be captured by the /{id} detail route', async () => {
    // `/campaigns/{id}` is anchored, so `c1/assign-csv` must not read as an id.
    stage({ campaigns: { c1: campaign() } });
    const [code] = await call(csvEvent({ csv: 'phone\n0168089999' }));
    expect(code).toBe(200);
    expect(cmds().filter((c) => c.IndexName === GSI)).toHaveLength(0);
  });

  it('routes a campaign id containing a URL-safe token', async () => {
    stage({ campaigns: { 'a-b_c.1': campaign({ campaignId: 'a-b_c.1', PK: 'CAMPAIGN#a-b_c.1' }) } });
    const [code, body] = await call(makeEvent({ httpMethod: 'GET', path: `${CAMPAIGNS_PATH}/a-b_c.1` }));
    expect(code).toBe(200);
    expect(body.campaign.campaignId).toBe('a-b_c.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE so its top-level `const`s do not collide with the
// other suites on a cold ts-jest cache. See the `test-suites` skill.
// ─────────────────────────────────────────────────────────────────────────────
export {};
