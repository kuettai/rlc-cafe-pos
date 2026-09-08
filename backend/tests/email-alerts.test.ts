/**
 * `lib/email.ts` — the paths that are NOT the date rendering.
 *
 * `email-date.test.ts` owns the service-date formatting and is deliberately not
 * duplicated here. This suite covers what was left uncovered:
 *
 *   - `getTransporter` returning a null transporter when SSM has no Gmail
 *     credentials (email.ts:10-12), and `sendEmail`'s "not configured" guard
 *     that turns that into a logged `false` rather than a throw (email.ts:45-48)
 *   - `sendEmail`'s catch block when the transport rejects (email.ts:59-62) —
 *     a mail failure must never propagate into the caller (the expiry cron
 *     writes its exactly-once `DAILY_SUMMARY#{date}` marker off the return
 *     value, so an exception here would be a different bug entirely)
 *   - `sendLowStockAlert` end to end (email.ts:65-95), which had no coverage
 *   - `sendEndOfDaySummary`'s low-stock branch (email.ts:159-164) — the `<li>`
 *     rows. The healthy-stock branch is exercised by `email-date.test.ts`, so
 *     only the pairing is asserted here.
 *
 * Fully offline: `nodemailer` and `lib/ssm-config` are both mocked, so no SMTP
 * connection is opened, no SSM parameter is read, and no mail is sent. Nothing
 * reaches production, so no `ZZTEST_` marker applies.
 */

const alertSendMail = jest.fn();
const alertCreateTransport = jest.fn((_opts?: any) => ({
  sendMail: (...args: any[]) => alertSendMail(...args),
}));
const alertEmailConfig = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: (...args: any[]) => alertCreateTransport(...args),
}));

