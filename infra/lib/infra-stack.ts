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
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
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

    const customersTable = new dynamodb.Table(this, 'CustomersTable', {
      tableName: 'rlc-cafe-customers',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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
        JWT_SECRET: 'CHANGE_ME_BEFORE_DEPLOY',
        GMAIL_USER: process.env.GMAIL_USER || '',
        GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
        NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL || '',
        // Origin verification for CloudFront front-door (see docs/cloudfront-migration.md).
        // Kept OFF until CloudFront is wired up to inject the header. When ENFORCE_ORIGIN_HEADER
        // is 'true', requests missing/mismatching X-Origin-Verify are rejected with 403.
        ORIGIN_VERIFY_SECRET: process.env.ORIGIN_VERIFY_SECRET || 'CHANGE_ME_WHEN_CLOUDFRONT_ENABLED',
        ENFORCE_ORIGIN_HEADER: process.env.ENFORCE_ORIGIN_HEADER || 'false',
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

    // ─── CloudFront front-door (Phase 1: scaffolding — see cloudfront-migration.md) ───

    // Private S3 bucket for the static frontend. No public access; CloudFront
    // reaches it via an Origin Access Identity. RETAIN so a stack teardown
    // doesn't nuke the frontend deploy artifacts.
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `rlc-cafe-frontend-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ACM cert for 153.oasisofcare.org, DNS-validated.
    //
    // TODO(cloudfront-region-issue): CloudFront requires the certificate to
    // live in us-east-1. This stack is deployed in ap-southeast-5, so this
    // certificate — while valid for any regional service (ALB, API Gateway
    // custom domain) — CANNOT be attached to the CloudFront distribution
    // below. Options to resolve when Phase 2 lands:
    //   1. Create a companion stack in us-east-1 that produces the CF cert
    //      and consume its ARN via a stack-to-stack reference or SSM param.
    //   2. Create the cert manually in the us-east-1 ACM console, then
    //      `acm.Certificate.fromCertificateArn(..., <us-east-1 arn>)` here.
    // Kept here for Phase 1 scaffolding + surfacing the CNAME validation
    // record via the AWS console; not yet attached to CloudFront.
    const frontendCertificate = new acm.Certificate(this, 'FrontendCert', {
      domainName: '153.oasisofcare.org',
      validation: acm.CertificateValidation.fromDns(),
    });

    // Origin Access Identity — grants CloudFront read access to the private
    // bucket without exposing it to the public.
    const frontendOAI = new cloudfront.OriginAccessIdentity(this, 'FrontendOAI', {
      comment: 'OAI for rlc-cafe-frontend',
    });
    frontendBucket.grantRead(frontendOAI);

    // CloudFront distribution. NOT wired to the custom domain / cert yet —
    // we'll add domainNames + certificate in Phase 2 once the us-east-1
    // cert issue is resolved and DNS is ready to cut over.
    const frontendDistribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      comment: 'RLC Café frontend + /api/* proxy',
      // Default: static site from S3.
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(frontendBucket, {
          originAccessIdentity: frontendOAI,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        // API traffic bypasses caching + forwards auth headers.
        '/api/*': {
          origin: new origins.RestApiOrigin(api),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      // SPA-style fallback: 403 (S3 "access denied" for a missing key) and
      // 404 both rewrite to index.html so client-side routing keeps working.
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      // Whitelist MY + SG; everyone else gets a 403 at the edge before
      // reaching the origin.
      geoRestriction: cloudfront.GeoRestriction.allowlist('MY', 'SG'),
      // Cheapest tier that still covers SG/MY edge locations.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // domainNames + certificate deliberately omitted for Phase 1.
    });

    // ─── Outputs ───────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: frontendBucket.bucketName,
      description: 'S3 bucket hosting the static frontend (private, CloudFront-only access)',
    });
    new cdk.CfnOutput(this, 'FrontendCertArn', {
      value: frontendCertificate.certificateArn,
      description: 'ACM certificate ARN — check ACM console for the DNS validation CNAME record',
    });
    new cdk.CfnOutput(this, 'FrontendDistributionDomain', {
      value: frontendDistribution.distributionDomainName,
      description: 'CloudFront distribution domain (xxx.cloudfront.net) — Phase 1, no custom domain yet',
    });
    new cdk.CfnOutput(this, 'FrontendDistributionId', {
      value: frontendDistribution.distributionId,
      description: 'CloudFront distribution ID (useful for cache invalidations)',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway endpoint URL',
    });
  }
}
