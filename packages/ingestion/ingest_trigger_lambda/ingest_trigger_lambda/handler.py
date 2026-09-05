from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# boto3 クライアントはコールドスタート時に一度だけ生成する。
_bedrock_agent = boto3.client("bedrock-agent")

# KB あたり同時1ジョブの制約に抵触したときに Bedrock が返すエラーコード。
_CONFLICT_ERROR_CODE = "ConflictException"


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """S3 ObjectCreated → SQS 経由のイベントを受けて StartIngestionJob を呼ぶ。

    StartIngestionJob は呼ぶたびにデータソース全体を再同期するため、バッチ内の
    メッセージ件数に関わらず1バッチにつき1回だけ呼べば十分。レコードごとに呼ぶと
    冗長なジョブが連続実行され、ジョブ同士が競合してドキュメント処理が失敗する
    原因になる（Phase 2の手動検証で確認済み。docs/lessons 参照）。

    KB あたり同時1ジョブまでという制約があるため、既に実行中の場合は
    ERROR ログを出さずに WARNING に留め、SQS の可視性タイムアウト経過後に
    バッチ全体を再試行させる（`batchItemFailures` に含めてメッセージを再キューする）。
    """
    records = event.get("Records", [])
    if not records:
        return {"batchItemFailures": []}

    knowledge_base_id = os.environ["KNOWLEDGE_BASE_ID"]
    data_source_id = os.environ["DATA_SOURCE_ID"]
    message_ids = [record["messageId"] for record in records]

    try:
        _bedrock_agent.start_ingestion_job(
            knowledgeBaseId=knowledge_base_id,
            dataSourceId=data_source_id,
        )
        logger.info(json.dumps({"event": "ingestion_job_started", "batchSize": len(records)}))
        return {"batchItemFailures": []}
    except ClientError as error:
        error_code = error.response.get("Error", {}).get("Code")
        if error_code == _CONFLICT_ERROR_CODE:
            logger.warning(json.dumps({"event": "ingestion_job_already_running"}))
        else:
            logger.error(
                json.dumps({"event": "ingestion_job_start_failed", "errorCode": error_code}),
                exc_info=True,
            )
        return {"batchItemFailures": [{"itemIdentifier": mid} for mid in message_ids]}
