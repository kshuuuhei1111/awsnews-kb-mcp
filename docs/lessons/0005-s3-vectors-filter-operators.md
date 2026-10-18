# S3 Vectors では日付文字列の範囲フィルタも前方一致フィルタも使えない

- 発生フェーズ: Phase 3 後の動作確認（メタデータフィルタの検証）

## 事象

`search_aws_updates` の `since_days` は、`published_at`（ISO8601 文字列）に対する
`greaterThanOrEquals` フィルタとして実装していたが、`bedrock-agent-runtime retrieve` で
実際に試すと次のエラーになった:

```
ValidationException: The filter value type provided isn't supported for the given operation:
GREATER_THAN_OR_EQUALS.
```

回避策として `startsWith`（例: `"2026-10"` で前方一致）も試したが、こちらも失敗した:

```
ValidationException: STARTS_WITH operation type is not supported for S3 Vectors
```

## 原因

- `greaterThan` / `greaterThanOrEquals` / `lessThan` / `lessThanOrEquals` は数値にしか使えない
- `startsWith` / `stringContains` は S3 Vectors をベクトルストアにした KB では未対応

Fetch Lambda が書き出すメタデータの日付が文字列だけだったため、日付の範囲指定ができなかった。

## 対処

- メタデータに `published_at_epoch`（Unix 秒、数値）を追加し、`since_days` はこのキーで比較する
- 取り込み済み記事は `scripts/backfill-metadata.sh --apply` で `.metadata.json` に追記し、
  `StartIngestionJob` で再同期する（S3 イベント通知は `.md` のみが対象のため、
  `.metadata.json` の更新だけでは取り込みが自動起動しない）

## 検証で確認できたフィルタ（2026-10-18 時点、S3 Vectors）

| 演算子 | 結果 |
|---|---|
| `equals` / `notEquals`（文字列） | 使える |
| `in`（文字列） | 使える |
| `andAll`（上記の組み合わせ） | 使える |
| `greaterThanOrEquals`（文字列） | 使えない |
| `startsWith` | 使えない |

## 教訓

- メタデータを設計する時点で「どの演算子で絞り込むか」を決め、範囲で絞る項目は数値で持つ
- フィルタ付きの検索は `numberOfResults` より少ない件数しか返らないことがある
  （3件指定で2件など）。件数が重要な場合は多めに取得して後段で絞る
