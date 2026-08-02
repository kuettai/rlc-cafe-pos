/**
 * Audit logging for order write operations. Each event goes to CloudWatch
 * as a single line prefixed with `[ORDER]` so it's cheap to grep. Call
 * only AFTER the DB write has succeeded — a log without a corresponding
 * write is worse than no log because it invites false forensic trails.
 *
 * Convention: `[ORDER] <ACTION> orderId=<uuid> key=value ...`
 * Empty / null / undefined values are elided.
 */
export function logOrder(action: string, orderId: string, extra: Record<string, unknown> = {}): void {
  const parts: string[] = ['[ORDER]', action, `orderId=${orderId}`];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${s}`);
  }
  // eslint-disable-next-line no-console
  console.log(parts.join(' '));
}

/**
 * Compact "3×Latte(Hot),1×Curry Puff" style summary of an items array.
 * Strips leading emoji from names so the log line reads cleanly.
 */
export function summarizeItems(items: any): string {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map((i: any) => {
    const name = String(i?.name || '?').replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u, '');
    const qty  = i?.quantity ?? i?.qty ?? 1;
    const v    = i?.variant ? `(${i.variant})` : '';
    return `${qty}×${name}${v}`;
  }).join(',');
}

/**
 * Audit logging for authentication events, prefixed `[AUTH]` so it greps
 * separately from order activity.
 *
 * Added after an unattributable ADMIN login on 2026-08-02: the API Lambda
 * emitted only START/END/REPORT, so there was no way to establish who logged
 * in or from where. Every login attempt — success, failure, or blocked — is
 * now recorded with source IP and user agent.
 *
 * NEVER pass a PIN, PIN hash, or token to this function.
 *
 * Convention: `[AUTH] <OUTCOME> id=<identifier> ip=<sourceIp> ...`
 */
export function logAuth(outcome: string, extra: Record<string, unknown> = {}): void {
  const parts: string[] = ['[AUTH]', outcome];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${s}`);
  }
  // eslint-disable-next-line no-console
  console.log(parts.join(' '));
}
