import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { Construct } from 'constructs';
import { exportLambdaRequirements } from './uv';

const TOOLS_ROOT = path.join(__dirname, '..', '..', 'tools');
const TARGET_NAME = 'awsnews-tools';

/**
 * MCPクライアントのローカルコールバックURL（ポート8090固定）。docs/adr/0004参照。
 * mcp-remote は `/oauth/callback`、Claude Code（`claude mcp add --callback-port`）は `/callback` を使う。
 */
const DEFAULT_OAUTH_CALLBACK_URLS = [
  'http://localhost:8090/oauth/callback',
  'http://localhost:8090/callback',
];

export interface GatewayStackProps extends cdk.StackProps {
  /** KnowledgeBaseStackが作成した記事バケット。get_articleツールがMarkdown全文を読む。 */
  readonly articlesBucket: s3.IBucket;
  /** search_aws_updates / get_article がRetrieveするKnowledge BaseのARN。 */
  readonly knowledgeBaseArn: string;
  /** ツールLambdaの環境変数に渡すKnowledge Base ID。 */
  readonly knowledgeBaseId: string;
  /**
   * Cognito App Clientに登録するOAuthコールバックURL。
   * 事前登録が必須でワイルドカードポートは使えないため既定は固定ポートのみ
   * (docs/adr/0004-gateway-cognito-app-client.md 参照)。
   */
  readonly oauthCallbackUrls?: string[];
}

/**
 * GatewayStack
 *
 * 読み取り経路（読み取り専任）: Cognito(OAuth2/OIDC) → AgentCore Gateway(CUSTOM_JWT認可)
 *   → Lambdaターゲット(search_aws_updates / get_article) → Bedrock KB Retrieve / S3 GetObject
 *
 * 設計判断: docs/adr/0004-gateway-cognito-app-client.md
 * （App Clientはシークレットなし・固定コールバックポート・専用リソースサーバー）
 */
export class GatewayStack extends cdk.Stack {
  /** クライアント側のOAuth設定（client/mcp.json）に必要なUser Pool。 */
  public readonly userPool: cognito.UserPool;

