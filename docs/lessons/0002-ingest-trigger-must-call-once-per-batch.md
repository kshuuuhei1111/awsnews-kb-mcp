# StartIngestionJob はバッチごとに1回だけ呼ぶ（レコードごとに呼ばない）

- 発生フェーズ: Phase 2（初回同期の手動検証）

## 事象

Fetch Lambda を手動実行して130記事をS3に書き込んだ後、`bedrock-agent list-ingestion-jobs`
で確認すると、短時間に7件の `COMPLETE` ジョブと1件の `IN_PROGRESS` ジョブが連続して
実行されていた。最初の `COMPLETE` ジョブの `get-ingestion-job` を見ると
`numberOfDocumentsFailed: 10` が発生していた。

## 原因

初期実装の `ingest_trigger_lambda/handler.py` は、SQSイベントの `Records` を
1件ずつループし、**レコードごとに** `StartIngestionJob` を呼んでいた。
`StartIngestionJob` は呼ぶたびにデータソース**全体**を再同期するAPIであり、
1バッチ（最大10件のS3イベント）に対して1回呼べば十分。

レコードごとに呼んだ結果、バッチ内で最初の1件が同期ジョブを開始し、残り9件は
`ConflictException` で再キューされる想定だったが、複数のバッチ・複数回の
Lambda呼び出しにまたがって同様のことが連鎖的に起こり、KBあたり同時1ジョブの制約下でも
「前のジョブの終了直後に次のジョブが始まる」という連続実行が多発した。
この連続実行の狭間で、あるジョブが処理中のドキュメントを次のジョブが同時に触りにいく
競合が起き、一部ドキュメントの処理失敗（`numberOfDocumentsFailed: 10`）につながったと
考えられる。加えて、同じデータソース全体を何度も再同期するため、埋め込みAPI呼び出しが
無駄に繰り返されコスト面でも非効率だった。

## 対処

`handler.py` を、バッチ全体に対して `StartIngestionJob` を1回だけ呼ぶように変更した。
成功時は空の `batchItemFailures`、失敗時（ConflictException含む）はバッチ内の
全メッセージIDを `batchItemFailures` に含めて丸ごと再キューする。

## 影響・教訓

- Bedrock KB の `StartIngestionJob` のように「呼び出し単位ではなくリソース全体を
  対象とする」APIをイベント駆動で叩く場合、イベントの粒度（S3オブジェクト単位）と
  API呼び出しの粒度（データソース全体）を混同しない
- SQSのバッチ処理では「バッチ内の各レコードに対して同じ操作を1回ずつ行う」パターンが
  デフォルトで正しいとは限らない。冪等性のないAPIや全体同期系のAPIでは、
  バッチ単位で集約してから1回だけ呼ぶ設計を検討する
- 再現手順: 大量の新着記事（100件超）を一度のFetch Lambda実行で処理すると、
  S3イベントが短時間に大量発生しSQSバッチが複数生成されるため、この問題が顕在化しやすい
