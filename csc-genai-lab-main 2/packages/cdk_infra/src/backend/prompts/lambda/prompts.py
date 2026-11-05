# Copyright Amazon.com and its affiliates; all rights reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  https://aws.amazon.com/asl/

import re
import boto3
from uuid import uuid4
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.utilities.typing import LambdaContext

logger = Logger(use_rfc3339=True)
cors_config = CORSConfig(allow_origin="*", max_age=300)
app = APIGatewayRestResolver(cors=cors_config)

# Prompts live in Amazon Bedrock Prompt Management (visible in the Bedrock console),
# stored as CHAT templates so they carry system instruction + user/assistant example
# messages — matching how prompts are composed in the console.
bedrock_agent = boto3.client("bedrock-agent")

# RetrieveAndGenerate needs the retrieved-context placeholder in the (flattened) template.
REQUIRED_PLACEHOLDER = "$search_results$"
# And this one is what makes the service emit citations. A custom template that omits it
# still answers, but every citation comes back with zero retrievedReferences — which the
# UI renders as an empty 근거문서 panel. Measured: without it refs=0, with it refs=1.
CITATION_PLACEHOLDER = "$output_format_instructions$"
VARIANT_NAME = "default"


def _make_name(title):
    """Bedrock prompt name must be ASCII (^([0-9a-zA-Z][_-]?){1,100}$); the human title
    is kept in `description`, so derive a safe name (fall back to a generated id)."""
    slug = re.sub(r"[^0-9a-zA-Z]+", "-", title or "").strip("-")[:90]
    return slug or f"prompt-{uuid4().hex[:12]}"


def _variant(system, user, assistant):
    """Build a CHAT template variant from the composed parts. Store exactly what the
    user posted: the user example goes in the user message, the assistant example in the
    assistant message. Never overwrite a provided value with a placeholder. Only inject
    the "사용자 질문" placeholder when it's structurally required — i.e. an assistant
    example was given but no user example, since a CHAT turn must be preceded by a user
    message. A system-only prompt keeps an empty messages list (no fake user turn)."""
    system, user, assistant = (system or "").strip(), (user or "").strip(), (assistant or "").strip()
    messages = []
    if user:
        messages.append({"role": "user", "content": [{"text": user}]})
    if assistant:
        if not messages:  # assistant example needs a preceding user turn
            messages.append({"role": "user", "content": [{"text": "사용자 질문"}]})
        messages.append({"role": "assistant", "content": [{"text": assistant}]})
    chat = {"messages": messages}
    if system:
        chat["system"] = [{"text": system}]
    return {
        "name": VARIANT_NAME,
        "templateType": "CHAT",
        "templateConfiguration": {"chat": chat},
    }


def _compose_template(system, user, assistant):
    """Flatten the parts into a RetrieveAndGenerate TEXT template (must contain
    $search_results$). The system instruction drives the answer; the user/assistant
    pair, if given, acts as a one-shot example."""
    parts = []
    if (system or "").strip():
        parts.append(system.strip())
    parts.append("다음은 참고 문서입니다:\n" + REQUIRED_PLACEHOLDER)
    if (user or "").strip() and (assistant or "").strip():
        parts.append(f"[예시]\n질문: {user.strip()}\n답변: {assistant.strip()}")
    parts.append("위 문서 내용을 근거로 사용자의 질문에 한국어로 답하세요. 문서에 근거가 없으면 모른다고 답하세요.")
    # Always last: this is the service's own citation-format instruction. Whatever the
    # user wrote above must not displace it, or the answer loses its sources.
    parts.append(CITATION_PLACEHOLDER)
    return "\n\n".join(parts)


def _to_item(prompt):
    """Map a Bedrock get_prompt response to the UI shape. Handles CHAT variants and,
    for backward compatibility, legacy TEXT variants (kept as the system instruction)."""
    variants = prompt.get("variants") or [{}]
    cfg = variants[0].get("templateConfiguration", {})
    system, user, assistant = "", "", ""
    if "chat" in cfg:
        chat = cfg["chat"]
        system = " ".join(s.get("text", "") for s in chat.get("system", []) or [])
        for m in chat.get("messages", []):
            text = " ".join(c.get("text", "") for c in m.get("content", []) or [])
            if m.get("role") == "user" and not user:
                user = text
            elif m.get("role") == "assistant" and not assistant:
                assistant = text
    else:  # legacy TEXT prompt
        system = cfg.get("text", {}).get("text", "")
    return {
        "promptId": prompt["id"],
        "title": prompt.get("description") or prompt.get("name"),
        "system": system,
        "user": user,
        "assistant": assistant,
        "template": _compose_template(system, user, assistant),
    }


def _parts_from_body(body):
    return (body.get("system") or "").strip(), (body.get("user") or "").strip(), (body.get("assistant") or "").strip()


@app.get("/prompts")
def list_prompts():
    items = []
    next_token = None
    while True:
        kwargs = {"maxResults": 100}
        if next_token:
            kwargs["nextToken"] = next_token
        resp = bedrock_agent.list_prompts(**kwargs)
        for summary in resp.get("promptSummaries", []):
            try:
                items.append(_to_item(bedrock_agent.get_prompt(promptIdentifier=summary["id"])))
            except Exception as e:  # noqa: BLE001 - skip prompts we can't read
                logger.warning(f"Could not read prompt {summary.get('id')}: {e}")
        next_token = resp.get("nextToken")
        if not next_token:
            break
    return {"prompts": items}


@app.post("/prompts")
def create_prompt():
    body = app.current_event.json_body or {}
    title = (body.get("title") or "").strip()
    system, user, assistant = _parts_from_body(body)
    if not title:
        return {"message": "title is required"}, 400
    if not system:
        return {"message": "시스템 지침(system)은 필수입니다"}, 400

    resp = bedrock_agent.create_prompt(
        name=_make_name(title),
        description=title[:200],
        variants=[_variant(system, user, assistant)],
    )
    return {"promptId": resp["id"], "title": title, "system": system,
            "user": user, "assistant": assistant,
            "template": _compose_template(system, user, assistant)}, 201


@app.put("/prompts/<prompt_id>")
def update_prompt(prompt_id: str):
    body = app.current_event.json_body or {}
    title = (body.get("title") or "").strip()
    system, user, assistant = _parts_from_body(body)
    if not title:
        return {"message": "title is required"}, 400
    if not system:
        return {"message": "시스템 지침(system)은 필수입니다"}, 400

    bedrock_agent.update_prompt(
        promptIdentifier=prompt_id,
        name=_make_name(title),
        description=title[:200],
        variants=[_variant(system, user, assistant)],
    )
    return {"promptId": prompt_id, "title": title, "system": system,
            "user": user, "assistant": assistant,
            "template": _compose_template(system, user, assistant)}


@app.delete("/prompts/<prompt_id>")
def delete_prompt(prompt_id: str):
    bedrock_agent.delete_prompt(promptIdentifier=prompt_id)
    return {"ok": True, "deleted": prompt_id}


@logger.inject_lambda_context(log_event=True)
def lambda_handler(event: dict, context: LambdaContext):
    return app.resolve(event, context)
