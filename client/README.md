# クライアント接続手順（Kiro / Claude Code）

GatewayStackをデプロイ後、以下の手順で `mcp-remote` 経由で AgentCore Gateway に接続する。
設計判断の背景は [docs/adr/0004-gateway-cognito-app-client.md](../docs/adr/0004-gateway-cognito-app-client.md)
を参照。

## 1. デプロイ出力の確認

```bash
cd packages/infra
npx cdk deploy GatewayStack
```

出力される `GatewayUrl` / `UserPoolId` / `UserPoolClientId` / `UserPoolDomain` を控える。

## 2. mcp.json の設定

[mcp.json.example](mcp.json.example) を参考に、Kiro / Claude Code の MCP 設定に追記する。
`mcp-remote` の第2引数（`8090`）はCognito App Clientに登録済みのコールバックURL
（`http://localhost:8090/oauth/callback`）のポート番号と一致させる必要がある
（App Clientのコールバック URL は事前登録が必須でワイルドカードポートは使えないため）。

## 3. 初回接続時の認可

MCPクライアントが初回接続すると、ブラウザが開きCognitoのホストUI
（`UserPoolDomain` の値のドメイン）でログイン画面が表示される。
User Poolはセルフサインアップを無効にしているため、事前に
[AWSコンソールまたはCLIでテストユーザーを作成](https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-create-user-accounts.html)
しておくこと。

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username <メールアドレス> \
  --user-attributes Name=email,Value=<メールアドレス> Name=email_verified,Value=true

aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> \
  --username <メールアドレス> \
  --password '<初期パスワード>' \
  --permanent
```

## 未検証事項

- `mcp-remote` のコールバックポート指定方法（CLI引数か環境変数か、バージョンによる差異）は
  実機接続で未検証。接続確認が取れ次第、本READMEとADR-0004を更新する
- Claude Desktopのカスタムコネクタは、AgentCore GatewayがMCP認可仕様の動的クライアント登録
  （DCR）に非対応のため使用できない（CLAUDE.md参照）
