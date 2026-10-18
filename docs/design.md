# 設計書

awsnews-kb-mcp の現状の構成（2026-10-18 時点のコード）をまとめた設計書。
設計判断の理由は [docs/adr/](adr/)、実装中のハマりどころは [docs/lessons/](lessons/) を参照。

## 1. システム構成

CDK のスタック単位で示す。取り込み側（書き込み専任）と読み取り側（読み取り専任）は
直接つながらず、S3 記事バケットと Bedrock KB だけを接点にする。

```mermaid
flowchart LR
  subgraph ING["IngestionStack（取り込み）"]
    SCH["EventBridge Scheduler<br/>6時間ごと"] --> FETCH["Fetch Lambda"]
    FETCH <--> DDB[("DynamoDB<br/>State Store")]
    TRIG["Ingest Trigger Lambda"]
    ALARM["CloudWatch Alarm x3"] --> SNS["SNS"] --> NOTIFY["Notifier Lambda"]
  end

  subgraph KB["KnowledgeBaseStack（知識層）"]
    S3[("S3 記事バケット<br/>news/YYYY/MM/*.md<br/>+ .metadata.json")]
    SQS["SQS KB追加キュー"] -.失敗.-> DLQ["DLQ"]
    BKB["Bedrock Knowledge Base<br/>Titan Embeddings v2"]
    S3V[("S3 Vectors<br/>Vector Index")]
  end

  subgraph GW["GatewayStack（読み取り）"]
    COG["Cognito User Pool"]
    AGW["AgentCore Gateway<br/>(MCP サーバー)"]
    TOOLS["Gateway Tools Lambda"]
  end

  RSS(["AWS RSS<br/>What's New / News Blog / Japan Blog"]) --> FETCH
  FETCH -- PutObject --> S3
  S3 -- "ObjectCreated (*.md)" --> SQS --> TRIG
  TRIG -- StartIngestionJob --> BKB
  BKB -- 読み込み --> S3
  BKB -- 埋め込み書き込み --> S3V
  NOTIFY -.-> SLACK(["Slack"])

  CLIENT(["Claude Code / Kiro<br/>mcp-remote"]) -- "OAuth2 (JWT)" --> COG
  CLIENT -- MCP --> AGW --> TOOLS
  TOOLS -- Retrieve --> BKB
  TOOLS -- GetObject --> S3
```

| スタック | 主なリソース | 依存先 |
|---|---|---|
| `KnowledgeBaseStack` | S3 記事バケット、S3 Vectors（Vector Bucket / Index）、Bedrock KB とデータソース、SQS KB追加キューと DLQ、S3 イベント通知 | なし |
| `IngestionStack` | Fetch / Ingest Trigger / Notifier の各 Lambda、DynamoDB、EventBridge Scheduler、CloudWatch Alarm、SNS | `KnowledgeBaseStack`（バケット、キュー、KB ID などを props で受け取る） |
| `GatewayStack` | Cognito User Pool、AgentCore Gateway と Target、Gateway Tools Lambda | `KnowledgeBaseStack`（バケット、KB ID） |

SQS キューを `IngestionStack` ではなく `KnowledgeBaseStack` に置いている理由は
[ADR-0003](adr/0003-ingestion-queue-in-knowledge-base-stack.md) を参照（S3 イベント通知の
カスタムリソースがバケット側のスタックに作られ、循環依存になるため）。

## 2. コード構成

どのソースコードが、どのスタックの Lambda としてデプロイされるかを示す。

