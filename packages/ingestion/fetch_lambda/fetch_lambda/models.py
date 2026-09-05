from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FeedSource:
    """取得対象の RSS フィード1つ分の定義。"""

    name: str
    url: str
    category: str


@dataclass(frozen=True)
class FeedEntry:
    """RSS フィードから取得した1記事分のエントリ。"""

    guid: str
    title: str
    link: str
    published_at: str
    """ISO8601形式の公開日時。"""
    source: str


@dataclass(frozen=True)
class ArticleMetadata:
    """S3 に書き込む記事の metadata.json の中身。"""

    title: str
    url: str
    published_at: str
    category: str
    source: str

    def to_bedrock_metadata(self) -> dict:
        return {
            "metadataAttributes": {
                "title": self.title,
                "url": self.url,
                "published_at": self.published_at,
                "category": self.category,
                "source": self.source,
            }
        }
