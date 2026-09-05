# S3 Vectors の Filterable metadata 上限(2048バイト)超過でIngestionJobが失敗する

- 発生フェーズ: Phase 2（初回同期の手動検証）

## 事象

Fetch Lambda で130記事をS3に投入後、`StartIngestionJob` を複数回実行しても
毎回同じ約47件のドキュメントが `FAILED` になった（`numberOfDocumentsFailed`）。
ジョブ自体が `FAILED` になったケースで `get-ingestion-job` の `failureReasons` を見ると:

```
Encountered error: Invalid record for key '...': Filterable metadata must have at
most 2048 bytes (Service: S3Vectors, Status Code: 400) ...
```

## 原因

S3 Vectors の Vector Index 作成時、`VectorIndex` の `nonFilterableMetadataKeys` に
`AMAZON_BEDROCK_TEXT`（Bedrock KBが本文チャンクを格納する内部キー）のみを指定していたが、
Bedrock KB は本文チャンクとは別に `AMAZON_BEDROCK_METADATA` という内部キーにもチャンクの
付随情報を格納している。このキーを non-filterable として除外していなかったため、
本文チャンク長やメタデータの組み合わせによっては、フィルタ可能メタデータの合計が
S3 Vectors の上限（1ベクトルあたり2048バイト）を超え、該当チャンクを含む記事全体が
ドキュメント単位で `FAILED` になっていた。

短い記事（チャンクが小さい/1個で収まる）は上限を超えず成功し、長い記事
（複数チャンクに分割され、チャンクサイズが大きい）ほど失敗しやすかったのはこのため。

## 対処

`packages/infra/lib/knowledge-base-stack.ts` の `VectorIndex` 定義で
`nonFilterableMetadataKeys` に `AMAZON_BEDROCK_METADATA` を追加した:

```ts
nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
```

## 教訓

- S3 Vectors をベクトルストアとして使う Bedrock KB では、`AMAZON_BEDROCK_TEXT` と
  `AMAZON_BEDROCK_METADATA` の**両方**を `nonFilterableMetadataKeys` に含めることが
  実質必須。片方だけだとチャンクサイズによって断続的に失敗する
- `get-ingestion-job` の `documentDetails` レベルでは `statusReason` が空文字列になる
  ことがあり、原因特定には**ジョブ全体が `FAILED` ステータスになったときの
  `failureReasons` フィールド**を確認する必要がある（`COMPLETE` かつ部分失敗の場合は
  この詳細が取れないため、再実行してジョブ全体が失敗するケースを踏むか、
  CloudWatch等の別経路を検討する）
- 修正後は VectorIndex の置き換え（`nonFilterableMetadataKeys` はインデックス作成時のみ
  指定可能）が発生するため、`cdk deploy` 後に改めて `StartIngestionJob` を実行し直す必要がある
- **追記**: 実際に `cdk deploy` したところ、`AWS::Bedrock::KnowledgeBase` の
  `KnowledgeBase with name awsnews-kb-mcp already exists (409 AlreadyExists)` で
  `UPDATE_FAILED` になった。Bedrock KB の名前はアカウント内でグローバルに一意である必要が
  あり、CloudFormation の replace 更新は「新しいリソースを作成 → 成功したら古いリソースを
  削除」の順で行われるため、固定名のまま VectorIndex 変更（＝KBも道連れでreplacement対象に
  なる）を行うと新旧の名前が衝突する。対処として `name` プロパティ自体をバージョン付き
  （`awsnews-kb-mcp-v2` 等）に変更してから再デプロイした。**今後 VectorIndex や
  KnowledgeBase のreplaceを伴う変更をする際は、毎回nameを変える必要がある**
