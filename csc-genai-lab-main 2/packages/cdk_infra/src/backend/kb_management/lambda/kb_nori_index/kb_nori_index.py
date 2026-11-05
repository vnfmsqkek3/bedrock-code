# Copyright Amazon.com and its affiliates; all rights reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  https://aws.amazon.com/asl/

"""CloudFormation custom resource: attach a Korean (nori) analyzer to the KB text field.

Why a custom resource instead of the VectorIndex construct's `analyzer` option: that
option writes the analyzer into the index *settings* but never references it from a field
mapping, and does not name it `default` either. An analyzer no field points at does
nothing, so the option silently has no effect (0.1.302 and the latest 0.1.318 are
identical here). Attaching it requires writing the mapping ourselves.

Why it runs during the deploy rather than after: rebuilding an index means recreating it
empty, and Bedrock tracks per-document sync state on the data source separately from the
index. Rebuild after documents have been ingested and the next ingestion job decides
nothing changed, skips everything, and leaves the index permanently empty. Running here —
after the index exists but before the initial sync — means nothing has been ingested yet,
so the ordinary first ingestion fills the rebuilt index.

Idempotent: if the field already uses the analyzer this is a no-op, so stack updates do
not wipe the vector store.

Measured effect on Korean queries: the standard analyzer splits on whitespace and
punctuation only, so a compound noun written as one word and the same noun written with a
space produce disjoint tokens, and an inflected form does not match its base form. Nori
decomposes both to the same morphemes, so either spelling matches. That is the half of
hybrid search that carries exact names, and it is inert without this.
"""

import hashlib
import json
import os
import time
import urllib.error
import urllib.request

import boto3
from aws_lambda_powertools import Logger
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

logger = Logger(use_rfc3339=True)

REGION = os.getenv("AWS_REGION")
ANALYZER = "nori_ko"
ANALYSIS = {
    "analyzer": {
        ANALYZER: {
            "type": "custom",
            "char_filter": ["icu_normalizer"],
            "tokenizer": "nori_tokenizer",
            "filter": ["nori_part_of_speech", "nori_readingform"],
        }
    }
}
# Mirrors the settings the VectorIndex construct creates, so the rebuilt index keeps the
# same index-level configuration; only the analysis block above is added on top.
BASE_INDEX_SETTINGS = {
    "number_of_shards": "2",
    "knn.algo_param": {"ef_search": "512"},
    "knn": "true",
}


def _request(endpoint, method, path, body=None):
    """Signed AOSS call. The service rejects requests without x-amz-content-sha256."""
    data = json.dumps(body).encode() if body is not None else b""
    headers = {
        "Content-Type": "application/json",
        "x-amz-content-sha256": hashlib.sha256(data).hexdigest(),
    }
    credentials = boto3.Session().get_credentials().get_frozen_credentials()
    signed = AWSRequest(method=method, url=endpoint + path, data=data, headers=headers)
    SigV4Auth(credentials, "aoss", REGION).add_auth(signed)
    req = urllib.request.Request(
        endpoint + path, data=data or None, method=method, headers=dict(signed.headers.items())
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def _read_mapping(endpoint, index_name, timeout=600):
    """Read the mapping, waiting out index creation and data-access-policy propagation.

    Both are eventually consistent and neither delay is observable, so poll the real call.
    Runs before anything is deleted: if it never succeeds we fail with the index intact.
    """
    deadline = time.time() + timeout
    while True:
        status, doc = _request(endpoint, "GET", f"/{index_name}/_mapping")
        if status == 200:
            return doc[index_name]["mappings"]["properties"]
        if status not in (403, 404) or time.time() > deadline:
            raise RuntimeError(f"could not read mapping for {index_name}: {status} {doc}")
        time.sleep(15)


def _ensure_analyzer(endpoint, index_name, text_field, force=False):
    properties = _read_mapping(endpoint, index_name)
    if properties.get(text_field, {}).get("analyzer") == ANALYZER and not force:
        logger.info(f"{text_field} already uses '{ANALYZER}'; nothing to do")
        return "unchanged"
    if force:
        logger.info("Rebuilding because the parser changed, not because of the analyzer")

    # Keep every field exactly as the service created it (vector dimensions, engine,
    # metadata field) and only attach the analyzer to the chunk text field.
    properties[text_field] = {**properties.get(text_field, {"type": "text"}), "analyzer": ANALYZER}

    status, out = _request(endpoint, "DELETE", f"/{index_name}")
    if status not in (200, 404):
        raise RuntimeError(f"delete failed: {status} {out}")
    time.sleep(10)

    status, out = _request(endpoint, "PUT", f"/{index_name}", {
        "settings": {"index": BASE_INDEX_SETTINGS, "analysis": ANALYSIS},
        "mappings": {"properties": properties},
    })
    if status != 200:
        raise RuntimeError(f"create failed: {status} {out}")
    # Bedrock rejects ingestion against an index that is not queryable yet.
    time.sleep(30)
    logger.info(f"rebuilt {index_name} with '{ANALYZER}' on {text_field}")
    return "rebuilt"


@logger.inject_lambda_context(log_event=True)
def on_event(event, context):
    request_type = event["RequestType"]
    props = event["ResourceProperties"]
    physical_id = f"{props['IndexName']}-{ANALYZER}"

    # Delete is a no-op on purpose: the index belongs to the VectorIndex resource, which
    # removes it on its own. Dropping it here would race that teardown.
    if request_type == "Delete":
        return {"PhysicalResourceId": physical_id}

    # Changing how documents are parsed replaces the data source, and the replacement starts
    # with nothing synced. The chunks the previous parser wrote are not removed with it — the
    # data source's deletion policy keeps the vectors — so they stay in the index as sources
    # nothing tracks any more: undeletable through the document API, and mixed into answers
    # alongside the re-parsed versions of the same pages. Emptying the index here is what
    # makes a parser change actually take effect rather than accumulate.
    old = event.get("OldResourceProperties") or {}
    force = request_type == "Update" and props.get("ParserFingerprint") != old.get(
        "ParserFingerprint"
    )
    result = _ensure_analyzer(
        props["Endpoint"], props["IndexName"], props["TextField"], force=force
    )
    return {"PhysicalResourceId": physical_id, "Data": {"Result": result}}
