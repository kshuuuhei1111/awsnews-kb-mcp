import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { Construct } from 'constructs';
import { exportLambdaRequirements } from './uv';

const INGESTION_ROOT = path.join(__dirname, '..', '..', 'ingestion');

export interface IngestionStackProps extends cdk.StackProps {
  /** KnowledgeBaseStack が作成した記事バケット。Fetch Lambda の書き込み先。 */
  readonly articlesBucket: s3.IBucket;
  /**
   * KnowledgeBaseStack が作成したKB追加キュー（S3 ObjectCreatedイベントの通知先）。
   * バケット通知のカスタムリソースがバケット側スタックに生成される制約のため、
   * キュー自体もKnowledgeBaseStackで作成している
   * (docs/adr/0003-ingestion-queue-in-knowledge-base-stack.md 参照)。
   */
  readonly kbIngestQueue: sqs.IQueue;
  /** KnowledgeBaseStack が作成したKbIngestQueueのDLQ（滞留アラームの監視対象）。 */
  readonly kbIngestDlq: sqs.IQueue;
  /** StartIngestionJob 呼び出しに必要な Knowledge Base の ARN。 */
  readonly knowledgeBaseArn: string;
  /** StartIngestionJob に渡す Knowledge Base ID。 */
  readonly knowledgeBaseId: string;
  /** StartIngestionJob に渡す DataSource ID。 */
  readonly dataSourceId: string;
  /**
   * CloudWatch Alarm のメール通知先（任意）。
   * 指定しない場合、SNS はメール購読なしで Slack 通知 Lambda のみに配信する。
   */
  readonly alarmEmail?: string;
  /**
   * Slack Incoming Webhook URL を格納する SSM パラメータ名。
   * パラメータが存在しない場合、通知 Lambda は何もせず正常終了する。
   */
  readonly slackWebhookSsmParam: string;
}

/**
 * IngestionStack
 *
 * 取り込みパイプライン（書き込み専任・Pull方式）:
 * EventBridge Scheduler(6時間毎) → Fetch Lambda → S3記事バケット
 *   → S3 ObjectCreated → SQS → KB Ingest Trigger Lambda → StartIngestionJob
 * 失敗時は CloudWatch Alarm → SNS → Slack通知Lambda（任意）。
 *
 * 設計判断: docs/adr/0002-lambda-dependency-management.md（uv export + PythonFunction）
 */
