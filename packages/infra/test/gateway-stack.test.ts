import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { GatewayStack } from '../lib/gateway-stack';

function synthTemplate(): Template {
  const app = new cdk.App();

  // KnowledgeBaseStack 相当のリソースを用意し、GatewayStack単体でテストする。
  const upstream = new cdk.Stack(app, 'UpstreamStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  const articlesBucket = new s3.Bucket(upstream, 'DummyArticlesBucket');

  const stack = new GatewayStack(app, 'TestGatewayStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    articlesBucket,
    knowledgeBaseArn: 'arn:aws:bedrock:ap-northeast-1:123456789012:knowledge-base/ABCDEFGHIJ',
    knowledgeBaseId: 'ABCDEFGHIJ',
  });
  return Template.fromStack(stack);
}

describe('GatewayStack', () => {
  it('Cognito User Poolがセルフサインアップ無効で作成される', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'awsnews-kb-mcp',
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it('App Clientがシークレットなし・Authorization Code Grantで作成される', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      // mcp-remote は /oauth/callback、Claude Code の --callback-port は /callback を使う
      CallbackURLs: ['http://localhost:8090/oauth/callback', 'http://localhost:8090/callback'],
    });
  });

  it('リソースサーバーがawsnews-gateway/invokeスコープを公開する', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
      Identifier: 'awsnews-gateway',
      Scopes: Match.arrayWith([Match.objectLike({ ScopeName: 'invoke' })]),
    });
  });

  it('ツールLambdaがKB Retrieve権限とKNOWLEDGE_BASE_ID環境変数を持つ', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.13',
      Handler: 'gateway_tools_lambda.handler.handler',
      Environment: {
        Variables: Match.objectLike({ KNOWLEDGE_BASE_ID: 'ABCDEFGHIJ' }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:Retrieve',
            Effect: 'Allow',
            Resource: 'arn:aws:bedrock:ap-northeast-1:123456789012:knowledge-base/ABCDEFGHIJ',
          }),
        ]),
      },
    });
  });

  it('Gateway実行ロールがbedrock-agentcore.amazonaws.comをtrustする', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
          }),
        ]),
      },
    });
  });

  it('AgentCore GatewayがCUSTOM_JWTでCognitoのdiscovery URLを検証する', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerType: 'CUSTOM_JWT',
      ProtocolType: 'MCP',
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: Match.objectLike({
          DiscoveryUrl: {
            'Fn::Join': [
              '',
              Match.arrayWith([
                'https://cognito-idp.ap-northeast-1.amazonaws.com/',
                '/.well-known/openid-configuration',
              ]),
            ],
          },
        }),
      },
    });
  });

  it('GatewayTargetがsearch_aws_updates / get_articleの2ツールをLambdaにマッピングする', () => {
    const template = synthTemplate();

    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: 'awsnews-tools',
      CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
      TargetConfiguration: {
        Mcp: {
          Lambda: {
            ToolSchema: {
              InlinePayload: Match.arrayWith([
                Match.objectLike({ Name: 'search_aws_updates' }),
                Match.objectLike({ Name: 'get_article' }),
              ]),
            },
          },
        },
      },
    });
  });

  it('スナップショット', () => {
    const template = synthTemplate();
    expect(template.toJSON()).toMatchSnapshot();
  });
});
