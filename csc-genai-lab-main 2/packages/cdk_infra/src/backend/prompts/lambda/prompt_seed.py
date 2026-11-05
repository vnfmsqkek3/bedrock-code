# Copyright Amazon.com and its affiliates; all rights reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  https://aws.amazon.com/asl/

"""CloudFormation custom-resource handler (via cr.Provider) that seeds a default
answer-format prompt into Amazon Bedrock Prompt Management on deploy, so it appears
in the app's 프롬프트 관리 list. Stored as a CHAT prompt (system + example messages).
Idempotent: upserts by name."""

import os
import boto3
from aws_lambda_powertools import Logger

logger = Logger()
bedrock_agent = boto3.client("bedrock-agent")

PROMPT_NAME = os.environ.get("PROMPT_NAME", "default-answer-format")
PROMPT_TITLE = os.environ.get("PROMPT_TITLE", "기본 답변 형식")
PHYSICAL_ID = "default-answer-format-prompt"

# The prompt text arrives in the custom-resource properties, not in the environment.
# Lambda caps an UpdateFunctionConfiguration request at 5120 bytes including all variables,
# so shipping the answer instructions as an env var made every deploy fail with a 413 once
# the file grew past that. CloudFormation resource properties have no such limit, and the
# stack already sends the same text there so that editing it re-seeds the prompt.


def _variant(props: dict):
    system = (props.get("system") or "").strip()
    user = (props.get("user") or "").strip()
    assistant = (props.get("assistant") or "").strip()

    messages = [{"role": "user", "content": [{"text": user or "사용자 질문"}]}]
    if assistant:
        messages.append({"role": "assistant", "content": [{"text": assistant}]})
    chat = {"messages": messages}
    if system:
        chat["system"] = [{"text": system}]
    return {"name": "default", "templateType": "CHAT",
            "templateConfiguration": {"chat": chat}}


def _find_existing():
    token = None
    while True:
        kwargs = {"maxResults": 100}
        if token:
            kwargs["nextToken"] = token
        resp = bedrock_agent.list_prompts(**kwargs)
        for summary in resp.get("promptSummaries", []):
            if summary.get("name") == PROMPT_NAME:
                return summary["id"]
        token = resp.get("nextToken")
        if not token:
            return None


def handler(event, context):
    request_type = event.get("RequestType")
    logger.info(f"prompt seed: {request_type}")
    props = event.get("ResourceProperties") or {}
    try:
        if request_type in ("Create", "Update"):
            variant = _variant(props)
            existing = _find_existing()
            if existing:
                bedrock_agent.update_prompt(
                    promptIdentifier=existing, name=PROMPT_NAME,
                    description=PROMPT_TITLE, variants=[variant],
                )
            else:
                bedrock_agent.create_prompt(
                    name=PROMPT_NAME, description=PROMPT_TITLE, variants=[variant],
                )
        elif request_type == "Delete":
            existing = _find_existing()
            if existing:
                bedrock_agent.delete_prompt(promptIdentifier=existing)
    except Exception:  # noqa: BLE001 - a seed failure must not block/roll back the deploy
        logger.exception("prompt seed failed (non-fatal)")
    return {"PhysicalResourceId": PHYSICAL_ID}
