from fetch_lambda.state_store import ArticleStateStore


class FakeTable:
    def __init__(self) -> None:
        self.items: dict[str, dict] = {}

    def get_item(self, Key: dict) -> dict:
        guid = Key["guid"]
        return {"Item": self.items[guid]} if guid in self.items else {}

    def put_item(self, Item: dict) -> dict:
        self.items[Item["guid"]] = Item
        return {}


def test_is_new_returns_true_for_unknown_guid():
    store = ArticleStateStore(FakeTable())

    assert store.is_new("unknown-guid") is True


def test_is_new_returns_false_after_mark_processed():
    table = FakeTable()
    store = ArticleStateStore(table)

    store.mark_processed("guid-1", "https://example.com/a", "2026-09-01T00:00:00+00:00")

    assert store.is_new("guid-1") is False
    assert table.items["guid-1"]["url"] == "https://example.com/a"
