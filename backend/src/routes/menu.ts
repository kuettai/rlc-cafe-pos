import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { docClient, MENU_TABLE, ScanCommand } from '../lib/db';

export async function handleMenu(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (event.httpMethod === 'GET' && event.path === '/api/menu') {
    const result = await docClient.send(new ScanCommand({
      TableName: MENU_TABLE,
      FilterExpression: 'isActive = :active AND isEnabledToday = :enabled',
      ExpressionAttributeValues: { ':active': true, ':enabled': true },
    }));

    const items = (result.Items || []).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return { statusCode: 200, headers: {}, body: JSON.stringify({ items }) };
  }

  return { statusCode: 404, headers: {}, body: JSON.stringify({ error: 'Not found' }) };
}
