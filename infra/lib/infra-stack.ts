import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaBase from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── DynamoDB Tables ───────────────────────────────────────────────

    const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      tableName: 'rlc-cafe-orders',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    ordersTable.addGlobalSecondaryIndex({
      indexName: 'status-createdAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    const menuTable = new dynamodb.Table(this, 'MenuTable', {
      tableName: 'rlc-cafe-menu',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ingredientsTable = new dynamodb.Table(this, 'IngredientsTable', {
      tableName: 'rlc-cafe-ingredients',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'rlc-cafe-users',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const settingsTable = new dynamodb.Table(this, 'SettingsTable', {
      tableName: 'rlc-cafe-settings',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── Lambda Functions (bundled with esbuild) ───────────────────────

    const backendPath = path.join(__dirname, '../../backend/src');
    const projectRoot = path.join(__dirname, '../..');

    const apiHandler = new lambda.NodejsFunction(this, 'ApiHandler', {
      functionName: 'rlc-cafe-api',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      entry: path.join(backendPath, 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      projectRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
      },
      environment: {
        ORDERS_TABLE: ordersTable.tableName,
        MENU_TABLE: menuTable.tableName,
        INGREDIENTS_TABLE: ingredientsTable.tableName,
        USERS_TABLE: usersTable.tableName,
        SETTINGS_TABLE: settingsTable.tableName,
        JWT_SECRET: 'CHANGE_ME_BEFORE_DEPLOY',
      },
    });

    ordersTable.grantReadWriteData(apiHandler);
    menuTable.grantReadWriteData(apiHandler);
    ingredientsTable.grantReadWriteData(apiHandler);
    usersTable.grantReadWriteData(apiHandler);
    settingsTable.grantReadWriteData(apiHandler);

    // ─── Order Expiry Cron ─────────────────────────────────────────────

    const expiryHandler = new lambda.NodejsFunction(this, 'ExpiryHandler', {
      functionName: 'rlc-cafe-order-expiry',
      runtime: lambdaBase.Runtime.NODEJS_20_X,
      entry: path.join(backendPath, 'expiry.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      projectRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        forceDockerBundling: false,
      },
      environment: {
        ORDERS_TABLE: ordersTable.tableName,
        MENU_TABLE: menuTable.tableName,
      },
    });

    ordersTable.grantReadWriteData(expiryHandler);
    menuTable.grantReadWriteData(expiryHandler);

    new events.Rule(this, 'OrderExpiryCron', {
      ruleName: 'rlc-cafe-order-expiry',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(expiryHandler)],
    });

    // ─── API Gateway (proxy integration) ───────────────────────────────

    const api = new apigateway.LambdaRestApi(this, 'CafeApi', {
      restApiName: 'rlc-cafe-api',
      handler: apiHandler,
      proxy: true,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // ─── Outputs ───────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway endpoint URL',
    });
  }
}
