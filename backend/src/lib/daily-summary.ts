/**
 * End-of-day revenue summary — the money roll-up and the email that carries it.
 *
 * ── Why this lives in lib/ and is driven by the cron ──────────────────────────
 * It used to live in `routes/pos.ts` and be kicked off by `closeCafe` as
 * `sendDailySummaryEmail().catch(() => {})` — un-awaited, after the handler had
 * already returned its 200. That does not work on Lambda: the execution
 * environment is FROZEN once the response is delivered, so the orphaned promise
 * only advanced when that same sandbox happened to be thawed by a later
 * unrelated request. Delivery was a coin flip on post-close traffic:
 *
 *   2026-08-02  close 06:40:17Z  → email sent 06:41:07Z  (+50s,  10 later hits)
 *   2026-08-09  close 05:39:50Z  → email sent 05:44:30Z  (+4m39s, 46 later hits)
 *   2026-08-16  close 06:00:56Z  → NEVER SENT            (2 later hits, then the
 *                                                         sandbox was reaped)
 *
 * On the working days CloudWatch attributed the `[EMAIL] Sent` line to a
 * *different* request id than the close, timestamped AFTER that request's
 * REPORT — the signature of post-response work limping along in the background.
 * The swallowed `.catch()` plus a discarded return value meant the failure was
 * invisible for a week.
 *
 * So: the cron owns it now (`sendDailySummary` in `expiry.ts`), where the work
 * is properly awaited inside an invocation that is allowed to take 30s, and a
 * `DAILY_SUMMARY#{date}` marker makes it exactly-once with free retries.
 * Nothing here may be called from a request handler again.
 */
import { docClient, ORDERS_TABLE, INGREDIENTS_TABLE, QueryCommand, ScanCommand } from './db';
import { sendEndOfDaySummary } from './email';
import { isNewcomerOrder } from './pricing';
import { malaysiaDayStartUtc } from './date';

/**
 * Roll a day's orders up into the money figures for the end-of-day email.
 *
 * Revenue counts COMPLETED SALES only — the same rule the admin Reports page
 * applies (`buildSummaryCol` in frontend/js/reports.js), so the email and the
 * page agree. They disagreed before: this summed EVERY status, so cancelled and
 * expired orders were billed as revenue. On 2026-08-09 ten cancelled orders
 * (RM 99.20) inflated the emailed net from the true RM 463.00 to RM 515.40. A
 * cancelled order was never collected; an EXPIRED one never reached the counter.
 *
 * A post-completion cancel is different: it IS a refund of a real sale, so it
 * is subtracted rather than ignored.
 *
 * `totalAmount` is stored NET (see conventions), so `netExpected` deducts only
 * refunds — subtracting discounts again would double-count them.
 *
 * Exported for tests; pure so it can be exercised without DynamoDB.
 */
export function summarizeDailyRevenue(allOrders: any[]) {
  const soldOrders = allOrders.filter(o =>
    (o.status === 'ARCHIVED' || o.status === 'READY') && o.postCompletionCancel !== true
  );
  const refundedOrders = allOrders.filter(o => o.postCompletionCancel === true);

  const totalRevenue = soldOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0);
  const totalOffsets = soldOrders.reduce((s, o) => s + Number(o.discountOffset || 0), 0);
  const totalRefunds = refundedOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0);

  return {
    soldOrders,
    totalOrders: soldOrders.length,
    totalRevenue,
    totalOffsets,
    totalRefunds,
    netExpected: totalRevenue - totalRefunds,
    newcomersServed: soldOrders.filter(o => isNewcomerOrder(o)).length,
  };
}

/**
 * Gather and send the summary for one Malaysian calendar date.
 *
 * `date` MUST be a MYT date from `malaysiaToday()`, never a UTC one. The cron
 * fires at several times of day and every run has to agree on which service it
 * is reporting; deriving the date from `new Date().toISOString()` (as the old
 * code did) puts any order placed before 08:00 MYT on the previous day and
 * silently drops it from the totals.
 *
 * Returns whatever `sendEmail` returned, so the caller can log it and decide
 * whether to record the once-per-day marker. NEVER discard this boolean — a
 * `false` here is the difference between "sent" and "silently skipped".
 */
export async function sendDailySummaryEmail(date: string): Promise<boolean> {
  // Query every status so item counts and the low-stock context still reflect
  // the whole day, then narrow to the revenue-bearing subset below.
  const statuses = ['PENDING', 'PREPARING', 'READY', 'ARCHIVED', 'EXPIRED', 'CANCELLED'];
  const allOrders: any[] = [];

  // `createdAt` is a UTC ISO string, so the cutoff must be the UTC instant MYT
  // midnight fell on — not the bare MYT date. `createdAt >= '2026-08-16'` would
  // exclude an order placed at 07:30 MYT that Sunday, because its `createdAt`
  // reads `2026-08-15T23:30:00Z`.
  const since = malaysiaDayStartUtc(date);

  for (const status of statuses) {
    // Paginate: a Query returns at most 1MB. A busy Sunday can exceed that for
    // ARCHIVED, which would silently drop orders from the totals.
    let lastKey: Record<string, any> | undefined = undefined;
    do {
      const r: any = await docClient.send(new QueryCommand({
        TableName: ORDERS_TABLE,
        IndexName: 'status-createdAt-index',
        KeyConditionExpression: '#s = :s AND createdAt >= :today',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status, ':today': since },
        ExclusiveStartKey: lastKey,
      }));
      allOrders.push(...(r.Items || []));
      lastKey = r.LastEvaluatedKey;
    } while (lastKey);
  }

  const { soldOrders, totalOrders, totalRevenue, totalOffsets, totalRefunds, netExpected, newcomersServed } =
    summarizeDailyRevenue(allOrders);

  // Item counts come from the sold subset: they drive the "top items" list and
  // the kitchen's sense of what moved, not the money.
  const itemCounts: Record<string, number> = {};
  for (const o of soldOrders) {
    for (const i of o.items || []) {
      const key = i.name + (i.variant ? ` (${i.variant})` : '');
      itemCounts[key] = (itemCounts[key] || 0) + (i.quantity || 1);
    }
  }
  const topItems = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, qty]) => ({ name, qty }));

  const ingredientResult = await docClient.send(new ScanCommand({
    TableName: INGREDIENTS_TABLE,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
    ExpressionAttributeValues: { ':prefix': 'INGREDIENT#', ':sk': 'META' },
  }));
  const lowStockItems = (ingredientResult.Items || [])
    .filter((i: any) => i.currentStock <= (i.lowStockThreshold || 0) && i.lowStockThreshold > 0)
    .map((i: any) => ({ name: i.name, currentStock: i.currentStock, unit: i.unit }));

  return sendEndOfDaySummary({
    date, totalOrders, totalRevenue, totalOffsets, totalRefunds,
    netExpected, newcomersServed, topItems, lowStockItems,
  });
}
