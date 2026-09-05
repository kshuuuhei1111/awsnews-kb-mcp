import json
from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest
from notifier_lambda import slack


def test_build_slack_message_for_alarm_state():
    alarm = {
        "AlarmName": "IngestQueueDlqNotEmpty",
        "NewStateValue": "ALARM",
        "NewStateReason": "Threshold Crossed",
        "StateChangeTime": "2026-09-05T00:00:00.000+0000",
    }

    payload = slack.build_slack_message(alarm)

    assert ":rotating_light:" in payload["text"]
    assert "IngestQueueDlqNotEmpty" in payload["text"]
    assert "ALARM" in payload["text"]


def test_build_slack_message_for_ok_state():
    alarm = {"AlarmName": "IngestQueueDlqNotEmpty", "NewStateValue": "OK"}

    payload = slack.build_slack_message(alarm)

    assert ":white_check_mark:" in payload["text"]


def test_post_to_slack_sends_json_payload(monkeypatch: pytest.MonkeyPatch):
    captured: dict = {}

    @contextmanager
    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["headers"] = request.headers
        yield MagicMock(read=lambda: b"ok")

    monkeypatch.setattr(slack.urllib.request, "urlopen", fake_urlopen)

    slack.post_to_slack("https://hooks.slack.example/webhook", {"text": "hello"})

    assert captured["url"] == "https://hooks.slack.example/webhook"
    assert captured["body"] == {"text": "hello"}
