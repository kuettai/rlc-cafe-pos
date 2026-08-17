import { ScheduledEvent } from 'aws-lambda';
import { docClient, ORDERS_TABLE, MENU_TABLE, INGREDIENTS_TABLE, SETTINGS_TABLE, QueryCommand, UpdateCommand, ScanCommand, GetCommand, PutCommand } from './lib/db';
import { sendLowStockAlert } from './lib/email';
import { logOrder } from './lib/audit';
import { getPreorderCode } from './routes/preorder';

export async function handler(_event: ScheduledEvent): Promise<void> {
  console.log('[expiry] handler invoked at %s, source: %s', new Date().toISOString(), _event.source || 'unknown');

  // Expire PENDING orders older than 1 hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const pendingResult = await docClient.send(new QueryCommand({
    TableName: ORDERS_TABLE,
    IndexName: 'status-createdAt-index',
    KeyConditionExpression: '#s = :status AND createdAt < :cutoff',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': 'PENDING', ':cutoff': oneHourAgo },
  }));

  for (const order of pendingResult.Items || []) {
    // Pre-orders live in PENDING BY DESIGN since v1.71 (that is what makes them
    // editable by the customer; the cashier's approve is the lock). They are
    // placed days ahead of the service they are for, so this 1-hour sweep must
    // never touch them — skipping here is exactly what lets a Wednesday
    // pre-order survive to Sunday. Their own expiry is `expirePreOrders()`
    // below, keyed on the ISO service-end time.
    if (order.isPreOrder === true) continue;

    await docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { PK: order.PK, SK: 'META' },
      UpdateExpression: 'SET #s = :expired, updatedAt = :now REMOVE expiresAt',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':expired': 'EXPIRED', ':now': new Date().toISOString() },
    }));

    logOrder('TTL_EXPIRE', order.orderId, {
      customer: order.customerName,
      total: order.totalAmount,
      reason: 'pending too long',
    });

    for (const item of order.items || []) {
      if (item.category === 'FOOD') {
        await docClient.send(new UpdateCommand({
          TableName: MENU_TABLE,
          Key: { PK: `MENU#${item.menuItemId}`, SK: 'META' },
          UpdateExpression: 'SET foodReserved = foodReserved - :qty',
          ExpressionAttributeValues: { ':qty': item.quantity || 1 },
        }));
      }
    }
  }

  // Auto-archive READY orders older than archiveAfterMinutes (default 15).
  await autoArchiveReadyOrders();

  // Expire pre-orders that are past their service-end time.
  await expirePreOrders();

  // Check low stock and send alert (max once per hour)
  await checkLowStock();

  console.log('[expiry] handler completed');
}

/**
 * Expire pre-orders (isPreOrder = true) whose `expiresAt` (ISO datetime,
 * usually 3PM MYT on service date) is in the past. Non-terminal states only —
 * completed and cancelled orders are already terminal.
 *
 * PENDING is in that list and is load-bearing. Since v1.71 pre-orders are
 * CREATED PENDING so the customer can edit them, and the 1-hour PENDING sweep in
 * `handler()` deliberately skips them. Nothing else expires a PENDING order once
 * `closeCafe` also skips pre-orders — so without PENDING here, a pre-order the
 * customer never got approved would sit in the queue forever, past its service,
 * for as long as the table lives.
 *
 * Pre-order expiresAt is stored as an ISO string (unlike the numeric
 * unix-seconds TTL on regular orders), so the comparison is by string
 * ordering of ISO timestamps, which is lexicographically valid. Do not
 * normalise it to a number: numeric would arm a real DynamoDB TTL on a record
 * that is meant to live for days, and the row would just vanish.
 *
 * ── Recovering a pre-order that has LOST its expiresAt ────────────────────
 * A pre-order with no usable (string) `expiresAt` would be immortal: this sweep
 * used to `continue` past it, the 1-hour PENDING sweep skips all pre-orders by
 * design, and `closeCafe` skips them too. So when the field is missing (or has
 * somehow been written as a number) we resolve the cutoff from the linked
 * `PREORDER_CODE#` record's `serviceEndTime` instead, and backfill it as an ISO
 * string so later runs need no lookup and the field is auditable again.
 *
 * This repair lives HERE and not in `undoToPending` (`pos.ts`) deliberately:
 *
 *   - `undoToPending` is a hot cashier swipe action that today does zero reads.
 *     Restoring `expiresAt` there would need a Get on the order plus a Get on
 *     the code record, adding latency to a gesture volunteers use during rush —
 *     and it would only cover the one route that can produce the state.
 *   - The cron is not user-facing and self-heals the record HOWEVER it lost the
 *     field, including if a future change stops `approveOrder` preserving it.
 *     That is exactly the class of regression this repo keeps re-learning.
 *
 * If the code record is gone or carries no `serviceEndTime` the order is skipped
 * and logged rather than expired against a guessed cutoff.
 */
