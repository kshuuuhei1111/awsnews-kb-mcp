from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError
from notifier_lambda import handler as handler_module


def _sns_event(message: dict) -> dict:
    import json

    return {"Records": [{"Sns": {"Message": json.dumps(message)}}]}


def test_handler_noop_when_webhook_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SLACK_WEBHOOK_SSM_PARAM", raising=False)
    fake_ssm = MagicMock()
    monkeypatch.setattr(handler_module, "_ssm", fake_ssm)

    result = handler_module.handler(_sns_event({"AlarmName": "x"}), None)

    assert result == {"notified": 0}
    fake_ssm.get_parameter.assert_not_called()


def test_handler_posts_to_slack_when_webhook_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SLACK_WEBHOOK_SSM_PARAM", "/awsnews-kb-mcp/slack-webhook-url")
    fake_ssm = MagicMock()
    fake_ssm.get_parameter.return_value = {
        "Parameter": {"Value": "https://hooks.slack.example/webhook"}
    }
    monkeypatch.setattr(handler_module, "_ssm", fake_ssm)

    posted: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        handler_module,
        "post_to_slack",
        lambda url, payload: posted.append((url, payload)),
    )

    result = handler_module.handler(
        _sns_event({"AlarmName": "IngestQueueDlqNotEmpty", "NewStateValue": "ALARM"}), None
    )

    fake_ssm.get_parameter.assert_called_once_with(
        Name="/awsnews-kb-mcp/slack-webhook-url", WithDecryption=True
    )
    assert result == {"notified": 1}
    assert posted[0][0] == "https://hooks.slack.example/webhook"
    assert "IngestQueueDlqNotEmpty" in posted[0][1]["text"]


def test_handler_noop_when_ssm_parameter_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SLACK_WEBHOOK_SSM_PARAM", "/awsnews-kb-mcp/slack-webhook-url")
    fake_ssm = MagicMock()
    fake_ssm.get_parameter.side_effect = ClientError(
        {"Error": {"Code": "ParameterNotFound", "Message": "not found"}}, "GetParameter"
    )
    monkeypatch.setattr(handler_module, "_ssm", fake_ssm)
    post_mock = MagicMock()
    monkeypatch.setattr(handler_module, "post_to_slack", post_mock)

    result = handler_module.handler(_sns_event({"AlarmName": "x"}), None)

    assert result == {"notified": 0}
    post_mock.assert_not_called()


def test_handler_skips_records_with_invalid_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SLACK_WEBHOOK_SSM_PARAM", "/awsnews-kb-mcp/slack-webhook-url")
    fake_ssm = MagicMock()
    fake_ssm.get_parameter.return_value = {
        "Parameter": {"Value": "https://hooks.slack.example/webhook"}
    }
    monkeypatch.setattr(handler_module, "_ssm", fake_ssm)
    monkeypatch.setattr(handler_module, "post_to_slack", MagicMock())

    event = {"Records": [{"Sns": {"Message": "not-json"}}]}
    result = handler_module.handler(event, None)

    assert result == {"notified": 0}
