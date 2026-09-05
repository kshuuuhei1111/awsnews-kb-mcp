from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

from notifier_lambda.slack import build_slack_message, post_to_slack

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# boto3 クライアントはコールドスタート時に一度だけ生成する。
_ssm = boto3.client("ssm")


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """SNS 経由の CloudWatch Alarm 通知を受け取り、設定があれば Slack に転送する。

    Slack Webhook URL は任意設定。SSM パラメータ名が環境変数に設定されていない場合は
    何もせずに終了する（SNS のメール通知など、他のサブスクライバーには影響しない）。
    """
    webhook_param_name = os.environ.get("SLACK_WEBHOOK_SSM_PARAM")
    if not webhook_param_name:
        logger.info(json.dumps({"event": "slack_webhook_not_configured"}))
        return {"notified": 0}

    webhook_url = _get_webhook_url(webhook_param_name)
    if webhook_url is None:
        logger.info(json.dumps({"event": "slack_webhook_param_not_found"}))
        return {"notified": 0}

    notified = 0
    for record in event.get("Records", []):
        raw_message = record.get("Sns", {}).get("Message", "{}")
        try:
            alarm = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.error(json.dumps({"event": "invalid_sns_message"}))
            continue
        payload = build_slack_message(alarm)
        post_to_slack(webhook_url, payload)
        notified += 1

    logger.info(json.dumps({"event": "slack_notify_completed", "notified": notified}))
    return {"notified": notified}


def _get_webhook_url(param_name: str) -> str | None:
    try:
        response = _ssm.get_parameter(Name=param_name, WithDecryption=True)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ParameterNotFound":
            return None
        raise
    return response["Parameter"]["Value"]
