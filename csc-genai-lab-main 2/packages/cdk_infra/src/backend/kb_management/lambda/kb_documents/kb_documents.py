# Copyright Amazon.com and its affiliates; all rights reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  https://aws.amazon.com/asl/

import os
import re
import json
import uuid
import unicodedata
import zipfile
import io
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ConnectTimeoutError, ReadTimeoutError
from aws_lambda_powertools import Logger
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.utilities.typing import LambdaContext

logger = Logger(use_rfc3339=True)
cors_config = CORSConfig(allow_origin="*", max_age=300)
app = APIGatewayRestResolver(cors=cors_config)

KB_BUCKET = os.getenv("KB_BUCKET")
KNOWLEDGE_BASE_ID = os.getenv("KNOWLEDGE_BASE_ID")
_DATA_SOURCE_ID = os.getenv("DATA_SOURCE_ID")  # may be unset; resolved at runtime below


def _data_source_id(refresh=False):
    """Resolve the KB's data source id. It's no longer injected as a cross-stack env var
    (that CloudFormation export blocked ever recreating the data source — e.g. to change
    the parser). Look it up from the knowledge base at runtime, and cache."""
    global _DATA_SOURCE_ID
    if _DATA_SOURCE_ID and not refresh:
        return _DATA_SOURCE_ID
    summaries = bedrock_agent.list_data_sources(
        knowledgeBaseId=KNOWLEDGE_BASE_ID, maxResults=5
    ).get("dataSourceSummaries", [])
    _DATA_SOURCE_ID = summaries[0]["dataSourceId"] if summaries else None
    return _DATA_SOURCE_ID


def _with_data_source(call):
    """Run `call(data_source_id)`, re-resolving the id once if the cached one is gone.

    Changing the data source's parsing or chunking configuration replaces it, giving it a
    new id. The old id stays cached in every warm execution environment, which then fails
    every call against it — ingestion never starts, status never loads, deletes fall back —
    until that environment is recycled. Which requests hit a stale environment is luck, so
    the breakage looks intermittent rather than total. Re-resolving on the error makes the
    recovery immediate instead of waiting for the environment to age out.
    """
    try:
        return call(_data_source_id())
    except bedrock_agent.exceptions.ResourceNotFoundException:
        fresh = _data_source_id(refresh=True)
        logger.info(f"Data source id was stale; re-resolved to {fresh}")
        return call(fresh)
METADATA_MODEL_ID = os.getenv("METADATA_MODEL_ID", "anthropic.claude-3-5-sonnet-20240620-v1:0")
SELF_FUNCTION_NAME = os.getenv("AWS_LAMBDA_FUNCTION_NAME")
STAGING_PREFIX = "staging/"
DOC_PREFIX = "documents/"
# Companion object holding the text a vision model read off each page, ingested alongside
# the original. A page whose substance is a table or a screenshot carries no text layer, so
# the parser can only extract it as a picture: retrieval then has nothing to match a query
# term against, and the page is reachable only when the vector happens to score well. The
# companion puts those words in the index. The suffix is distinctive so it can be told apart
# from a document a user actually uploaded with an .md extension.
EXTRACT_SUFFIX = ".text.md"
# Page -> section map, derived from the transcription. Which section a page belongs to is
# known here, at ingestion, from the document's own headings; the answering side used to
# re-derive it per query by comparing the retrieved figures' headings against each other,
# which fails exactly when it matters — every candidate coming from one wrong section leaves
# nothing to compare against, and a maker documented in several sections cancels its own name
# out. Writing the map down once removes the guess.
#
# NOT under DOC_PREFIX: the data source ingests that prefix in full, so a map stored there
# would be embedded as if it were a document (and would show up in the document list).
SECTIONS_PREFIX = "_sections/"
# Async /kb/process task status. This MUST NOT live in KB_BUCKET: the knowledge base data
# source scans that bucket in full, and a status object is alive exactly while the upload
# that created it starts an ingestion job — so it gets embedded as if it were a document.
# Deleting it on the final poll is not enough (an indexed chunk outlives the object, and an
# abandoned upload never polls again). A separate bucket removes the timing dependency.
STATUS_BUCKET = os.getenv("STATUS_BUCKET")
STATUS_PREFIX = "tasks/"
# How long a task may stay RUNNING before the poller declares it dead. The worker is this
# same Lambda, so it cannot outlive the function timeout (15 min); anything still RUNNING
# past that was killed without reaching its except block. The minute of slack covers the
# gap between writing RUNNING and the async invocation actually starting.
_TASK_MAX_AGE = 16 * 60

# Bedrock Converse "document" block supported formats, keyed by file extension.
DOC_FORMATS = {
    "pdf": "pdf", "csv": "csv", "doc": "doc", "docx": "docx",
    "xls": "xls", "xlsx": "xlsx", "html": "html", "htm": "html",
    "txt": "txt", "md": "md",
}

# Formats read page by page by a model. Transcription exists to recover words that a parser
# classifies as picture — a table drawn as vector art, the labels printed inside a screenshot —
# and only a rendered document has those.
#
# A spreadsheet has none of that, and asking a model to read one page by page does not even
# finish: measured on a 486 KB workbook, metadata and publication took 7 seconds and the
# document was indexed and searchable, then transcription held the worker until the UI
# reported the upload as failed. Spreadsheets go through _spreadsheet_markdown below instead —
# no model call, exact values, and a table the chunker can carry.
TRANSCRIBED_FORMATS = {"pdf", "doc", "docx"}

