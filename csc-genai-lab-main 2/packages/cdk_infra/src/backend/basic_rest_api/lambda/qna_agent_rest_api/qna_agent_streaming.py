"""
Lambda handler for QnA streaming endpoint.

Returns the full response as NDJSON lines:
  {"type":"text","content":"full answer text"}
  {"type":"citations","content":[...]}
  {"type":"images","content":[...]}
  {"type":"done","sessionId":"..."}
"""

import json
import base64
import os
import time
from aws_lambda_powertools import Logger
from dispatch.bedrock_chat_router import BedrockChatRouter

logger = Logger(service="QnaAgentStreamingApi", use_rfc3339=True)


def handler(event, context):
    """Lambda handler - returns NDJSON response."""

    # Parse request body
    body = event.get("body", "")
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")

    try:
        request = json.loads(body) if body else {}
    except json.JSONDecodeError:
        return _response(400, json.dumps({"type": "error", "message": "Invalid JSON body"}))

    message = request.get("message", "")
    if not message:
        return _response(400, json.dumps({"type": "error", "message": "Message not provided"}))

    session_id = request.get("sessionId")
    metadata = request.get("metadata", {})
    model_id = request.get("modelId")
    prompt_template = request.get("promptTemplate")
    guardrail_id = request.get("guardrailId")
    guardrail_version = request.get("guardrailVersion")

    iam_context = event.get("requestContext", {}).get("authorizer", {}).get("iam", {})
    principal_id = iam_context.get("userId", "").split(":")[-1] if iam_context.get("userId") else "unknown"
    session_attributes = {"principalId": principal_id}

    logger.info(f"Request: session={session_id}, model={model_id or 'default'}")

    # Initialize router
    try:
        router = BedrockChatRouter(
            session_id, session_attributes, metadata,
            model_id, prompt_template, guardrail_id, guardrail_version
        )
    except Exception as e:
        logger.error(f"Failed to init router: {e}")
        return _response(500, json.dumps({"type": "error", "message": str(e)}))

    # Execute
    try:
        agent_response = router.chat_with_agent(message)
    except Exception as e:
        logger.error(f"chat_with_agent failed: {e}")
        return _response(500, json.dumps({"type": "error", "message": str(e)}))

    # Build NDJSON
    lines = []
    lines.append(json.dumps({"type": "text", "content": agent_response.get("message", "")}, ensure_ascii=False))

    if agent_response.get("citations"):
        lines.append(json.dumps({"type": "citations", "content": agent_response["citations"]}, ensure_ascii=False))

    if agent_response.get("relatedImages"):
        lines.append(json.dumps({"type": "images", "content": agent_response["relatedImages"]}, ensure_ascii=False))

    lines.append(json.dumps({"type": "done", "sessionId": router.session_id}, ensure_ascii=False))

    return _response(200, "\n".join(lines) + "\n")


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/x-ndjson",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "content-type,authorization,x-amz-date,x-amz-security-token,x-amz-content-sha256",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
        "body": body,
    }
