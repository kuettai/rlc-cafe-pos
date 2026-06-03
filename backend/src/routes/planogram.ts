import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { docClient, SETTINGS_TABLE, INGREDIENTS_TABLE, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '../lib/db';

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-southeast-5' });
const PLANOGRAM_BUCKET = process.env.PLANOGRAM_BUCKET || 'rlc-cafe-planogram';

function res(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function handlePlanogram(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // POST /api/pos/planogram/analyze — upload photos and get AI stock count
    if (method === 'POST' && path.endsWith('/planogram/analyze')) {
      const { location, images } = body;
      if (!location || !images || !images.length) {
        return res(400, { error: 'location and images[] required' });
      }

      // Save photos to S3
      const today = new Date().toISOString().split('T')[0];
      const timestamp = Date.now();
      const s3Keys: string[] = [];

      for (let i = 0; i < images.length; i++) {
        const base64Match = images[i].match(/^data:([^;]+);base64,(.+)$/);
        const imgData = base64Match ? Buffer.from(base64Match[2], 'base64') : Buffer.from(images[i], 'base64');
        const contentType = base64Match ? base64Match[1] : 'image/jpeg';
        const key = `stock-count/${today}/${location}/${timestamp}-${i}.jpg`;

        await s3.send(new PutObjectCommand({
          Bucket: PLANOGRAM_BUCKET,
          Key: key,
          Body: imgData,
          ContentType: contentType,
        }));
        s3Keys.push(key);
      }

      // Get current ingredient list for context
      const ingredientResult = await docClient.send(new ScanCommand({
        TableName: INGREDIENTS_TABLE,
        FilterExpression: 'begins_with(PK, :prefix) AND SK = :sk',
        ExpressionAttributeValues: { ':prefix': 'INGREDIENT#', ':sk': 'META' },
      }));
      const ingredients = ingredientResult.Items || [];

      // Filter by storage location
      const locationFilter = location === 'fridge' ? 'FRIDGE' : 'STOREROOM';
      const relevantIngredients = ingredients.filter((i: any) => i.storageLocation === locationFilter);

      // Get reference photo if available
      const refResult = await docClient.send(new GetCommand({
        TableName: SETTINGS_TABLE,
        Key: { PK: `PLANOGRAM_REF#${location}`, SK: 'META' },
      }));
      const referenceKey = refResult.Item?.s3Key || null;

      // Prepare images for Bedrock
      const imageContents: any[] = [];
      for (const img of images) {
        const base64Match = img.match(/^data:([^;]+);base64,(.+)$/);
        const imgBase64 = base64Match ? base64Match[2] : img;
        const mediaType = base64Match ? base64Match[1] : 'image/jpeg';
        imageContents.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: imgBase64 },
        });
      }

      // If reference photo exists, add it
      if (referenceKey) {
        try {
          const refObj = await s3.send(new GetObjectCommand({
            Bucket: PLANOGRAM_BUCKET,
            Key: referenceKey,
          }));
          const refBytes = await refObj.Body?.transformToByteArray();
          if (refBytes) {
            imageContents.unshift({
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(refBytes).toString('base64') },
            });
            imageContents.unshift({
              type: 'text',
              text: 'REFERENCE IMAGE (ideal arrangement):',
            });
          }
        } catch {}
      }

      // Build ingredient context
      const ingredientList = relevantIngredients.map((i: any) =>
        `- ${i.name} (stored in ${i.unit}, usage: ${i.usageUnit || 'n/a'})`
      ).join('\n');

      // Call Bedrock
      const aiResult = await analyzeStock(imageContents, ingredientList, location);

      // Save the analysis log
      await docClient.send(new PutCommand({
        TableName: SETTINGS_TABLE,
        Item: {
          PK: `PLANOGRAM_LOG#${today}#${timestamp}`,
          SK: 'META',
          date: today,
          location,
          s3Keys,
          result: aiResult,
          confirmedAt: null,
          createdAt: new Date().toISOString(),
        },
      }));

      return res(200, {
        counts: aiResult,
        s3Keys,
        ingredients: relevantIngredients.map((i: any) => ({
          ingredientId: i.ingredientId,
          name: i.name,
          unit: i.unit,
          currentStock: i.currentStock,
        })),
      });
    }

    // POST /api/pos/planogram/confirm — confirm AI results and update stock
    if (method === 'POST' && path.endsWith('/planogram/confirm')) {
      const { counts } = body;
      if (!counts || !Array.isArray(counts)) return res(400, { error: 'counts[] required' });

      for (const item of counts) {
        if (!item.ingredientId || item.count === undefined) continue;
        await docClient.send(new UpdateCommand({
          TableName: INGREDIENTS_TABLE,
          Key: { PK: `INGREDIENT#${item.ingredientId}`, SK: 'META' },
          UpdateExpression: 'SET currentStock = :s',
          ExpressionAttributeValues: { ':s': item.count },
        }));
      }

      return res(200, { updated: counts.length });
    }

    // POST /api/admin/planogram/reference — upload reference photo
    if (method === 'POST' && path.endsWith('/planogram/reference')) {
      const { location, image } = body;
      if (!location || !image) return res(400, { error: 'location and image required' });

      const base64Match = image.match(/^data:([^;]+);base64,(.+)$/);
      const imgData = base64Match ? Buffer.from(base64Match[2], 'base64') : Buffer.from(image, 'base64');
      const contentType = base64Match ? base64Match[1] : 'image/jpeg';
      const key = `reference/${location}.jpg`;

      await s3.send(new PutObjectCommand({
        Bucket: PLANOGRAM_BUCKET,
        Key: key,
        Body: imgData,
        ContentType: contentType,
      }));

      await docClient.send(new PutCommand({
        TableName: SETTINGS_TABLE,
        Item: {
          PK: `PLANOGRAM_REF#${location}`,
          SK: 'META',
          s3Key: key,
          uploadedAt: new Date().toISOString(),
        },
      }));

      return res(200, { location, s3Key: key });
    }

    // GET /api/pos/planogram/reference/{location} — get reference photo URL
    if (method === 'GET' && path.match(/\/planogram\/reference\/(fridge|storeroom)$/)) {
      const location = path.split('/').pop()!;
      const refResult = await docClient.send(new GetCommand({
        TableName: SETTINGS_TABLE,
        Key: { PK: `PLANOGRAM_REF#${location}`, SK: 'META' },
      }));

      if (!refResult.Item?.s3Key) return res(404, { error: 'No reference photo' });

      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: PLANOGRAM_BUCKET,
        Key: refResult.Item.s3Key,
      }), { expiresIn: 3600 });

      return res(200, { location, url, uploadedAt: refResult.Item.uploadedAt });
    }

    return res(404, { error: 'Not found' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return res(500, { error: message });
  }
}

async function analyzeStock(imageContents: any[], ingredientList: string, location: string) {
  const prompt = `You are a stock counting assistant for a church café. Analyze the ${location} photos and count the items visible.

These are multiple views of the SAME ${location}. Combine counts across all images but DO NOT double-count items visible in overlapping views.

Known items that should be in this ${location}:
${ingredientList}

Instructions:
1. Count each distinct item visible across all photos (avoid double-counting from overlapping angles)
2. For transparent containers, estimate fill level as a decimal (e.g., 0.7 for 70% full)
3. For sealed non-transparent bags (like coffee beans), just count whole units
4. If an item from the list is NOT visible, set count to 0
5. If you see items not in the list, include them with a "unknown" flag

Return ONLY a JSON array:
[{"name": "Item Name", "count": <number>, "confidence": "high"|"medium"|"low", "notes": "optional note"}]

Be precise. Count carefully. If unsure about an item, set confidence to "low".`;

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        ...imageContents,
        { type: 'text', text: prompt },
      ],
    }],
  };

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: 'anthropic.claude-sonnet-4-5-v1',
    body: JSON.stringify(payload),
    contentType: 'application/json',
  }));

  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const text = responseBody.content?.[0]?.text || '';

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}

  return [];
}
