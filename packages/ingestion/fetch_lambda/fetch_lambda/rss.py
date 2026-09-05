from __future__ import annotations

from datetime import UTC, datetime
from time import struct_time

import feedparser
import requests

from fetch_lambda.models import FeedEntry, FeedSource

_REQUEST_TIMEOUT_SECONDS = 15


def fetch_feed(source: FeedSource) -> list[FeedEntry]:
    """RSS フィードを取得し、パース済みのエントリ一覧を返す。"""
    response = requests.get(source.url, timeout=_REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()
    return parse_feed(response.content, source)


def parse_feed(raw: bytes, source: FeedSource) -> list[FeedEntry]:
    """RSS の生バイト列をパースして FeedEntry のリストに変換する（ネットワークI/Oなし）。"""
    parsed = feedparser.parse(raw)
    entries: list[FeedEntry] = []
    for entry in parsed.entries:
        guid = getattr(entry, "id", None) or getattr(entry, "link", None)
        link = getattr(entry, "link", None)
        title = getattr(entry, "title", None)
        if not guid or not link or not title:
            continue
        published_struct = getattr(entry, "published_parsed", None) or getattr(
            entry, "updated_parsed", None
        )
        entries.append(
            FeedEntry(
                guid=guid,
                title=title,
                link=link,
                published_at=_to_iso8601(published_struct),
                source=source.name,
            )
        )
    return entries


def _to_iso8601(published_struct: struct_time | None) -> str:
    if published_struct is None:
        return datetime.now(tz=UTC).isoformat()
    dt = datetime(*published_struct[:6], tzinfo=UTC)
    return dt.isoformat()
