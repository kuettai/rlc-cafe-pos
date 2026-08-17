import webpush from 'web-push';
import { docClient, SETTINGS_TABLE, QueryCommand, DeleteCommand } from './db';
import { getVapidConfig } from './ssm-config';

/**
 * VAPID configuration comes from SSM (`/rlc-cafe/VAPID_*`), the same way the
 * email credentials do — see `lib/ssm-config.ts` for why the Lambda environment
 * is not trusted with it.
 *
 * SSM is async, so the keys cannot be module-level constants any more. Every
 * entry point that needs them awaits `ensureVapidConfigured()` instead; the
 * underlying parameter fetch is cached by `ssm-config` (5-minute TTL), and
 * `setVapidDetails` is only re-applied when the public key actually changes, so a
 * warm Lambda does no extra work per push.
 */

/** The public key currently applied to the web-push singleton, if any. */
let appliedPublicKey: string | null = null;

/**
 * Resolve the VAPID config, apply it to web-push, and return the public key.
 * Returns `null` when push cannot be sent — and LOGS WHY.
 *
 * The old code did `if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;` with the comment
 * "skip silently". Production consequence: the keys were blank for weeks, no log
 * line was ever emitted, and customers who tapped "Notify me" on track.html
 * granted browser notification permission and then received nothing, forever. A
 * disabled feature must be loud.
 */
export async function ensureVapidConfigured(): Promise<string | null> {
  const config = await getVapidConfig();

  const missing: string[] = [];
  if (!config.publicKey) missing.push('VAPID_PUBLIC_KEY');
  if (!config.privateKey) missing.push('VAPID_PRIVATE_KEY');
  if (missing.length > 0) {
    appliedPublicKey = null;
    console.error(
      `[PUSH] VAPID not configured — missing ${missing.join(', ')}. Checked SSM path `
      + '/rlc-cafe/ (decrypted) and process.env. Web push is DISABLED: customers who '
      + 'granted notification permission will silently receive nothing. Fix by setting '
      + 'the parameters, e.g. aws ssm put-parameter --name /rlc-cafe/VAPID_PRIVATE_KEY '
      + '--type SecureString --value <key> --region ap-southeast-5'
    );
    return null;
  }

  if (appliedPublicKey === config.publicKey) return appliedPublicKey;

  try {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  } catch (err) {
    // Malformed keys or a subject that is not a mailto:/https: URL. web-push
    // throws here rather than at send time, so this is the only place the detail
    // exists — log it, do not swallow it.
    appliedPublicKey = null;
    console.error(
      `[PUSH] VAPID config REJECTED by web-push (subject="${config.subject}", `
      + `publicKey length=${config.publicKey.length}, privateKey length=${config.privateKey.length}): `
      + (err as Error).message
    );
    return null;
  }

  appliedPublicKey = config.publicKey;
  return appliedPublicKey;
}

/** Test seam: forget which key was applied to the web-push singleton. */
export function resetVapidState(): void {
  appliedPublicKey = null;
}

export async function sendOrderPush(orderId: string, title: string, body: string): Promise<void> {
  const publicKey = await ensureVapidConfigured();
  if (!publicKey) {
    console.error(`[PUSH] Not sending "${title}" for order ${orderId} — VAPID unavailable (see previous line).`);
    return;
  }

  try {
    const result = await docClient.send(new QueryCommand({
      TableName: SETTINGS_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `PUSH_SUB#${orderId}` },
    }));

    for (const item of result.Items || []) {
      try {
        await webpush.sendNotification(
          item.subscription,
          JSON.stringify({ title, body, orderId })
        );
      } catch (e: any) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          // Subscription expired or invalid — clean up
          await docClient.send(new DeleteCommand({
            TableName: SETTINGS_TABLE,
            Key: { PK: item.PK, SK: item.SK },
          }));
        }
        // Other errors: log and continue
        console.error('Push failed for', item.SK, e.statusCode || e.message);
      }
    }
  } catch (e) {
    console.error('sendOrderPush error:', e);
  }
}
