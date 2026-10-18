# ADR-0004: GatewayStackのCognito App Client設計（パブリッククライアント + 固定コールバックポート）

- ステータス: Accepted
- 日付: 2026-09-06

## コンテキスト

Phase 3（GatewayStack）では、Cognito User PoolをOAuth2/OIDC IdPとして使い、
AgentCore GatewayのCUSTOM_JWTオーソライザーで検証する。クライアントはKiro/Claude Codeから
`mcp-remote`経由でAuthorization Code Grantで接続する想定（CLAUDE.md参照）。

依頼書はUser Poolを使うことのみを定め、App Client（シークレットの要否、コールバックURL、
スコープ）の具体設計は委ねられている。

## 決定

1. **App Clientはシークレットを発行しない（`generateSecret: false`）**。
   Authorization Code + PKCEで完結させ、クライアントシークレットの管理（SSM SecureStringへの
   格納、ローテーション）をハンズオンの範囲から外す。CLAUDE.mdのセキュリティ約束事
   （シークレットはSSM/Secrets Managerに格納）は、シークレットを発行しない設計であれば
   そもそも該当しない。
2. **コールバックURLは固定ポートのlocalhostを1つだけ登録する**
   （`http://localhost:8090/oauth/callback`、`oauthCallbackUrls` propで上書き可能）。
   Cognito App Clientのコールバック URLは事前登録が必須でワイルドカードポートは使えないため、
   `mcp-remote`起動時にコールバックポートを明示指定する運用とする
   （client/mcp.json側の設定は接続確認时に確定させ、README/lessonsに追記する）。
3. **専用リソースサーバー`awsnews-gateway`とスコープ`invoke`を定義**し、App Clientの
   OAuthスコープをこの1スコープのみに絞る。Gateway側の`allowedClients`にApp Client IDを
   設定し、JWT検証はクライアントID一致で行う（`allowedAudience`は使わない。Cognito
   アクセストークンは既定で`aud`クレームを持たないため）。

## 影響

- App Clientにシークレットがないため、`.env` / SSMへのシークレット格納作業は不要になる
- `mcp-remote`のコールバックポートを固定するため、client/mcp.json・READMEの接続手順で
  ポート番号を明示する必要がある。実機接続で固定ポートの指定方法（CLI引数か環境変数か）が
  想定と異なる場合は、このADRとclient/mcp.jsonを合わせて更新する
- Claude Desktopのカスタムコネクタ（DCR前提）は引き続き非対応（CLAUDE.md記載の通り）
