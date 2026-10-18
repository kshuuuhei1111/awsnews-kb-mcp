import pytest
from gateway_tools_lambda.article import get_article, parse_s3_uri


def test_parse_s3_uri_splits_bucket_and_key():
    bucket, key = parse_s3_uri("s3://my-bucket/news/2026/09/example.md")

    assert bucket == "my-bucket"
    assert key == "news/2026/09/example.md"


def test_parse_s3_uri_rejects_non_s3_scheme():
    with pytest.raises(ValueError, match="not an s3 URI"):
        parse_s3_uri("https://example.com/x")


class FakeBedrockAgentRuntime:
    def __init__(self, response: dict) -> None:
        self._response = response
        self.last_call: dict | None = None

    def retrieve(self, **kwargs):
        self.last_call = kwargs
        return self._response


class FakeBody:
    def __init__(self, text: str) -> None:
        self._text = text

    def read(self) -> bytes:
        return self._text.encode("utf-8")


class FakeS3:
    def __init__(self, body_text: str) -> None:
        self._body_text = body_text
        self.last_call: dict | None = None

    def get_object(self, **kwargs):
        self.last_call = kwargs
        return {"Body": FakeBody(self._body_text)}


def test_get_article_returns_markdown_from_matched_document():
    bedrock = FakeBedrockAgentRuntime(
        {
            "retrievalResults": [
                {
                    "location": {"s3Location": {"uri": "s3://my-bucket/news/2026/09/x.md"}},
                    "metadata": {
                        "title": "Example",
                        "url": "https://aws.amazon.com/x",
                        "published_at": "2026-09-01T00:00:00+00:00",
                        "category": "whats-new",
                        "source": "whats-new",
                    },
                }
            ]
        }
    )
    s3 = FakeS3("# Example\nbody")

    result = get_article(
        bedrock_client=bedrock,
        s3_client=s3,
        knowledge_base_id="kb-1",
        url="https://aws.amazon.com/x",
    )

    assert bedrock.last_call["retrievalConfiguration"]["vectorSearchConfiguration"]["filter"] == {
        "equals": {"key": "url", "value": "https://aws.amazon.com/x"}
    }
    assert s3.last_call == {"Bucket": "my-bucket", "Key": "news/2026/09/x.md"}
    assert result["markdown"] == "# Example\nbody"
    assert result["title"] == "Example"


def test_get_article_returns_error_when_not_found():
    bedrock = FakeBedrockAgentRuntime({"retrievalResults": []})
    s3 = FakeS3("")

    result = get_article(
        bedrock_client=bedrock,
        s3_client=s3,
        knowledge_base_id="kb-1",
        url="https://aws.amazon.com/missing",
    )

    assert result == {"error": "article_not_found", "url": "https://aws.amazon.com/missing"}
