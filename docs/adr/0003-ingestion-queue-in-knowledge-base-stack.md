# ADR-0003: KB追加キュー(SQS/DLQ)をKnowledgeBaseStackに配置する

- ステータス: Accepted
- 日付: 2026-09-05

## コンテキスト

依頼書のフェーズ分割（セクション5）では、SQS/DLQ は Phase 2 の IngestionStack に含める
想定になっている。一方 S3 記事バケットは Phase 1 の KnowledgeBaseStack に属する。

`cdk synth` を実行したところ、以下のスタック依存の循環でエラーになった:

```
«DependencyCycle» 'IngestionStack' depends on 'KnowledgeBaseStack'
Adding this dependency (<KnowledgeBaseStack/ArticlesBucket/Notifications/Resource>
  .node.addDependency(<IngestionStack/KbIngestQueue>)) would create a cyclic reference.
```

## 原因

CDK の `Bucket#addEventNotification()` は、通知設定を反映するカスタムリソース
（`Custom::S3BucketNotifications`）を、呼び出しコード上の場所に関わらず**バケット構築物
自身が属するスタック**（ここでは KnowledgeBaseStack）の子として生成する。

このカスタムリソースが通知先の SQS キュー（IngestionStack 側）を参照するため、
CDK は自動的に `KnowledgeBaseStack → IngestionStack` の依存を追加する。

一方 IngestionStack は Fetch Lambda / Ingest Trigger Lambda の環境変数・IAM許可のために
記事バケット名・Knowledge Base ID・DataSource ID を KnowledgeBaseStack から参照しており、
これは `IngestionStack → KnowledgeBaseStack` の依存を生む。

双方向の依存は CDK では許可されず、synth 時にエラーとなる。

## 決定

KB追加キュー（`KbIngestQueue`）と DLQ（`KbIngestDlq`）、および S3 → SQS のイベント通知配線を
**KnowledgeBaseStack に配置する**。IngestionStack はこのキューを `props` 経由で受け取り、
Ingest Trigger Lambda のイベントソースとして消費するだけにする。

依存方向は `IngestionStack → KnowledgeBaseStack` の一方向のみになり、循環が解消される。

## 影響

- `KnowledgeBaseStack` が公開する props: `articlesBucket` に加え `kbIngestQueue` /
  `kbIngestDlq` を追加
- `IngestionStack` の役割は「キューを作る」から「キューを消費する」に変わる。
  CLAUDE.md のディレクトリ構成説明（「IngestionStack: Scheduler, Fetch Lambda, DynamoDB,
  SQS/DLQ, ...」）の「SQS/DLQ」は物理的な配置スタックではなく論理的な取り込みパイプラインの
  構成要素として読み替える
- 今後、GatewayStack など他スタックが S3 バケットにイベント通知を追加する場合も、
  同様の制約（通知カスタムリソースはバケット側スタックに生成される）に注意する

## 教訓（一般化）

S3 バケットと通知先リソースが別スタックにまたがり、かつ通知先スタックが
バケット側スタックの出力（バケット名・ARN等）を必要とする設計では、
`addEventNotification` によって高確率でスタック依存の循環が起きる。
**通知先リソース（この場合SQSキュー）はバケットと同じスタックに置く**のが最も単純な回避策。
