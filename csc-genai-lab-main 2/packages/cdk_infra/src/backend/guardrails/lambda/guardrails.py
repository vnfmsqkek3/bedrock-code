# Copyright Amazon.com and its affiliates; all rights reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  https://aws.amazon.com/asl/

import re
import boto3
from uuid import uuid4
from botocore.exceptions import ClientError
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.utilities.typing import LambdaContext

logger = Logger(use_rfc3339=True)
cors_config = CORSConfig(allow_origin="*", max_age=300)
app = APIGatewayRestResolver(cors=cors_config)

# Guardrails live in Amazon Bedrock Guardrails (visible in the Bedrock console). The chat
# lambda applies a selected guardrail to RetrieveAndGenerate by (guardrailId, DRAFT).
bedrock = boto3.client("bedrock")

# The 6 managed content-filter categories. One UI "strength" knob sets them all — the
# laziest control that's still meaningful. PROMPT_ATTACK only supports an input filter
# (outputStrength must be NONE), so it's handled specially below.
CONTENT_FILTER_TYPES = ["SEXUAL", "VIOLENCE", "HATE", "INSULTS", "MISCONDUCT", "PROMPT_ATTACK"]
VALID_STRENGTHS = {"NONE", "LOW", "MEDIUM", "HIGH"}

DEFAULT_BLOCKED_INPUT = "죄송합니다. 해당 요청은 정책상 답변할 수 없습니다."
DEFAULT_BLOCKED_OUTPUT = "죄송합니다. 해당 내용은 정책상 제공할 수 없습니다."


def _make_name(title):
    """Guardrail name must match ^[0-9a-zA-Z-_]+$ (<=50 chars); the human title is kept
    in `description`, so derive a safe name (fall back to a generated id)."""
    slug = re.sub(r"[^0-9a-zA-Z]+", "-", title or "").strip("-")[:45]
    return slug or f"guardrail-{uuid4().hex[:12]}"


def _content_policy(strength):
    """Build contentPolicyConfig from a single strength knob. Returns None for NONE so the
    policy is omitted entirely."""
    if strength == "NONE":
        return None
    filters = []
    for t in CONTENT_FILTER_TYPES:
        out = "NONE" if t == "PROMPT_ATTACK" else strength
        filters.append({"type": t, "inputStrength": strength, "outputStrength": out})
    return {"filtersConfig": filters}


# Bedrock topic name allows only [0-9a-zA-Z-_ !?.] (no Korean/Unicode). A Korean label is
# slugged to topic-N and folded into the definition so the intent + model signal survive.
_TOPIC_NAME_RE = re.compile(r"[^0-9a-zA-Z\-_ !?.]+")


def _safe_topic_name(raw, idx):
    cleaned = _TOPIC_NAME_RE.sub("", raw or "").strip()
    return cleaned[:100] if cleaned else f"topic-{idx}"


def _topic_policy(denied_topics):
    """Build topicPolicyConfig from [{name, definition}]. Non-ASCII names are slugged and
    their label moved into the definition (Bedrock rejects non-ASCII topic names). None if empty.
    Adds 'examples' to improve model detection — sample inputs that should trigger the topic."""
    topics = []
    for i, t in enumerate(denied_topics or [], start=1):
        raw_name = (t.get("name") or "").strip()
        definition = (t.get("definition") or "").strip()
        if not raw_name or not definition:
            continue
        name = _safe_topic_name(raw_name, i)
        if name != raw_name:  # readable label was dropped -> keep it in the definition
            definition = f"{raw_name}: {definition}"
        # Bedrock topicPolicy 'definition' is the description used by the model to detect
        # the topic. 'examples' are sample inputs that should trigger — critical for
        # non-English topic names where semantic detection needs explicit hints.
        topic_entry = {
            "name": name,
            "definition": definition[:200],
            "type": "DENY",
            "examples": [
                f"{raw_name}에 대해 알려줘",
                f"{raw_name} 관련 정보",
                raw_name,
            ],
        }
        topics.append(topic_entry)
    return {"topicsConfig": topics} if topics else None


VALID_PII_ACTIONS = {"ANONYMIZE", "BLOCK"}


