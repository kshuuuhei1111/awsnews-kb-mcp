from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Protocol


class S3Client(Protocol):
    """boto3 の S3 クライアントのうち、本モジュールが使う操作のみを表す。"""

    def put_object(self, **kwargs) -> dict: ...


def slugify(title: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", title.strip().lower()).strip("-")
    return normalized[:80] or "article"


def build_object_key(published_at: str, title: str, guid: str) -> str:
    """記事の公開日・タイトル・GUIDから S3 オブジェクトキーを組み立てる。

    記事タイトルの重複によるキー衝突を避けるため、GUID の短いハッシュを付与する。
    """
    dt = datetime.fromisoformat(published_at)
    slug = slugify(title)
    short_hash = hashlib.sha1(guid.encode("utf-8")).hexdigest()[:8]
    return f"news/{dt:%Y}/{dt:%m}/{slug}-{short_hash}.md"


def put_article(
    s3_client: S3Client,
    bucket: str,
    key: str,
    markdown: str,
    metadata: dict,
) -> None:
    """本文Markdownと、Bedrock KB用のメタデータサイドカーをS3に書き込む。"""
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=markdown.encode("utf-8"),
        ContentType="text/markdown; charset=utf-8",
    )
    s3_client.put_object(
        Bucket=bucket,
        Key=f"{key}.metadata.json",
        Body=json.dumps(metadata, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
