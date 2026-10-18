# CLAUDE.md

このファイルは Claude Code (claude.ai/code) がこのリポジトリで作業する際のガイドです。

## 1. プロジェクト概要

AWS What's New / AWS 公式ブログ（英語・日本語）の RSS を定期取得して
Amazon Bedrock Knowledge Base（KB）に取り込み、Claude Desktop / Kiro / Claude Code から
MCP 経由で検索・深掘りできるようにするハンズオン教材。

社内の既存システム UC55（ChatGPT MCP コネクター → AgentCore → KB）と同じ設計思想を、
低コストな題材で再現することが狙い。

- 取り込み側（書き込み専任）と読み取り側（読み取り専任）は直接つながらず、S3 と KB だけを
  接点にした疎結合構成
- 回答生成は MCP クライアント側の LLM が行う。サーバー側に AgentCore Runtime や回答生成 LLM は
  置かない
- 全コンポーネントをサーバーレスにし、放置しても月数ドル以内に収める
- 1〜2 日で構築・検証・削除まで通せる粒度

アーキテクチャ図は依頼時点で指定パスに存在しなかったため未参照。設計は本ファイルおよび
[docs/adr/0001-region-and-vector-store.md](docs/adr/0001-region-and-vector-store.md) を正とする。
図が入手でき次第 `docs/architecture/` に配置し、差分があれば ADR を改訂する。

### アーキテクチャ概要

**① 取り込みパイプライン（書き込み専任・Pull 方式）**

1. EventBridge Scheduler（6時間ごと）が Fetch Lambda を起動
2. Fetch Lambda が RSS を取得し、DynamoDB State Store の記事 GUID と突合して新着のみ処理
3. 新着記事は本文 HTML を取得して Markdown に変換し、S3 記事バケットに
   `news/YYYY/MM/<slug>.md` と `news/YYYY/MM/<slug>.md.metadata.json` を Put
4. S3 の ObjectCreated イベント → SQS KB 追加キュー（バッチ10件、最大4回リトライ、失敗は DLQ）
5. KB Ingest Trigger Lambda が `StartIngestionJob` を呼ぶ（KB あたり同時1ジョブの制約があるため、
   実行中なら例外にせず可視性タイムアウトで再キューする）
6. CloudWatch Alarm（DLQ 滞留、Fetch 失敗、Ingest 失敗率）→ SNS → Slack 通知 Lambda（任意）

RSS ソース（初期値）:
- AWS What's New: `aws.amazon.com/about-aws/whats-new/recent/feed`
- AWS News Blog: `aws.amazon.com/blogs/aws/feed`
- AWS Japan Blog: `aws.amazon.com/jp/blogs/news/feed`

**② 知識層**

- S3 記事バケット（上記）
- Bedrock Knowledge Base: データソースは S3 記事バケット、埋め込みは Titan Text Embeddings v2
- ベクトルストアは S3 Vectors（[ADR-0001](docs/adr/0001-region-and-vector-store.md)）

**③ 読み取り経路（読み取り専任）**

- Amazon Cognito User Pool を OAuth2 / OIDC IdP として使用
- AgentCore Gateway に Cognito の JWT インバウンド認可を設定
- Gateway の Lambda ターゲットに `search_aws_updates` / `get_article` の2ツールを実装
- クライアントは Kiro / Claude Code から `mcp-remote` 経由で接続（第一段階）
- 注意: Gateway は Protected Resource Metadata（`/.well-known/oauth-protected-resource`）を
  返すが、認可サーバーの Cognito が MCP 認可仕様の動的クライアント登録（DCR）に未対応のため、
  Claude Desktop のカスタムコネクタから直接 OAuth 接続はできない。第二段階（任意）として
  API Gateway + 薄いプロキシ Lambda で DCR を補う構成を検討課題とする

### やらないこと（Non-goals）

AgentCore Runtime / AgentCore Memory / A2A マルチエージェント、VPC、Aurora、
OpenSearch Serverless、サーバー側での回答生成、ChatGPT コネクタ対応。

## 2. リージョン・技術選定

- **リージョン: `ap-northeast-1`（東京）**。詳細は
  [docs/adr/0001-region-and-vector-store.md](docs/adr/0001-region-and-vector-store.md)
- **ベクトルストア: S3 Vectors**（Aurora / OpenSearch Serverless は使わない）
- **Lambda 依存管理: `PythonFunction`（aws-cdk/aws-lambda-python-alpha）+ `uv export`**。詳細は
  [docs/adr/0002-lambda-dependency-management.md](docs/adr/0002-lambda-dependency-management.md)

