import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { docClient, SETTINGS_TABLE, ScanCommand } from '../lib/db';

const res = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export async function handleVerses(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;

  if (method === 'GET' && path === '/api/verses/random') {
    const result = await docClient.send(new ScanCommand({
      TableName: SETTINGS_TABLE,
      FilterExpression: 'begins_with(PK, :prefix) AND isActive = :active',
      ExpressionAttributeValues: { ':prefix': 'BIBLE_VERSE#', ':active': true },
    }));
    const verses = result.Items || [];
    if (!verses.length) return res(200, { verse: null });
    const pick = verses[Math.floor(Math.random() * verses.length)];
    return res(200, { verse: { text: pick.text, reference: pick.reference } });
  }

  return res(404, { error: 'Not found' });
}
