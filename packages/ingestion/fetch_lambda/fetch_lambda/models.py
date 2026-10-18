from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FeedSource:
    """取得対象の RSS フィード1つ分の定義。"""

    name: str
    url: str
    category: str
    lang: str
    """記事の言語（"ja" / "en"）。フィード単位で決まる。"""


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
    published_at_epoch: int
    """published_at の Unix 秒。S3 Vectors の範囲比較フィルタは数値にしか使えないため併記する。"""
    category: str
    source: str
    lang: str

    def to_bedrock_metadata(self) -> dict:
        return {
            "metadataAttributes": {
                "title": self.title,
                "url": self.url,
                "published_at": self.published_at,
                "published_at_epoch": self.published_at_epoch,
                "category": self.category,
                "source": self.source,
                "lang": self.lang,
            }
        }
