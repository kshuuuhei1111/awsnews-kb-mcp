from __future__ import annotations

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify

_REQUEST_TIMEOUT_SECONDS = 15

# AWS What's New / ブログのページ構造は完全には統一されていないため、
# 優先順位を付けて本文コンテナを探す。見つからない場合は <body> 全体を使う。
_CONTENT_SELECTORS = ["main", "article", "#main-content", ".blog-post-content"]


def fetch_article_html(url: str) -> str:
    """記事ページのHTMLを取得する。"""
    response = requests.get(url, timeout=_REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()
    response.encoding = response.apparent_encoding or response.encoding
    return response.text


def extract_main_content_html(html: str) -> str:
    """ページ全体のHTMLから本文と思われる領域を抜き出す。"""
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()

    for selector in _CONTENT_SELECTORS:
        found = soup.select_one(selector)
        if found is not None:
            return str(found)

    body = soup.find("body")
    return str(body) if body is not None else str(soup)


def html_to_markdown(html: str) -> str:
    """HTML断片をMarkdownに変換する。"""
    markdown = markdownify(html, heading_style="ATX")
    lines = [line.rstrip() for line in markdown.splitlines()]
    # markdownify が生成する連続する空行を1行に圧縮する。
    collapsed: list[str] = []
    for line in lines:
        if line == "" and collapsed and collapsed[-1] == "":
            continue
        collapsed.append(line)
    return "\n".join(collapsed).strip() + "\n"
