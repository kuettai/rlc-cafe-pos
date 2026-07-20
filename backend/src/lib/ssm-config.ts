import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const SSM_PREFIX = '/rlc-cafe/';

interface EmailConfig {
  gmailUser: string;
  gmailAppPassword: string;
  notificationEmail: string;
}

let cachedConfig: EmailConfig | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load email config from SSM Parameter Store with in-memory caching.
 * Falls back to process.env for local dev / backward compat.
 */
export async function getEmailConfig(): Promise<EmailConfig> {
  // Return cached if still fresh
  if (cachedConfig && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedConfig;
  }

  // Try SSM first
  try {
    const result = await ssm.send(new GetParametersByPathCommand({
      Path: SSM_PREFIX,
      WithDecryption: true,
    }));

    const params: Record<string, string> = {};
    for (const p of result.Parameters || []) {
      const key = p.Name?.replace(SSM_PREFIX, '') || '';
      params[key] = p.Value || '';
    }

    if (params['GMAIL_USER'] && params['GMAIL_APP_PASSWORD']) {
      cachedConfig = {
        gmailUser: params['GMAIL_USER'],
        gmailAppPassword: params['GMAIL_APP_PASSWORD'],
        notificationEmail: params['NOTIFICATION_EMAIL'] || '',
      };
      cacheTimestamp = Date.now();
      return cachedConfig;
    }
  } catch (err) {
    console.warn('[ssm-config] Failed to load from SSM, falling back to env:', (err as Error).message);
  }

  // Fallback to process.env
  cachedConfig = {
    gmailUser: process.env.GMAIL_USER || '',
    gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
    notificationEmail: process.env.NOTIFICATION_EMAIL || '',
  };
  cacheTimestamp = Date.now();
  return cachedConfig;
}
