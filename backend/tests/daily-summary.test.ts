/**
 * The end-of-day email's revenue must agree with the admin Reports page.
 *
 * It did not: the email summed EVERY order status, so cancelled and expired
 * orders were counted as money taken. On 2026-08-09 that made the email report
 * RM 515.40 against the report's RM 463.00 — ten cancelled orders worth
 * RM 99.20, minus the RM 8.20 refund the email also mishandled.
 *
 * These cases pin the rule down: completed sales only (ARCHIVED / READY),
 * post-completion cancels subtracted as refunds, `totalAmount` treated as NET.
 * The mirror of this logic lives in `buildSummaryCol` in frontend/js/reports.js.
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
  TransactWriteCommand: jest.fn().mockImplementation((p) => ({ ...p, __cmd: 'TransactWrite' })),
}));

jest.mock('../src/lib/email', () => ({
  sendEndOfDaySummary: jest.fn().mockResolvedValue(true),
  sendLowStockAlert: jest.fn().mockResolvedValue(true),
}));

// Moved out of routes/pos.ts into lib/daily-summary.ts when the end-of-day
// summary became a cron job instead of a fire-and-forget call in `closeCafe`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { summarizeDailyRevenue } = require('../src/lib/daily-summary');

const sale = (total: number, offset = 0, extra: Record<string, any> = {}) => ({
  status: 'ARCHIVED', totalAmount: total, discountOffset: offset, ...extra,
});

describe('summarizeDailyRevenue', () => {
  it('counts ARCHIVED and READY as sales', () => {
    const r = summarizeDailyRevenue([
      sale(7), sale(8), { status: 'READY', totalAmount: 5, discountOffset: 0 },
    ]);
    expect(r.totalOrders).toBe(3);
    expect(r.totalRevenue).toBe(20);
    expect(r.netExpected).toBe(20);
  });

  it('EXCLUDES cancelled and expired orders — the 2026-08-09 bug', () => {
    const r = summarizeDailyRevenue([
      sale(100),
      { status: 'CANCELLED', totalAmount: 99.2, discountOffset: 8 },
      { status: 'EXPIRED', totalAmount: 50, discountOffset: 0 },
      { status: 'PENDING', totalAmount: 12, discountOffset: 0 },
      { status: 'PREPARING', totalAmount: 9, discountOffset: 0 },
    ]);
    // Only the RM100 sale counts. Summing every status would give 270.20.
    expect(r.totalOrders).toBe(1);
    expect(r.totalRevenue).toBe(100);
    expect(r.netExpected).toBe(100);
  });

  it('subtracts post-completion cancels as refunds', () => {
    const r = summarizeDailyRevenue([
      sale(100),
      // A real sale that was later refunded. Status is CANCELLED but the
      // postCompletionCancel flag marks it as a reversal of collected money.
      { status: 'CANCELLED', totalAmount: 8.2, discountOffset: 0, postCompletionCancel: true },
    ]);
    expect(r.totalRefunds).toBeCloseTo(8.2, 2);
    expect(r.netExpected).toBeCloseTo(91.8, 2);
  });

  it('does not double-count discounts — totalAmount is already NET', () => {
    // RM10 gross, RM3 discounted, RM7 collected.
    const r = summarizeDailyRevenue([sale(7, 3)]);
    expect(r.totalRevenue).toBe(7);
    expect(r.totalOffsets).toBe(3);
    // Net expected is the collected amount, NOT 7 - 3.
    expect(r.netExpected).toBe(7);
  });

  it('never counts a post-completion cancel as both sale and refund', () => {
    const r = summarizeDailyRevenue([
      { status: 'ARCHIVED', totalAmount: 20, discountOffset: 0, postCompletionCancel: true },
    ]);
    expect(r.totalOrders).toBe(0);
    expect(r.totalRevenue).toBe(0);
    expect(r.totalRefunds).toBe(20);
    expect(r.netExpected).toBe(-20);
  });

  it('reproduces the real 2026-08-09 service figures', () => {
    // 53 completed sales totalling RM471.20 net with RM47.00 of discounts,
    // 10 cancelled orders (RM99.20) that must NOT count, and one RM8.20
    // post-completion refund. Verified against production data.
    const orders: any[] = [];
    for (let i = 0; i < 52; i++) orders.push(sale(9, 0));            // 468.00
    orders.push(sale(3.2, 47));                                      // -> 471.20 net, 47.00 offsets
    for (let i = 0; i < 10; i++) orders.push({ status: 'CANCELLED', totalAmount: 9.92, discountOffset: 0.8 });
    orders.push({ status: 'CANCELLED', totalAmount: 8.2, discountOffset: 0, postCompletionCancel: true });

    const r = summarizeDailyRevenue(orders);
    expect(r.totalOrders).toBe(53);
    expect(r.totalRevenue).toBeCloseTo(471.2, 2);
    expect(r.totalOffsets).toBeCloseTo(47, 2);
    expect(r.totalRefunds).toBeCloseTo(8.2, 2);
    // The figure the admin Reports page shows for Sun 09 Aug.
    expect(r.netExpected).toBeCloseTo(463, 2);
  });

  it('handles an empty day without producing NaN', () => {
    const r = summarizeDailyRevenue([]);
    expect(r.totalOrders).toBe(0);
    expect(r.netExpected).toBe(0);
    expect(Number.isNaN(r.netExpected)).toBe(false);
  });
});