jest.mock('../src/lib/ssm-config', () => ({
  getEmailConfig: () => alertEmailConfig(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendEmail, sendLowStockAlert, sendEndOfDaySummary } = require('../src/lib/email');

const CONFIGURED = {
  gmailUser: 'cafe@example.com',
  gmailAppPassword: 'app-password',
  notificationEmail: 'treasurer@example.com',
};

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  alertSendMail.mockReset().mockResolvedValue({ messageId: 'test' });
  alertCreateTransport.mockClear();
  alertEmailConfig.mockReset().mockResolvedValue({ ...CONFIGURED });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** The single message the call under test handed to the transport. */
function sentMail(): any {
  expect(alertSendMail).toHaveBeenCalledTimes(1);
  return alertSendMail.mock.calls[0][0];
}

describe('getTransporter — credentials absent', () => {
  it('builds no transport at all when gmailUser is missing', async () => {
    alertEmailConfig.mockResolvedValue({
      gmailUser: '',
      gmailAppPassword: 'app-password',
      notificationEmail: 'treasurer@example.com',
    });

    expect(await sendEmail('Subject', '<p>body</p>')).toBe(false);
    // The early return happens BEFORE createTransport, so a missing password
    // cannot reach nodemailer and fail there instead.
    expect(alertCreateTransport).not.toHaveBeenCalled();
    expect(alertSendMail).not.toHaveBeenCalled();
  });

  it('builds no transport when gmailAppPassword is missing', async () => {
    alertEmailConfig.mockResolvedValue({
      gmailUser: 'cafe@example.com',
      gmailAppPassword: '',
      notificationEmail: 'treasurer@example.com',
    });

    expect(await sendEmail('Subject', '<p>body</p>')).toBe(false);
    expect(alertCreateTransport).not.toHaveBeenCalled();
  });

  it('passes the SSM credentials straight through to nodemailer when present', async () => {
    await sendEmail('Subject', '<p>body</p>');

    expect(alertCreateTransport).toHaveBeenCalledWith({
      service: 'gmail',
      auth: { user: 'cafe@example.com', pass: 'app-password' },
    });
  });
});

describe('sendEmail — the "not configured" guard', () => {
  it('logs and returns false, naming the subject that was dropped', async () => {
    alertEmailConfig.mockResolvedValue({
      gmailUser: '',
      gmailAppPassword: '',
      notificationEmail: '',
    });

    expect(await sendEmail('End of day summary', '<p>body</p>')).toBe(false);
    expect(logSpy).toHaveBeenCalledWith('[EMAIL] Not configured, skipping:', 'End of day summary');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('also skips when credentials exist but no recipient is configured', async () => {
    // NOTIFICATION_EMAIL unset in SSM resolves to '' — a transport is built and
    // then never used, because a mail with no `to` is not worth attempting.
    alertEmailConfig.mockResolvedValue({ ...CONFIGURED, notificationEmail: '' });

    expect(await sendEmail('Low stock', '<p>body</p>')).toBe(false);
    expect(alertCreateTransport).toHaveBeenCalledTimes(1);
    expect(alertSendMail).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[EMAIL] Not configured, skipping:', 'Low stock');
  });
});

describe('sendEmail — configured', () => {
  it('sends from the SSM user to the notification address and returns true', async () => {
    expect(await sendEmail('Hello', '<p>body</p>')).toBe(true);

    expect(sentMail()).toEqual({
      from: '"153 Café POS" <cafe@example.com>',
      to: 'treasurer@example.com',
      subject: 'Hello',
      html: '<p>body</p>',
    });
    expect(logSpy).toHaveBeenCalledWith('[EMAIL] Sent:', 'Hello');
  });

  it('swallows a transport failure: logs the error and returns false', async () => {
    const boom = new Error('Invalid login: 535-5.7.8 Username and Password not accepted');
    alertSendMail.mockRejectedValue(boom);

    // Must not throw — callers gate exactly-once markers on this boolean.
    await expect(sendEmail('Hello', '<p>body</p>')).resolves.toBe(false);
    expect(errorSpy).toHaveBeenCalledWith('[EMAIL] Failed:', boom);
    expect(logSpy).not.toHaveBeenCalledWith('[EMAIL] Sent:', 'Hello');
  });
});

describe('sendLowStockAlert', () => {
  const twoItems = [
    { name: 'Oat Milk', currentStock: 2, unit: 'L', threshold: 5 },
    { name: 'Espresso Beans', currentStock: 300, unit: 'g', threshold: 1000 },
  ];

  it('subjects the mail with the item count and pluralises past one', async () => {
    expect(await sendLowStockAlert(twoItems)).toBe(true);

    expect(sentMail().subject).toBe('⚠️ Low Stock: 2 items need restocking');
    expect(sentMail().to).toBe('treasurer@example.com');
    expect(sentMail().from).toBe('"153 Café POS" <cafe@example.com>');
  });

  it('renders one row per item with current stock, unit and threshold', async () => {
    await sendLowStockAlert(twoItems);
    const html = sentMail().html;

    expect(html).toContain('Low Stock Alert');
    expect(html).toContain('2 items running low');
    expect(html).toContain('Oat Milk');
    expect(html).toContain('2 L');
    expect(html).toContain('5 L');
    expect(html).toContain('Espresso Beans');
    expect(html).toContain('300 g');
    expect(html).toContain('1000 g');
    // One <tr> per item inside the table body, and no more.
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)![0].match(/<tr>/g)).toHaveLength(2);
    expect(html).toContain("Please restock before next Sunday's service");
  });

  it('wraps the alert in the shared email chrome', async () => {
    await sendLowStockAlert(twoItems);
    const html = sentMail().html;

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('oneFIVEthree Café');
    expect(html).toContain('153.oasisofcare.org/admin.html');
  });

  it('uses the singular form for exactly one item', async () => {
    await sendLowStockAlert([{ name: 'Oat Milk', currentStock: 1, unit: 'L', threshold: 5 }]);

    expect(sentMail().subject).toBe('⚠️ Low Stock: 1 item need restocking');
    expect(sentMail().html).toContain('1 item running low');
  });

  it('has no empty-list guard — an empty call still sends a "0 item" mail', async () => {
    // Documenting current behaviour, not endorsing it: the caller is responsible
    // for not calling this with nothing low.
    expect(await sendLowStockAlert([])).toBe(true);
    expect(sentMail().subject).toBe('⚠️ Low Stock: 0 item need restocking');
    expect(sentMail().html).toContain('<tbody></tbody>');
  });

  it('escapes nothing — an item name is interpolated raw into the HTML', async () => {
    // Ingredient names are admin-authored, so this is not an injection path from
    // an untrusted source; pinned so a future change is a deliberate one.
    await sendLowStockAlert([{ name: 'Milk <b>x</b>', currentStock: 1, unit: 'L', threshold: 2 }]);
    expect(sentMail().html).toContain('Milk <b>x</b>');
  });

  it('reports false when email is not configured', async () => {
    alertEmailConfig.mockResolvedValue({ gmailUser: '', gmailAppPassword: '', notificationEmail: '' });

    expect(await sendLowStockAlert(twoItems)).toBe(false);
    expect(alertSendMail).not.toHaveBeenCalled();
  });

  it('reports false when the transport rejects', async () => {
    alertSendMail.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(sendLowStockAlert(twoItems)).resolves.toBe(false);
  });
});

describe('sendEndOfDaySummary — the low-stock block', () => {
  const base = {
    date: '2026-08-16',
    totalRevenue: 463,
    totalOrders: 53,
    totalOffsets: 47,
    netExpected: 463,
    newcomersServed: 4,
    topItems: [{ name: 'Latte', qty: 12 }],
    lowStockItems: [] as { name: string; currentStock: number; unit: string }[],
  };

  it('renders an <li> per low-stock item instead of the healthy banner', async () => {
    await sendEndOfDaySummary({
      ...base,
      lowStockItems: [
        { name: 'Oat Milk', currentStock: 2, unit: 'L' },
        { name: 'Espresso Beans', currentStock: 300, unit: 'g' },
      ],
    });
    const html = sentMail().html;

    expect(html).toContain('Low Stock Items');
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toContain('<strong>Oat Milk</strong>: 2 L');
    expect(html).toContain('<strong>Espresso Beans</strong>: 300 g');
    // The two branches are mutually exclusive — the reassuring banner must be gone.
    expect(html).not.toContain('All stock levels are healthy');
  });

  it('shows the healthy banner and no <li> rows when nothing is low', async () => {
    await sendEndOfDaySummary({ ...base });
    const html = sentMail().html;

    expect(html).toContain('All stock levels are healthy');
    expect(html).not.toContain('<li ');
    expect(html).not.toContain('Low Stock Items');
  });

  it('omits the Top Sellers table and the Refunds row when both are absent', async () => {
    // The other side of two ternaries `email-date.test.ts` only ever sees truthy.
    await sendEndOfDaySummary({ ...base, topItems: [], totalRefunds: 0 });
    const html = sentMail().html;

    expect(html).not.toContain('Top Sellers');
    expect(html).not.toContain('Refunds');
    expect(html).toContain('Net Expected');
  });

  it('ranks the first three top sellers differently from the rest', async () => {
    await sendEndOfDaySummary({
      ...base,
      topItems: [1, 2, 3, 4].map(n => ({ name: `Item ${n}`, qty: 10 - n })),
    });
    const html = sentMail().html;

    expect(html).toContain('Top Sellers');
    expect(html.match(/#6B4226;color:#fff/g)).toHaveLength(3); // ranks 1-3
    expect(html.match(/#D4A574;color:#fff/g)).toHaveLength(1); // rank 4
  });

  it('returns false, and sends nothing, when email is not configured', async () => {
    alertEmailConfig.mockResolvedValue({ gmailUser: '', gmailAppPassword: '', notificationEmail: '' });

    expect(await sendEndOfDaySummary({ ...base })).toBe(false);
    expect(alertSendMail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marks this file as a MODULE. Without it TypeScript treats the file as a global
// script and its top-level `const`s collide with the other script-mode suites
// (`TS2451: Cannot redeclare block-scoped variable`), which fails the suite on a
// cold ts-jest cache while a warm local run passes. See tests/README.md.
// ─────────────────────────────────────────────────────────────────────────────
export {};