# Workbook formats we can open ourselves. .xlsx is a zip of XML, so the standard library is
# enough; .xls is a different, binary format and is left to the index's own parsing.
SPREADSHEET_FORMATS = {"xlsx", "xlsm"}

# How often the column names are repeated inside a sheet's table. Chunking cuts a long sheet
# into pieces and a piece that starts mid-table carries no column names — the rows then reach
# the model as bare values, and "핸디소프트" in one column means the owner while the same word
# in another means who does the work. Measured on the indexed chunks of a real workbook: rows
# arrived with no way to tell which column a value came from. Same rule the page transcription
# already follows — a row has to identify itself.
_HEADER_EVERY = 15

# Guards on a workbook large enough to bury the index in one document.
_MAX_SHEET_ROWS = 2000
_MAX_SHEET_CHARS = 400_000

# SigV4 + regional virtual-hosted endpoint. Without this, presigned PUT URLs come out
# SigV2 on the global s3.amazonaws.com host, which 307-redirects for any bucket outside
# us-east-1 (e.g. us-west-2). The browser can't follow that redirect on a CORS PUT, so
# uploads fail. SigV4 signs the regional endpoint (bucket.s3.<region>.amazonaws.com) → no
# redirect → CORS works.
s3 = boto3.client(
    "s3",
    region_name=os.getenv("AWS_REGION"),
    config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
)
bedrock_agent = boto3.client("bedrock-agent")
lambda_client = boto3.client("lambda")
# /kb/process runs the Converse calls in a background (async) invocation, so they no longer
# have to fit API Gateway's 29 s integration timeout — only the Lambda's own. Reading every
# page of a long document and transcribing it takes minutes, well past the old 240 s, so
# this tracks the Lambda timeout instead. No retry: a retry would double the wall clock and
# the model rarely recovers on a second identical attempt.
bedrock_runtime = boto3.client(
    "bedrock-runtime",
    config=Config(read_timeout=840, connect_timeout=10, retries={"max_attempts": 0}),
)

# Above this we skip analysis and transcription and ingest the document as-is, with no
# generated metadata and no page transcription. That costs the document its scope filter,
# its section map, and every word that lives only inside a screenshot or a vector table —
# so the ceiling should sit where the API actually stops, not below it.
#
# It previously sat at 4 MiB, on the belief that "Converse rejects anything over ~4.5 MB".
# That is not what Converse does. Measured in ap-northeast-2 against
# global.anthropic.claude-sonnet-4-6, holding bytes constant and varying page count:
#
#   6.77 MiB /  70 pages   ok, ~30s
#   6.81 MiB / 140 pages   ok,  60s, 237k input tokens
#   6.85 MiB / 210 pages   ok,  78s, 356k input tokens
#   6.92 MiB / 350 pages   "Bedrock is unable to process your request"
#
# The binding constraint is pages (tokens), not bytes — the failing case was the smallest
# jump in file size and the largest in page count. A real 4.52 MiB / ~30-page slide export
# was being refused here for a limit that does not exist, which is the failure this value
# is set to avoid; 20 MiB leaves room under the 32 MB request ceiling.
#
# Two ceilings still stand above this one, both already handled rather than guarded:
#   - Transcription output caps at 32k tokens (~100 pages of this corpus). _extract_page_text
#     keeps the partial text and logs it, so a long document degrades instead of failing.
#   - Page count, per the measurements above. No guard: the API's own error is clearer than
#     a page count we would have to keep re-measuring.
# If a document ever needs more than this, InvokeModel with the Anthropic Messages API takes
# PDFs up to 32 MB / 600 pages — verified working on the same 6.77 MiB file.
MAX_ANALYZE_BYTES = 20 * 1024 * 1024  # 20 MiB


@app.post("/kb/upload-url")
def create_upload_url():
    """Stage 1 (업로드): presigned S3 PUT URL into the staging area (no auto-ingest there)."""
    body = app.current_event.json_body or {}
    filename = body.get("filename")
    content_type = body.get("contentType", "application/octet-stream")
    if not filename:
        return {"message": "filename is required"}, 400

    key = f"{STAGING_PREFIX}{filename}"
    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": KB_BUCKET, "Key": key, "ContentType": content_type},
        ExpiresIn=300,
    )
    return {"uploadUrl": url, "stagingKey": key, "filename": filename}


@app.post("/kb/process")
def process_document():
    """
    Stages 2-4, kicked off asynchronously: Bedrock analysis of a large PDF regularly runs
    past API Gateway's 29 s integration timeout, and a 504 carries no CORS headers, so the
    browser reports it as "Failed to fetch" even though the Lambda finishes fine. Instead
    we hand the work to a background invocation of this same Lambda and return a taskId
    the UI polls via GET /kb/process?taskId=.
    """
    body = app.current_event.json_body or {}
    staging_key = body.get("stagingKey")
    if not staging_key:
        return {"message": "stagingKey is required"}, 400
    filename = body.get("filename") or staging_key.rsplit("/", 1)[-1]

    task_id = uuid.uuid4().hex
    _put_task(task_id, {"status": "RUNNING"})
    lambda_client.invoke(
        FunctionName=SELF_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps(
            {"_task": {"taskId": task_id, "stagingKey": staging_key, "filename": filename}}
        ).encode("utf-8"),
    )
    return {"taskId": task_id, "status": "RUNNING"}, 202


@app.get("/kb/process")
def process_status():
    """Poll target for the async /kb/process task. Returns RUNNING, or the DONE payload
    (key/summary/metadataAttributes/ingestionJobId), or FAILED with a message."""
    task_id = app.current_event.get_query_string_value(name="taskId")
    if not task_id:
        return {"message": "taskId query parameter is required"}, 400
    return _get_task(task_id)


