import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, ScanCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(client);

export const ORDERS_TABLE = process.env.ORDERS_TABLE!;
export const MENU_TABLE = process.env.MENU_TABLE!;
export const INGREDIENTS_TABLE = process.env.INGREDIENTS_TABLE!;
export const USERS_TABLE = process.env.USERS_TABLE!;
export const SETTINGS_TABLE = process.env.SETTINGS_TABLE!;
export const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE!;
export const VOUCHERS_TABLE = process.env.VOUCHERS_TABLE!;

export { GetCommand, PutCommand, QueryCommand, UpdateCommand, ScanCommand, DeleteCommand, TransactWriteCommand };
