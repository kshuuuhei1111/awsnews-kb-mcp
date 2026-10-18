#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GatewayStack } from '../lib/gateway-stack';
import { IngestionStack } from '../lib/ingestion-stack';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
};

const knowledgeBaseStack = new KnowledgeBaseStack(app, 'KnowledgeBaseStack', {
  env,
  description: 'awsnews-kb-mcp: S3記事バケット + S3 Vectors + Bedrock Knowledge Base',
});

const ingestionStack = new IngestionStack(app, 'IngestionStack', {
  env,
  description: 'awsnews-kb-mcp: RSS取得 → Markdown変換 → S3 → SQS → KB Ingestion',
  articlesBucket: knowledgeBaseStack.articlesBucket,
  kbIngestQueue: knowledgeBaseStack.kbIngestQueue,
  kbIngestDlq: knowledgeBaseStack.kbIngestDlq,
  knowledgeBaseArn: knowledgeBaseStack.knowledgeBase.knowledgeBaseArn,
  knowledgeBaseId: knowledgeBaseStack.knowledgeBase.knowledgeBaseId,
  dataSourceId: knowledgeBaseStack.dataSource.dataSourceId,
  alarmEmail: app.node.tryGetContext('alarmEmail'),
  slackWebhookSsmParam:
    app.node.tryGetContext('slackWebhookSsmParam') ?? '/awsnews-kb-mcp/slack-webhook-url',
});
ingestionStack.addDependency(knowledgeBaseStack);

const gatewayStack = new GatewayStack(app, 'GatewayStack', {
  env,
  description: 'awsnews-kb-mcp: Cognito + AgentCore Gateway + MCPツール(search_aws_updates / get_article)',
  articlesBucket: knowledgeBaseStack.articlesBucket,
  knowledgeBaseArn: knowledgeBaseStack.knowledgeBase.knowledgeBaseArn,
  knowledgeBaseId: knowledgeBaseStack.knowledgeBase.knowledgeBaseId,
  oauthCallbackUrls: app.node.tryGetContext('oauthCallbackUrls'),
});
gatewayStack.addDependency(knowledgeBaseStack);