```mermaid
flowchart TB
  subgraph infra["packages/infra（CDK / TypeScript）"]
    BIN["bin/infra.ts<br/>3スタックの組み立て"]
    KBS["lib/knowledge-base-stack.ts"]
    INGS["lib/ingestion-stack.ts"]
    GWS["lib/gateway-stack.ts<br/>MCPツールのスキーマ定義"]
    UV["lib/uv.ts<br/>uv export で requirements.txt 生成"]
    BIN --> KBS & INGS & GWS
    INGS & GWS --> UV
  end

  subgraph fetch["packages/ingestion/fetch_lambda"]
    FH["handler.py<br/>フィード定義 SOURCES・全体の制御"]
    FR["rss.py<br/>RSS 取得・パース"]
    FA["article.py<br/>本文 HTML 取得・Markdown 変換"]
    FS["s3_writer.py<br/>S3 キー生成・本文/メタデータ書き込み"]
    FST["state_store.py<br/>DynamoDB で既読 GUID 管理"]
    FM["models.py<br/>FeedSource / FeedEntry / ArticleMetadata"]
    FH --> FR & FA & FS & FST & FM
  end

  subgraph trig["packages/ingestion/ingest_trigger_lambda"]
    TH["handler.py<br/>バッチ単位で StartIngestionJob"]
  end

  subgraph notif["packages/ingestion/notifier_lambda"]
    NH["handler.py<br/>SSM から Webhook URL 取得"] --> NS["slack.py<br/>メッセージ整形・送信"]
  end

  subgraph tools["packages/tools/gateway_tools_lambda"]
    GH["handler.py<br/>ツール名で振り分け"]
    GR["retrieve.py<br/>search_aws_updates<br/>メタデータフィルタ組み立て"]
    GA["article.py<br/>get_article"]
    GH --> GR & GA
  end

  INGS -. デプロイ .-> fetch & trig & notif
  GWS -. デプロイ .-> tools
```

| パス | 役割 |
|---|---|
| [packages/infra/](../packages/infra/) | CDK v2。Python Lambda は `PythonFunction` と `uv export` でビルドする（[ADR-0002](adr/0002-lambda-dependency-management.md)） |
| [packages/ingestion/](../packages/ingestion/) | 取り込み側の Lambda 3つ。uv workspace のメンバー |
| [packages/tools/](../packages/tools/) | 読み取り側の Lambda（MCP ツールの実体） |
| [client/](../client/) | MCP クライアントの設定例と接続手順 |
| [scripts/check-kb-sync.sh](../scripts/check-kb-sync.sh) | Ingestion Job 履歴とドキュメントのステータスを確認する |
| [scripts/backfill-metadata.sh](../scripts/backfill-metadata.sh) | 取り込み済み記事のメタデータに項目を追記し、KB を再同期する |

各 Lambda は boto3 クライアントをモジュールスコープで生成し、テストでは `monkeypatch` で
差し替える。外部 API を呼ぶ関数は `Protocol` で依存を表し、偽物のクライアントでテストする。

## 3. 処理の流れ

### 3.1 取り込み

```mermaid
sequenceDiagram
  participant SCH as Scheduler
  participant F as Fetch Lambda
  participant D as DynamoDB
  participant S3 as S3 記事バケット
  participant Q as SQS
  participant T as Ingest Trigger
  participant KB as Bedrock KB

  SCH->>F: 6時間ごとに起動
  loop 3フィード × 各記事
    F->>D: GUID は既読か
    alt 新着
      F->>F: 本文 HTML 取得 → Markdown 変換
      F->>S3: .md と .md.metadata.json を Put
      F->>D: GUID を既読として記録
    end
  end
  S3->>Q: ObjectCreated（*.md のみ）
  Q->>T: 最大10件のバッチ
  T->>KB: StartIngestionJob（バッチにつき1回）
  alt 別のジョブが実行中（ConflictException）
    T-->>Q: バッチ全体を再キュー
  end
  KB->>S3: 差分を読み込み、チャンク分割・埋め込み → S3 Vectors
```

- `StartIngestionJob` はデータソース全体を同期する API のため、レコードごとではなく
  バッチごとに1回だけ呼ぶ（[lessons 0002](lessons/0002-ingest-trigger-must-call-once-per-batch.md)）
- `.metadata.json` だけを更新しても S3 イベントは発生しないため、取り込みは自動では起動しない

### 3.2 検索（MCP ツール）

```mermaid
sequenceDiagram
  participant C as MCP クライアント
  participant G as AgentCore Gateway
  participant L as Tools Lambda
  participant KB as Bedrock KB
  participant S3 as S3 記事バケット

  C->>G: search_aws_updates(query, since_days, source, lang)
  G->>L: ツール名 "<target>___search_aws_updates"
  L->>KB: Retrieve（メタデータフィルタ付き、上位5件）
  KB-->>L: チャンク + メタデータ
  L-->>C: タイトル・URL・公開日・抜粋（500文字）

  C->>G: get_article(url)
  G->>L: ツール名 "<target>___get_article"
  L->>KB: Retrieve（url の完全一致フィルタ、1件）
  KB-->>L: S3 URI
  L->>S3: GetObject
  L-->>C: 記事の Markdown 全文
```

