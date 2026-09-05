import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

function synthTemplate(): Template {
  const app = new cdk.App();
  const stack = new KnowledgeBaseStack(app, 'TestKnowledgeBaseStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
}

describe('KnowledgeBaseStack', () => {
  it('S3記事バケットが暗号化・パブリックアクセスブロック・自動削除の設定で作成される', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('S3 Vectors のバケットとインデックスが1024次元・コサイン距離で作成される', () => {
    const template = synthTemplate();

    template.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      DataType: 'float32',
      Dimension: 1024,
      DistanceMetric: 'cosine',
    });
  });

  it('Bedrock Knowledge Base が Titan Embed v2 (1024次元) を埋め込みモデルとして使う', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      KnowledgeBaseConfiguration: {
        Type: 'VECTOR',
        VectorKnowledgeBaseConfiguration: {
          EmbeddingModelArn: {
            'Fn::Join': [
              '',
              Match.arrayWith([
                Match.stringLikeRegexp('foundation-model/amazon.titan-embed-text-v2:0'),
              ]),
            ],
          },
        },
      },
    });
  });

  it('S3 データソースが news/ プレフィックスのみを対象にし、削除ポリシーが DELETE になっている', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::Bedrock::DataSource', {
      DataSourceConfiguration: {
        Type: 'S3',
        S3Configuration: {
          InclusionPrefixes: ['news/'],
        },
      },
      DataDeletionPolicy: 'DELETE',
    });
  });

  it('スナップショット', () => {
    const template = synthTemplate();
    expect(template.toJSON()).toMatchSnapshot();
  });
});
