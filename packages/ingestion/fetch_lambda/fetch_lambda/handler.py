from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3

from fetch_lambda.article import extract_main_content_html, fetch_article_html, html_to_markdown
from fetch_lambda.models import ArticleMetadata, FeedEntry, FeedSource
from fetch_lambda.rss import fetch_feed
from fetch_lambda.s3_writer import build_object_key, put_article
from fetch_lambda.state_store import ArticleStateStore

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# boto3 クライアントはコールドスタート時に一度だけ生成する。
_dynamodb = boto3.resource("dynamodb")
_s3 = boto3.client("s3")

SOURCES: list[FeedSource] = [
    FeedSource(
        name="whats-new",
        url="https://aws.amazon.com/about-aws/whats-new/recent/feed/",
        category="whats-new",
    ),
    FeedSource(
        name="news-blog",
        url="https://aws.amazon.com/blogs/aws/feed/",
        category="news-blog",
    ),
    FeedSource(
        name="jp-blog",
        url="https://aws.amazon.com/jp/blogs/news/feed/",
        category="jp-blog",
    ),
]


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    bucket = os.environ["ARTICLES_BUCKET_NAME"]
    table_name = os.environ["STATE_TABLE_NAME"]
    state_store = ArticleStateStore(_dynamodb.Table(table_name))

    processed = 0
    skipped = 0
    failed = 0

    for source in SOURCES:
        try:
            entries = fetch_feed(source)
        except Exception:
            logger.exception(json.dumps({"event": "feed_fetch_failed", "source": source.name}))
            failed += 1
            continue

        for entry in entries:
            if not state_store.is_new(entry.guid):
                skipped += 1
                continue
            try:
                _process_entry(source, entry, bucket)
                state_store.mark_processed(entry.guid, entry.link, entry.published_at)
                processed += 1
            except Exception:
                logger.exception(json.dumps({"event": "article_process_failed", "url": entry.link}))
                failed += 1

    result = {"processed": processed, "skipped": skipped, "failed": failed}
    logger.info(json.dumps({"event": "fetch_completed", **result}))
    return result


def _process_entry(source: FeedSource, entry: FeedEntry, bucket: str) -> None:
    html = fetch_article_html(entry.link)
    content_html = extract_main_content_html(html)
    markdown = html_to_markdown(content_html)

    metadata = ArticleMetadata(
        title=entry.title,
        url=entry.link,
        published_at=entry.published_at,
        category=source.category,
        source=source.name,
    )
    key = build_object_key(entry.published_at, entry.title, entry.guid)
    put_article(_s3, bucket, key, markdown, metadata.to_bedrock_metadata())
    logger.info(json.dumps({"event": "article_ingested", "url": entry.link, "key": key}))
