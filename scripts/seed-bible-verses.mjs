import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(join(__dirname, '..', 'backend', 'package.json'));

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuid } = require('uuid');

const REGION = 'ap-southeast-5';
const TABLE = process.env.SETTINGS_TABLE || 'rlc-cafe-settings';
const client = new DynamoDBClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(client);

const VERSES = [
  { text: "Come to me, all you who are weary and burdened, and I will give you rest.", reference: "Matthew 11:28" },
  { text: "The Lord is my shepherd, I lack nothing.", reference: "Psalm 23:1" },
  { text: "I can do all this through him who gives me strength.", reference: "Philippians 4:13" },
  { text: "For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life.", reference: "John 3:16" },
  { text: "Trust in the Lord with all your heart and lean not on your own understanding.", reference: "Proverbs 3:5" },
  { text: "Be strong and courageous. Do not be afraid; do not be discouraged, for the Lord your God will be with you wherever you go.", reference: "Joshua 1:9" },
  { text: "And we know that in all things God works for the good of those who love him.", reference: "Romans 8:28" },
  { text: "The joy of the Lord is your strength.", reference: "Nehemiah 8:10" },
  { text: "Cast all your anxiety on him because he cares for you.", reference: "1 Peter 5:7" },
  { text: "But those who hope in the Lord will renew their strength. They will soar on wings like eagles.", reference: "Isaiah 40:31" },
  { text: "Peace I leave with you; my peace I give you. I do not give to you as the world gives. Do not let your hearts be troubled and do not be afraid.", reference: "John 14:27" },
  { text: "Taste and see that the Lord is good; blessed is the one who takes refuge in him.", reference: "Psalm 34:8" },
  { text: "Every good and perfect gift is from above, coming down from the Father of the heavenly lights.", reference: "James 1:17" },
  { text: "Delight yourself in the Lord, and he will give you the desires of your heart.", reference: "Psalm 37:4" },
  { text: "Give thanks to the Lord, for he is good; his love endures forever.", reference: "Psalm 107:1" },
];

for (const v of VERSES) {
  const verseId = uuid();
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `BIBLE_VERSE#${verseId}`, SK: 'META', verseId,
      text: v.text, reference: v.reference,
      isActive: true, createdAt: new Date().toISOString(),
    },
  }));
  console.log(`✓ ${v.reference}`);
}
console.log(`\n✓ Seeded ${VERSES.length} Bible verses.`);
