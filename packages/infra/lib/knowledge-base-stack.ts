import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { bedrock, s3vectors } from '@cdklabs/generative-ai-cdk-constructs';
import { Construct } from 'constructs';

/**
 * KnowledgeBaseStack
 *
 * 知識層: S3記事バケット + S3 Vectors + Bedrock Knowledge Base。
 * IngestionStack (Phase 2) が S3 記事バケットに Markdown 記事を書き込み、
 * GatewayStack (Phase 3) のツール Lambda がこの Knowledge Base を Retrieve する。
 *
 * ベクトルストアの選定理由・リージョン選定は docs/adr/0001-region-and-vector-store.md 参照。
 */
export class KnowledgeBaseStack extends cdk.Stack {
  /** 取り込み先の記事バケット（IngestionStack から参照する） */
  public readonly articlesBucket: s3.Bucket;

  /** ツール Lambda から Retrieve するための Knowledge Base */
  public readonly knowledgeBase: bedrock.VectorKnowledgeBase;

  /** KB のデータソース ID（Ingest Trigger Lambda が StartIngestionJob に使う） */
  public readonly dataSource: bedrock.S3DataSource;

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
      // Bedrock KB が本文チャンクを格納するための内部キーは絞り込み対象から除外する。
      nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT'],
    });

    this.knowledgeBase = new bedrock.VectorKnowledgeBase(this, 'KnowledgeBase', {
      name: 'awsnews-kb-mcp',
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
  }
}
