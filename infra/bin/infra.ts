#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { InfraStack } from '../lib/infra-stack';

const app = new cdk.App();
const stack = new InfraStack(app, 'RlcCafeStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

cdk.Tags.of(stack).add('Project', 'POS');
cdk.Tags.of(stack).add('Environment', 'production');
cdk.Tags.of(stack).add('ManagedBy', 'cdk');
cdk.Tags.of(stack).add('Ministry', 'Cafe');
cdk.Tags.of(stack).add('Owner', 'RLC');
