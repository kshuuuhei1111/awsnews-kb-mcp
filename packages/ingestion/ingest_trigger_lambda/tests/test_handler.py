from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError
from ingest_trigger_lambda import handler as handler_module


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KNOWLEDGE_BASE_ID", "kb-123")
    monkeypatch.setenv("DATA_SOURCE_ID", "ds-456")


def _sqs_event(message_ids: list[str]) -> dict:
    return {"Records": [{"messageId": mid} for mid in message_ids]}


def test_handler_starts_ingestion_job_once_for_a_single_message_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client = MagicMock()
    monkeypatch.setattr(handler_module, "_bedrock_agent", fake_client)

    result = handler_module.handler(_sqs_event(["m1"]), None)

    fake_client.start_ingestion_job.assert_called_once_with(
        knowledgeBaseId="kb-123", dataSourceId="ds-456"
    )
    assert result == {"batchItemFailures": []}


def test_handler_starts_ingestion_job_only_once_even_for_a_multi_message_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # StartIngestionJobはデータソース全体を再同期するため、バッチ内のメッセージ件数に
    # 関わらず1回呼べば十分。レコードごとに呼ぶと冗長なジョブが競合する。
    fake_client = MagicMock()
    monkeypatch.setattr(handler_module, "_bedrock_agent", fake_client)

    result = handler_module.handler(_sqs_event(["m1", "m2", "m3"]), None)

    fake_client.start_ingestion_job.assert_called_once_with(
        knowledgeBaseId="kb-123", dataSourceId="ds-456"
    )
    assert result == {"batchItemFailures": []}


def test_handler_noop_for_empty_batch(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_client = MagicMock()
    monkeypatch.setattr(handler_module, "_bedrock_agent", fake_client)

    result = handler_module.handler({"Records": []}, None)

    fake_client.start_ingestion_job.assert_not_called()
    assert result == {"batchItemFailures": []}


def test_handler_requeues_on_conflict_without_treating_as_hard_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client = MagicMock()
    fake_client.start_ingestion_job.side_effect = ClientError(
        {"Error": {"Code": "ConflictException", "Message": "already running"}},
        "StartIngestionJob",
    )
    monkeypatch.setattr(handler_module, "_bedrock_agent", fake_client)

    result = handler_module.handler(_sqs_event(["m1"]), None)

    assert result == {"batchItemFailures": [{"itemIdentifier": "m1"}]}


def test_handler_requeues_on_unexpected_client_error(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_client = MagicMock()
    fake_client.start_ingestion_job.side_effect = ClientError(
        {"Error": {"Code": "ThrottlingException", "Message": "too many requests"}},
        "StartIngestionJob",
    )
    monkeypatch.setattr(handler_module, "_bedrock_agent", fake_client)

    result = handler_module.handler(_sqs_event(["m1", "m2"]), None)

    assert result == {"batchItemFailures": [{"itemIdentifier": "m1"}, {"itemIdentifier": "m2"}]}
