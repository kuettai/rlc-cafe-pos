/**
 * The end-of-day email must be headed with the date of the service it reports.
 *
 * It was not. `formatDate` parsed the date as midnight MYT and then formatted it
 * with `toLocaleDateString('en-MY', …)` and NO `timeZone` option, so it rendered
 * in the Lambda's zone — UTC — landing at 16:00 the previous day. The two
 * summaries that actually reached the inbox were subject-lined:
 *
 *   2026-08-02 service → "☕ Saturday, 1 August 2026: 76 orders · RM340 revenue"
 *   2026-08-09 service → "☕ Saturday, 8 August 2026: 63 orders · RM515 revenue"
 *
 * Both services were Sundays. Verbatim from CloudWatch, `/aws/lambda/rlc-cafe-api`.
 *
 * These tests drive the REAL `sendEndOfDaySummary` with a captured transport, so
 * they assert on the actual subject and body a recipient would see.
 */

const mockSendMail = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: (...args: any[]) => mockSendMail(...args) })),
}));

jest.mock('../src/lib/ssm-config', () => ({
  getEmailConfig: jest.fn().mockResolvedValue({
    gmailUser: 'cafe@example.com',
    gmailAppPassword: 'app-password',
    notificationEmail: 'treasurer@example.com',
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendEndOfDaySummary } = require('../src/lib/email');

/**
 * Emulate the Lambda runtime's ambient timezone (UTC) no matter where the suite
 * runs.
 *
 * This is what gives these tests teeth. The bug is invisible on a Malaysian dev
 * machine — with the ambient zone already MYT, a missing `timeZone` option
 * renders correctly by accident, so every assertion below passed against the
 * BROKEN code until this shim existed. Setting `process.env.TZ` in setupFiles is
 * too late to help (Node caches the zone before then), so instead: any call that
 * does not pin a `timeZone` is served as UTC, exactly as production would.
 */
function emulateUtcRuntime() {
  const real = Date.prototype.toLocaleDateString;
  jest
    .spyOn(Date.prototype, 'toLocaleDateString')
    .mockImplementation(function (this: Date, locales?: any, options?: any) {
      const effective = options?.timeZone ? options : { ...(options || {}), timeZone: 'UTC' };
      return real.call(this, locales, effective);
    });
}

beforeEach(() => {
  emulateUtcRuntime();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const baseSummary = {
  totalRevenue: 463,
  totalOrders: 53,
  totalOffsets: 47,
  totalRefunds: 8.2,
  netExpected: 463,
  newcomersServed: 4,
  topItems: [{ name: 'Latte', qty: 12 }],
  lowStockItems: [],
};

/** Subject line of the single mail the call produced. */
async function subjectFor(date: string): Promise<string> {
  mockSendMail.mockReset();
  mockSendMail.mockResolvedValue({ messageId: 'test' });
  const ok = await sendEndOfDaySummary({ ...baseSummary, date });
  expect(ok).toBe(true);
  expect(mockSendMail).toHaveBeenCalledTimes(1);
  return mockSendMail.mock.calls[0][0].subject;
}

describe('end-of-day email date rendering', () => {
  it('renders a Sunday service as that Sunday — the 2026-08-16 case', async () => {
    const subject = await subjectFor('2026-08-16');

    expect(subject).toContain('Sunday');
    expect(subject).toContain('16');
    expect(subject).toContain('August');
    expect(subject).toContain('2026');
    // The production bug, stated as its own assertion.
    expect(subject).not.toContain('Saturday');
    expect(subject).not.toContain('15');
  });

  it('reproduces the two dates that shipped wrong, now correct', async () => {
    // Was "Saturday, 1 August 2026".
    const aug2 = await subjectFor('2026-08-02');
    expect(aug2).toContain('Sunday');
    expect(aug2).toContain('2 August');
    expect(aug2).not.toContain('Saturday');

    // Was "Saturday, 8 August 2026".
    const aug9 = await subjectFor('2026-08-09');
    expect(aug9).toContain('Sunday');
    expect(aug9).toContain('9 August');
    expect(aug9).not.toContain('Saturday');
  });

  it('does not slip a day at the start of a month', async () => {
    // 1 March would render as 28/29 February without the timeZone.
    const subject = await subjectFor('2026-03-01');
    expect(subject).toContain('1 March');
    expect(subject).not.toContain('February');
  });

  it('does not slip a year at the start of January', async () => {
    const subject = await subjectFor('2027-01-01');
    expect(subject).toContain('1 January');
    expect(subject).toContain('2027');
    expect(subject).not.toContain('2026');
    expect(subject).not.toContain('December');
  });

  it('puts the same corrected date in the email body', async () => {
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
    await sendEndOfDaySummary({ ...baseSummary, date: '2026-08-16' });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('Sunday');
    expect(html).not.toContain('Saturday');
  });

  it('still reports the money figures it was given', async () => {
    // Guards the date fix against disturbing the net/gross reconciliation.
    mockSendMail.mockReset();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
    await sendEndOfDaySummary({ ...baseSummary, date: '2026-08-16' });

    const html = mockSendMail.mock.calls[0][0].html;
    expect(html).toContain('510.00'); // gross = 463 net + 47 offsets
    expect(html).toContain('463.00'); // net sales
    expect(html).toContain('8.20');   // refunds
  });
});
