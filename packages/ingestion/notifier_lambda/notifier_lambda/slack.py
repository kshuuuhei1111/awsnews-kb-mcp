from __future__ import annotations

import json
import urllib.request

_REQUEST_TIMEOUT_SECONDS = 10


def build_slack_message(alarm: dict) -> dict:
    """CloudWatch Alarm の SNS メッセージ（辞書化済み）から Slack payload を組み立てる。"""
    alarm_name = alarm.get("AlarmName", "unknown alarm")
    new_state = alarm.get("NewStateValue", "UNKNOWN")
    reason = alarm.get("NewStateReason", "")
    changed_at = alarm.get("StateChangeTime", "")
    emoji = ":rotating_light:" if new_state == "ALARM" else ":white_check_mark:"
    text = f"{emoji} *{alarm_name}* is now *{new_state}*\n{reason}\n({changed_at})"
    return {"text": text}


def post_to_slack(webhook_url: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        webhook_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
        response.read()
