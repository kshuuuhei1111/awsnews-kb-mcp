import pytest
from fetch_lambda import handler as handler_module
from fetch_lambda.models import FeedEntry, FeedSource


class FakeTable:
    def __init__(self) -> None:
        self.items: dict[str, dict] = {}

    def get_item(self, Key: dict) -> dict:
        guid = Key["guid"]
        return {"Item": self.items[guid]} if guid in self.items else {}

    def put_item(self, Item: dict) -> dict:
        self.items[Item["guid"]] = Item
        return {}


class FakeDynamoDBResource:
    def __init__(self, table: FakeTable) -> None:
        self._table = table

    def Table(self, name: str) -> FakeTable:
        return self._table


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_object(self, Bucket: str, Key: str, Body: bytes, ContentType: str) -> dict:
        self.objects[Key] = Body
        return {}


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARTICLES_BUCKET_NAME", "test-bucket")
    monkeypatch.setenv("STATE_TABLE_NAME", "test-table")


def test_handler_processes_only_new_entries_and_writes_both_objects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_table = FakeTable()
    fake_table.items["already-seen-guid"] = {"guid": "already-seen-guid"}
    fake_s3 = FakeS3()

    monkeypatch.setattr(handler_module, "_dynamodb", FakeDynamoDBResource(fake_table))
    monkeypatch.setattr(handler_module, "_s3", fake_s3)

    entries_by_source = {
        "whats-new": [
            FeedEntry(
                guid="already-seen-guid",
                title="Old",
                link="https://x/old",
                published_at="2026-01-01T00:00:00+00:00",
                source="whats-new",
            ),
            FeedEntry(
                guid="new-guid",
                title="New Feature",
                link="https://x/new",
                published_at="2026-09-01T00:00:00+00:00",
                source="whats-new",
            ),
        ],
        "news-blog": [],
        "jp-blog": [],
    }

    monkeypatch.setattr(handler_module, "fetch_feed", lambda source: entries_by_source[source.name])
    monkeypatch.setattr(
        handler_module, "fetch_article_html", lambda url: "<main><p>content</p></main>"
    )
    monkeypatch.setattr(handler_module, "extract_main_content_html", lambda html: html)
    monkeypatch.setattr(handler_module, "html_to_markdown", lambda html: "# content\n")

    result = handler_module.handler({}, None)

    assert result == {"processed": 1, "skipped": 1, "failed": 0}
    assert "new-guid" in fake_table.items
    assert len(fake_s3.objects) == 2  # 本文 .md + .md.metadata.json


def test_handler_counts_feed_fetch_failure_per_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(handler_module, "_dynamodb", FakeDynamoDBResource(FakeTable()))
    monkeypatch.setattr(handler_module, "_s3", FakeS3())

    def raise_error(source: FeedSource) -> list[FeedEntry]:
        raise RuntimeError("network error")

    monkeypatch.setattr(handler_module, "fetch_feed", raise_error)

    result = handler_module.handler({}, None)

    assert result == {"processed": 0, "skipped": 0, "failed": len(handler_module.SOURCES)}


def test_handler_counts_article_processing_failure_without_marking_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_table = FakeTable()
    monkeypatch.setattr(handler_module, "_dynamodb", FakeDynamoDBResource(fake_table))
    monkeypatch.setattr(handler_module, "_s3", FakeS3())

    entries_by_source = {
        "whats-new": [
            FeedEntry(
                guid="broken-guid",
                title="Broken",
                link="https://x/broken",
                published_at="2026-09-01T00:00:00+00:00",
                source="whats-new",
            )
        ],
        "news-blog": [],
        "jp-blog": [],
    }
    monkeypatch.setattr(handler_module, "fetch_feed", lambda source: entries_by_source[source.name])

    def raise_error(url: str) -> str:
        raise RuntimeError("fetch failed")

    monkeypatch.setattr(handler_module, "fetch_article_html", raise_error)

    result = handler_module.handler({}, None)

    assert result == {"processed": 0, "skipped": 0, "failed": 1}
    assert "broken-guid" not in fake_table.items
