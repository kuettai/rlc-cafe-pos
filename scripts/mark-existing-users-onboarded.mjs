import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = 'ap-southeast-5';
const TABLE = process.env.USERS_TABLE || 'rlc-cafe-users';
const client = new DynamoDBClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(client);

const ALL_STEPS = ['approve','mark-ready','collect','walk-up','menu-toggle','stock-count','open-close'];

const result = await doc.send(new ScanCommand({ TableName: TABLE }));
const users = (result.Items || []).filter(i => i.SK === 'META');

let updated = 0;
for (const user of users) {
  if (user.onboardingComplete === true) { console.log(`  ⏭ ${user.name} — already complete`); continue; }
  await doc.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: user.PK, SK: user.SK },
    UpdateExpression: 'SET onboardingComplete = :c, onboardingProgress = :p',
    ExpressionAttributeValues: { ':c': true, ':p': ALL_STEPS },
  }));
  console.log(`  ✓ ${user.name} — marked onboarding complete`);
  updated++;
}
console.log(`\nDone. Updated ${updated} of ${users.length} users.`);
