import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaBase from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
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
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const ingredientsTable = new dynamodb.Table(this, 'IngredientsTable', {
      tableName: 'rlc-cafe-ingredients',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'rlc-cafe-users',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const settingsTable = new dynamodb.Table(this, 'SettingsTable', {
      tableName: 'rlc-cafe-settings',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const customersTable = new dynamodb.Table(this, 'CustomersTable', {
      tableName: 'rlc-cafe-customers',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    ordersTable.addGlobalSecondaryIndex({
      indexName: 'customerId-createdAt-index',
      partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    const vouchersTable = new dynamodb.Table(this, 'VouchersTable', {
      tableName: 'rlc-cafe-vouchers',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    vouchersTable.addGlobalSecondaryIndex({
      indexName: 'campaignId-issuedAt-index',
      partitionKey: { name: 'campaignId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'issuedAt', type: dynamodb.AttributeType.STRING },
    });    // ─── S3 Buckets ────────────────────────────────────────────────────

    const receiptsBucket = new s3.Bucket(this, 'ReceiptsBucket', {
      bucketName: `rlc-cafe-receipts-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        expiration: cdk.Duration.days(1),
      }],
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.GET],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
      }],
    });

    const planogramBucket = new s3.Bucket(this, 'PlanogramBucket', {
      bucketName: `rlc-cafe-planogram-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        id: 'expire-after-4-weeks',
        expiration: cdk.Duration.days(28),
      }],
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.GET],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
      }],
    });

    // Display slides bucket — TV display screen promo images uploaded
    // by admin. Contents are non-sensitive marketing material. CORS is
    // permissive because uploads go directly from the admin browser via
    // a presigned PUT URL; a strict origin allowlist would just add
    // deployment friction for no security gain (the PUT is already gated
    // by the presigned URL).
    //
    // NOTE: Public read is intentionally OFF. Images are served from the
    // same origin as the frontend (/display-slides/*) via CloudFront /
    // BucketDeployment — the backend records `/display-slides/<file>`
    // as the imageUrl. If a future setup needs direct S3 access, add a
    // BucketPolicy for public GET on the display-slides/* prefix.
    const displaySlidesBucket = new s3.Bucket(this, 'DisplaySlidesBucket', {
      bucketName: `rlc-cafe-display-slides-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.GET],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
      }],
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
        CUSTOMERS_TABLE: customersTable.tableName,
        VOUCHERS_TABLE: vouchersTable.tableName,
        RECEIPTS_BUCKET: receiptsBucket.bucketName,
        PLANOGRAM_BUCKET: planogramBucket.bucketName,
        // FRONTEND_BUCKET is used by the /admin/display/upload-url endpoint
        // to generate presigned PUT URLs for TV display slide uploads.
        // Named FRONTEND_BUCKET (not DISPLAY_SLIDES_BUCKET) to match the
        // display-screen spec — the intent is that this bucket holds
        // static frontend assets when the migration off GitHub Pages
        // happens; until then, only the display-slides/ prefix is used.
        FRONTEND_BUCKET: displaySlidesBucket.bucketName,
        JWT_SECRET: 'CHANGE_ME_BEFORE_DEPLOY',
        GMAIL_USER: process.env.GMAIL_USER || '',
        GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
        NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL || '',
        // Origin verification for CloudFront front-door (see docs/cloudfront-migration.md).
        // Kept OFF until CloudFront is wired up to inject the header. When ENFORCE_ORIGIN_HEADER
        // is 'true', requests missing/mismatching X-Origin-Verify are rejected with 403.
        ORIGIN_VERIFY_SECRET: process.env.ORIGIN_VERIFY_SECRET || 'CHANGE_ME_WHEN_CLOUDFRONT_ENABLED',
        ENFORCE_ORIGIN_HEADER: process.env.ENFORCE_ORIGIN_HEADER || 'false',
        VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
        VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
        VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:admin@rlccafe.com',
      },
    });

    ordersTable.grantReadWriteData(apiHandler);
    menuTable.grantReadWriteData(apiHandler);
    ingredientsTable.grantReadWriteData(apiHandler);
    usersTable.grantReadWriteData(apiHandler);
    settingsTable.grantReadWriteData(apiHandler);
    customersTable.grantReadWriteData(apiHandler);
    vouchersTable.grantReadWriteData(apiHandler);
    receiptsBucket.grantReadWrite(apiHandler);
    planogramBucket.grantReadWrite(apiHandler);

    // Scoped write access for display slide uploads: only the
    // `display-slides/*` prefix, not the whole bucket. This is narrower
    // than grantReadWrite() so if the bucket later serves other content
    // (e.g. frontend static assets), the Lambda can't mutate those.
    apiHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:PutObjectAcl'],
      resources: [`${displaySlidesBucket.bucketArn}/display-slides/*`],
    }));

    apiHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:ap-southeast-5:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
      ],
    }));

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
        INGREDIENTS_TABLE: ingredientsTable.tableName,
        SETTINGS_TABLE: settingsTable.tableName,
        GMAIL_USER: process.env.GMAIL_USER || '',
        GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
        NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL || '',
      },
    });

    ordersTable.grantReadWriteData(expiryHandler);
    menuTable.grantReadWriteData(expiryHandler);
    ingredientsTable.grantReadData(expiryHandler);
    settingsTable.grantReadWriteData(expiryHandler);

    new events.Rule(this, 'OrderExpiryCron', {
      ruleName: 'rlc-cafe-order-expiry',
      // Sundays 9am-3pm MYT (1am-7am UTC), every 30 min
      schedule: events.Schedule.expression('cron(0/30 1-7 ? * SUN *)'),
      targets: [new targets.LambdaFunction(expiryHandler)],
    });

    new events.Rule(this, 'MidweekStockCheck', {
      ruleName: 'rlc-cafe-midweek-stock',
      // Wednesday 12pm MYT (4am UTC)
      schedule: events.Schedule.expression('cron(0 4 ? * WED *)'),
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
