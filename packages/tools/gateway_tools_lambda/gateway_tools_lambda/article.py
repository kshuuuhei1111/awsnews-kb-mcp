from __future__ import annotations

from typing import Any, Protocol
from urllib.parse import urlparse


class BedrockAgentRuntimeClient(Protocol):
    def retrieve(self, **kwargs: Any) -> dict: ...


class S3Client(Protocol):
    def get_object(self, **kwargs: Any) -> dict: ...


def parse_s3_uri(uri: str) -> tuple[str, str]:
    """`s3://bucket/key` 形式のURIをバケット名とキーに分解する。"""
    parsed = urlparse(uri)
    if parsed.scheme != "s3":
        raise ValueError(f"not an s3 URI: {uri}")
    return parsed.netloc, parsed.path.lstrip("/")


def get_article(
    bedrock_client: BedrockAgentRuntimeClient,
    s3_client: S3Client,
    knowledge_base_id: str,
    url: str,
) -> dict:
    """記事URLからKB経由でS3上のMarkdown全文を取得する。

    URL→S3キーの対応表を別途持たず、Bedrock KBのメタデータフィルタ（url完全一致）で
    該当記事を1件だけ引き当て、Retrieve結果に含まれる location.s3Location.uri から
    S3オブジェクトを直接取得する。
    """
    response = bedrock_client.retrieve(
        knowledgeBaseId=knowledge_base_id,
        retrievalQuery={"text": url},
        retrievalConfiguration={
            "vectorSearchConfiguration": {
                "numberOfResults": 1,
                "filter": {"equals": {"key": "url", "value": url}},
            }
        },
    )
    results = response.get("retrievalResults", [])
    if not results:
        return {"error": "article_not_found", "url": url}

    result = results[0]
    uri = result["location"]["s3Location"]["uri"]
    bucket, key = parse_s3_uri(uri)

    obj = s3_client.get_object(Bucket=bucket, Key=key)
    markdown = obj["Body"].read().decode("utf-8")

    metadata = result.get("metadata", {})
    return {
        "url": url,
        "title": metadata.get("title"),
        "published_at": metadata.get("published_at"),
        "category": metadata.get("category"),
        "source": metadata.get("source"),
        "markdown": markdown,
    }