async function expirePreOrders(): Promise<void> {
  const nowIso = new Date().toISOString();
  // One lookup per distinct code per sweep, not per order.
  const codeCache = new Map<string, string | null>();

  /** Service-end time for a pre-order code, or null if unresolvable. */
  async function serviceEndFor(code: unknown): Promise<string | null> {
    const key = String(code ?? '').trim().toUpperCase();
    if (!key) return null;
    if (codeCache.has(key)) return codeCache.get(key) ?? null;
    const rec = await getPreorderCode(key);
    const end = rec?.serviceEndTime;
    // Must be a non-empty STRING. A numeric value here would be meaningless as
    // a cutoff and must never be copied onto the order — see the TTL note above.
    const resolved = typeof end === 'string' && end.trim() ? end : null;
    codeCache.set(key, resolved);
    return resolved;
  }

  for (const status of ['PENDING', 'PREPARING', 'READY']) {
    const r = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
    }));
    for (const order of r.Items || []) {
      if (order.isPreOrder !== true) continue;

      const stored = typeof order.expiresAt === 'string' && order.expiresAt ? order.expiresAt : null;
      let cutoff = stored;
      if (!cutoff) {
        cutoff = await serviceEndFor(order.preorderCode);
        if (!cutoff) {
          console.warn(
            '[expiry] pre-order %s (%s) has no usable expiresAt and its code %s could not supply a serviceEndTime — skipped',
            order.orderId, status, order.preorderCode || '(none)',
          );
          continue;
        }
      }

      if (cutoff >= nowIso) {
        // Not due yet. Backfill the recovered value so subsequent runs need no
        // lookup and the field is visible again. Guarded on the status so a
        // concurrent approve/cancel wins; ALWAYS a string, never numeric, and
        // only on an isPreOrder record. Writing it also disarms any stray
        // NUMERIC expiresAt that put us on this branch in the first place.
        //
        // No backfill on the expiring path below: that update REMOVEs expiresAt
        // on the way to EXPIRED, as every terminal transition does, so the write
        // would be undone immediately.
        if (!stored) {
          try {
            await docClient.send(new UpdateCommand({
              TableName: ORDERS_TABLE,
              Key: { PK: order.PK, SK: 'META' },
              UpdateExpression: 'SET expiresAt = :ea, updatedAt = :now',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':ea': cutoff, ':now': nowIso, ':prev': status },
              ConditionExpression: '#s = :prev',
            }));
            console.log('[expiry] backfilled ISO expiresAt %s onto pre-order %s', cutoff, order.orderId);
          } catch (e: any) {
            if (e.name !== 'ConditionalCheckFailedException') throw e;
            // Status changed under us — leave it alone.
          }
        }
        continue;
      }

      try {
        await docClient.send(new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { PK: order.PK, SK: 'META' },
          UpdateExpression: 'SET #s = :expired, updatedAt = :now REMOVE expiresAt',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':expired': 'EXPIRED', ':now': nowIso, ':prev': status },
          ConditionExpression: '#s = :prev',
        }));
        logOrder('TTL_EXPIRE', order.orderId, {
          customer: order.customerName,
          prevStatus: status,
          reason: 'pre-order past service end',
        });
      } catch (e: any) {
        if (e.name !== 'ConditionalCheckFailedException') throw e;
        // Status changed under us — skip.
      }
    }
  }
}

/**
 * Archive READY orders that have been ready longer than the configured
 * threshold. Reads `archiveAfterMinutes` from the Settings record (fallback 15).
 *
 * Threshold is computed from `readyAt`. Orders predating this feature won't
 * have a `readyAt` attribute; for those we fall back to `updatedAt` and
 * backfill `readyAt` so the next pass uses the correct field.
 *
 * The Update is guarded by a status precondition so a cashier "Undo" mid-cron
 * silently no-ops instead of clobbering the order.
 */
