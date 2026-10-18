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
Claude Code の場合は、次のコマンドで登録できる（このプロジェクトだけで有効な local スコープ）。

```bash
claude mcp add -s local awsnews-kb -- npx -y mcp-remote@0.14.3 <GatewayUrl> 8090 \
  --static-oauth-client-info '{"client_id":"<UserPoolClientId>"}' \
  --static-oauth-client-metadata '{"scope":"awsnews-gateway/invoke"}'
```

各引数の意味:

| 引数 | 理由 |
|---|---|
| `8090` | OAuth のコールバックを受けるポート。App Client に登録済みのコールバック URL（`http://localhost:8090/oauth/callback`）と一致させる。事前登録が必須で、ワイルドカードポートは使えない |
| `--static-oauth-client-info` | Cognito は動的クライアント登録（DCR）に未対応のため、App Client ID を直接渡す |
| `--static-oauth-client-metadata` | 要求するスコープを `awsnews-gateway/invoke` に固定する。Cognito のメタデータにある `openid` などを要求すると、App Client に許可されていないため `invalid_scope` になる |

Gateway は 401 応答で Protected Resource Metadata（`/.well-known/oauth-protected-resource`）の
場所を返すため、Cognito の URL を設定する必要はない。

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

ログインが終わる前に MCP クライアント側の接続がタイムアウトすることがある。その場合も
トークンは `~/.mcp-auth` に保存されているため、クライアントから再接続すればよい
（Claude Code では `/mcp` → `awsnews-kb` → Reconnect）。

## 4. 動作確認

接続後、「awsnews-kb で最近の AgentCore 関連のアップデートを調べて」などと質問する。
ツールが呼ばれたことは、ツール Lambda のログ（`/aws/lambda/GatewayStack-GatewayToolsLambda...`）の
`tool_invoked` で確認できる。

## 検証状況（2026-10-18）

- 検証済み: Claude Code 2.1.81 から `mcp-remote@0.14.3`（上記の引数）で接続し、
  Cognito でのログインと `search_aws_updates` の呼び出しまで確認した
- 未検証: Claude Code の HTTP 接続（`claude mcp add --transport http --client-id <UserPoolClientId>
  --callback-port 8090 awsnews-kb <GatewayUrl>`）。Claude Code はコールバック URL に
  `/callback` を使うため、App Client に `http://localhost:8090/callback` を登録済み
- 非対応: Claude Desktop のカスタムコネクタ。認可サーバーの Cognito が動的クライアント登録
  （DCR）に未対応のため使用できない（CLAUDE.md 参照）
