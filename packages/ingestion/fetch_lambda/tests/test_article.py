import responses
from fetch_lambda.article import extract_main_content_html, fetch_article_html, html_to_markdown


def test_extract_main_content_html_keeps_main_and_strips_nav_footer_script(sample_article_html):
    content = extract_main_content_html(sample_article_html)

    assert "<main" in content
    assert "Global AWS Nav" not in content
    assert "Copyright Amazon.com" not in content
    assert "console.log" not in content
    assert "Point one about the feature" in content


def test_extract_main_content_html_falls_back_to_body_when_no_main_or_article():
    html = "<html><body><p>Only a body tag here</p></body></html>"

    content = extract_main_content_html(html)

    assert "Only a body tag here" in content


def test_html_to_markdown_converts_headings_links_and_lists():
    html = (
        "<h1>Title</h1>"
        '<p>Hello <a href="https://example.com">world</a></p>'
        "<ul><li>one</li><li>two</li></ul>"
    )

    markdown = html_to_markdown(html)

    assert "# Title" in markdown
    assert "[world](https://example.com)" in markdown
    assert "one" in markdown
    assert "two" in markdown


@responses.activate
def test_fetch_article_html_performs_http_get():
    url = "https://aws.amazon.com/about-aws/whats-new/2026/09/example/"
    responses.add(responses.GET, url, body="<html><body>ok</body></html>", status=200)

    html = fetch_article_html(url)

    assert "ok" in html
