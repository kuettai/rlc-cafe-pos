import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { docClient, SETTINGS_TABLE, GetCommand, PutCommand, ScanCommand } from '../lib/db';

function res(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function handleChecklist(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // GET /api/pos/checklist — get checklist config + today's completion status
    if (method === 'GET' && path.endsWith('/checklist')) {
      const config = await getChecklistConfig();
      // POS only sees enabled items (enabled === false hides them).
      // Missing 'enabled' is treated as enabled for backward compat.
      const filterEnabled = (list: any[]) => list.filter((i: any) => i.enabled !== false);
      const posConfig = {
        open: filterEnabled(config.open || []),
        close: filterEnabled(config.close || []),
        handover: filterEnabled(config.handover || []),
      };
      const today = new Date().toISOString().split('T')[0];
      const log = await getChecklistLog(today);
      return res(200, { config: posConfig, log });
    }

    // PUT /api/pos/checklist/check — mark an item as checked
    if (method === 'PUT' && path.endsWith('/checklist/check')) {
      const { phase, itemId, value, completedBy } = body;
      if (!phase || !itemId) return res(400, { error: 'phase and itemId required' });
      if (!['open', 'close', 'handover'].includes(phase)) return res(400, { error: 'invalid phase' });

      const today = new Date().toISOString().split('T')[0];
      const logKey = `CHECKLIST_LOG#${today}#${phase}`;

      const existing = await docClient.send(new GetCommand({
        TableName: SETTINGS_TABLE,
        Key: { PK: logKey, SK: 'META' },
      }));

      const items = existing.Item?.items || {};
      items[itemId] = {
        checked: true,
        value: value || null,
        completedBy: completedBy || 'Unknown',
        completedAt: new Date().toISOString(),
      };

      const allConfig = await getChecklistConfig();
      const phaseItems = phase === 'open'
        ? allConfig.open
        : phase === 'close'
          ? allConfig.close
          : allConfig.handover;
      const allChecked = (phaseItems || []).every((i: any) => items[i.id]?.checked);

      await docClient.send(new PutCommand({
        TableName: SETTINGS_TABLE,
        Item: {
          PK: logKey,
          SK: 'META',
          date: today,
          phase,
          items,
          allCompleted: allChecked,
          lastUpdated: new Date().toISOString(),
        },
      }));

      return res(200, { itemId, checked: true, allCompleted: allChecked });
    }

    // PUT /api/pos/checklist/uncheck — uncheck an item
    if (method === 'PUT' && path.endsWith('/checklist/uncheck')) {
      const { phase, itemId } = body;
      if (!phase || !itemId) return res(400, { error: 'phase and itemId required' });
      if (!['open', 'close', 'handover'].includes(phase)) return res(400, { error: 'invalid phase' });

      const today = new Date().toISOString().split('T')[0];
      const logKey = `CHECKLIST_LOG#${today}#${phase}`;

      const existing = await docClient.send(new GetCommand({
        TableName: SETTINGS_TABLE,
        Key: { PK: logKey, SK: 'META' },
      }));

      const items = existing.Item?.items || {};
      delete items[itemId];

      await docClient.send(new PutCommand({
        TableName: SETTINGS_TABLE,
        Item: {
          PK: logKey,
          SK: 'META',
          date: today,
          phase,
          items,
          allCompleted: false,
          lastUpdated: new Date().toISOString(),
        },
      }));

      return res(200, { itemId, checked: false, allCompleted: false });
    }

    // Admin: GET /api/admin/checklist/config
    if (method === 'GET' && path.endsWith('/checklist/config')) {
      const config = await getChecklistConfig();
      return res(200, config);
    }

    // Admin: PUT /api/admin/checklist/config — save full config
    if (method === 'PUT' && path.endsWith('/checklist/config')) {
      const { open, close, handover } = body;
      await docClient.send(new PutCommand({
        TableName: SETTINGS_TABLE,
        Item: {
          PK: 'CHECKLIST_CONFIG',
          SK: 'META',
          open: open || [],
          close: close || [],
          handover: handover || [],
          updatedAt: new Date().toISOString(),
        },
      }));
      return res(200, { updated: true });
    }

    // Admin: GET /api/admin/checklist/logs — get historical logs
    if (method === 'GET' && path.endsWith('/checklist/logs')) {
      const result = await docClient.send(new ScanCommand({
        TableName: SETTINGS_TABLE,
        FilterExpression: 'begins_with(PK, :prefix)',
        ExpressionAttributeValues: { ':prefix': 'CHECKLIST_LOG#' },
      }));
      const logs = (result.Items || []).sort((a: any, b: any) => b.date?.localeCompare(a.date));
      return res(200, { logs });
    }

    return res(404, { error: 'Not found' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return res(500, { error: message });
  }
}

async function getChecklistConfig() {
  const result = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: 'CHECKLIST_CONFIG', SK: 'META' },
  }));

  if (result.Item) {
    return {
      open: result.Item.open || [],
      close: result.Item.close || [],
      handover: result.Item.handover || defaultHandover(),
    };
  }

  // Default checklist if none configured
  return {
    open: [
      { id: 'open-1', label: 'Turn on coffee machine', type: 'checkbox', enabled: true },
      { id: 'open-2', label: 'Fill ice container', type: 'checkbox', enabled: true },
      { id: 'open-3', label: 'Fill hot water in kettle', type: 'checkbox', enabled: true },
      { id: 'open-4', label: 'Set out food items', type: 'checkbox', enabled: true },
      { id: 'open-5', label: 'Enable menu items in POS', type: 'checkbox', enabled: true },
      { id: 'open-6', label: 'Confirm QR code is visible', type: 'checkbox', enabled: true },
      { id: 'open-7', label: 'Test shot (machine warm-up)', type: 'checkbox', enabled: true },
      { id: 'open-8', label: 'Capture fridge photo (stock count)', type: 'image', enabled: true },
      { id: 'open-9', label: 'Capture store room photo (stock count)', type: 'image', enabled: true },
    ],
    close: [
      { id: 'close-1', label: 'Clean up', type: 'checkbox', enabled: true },
      { id: 'close-2', label: 'Empty coffee grounds', type: 'checkbox', enabled: true },
      { id: 'close-3', label: 'Return unused milk to fridge', type: 'checkbox', enabled: true },
      { id: 'close-4', label: 'Close aircon & music', type: 'checkbox', enabled: true },
      { id: 'close-5', label: 'Turn off fridge light', type: 'checkbox', enabled: true },
      { id: 'close-6', label: 'Turn off coffee machines & cover up', type: 'checkbox', enabled: true },
      { id: 'close-7', label: 'Capture fridge photo (stock count)', type: 'image', enabled: true },
      { id: 'close-8', label: 'Capture store room photo (stock count)', type: 'image', enabled: true },
    ],
    handover: defaultHandover(),
  };
}

function defaultHandover() {
  return [
    { id: 'handover-1', label: 'Wipe counters for 2nd service team', type: 'checkbox', enabled: true },
    { id: 'handover-2', label: 'Tally 1st service orders', type: 'checkbox', enabled: true },
    { id: 'handover-3', label: 'Refill all items if needed', type: 'checkbox', enabled: true },
  ];
}

async function getChecklistLog(date: string) {
  const openLog = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: `CHECKLIST_LOG#${date}#open`, SK: 'META' },
  }));
  const closeLog = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: `CHECKLIST_LOG#${date}#close`, SK: 'META' },
  }));
  const handoverLog = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: `CHECKLIST_LOG#${date}#handover`, SK: 'META' },
  }));
  return {
    open: openLog.Item || { items: {}, allCompleted: false },
    close: closeLog.Item || { items: {}, allCompleted: false },
    handover: handoverLog.Item || { items: {}, allCompleted: false },
  };
}