def _sensitive_policy(pii_entities):
    """Build sensitiveInformationPolicyConfig from [{type, action}]. ANONYMIZE masks the
    detected entity (e.g. {PHONE}) in the answer; BLOCK refuses. None if empty. Dedupes by
    type (Bedrock rejects duplicates)."""
    entities = []
    seen = set()
    for e in pii_entities or []:
        etype = (e.get("type") or "").strip().upper()
        if not etype or etype in seen:
            continue
        action = (e.get("action") or "ANONYMIZE").strip().upper()
        if action not in VALID_PII_ACTIONS:
            action = "ANONYMIZE"
        seen.add(etype)
        entities.append({"type": etype, "action": action})
    return {"piiEntitiesConfig": entities} if entities else None


def _client_err(e):
    return e.response.get("Error", {}).get("Message") or str(e)


# Korean particles commonly appended to nouns — used to expand word-filter coverage so
# that "대상 A" also catches "대상 A에서", "대상 A의", "대상 A을" etc.
_KO_PARTICLES = ["에서", "에", "의", "을", "를", "이", "가", "은", "는", "으로", "로", "과", "와", "도"]


def _word_policy(word_filters):
    """Build wordPolicyConfig from a list of words/phrases. For Korean words, automatically
    adds common particle variants so exact-match filters cover inflected forms.
    Returns None if empty."""
    if not word_filters:
        return None
    words_set = set()
    for w in word_filters:
        word = w.strip() if isinstance(w, str) else ""
        if not word:
            continue
        words_set.add(word)
        # If the word contains Korean characters, add particle variants
        if any('\uac00' <= c <= '\ud7a3' for c in word):
            for p in _KO_PARTICLES:
                words_set.add(f"{word}{p}")
    if not words_set:
        return None
    # Bedrock word config limit is 10000 words
    words_config = [{"text": w} for w in sorted(words_set)[:10000]]
    return {"wordsConfig": words_config}


def _policies_from_body(body):
    """Validate + assemble the create/update kwargs shared by POST and PUT."""
    title = (body.get("title") or "").strip()
    strength = (body.get("filterStrength") or "NONE").strip().upper()
    if strength not in VALID_STRENGTHS:
        strength = "NONE"
    denied_topics = body.get("deniedTopics") or []
    word_filters = body.get("wordFilters") or []
    content = _content_policy(strength)
    topic = _topic_policy(denied_topics)
    word = _word_policy(word_filters)
    sensitive = _sensitive_policy(body.get("piiEntities"))
    if not content and not topic and not word and not sensitive:
        return None, "거부 주제, 단어 필터, PII 항목 중 하나 이상은 설정해야 합니다."

    kwargs = {
        "description": (title or "guardrail")[:200],
        "blockedInputMessaging": (body.get("blockedInputMessaging") or DEFAULT_BLOCKED_INPUT).strip()[:500],
        "blockedOutputsMessaging": (body.get("blockedOutputsMessaging") or DEFAULT_BLOCKED_OUTPUT).strip()[:500],
    }
    if content:
        kwargs["contentPolicyConfig"] = content
    if topic:
        kwargs["topicPolicyConfig"] = topic
    if word:
        kwargs["wordPolicyConfig"] = word
    if sensitive:
        kwargs["sensitiveInformationPolicyConfig"] = sensitive
    return kwargs, None


