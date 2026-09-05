import json

from fetch_lambda.s3_writer import build_object_key, put_article, slugify


class FakeS3:
    def __init__(self) -> None:
        self.puts: dict[str, dict] = {}

    def put_object(self, Bucket: str, Key: str, Body: bytes, ContentType: str) -> dict:
        self.puts[Key] = {"Bucket": Bucket, "Body": Body, "ContentType": ContentType}
        return {}


def test_slugify_normalizes_title():
    assert slugify("Amazon Example Service: New Feature!") == "amazon-example-service-new-feature"


def test_slugify_falls_back_when_no_alnum_chars():
    assert slugify("!!!") == "article"


def test_build_object_key_uses_year_month_and_guid_hash():
    key = build_object_key(
        published_at="2026-09-01T10:00:00+00:00",
        title="Amazon Example Service now supports a new feature",
        guid="https://aws.amazon.com/about-aws/whats-new/2026/09/example/",
    )

    assert key.startswith("news/2026/09/amazon-example-service-now-supports-a-new-feature-")
    assert key.endswith(".md")


def test_put_article_writes_markdown_and_metadata_sidecar():
    s3 = FakeS3()
    metadata = {
        "metadataAttributes": {
            "title": "Amazon Example Service now supports a new feature",
            "url": "https://aws.amazon.com/about-aws/whats-new/2026/09/example/",
            "published_at": "2026-09-01T10:00:00+00:00",
            "category": "whats-new",
            "source": "whats-new",
        }
    }

    put_article(s3, "my-bucket", "news/2026/09/example.md", "# Title\n", metadata)

    assert set(s3.puts.keys()) == {
        "news/2026/09/example.md",
        "news/2026/09/example.md.metadata.json",
    }
    assert s3.puts["news/2026/09/example.md"]["Body"] == b"# Title\n"
    assert s3.puts["news/2026/09/example.md"]["ContentType"].startswith("text/markdown")

    sidecar = json.loads(s3.puts["news/2026/09/example.md.metadata.json"]["Body"])
    assert sidecar == metadata
