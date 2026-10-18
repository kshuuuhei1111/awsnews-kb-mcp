from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

_DEFAULT_NUMBER_OF_RESULTS = 5
_EXCERPT_LENGTH = 500


class BedrockAgentRuntimeClient(Protocol):
    """boto3 の bedrock-agent-runtime クライアントのうち、本モジュールが使う操作のみを表す。"""

    def retrieve(self, **kwargs: Any) -> dict: ...


def build_retrieval_filter(
    since_days: int | None = None,
    category: str | None = None,
    source: str | None = None,
    lang: str | None = None,
) -> dict | None:
    """search_aws_updates の引数から Bedrock Retrieve 用のメタデータフィルタを組み立てる。"""
    conditions: list[dict] = []

    if since_days is not None:
        # S3 Vectors の範囲比較は数値のみ対応のため、ISO8601 文字列ではなく Unix 秒で比較する。
        cutoff = int((datetime.now(tz=UTC) - timedelta(days=since_days)).timestamp())
        conditions.append({"greaterThanOrEquals": {"key": "published_at_epoch", "value": cutoff}})
    if category:
        conditions.append({"equals": {"key": "category", "value": category}})
    if source:
        conditions.append({"equals": {"key": "source", "value": source}})
    if lang:
        conditions.append({"equals": {"key": "lang", "value": lang}})

    if not conditions:
        return None
    if len(conditions) == 1:
        return conditions[0]
    return {"andAll": conditions}


def format_result(result: dict) -> dict:
    metadata = result.get("metadata", {})
    text = result.get("content", {}).get("text", "")
    return {
        "score": result.get("score"),
        "title": metadata.get("title"),
        "url": metadata.get("url"),
        "published_at": metadata.get("published_at"),
        "category": metadata.get("category"),
        "source": metadata.get("source"),
        "lang": metadata.get("lang"),
        "excerpt": text[:_EXCERPT_LENGTH],
    }


def search_aws_updates(
    client: BedrockAgentRuntimeClient,
    knowledge_base_id: str,
    query: str,
    since_days: int | None = None,
    category: str | None = None,
    source: str | None = None,
    lang: str | None = None,
) -> dict:
    """KB Retrieve をメタデータフィルタ付きで呼び、スコア・タイトル・URL・抜粋・公開日を返す。"""
    vector_search_configuration: dict[str, Any] = {
        "numberOfResults": _DEFAULT_NUMBER_OF_RESULTS,
    }
    retrieval_filter = build_retrieval_filter(since_days, category, source, lang)
    if retrieval_filter is not None:
        vector_search_configuration["filter"] = retrieval_filter

    response = client.retrieve(
        knowledgeBaseId=knowledge_base_id,
        retrievalQuery={"text": query},
        retrievalConfiguration={"vectorSearchConfiguration": vector_search_configuration},
    )
    results = [format_result(r) for r in response.get("retrievalResults", [])]
    return {"results": results}