回答文はクライアント側の LLM が作る。サーバー側では回答を生成しない。

## 4. データ設計

### 4.1 S3 オブジェクト

- 本文: `news/YYYY/MM/<タイトルのslug>-<GUIDのSHA1先頭8桁>.md`
- メタデータ: 本文と同じキーに `.metadata.json` を付けたもの。Bedrock KB が自動で関連付ける

### 4.2 メタデータ項目

| キー | 型 | 例 | 用途 |
|---|---|---|---|
| `title` | 文字列 | `Amazon CloudWatch log centralization now available ...` | 結果の表示 |
| `url` | 文字列 | `https://aws.amazon.com/about-aws/whats-new/2026/10/...` | 結果の表示、`get_article` の完全一致検索 |
| `published_at` | 文字列（ISO8601、UTC） | `2026-10-16T20:04:00+00:00` | 結果の表示 |
| `published_at_epoch` | 数値（Unix 秒） | `1792181040` | `since_days` の範囲フィルタ |
| `source` | 文字列 | `whats-new` / `news-blog` / `jp-blog` | 出典での絞り込み |
| `lang` | 文字列 | `en` / `ja` | 言語での絞り込み |
| `category` | 文字列 | （現状 `source` と同じ値） | 予約。意味のある分類に作り直す予定 |

- S3 Vectors の範囲比較（`greaterThan` など）は数値にしか使えず、`startsWith` は未対応。
  そのため日付は `published_at_epoch` で比較する（[lessons 0005](lessons/0005-s3-vectors-filter-operators.md)）
- フィルタに使えるメタデータは1ベクトルあたり合計 2048 バイトまで。Bedrock の内部キー
  `AMAZON_BEDROCK_TEXT` / `AMAZON_BEDROCK_METADATA` はフィルタ対象外にしている
  （[lessons 0003](lessons/0003-s3-vectors-filterable-metadata-limit.md)）

### 4.3 チャンキング

固定サイズ（500 トークン、重なり 20%）。What's New はほぼ1チャンクに収まり、長いブログは
数十チャンクに分かれる。チャンキングの設定はデータソース作成後に変更できない。

## 5. MCP ツール

| ツール | 引数 | 返り値 |
|---|---|---|
| `search_aws_updates` | `query`（必須）、`since_days`、`source`、`lang`、`category` | 上位5件のスコア・タイトル・URL・公開日・出典・言語・抜粋 |
| `get_article` | `url`（必須） | 記事のタイトル・公開日・Markdown 全文 |

ツールのスキーマは [gateway-stack.ts](../packages/infra/lib/gateway-stack.ts) の
`inlinePayload` に定義し、処理の実体は [packages/tools/](../packages/tools/) にある。

## 6. 監視

| アラーム | 発火条件 | 通知先 |
|---|---|---|
| `KbIngestDlqNotEmptyAlarm` | DLQ にメッセージが残っている | SNS → Notifier Lambda → Slack（任意）、メール（任意） |
| `FetchFailureAlarm` | Fetch Lambda のエラー | 同上 |
| `IngestFailureAlarm` | Ingest Trigger Lambda のエラー | 同上 |

## 7. 既知の課題（2026-10-18 時点）

| 課題 | 状態 |
|---|---|
| `published_at_epoch` / `lang` の追加 | コードは修正済み。`IngestionStack` のデプロイと既存650件への追記（`backfill-metadata.sh --apply`）は未実施 |
| Slack 通知が失敗する | SSM パラメータ名 `/awsnews-kb-mcp/...` が予約名（`aws` で始まる）に当たる。SSM は先頭の `/` を除いて判定するため、`aws` で始まらない名前への変更が必要 |
| DLQ アラームが 2026-09-05 から ALARM のまま | Phase 2 の検証時に溜まったメッセージと思われる。未調査 |
| Ingestion Job が多い（約6週間で419回） | SQS バッチごとにジョブが起動するため。料金への影響は小さい |
| 同じ記事のチャンクが検索結果を占める | `search_aws_updates` で URL ごとにまとめる処理が未実装 |
| MCP クライアントからの接続 | 未検証。Tools Lambda の呼び出しは0回 |
| `category` が `source` と同じ値 | 意味のある分類（サービス名、分野など）に作り直す予定 |