def _to_item(detail):
    """Map a Bedrock get_guardrail response to the UI shape (reverse of the form)."""
    filters = (detail.get("contentPolicy") or {}).get("filters") or []
    # All non-PROMPT_ATTACK filters share the same UI strength; read the first one.
    strength = "NONE"
    for f in filters:
        if f.get("type") != "PROMPT_ATTACK":
            strength = f.get("inputStrength", "NONE")
            break
    # Restore human-readable topic names: if `name` is a slug (topic-N) and definition
    # starts with "OriginalLabel: ...", extract the label back as the display name.
    topics = []
    for t in (detail.get("topicPolicy") or {}).get("topics") or []:
        name = t.get("name", "")
        definition = t.get("definition", "")
        # If name looks like a generated slug (topic-N) and definition has the original
        # label prefixed, restore the original name for display.
        if re.match(r"^topic-\d+$", name) and ": " in definition:
            original_name, restored_def = definition.split(": ", 1)
            topics.append({"name": original_name, "definition": restored_def})
        else:
            topics.append({"name": name, "definition": definition})
    pii_entities = [
        {"type": p.get("type", ""), "action": p.get("action", "ANONYMIZE")}
        for p in (detail.get("sensitiveInformationPolicy") or {}).get("piiEntities") or []
    ]
    # Word filters: extract the base words (remove auto-generated particle variants).
    # The stored words include Korean particle expansions — deduplicate back to originals.
    raw_words = [w.get("text", "") for w in (detail.get("wordPolicy") or {}).get("words") or []]
    # Find base words: a word is a base if no shorter word in the set is a prefix of it
    # after removing known particles.
    base_words = set()
    for w in raw_words:
        is_variant = False
        for p in _KO_PARTICLES:
            if w.endswith(p) and w[:-len(p)] in raw_words:
                is_variant = True
                break
        if not is_variant:
            base_words.add(w)
    word_filters = sorted(base_words)
    return {
        "guardrailId": detail["guardrailId"],
        "guardrailVersion": detail.get("version", "DRAFT"),
        "title": detail.get("description") or detail.get("name"),
        "status": detail.get("status"),
        "filterStrength": strength,
        "deniedTopics": topics,
        "wordFilters": word_filters,
        "piiEntities": pii_entities,
        "blockedInputMessaging": detail.get("blockedInputMessaging", DEFAULT_BLOCKED_INPUT),
        "blockedOutputsMessaging": detail.get("blockedOutputsMessaging", DEFAULT_BLOCKED_OUTPUT),
    }


@app.get("/guardrails")
def list_guardrails():
    items = []
    next_token = None
    while True:
        kwargs = {"maxResults": 100}
        if next_token:
            kwargs["nextToken"] = next_token
        resp = bedrock.list_guardrails(**kwargs)
        for summary in resp.get("guardrails", []):
            try:
                # DRAFT holds the latest edits — what the chat applies, so read that.
                detail = bedrock.get_guardrail(guardrailIdentifier=summary["id"], guardrailVersion="DRAFT")
                items.append(_to_item(detail))
            except Exception as e:  # noqa: BLE001 - skip guardrails we can't read
                logger.warning(f"Could not read guardrail {summary.get('id')}: {e}")
        next_token = resp.get("nextToken")
        if not next_token:
            break
    return {"guardrails": items}


@app.post("/guardrails")
def create_guardrail():
    body = app.current_event.json_body or {}
    title = (body.get("title") or "").strip()
    if not title:
        return {"message": "이름(title)은 필수입니다"}, 400
    kwargs, err = _policies_from_body(body)
    if err:
        return {"message": err}, 400
    try:
        resp = bedrock.create_guardrail(name=_make_name(title), **kwargs)
    except ClientError as e:
        logger.warning(f"create_guardrail failed: {e}")
        return {"message": _client_err(e)}, 400
    return {"guardrailId": resp["guardrailId"], "guardrailVersion": resp.get("version", "DRAFT"),
            "title": title}, 201


@app.put("/guardrails/<guardrail_id>")
def update_guardrail(guardrail_id: str):
    body = app.current_event.json_body or {}
    title = (body.get("title") or "").strip()
    if not title:
        return {"message": "이름(title)은 필수입니다"}, 400
    kwargs, err = _policies_from_body(body)
    if err:
        return {"message": err}, 400
    try:
        bedrock.update_guardrail(guardrailIdentifier=guardrail_id, name=_make_name(title), **kwargs)
    except ClientError as e:
        logger.warning(f"update_guardrail failed: {e}")
        return {"message": _client_err(e)}, 400
    return {"guardrailId": guardrail_id, "title": title}


@app.delete("/guardrails/<guardrail_id>")
def delete_guardrail(guardrail_id: str):
    try:
        bedrock.delete_guardrail(guardrailIdentifier=guardrail_id)
    except ClientError as e:
        logger.warning(f"delete_guardrail failed: {e}")
        return {"message": _client_err(e)}, 400
    return {"ok": True, "deleted": guardrail_id}


@logger.inject_lambda_context(log_event=True)
def lambda_handler(event: dict, context: LambdaContext):
    return app.resolve(event, context)
