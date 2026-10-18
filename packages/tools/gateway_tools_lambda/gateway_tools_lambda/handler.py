from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3

from gateway_tools_lambda.article import get_article
from gateway_tools_lambda.retrieve import search_aws_updates

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# boto3 クライアントはコールドスタート時に一度だけ生成する。
_bedrock_agent_runtime = boto3.client("bedrock-agent-runtime")
_s3 = boto3.client("s3")

# AgentCore Gateway はツール名に `${target_name}___${tool_name}` の形でターゲット名を
# プレフィックスする。Lambda側で剥がす必要がある。
_TOOL_NAME_DELIMITER = "___"

_TOOL_SEARCH = "search_aws_updates"
_TOOL_GET_ARTICLE = "get_article"


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    knowledge_base_id = os.environ["KNOWLEDGE_BASE_ID"]
    tool_name = _extract_tool_name(context)

    logger.info(json.dumps({"event": "tool_invoked", "tool": tool_name}))

    if tool_name == _TOOL_SEARCH:
        return search_aws_updates(
            client=_bedrock_agent_runtime,
            knowledge_base_id=knowledge_base_id,
            query=event["query"],
            since_days=event.get("since_days"),
            category=event.get("category"),
            source=event.get("source"),
            lang=event.get("lang"),
        )

    if tool_name == _TOOL_GET_ARTICLE:
        return get_article(
            bedrock_client=_bedrock_agent_runtime,
            s3_client=_s3,
            knowledge_base_id=knowledge_base_id,
            url=event["url"],
        )

    raise ValueError(f"unknown tool: {tool_name}")


def _extract_tool_name(context: Any) -> str:
    custom = context.client_context.custom
    original_tool_name = custom["bedrockAgentCoreToolName"]
    delimiter_index = original_tool_name.index(_TOOL_NAME_DELIMITER)
    return original_tool_name[delimiter_index + len(_TOOL_NAME_DELIMITER) :]
