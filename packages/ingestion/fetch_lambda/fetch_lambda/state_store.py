from __future__ import annotations

from typing import Protocol


class DynamoDBTable(Protocol):
    """boto3 の Table リソースのうち、本モジュールが使う操作のみを表す。"""

    def get_item(self, Key: dict) -> dict: ...

    def put_item(self, Item: dict) -> dict: ...


class ArticleStateStore:
    """記事の GUID を DynamoDB に記録し、新着記事のみ処理するための重複排除ストア。"""

    def __init__(self, table: DynamoDBTable) -> None:
        self._table = table

    def is_new(self, guid: str) -> bool:
        response = self._table.get_item(Key={"guid": guid})
        return "Item" not in response

    def mark_processed(self, guid: str, url: str, fetched_at: str) -> None:
        self._table.put_item(
            Item={
                "guid": guid,
                "url": url,
                "fetched_at": fetched_at,
            }
        )