export class IngestionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);

    // --- DynamoDB State Store: 記事GUIDの重複排除 ---
    const stateTable = new dynamodb.TableV2(this, 'ArticleStateTable', {
      partitionKey: { name: 'guid', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // KB追加キュー + DLQ は KnowledgeBaseStack で作成済み（props経由で受け取る）。
    const kbIngestQueue = props.kbIngestQueue;

    // --- Fetch Lambda: RSS取得 → Markdown変換 → S3 Put ---
    const fetchLambdaEntry = path.join(INGESTION_ROOT, 'fetch_lambda');
    exportLambdaRequirements('fetch-lambda', fetchLambdaEntry);

    const fetchFunction = new PythonFunction(this, 'FetchLambda', {
      entry: fetchLambdaEntry,
      index: 'fetch_lambda/handler.py',
      handler: 'handler',
      runtime: Runtime.PYTHON_3_13,
      timeout: cdk.Duration.seconds(90),
      memorySize: 512,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: {
        ARTICLES_BUCKET_NAME: props.articlesBucket.bucketName,
        STATE_TABLE_NAME: stateTable.tableName,
        LOG_LEVEL: 'INFO',
      },
      bundling: { assetExcludes: ['tests', '.venv', '__pycache__'] },
    });
    props.articlesBucket.grantWrite(fetchFunction);
    stateTable.grantReadWriteData(fetchFunction);

    // --- EventBridge Scheduler: 6時間ごとにFetch Lambdaを起動 ---
    new scheduler.Schedule(this, 'FetchSchedule', {
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.hours(6)),
      target: new targets.LambdaInvoke(fetchFunction),
      description: 'AWS What\'s New / 公式ブログのRSSを6時間ごとに取得する',
    });

    // --- KB Ingest Trigger Lambda: SQS → StartIngestionJob ---
    const ingestTriggerEntry = path.join(INGESTION_ROOT, 'ingest_trigger_lambda');
    exportLambdaRequirements('ingest-trigger-lambda', ingestTriggerEntry);

    const ingestTriggerFunction = new PythonFunction(this, 'IngestTriggerLambda', {
      entry: ingestTriggerEntry,
      index: 'ingest_trigger_lambda/handler.py',
      handler: 'handler',
      runtime: Runtime.PYTHON_3_13,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
        LOG_LEVEL: 'INFO',
      },
      bundling: { assetExcludes: ['tests', '.venv', '__pycache__'] },
    });
    ingestTriggerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:StartIngestionJob'],
        resources: [props.knowledgeBaseArn],
      }),
    );
    ingestTriggerFunction.addEventSource(
      new SqsEventSource(kbIngestQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    // --- SNS: アラーム通知トピック ---
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'awsnews-kb-mcp ingestion alarms',
    });
    if (props.alarmEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }

    // --- Slack通知Lambda（任意設定。SSMパラメータ未設定ならメール通知のみ） ---
    const notifierEntry = path.join(INGESTION_ROOT, 'notifier_lambda');
    exportLambdaRequirements('notifier-lambda', notifierEntry);

    const notifierFunction = new PythonFunction(this, 'NotifierLambda', {
      entry: notifierEntry,
      index: 'notifier_lambda/handler.py',
      handler: 'handler',
      runtime: Runtime.PYTHON_3_13,
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: {
        SLACK_WEBHOOK_SSM_PARAM: props.slackWebhookSsmParam,
        LOG_LEVEL: 'INFO',
      },
      bundling: { assetExcludes: ['tests', '.venv', '__pycache__'] },
    });
    notifierFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: props.slackWebhookSsmParam.replace(/^\//, ''),
          }),
        ],
      }),
    );
    alarmTopic.addSubscription(new subscriptions.LambdaSubscription(notifierFunction));

    // --- CloudWatch Alarms ---
    // DLQ 滞留: 1件でも入ったら通知する。
    const dlqAlarm = new cloudwatch.Alarm(this, 'KbIngestDlqNotEmptyAlarm', {
      metric: props.kbIngestDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'KB追加キューのDLQにメッセージが滞留している',
    });
    dlqAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // Fetch Lambda 失敗: ハンドラ内部で例外を握りつぶし {failed: N} を返す設計のため、
    // Lambda標準のErrorsメトリクスではなく、ERRORログの出現をメトリクスフィルタで検知する。
    const fetchFailureMetric = new logs.MetricFilter(this, 'FetchFailureMetricFilter', {
      logGroup: fetchFunction.logGroup,
      metricNamespace: 'AwsNewsKbMcp',
      metricName: 'FetchFailureCount',
      filterPattern: logs.FilterPattern.anyTerm(
        'feed_fetch_failed',
        'article_process_failed',
      ),
      metricValue: '1',
    }).metric({ period: cdk.Duration.hours(1), statistic: 'sum' });

    const fetchFailureAlarm = new cloudwatch.Alarm(this, 'FetchFailureAlarm', {
      metric: fetchFailureMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'RSS取得または記事変換が1件以上失敗した',
    });
    fetchFailureAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // Ingest Trigger Lambda 失敗: ConflictException（実行中で再キュー）はWARNINGに留めており
    // アラーム対象外。ERRORログ（想定外の失敗）のみを検知する。
    const ingestFailureMetric = new logs.MetricFilter(this, 'IngestFailureMetricFilter', {
      logGroup: ingestTriggerFunction.logGroup,
      metricNamespace: 'AwsNewsKbMcp',
      metricName: 'IngestionJobStartFailureCount',
      filterPattern: logs.FilterPattern.literal('"ingestion_job_start_failed"'),
      metricValue: '1',
    }).metric({ period: cdk.Duration.hours(1), statistic: 'sum' });

    const ingestFailureAlarm = new cloudwatch.Alarm(this, 'IngestFailureAlarm', {
      metric: ingestFailureMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'StartIngestionJobが想定外の理由で失敗した（KB同時実行制約による再試行は含まない）',
    });
    ingestFailureAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    new cdk.CfnOutput(this, 'ArticleStateTableName', { value: stateTable.tableName });
    new cdk.CfnOutput(this, 'FetchFunctionName', { value: fetchFunction.functionName });
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
  }
}
