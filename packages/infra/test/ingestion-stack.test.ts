import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { IngestionStack } from '../lib/ingestion-stack';

function synthTemplate(): Template {
  const app = new cdk.App();

  // KnowledgeBaseStack 相当のリソースを用意し、IngestionStack単体でテストする。
  const upstream = new cdk.Stack(app, 'UpstreamStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  const articlesBucket = new s3.Bucket(upstream, 'DummyArticlesBucket');
  const kbIngestDlq = new sqs.Queue(upstream, 'DummyKbIngestDlq');
  const kbIngestQueue = new sqs.Queue(upstream, 'DummyKbIngestQueue', {
    deadLetterQueue: { queue: kbIngestDlq, maxReceiveCount: 4 },
  });

  const stack = new IngestionStack(app, 'TestIngestionStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    articlesBucket,
    kbIngestQueue,
    kbIngestDlq,
    knowledgeBaseArn: 'arn:aws:bedrock:ap-northeast-1:123456789012:knowledge-base/ABCDEFGHIJ',
    knowledgeBaseId: 'ABCDEFGHIJ',
    dataSourceId: 'ZYXWVUTSRQ',
    slackWebhookSsmParam: '/awsnews-kb-mcp/slack-webhook-url',
  });
  return Template.fromStack(stack);
}

describe('IngestionStack', () => {
  it('DynamoDB State Store が guid をパーティションキーにオンデマンド課金で作成される', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      AttributeDefinitions: Match.arrayWith([
        Match.objectLike({ AttributeName: 'guid', AttributeType: 'S' }),
      ]),
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'guid', KeyType: 'HASH' }),
      ]),
    });
  });

  it('Fetch Lambda が正しい環境変数とPython 3.13ランタイムを持つ', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'fetch_lambda.handler.handler',
      Environment: {
        Variables: Match.objectLike({
          LOG_LEVEL: 'INFO',
        }),
      },
    });
  });

  it('Ingest Trigger Lambda が SQS イベントソースを ReportBatchItemFailures 付きで持つ', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('Ingest Trigger Lambda に bedrock:StartIngestionJob 権限が付与されている', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:StartIngestionJob',
            Effect: 'Allow',
            Resource: 'arn:aws:bedrock:ap-northeast-1:123456789012:knowledge-base/ABCDEFGHIJ',
          }),
        ]),
      },
    });
  });

  it('EventBridge Scheduler が6時間ごとのrate式でFetch Lambdaを起動する', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(6 hours)',
    });
  });

  it('DLQ滞留アラームとFetch/Ingest失敗アラームがSNSトピックへ通知する', () => {
    const template = synthTemplate();

    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    template.hasResourceProperties('AWS::SNS::Topic', {
      DisplayName: 'awsnews-kb-mcp ingestion alarms',
    });
  });

  it('スナップショット', () => {
    const template = synthTemplate();
    expect(template.toJSON()).toMatchSnapshot();
  });
});
