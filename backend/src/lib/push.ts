import webpush from 'web-push';
import { docClient, SETTINGS_TABLE, QueryCommand, DeleteCommand } from './db';

// Configure VAPID — keys come from environment
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@rlccafe.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

export async function sendOrderPush(orderId: string, title: string, body: string): Promise<void> {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return; // VAPID not configured, skip silently

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
