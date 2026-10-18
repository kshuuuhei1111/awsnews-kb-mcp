from types import SimpleNamespace

import pytest
from gateway_tools_lambda import handler as handler_module


def _context(tool_name: str) -> SimpleNamespace:
    return SimpleNamespace(
        client_context=SimpleNamespace(custom={"bedrockAgentCoreToolName": tool_name})
    )


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KNOWLEDGE_BASE_ID", "kb-1")


def test_extract_tool_name_strips_target_prefix():
    context = _context("awsnews-tools___search_aws_updates")

    assert handler_module._extract_tool_name(context) == "search_aws_updates"


def test_handler_dispatches_to_search_aws_updates(monkeypatch: pytest.MonkeyPatch):
    called = {}

    def fake_search_aws_updates(**kwargs):
        called.update(kwargs)
        return {"results": []}

    monkeypatch.setattr(handler_module, "search_aws_updates", fake_search_aws_updates)

    event = {"query": "Graviton5", "since_days": 7}
    result = handler_module.handler(event, _context("t___search_aws_updates"))

    assert result == {"results": []}
    assert called["query"] == "Graviton5"
    assert called["since_days"] == 7
    assert called["knowledge_base_id"] == "kb-1"


def test_handler_dispatches_to_get_article(monkeypatch: pytest.MonkeyPatch):
    called = {}

    def fake_get_article(**kwargs):
        called.update(kwargs)
        return {"markdown": "ok"}

    monkeypatch.setattr(handler_module, "get_article", fake_get_article)

    event = {"url": "https://aws.amazon.com/x"}
    result = handler_module.handler(event, _context("t___get_article"))

    assert result == {"markdown": "ok"}
    assert called["url"] == "https://aws.amazon.com/x"


def test_handler_raises_on_unknown_tool():
    with pytest.raises(ValueError, match="unknown tool"):
        handler_module.handler({}, _context("t___unknown_tool"))