  /** クライアント側のOAuth設定に必要なApp Client（シークレットなし）。 */
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // --- Cognito: MCPクライアント向けのOAuth2/OIDC IdP ---
    this.userPool = new cognito.UserPool(this, 'McpUserPool', {
      userPoolName: 'awsnews-kb-mcp',
      selfSignUpEnabled: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolDomain = this.userPool.addDomain('McpUserPoolDomain', {
      cognitoDomain: {
        domainPrefix: `awsnews-kb-mcp-${cdk.Stack.of(this).account}`,
      },
    });

    const invokeScope = new cognito.ResourceServerScope({
      scopeName: 'invoke',
      scopeDescription: 'AgentCore Gateway経由でMCPツール(search_aws_updates / get_article)を呼び出す',
    });
    const resourceServer = this.userPool.addResourceServer('GatewayResourceServer', {
      identifier: 'awsnews-gateway',
      scopes: [invokeScope],
    });

    this.userPoolClient = this.userPool.addClient('McpClient', {
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.resourceServer(resourceServer, invokeScope)],
        callbackUrls: props.oauthCallbackUrls ?? DEFAULT_OAUTH_CALLBACK_URLS,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
    });

    // --- ツールLambda: search_aws_updates / get_article ---
    const toolsEntry = path.join(TOOLS_ROOT, 'gateway_tools_lambda');
    exportLambdaRequirements('gateway-tools-lambda', toolsEntry);

    const toolsFunction = new PythonFunction(this, 'GatewayToolsLambda', {
      entry: toolsEntry,
      index: 'gateway_tools_lambda/handler.py',
      handler: 'handler',
      runtime: Runtime.PYTHON_3_13,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.TWO_WEEKS,
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        LOG_LEVEL: 'INFO',
      },
      bundling: { assetExcludes: ['tests', '.venv', '__pycache__'] },
    });
    toolsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:Retrieve'],
        resources: [props.knowledgeBaseArn],
      }),
    );
    props.articlesBucket.grantRead(toolsFunction);

    // --- Gateway実行ロール: AgentCore GatewayがツールLambdaを呼び出す際に引き受ける ---
    const gatewayRole = new iam.Role(this, 'GatewayExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
        },
      }),
    });
    toolsFunction.grantInvoke(gatewayRole);

    // --- AgentCore Gateway: CUSTOM_JWTでCognitoアクセストークンを検証 ---
    const gateway = new bedrockagentcore.CfnGateway(this, 'Gateway', {
      name: 'awsnews-kb-mcp-gateway',
      description: 'AWS What\'s New / 公式ブログを検索するMCPゲートウェイ',
      roleArn: gatewayRole.roleArn,
      protocolType: 'MCP',
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/openid-configuration`,
          allowedClients: [this.userPoolClient.userPoolClientId],
        },
      },
    });

    // --- Gatewayターゲット: search_aws_updates / get_article をLambdaにマッピング ---
    const gatewayTarget = new bedrockagentcore.CfnGatewayTarget(this, 'ToolsTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: TARGET_NAME,
      description: 'search_aws_updates / get_article を提供するLambdaターゲット',
      // GATEWAY_IAM_ROLE: 専用の認証情報プロバイダを別途作らず、Gateway自身の実行ロール
      // (roleArn = gatewayRole、ツールLambdaへのInvoke権限は付与済み)でLambdaを呼び出す。
      // CfnGatewayTargetの型定義上はcredentialProviderConfigurationsが省略可能に見えるが、
      // 実際のAPIはLambdaターゲットに対して必須のため、省略すると
      // 「CredentialProviderConfigurations is required for Lambda targets」で作成に失敗する
      // (docs/lessons/0004-gateway-target-requires-credential-provider.md 参照)。
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: toolsFunction.functionArn,
            toolSchema: {
              inlinePayload: [
                {
                  name: 'search_aws_updates',
                  description:
                    'AWS What\'s New / 公式ブログの記事をキーワード検索する。' +
                    'since_days・category・source・langで絞り込み可能。',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      query: {
                        type: 'string',
                        description: '検索キーワード（例: "Graviton5", "S3 Vectors"）',
                      },
                      since_days: {
                        type: 'integer',
                        description: '直近N日以内に公開された記事に絞り込む（任意）',
                      },
                      category: {
                        type: 'string',
                        description: '記事のカテゴリで絞り込む（任意）',
                      },
                      source: {
                        type: 'string',
                        // Gateway のツールスキーマは enum に未対応のため、値は description で示す。
                        description:
                          '出典で絞り込む（任意）。値は次のいずれか。whats-new: AWS What\'s New、' +
                          'news-blog: AWS News Blog（英語）、jp-blog: AWS Japan Blog（日本語）',
                      },
                      lang: {
                        type: 'string',
                        description: '記事の言語で絞り込む（任意）。値は ja または en',
                      },
                    },
                    required: ['query'],
                  },
                },
                {
                  name: 'get_article',
                  description: '記事URLからS3上のMarkdown全文を取得する。',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      url: {
                        type: 'string',
                        description: '記事のURL（search_aws_updatesの結果のurlフィールド）',
                      },
                    },
                    required: ['url'],
                  },
                },
              ],
            },
          },
        },
      },
    });
    gatewayTarget.addResourceDependency(gateway);

    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: gateway.attrGatewayUrl,
      description: 'MCPクライアント(mcp-remote)が接続するAgentCore GatewayのURL',
    });
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'UserPoolDomain', {
      value: userPoolDomain.domainName,
      description: 'ホストUIドメイン（Authorization Code Grantのログイン画面）',
    });
    new cdk.CfnOutput(this, 'OidcDiscoveryUrl', {
      value: `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/openid-configuration`,
    });
    new cdk.CfnOutput(this, 'GatewayToolsFunctionName', { value: toolsFunction.functionName });
  }
}
