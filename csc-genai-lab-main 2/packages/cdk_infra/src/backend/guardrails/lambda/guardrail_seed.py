# Copyright Amazon.com and its affiliates; all rights reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  https://aws.amazon.com/asl/

"""CloudFormation custom-resource handler (via cr.Provider) that seeds a default
PII-masking guardrail into Amazon Bedrock Guardrails on deploy, so it appears in the
app's 가드레일 list on any account/region. Idempotent: upserts by name."""

import os
import boto3
from aws_lambda_powertools import Logger

logger = Logger()
bedrock = boto3.client("bedrock")

GUARDRAIL_NAME = os.environ.get("GUARDRAIL_NAME", "default-phone-masking")
GUARDRAIL_TITLE = os.environ.get("GUARDRAIL_TITLE", "기본 전화번호 마스킹")
# Comma-separated PII entity types to ANONYMIZE (mask) in answers. Default: phone only.
PII_TYPES = [t.strip().upper() for t in os.environ.get("PII_TYPES", "PHONE").split(",") if t.strip()]
BLOCKED_INPUT = os.environ.get("BLOCKED_INPUT", "죄송합니다. 해당 요청은 정책상 답변할 수 없습니다.")
BLOCKED_OUTPUT = os.environ.get("BLOCKED_OUTPUT", "죄송합니다. 해당 내용은 정책상 제공할 수 없습니다.")
PHYSICAL_ID = "default-guardrail-seed"


def _sensitive_config():
    return {"piiEntitiesConfig": [{"type": t, "action": "ANONYMIZE"} for t in PII_TYPES]}


def _find_existing():
    token = None
    while True:
        kwargs = {"maxResults": 100}
        if token:
            kwargs["nextToken"] = token
        resp = bedrock.list_guardrails(**kwargs)
        for g in resp.get("guardrails", []):
            if g.get("name") == GUARDRAIL_NAME:
                return g["id"]
        token = resp.get("nextToken")
        if not token:
            return None


def handler(event, context):
    request_type = event.get("RequestType")
    logger.info(f"guardrail seed: {request_type}")
    try:
        if request_type in ("Create", "Update"):
            existing = _find_existing()
            common = dict(
                description=GUARDRAIL_TITLE,
                blockedInputMessaging=BLOCKED_INPUT,
                blockedOutputsMessaging=BLOCKED_OUTPUT,
                sensitiveInformationPolicyConfig=_sensitive_config(),
            )
            if existing:
                bedrock.update_guardrail(guardrailIdentifier=existing, name=GUARDRAIL_NAME, **common)
            else:
                bedrock.create_guardrail(name=GUARDRAIL_NAME, **common)
        elif request_type == "Delete":
            # Leave the guardrail in place on stack delete — it may be referenced by chats
            # and is cheap to keep. Flip to delete_guardrail here if teardown should remove it.
            pass
    except Exception:  # noqa: BLE001 - a seed failure must not block/roll back the deploy
        logger.exception("guardrail seed failed (non-fatal)")
    return {"PhysicalResourceId": PHYSICAL_ID}
