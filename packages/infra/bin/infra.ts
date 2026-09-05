#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
};

new KnowledgeBaseStack(app, 'KnowledgeBaseStack', {
  env,
  description: 'awsnews-kb-mcp: S3記事バケット + S3 Vectors + Bedrock Knowledge Base',
});