## 3. ディレクトリ構成

```
.
├── CLAUDE.md
├── README.md                  # ハンズオン手順書
├── docs/
│   ├── adr/                   # 設計判断の記録（NNNN-title.md）
│   ├── lessons/                # ハマりどころ
│   └── architecture/          # アーキテクチャ図（入手次第配置）
├── packages/
│   ├── infra/                 # CDK（KnowledgeBaseStack / IngestionStack / GatewayStack）
│   ├── ingestion/             # Fetch Lambda, KB Ingest Trigger Lambda, Slack Notifier
│   └── tools/                 # Gateway ターゲット Lambda（search_aws_updates / get_article）
├── client/                    # Kiro / Claude Code 向け mcp.json サンプルと接続手順
└── scripts/                   # 初回同期の手動実行、KB 状態確認、クリーンアップ補助
```

各パッケージの責務:
- `packages/infra`: CDK v2 (TypeScript)。Stack は KnowledgeBase / Ingestion / Gateway の3つに分割
- `packages/ingestion`: RSS 取得・Markdown 変換・KB Ingestion 起動・Slack 通知の Lambda（Python）
- `packages/tools`: AgentCore Gateway の Lambda ターゲット（KB Retrieve / S3 記事全文取得）
- `client`: MCP クライアント（Kiro / Claude Code）向け設定サンプルと接続手順
- `scripts`: 運用補助スクリプト（初回同期、KB 状態確認、削除前チェックなど）

## 4. ビルド・テスト・デプロイコマンド

```bash
# Python (uv workspace, packages/ingestion, packages/tools)
uv sync
uv run pytest
uv run ruff check .
uv run ruff format .

# CDK (packages/infra)
cd packages/infra
npm install
npm run build
npm test
npx cdk synth
npx cdk deploy --all      # 実際に課金が発生する。事前にスタックと概算コストを確認すること
npx cdk destroy --all     # ハンズオン終了後は必ず実行し、課金ゼロに戻す
```

## 5. コーディング規約

- **Python**: 型ヒント必須。ruff で lint/format（`pyproject.toml` の `[tool.ruff]` に設定を集約）。
  boto3 クライアントはハンドラ関数の外（モジュールスコープ）で生成し、コールドスタート時のみ
  初期化する。ログは構造化ログ（`json.dumps` または `aws-lambda-powertools` の Logger）で出力し、
  リクエストID・記事URL・処理件数などを含める
- **TypeScript (CDK)**: Stack ごとにファイルを分割し、L2 コンストラクトを優先。
  `@cdklabs/generative-ai-cdk-constructs` が S3 Vectors データソースに対応していない場合は
  L1（`CfnKnowledgeBase` / `CfnDataSource`）で代替する
- テストは各パッケージに同梱し、CI 相当のコマンド（上記）で必ず実行できる状態を保つ

## 6. セキュリティ・コスト上の約束事

- シークレット（Cognito クライアントシークレット、Slack Webhook URL）はコードに書かず、
  SSM パラメータ（`SecureString`）または Secrets Manager に格納する
- `.env` は `.gitignore` 済み。ローカル動作確認用の値は `.env.example` をコピーして使う
- 常時課金リソース（NAT Gateway、OpenSearch Serverless など）を追加する場合は、
  理由を ADR に残してから実装する
- ハンズオン終了後は `npx cdk destroy --all` で全スタックを削除し、課金ゼロに戻せることを
  Phase 4 で確認する

## 7. 開発フロー

- 変更規模に応じて「設計 → 実装 → テスト → ドキュメント同期」を回す
- **ADR** (`docs/adr/`): アーキテクチャ・技術選定など、後から「なぜそうしたか」を問われる決定を
  記録する。依頼書で「判断を委ねられている」箇所は必ず ADR 化する
- **lessons** (`docs/lessons/`): 実装中にハマった詰まりどころ・回避策・調査に時間がかかった点を
  簡潔に記録する。ADR ほど大きな決定ではないが、再現時に他者がつまずきそうな内容が対象
- 各フェーズの終わりに、動作確認の結果（実行したコマンドと結果）と次フェーズの計画を報告する

## 8. ハンズオン教材としての品質基準

- README の手順だけで第三者が再現できること（前提条件、デプロイ、接続、動作確認、削除まで）
- 削除手順（`cdk destroy --all` 等）で課金ゼロに戻せることを実際に確認してから完了とする
- 未検証の内容は「未検証」と明記し、実行したコマンドと結果を根拠に報告する