async function autoArchiveReadyOrders(): Promise<void> {
  const settingsResult = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: 'SETTINGS', SK: 'CONFIG' },
  }));
  const archiveAfterMinutes = Number(settingsResult.Item?.archiveAfterMinutes) || 15;
  const cutoffMs = Date.now() - archiveAfterMinutes * 60 * 1000;

  // Query all current READY orders. At any point during service this is
  // typically <20 orders, so an in-memory filter is cheaper than maintaining
  // a second GSI on readyAt.
  const readyResult = await docClient.send(new QueryCommand({
    TableName: ORDERS_TABLE,
    IndexName: 'status-createdAt-index',
    KeyConditionExpression: '#s = :status',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': 'READY' },
  }));

  const now = new Date().toISOString();

  for (const order of readyResult.Items || []) {
    const readyAt: string | undefined = order.readyAt || order.updatedAt;
    if (!readyAt) continue;
    if (new Date(readyAt).getTime() >= cutoffMs) continue;

    const needsBackfill = !order.readyAt && order.updatedAt;

    try {
      await docClient.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { PK: order.PK, SK: 'META' },
        UpdateExpression: needsBackfill
          ? 'SET #s = :archived, updatedAt = :now, readyAt = :readyAt'
          : 'SET #s = :archived, updatedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: needsBackfill
          ? { ':archived': 'ARCHIVED', ':now': now, ':prev': 'READY', ':readyAt': order.updatedAt }
          : { ':archived': 'ARCHIVED', ':now': now, ':prev': 'READY' },
        ConditionExpression: '#s = :prev',
      }));
    } catch (e: any) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      // Status changed (e.g. cashier undid back to PREPARING) — silently skip.
    }
  }
}

async function checkLowStock() {
  // Send low stock alert:
  // - Sunday: only on the last cron run (after 2:30pm MYT)
  // - Wednesday: always (triggered by dedicated midweek rule at 12pm MYT)
  const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000); // UTC+8
  const day = nowMYT.getUTCDay(); // 0=Sun, 3=Wed
  const hour = nowMYT.getUTCHours();
  console.log('[checkLowStock] day=%d hour=%d nowMYT=%s', day, hour, nowMYT.toISOString());

  if (day === 0 && hour < 14) {
    console.log('[checkLowStock] skipped — Sunday before 2:30pm MYT');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const alertKey = `LOW_STOCK_ALERT#${today}`;

  const lastAlert = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: alertKey, SK: 'META' },
  }));

  // Only send once per day
  if (lastAlert.Item?.lastSent) {
    console.log('[checkLowStock] skipped — alert already sent today (%s)', lastAlert.Item.lastSent);
    return;
  }

  const ingredientResult = await docClient.send(new ScanCommand({
    TableName: INGREDIENTS_TABLE,
    FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
    ExpressionAttributeValues: { ':prefix': 'INGREDIENT#', ':sk': 'META' },
  }));

  const allIngredients = ingredientResult.Items || [];
  const lowItems = allIngredients.filter(
    (i: any) => i.currentStock <= (i.lowStockThreshold || 0) && i.lowStockThreshold > 0
  );

  console.log('[checkLowStock] scanned %d ingredients, %d below threshold', allIngredients.length, lowItems.length);
  if (lowItems.length > 0) {
    console.log('[checkLowStock] low items: %s', JSON.stringify(lowItems.map((i: any) => ({ name: i.name, stock: i.currentStock, threshold: i.lowStockThreshold }))));
  }

  if (lowItems.length === 0) return;

  const sent = await sendLowStockAlert(lowItems.map((i: any) => ({
    name: i.name,
    currentStock: i.currentStock,
    unit: i.unit,
    threshold: i.lowStockThreshold,
  })));

  console.log('[checkLowStock] sendLowStockAlert returned: %s', sent);

  if (sent) {
    await docClient.send(new PutCommand({
      TableName: SETTINGS_TABLE,
      Item: { PK: alertKey, SK: 'META', lastSent: new Date().toISOString(), itemCount: lowItems.length },
    }));
    console.log('[checkLowStock] alert recorded for %s (%d items)', alertKey, lowItems.length);
  }
}
