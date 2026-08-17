import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const SSM_PREFIX = '/rlc-cafe/';

interface EmailConfig {
  gmailUser: string;
  gmailAppPassword: string;
  notificationEmail: string;
}

interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Fallback contact for the VAPID `sub` claim when `/rlc-cafe/VAPID_SUBJECT` is
 * absent. Must be a real, resolvable mailto: or https: URL — push services (APNs
 * in particular) treat it as the operator contact and may reject a bogus domain.
 * The previous default was `mailto:admin@rlccafe.com`, a domain this project does
 * not own.
 */
const DEFAULT_VAPID_SUBJECT = 'https://153.oasisofcare.org';

/**
 * One cache for the whole `/rlc-cafe/` parameter set. Every consumer
 * (`getEmailConfig`, `getVapidConfig`) reads from it, so a warm Lambda makes at
 * most one SSM round trip per TTL window no matter how many configs it needs.
 */
let cachedParams: Record<string, string> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch every parameter under `/rlc-cafe/`, with caching.
 *
 * PAGINATES on NextToken. `GetParametersByPath` returns at most 10 parameters per
 * call by default, and the prefix already holds 7 — silent truncation here would
 * look exactly like "the config was never set", which is the failure mode this
 * module exists to prevent (see the VAPID outage: web push was dead for weeks
 * because a missing value was indistinguishable from a disabled feature).
 *
 * Returns `{}` — never throws — when SSM is unreachable, so callers fall back to
 * `process.env` for local dev.
 */
async function loadSsmParams(): Promise<Record<string, string>> {
  if (cachedParams && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedParams;
  }

  const params: Record<string, string> = {};
  try {
    let nextToken: string | undefined;
    do {
      const result = await ssm.send(new GetParametersByPathCommand({
        Path: SSM_PREFIX,
        WithDecryption: true,
        MaxResults: 10,
        NextToken: nextToken,
      }));
      for (const p of result.Parameters || []) {
        const key = p.Name?.replace(SSM_PREFIX, '') || '';
        params[key] = p.Value || '';
      }
      nextToken = result.NextToken;
    } while (nextToken);
  } catch (err) {
    console.warn('[ssm-config] Failed to load from SSM, falling back to env:', (err as Error).message);
  }

  cachedParams = params;
  cacheTimestamp = Date.now();
  return params;
}

/** Test seam / deploy-time escape hatch: drop the cached parameter set. */
export function resetSsmConfigCache(): void {
  cachedParams = null;
  cacheTimestamp = 0;
}

/**
 * Load email config from SSM Parameter Store with in-memory caching.
 * Falls back to process.env for local dev / backward compat.
 */
export async function getEmailConfig(): Promise<EmailConfig> {
  const params = await loadSsmParams();

  if (params['GMAIL_USER'] && params['GMAIL_APP_PASSWORD']) {
    return {
      gmailUser: params['GMAIL_USER'],
      gmailAppPassword: params['GMAIL_APP_PASSWORD'],
      notificationEmail: params['NOTIFICATION_EMAIL'] || '',
    };
  }

  // Fallback to process.env
  return {
    gmailUser: process.env.GMAIL_USER || '',
    gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
    notificationEmail: process.env.NOTIFICATION_EMAIL || '',
  };
}

/**
 * Load Web Push VAPID config from SSM Parameter Store, cached alongside the
 * email config.
 *
 * `/rlc-cafe/VAPID_PRIVATE_KEY` is a SecureString; the public key and subject are
 * plain Strings (the public key is served to every browser by
 * `GET /api/push/vapid-public-key`, so it is not a secret).
 *
 * Why SSM and not the Lambda environment: the keys used to be env vars defaulted
 * to `''` in the CDK stack, so any `cdk deploy` from a shell that had not exported
 * them wiped web push silently. Nothing in the deploy path can wipe a parameter.
 *
 * `process.env` remains a fallback for local dev only.
 */
export async function getVapidConfig(): Promise<VapidConfig> {
  const params = await loadSsmParams();

  if (params['VAPID_PUBLIC_KEY'] && params['VAPID_PRIVATE_KEY']) {
    return {
      publicKey: params['VAPID_PUBLIC_KEY'],
      privateKey: params['VAPID_PRIVATE_KEY'],
      subject: params['VAPID_SUBJECT'] || process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
    };
  }

  return {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
  };
}
