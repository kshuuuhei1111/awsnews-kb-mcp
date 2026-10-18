import responses
from fetch_lambda.models import FeedSource
from fetch_lambda.rss import fetch_feed, parse_feed


def test_parse_feed_returns_expected_entries(sample_feed_bytes):
    source = FeedSource(
        name="whats-new", url="https://example.com/feed", category="whats-new", lang="en"
    )

    entries = parse_feed(sample_feed_bytes, source)

    assert len(entries) == 2
    first = entries[0]
    assert first.title == "Amazon Example Service now supports a new feature"
    assert (
        first.link
        == "https://aws.amazon.com/about-aws/whats-new/2026/09/example-service-new-feature/"
    )
    assert first.guid == first.link
    assert first.published_at.startswith("2026-09-01T10:00:00")
    assert first.source == "whats-new"


def test_parse_feed_skips_entries_missing_link_or_title():
    source = FeedSource(
        name="whats-new", url="https://example.com/feed", category="whats-new", lang="en"
    )
    broken_feed = (
        b'<?xml version="1.0"?><rss version="2.0"><channel>'
        b"<item><title>No link here</title></item>"
        b"</channel></rss>"
    )

    entries = parse_feed(broken_feed, source)

    assert entries == []


@responses.activate
def test_fetch_feed_performs_http_get_and_parses_response(sample_feed_bytes):
    source = FeedSource(
        name="whats-new",
        url="https://aws.amazon.com/about-aws/whats-new/recent/feed/",
        category="whats-new",
        lang="en",
    )
    responses.add(responses.GET, source.url, body=sample_feed_bytes, status=200)

    entries = fetch_feed(source)

    assert len(entries) == 2
    assert responses.calls[0].request.url == source.url