def _task_key(task_id):
    return f"{STATUS_PREFIX}{task_id}.json"


def _put_task(task_id, payload):
    s3.put_object(
        Bucket=STATUS_BUCKET,
        Key=_task_key(task_id),
        Body=json.dumps(payload).encode("utf-8"),
        ContentType="application/json",
    )


def _get_task(task_id):
    try:
        obj = s3.get_object(Bucket=STATUS_BUCKET, Key=_task_key(task_id))
        result = json.loads(obj["Body"].read())
    except s3.exceptions.NoSuchKey:
        # Either an unknown id, or a finished task already collected by a previous poll.
        return {"status": "UNKNOWN"}
    # A worker killed by the Lambda timeout or an OOM never reaches its except block, so
    # nothing ever writes DONE/FAILED and the UI polls RUNNING forever. The object's own
    # age is the evidence: past the worker's maximum lifetime there is no one left to
    # write it. Judged here rather than in the UI because every caller polls through this.
    age = (datetime.now(timezone.utc) - obj["LastModified"]).total_seconds()
    if result.get("status") == "RUNNING" and age > _TASK_MAX_AGE:
        logger.warning(f"Task {task_id} abandoned — RUNNING past the worker's lifetime")
        result = {"status": "FAILED", "message": "처리 시간이 초과되었습니다. 다시 시도해 주세요."}
    if result.get("status") in ("DONE", "FAILED"):
        # Terminal: hand it over and drop the object. Housekeeping only — correctness no
        # longer depends on this happening, since the bucket is outside the data source.
        s3.delete_object(Bucket=STATUS_BUCKET, Key=_task_key(task_id))
    return result


def _run_process_task(task):
    """Background worker for POST /kb/process (invoked with InvocationType='Event')."""
    task_id = task["taskId"]
    try:
        result = _process_document(task["stagingKey"], task["filename"])
        _put_task(task_id, {"status": "DONE", **result})
    except Exception as e:  # noqa: BLE001 - the poller is the only reader; surface it there
        logger.exception(f"Process task {task_id} failed")
        _put_task(task_id, {"status": "FAILED", "message": str(e)})


def _analyze_key(key, filename):
    """Produce a document's metadata attributes from the object stored at `key`.

    Shared by the upload flow and the deploy-time backfill so documents that ship with the
    stack end up with the same attributes, from the same prompt, as uploaded ones.
    """
    # Check size first (via HEAD, no full download) — anything above the Converse limit is
    # a guaranteed reject, so skip the call and ingest without auto-metadata.
    head = s3.head_object(Bucket=KB_BUCKET, Key=key)
    doc_size = head.get("ContentLength", 0)
    if doc_size > MAX_ANALYZE_BYTES:
        logger.info(
            f"Skip auto-analysis for {filename}: size {doc_size} > {MAX_ANALYZE_BYTES} "
            "(Bedrock Converse document ceiling). Ingesting without generated metadata."
        )
        analysis = {"summary": "", "metadataAttributes": {}}
    else:
        doc_bytes = s3.get_object(Bucket=KB_BUCKET, Key=key)["Body"].read()
        analysis = _analyze_document(doc_bytes, filename)

    # Stamp the title deterministically, regardless of what the model produced. The
    # generated attributes are best-effort and are not guaranteed to mention what tells
    # this document apart from a similar one — and an attribute present on some documents
    # but missing on others is worse than no filter at all, because a query filtered on it
    # silently excludes every document that lacks it. This one is always present, always
    # exact, and needs no model call.
    analysis["metadataAttributes"]["source_title"] = _title_of(filename)
    _add_scope_key(analysis["metadataAttributes"])
    return analysis


def _add_scope_key(attributes):
    """Store a whitespace-free copy of `scope` for filtering.

    Metadata filters compare values as exact strings — the index analyzer applies to text
    fields, never to filter values. So a question that spaces a compound name differently
    from the document matches nothing, and the answer becomes "not in the documents".
    Stripping whitespace on both sides makes the spellings one key, while `scope` keeps its
    readable form for display.
    """
    scope = str(attributes.get("scope") or "").strip()
    if scope:
        attributes["scope_key"] = re.sub(r"\s+", "", unicodedata.normalize("NFC", scope))
    return attributes


def _page_sections(text):
    """{"pages": {page(0-based): section title}, "sections": [title, …]} from a transcription.

    Reads the 〔section: …〕 lines the transcription prompt emits, and falls back to Markdown
    headings so a document transcribed before that instruction existed still yields a map.

    A page with no title of its own inherits the section running at that point — a section
    continued across pages is the common case, and leaving those pages blank would put the
    answering side straight back to guessing for them.
    """
    # Headings are the FALLBACK, not a second source. A transcription that carries the tags
    # also carries ordinary headings — the document title, a table caption — and mixing both
    # puts entries in the section list that name no section. The list is what section identity
    # is measured against, so a stray entry shifts every figure's identity.
    tagged = "〔section:" in (text or "")
    pattern = re.compile(r"^〔section:\s*(.+?)〕$" if tagged else r"^#{1,6}\s+(.+?)\s*$")

    pages, order, explicit = {}, [], set()
    current, page = "", None
    for line in (text or "").split("\n"):
        stripped = line.strip()
        marker = re.match(r"^\[p(\d+)\]", stripped)
        if marker:
            page = int(marker.group(1)) - 1
            if current:
                pages[page] = current
            continue
        found = pattern.match(stripped)
        title = found.group(1).strip() if found else ""
        if not title:
            continue
        current = title
        if title not in order:
            order.append(title)
        # The FIRST title on a page wins. A section boundary falling mid-page would otherwise
        # relabel the whole page as the section that starts at its bottom.
        if page is not None and page not in explicit:
            pages[page] = title
            explicit.add(page)
    return {"pages": {str(p): t for p, t in sorted(pages.items())}, "sections": order}


