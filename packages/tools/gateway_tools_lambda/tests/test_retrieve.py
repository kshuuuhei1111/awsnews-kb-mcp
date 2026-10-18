import time

from gateway_tools_lambda.retrieve import build_retrieval_filter, format_result, search_aws_updates


def test_build_retrieval_filter_returns_none_when_no_args():
    assert build_retrieval_filter() is None


def test_build_retrieval_filter_single_condition_is_not_wrapped():
    filter_ = build_retrieval_filter(category="whats-new")

    assert filter_ == {"equals": {"key": "category", "value": "whats-new"}}


def test_build_retrieval_filter_combines_conditions_with_and_all():
    filter_ = build_retrieval_filter(since_days=7, category="whats-new", source="whats-new")

    assert filter_["andAll"][0]["greaterThanOrEquals"]["key"] == "published_at_epoch"
    assert filter_["andAll"][1] == {"equals": {"key": "category", "value": "whats-new"}}
    assert filter_["andAll"][2] == {"equals": {"key": "source", "value": "whats-new"}}


def test_build_retrieval_filter_since_days_produces_epoch_seconds_cutoff():
    before = int(time.time()) - 86400
    filter_ = build_retrieval_filter(since_days=1)
    after = int(time.time()) - 86400

    cutoff = filter_["greaterThanOrEquals"]["value"]
    # S3 Vectors の範囲比較は数値のみ対応のため、文字列ではなく int であること
    assert isinstance(cutoff, int)
    assert before <= cutoff <= after


def test_build_retrieval_filter_lang():
    assert build_retrieval_filter(lang="ja") == {"equals": {"key": "lang", "value": "ja"}}


def test_format_result_extracts_expected_fields():
    result = {
        "score": 0.71,
        "content": {"text": "x" * 600},
        "metadata": {
            "title": "Example",
            "url": "https://example.com/a",
            "published_at": "2026-09-01T00:00:00+00:00",
            "category": "whats-new",
            "source": "whats-new",
        },
    }

    formatted = format_result(result)

    assert formatted["score"] == 0.71
    assert formatted["title"] == "Example"
    assert formatted["url"] == "https://example.com/a"
    assert len(formatted["excerpt"]) == 500


class FakeBedrockAgentRuntime:
    def __init__(self, response: dict) -> None:
        self._response = response
        self.last_call: dict | None = None

    def retrieve(self, **kwargs):
        self.last_call = kwargs
        return self._response


def test_search_aws_updates_passes_filter_and_formats_results():
    client = FakeBedrockAgentRuntime(
        {
            "retrievalResults": [
                {
                    "score": 0.9,
                    "content": {"text": "hello"},
                    "metadata": {"title": "T", "url": "https://x/1"},
                }
            ]
        }
    )

    result = search_aws_updates(
        client=client,
        knowledge_base_id="kb-1",
        query="Graviton5",
        since_days=7,
        category="whats-new",
    )

    assert client.last_call["knowledgeBaseId"] == "kb-1"
    assert client.last_call["retrievalQuery"] == {"text": "Graviton5"}
    vector_config = client.last_call["retrievalConfiguration"]["vectorSearchConfiguration"]
    assert "filter" in vector_config
    assert result == {
        "results": [
            {
                "score": 0.9,
                "title": "T",
                "url": "https://x/1",
                "published_at": None,
                "category": None,
                "source": None,
                "lang": None,
                "excerpt": "hello",
            }
        ]
    }


def test_search_aws_updates_without_filters_omits_filter_key():
    client = FakeBedrockAgentRuntime({"retrievalResults": []})

    search_aws_updates(client=client, knowledge_base_id="kb-1", query="anything")

    vector_config = client.last_call["retrievalConfiguration"]["vectorSearchConfiguration"]
    assert "filter" not in vector_config
