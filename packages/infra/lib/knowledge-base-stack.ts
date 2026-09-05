import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { bedrock, s3vectors } from '@cdklabs/generative-ai-cdk-constructs';
import { Construct } from 'constructs';

/**
 * KnowledgeBaseStack
 *
 * 知識層: S3記事バケット + S3 Vectors + Bedrock Knowledge Base。
 * IngestionStack (Phase 2) が Fetch Lambda で S3 記事バケットに Markdown 記事を書き込み、
 * GatewayStack (Phase 3) のツール Lambda がこの Knowledge Base を Retrieve する。
 *
 * ベクトルストアの選定理由・リージョン選定は docs/adr/0001-region-and-vector-store.md 参照。
 *
 * KB追加キュー(SQS/DLQ)とS3イベント通知の配線は、依頼書の想定ではIngestionStack側の
 * 責務だが、S3の`addEventNotification`が作るカスタムリソースは常にバケットが属するスタック
 * （このKnowledgeBaseStack）に生成されるため、ここに置かないとIngestionStackとの間に
 * CDKスタック依存の循環（KB→ING と ING→KB が両方発生）が生じる。そのためこのスタックで
 * キューまで作成し、IngestionStackはこのキューを props 経由で受け取って消費するだけにする
 * (docs/adr/0003-ingestion-queue-in-knowledge-base-stack.md 参照)。
 */
export class KnowledgeBaseStack extends cdk.Stack {
  /** 取り込み先の記事バケット（IngestionStack から参照する） */
  public readonly articlesBucket: s3.Bucket;

  /** ツール Lambda から Retrieve するための Knowledge Base */
  public readonly knowledgeBase: bedrock.VectorKnowledgeBase;

  /** KB のデータソース ID（Ingest Trigger Lambda が StartIngestionJob に使う） */
  public readonly dataSource: bedrock.S3DataSource;

  /** S3 ObjectCreated イベントを受け取るキュー（IngestionStack の Ingest Trigger Lambda が消費） */
  public readonly kbIngestQueue: sqs.Queue;

  /** KbIngestQueue の DLQ（最大4回リトライ後に格納） */
  public readonly kbIngestDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Titan Text Embeddings v2 (1024次元)。ap-northeast-1 での実アカウント検証済み
    // (docs/adr/0001-region-and-vector-store.md 参照)。
    const embeddingsModel = bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024;

    this.articlesBucket = new s3.Bucket(this, 'ArticlesBucket', {
      // ハンズオン教材のため、削除手順 (cdk destroy) で確実に消せるようにする。
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      enforceSSL: true,
    });

    const vectorBucket = new s3vectors.VectorBucket(this, 'VectorBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3vectors.VectorBucketEncryption.S3_MANAGED,
    });

    const vectorIndex = new s3vectors.VectorIndex(this, 'VectorIndex', {
      vectorBucket,
      dimension: embeddingsModel.vectorDimensions!,
      distanceMetric: s3vectors.VectorIndexDistanceMetric.COSINE,
      // Bedrock KB が本文チャンク・内部メタデータを格納するキーはフィルタ対象から除外する。
      // これを外すと両キーの合計がフィルタ可能メタデータの上限(2048バイト)にカウントされ、
      // 大きめの記事チャンクでStartIngestionJobが失敗する
      // (docs/lessons/0003-s3-vectors-filterable-metadata-limit.md 参照)。
      nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
    });

    this.knowledgeBase = new bedrock.VectorKnowledgeBase(this, 'KnowledgeBase', {
      // AWS::Bedrock::KnowledgeBase はアカウント内でグローバルに一意な名前が必要で、
      // CloudFormationのreplace更新は「新規作成→旧削除」の順で行われるため、固定名のまま
      // プロパティ変更（VectorIndexのnonFilterableMetadataKeys変更など）を行うと
      // 名前衝突でUPDATE_FAILEDになる。変更のたびに名前を変える必要がある
      // (docs/lessons/0003-s3-vectors-filterable-metadata-limit.md 参照)。
      name: 'awsnews-kb-mcp-v2',
      embeddingsModel,
      vectorStore: vectorIndex,
      instruction:
        'AWS の公式アップデート情報（What\'s New / 公式ブログ）を検索するための知識ベース。' +
        '記事のタイトル・本文抜粋・公開日・カテゴリ・出典URLをもとに、直近の AWS サービス変更点に関する質問に回答するために使う。',
    });

    this.dataSource = this.knowledgeBase.addS3DataSource({
      bucket: this.articlesBucket,
      dataSourceName: 'awsnews-articles',
      inclusionPrefixes: ['news/'],
      chunkingStrategy: bedrock.ChunkingStrategy.fixedSize({
        maxTokens: 500,
        overlapPercentage: 20,
      }),
      // ハンズオンでの作り直しを容易にするため、データソース削除時はベクトルも削除する。
      dataDeletionPolicy: bedrock.DataDeletionPolicy.DELETE,
    });

    this.kbIngestDlq = new sqs.Queue(this, 'KbIngestDlq', {
      retentionPeriod: cdk.Duration.days(14),
    });

    this.kbIngestQueue = new sqs.Queue(this, 'KbIngestQueue', {
      visibilityTimeout: cdk.Duration.seconds(120),
      deadLetterQueue: {
        queue: this.kbIngestDlq,
        maxReceiveCount: 4,
      },
    });

    this.articlesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.kbIngestQueue),
      { prefix: 'news/', suffix: '.md' },
    );

    new cdk.CfnOutput(this, 'ArticlesBucketName', {
      value: this.articlesBucket.bucketName,
      description: 'IngestionStack がMarkdown記事をPutするS3バケット名',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: this.knowledgeBase.knowledgeBaseId,
      description: 'Bedrock Knowledge Base ID (KB Ingest Trigger Lambda / ツールLambdaで使用)',
    });

    new cdk.CfnOutput(this, 'DataSourceId', {
      value: this.dataSource.dataSourceId,
      description: 'StartIngestionJob に渡す DataSource ID',
    });

    new cdk.CfnOutput(this, 'VectorBucketName', {
      value: vectorBucket.vectorBucketName,
      description: 'S3 Vectors バケット名',
    });

    new cdk.CfnOutput(this, 'KbIngestQueueUrl', { value: this.kbIngestQueue.queueUrl });
    new cdk.CfnOutput(this, 'KbIngestDlqUrl', { value: this.kbIngestDlq.queueUrl });
  }
}