def _put_sections(doc_key, text):
    """Store the page->section map for `doc_key`, outside the prefix the data source ingests."""
    sections = _page_sections(text)
    if not sections["pages"]:
        return
    s3.put_object(
        Bucket=KB_BUCKET,
        Key=f"{SECTIONS_PREFIX}{doc_key.split('/')[-1]}.json",
        Body=json.dumps(sections, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    logger.info(
        f"Wrote section map for {doc_key.split('/')[-1]}: "
        f"{len(sections['pages'])} pages, {len(sections['sections'])} sections"
    )


def _put_extract(doc_key, filename, sidecar):
    """Transcribe the document at `doc_key` and store the result beside it."""
    head = s3.head_object(Bucket=KB_BUCKET, Key=doc_key)
    if head.get("ContentLength", 0) > MAX_ANALYZE_BYTES:
        logger.info(f"Skip page transcription for {filename}: over the Converse input ceiling")
        return
    text = _extract_page_text(s3.get_object(Bucket=KB_BUCKET, Key=doc_key)["Body"].read(), filename)
    if not text.strip():
        return
    extract_key = f"{doc_key}{EXTRACT_SUFFIX}"
    s3.put_object(
        Bucket=KB_BUCKET, Key=f"{extract_key}.metadata.json",
        Body=sidecar, ContentType="application/json",
    )
    s3.put_object(
        Bucket=KB_BUCKET, Key=extract_key,
        Body=text.encode("utf-8"), ContentType="text/markdown",
    )
    logger.info(f"Wrote page transcription for {filename}: {len(text)} chars")
    _put_sections(doc_key, text)


def _process_document(staging_key, filename):
    # Stage 2-3 (분석 + 메타데이터 생성): let Bedrock read the document directly.
    analysis = _analyze_key(staging_key, filename)

    doc_key = f"{DOC_PREFIX}{filename}"
    sidecar = json.dumps({"metadataAttributes": analysis["metadataAttributes"]}).encode("utf-8")

    # Write the metadata sidecar BEFORE the document so ingestion picks it up.
    s3.put_object(
        Bucket=KB_BUCKET,
        Key=f"{doc_key}.metadata.json",
        Body=sidecar,
        ContentType="application/json",
    )

    # Publish the document into documents/ (this also fires the S3 auto-ingest trigger).
    s3.copy_object(
        Bucket=KB_BUCKET,
        CopySource={"Bucket": KB_BUCKET, "Key": staging_key},
        Key=doc_key,
    )
    s3.delete_object(Bucket=KB_BUCKET, Key=staging_key)

    # Transcribe the pages and ingest that next to the original, under the SAME metadata.
    # The companion is a separate S3 object and therefore a separate knowledge-base document,
    # so it needs its own sidecar: without one it has no scope attribute, and any question
    # narrow enough to be filtered by scope would exclude the very text it was written for.
    # After the document is published, not before — transcription is the slowest step here
    # and the one that can exhaust the Lambda, and the upload must not be lost with it.
    _put_extract(doc_key, filename, sidecar)

    # Stage 4 (벡터화/OpenSearch): start ingestion and return a job id to poll.
    job_id = _start_ingestion()

    return {
        "key": doc_key,
        "summary": analysis["summary"],
        "metadataAttributes": analysis["metadataAttributes"],
        "ingestionJobId": job_id,
    }


@app.post("/kb/ingestion")
def start_ingestion():
    """Start a sync and return its job id.

    Needed because the S3 trigger skips when a job is already running, on the assumption
    that the in-flight job will cover whatever just landed. That does not hold for an
    object that arrives after the running job has already enumerated the bucket — it stays
    unindexed until something else starts a job. Uploading several documents at once makes
    that overlap the normal case, so the client asks for one sync after the batch.
    """
    return {"ingestionJobId": _start_ingestion()}


@app.get("/kb/ingestion")
def ingestion_status():
    """Poll target for stage 4 — returns the ingestion job status (COMPLETE when vectorized)."""
    job_id = app.current_event.get_query_string_value(name="jobId")
    if not job_id:
        return {"message": "jobId query parameter is required"}, 400
    try:
        resp = _with_data_source(lambda ds: bedrock_agent.get_ingestion_job(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=ds,
            ingestionJobId=job_id,
        ))
        job = resp.get("ingestionJob", {})
        return {"status": job.get("status"), "statistics": job.get("statistics", {})}
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Could not read ingestion job {job_id}: {e}")
        return {"status": "UNKNOWN"}


@app.get("/kb/documents")
def list_documents():
    """List KB documents with metadata + latest ingestion status.

    Everything the knowledge base ingests lives under ``documents/`` — uploads and the
    documents shipped with the stack alike — so one prefix covers the list. Sidecars, folder
    markers and page transcriptions are excluded: a transcription is machine-generated from
    a document already in the list, and showing it would offer a second entry that deletes
    half of one document.
    """
    documents = []
    seen = set()
    paginator = s3.get_paginator("list_objects_v2")

    def _collect(kwargs):
        for page in paginator.paginate(**kwargs):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key in seen or key.endswith(".metadata.json") or key.endswith("/"):
                    continue
                if key.endswith(EXTRACT_SUFFIX):
                    continue  # generated from the document it sits next to
                seen.add(key)
                documents.append(
                    {
                        "key": key,
                        "size": obj["Size"],
                        "lastModified": obj["LastModified"].isoformat(),
                        "metadataAttributes": _read_metadata(f"{key}.metadata.json"),
                    }
                )

    _collect({"Bucket": KB_BUCKET, "Prefix": DOC_PREFIX})
    return {"documents": documents, "ingestionStatus": _latest_ingestion_status()}


@app.delete("/kb/documents")
def delete_document():
    """Delete a document and its metadata sidecar. Key passed as ?key=documents/<file>."""
    key = app.current_event.get_query_string_value(name="key")
    if not key:
        return {"message": "key query parameter is required"}, 400
    # The page transcription is part of this document, not a document of its own — leaving
    # it behind would keep answering questions from a document the user just deleted.
    keys = [key, f"{key}.metadata.json",
            f"{key}{EXTRACT_SUFFIX}", f"{key}{EXTRACT_SUFFIX}.metadata.json"]
    for k in keys:
        s3.delete_object(Bucket=KB_BUCKET, Key=k)
    # Deleting the S3 object alone does NOT remove its vectors from OpenSearch — the
    # auto-ingest trigger only fires on OBJECT_CREATED, and a full ingestion re-scan can
    # lag. Ask Bedrock to purge this document's vectors directly so search results are
    # accurate immediately; still kick an ingestion job as a fallback/safety net in case
    # the direct delete API is unavailable for this data source.
    deletion_job_id = None
    try:
        resp = _with_data_source(lambda ds: bedrock_agent.delete_knowledge_base_documents(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=ds,
            documentIdentifiers=[
                {"dataSourceType": "S3", "s3": {"uri": f"s3://{KB_BUCKET}/{key}"}},
                {"dataSourceType": "S3", "s3": {"uri": f"s3://{KB_BUCKET}/{key}{EXTRACT_SUFFIX}"}},
            ],
        ))
        deletion_job_id = resp.get("documentDetails", [{}])[0].get("status")
    except Exception:
        logger.exception("delete_knowledge_base_documents failed (falling back to ingestion sync)")
    job_id = _start_ingestion()
    return {"ok": True, "deleted": key, "ingestionJobId": job_id, "deletionStatus": deletion_job_id}


def _title_of(filename):
    """Filename without its extension, NFC-normalized.

    Normalization matters: filenames uploaded from macOS arrive decomposed (NFD) while
    queries and filter values are composed (NFC), and the two never compare equal.
    """
    return unicodedata.normalize("NFC", filename).rsplit(".", 1)[0]


def _analyze_document(doc_bytes, filename):
    """Use Bedrock Converse (document understanding) to summarize + generate metadata."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    doc_format = DOC_FORMATS.get(ext)
    if not doc_format:
        logger.info(f"Unsupported format for analysis: {ext}; ingesting without generated metadata.")
        return {"summary": "", "metadataAttributes": {}}

    # Converse document name allows only alphanumerics, spaces, hyphens, parens, brackets,
    # and must be non-blank — an all-non-ASCII (e.g. all-Korean) filename sanitizes to blank.
    doc_name = re.sub(r"[^a-zA-Z0-9\s\-\(\)\[\]]", " ", filename.rsplit(".", 1)[0])
    doc_name = re.sub(r"\s+", " ", doc_name).strip()[:200] or "document"

    # The sanitized doc_name above drops every non-ASCII character, so for a non-English
    # filename the model would otherwise never see the real title — and the title is often
    # the only place a document says which subject/edition/site it covers. Pass it in the
    # prompt text, which has no charset restriction, and tell the model to mine it.
    title = _title_of(filename)
    prompt = (
        "You are indexing a document into a knowledge base. Read the attached document and respond with "
        "ONLY a JSON object, no prose, in this exact shape:\n"
        '{"summary": "<1-2 sentence plain-language summary a non-expert can understand>", '
        '"metadataAttributes": {"topic": "<short topic>", "doc_type": "<e.g. faq, guide, report>", '
        '"language": "<language>", "keywords": "<3-5 comma-separated keywords>", '
        '"scope": "<the specific subject this edition covers — site, product, org, region or '
        'version — taken from the title or document; empty string if it is not stated>"}}\n'
        f"The document's title is: {title}\n"
        "The title often names what distinguishes this document from similar ones; when it does, "
        "reflect that in scope and keywords, in the same language as the title.\n"
        "Keep every value short. Use only string values."
    )

    try:
        resp = bedrock_runtime.converse(
            modelId=METADATA_MODEL_ID,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"document": {"format": doc_format, "name": doc_name, "source": {"bytes": doc_bytes}}},
                        {"text": prompt},
                    ],
                }
            ],
            inferenceConfig={"maxTokens": 512, "temperature": 0},
        )
        text = resp["output"]["message"]["content"][0]["text"]
        parsed = json.loads(_extract_json(text))
        return {
            "summary": str(parsed.get("summary", "")),
            "metadataAttributes": {k: str(v) for k, v in (parsed.get("metadataAttributes") or {}).items()},
        }
    except (ReadTimeoutError, ConnectTimeoutError) as e:
        # Bounded by the boto3 read_timeout above — treated as "not fast enough to make
        # the API Gateway budget", fall back to ingesting without generated metadata.
        logger.warning(f"Auto metadata generation timed out for {filename}: {e}")
        return {"summary": "", "metadataAttributes": {}}
    except Exception as e:  # noqa: BLE001 - analysis is best-effort; ingest anyway
        logger.warning(f"Auto metadata generation failed for {filename}: {e}")
        return {"summary": "", "metadataAttributes": {}}


_XL_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def _xl_column(ref):
    """Column index for a cell reference: "C7" -> 2. Gaps in a row must keep their place."""
    letters = re.match(r"[A-Z]+", ref or "")
    if not letters:
        return 0
    n = 0
    for ch in letters.group():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _xl_shared_strings(archive):
    """Strings a workbook stores once and references by index. Absent when all are inline."""
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return ["".join(t.text or "" for t in si.iter(f"{{{_XL_NS['m']}}}t"))
            for si in root.findall("m:si", _XL_NS)]


def _xl_sheets(archive):
    """[(sheet name, path in the archive)] in the order the workbook lists them."""
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    target = {rel.get("Id"): rel.get("Target") or "" for rel in rels}
    out = []
    for sheet in workbook.find("m:sheets", _XL_NS) or []:
        path = target.get(sheet.get(f"{{{_XL_NS['r']}}}id"), "")
        path = path[1:] if path.startswith("/") else path if path.startswith("xl/") else f"xl/{path}"
        out.append((sheet.get("name") or "", path))
    return out


def _xl_rows(archive, path, shared):
    """Rows of one sheet as lists of strings, empty cells preserved as ""."""
    root = ET.fromstring(archive.read(path))
    for row in root.iter(f"{{{_XL_NS['m']}}}row"):
        cells, width = {}, 0
        for cell in row.findall("m:c", _XL_NS):
            kind = cell.get("t")
            if kind == "inlineStr":
                inline = cell.find("m:is", _XL_NS)
                text = ("".join(t.text or "" for t in inline.iter(f"{{{_XL_NS['m']}}}t"))
                        if inline is not None else "")
            else:
                value = cell.find("m:v", _XL_NS)
                text = (value.text or "") if value is not None else ""
                if kind == "s" and text.isdigit():
                    index = int(text)
                    text = shared[index] if index < len(shared) else ""
            text = " ".join((text or "").split())
            if text:
                cells[_xl_column(cell.get("r", ""))] = text
                width = max(width, _xl_column(cell.get("r", "")) + 1)
        yield [cells.get(i, "") for i in range(width)]


def _xl_header_row(rows):
    """Index of the row that names the columns.

    A working spreadsheet rarely starts with its header: a title, a measurement date and a
    summary block sit above it. Those rows fill one or two cells; the header fills the sheet's
    full width. Take the first row that does — measured on a nine-sheet workbook, this picked
    the right row on every sheet, including four where the header sat eight or nine rows down.
    """
    width = max((len(r) for r in rows), default=0)
    if width < 2:
        return 0
    for i, row in enumerate(rows[:10]):
        if sum(1 for cell in row if cell) >= max(2, int(width * 0.6)):
            return i
    return 0


def _md_row(values, width):
    padded = list(values) + [""] * (width - len(values))
    return "| " + " | ".join(v.replace("|", "\\|") for v in padded[:width]) + " |"


def _spreadsheet_markdown(doc_bytes):
    """A workbook as Markdown: one section per sheet, column names repeated down each table.

    The index reads a spreadsheet's cells on its own, so this is not about recovering lost
    text — it is about keeping each row readable after chunking. Left as the parser writes it,
    a chunk is a run of tab-separated values with the header rows cut away, and a value cannot
    be traced back to the column it came from.

    Returns "" when the file is not a workbook we can open; the caller then ingests the
    original alone, which is the behaviour without this function.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(doc_bytes))
        sheets = _xl_sheets(archive)
        shared = _xl_shared_strings(archive)
    except Exception:  # noqa: BLE001 - not a workbook we can read; fall back to the original
        logger.exception("Could not read workbook structure")
        return ""

    out, budget = [], _MAX_SHEET_CHARS
    for page, (name, path) in enumerate(sheets, start=1):
        try:
            rows = [row for row in _xl_rows(archive, path, shared) if any(row)]
        except (KeyError, ET.ParseError):
            continue
        if not rows:
            continue
        dropped = max(0, len(rows) - _MAX_SHEET_ROWS)
        rows = rows[:_MAX_SHEET_ROWS]
        width = max(len(r) for r in rows)
        head = _xl_header_row(rows)
        # The rows above the header are the sheet's own summary — totals, the date it was
        # measured. They answer questions on their own, so they are kept as plain lines.
        preamble = [" · ".join(c for c in row if c) for row in rows[:head]]
        header, body = rows[head], rows[head + 1:]

        block = [f"[p{page}]", f"〔section: {name}〕"] + preamble
        for i, row in enumerate(body):
            if i % _HEADER_EVERY == 0:
                block += ["", f"〔section: {name}〕", _md_row(header, width), "|" + "---|" * width]
            block.append(_md_row(row, width))
        if dropped:
            block.append(f"(이하 {dropped}행 생략)")
        text = "\n".join(block)
        budget -= len(text)
        out.append(text)
        if budget <= 0:
            logger.info(f"Workbook truncated at sheet {page} ({name}): over {_MAX_SHEET_CHARS} chars")
            break
    return "\n\n".join(out)


def _extract_page_text(doc_bytes, filename):
    """Read every page with a vision model and return one Markdown document.

    The knowledge-base parser decides per element whether something is text or a picture,
    and it is right to call a diagram a picture — but a table drawn as vector art and the
    labels printed inside a screenshot are pictures by that rule too, and their words then
    exist nowhere in the index. Keyword search cannot reach them at all, and vector search
    only can when the page happens to rank, which for a page of model numbers and addresses
    it usually does not.

    So this asks a model to read the pages and write down what they say. The result is
    ingested next to the original rather than in place of it: the original still yields the
    figures themselves, which stay worth returning.

    Returns "" when it cannot run or fails — the caller ingests the original either way,
    which is the behaviour without this function.
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    doc_format = DOC_FORMATS.get(ext)
    if not doc_format:
        return ""
    if ext in SPREADSHEET_FORMATS:
        text = _spreadsheet_markdown(doc_bytes)
        logger.info(f"Converted workbook {filename} to Markdown: {len(text)} chars, no model call")
        return text
    if ext not in TRANSCRIBED_FORMATS:
        logger.info(f"Skip page transcription for {filename}: {ext} stores its text as text")
        return ""

    doc_name = re.sub(r"[^a-zA-Z0-9\s\-\(\)\[\]]", " ", filename.rsplit(".", 1)[0])
    doc_name = re.sub(r"\s+", " ", doc_name).strip()[:200] or "document"

    prompt = (
        "Transcribe this document to Markdown, page by page, so it can be searched by text.\n"
        "Mark each page boundary with exactly this form on its own line: [pN]  (N = page number, "
        "starting at 1). Do NOT use a Markdown heading (no # prefix). Do not skip a page; "
        "emit its marker even when the page is blank.\n"
        "For every page:\n"
        "- Transcribe all body text verbatim.\n"
        "- Render every table as a Markdown table. Include EVERY row and EVERY cell exactly "
        "as printed, including codes, model names, numbers and addresses. Never summarise a "
        "table or write that it continues.\n"
        "- When a heading or label above a table says which group its rows belong to, add "
        "that value as the first column of the table and repeat it on every row. A row has "
        "to identify itself: search splits a document into fragments, and a fragment holding "
        "only rows is unreachable by a question that names the group they belong to.\n"
        # Same principle, applied to the section instead of the table: every fragment has to
        # identify itself. Emitting the section once per page is not enough — chunking cuts a
        # page into several pieces and only the piece holding the heading keeps it. Measured
        # on this corpus before this instruction existed: the documents carried a section
        # heading on 81-100% of their pages, yet only 19% of the chunks that actually reached
        # the model carried one. The other 80% arrived as installation steps with nothing
        # saying which maker they belong to — and every maker in these manuals is documented
        # with the same steps, so the model and the figure matcher were both left guessing.
        "- Name the section on every fragment, not once per section. Write the line "
        "〔section: <section title>〕 directly after each page marker, and repeat that same "
        "line immediately before every table, every picture description and every group of "
        "numbered steps on the page. Use the section's own title exactly as printed. A "
        "fragment that does not name its section cannot be told apart from the same "
        "procedure written for a different product.\n"
        "- Treat each picture on the page as its own item, and transcribe the words printed "
        "inside it — labels, buttons, menu items, tab names, field names, values, messages — "
        "then say in one sentence what it shows. Never stand back and describe the pictures "
        "in the aggregate ('three screenshots showing the setup steps'): the words inside "
        "them are what someone searches for, and a count of pictures contains none of them.\n"
        "- When the page is a diagram, map or floor plan, transcribe every label printed on "
        "it and describe what it depicts.\n"
        "Write the transcription in the language of the document. Output only the Markdown."
    )

    try:
        resp = bedrock_runtime.converse(
            modelId=METADATA_MODEL_ID,
            messages=[{"role": "user", "content": [
                {"document": {"format": doc_format, "name": doc_name, "source": {"bytes": doc_bytes}}},
                {"text": prompt},
            ]}],
            # Long enough for a full transcription of a document that fits the input ceiling.
            # An earlier, much smaller ceiling truncated mid-document, which looked like the
            # model refusing to finish and sent us looking for the wrong fix.
            inferenceConfig={"maxTokens": 32000, "temperature": 0},
        )
        text = resp["output"]["message"]["content"][0]["text"]
        if resp.get("stopReason") == "max_tokens":
            # Keep the partial text: the pages it did reach are still searchable, and the
            # original document is ingested regardless. Splitting the input into page ranges
            # is the fix if this starts happening for real documents.
            logger.warning(f"Page transcription hit the output ceiling for {filename}; keeping partial text")
        return text
    except Exception as e:  # noqa: BLE001 - best-effort; the original is ingested anyway
        logger.warning(f"Page transcription failed for {filename}: {e}")
        return ""


def _extract_json(text):
    """Pull the first {...} block out of the model response."""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    return match.group(0) if match else "{}"


def _start_ingestion():
    """Start an ingestion job; if one is already running, return the in-flight job id."""
    try:
        resp = _with_data_source(lambda ds: bedrock_agent.start_ingestion_job(
            knowledgeBaseId=KNOWLEDGE_BASE_ID, dataSourceId=ds
        ))
        return resp.get("ingestionJob", {}).get("ingestionJobId")
    except bedrock_agent.exceptions.ConflictException:
        logger.info("Ingestion already running; returning the in-flight job id.")
        jobs = _with_data_source(lambda ds: bedrock_agent.list_ingestion_jobs(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=ds,
            sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
            maxResults=1,
        )).get("ingestionJobSummaries", [])
        return jobs[0]["ingestionJobId"] if jobs else None
    except Exception as e:  # noqa: BLE001 - never fail the upload on ingestion errors
        # The document + sidecar are already published; ingestion can be retried
        # (e.g. via the S3 auto-ingest trigger). Return None instead of a 502.
        logger.error(f"Failed to start ingestion job: {e}")
        return None


def _read_metadata(metadata_key):
    try:
        obj = s3.get_object(Bucket=KB_BUCKET, Key=metadata_key)
        return json.loads(obj["Body"].read()).get("metadataAttributes", {})
    except s3.exceptions.NoSuchKey:
        return {}
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Could not read metadata {metadata_key}: {e}")
        return {}


def _latest_ingestion_status():
    try:
        resp = _with_data_source(lambda ds: bedrock_agent.list_ingestion_jobs(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=ds,
            sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
            maxResults=1,
        ))
        jobs = resp.get("ingestionJobSummaries", [])
        return jobs[0]["status"] if jobs else None
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Could not read ingestion status: {e}")
        return None


@logger.inject_lambda_context(log_event=True)
def sidecar_handler(event: dict, context: LambdaContext):
    """CloudFormation custom resource: write metadata sidecars for documents that ship
    with the stack.

    Uploaded documents get their attributes from /kb/process. Documents deployed as stack
    assets never pass through that flow, so without this they land in the vector store
    with no metadata at all — nothing to filter on, nothing in the UI's metadata column.
    Committing sidecars to the repo instead means hand-writing one per sample file and
    keeping it in step with the prompt, which is exactly the chore this removes.

    Runs the same analysis as the upload path (see _analyze_key), so both kinds of
    document end up with the same attributes.

    Gap-filling only: a document that already has a sidecar is left alone. A sidecar
    committed on purpose still wins, and stack updates do not re-run the model.
    """
    props = event.get("ResourceProperties", {}) or {}
    prefixes = props.get("Prefixes") or [""]
    physical_id = "kb-sidecars"
    if event["RequestType"] == "Delete":
        return {"PhysicalResourceId": physical_id}

    written, skipped, transcribed, mapped = [], [], [], []
    paginator = s3.get_paginator("list_objects_v2")
    # Delimiter keeps each pass to a single level, so the access-log prefix is a
    # CommonPrefix and never treated as a document. The root holds documents shipped with
    # the stack; documents/ holds uploads, which arrive with a sidecar already and are
    # visited only so derived keys can be backfilled without a model call.
    pages = (page for prefix in prefixes
             for page in paginator.paginate(Bucket=KB_BUCKET, Prefix=prefix, Delimiter="/"))
    for page in pages:
        for obj in page.get("Contents", []):
            key = obj["Key"]
            filename = key.rsplit("/", 1)[-1]
            if not filename or key.endswith(".metadata.json"):
                continue
            if key.endswith(EXTRACT_SUFFIX):
                # A transcription is not a document to transcribe again.
                continue
            sidecar_key = f"{key}.metadata.json"
            existing = None
            try:
                existing = json.loads(s3.get_object(Bucket=KB_BUCKET, Key=sidecar_key)["Body"].read())
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey"):
                    raise

            if existing is not None:
                # Sidecar already written — by a previous run, by the upload flow, or by
                # hand. Leave its values alone, but backfill derived keys added since it
                # was written. This costs no model call, so documents keep working after
                # an upgrade without being re-uploaded.
                attributes = existing.get("metadataAttributes", {}) or {}
                before = dict(attributes)
                _add_scope_key(attributes)
                needs_write = attributes != before
                if needs_write:
                    logger.info(f"Backfilling derived metadata for {filename}")
                else:
                    skipped.append(filename)
            else:
                attributes = _analyze_key(key, filename)["metadataAttributes"]
                needs_write = True

            sidecar = json.dumps(
                {"metadataAttributes": attributes}, ensure_ascii=False
            ).encode("utf-8")
            if needs_write:
                s3.put_object(
                    Bucket=KB_BUCKET, Key=sidecar_key,
                    Body=sidecar, ContentType="application/json",
                )
                written.append(filename)

            # A document that ships with the stack never passes through /kb/process, so
            # nothing has transcribed its pages. For a document whose substance is drawn
            # rather than typed — a datasheet of tables and curves — the parser can only
            # emit pictures, the index gets no text for it at all, and every question about
            # it is answered "not in the documents" while the file sits there looking
            # ingested. Write the same companion the upload path writes, so a shipped
            # sample is searchable from the very first deploy.
            #
            # Gap-filling, like the sidecar above: an existing companion is left alone, so
            # uploads and repeat runs cost no model call.
            try:
                s3.head_object(Bucket=KB_BUCKET, Key=f"{key}{EXTRACT_SUFFIX}")
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey"):
                    raise
                _put_extract(key, filename, sidecar)
                transcribed.append(filename)
            else:
                # Transcription already there. Its section map may not be — the map was added
                # after these documents were transcribed. Deriving it from the stored text
                # costs no model call, so a document keeps working without being re-read.
                try:
                    s3.head_object(Bucket=KB_BUCKET, Key=f"{SECTIONS_PREFIX}{filename}.json")
                except ClientError as e:
                    if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey"):
                        raise
                    stored = s3.get_object(
                        Bucket=KB_BUCKET, Key=f"{key}{EXTRACT_SUFFIX}"
                    )["Body"].read().decode("utf-8")
                    _put_sections(key, stored)
                    mapped.append(filename)

    logger.info(
        f"Section maps backfilled for {mapped}; "
        f"Sidecars written for {written}; already present for {skipped}; "
        f"page transcriptions written for {transcribed}"
    )
    return {
        "PhysicalResourceId": physical_id,
        "Data": {
            "Written": ",".join(written),
            "Skipped": ",".join(skipped),
            "Transcribed": ",".join(transcribed),
        },
    }


@logger.inject_lambda_context(log_event=True)
def lambda_handler(event: dict, context: LambdaContext):
    # Background invocations carry "_task" instead of an API Gateway event (see /kb/process).
    task = event.get("_task") if isinstance(event, dict) else None
    if task:
        return _run_process_task(task)
    return app.resolve(event, context)
