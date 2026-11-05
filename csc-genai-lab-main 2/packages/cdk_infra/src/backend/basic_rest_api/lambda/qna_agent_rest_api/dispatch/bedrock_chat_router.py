# Copyright Amazon.com and its affiliates; all rights reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  https://aws.amazon.com/asl/

import os
import re
import json
import base64
import hashlib
import unicodedata
from collections import Counter
from functools import lru_cache
from itertools import zip_longest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from botocore.exceptions import ClientError
from aws_lambda_powertools import Logger
from dispatch.chat_context_client import ChatContextClient, InvalidSessionId
from dispatch.types.chat_context import ChatContext
from dispatch.bedrock_client import BedrockClient

logger = Logger(use_rfc3339=True)

table_name = os.getenv('SESSIONS_TABLE')
region_name = os.getenv('AWS_REGION')
account_id = os.getenv('ACCOUNT_ID', '')
knowledge_base_id = os.getenv('KNOWLEDGE_BASE_ID')
default_model_id = os.getenv('DEFAULT_MODEL_ID', 'global.anthropic.claude-sonnet-4-6')
image_bucket_name = os.getenv('IMAGE_BUCKET', '')

# How many retrieved-but-uncited figures to show under an answer. Each is roughly half a
# megabyte of base64, so this is a response-size limit as much as an editorial one — and
# past the first few the pictures stop being about the question.
RELATED_IMAGE_LIMIT = 6

# Most a question is split into. Each intent costs its own generate call, so this bounds
# both latency and spend for a question that lists many things at once.
MAX_INTENTS = 3
# How much retrieved material the planner is shown. It only needs to see what KINDS of thing
# the documents cover, not their contents, and a long digest costs latency on every question.
DIGEST_CHUNKS = 12
DIGEST_CHARS = 100

# Reranking: retrieve broadly (numberOfResults=100), then keep the top RERANK_TOP_N results
# after scoring. This improves precision without losing recall — hierarchical chunking
# produces many small child chunks, so casting a wide net and then filtering is key.
RERANK_TOP_N = 25
# Minimum relevance score (0–1) to keep a result. Chunks below this threshold are noise.
RERANK_MIN_SCORE = 0.25


# S3 client for storing images and generating presigned URLs.
import boto3 as _boto3
_s3_client = _boto3.client('s3', region_name=region_name)

# Presigned URL expiry in seconds (1 hour)
_PRESIGNED_URL_EXPIRY = 3600


def _image_data_to_presigned_url(data_uri: str, doc_uri: str = "", page=None) -> str:
    """Convert a base64 data URI to an S3-stored object with a presigned URL.

    The image is stored under a _tmp_images/ prefix in IMAGE_BUCKET with a
    content-hash filename to avoid duplicates. Returns a presigned GET URL
    valid for _PRESIGNED_URL_EXPIRY seconds.

    Falls back to the original data URI if S3 upload fails or no bucket configured.
    """
    if not image_bucket_name or not data_uri:
        return data_uri

    try:
        # Parse data URI: "data:image/png;base64,<payload>"
        if data_uri.startswith("data:"):
            header, payload = data_uri.split(",", 1)
            # Extract content type: "data:image/png;base64" -> "image/png"
            content_type = header.split(":")[1].split(";")[0]
        else:
            # Raw base64 without header — assume PNG
            payload = data_uri
            content_type = "image/png"

        # Decode to get raw bytes for hashing
        image_bytes = base64.b64decode(payload)

        # Generate a stable key from content hash (dedup identical images)
        content_hash = hashlib.md5(image_bytes).hexdigest()
        ext = content_type.split("/")[-1]  # png, jpeg, etc.
        if ext == "svg+xml":
            ext = "svg"
        s3_key = f"_tmp_images/{content_hash}.{ext}"

        # Upload (idempotent — same hash = same key)
        _s3_client.put_object(
            Bucket=image_bucket_name,
            Key=s3_key,
            Body=image_bytes,
            ContentType=content_type,
        )

        # Generate presigned URL
        url = _s3_client.generate_presigned_url(
            "get_object",
            Params={"Bucket": image_bucket_name, "Key": s3_key},
            ExpiresIn=_PRESIGNED_URL_EXPIRY,
        )
        return url

    except Exception as e:  # noqa: BLE001
        logger.warning(f"Failed to generate presigned URL: {e}")
        return data_uri


def _scope_values(results) -> list:
    """The subjects present in what was retrieved, as (filter value, readable name).

    Taken from the index rather than from the question. A filter compares values as exact
    strings, so a value the model writes from the wording — "대상 B" for a document stored as
    "대상 B" — matches nothing; a value read off the retrieved chunks always matches.
    """
    seen = {}
    for r in results:
        meta = r.get("metadata") or {}
        key = str(meta.get("scope_key") or "").strip()
        if key and key not in seen:
            seen[key] = str(meta.get("scope") or key).strip()
    return list(seen.items())


def _material_digest(results) -> str:
    """One line per retrieved chunk: enough for the planner to name the kinds on offer.

    Figures carry no text, so they contribute nothing here and are skipped.
    """
    lines = []
    for r in results:
        content = r.get("content") or {}
        if content.get("type") == "IMAGE":
            continue
        text = " ".join((content.get("text") or "").split())
        if not text:
            continue
        title = (r.get("metadata") or {}).get("source_title") or ""
        lines.append(f"- [{title}] {text[:DIGEST_CHARS]}")
        if len(lines) >= DIGEST_CHUNKS:
            break
    return "\n".join(lines)

# Used when the user hasn't picked a custom system prompt.
#
# Two placeholders are mandatory. $search_results$ is where the retrieved context is
# injected. $output_format_instructions$ carries the service's own citation instructions —
# a template without it still answers, but every citation comes back with zero
# retrievedReferences, i.e. the answer shows no sources at all (measured: refs=0 without,
# refs=1 with). An earlier version of this constant omitted it, which is why applying it
# appeared to "drop citations" and it ended up unused.
#
# The source-selection rules exist because retrieval returns the top matches, not only the
# correct ones: when a collection holds several documents covering the same subject for
# different targets, a question about one target routinely also retrieves another's
# material — including extracted figures. Left unguided the model answers correctly and
# then volunteers a description of the mismatched figure, which reads as part of the answer.
# The instruction body lives in answer_instructions.txt beside this file, because the deploy
# also seeds it into Bedrock Prompt Management so it is visible and editable in 프롬프트 관리.
# Two copies of the same wording drift, and the copy people read would stop being the copy
# that runs — which is exactly what happened before this was split out.
_INSTRUCTIONS = (Path(__file__).with_name("answer_instructions.txt")).read_text(encoding="utf-8").strip()

DEFAULT_PROMPT_TEMPLATE = (
    "다음은 지식 베이스에서 검색된 참고 자료입니다. 텍스트와 함께 문서에서 추출된 그림이 올 수 있습니다.\n"
    "$search_results$\n\n"
    f"{_INSTRUCTIONS}\n\n"
    "$output_format_instructions$"
)


# Multimodal parsers (Sonnet 4.6 / BDA) wrap extracted images and tables in
# <figure><figure_type>...</figure_type>…description…</figure> markup. That markup is
# stored verbatim in the vector chunks, so it leaks into citation snippets. Strip the tags
# for display while keeping the human-readable description text inside them.
# What RetrieveAndGenerate answers with when the model produced nothing it could use. It is
# a fixed English sentence regardless of the question's language, which is how it is told
# apart from a model legitimately saying it does not know.
_SERVICE_DECLINE = "sorry, i am unable to assist you with this request"


def _is_service_decline(text: str) -> bool:
    return _SERVICE_DECLINE in (text or "").strip().lower()


_FIGURE_TYPE_RE = re.compile(r"<figure_type>.*?</figure_type>", re.DOTALL | re.IGNORECASE)
_FIGURE_TAG_RE = re.compile(r"</?\s*figure\s*>", re.IGNORECASE)


# ── Image relevance ──────────────────────────────────────────────────────────
# Every IMAGE result carries `x-amz-bedrock-kb-description`: the page's markdown with a
# <figure>…</figure> caption saying what the picture actually shows. That caption is the
# only evidence of an image's subject — the image itself has no `content.text` and no OCR.
# Matching on the surrounding PAGE text instead (what this used to do) attaches whatever
# image happens to sit on a cited page.
_FIGURE_BODY_RE = re.compile(r"<figure>(.*?)</figure>", re.DOTALL | re.IGNORECASE)

# Language-agnostic tokens: IPs/dotted versions, Latin words and part numbers, Hangul runs,
# and digit-prefixed units ("10층", "3rd"). Deliberately NO stop-word list — which words are
# uninformative depends entirely on the corpus, and a fixed list would encode one document
# set's vocabulary. Informativeness is measured instead (see _generic_tokens).
_TOKEN_RE = re.compile(
    r"\d{1,3}(?:\.\d{1,3}){2,}"      # 10.13.1.241
    r"|[A-Za-z][A-Za-z0-9-]*"        # 모델명, 모델코드, Windows
    r"|\d+[가-힣A-Za-z]+"             # 10층, 3rd
    r"|[가-힣]{2,}"                   # 복합기, 드라이버
)


def _tokens(text: str) -> set:
    return {t.lower() for t in _TOKEN_RE.findall(text or "")}


def _occurrences(tokens: set, text: str) -> int:
    """How many of `tokens` appear in `text`, by containment rather than equality.

    Korean glues particles onto nouns, so the caption's "마법사" and the answer's "마법사에서"
    tokenize differently and set intersection scores them as unrelated — which silently
    disables matching for most Korean text. Containment sees them as the match they are.
    Single characters are excluded; they hit inside unrelated words too often to mean anything.
    """
    low = (text or "").lower()
    return sum(1 for t in tokens if len(t) > 1 and t in low)


def _weight(tokens: set, text: str) -> int:
    """How much of `text` is made of `tokens` — occurrences, not distinct hits.

    `_occurrences` answers "does this appear at all", which is the right question for a
    single block: a block is a sentence or two, so a word is either its subject or absent.
    Over a whole answer it is the wrong question — every section title shares a word or two
    with any answer from the same manual, and counting distinct hits makes one passing
    mention weigh exactly as much as the word the answer is built on.
    """
    low = (text or "").lower()
    return sum(low.count(t) for t in tokens if len(t) > 1)


def _generic_tokens(corpus: list, threshold: float = 0.5) -> set:
    """Tokens this corpus uses everywhere, so they cannot tell its documents apart.

    Derived, not declared. In a printer-manual corpus "설치/프린터/드라이버" land here; in a
    contract corpus "계약/조항" would instead, and "프린터" would become informative. A fixed
    stop-word list gets this exactly backwards the moment the documents change.

    Returns an empty set for a corpus too small to measure — with no evidence about which
    words are common, nothing is excluded.
    """
    if len(corpus) < 5:
        return set()
    df = Counter()
    for text in corpus:
        df.update(_tokens(text))
    cutoff = len(corpus) * threshold
    return {tok for tok, n in df.items() if n > cutoff}


# Cap on each first-pass chunk shown to the follow-up-query model. Bounds prompt size only —
# chunks are normally well under this, so in practice the whole chunk is passed.
_FOLLOWUP_SNIPPET_LIMIT = 2500

# How many retrieved chunks reach the answering model. The citation numbering is built from
# the same slice, so both must use this constant or [n] markers would point at the wrong source.
_CONTEXT_CHUNKS = 15

# How many words a block and a figure must share before the figure is placed there. One shared
# word is satisfied by a passing mention; a figure that really depicts the step shares several.
#
# This was 3 for a while, and the reason is worth keeping: procedure manuals describe every
# make the same way — "설치/프린터/선택/화면/다운로드" — so two shared words are cleared by any
# two screenshots of any installer, and MAKER A's wizard (p.5) once came back attached to
# answers about MAKER B and SINDOH printers.
#
# Back to 2 now that the wrong-section case is caught upstream instead of here. A figure only
# reaches this scoring if its page was cited AND its section won _section_identity's
# best-match contest, and that section now comes from the map ingestion writes rather than
# from comparing whatever figures the query happened to retrieve. At 3 the gate was doing
# double duty — rejecting wrong figures AND right ones, which is why four questions in five
# came back with no figure at all.
#
# The knob is deliberately still here: it is the last defence if that upstream chain is ever
# weakened, so raise it again rather than patching symptoms downstream.
_MIN_FIGURE_MATCH = 2

# How much of a cited chunk's page has to surface in the answer for that page's figures to
# count as cited. Deliberately not _MIN_FIGURE_MATCH: that one asks "does this figure depict
# this step", this one asks the weaker "did the answer use this page at all". A page pulled in
# only because a parent chunk happened to span it should fall out here, but a page the answer
# genuinely drew a line or two from should stay.
_MIN_PAGE_EVIDENCE = 2

# How the two retrieval rounds share the context: three of the first round per one of the
# second. The second round still lands inside the cut — which is the whole reason it is
# interleaved rather than appended — but it no longer takes half the slots from the ranking
# that answered the question in the first place.
_PASS_MIX = (3, 1)

# How much conversation the follow-up rewriter reads back over. A subject named once and then
# carried implicitly has to stay reachable across the elliptical turns that follow it.
_REWRITE_HISTORY_TURNS = 6
_REWRITE_TURN_CHARS = 300


def _round_robin(groups: list, take: tuple = ()) -> list:
    """Interleave the results of successive retrieval rounds, keeping each round's own order.

    A later round exists precisely because the earlier one was missing something. Concatenating
    instead buries it: with ~57 chunks retrieved and only _CONTEXT_CHUNKS reaching the model,
    everything a second round added sits past the cut and never gets shown — the system fetches
    the right passage and then answers "그 내용은 자료에 없습니다".

    `take` is how many each round contributes per turn; the default of one apiece splits the
    context evenly. An even split is too generous to the later round: measured on this corpus
    it took 7 of the 15 slots, which pushes the first round's list off after rank 8 — and the
    floor table a question about "대상 B 4층" needs sits at rank 14, so the answer came back
    saying the floor's printers were not in the material. A round that exists to fill one gap
    does not need half the context.
    """
    if not take:
        take = (1,) * len(groups)
    iters = [iter(g) for g in groups]
    out, alive = [], True
    while alive:
        alive = False
        for it, n in zip(iters, take):
            for _ in range(n):
                item = next(it, None)
                if item is None:
                    break
                out.append(item)
                alive = True
    return out


# Where ingestion stores each document's page -> section map. Outside the prefix the data
# source ingests, so it is a lookup table and never a retrievable chunk.
SECTIONS_PREFIX = "_sections/"


@lru_cache(maxsize=64)
def _load_sections(doc_uri: str) -> tuple:
    """((page, section title), …), (every section title, …) for a document.

    Which section a page belongs to is a fact ingestion already established from the
    document's own headings. Re-deriving it per query — by comparing the retrieved figures'
    headings against each other — is what kept failing: a page whose figure description
    carried no heading got no section at all, and a maker documented in several sections
    cancelled its own name out of the comparison.

    Cached per Lambda container: the map is small, immutable between ingestions, and read on
    every question that returns a figure.

    Returns empty tuples when there is no map — a document ingested before maps existed — and
    the caller falls back to the heading the parser wrote into the figure's description.
    """
    if not image_bucket_name or not doc_uri:
        return ((), ())
    name = doc_uri.split("/")[-1]
    # S3 stores these keys as the uploader wrote them; macOS clients write decomposed Hangul
    # while most other sources write composed. Both spellings name the same document, so try
    # each rather than lose the map to a normalisation mismatch.
    candidates = {name, unicodedata.normalize("NFC", name), unicodedata.normalize("NFD", name)}
    for candidate in candidates:
        try:
            body = _s3_client.get_object(
                Bucket=image_bucket_name, Key=f"{SECTIONS_PREFIX}{candidate}.json"
            )["Body"].read()
        except Exception:  # noqa: BLE001 - absence is normal; fall through to the next spelling
            continue
        data = json.loads(body)
        pages = tuple(sorted(
            (int(p), t) for p, t in (data.get("pages") or {}).items()
        ))
        return pages, tuple(data.get("sections") or ())
    return ((), ())


def _section_of(doc_uri: str, page) -> str:
    """The section a page belongs to, per the ingested map. Empty when unknown."""
    if page is None:
        return ""
    return dict(_load_sections(doc_uri)[0]).get(int(page), "")


def _document_sections(doc_uris) -> list:
    """Every section of the documents in play, in document order, de-duplicated.

    This is what section identity has to be measured against. Measuring it against only the
    figures a query happened to retrieve makes the answer depend on retrieval luck: the same
    figure is ruled out or waved through depending on which of its siblings came back with it.
    """
    out = []
    for uri in doc_uris:
        for title in _load_sections(uri)[1]:
            if title not in out:
                out.append(title)
    return out


def _figure_caption(img) -> str:
    """What the image depicts, per the KB's <figure> caption. Empty when unknown."""
    desc = (img.get("metadata") or {}).get("x-amz-bedrock-kb-description") or ""
    return " ".join(m.strip() for m in _FIGURE_BODY_RE.findall(desc))


def _page_headings(img) -> str:
    """Markdown headings on the figure's page — the section it belongs to."""
    desc = (img.get("metadata") or {}).get("x-amz-bedrock-kb-description") or ""
    return " ".join(
        line.strip().lstrip("#").strip()
        for line in desc.split("\n")
        if line.strip().startswith("#")
    )


def _identifying_tokens(contexts: dict, generic: set) -> dict:
    """Per figure, the tokens that only IT carries among the candidates.

    Two figures illustrating the same procedure for different subjects share almost all their
    words — screen, button, scan, address, register. What separates them is the handful of
    tokens unique to one: a manufacturer, a model, a section number. Those are the only tokens
    that can answer "is this figure about what the answer is about?".

    Derived by comparing the candidates against each other, so it needs no list of which words
    happen to be meaningful in this corpus.
    """
    tokens = {key: _tokens(text) - generic for key, text in contexts.items()}
    seen = Counter()
    for toks in tokens.values():
        seen.update(toks)
    return {key: {t for t in toks if seen[t] == 1} for key, toks in tokens.items()}


def _scope_first(text_results: list, allowed_scopes: set) -> list:
    """Put the subject the question named at the front of the context, without dropping the rest.

    A larger document about a different subject can flood retrieval — a "대상 A 4층" question
    comes back with six of its top eight chunks from another building's manual, because both
    manuals describe the same procedures. Cut that at _CONTEXT_CHUNKS and the building actually
    asked about barely reaches the model, which then transcribes the neighbouring manual's steps.

    Nothing is removed. Answering from another document when this one omits a procedure is
    deliberate and useful; it just must not outrank the document the question is about. The sort
    is stable, so relevance order inside each group survives.
    """
    if not allowed_scopes:
        return text_results
    return sorted(
        text_results,
        key=lambda r: ((r.get("metadata") or {}).get("scope_key") or "") not in allowed_scopes,
    )


def _chunk_page_key(chunk) -> tuple:
    """(document, first page) for a retrieved text chunk."""
    uri = ((chunk.get("location") or {}).get("s3Location") or {}).get("uri") or ""
    doc = uri.split(".pdf")[0] + ".pdf" if ".pdf" in uri else uri
    text = (chunk.get("content") or {}).get("text") or ""
    marker = re.search(r"\[p(\d+)\]", text)
    if marker:
        return (doc, int(marker.group(1)) - 1)
    page = (chunk.get("metadata") or {}).get("x-amz-bedrock-kb-document-page-number")
    return (doc, int(page) if page is not None else None)


def _keep_pages_together(text_results: list) -> list:
    """Move the chunks of one page next to each other, keeping the best-ranked page first.

    A page is often split so that its prose and its table land in different chunks, and the
    prose chunk — short and densely on-topic — outranks the table by a wide margin. Cut the
    list at _CONTEXT_CHUNKS and the model receives the half of the page that describes what
    the page contains without the half that contains it, then reports, accurately, that the
    detail is not in the material.

    Nothing is added or dropped; a page that was worth retrieving simply arrives whole.
    """
    groups = {}
    order = []
    for chunk in text_results:
        key = _chunk_page_key(chunk)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(chunk)
    return [chunk for key in order for chunk in groups[key]]


def _pages_in_chunk(text: str):
    """[(page_0based, that page's slice of the chunk), …] in the order they appear."""
    marks = list(re.finditer(r"\[p(\d+)\]", text or ""))
    return [
        (int(m.group(1)) - 1, text[m.end():(marks[i + 1].start() if i + 1 < len(marks) else len(text))])
        for i, m in enumerate(marks)
    ]


def _page_texts(text_results: list) -> dict:
    """{(document, page): what this turn retrieved from that page}.

    The figure placement scorer asks whether a block and a figure talk about the same thing,
    and it asks the figure's caption. The parser writes that caption in whatever language it
    chooses, which is not always the document's — and a caption in another language shares no
    tokens with any block, so the scorer answers "no" for every pair and the answer comes back
    with no figures at all. The page's own retrieved text is the same document, the same
    language as the answer, and already in hand; it can say what a page is about when that
    page's caption cannot.
    """
    out = {}
    for chunk in text_results:
        uri = ((chunk.get("location") or {}).get("s3Location") or {}).get("uri") or ""
        doc = uri.split(".pdf")[0] + ".pdf" if ".pdf" in uri else uri
        text = (chunk.get("content") or {}).get("text") or ""
        for page, slice_text in _pages_in_chunk(text):
            out[(doc, page)] = f"{out.get((doc, page), '')} {slice_text}"
    return out


def _cited_page_keys(references: list, text_results: list,
                     answer_text: str = "", generic: set = frozenset()) -> set:
    """Every (document, page) the answer's citations actually rest on.

    A citation names one representative page, but the chunk behind it spans several
    ("…[p31]…[p32]…"), and the figures on those other pages usually belong to the same step —
    so the representative page alone leaves a procedure illustrated with gaps.

    Taking the whole span is what breaks under hierarchical chunking. A parent chunk covers
    2.4 pages on average here and up to 11, so one citation would open eleven pages of
    figures and "only the cited pages" stops filtering anything: a question about the 2nd
    floor came back illustrated with the 4th floor's IP screen (p.18) and, for a MAKER B
    printer, with MAKER A's installer (p.5).

    So the representative page is admitted because the citation names it, and every further
    page of that chunk has to show up in the answer to come along — measured the way figure
    placement is measured (containment, generic words discounted). A page whose words the
    answer never uses contributed nothing to it, whatever else its chunk contained.

    With no answer to check against, the old behaviour stands: the whole span is admitted.
    """
    keys = set()
    for ref in references:
        idx = (ref.get("number") or 0) - 1
        if not (0 <= idx < len(text_results)):
            continue
        chunk = text_results[idx]
        uri = ((chunk.get("location") or {}).get("s3Location") or {}).get("uri") or ""
        doc = uri.split(".pdf")[0] + ".pdf" if ".pdf" in uri else uri
        text = (chunk.get("content") or {}).get("text") or ""

        pages = _pages_in_chunk(text)
        for position, (page, slice_text) in enumerate(pages):
            supported = (
                position == 0
                or not answer_text
                or _occurrences(_tokens(slice_text) - set(generic), answer_text) >= _MIN_PAGE_EVIDENCE
            )
            if supported:
                keys.add((doc, page))

        page = (chunk.get("metadata") or {}).get("x-amz-bedrock-kb-document-page-number")
        if page is not None:
            keys.add((doc, int(page)))
    return keys


def _section_key(title: str) -> str:
    """Comparison key for a section title, blind to how it happens to be written.

    A document states the same section twice — once in its contents list, once as the heading
    on the page — and the two spellings differ in trivia: the number may carry a dot, the
    words may be spaced differently. Ingestion records both, so the same section arrives as
    two sections, and two sections compete.

    Measured: three consecutive pages of one section were mapped to two spellings of its
    title. The gate treated them as rivals and the spelling that scored one point lower was
    dropped — a section beaten by itself. What survived was its weakest page, and the answer
    came back with no figure at all.
    """
    t = unicodedata.normalize("NFC", title or "").lower()
    t = re.sub(r"^[\s\d.\-)_]+", "", t)      # 앞머리 번호 매김: "05", "05.", "3-2." …
    return re.sub(r"\s+", "", t)             # 띄어쓰기 차이


def _section_identity(matched_images: dict, section_list=(), share: int = 2) -> dict:
    """Per figure, what marks its SECTION apart from the other candidates' sections.

    Judged on the page heading — the document's own statement of what a figure belongs to.
    Captions cannot carry this: two figures of the same procedure differ mostly by incidental
    wording ("arrow between them", "저장 터치"), and those accidents look exactly like identity
    when compared token by token.

    Compared SECTION by SECTION, not page by page. A section usually contributes several
    consecutive pages carrying the identical heading; comparing individual pages lets those
    copies cancel each other out — every token appears more than once, so the section ends up
    with no identity at all and passes every gate. That is how a MAKER B answer ended up
    illustrated with the MAKER A section's pages: MAKER A had two candidate pages, so "제조사 A"
    stopped counting as its identity.

    Give this the WIDEST set of figures the turn retrieved, not the handful that survived the
    citation filter. Identity here is relative — a section is known by what the other sections
    do not say — so narrowing the pool first destroys the very evidence this needs. When every
    surviving candidate happens to come from one (wrong) section, `distinct` collapses to a
    single heading and the gate below turns itself off, passing exactly the figures it exists
    to catch. Measured: a 대상 A 10층 answer about MAKER C was illustrated with the
    "02 제조사 A 복합기 드라이버 설치 방법" section's p.4 and p.5, because those two were the only
    candidates left and "제조사 A" therefore had nothing to be unique against.

    An empty set means nothing distinguishes the section from the others, so nothing can rule
    it out — the case of a corpus whose pages carry no headings.
    """
    headings = {key: (c.get("heading") or "").strip() for key, c in matched_images.items()}
    # Measure against the document's WHOLE section list when ingestion recorded one. The
    # candidates alone are a sample of it, and which sample a query draws is retrieval luck —
    # so the same figure was ruled out or waved through depending on which siblings came back
    # with it. The full list makes the measurement the same on every question.
    # 표기가 다른 같은 절은 하나로 묶는다 — 목차 줄과 본문 헤딩이 따로 들어오면 한 절이
    # 자기 자신과 겨루게 되고, 점수가 1점 낮은 표기 쪽 페이지가 통째로 탈락한다.
    canon = {}
    for title in (list(section_list) or [h for h in headings.values() if h]):
        canon.setdefault(_section_key(title), title)
    distinct = set(canon.values())
    if not distinct:
        # The corpus carries no headings, so there is nothing to judge a section by.
        return {key: set() for key in matched_images}

    # Rarest-token identity, NOT strict uniqueness. Requiring a token to appear in exactly one
    # heading (what _identifying_tokens does, correctly, for captions) silently disarms this
    # gate on any manual that documents one subject in more than one section. Measured on the
    # 대상 A manual: "제조사 A" heads three sections — "02 제조사 A … (Windows ver.)",
    # "03 제조사 A … (macOS ver.)" and "1) 제조사 A 복합기 스캔" — so it was never unique, the MAKER A
    # sections were left with an empty identity, and an empty identity passes everything. The
    # same held for 제조사 B (2 sections), 제조사 C (2) and 제조사 D (2): every maker in the
    # document cancelled itself out, and a MAKER C answer was illustrated with MAKER A's
    # installer. Taking each heading's least-common tokens keeps the maker — three sections out
    # of thirteen is still what marks those pages apart — while "복합기/드라이버/설치/방법",
    # which head nearly every section, drop out on their own.
    # 코퍼스 흔한말(generic) 집합을 여기서 빼면 안 된다. 그것은 "어떤 낱말이 문서들을 구별
    # 못 하는가"를 잰 값인데, 절을 구별하는 낱말은 정반대의 성질을 갖는다 — 한 문서가 같은
    # 절차를 조건별로 나눠 설명하면 그 조건어(플랫폼·버전 이름)는 문서 안 어디에나 나오므로
    # 코퍼스 기준으로는 흔한말이 되고, 그래서 절 정체에서 지워진다.
    #
    # 실측으로 정확히 그 일이 있었다. 조건만 다른 두 형제 절의 정체가 둘 다 제조사 이름
    # 하나로 줄어 완전히 같아졌고, 같으면 서로를 이길 수 없으므로 게이트가 통째로 무력화됐다
    # (로그에 `Figure eligibility by section` 줄이 아예 없었다). 그 턴의 코퍼스에서
    # 두 조건어는 청크의 과반에 등장해 generic으로 분류돼 있었다 — 인제스트가 블록마다
    # 절 제목을 반복해 적기 때문이다(정리.md §1).
    #
    # 절에는 이미 자기 기준의 변별력 척도가 있다: 아래의 '문서 절 목록 기준 df'. 흔한 말은
    # 그쪽에서 걸러지고("복합기/드라이버/설치/방법"은 절 대부분에 있어 df 초과), 조건어는
    # 소수 절만 가지므로 정체로 남는다. 척도는 하나면 된다.
    tokens = {h: _tokens(h) for h in distinct}
    df = Counter()
    for toks in tokens.values():
        df.update(toks)
    # Not the single rarest token either: which token is rarest swings with whatever sections
    # this turn happened to retrieve, and it lands on an incidental qualifier as easily as on
    # the subject — with the macOS sections in the pool "windows" was rarer than "제조사 A", so the
    # MAKER A section's identity became {windows} and a MAKER C-on-Windows answer matched it.
    # Everything the minority of sections carry is kept; the caller decides between them.
    # `share`로 문턱을 조인다. 기본(1/2)은 '정체' — 점수를 낼 근거가 되는 낱말이라 넓게 잡는다.
    # 1/4로 부르면 '주제어' — 누구와 겨룰지(형제 관계)를 정하는 데만 쓰는 좁은 집합이다.
    # 한 척도로 둘 다 하려 하면 이 코퍼스에서 반드시 한쪽이 깨진다: 절차 문서의 '방법'(df 8)과
    # 주제어 '스캔'(df 7)이 사실상 같은 빈도라 문턱 하나로는 갈라지지 않는다.
    cutoff = max(1, len(distinct) // share)
    own = {h: {t for t in toks if df[t] <= cutoff} for h, toks in tokens.items()}
    return {key: set(own.get(canon.get(_section_key(h), h), set()))
            for key, h in headings.items()}


def _siblings(a_ident: set, b_ident: set, a_subj: set, b_subj: set) -> bool:
    """Are these two sections about the same thing, and therefore in competition?

    Two ways to be related, because the corpus contains both shapes and neither test alone
    covers them:

    - They share a SUBJECT word — a word few sections in the document carry. One shared
      subject is enough: the same subject written up again under another condition differs
      only by that condition, and everything else in the two titles is identical.
    - They share SEVERAL identity words. Two different subjects documented the same way share
      no subject at all, only process words ("driver", "install", "method"). One such word in
      common means nothing — every section of a procedure manual has one — but a handful means
      the two sections are the same procedure written for different subjects, which is exactly
      the pair the answer must not confuse.

    Measured on one manual: the two conditions of one subject share exactly one word (the
    subject), while two subjects' install sections share five process words and no subject.
    Requiring a subject alone missed the second; requiring several words missed the first.
    """
    return bool(a_subj & b_subj) or len(a_ident & b_ident) >= 2


def _beaten_by_sibling(key, section: dict, subject: dict, scores: dict) -> bool:
    """Does a section about the same subject match this answer better than `key`'s does?

    Siblings are decided by `_siblings`; only the better match of a sibling pair may pass,
    which is the whole point of ranking sections against each other.

    Sections that are not related are not in competition, and that is deliberate: a section
    titled with the document's own subject (a cover or overview page) carries words that appear
    in every answer about that document, so it takes the top score every time. Ranking
    unrelated sections against it left them all below the top and threw the lot away.
    """
    own_ident = section.get(key) or set()
    own_subj = subject.get(key) or set()
    mine = scores.get(key, 0)
    return any(
        score > mine and _siblings(
            own_ident, section.get(other) or set(), own_subj, subject.get(other) or set())
        for other, score in scores.items()
    )


def _image_candidate(img) -> dict:
    """Reduce a retrieval result to the minimum needed to place and render a figure.

    JSON-serializable on purpose: with generation moved to the streaming proxy, this is what
    survives the round trip between the two Lambda invocations. `data` (base64, ~300KB each)
    is carried only on the in-process path; the streaming path replaces it with `url` after
    uploading, because tens of megabytes of image bytes cannot go through the state record.
    """
    uri = ((img.get("location") or {}).get("s3Location") or {}).get("uri") or ""
    doc = uri.split(".pdf")[0] + ".pdf" if ".pdf" in uri else uri
    meta = img.get("metadata") or {}
    page = meta.get("x-amz-bedrock-kb-document-page-number")
    return {
        "doc": doc,
        "page": int(page) if page is not None else None,
        "caption": _figure_caption(img),
        # The page's own headings. A caption describes what is drawn; the heading says which
        # section it belongs to, and that is often the only thing separating two figures that
        # illustrate the same procedure for different subjects.
        "heading": _page_headings(img),
        "scope_key": (meta.get("scope_key") or "").strip(),
        "data": (img.get("content") or {}).get("byteContent") or "",
        "url": "",
    }


def _candidate_url(cand: dict) -> str:
    """Presigned URL for a chosen figure, uploading its bytes only if not already stored."""
    if cand.get("url"):
        return cand["url"]
    return _image_data_to_presigned_url(cand.get("data") or "", cand.get("doc") or "", cand.get("page"))


def _images_in_scope(matched_images: dict, allowed_scopes: set) -> dict:
    """Drop figures belonging to a subject the question did not ask about.

    The answer text is allowed to draw on other documents on purpose: when one subject's
    document omits a procedure, citing another document that covers the same procedure is
    more useful than refusing. A figure cannot be borrowed the same way — its caption carries
    its source document's name, so a figure from another subject reads as a contradiction
    sitting inside the answer.

    Documents with no scope metadata are kept: a corpus that does not use scoping at all must
    not lose every figure. Only explicit mismatches are removed.
    """
    if not allowed_scopes or not matched_images:
        return matched_images
    kept = {}
    for key, cand in matched_images.items():
        scope = (cand.get("scope_key") or "").strip()
        if not scope or scope in allowed_scopes:
            kept[key] = cand
    return kept


def _clean_snippet(text: str) -> str:
    if not text:
        return text
    text = _FIGURE_TYPE_RE.sub("", text)
    text = _FIGURE_TAG_RE.sub("", text)
    # collapse the blank lines/spaces the stripped tags leave behind
    text = re.sub(r"[ \t]*\n[ \t]*\n[ \t]*", "\n\n", text)
    return text.strip()


# ── Answer formatting (display-only, citation-safe) ──────────────────────────
# The default (built-in) RAG prompt is kept so RetrieveAndGenerate still returns citation
# spans, but its output is a run-on. So we reshape the FINAL text (with [n] markers already
# embedded) into readable Markdown by ONLY adding line breaks / "- " / "**" around existing
# text — never removing, reordering, or splitting mid-word — so the [n] markers stay intact.
_TRAILING_MARKERS_RE = re.compile(r"(?:\s*\[\d+\])+\s*$")

# 인용 마커를 읽는 것과 지우는 것은 반드시 같은 것을 가리켜야 한다. 서로 어긋나면 한 마커가
# "인용으로는 안 세지는데 본문에서 지워지지도 않는" 상태가 되고, 그때 두 가지가 동시에
# 무너진다: 그 출처가 인용 목록에서 빠지므로 해당 페이지의 그림이 후보에서 탈락해 정작
# 질문이 가리킨 도면이 사라지고, 마커는 화면에 그대로 노출된다. 그래서 한 곳에서 정의한다.
#
# 모델은 "[6]"으로 쓰라고 지시받지만 실제로는 괄호 안에 말을 덧붙여 "[출처 6 그림 참조]"
# 처럼 쓴다. 덧붙는 말은 '출처'라고 적혀 있을 때만 허용한다 — 숫자로 시작하는 괄호를 무엇이든
# 삼키면 "[35.5 ± 0.55]" 같은 본문이 인용으로 오인돼 지워진다.
_CITATION_RE = re.compile(r"\[출처\s*(\d+)[^\]]*\]|\[(\d+)\]")
_CITATION_STRIP_RE = re.compile(r" *(?:\[출처\s*\d+[^\]]*\]|\[\d+\])")


def _cited_numbers(text: str) -> set:
    """답변이 인용한 출처 번호."""
    return {int(a or b) for a, b in _CITATION_RE.findall(text or "")}


def _strip_citations(text: str) -> str:
    """화면에 나갈 본문에서 인용 마커를 지운다 (_cited_numbers와 같은 것을 지운다)."""
    return _CITATION_STRIP_RE.sub("", text or "")
# "짧은라벨: 값" — a short label (no spaces, <=16 chars) followed by a colon and a value.
_LABEL_RE = re.compile(r"^([^\s:：][^:：\n]{0,15})[:：]\s+(\S.*)$")


def _standalone_comma_list(line: str):
    """Return the items if the line is a short standalone comma list (e.g.
    "Python, JavaScript, AWS"), else None. Rejects comma-heavy sentences, thousands
    separators ("42,000"), and "label: value" fragments so they aren't wrongly split."""
    core = _TRAILING_MARKERS_RE.sub("", line).strip()
    if core.count(",") < 1:
        return None
    if re.search(r"\d\s*,\s*\d", core):   # thousands separator, not a list
        return None
    parts = [p.strip() for p in core.split(",") if p.strip()]
    if len(parts) < 2:
        return None
    if any((":" in p or "：" in p) for p in parts):   # "label: value" fragments
        return None
    if all(len(p) <= 30 and not p.endswith((".", "다", "요", "함", "음")) for p in parts):
        return parts
    return None


def _unwrap_split_emphasis(text: str) -> str:
    """Rejoin a line that ends in the middle of a **…** span with the line after it.

    The model soft-wraps a long label ("**TLHR540. (Red\\n빨간색)**"), and everything below
    works line by line: the wrapped tail becomes its own block, which puts a BLANK line
    inside the emphasis. Markdown only spans emphasis within one paragraph, so the reader
    gets literal asterisks. Markdown treats a soft wrap as a space anyway, so putting the
    space back changes nothing except that the span survives the rebuild.

    Table rows are left alone: they are their own blocks by design, and joining two rows
    would destroy the table.
    """
    out = []
    for line in text.split("\n"):
        joinable = (
            out
            and out[-1].count("**") % 2  # previous line left a ** open
            and line.strip()
            and not line.lstrip().startswith("|")
            and not out[-1].lstrip().startswith("|")
        )
        if joinable:
            out[-1] = f"{out[-1].rstrip()} {line.strip()}"
        else:
            out.append(line)
    return "\n".join(out)


def _format_answer(text: str) -> str:
    if not text:
        return text
    text = _unwrap_split_emphasis(text)
    # The model often GLUES an ATX header to the end of the previous line
    # ("...N/A) ## 2. 텍스트 프롬프트 할당량"), so Markdown renders a literal "##". Force any
    # header that is preceded by text+space onto its own line. (A space between the text and
    # the "#" is required, so "C# " and line-start headers are left untouched.)
    text = re.sub(r"(?<=\S)[ \t]+(#{1,6}[ \t]+)", r"\n\n\1", text)
    blocks = []  # (kind, content); kind in {"li","p","h","raw"}
    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("|"):
            # GFM table row — must stay adjacent to the other rows (no blank line between),
            # so keep it as its own "table" block and join tightly on rebuild.
            blocks.append(("table", line))
            continue
        if line.startswith("#"):
            # already a Markdown ATX header — keep verbatim so it renders as a heading
            blocks.append(("raw", line))
            continue
        m = _LABEL_RE.match(line)
        if m and " " not in m.group(1):
            # bold the label, keep the value (and any trailing [n] markers) as a bullet
            blocks.append(("li", f"**{m.group(1).strip()}**: {m.group(2).strip()}"))
            continue
        items = _standalone_comma_list(line)
        if items:
            for it in items:
                blocks.append(("li", it))
            continue
        blocks.append(("p", line))
    # A short paragraph immediately followed by bullets is a section header -> bold it.
    for i, (kind, content) in enumerate(blocks):
        if kind == "p" and i + 1 < len(blocks) and blocks[i + 1][0] == "li":
            core = _TRAILING_MARKERS_RE.sub("", content).strip()
            if len(core) <= 24 and not core.endswith((".", "다", "요", "다.", "요.")):
                blocks[i] = ("h", content)
    out = []
    prev = None
    for kind, content in blocks:
        if kind == "table":
            # blank line before the FIRST row of a table; consecutive rows stay adjacent
            if out and prev != "table":
                out.append("")
            out.append(content)
        elif kind == "li":
            out.append(f"- {content}")
        elif kind == "h":
            if out:
                out.append("")
            out.append(f"**{_TRAILING_MARKERS_RE.sub('', content).strip()}**")
            out.append("")
        elif kind == "raw":  # a Markdown ATX header line — own paragraph
            if out:
                out.append("")
            out.append(content)
            out.append("")
        else:  # p
            if out:
                out.append("")
            out.append(content)
        prev = kind
    result = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", result).strip()


class BedrockChatRouter:
    """
    Runs Knowledge Base Q&A via Bedrock RetrieveAndGenerate (RAG). The model and the
    generation prompt template are chosen per request, so the UI can switch models
    and apply managed prompts at runtime (unlike a Bedrock Agent, which binds them
    at deploy time).
    """

    def __init__(self, session_id: str, session_attributes: dict, metadata: dict,
                 model_id: str = None, prompt_template: str = None,
                 guardrail_id: str = None, guardrail_version: str = None):
        logger.info('Initializing BedrockChatRouter (RetrieveAndGenerate)')

        self.chat_context_client = ChatContextClient(table_name=table_name, region=region_name)
        self.knowledge_base_id = knowledge_base_id
        self.model_id = model_id or default_model_id
        self.prompt_template = prompt_template
        self.guardrail_id = guardrail_id
        # DRAFT holds the latest edits — no version publishing needed for this lab.
        self.guardrail_version = guardrail_version or "DRAFT"
        self.metadata = metadata or None
        self.session_attributes = session_attributes or None

        if session_id:
            self.session_id = session_id
            try:
                self.chat_context: ChatContext = self.chat_context_client.get(session_id)
            except InvalidSessionId:
                # The UI generates the sessionId and sends it on the first turn, so an
                # id we haven't persisted yet is a brand-new session, not an error.
                logger.info(f'Session Id {session_id} not found; starting a new ChatContext with it')
                self.chat_context = ChatContext(session_id=session_id)
                self.chat_context_client.upsert(self.chat_context)
        else:
            self.chat_context = ChatContext()
            self.session_id = self.chat_context.session_id
            logger.info(f'Persisting new ChatContext with session Id {self.session_id}')
            self.chat_context_client.upsert(self.chat_context)

        bedrock_client = BedrockClient(region_name)
        self.bedrock_agent_runtime_client = bedrock_client.get_bedrock_agent_runtime_client()
        self.bedrock_runtime_client = bedrock_client.get_bedrock_runtime_client()

    def _model_arn(self):
        # Accept a full ARN as-is.
        if self.model_id.startswith("arn:"):
            return self.model_id
        # us./eu./apac./global. prefixed ids are cross-region inference profiles.
        if self.model_id.split(".")[0] in ("us", "eu", "apac", "global"):
            return f"arn:aws:bedrock:{region_name}:{account_id}:inference-profile/{self.model_id}"
        return f"arn:aws:bedrock:{region_name}::foundation-model/{self.model_id}"

    def _build_kb_config(self, vector_search=None):
        kb_config = {
            "knowledgeBaseId": self.knowledge_base_id,
            "modelArn": self._model_arn(),
        }
        kb_config["retrievalConfiguration"] = {
            "vectorSearchConfiguration": vector_search or self._vector_search_config()
        }
        # One question can carry two intents ("대상 B 6층 프린터 정보와 mac 연결 방법"). Retrieval
        # embeds the whole sentence as a single vector, so the two pull against each other and
        # whichever wording is stronger takes the entire numberOfResults budget — the other
        # topic's chunks drop out and the model correctly reports it has no material for them.
        # Decomposition retrieves for each sub-question separately, which also lets the implicit
        # filter apply per sub-question instead of forcing one filter onto both.
        kb_config["orchestrationConfiguration"] = {
            "queryTransformationConfiguration": {"type": "QUERY_DECOMPOSITION"}
        }
        return self._with_generation_config(kb_config)

    def _vector_search_config(self):
        """Retrieval settings, shared so the score lookup searches the same way the answer
        did — scores are keyed by chunk text and would not line up otherwise."""
        # HYBRID search (semantic + keyword) — better recall and higher relevance than the
        # SEMANTIC-only default; supported by the OpenSearch Serverless vector store.
        #
        # numberOfResults=100: cast a wide net to avoid losing relevant chunks, especially
        # with hierarchical chunking where many small child chunks exist. The _rerank step
        # in _resolve_retrieval then filters to RERANK_TOP_N by relevance score, so the
        # answering model sees only the best candidates. This "retrieve broadly, rerank
        # precisely" pattern gives high recall (nothing relevant is missed in the initial
        # fetch) with high precision (noise is removed before generation).
        #
        # A question with two intents shares one budget between them, so whichever intent
        # matches more chunks takes it. Per-intent retrieval (in retrieve_and_generate)
        # mitigates this by giving each intent its own call.
        vector_search = {"overrideSearchType": "HYBRID", "numberOfResults": 100}
        if self.metadata:
            vector_search["filter"] = self.metadata
        # No service-derived filter when the user picked none. There used to be one here,
        # asking the service to infer a filter on the document's subject from the question.
        # Production logs show what it actually did: on nearly every question it produced a
        # filter that matched nothing, and the code fell back to searching unfiltered — so
        # the isolation it was meant to provide never happened, while every question paid for
        # an extra model call. Filter values compare as exact strings, and people name a
        # subject with a short form ("대상 B 4층") that does not equal the stored name
        # ("대상 B"); normalizing whitespace does not close that gap.
        #
        # It was also actively harmful on a follow-up question. "제조사 B 말고 다른건 없음?"
        # names a brand, the service built a filter out of it, retrieval came back empty, and
        # the answer was the service's canned refusal — the earlier turn was unreachable.
        #
        # What replaces it: the page transcription puts the subject's own words in the body
        # chunks, so retrieval can tell documents apart on content rather than on a filter,
        # and the answer prompt asks which subject is meant when the material is ambiguous.
        return vector_search

    def _with_generation_config(self, kb_config):
        # Three cases, which is why this tests for None rather than truthiness:
        #   None — caller expressed no preference: apply our default template.
        #   ""   — caller explicitly asked for no template: let the service use its own.
        #   text — caller picked a template: use it.
        # Any template must carry $output_format_instructions$ or the answer comes back
        # with no sources — that placeholder, not the act of overriding the prompt, is
        # what citations depend on.
        generation_config = {}
        template = DEFAULT_PROMPT_TEMPLATE if self.prompt_template is None else self.prompt_template
        if template:
            generation_config["promptTemplate"] = {"textPromptTemplate": template}
        # Apply a user-selected Bedrock Guardrail to the generation, if any.
        if self.guardrail_id:
            generation_config["guardrailConfiguration"] = {
                "guardrailId": self.guardrail_id,
                "guardrailVersion": self.guardrail_version,
            }
        # "no template and no guardrail" means send no generationConfiguration at all.
        if generation_config:
            kb_config["generationConfiguration"] = generation_config
        return kb_config

    def _generate(self, prompt: str, vector_search):
        """One RetrieveAndGenerate round-trip. Returns the raw response."""
        request = {
            "input": {"text": prompt},
            "retrieveAndGenerateConfiguration": {
                "type": "KNOWLEDGE_BASE",
                "knowledgeBaseConfiguration": self._build_kb_config(vector_search),
            },
        }

        # Continue the RAG-managed session across turns when we have a valid id.
        rag_session_id = self.chat_context.state.get("rag_session_id")
        if rag_session_id:
            request["sessionId"] = rag_session_id

        try:
            response = self._invoke(request)
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            # A stale/invalid RAG session id -> retry once without it.
            if rag_session_id and code in ("ValidationException", "ResourceNotFoundException"):
                logger.info("RAG session id invalid; retrying without session.")
                request.pop("sessionId", None)
                response = self._invoke(request)
            else:
                logger.error(f"RetrieveAndGenerate failed: {e}")
                raise

        # Persist the (possibly new) RAG session id for continuity.
        self.chat_context.state["rag_session_id"] = response.get("sessionId")

        # A model can fail to follow a long instruction set and return nothing usable, at
        # which point the service substitutes its own decline. It happens intermittently and
        # more often on smaller models, so the same question can work once and fail the next
        # time — from the user's side the app simply refuses. Measured on one question:
        # haiku declined 3 of 6 times with the template and 0 of 6 without it; sonnet 0 of 6
        # either way. Retrieval was fine both times, so retry generation without our template
        # rather than lose the answer: a plainer reply beats a refusal.
        #
        # The decline is matched on its text alone. An earlier version also required the
        # citation list to be empty, on the assumption that a refusal cites nothing — it does
        # cite, so that condition never fired and the retry never ran. The text is a fixed
        # English sentence while this app answers in Korean, which is signal enough.
        #
        # Logged, because a silent fallback hides how often the template is being dropped.
        if _is_service_decline(response.get("output", {}).get("text", "")):
            generation = request["retrieveAndGenerateConfiguration"][
                "knowledgeBaseConfiguration"
            ].get("generationConfiguration", {})
            # Only worth retrying if there is a template to drop — without one the retry
            # would be the identical request.
            if generation.pop("promptTemplate", None):
                logger.warning(
                    "Model returned the service decline; retrying without the answer "
                    f"template (model={self.model_id})."
                )
                response = self._invoke(request)
                self.chat_context.state["rag_session_id"] = response.get("sessionId")
        return response

    def retrieve_and_generate(self, prompt: str):
        # Rewrite short follow-up questions using conversation history so they become
        # self-contained. "그럼 대상 B은?" after "대상 A 4층 프린터 알려줘" becomes
        # "대상 B 4층 프린터 정보를 알려줘" — without this, the retrieval has no idea what
        # "대상 B은?" is asking about and returns irrelevant results.
        prompt = self._rewrite_followup(prompt)

        # Searching and deciding whether there is anything to search for do not depend on each
        # other, so they run together. Sequentially, the triage would add its own latency to
        # every real question to save time on the few that are not questions; concurrently, a
        # real question pays nothing — retrieval is the longer of the two — and a greeting
        # skips retrieve-and-generate entirely, which is where the seconds actually go
        # (measured: retrieve ~2-3s, triage ~2s, retrieve-and-generate 7-13s).
        with ThreadPoolExecutor(max_workers=2) as pool:
            triage_task = pool.submit(self._triage, prompt)
            retrieval_task = pool.submit(self._resolve_retrieval, prompt)
            triage = triage_task.result()
            vector_search, scores, retrieved_images, results, retrieve_metadata = retrieval_task.result()

        if triage:
            return {"completion": triage, "references": [], "relatedImages": []}

        plan = self._plan(prompt, results)

        if plan["ambiguous"] and plan["options"]:
            # Answer with the question instead. Deciding this in code rather than asking the
            # answering model to decide it: the same wording made it ask when it should have
            # answered and answer when it should have asked, and no rewrite settled it.
            listed = "\n".join(f"- {o}" for o in plan["options"])
            return {
                "completion": f"자료에 여러 종류가 있어 어느 것인지에 따라 답이 달라집니다. "
                              f"어느 것을 말씀하시나요?\n\n{listed}",
                "references": [],
                "relatedImages": [],
            }

        # If the user explicitly named a subject (e.g. "대상 A") but no document in the
        # KB carries that subject as its scope, searching unfiltered would return chunks from
        # a DIFFERENT subject that happens to discuss similar topics (e.g. printers), and the
        # model would present that material AS IF it belonged to the named subject. Block
        # this: when the planner identified a subject and it does not exist in the index,
        # tell the user the KB has no material for it.
        #
        # Exception: when the question names MULTIPLE subjects (e.g. "대상 A 4층과 대상 B 4층")
        # the planner may join them into one identified_subject string while leaving scope
        # empty (it can only pick one). If ANY of the index's scope values appear inside the
        # identified_subject text, at least one named subject exists — don't block.
        if plan["identified_subject"] and not plan["scope"]:
            scope_keys = {k for k, _ in _scope_values(results)}
            scope_names = {name for _, name in _scope_values(results)}
            subject = plan["identified_subject"]
            # If NO documents in the retrieval results have scope metadata at all, this
            # check is meaningless — it means the KB doesn't use scope tagging, so every
            # identified_subject would be blocked. Skip the check entirely in that case.
            if not scope_keys:
                logger.info(
                    f"No scope metadata in retrieved results; skipping subject check "
                    f"for '{subject}'."
                )
            else:
                # Check if any known scope key or name is mentioned in the identified subject
                has_known_subject = any(
                    k in subject or name in subject
                    for k, name in _scope_values(results)
                )
                if not has_known_subject:
                    logger.info(
                        f"Subject '{subject}' not found in KB scope values; "
                        "returning 'no material' response."
                    )
                    return {
                        "completion": f"'{subject}'에 대한 자료가 지식 베이스에 없습니다. "
                                      f"다른 주제로 질문해 주시거나, 해당 문서를 업로드해 주세요.",
                        "references": [],
                        "relatedImages": [],
                    }

        # Narrow to the subject the question named, when it named one. Now handled per-intent
        # in _generate_with_scope below — the global filter here only applies to retrieved_images.
        if plan["scope"] and not self.metadata:
            retrieved_images = [
                r for r in retrieved_images
                if (r.get("metadata") or {}).get("scope_key") == plan["scope"]
            ]

        # When the subject (scope) changes between turns, the RAG session's history carries
        # the previous subject's retrieved chunks, and the model conflates them with the new
        # retrieval — answering about the old subject while claiming to answer the new one.
        # Reset the RAG session so this turn starts fresh. Follow-up questions on the SAME
        # subject ("거기 5층은?") keep scope unchanged, so the session (and its context)
        # carries over normally.
        prev_scope = self.chat_context.state.get("last_scope", "")
        current_scope = plan["scope"] or ""
        if current_scope and current_scope != prev_scope:
            logger.info(
                f"Scope changed ({prev_scope!r} -> {current_scope!r}); "
                "resetting RAG session to avoid cross-subject contamination."
            )
            self.chat_context.state.pop("rag_session_id", None)
        self.chat_context.state["last_scope"] = current_scope

        # One call per intent, each with the full result budget to itself. Sharing one budget
        # is what loses an intent: retrieval embeds the whole sentence at once, so whichever
        # intent matches more chunks takes the room, and a document that repeats a structure
        # (a section per floor, per product, per month) supplies plenty of those. Measured on
        # a two-part question, the second half was absent from 5 of 5 answers.
        #
        # Per-intent scope filtering: when _plan returns intent_scopes, each intent gets its
        # own scope filter so documents from different subjects don't compete for the budget.
        # Parallel execution: each intent is independent, so run them concurrently.
        def _generate_with_scope(intent, intent_scope):
            vs = vector_search
            if intent_scope and not self.metadata:
                vs = {**vector_search, "filter": {"equals": {"key": "scope_key", "value": intent_scope}}}
            return self._generate(intent, vs)

        intent_scopes = plan.get("intent_scopes", [])
        if len(plan["intents"]) > 1:
            with ThreadPoolExecutor(max_workers=MAX_INTENTS) as pool:
                futures = [
                    pool.submit(_generate_with_scope, intent, intent_scopes[i] if i < len(intent_scopes) else "")
                    for i, intent in enumerate(plan["intents"])
                ]
                responses = [f.result() for f in futures]
        else:
            scope_for_intent = intent_scopes[0] if intent_scopes else ""
            responses = [_generate_with_scope(plan["intents"][0], scope_for_intent)]

        # scores came from the probe in _resolve_retrieval — same query, same settings.

        # Build a de-duplicated, numbered reference list and insert [n] citation markers
        # into the answer at each cited span, so the UI can show inline [1][2] tied to a
        # matching numbered source list. RetrieveAndGenerate returns, per citation, the text
        # span it supports plus the retrieved references backing that span.
        key_to_num = {}
        references = []
        # With MULTIMODAL parsing a citation can be an extracted figure rather than text.
        # Those arrive as a base64 data URI in byteContent, roughly 0.5 MB each, so the
        # total is capped: a handful would otherwise push the response past API Gateway's
        # limit and stall the browser. Over budget we keep the reference and drop the image.
        image_budget = [10 * 1024 * 1024]

        def _ref_number(ref):
            loc = ref.get("location", {})
            uri = loc.get("s3Location", {}).get("uri") or ""
            content_obj = ref.get("content", {}) or {}
            content_type = content_obj.get("type") or "TEXT"
            raw_content = content_obj.get("text") or ""
            content = _clean_snippet(raw_content)
            metadata = ref.get("metadata", {}) or {}
            # RetrieveAndGenerate often omits user-defined metadata for TEXT citations.
            # Enrich from the parallel Retrieve call's results, matched by chunk text.
            if not metadata or all(k.startswith("x-amz") for k in metadata):
                enriched = retrieve_metadata.get(raw_content.strip(), {})
                if enriched:
                    metadata = {**enriched, **metadata}
            # De-dupe by uri+page so the same doc cited on different pages stays distinct.
            # Content type is part of the key too: one page can be cited both as text and
            # as a figure, and collapsing those would silently discard one of them.
            page = metadata.get("x-amz-bedrock-kb-document-page-number")
            # Page metadata only exists for formats the parser paginates (PDF and the
            # like). A plain-text source has none, so every one of its chunks would share
            # one key and the panel would show a single entry for the whole file. When an
            # extraction sidecar is present it marks each page as "[pN]" at the top of the
            # section, 1-based; page metadata elsewhere is 0-based, so align to that.
            # Chunk boundaries do not have to follow page boundaries, so the key still
            # needs the content to keep two chunks of one page apart.
            fingerprint = ""
            if page is None:
                marker = re.search(r"\[p(\d+)\]", raw_content)
                if marker:
                    page = int(marker.group(1)) - 1
                fingerprint = f"#{raw_content.strip()}"
            key = (
                f"{uri}#{page}#{content_type}{fingerprint}"
                if uri
                else json.dumps(metadata, sort_keys=True, ensure_ascii=False) + content_type
            )
            if key not in key_to_num:
                image = None
                if content_type == "IMAGE":
                    data = content_obj.get("byteContent") or ""
                    if data:
                        # Convert to presigned URL instead of inline base64
                        image = _image_data_to_presigned_url(data, uri, page)
                key_to_num[key] = len(references) + 1
                references.append({
                    "number": key_to_num[key],
                    "name": uri.split("/")[-1] if uri else "문서",
                    "uri": uri,
                    "page": int(page) + 1 if page is not None else None,
                    "score": scores.get(raw_content.strip()),
                    "content": content,
                    "type": content_type,
                    "image": image,
                    "metadata": metadata,
                    "location": loc,
                })
            return key_to_num[key]

        # Build the numbered reference list for the 근거문서 (Citation) panel, but DO NOT
        # insert inline [1][2][3] markers into the answer text — the user wants a clean answer.
        # Across every response when the question was split: the de-dup key already collapses
        # a chunk two intents both cited, so the panel reads as one list.
        for response in responses:
            for citation in response.get("citations", []):
                for ref in citation.get("retrievedReferences", []):
                    _ref_number(ref)

        # Show images from the initial Retrieve that scored above the reranking threshold
        # AND belong to the same document as a text citation. This ensures relevance
        # (same document = same topic) without needing page-level filtering.
        cited = {r["image"] for r in references if r.get("image")}
        related = []

        # Get URIs of documents cited in the answer (text or image)
        cited_uris = set()
        for ref in references:
            uri = ref.get("uri") or ""
            if uri and ".pdf" in uri:
                pdf_uri = uri.split(".pdf")[0] + ".pdf"
                cited_uris.add(pdf_uri)

        # Collect images from the initial Retrieve that are from cited documents
        # These already passed the RERANK_MIN_SCORE threshold in _resolve_retrieval
        if cited_uris:
            seen_uri_pages = set()
            # Mark citation images as seen to avoid duplicates
            for r in references:
                if r.get("image") and r.get("uri") and r.get("page"):
                    pdf_uri = r["uri"].split(".pdf")[0] + ".pdf" if ".pdf" in r["uri"] else r["uri"]
                    seen_uri_pages.add((pdf_uri, r["page"]))

            # retrieved_images from _resolve_retrieval — already filtered by score
            for result in retrieved_images:
                if len(related) >= RELATED_IMAGE_LIMIT:
                    break
                content = result.get("content") or {}
                if content.get("type") != "IMAGE":
                    continue
                data = content.get("byteContent") or ""
                if not data:
                    continue

                uri = (result.get("location", {}).get("s3Location", {}) or {}).get("uri") or ""
                pdf_uri = uri.split(".pdf")[0] + ".pdf" if ".pdf" in uri else uri

                # Only images from cited documents
                if pdf_uri not in cited_uris:
                    continue

                meta = result.get("metadata") or {}
                page = meta.get("x-amz-bedrock-kb-document-page-number")
                if page is None:
                    text = content.get("text") or ""
                    marker = re.search(r"\[p(\d+)\]", text)
                    page = int(marker.group(1)) - 1 if marker else None
                else:
                    page = int(page)

                page_1based = int(page) + 1 if page is not None else None

                # Dedup by (document, page)
                dedup_key = (pdf_uri, page_1based)
                if dedup_key in seen_uri_pages:
                    continue
                seen_uri_pages.add(dedup_key)

                image_url = _image_data_to_presigned_url(data, uri, page)
                related.append({
                    "name": uri.split("/")[-1] if uri else "문서",
                    "uri": uri,
                    "page": page_1based,
                    "score": result.get("score"),
                    "image": image_url,
                })

            # Sort by page order
            related.sort(key=lambda r: r.get("page") or 999)

        logger.info(
            f"Image pipeline: citations_with_image={len(cited)}, "
            f"cited_uris={len(cited_uris)}, "
            f"related_final={len(related)}"
        )

        # Reshape the answer into readable Markdown (headings / bullets). No inline markers.
        # A split question produces one answer per intent; joined in the order they were
        # asked so the reply follows the question.
        text = "\n\n".join(
            _format_answer(r.get("output", {}).get("text", "")) for r in responses
        ).strip()

        return {"completion": text, "references": references, "relatedImages": related}

    def _rewrite_followup(self, prompt: str) -> str:
        """Expand a short follow-up question into a self-contained one using chat history.

        Short questions like "그럼 대상 B은?", "거기 5층은?", "다른건?" rely on context from
        the previous turn. Without expansion, retrieval and planning see only the short text
        and cannot determine what the user is asking about. This rewrites the prompt into a
        complete question that includes the necessary context.

        Only triggers when: prompt is short AND there is at least one previous human turn.
        """
        # Don't rewrite if the question is already long enough to be self-contained,
        # or if there's no history to draw context from.
        if len(prompt) > 60 or not self.chat_context.history:
            return prompt

        # Read back over several turns, not just the previous question.
        #
        # The subject is often named once and then carried implicitly, and the turns in
        # between are themselves elliptical: "대상 A …목록" → "그럼 13층은?" → "윈도우야".
        # History stores what the user actually typed, so the immediately previous turn has
        # no subject in it either — looking only there loses the building entirely, and the
        # question then matches three different buildings' manuals at once.
        # Assistant turns are included because they usually restate the subject outright.
        recent = self.chat_context.history[-_REWRITE_HISTORY_TURNS:]
        if not any(h.get("type") == "human" for h in recent):
            return prompt
        transcript = "\n".join(
            f"{'사용자' if h.get('type') == 'human' else '어시스턴트'}: "
            f"{(h.get('text') or '')[:_REWRITE_TURN_CHARS]}"
            for h in recent
        )

        instruction = (
            "아래 대화를 보고, 마지막 후속 질문을 독립적으로 이해 가능한 "
            "완전한 문장으로 다시 작성하세요.\n\n"
            f"[이전 대화]\n{transcript}\n\n"
            f"[현재 후속 질문]\n{prompt}\n\n"
            "[규칙]\n"
            "1. 대화에서 확인된 대상과 조건(위치, 이름, 날짜, 수량, 버전 등)을 반드시 유지하세요.\n"
            "   대상이 여러 턴 앞에서 한 번만 언급되었더라도 그대로 이어서 씁니다 — 빠뜨리면\n"
            "   질문이 여러 대상에 동시에 해당하게 되어 엉뚱한 자료를 찾게 됩니다.\n"
            "2. 후속 질문이 대상만 바꾼 경우(예: '그럼 B는?') → 이전 질문에서 대상만 교체하고\n"
            "   나머지 조건과 묻는 내용은 그대로 두세요.\n"
            "3. 후속 질문이 조건 하나만 바꾼 경우(예: '두 번째 것은?') → 그 조건만 교체하세요.\n"
            "4. 원래 질문이 이미 완전하면 그대로 출력하세요.\n\n"
            "완전한 질문만 출력하세요. 설명 금지."
        )
        try:
            resp = self.bedrock_runtime_client.converse(
                modelId=self.model_id,
                messages=[{"role": "user", "content": [{"text": instruction}]}],
                inferenceConfig={"maxTokens": 150, "temperature": 0},
            )
            rewritten = resp["output"]["message"]["content"][0]["text"].strip()
            if rewritten and rewritten != prompt:
                logger.info(f"Query rewritten: {prompt!r} -> {rewritten!r}")
                return rewritten
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Query rewrite failed, using original: {e}")
        return prompt

    def _triage(self, prompt: str) -> str:
        """Reply text for an input the documents cannot answer, or "" to search as usual.

        A greeting, a thank-you or abuse still costs a knowledge-base search and a full
        retrieve-and-generate today — around 17 seconds to answer "안녕", and the answer picks
        up whichever document happened to rank as if it were the subject.

        Deliberately biased towards searching: anything that could be a question about the
        material returns "", because a slow answer is a far smaller failure than refusing to
        look something up. The reply is produced here too, so a non-question costs one call
        rather than two.
        """
        instruction = (
            "다음 사용자 입력이 문서에서 찾아 답할 내용을 요구하는지 판단하세요.\n\n"
            f"[입력]\n{prompt}\n\n"
            "다음 JSON만 출력하세요. 설명 금지.\n"
            '{"needs_documents": true, "reply": ""}\n\n'
            "- needs_documents: 무엇인가를 묻거나 찾아달라는 요청이면 true입니다. 짧거나 "
            "불완전해도, 오타가 있어도, 명사만 있어도 질문일 수 있으면 true입니다. "
            "인사·감사·잡담·욕설처럼 문서와 무관한 말에만 false입니다. 애매하면 true입니다.\n"
            "- reply: needs_documents가 false일 때만, 한국어로 한두 문장의 응답을 씁니다. "
            "인사에는 인사로 답하고 무엇을 도와줄지 묻습니다. 무례한 말에는 정중하게 선을 긋고 "
            "질문을 요청합니다. 문서 내용을 지어내지 마세요. true면 빈 문자열입니다."
        )
        try:
            resp = self.bedrock_runtime_client.converse(
                modelId=self.model_id,
                messages=[{"role": "user", "content": [{"text": instruction}]}],
                inferenceConfig={"maxTokens": 200, "temperature": 0},
            )
            raw = resp["output"]["message"]["content"][0]["text"]
            parsed = json.loads(re.search(r"\{.*\}", raw, re.DOTALL).group(0))
        except Exception as e:  # noqa: BLE001 - on any doubt, search
            logger.warning(f"Triage failed, treating as a question: {e}")
            return ""
        if parsed.get("needs_documents") is False:
            reply = str(parsed.get("reply") or "").strip()
            if reply:
                logger.info("Triage: not a documents question; answered without retrieval.")
                return reply
        return ""

    def _plan(self, prompt: str, results) -> dict:
        """Decide how many things the question asks for, and whether it says which one.

        Both decisions used to live in the answer prompt, where they were unreliable in
        opposite directions at once: tightening the wording made it ask for clarification on
        questions that named their subject, loosening it made it answer half of a two-part
        question. Deciding here is deterministic, and the answering model is left to answer.

        Returns {"intents": [...], "scope": str, "ambiguous": bool, "options": [...]}.
        `intents` always holds at least the original question, so a failure here is the
        previous behaviour.
        """
        fallback = {"intents": [prompt], "scope": "", "identified_subject": "", "ambiguous": False, "options": []}
        digest = _material_digest(results)
        if not digest:
            return fallback

        scopes = _scope_values(results)
        scope_block = ""
        if len(scopes) > 1:
            listed = "\n".join(f'- "{k}"  ({name})' for k, name in scopes)
            scope_block = (
                f"\n[자료에 들어 있는 대상]\n{listed}\n"
                '\n- scope: 질문이 위 대상 중 하나를 가리키면 따옴표 안의 값을 한 글자도 바꾸지 말고 '
                "그대로 넣습니다. 가리키지 않거나 확실하지 않으면 빈 문자열입니다.\n"
            )

        instruction = (
            "당신은 검색 질의를 준비합니다. 답하지 마세요.\n\n"
            f"[질문]\n{prompt}\n\n"
            f"[검색된 자료의 요약]\n{digest}\n"
            f"{scope_block}\n"
            "다음 JSON만 출력하세요. 설명 금지.\n"
            '{"intents": ["..."], "intent_scopes": ["..."], "scope": "", "identified_subject": "", "ambiguous": false, "options": ["..."]}\n\n'
            "- intents: 질문이 서로 다른 자료를 찾아야 하는 요구를 둘 이상 담고 있으면 각각을 "
            "독립적으로 검색 가능한 문장으로 나눕니다. 하나뿐이면 질문을 그대로 하나만 넣습니다. "
            "억지로 쪼개지 마세요.\n"
            "- intent_scopes: intents와 같은 길이의 배열입니다. 각 intent가 위 [자료에 들어 있는 대상] 중 "
            "하나를 가리키면 따옴표 안의 값을 그대로 넣고, 가리키지 않으면 빈 문자열입니다.\n"
            "- identified_subject: 질문이 특정 장소·건물·제품·서비스 등 고유한 대상을 명시적으로 "
            "지칭하면 그 대상의 이름을 그대로 씁니다. 대상을 지칭하지 않으면 빈 문자열입니다.\n"
            "- ambiguous: 질문이 방법·절차를 묻는데 자료에 그 절차가 종류마다 다르게 여러 개 있고 "
            "질문이 어느 것인지 말하지 않았을 때만 true입니다. 단, 질문이 이미 구체적 조건을 "
            "명시했고 그 조건으로 자료에서 대상을 특정할 수 있으면 false입니다. "
            "그 외에는 false입니다.\n"
            "- options: ambiguous가 true일 때만, 자료에 실제로 등장하는 종류의 이름을 넣습니다. "
            "지어내지 마세요. false면 빈 배열입니다."
        )
        try:
            resp = self.bedrock_runtime_client.converse(
                modelId=self.model_id,
                messages=[{"role": "user", "content": [{"text": instruction}]}],
                inferenceConfig={"maxTokens": 400, "temperature": 0},
            )
            raw = resp["output"]["message"]["content"][0]["text"]
            parsed = json.loads(re.search(r"\{.*\}", raw, re.DOTALL).group(0))
        except Exception as e:  # noqa: BLE001 - planning is best-effort; answer either way
            logger.warning(f"Question planning failed, answering as one question: {e}")
            return fallback

        intents = [str(i).strip() for i in (parsed.get("intents") or []) if str(i).strip()]
        options = [str(o).strip() for o in (parsed.get("options") or []) if str(o).strip()]
        identified_subject = str(parsed.get("identified_subject") or "").strip()
        # Cap the split. Every intent costs a full generate call, and a question that really
        # asks for more than a handful of separate things is better served by answering the
        # whole of it once than by fanning out.
        if not intents or len(intents) > MAX_INTENTS:
            intents = [prompt]
        ambiguous = bool(parsed.get("ambiguous")) and len(intents) == 1
        # Only a value that exists in the index. Anything else would filter to nothing, and
        # "no results" reads to the user as "the documents do not cover this".
        scope = str(parsed.get("scope") or "").strip()
        if scope not in {k for k, _ in scopes}:
            scope = ""
        # Per-intent scopes: validate each against the index, default to "" if invalid.
        raw_intent_scopes = parsed.get("intent_scopes") or []
        valid_scope_keys = {k for k, _ in scopes}
        intent_scopes = []
        for i, s in enumerate(raw_intent_scopes):
            s = str(s or "").strip()
            intent_scopes.append(s if s in valid_scope_keys else "")
        # Pad or trim to match intents length
        while len(intent_scopes) < len(intents):
            intent_scopes.append(scope)  # fallback to the global scope
        intent_scopes = intent_scopes[:len(intents)]

        if len(intents) > 1 or ambiguous or scope or identified_subject:
            logger.info(
                f"Question plan: intents={intents} scope={scope!r} "
                f"intent_scopes={intent_scopes} "
                f"identified_subject={identified_subject!r} "
                f"ambiguous={ambiguous} options={options}"
            )
        return {"intents": intents, "scope": scope, "intent_scopes": intent_scopes,
                "identified_subject": identified_subject,
                "ambiguous": ambiguous, "options": options}

    def _invoke(self, request):
        logger.info("Calling retrieve_and_generate")
        return self.bedrock_agent_runtime_client.retrieve_and_generate(**request)

    def _resolve_retrieval(self, prompt: str):
        """Decide how to retrieve for this question, and collect per-chunk scores.

        Returns (vectorSearchConfiguration, {chunk_text: score}, figures, all results).

        RetrieveAndGenerate omits per-reference scores and returns only the figures the
        answer quoted, so the UI needs a separate Retrieve either way. Running it with the
        same settings the answer will use means both come from one ranking.
        """
        config = self._vector_search_config()
        results = self._retrieve(prompt, config)

        # --- Reranking ---
        # With hierarchical chunking and numberOfResults=100 we get many candidates.
        # Rerank by relevance score: drop anything below the minimum threshold, then
        # keep only the top RERANK_TOP_N. This sharpens precision without losing recall
        # from the broad initial retrieval.
        results = self._rerank(results)

        scores = {}
        retrieve_metadata = {}
        for r in results:
            text = ((r.get("content", {}) or {}).get("text") or "").strip()
            if text:
                if r.get("score") is not None:
                    scores[text] = r["score"]
                # Retrieve API returns full user-defined metadata per chunk;
                # RetrieveAndGenerate often omits it for TEXT citations. Build a
                # lookup so _ref_number can enrich TEXT citations that lack metadata.
                meta = r.get("metadata", {}) or {}
                if meta:
                    retrieve_metadata[text] = meta

        # Figures that retrieval ranked for this question but the answer did not cite.
        # A generated answer is text, so it cites the pages it quoted — usually one figure at
        # most, even when the question is literally asking to be shown something. Retrieval
        # ranks the rest just as highly and already carries their bytes, so keep them: for a
        # document whose substance is drawings, the picture next to the cited one is often
        # the one the reader wanted.
        images = [r for r in results if (r.get("content") or {}).get("type") == "IMAGE"]
        return config, scores, images, results, retrieve_metadata

    def _rerank(self, results: list) -> list:
        """Score-based reranking: filter low-relevance chunks and keep the top N.

        Bedrock Retrieve returns results sorted by relevance score descending.
        With hierarchical chunking the child chunks are small (300 tokens), so many can
        match loosely. Filtering by a score floor removes noise, and capping at RERANK_TOP_N
        bounds what downstream (planner, answer generation) has to process.

        IMAGE results are also filtered by score — a higher threshold (0.4) ensures only
        images semantically close to the question are shown.
        """
        images = [r for r in results if (r.get("content") or {}).get("type") == "IMAGE"]
        text_results = [r for r in results if (r.get("content") or {}).get("type") != "IMAGE"]

        # Filter by minimum score threshold
        scored = [r for r in text_results if (r.get("score") or 0) >= RERANK_MIN_SCORE]

        # Results are already sorted by score descending from Bedrock, but ensure order
        scored.sort(key=lambda r: r.get("score", 0), reverse=True)

        # Keep top N
        top_results = scored[:RERANK_TOP_N]

        # IMAGE results: keep all — filtering is done later by _match_images_to_text
        # which only keeps images from pages that have matching TEXT results.
        # Applying a score threshold here would drop relevant images since IMAGE
        # embeddings score lower than text on the same query.

        logger.info(
            f"Reranking: {len(text_results)} text → {len(top_results)} kept; "
            f"{len(images)} images kept (filtered by page matching later)"
        )

        return top_results + images

    def _retrieve(self, prompt: str, vector_search):
        """Best-effort Retrieve — a failure here must not cost the user their answer."""
        try:
            resp = self.bedrock_agent_runtime_client.retrieve(
                knowledgeBaseId=self.knowledge_base_id,
                retrievalQuery={"text": prompt},
                # Same settings as the answer's own retrieval, including the result count:
                # the scores this collects are matched to chunks by text, so a different
                # count would leave some of the answer's references without a score, and the
                # figures collected here would not be the ones the answer saw.
                retrievalConfiguration={"vectorSearchConfiguration": vector_search},
            )
            return resp.get("retrievalResults", [])
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Retrieve failed: {e}")
            return []

    def _fetch_document_images(self, cited_uris: list, cited_pages: set,
                               existing_images: list, prompt: str) -> list:
        """Fetch additional IMAGE results related to the answer.

        Uses the user's original prompt to Retrieve IMAGE-type results, then keeps only
        those whose relevance score is above the reranking threshold (RERANK_MIN_SCORE).
        This ensures only images semantically relevant to the question are shown — not
        just any image from the cited document.

        Returns only IMAGE-type results not already present in existing_images.
        """
        existing_data = {
            (r.get("content") or {}).get("byteContent") or ""
            for r in existing_images
        }
        supplemental = []

        query = prompt
        if not query:
            return supplemental

        try:
            resp = self.bedrock_agent_runtime_client.retrieve(
                knowledgeBaseId=self.knowledge_base_id,
                retrievalQuery={"text": query},
                retrievalConfiguration={
                    "vectorSearchConfiguration": {
                        "overrideSearchType": "HYBRID",
                        "numberOfResults": 100,
                    }
                },
            )
            results = resp.get("retrievalResults", [])
            images_found = 0
            for r in results:
                content = r.get("content") or {}
                if content.get("type") != "IMAGE":
                    continue

                # Dynamic relevance filter: only keep images with score above threshold
                score = r.get("score", 0)
                if score < RERANK_MIN_SCORE:
                    continue

                # Prefer images from cited documents, but don't strictly require it
                result_uri = (
                    (r.get("location", {}).get("s3Location", {}) or {}).get("uri")
                    or ""
                )
                # Boost priority: images from cited URIs come first (handled by caller's sort)

                images_found += 1
                data = content.get("byteContent") or ""
                if not data or data in existing_data:
                    continue
                existing_data.add(data)
                supplemental.append(r)

            logger.info(
                f"Supplemental image fetch: query='{query[:50]}...', "
                f"{images_found} IMAGE results above score threshold ({RERANK_MIN_SCORE}), "
                f"{len(supplemental)} new after dedup"
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Supplemental image fetch failed: {e}")

        return supplemental

    def __get_size_in_kb(self, obj):
        return len(json.dumps(obj).encode('utf-8')) / 1024

    # ── Custom RAG: Retrieve + Converse ──────────────────────────────────────

    def _match_images_to_text(self, text_results, image_results):
        """문서 URI + 페이지 번호 기준으로 IMAGE를 TEXT 청크에 매칭.

        키는 반드시 (문서URI, 페이지)여야 한다. 페이지 번호만으로 키를 잡으면
        "대상 A p.3"과 "대상 B p.3"이 같은 칸에 들어가 서로 다른 문서의 이미지가
        섞인다 — 이게 엉뚱한 이미지가 붙는 근본 원인이었다.

        Returns:
            {(pdf_uri, page_0based): candidate}  — (문서, 페이지)당 대표 이미지 1장.
            candidate는 _image_candidate가 만든 직렬화 가능한 최소 표현이다.
        """
        # IMAGE를 (문서URI, page)로 인덱싱
        image_index = {}  # {(pdf_uri, page): [image_result, ...]}

        for img in image_results:
            meta = img.get("metadata") or {}
            uri = (img.get("location", {}).get("s3Location", {}) or {}).get("uri") or ""
            pdf_uri = uri.split(".pdf")[0] + ".pdf" if ".pdf" in uri else uri
            page = meta.get("x-amz-bedrock-kb-document-page-number")
            if page is None:
                text = (img.get("content") or {}).get("text") or ""
                marker = re.search(r"\[p(\d+)\]", text)
                page = int(marker.group(1)) - 1 if marker else None
            if page is not None:
                page = int(page)
                image_index.setdefault((pdf_uri, page), []).append(img)

        # TEXT 청크에서 (문서URI, page) 추출
        text_doc_pages = set()
        for r in text_results:
            uri = (r.get("location", {}).get("s3Location", {}) or {}).get("uri") or ""
            pdf_uri = uri.split(".pdf")[0] + ".pdf" if ".pdf" in uri else uri
            content_text = (r.get("content") or {}).get("text") or ""
            for m in re.finditer(r"\[p(\d+)\]", content_text):
                text_doc_pages.add((pdf_uri, int(m.group(1)) - 1))
            meta = r.get("metadata") or {}
            p = meta.get("x-amz-bedrock-kb-document-page-number")
            if p is not None:
                text_doc_pages.add((pdf_uri, int(p)))

        # TEXT와 같은 (문서, 페이지)의 이미지만 유지 — (문서, 페이지)당 1장.
        # 무엇을 담았는지 알 수 없는(캡션 없는) 이미지는 판단 근거가 없으므로 버린다.
        matched = {}
        skipped_unknown = 0
        for key, imgs in image_index.items():
            if key not in text_doc_pages:
                continue
            for img in imgs:
                cand = _image_candidate(img)
                if not cand["caption"].strip():
                    skipped_unknown += 1
                    continue
                # 절은 인제스트가 적어 둔 맵에서 조회한다. 파서가 그림 설명에 헤딩을 남기지
                # 않은 페이지(실제로 있었다 — 대상 A p.14)도 이 경로로는 절을 갖는다.
                mapped = _section_of(key[0], key[1])
                if mapped:
                    cand["heading"] = mapped
                matched[key] = cand
                break

        logger.info(
            f"Image-text matching: {len(image_results)} images, "
            f"{len(text_doc_pages)} (doc,page) pairs in text, "
            f"{skipped_unknown} without a caption skipped, "
            f"{len(matched)} (doc,page) pairs with matched images"
        )
        return matched

    def _build_converse_messages(self, prompt, text_results, matched_images):
        """Converse API용 system prompt + messages 조립."""
        # 검색 결과를 번호 매겨 컨텍스트로 구성
        context_blocks = []
        for i, r in enumerate(text_results[:_CONTEXT_CHUNKS], 1):
            text = (r.get("content") or {}).get("text") or ""
            meta = r.get("metadata") or {}
            uri = (r.get("location", {}).get("s3Location", {}) or {}).get("uri") or ""
            title = meta.get("source_title") or (uri.split("/")[-1] if uri else "문서")
            page = meta.get("x-amz-bedrock-kb-document-page-number")
            page_info = f", p.{int(page)+1}" if page is not None else ""
            context_blocks.append(f"[출처 {i}] ({title}{page_info})\n{text}")

        # 그림 설명을 컨텍스트에 넣는다. 어디에 끼울지는 코드가 정하지만(_parse_image_markers),
        # 그림이 '무엇을 보여주는지'는 답변 근거가 된다.
        #
        # 표의 음영, 번호의 색깔처럼 서식으로만 표현된 정보는 마크다운 추출에서 사라진다.
        # 그런 항목은 본문에 "규칙"만 남고 "어떤 항목이 그 규칙에 해당하는지"는 그림에만
        # 남는데, 파서는 그것을 캡션에 적어 둔다. 캡션을 빼면 모델은 규칙만 보고 해당 여부를
        # 지어내게 된다.
        #
        # 출처 번호는 붙이지 않는다 — [N] 인용은 텍스트 청크에만 매겨지고, 여기에 번호를
        # 주면 인용 번호와 어긋난다.
        figure_blocks = []
        for (doc, page), cand in (matched_images or {}).items():
            caption = (cand.get("caption") or "").strip()
            if caption:
                name = doc.split("/")[-1] if doc else "문서"
                figure_blocks.append(f"({name}, p.{page + 1}) {caption}")
        image_instruction = (
            "\n\n[그림 설명]\n"
            "아래는 위 자료에 실린 그림을 글로 옮긴 것입니다. 색·음영·강조처럼 표에서는 사라진\n"
            "정보가 여기에 남아 있을 수 있습니다.\n"
            + "\n".join(f"- {b}" for b in figure_blocks)
        ) if figure_blocks else ""

        # 기본 답변 지침 (기존 answer_instructions.txt 활용)
        system_prompt = (
            "당신은 사내 지식 베이스의 문서를 근거로 답변하는 한국어 Q&A 어시스턴트입니다.\n\n"
            "[검색된 참고 자료]\n" + "\n\n".join(context_blocks)
            + image_instruction + "\n\n"
            f"{_INSTRUCTIONS}\n\n"
            "[인용 규칙]\n"
            "답변에서 특정 출처의 정보를 사용할 때 문장 끝에 [N] 형식으로 출처 번호를 표시하세요. "
            "반드시 [1], [2] 형식을 사용하세요. [출처 1] 형식은 사용하지 마세요.\n"
            "출처 번호는 위 [출처 N]의 N과 일치해야 합니다."
        )

        # 사용자 커스텀 프롬프트가 있으면 system에 병합
        if self.prompt_template:
            system_prompt = self.prompt_template + "\n\n" + system_prompt

        # 히스토리 → Converse format (최근 10턴)
        messages = []
        for h in self.chat_context.history[-10:]:
            role = "user" if h["type"] == "human" else "assistant"
            messages.append({"role": role, "content": [{"text": h["text"]}]})

        # 현재 질문
        messages.append({"role": "user", "content": [{"text": prompt}]})

        return system_prompt, messages

    def _converse_generate(self, system_prompt, messages):
        """bedrock_runtime_client.converse() 호출."""
        params = {
            "modelId": self.model_id,
            "system": [{"text": system_prompt}],
            "messages": messages,
            "inferenceConfig": {"maxTokens": 4096, "temperature": 0.1},
        }

        if self.guardrail_id:
            params["guardrailConfig"] = {
                "guardrailIdentifier": self.guardrail_id,
                "guardrailVersion": self.guardrail_version,
                "trace": "disabled",
            }

        response = self.bedrock_runtime_client.converse(**params)
        return response["output"]["message"]["content"][0]["text"]

    def _parse_image_markers(self, answer_text, matched_images, corpus=None, sections=None,
                             section_list=(), page_texts=None):
        """답변의 마크다운 블록마다 (문서, 페이지) 키워드를 매칭해 이미지를 삽입.

        - 테이블/리스트 등 마크다운 블록은 분할하지 않는다.
        - 각 text 블록 끝에 빈 줄을 붙인다. 소비자(스트리밍 프록시)가 세그먼트를
          그대로 이어 붙이기 때문에, 구분자가 없으면 "…있습니다.| 층 |"처럼 붙어서
          테이블이 문장으로 렌더링된다.
        - matched_images는 호출 전에 '답변이 실제로 인용한 (문서, 페이지)'로 좁혀져 있다.
        - 붙일지 말지는 이미지의 <figure> 캡션과 블록이 '이 코퍼스에서 변별력 있는' 토큰을
          공유하는지로만 판단한다. 변별력은 corpus에서 측정한다 — 어떤 단어가 흔한지는
          문서 집합마다 다르므로 코드에 적어둘 수 없다.
        - 근거가 없으면 붙이지 않는다. 틀린 그림보다 없는 편이 낫다.
        - 각 이미지 세그먼트에 본문 내 문자 오프셋 `at`을 함께 낸다. 스트리밍 경로에서는
          클라이언트가 본문을 다 받은 뒤에야 이미지 이벤트를 받으므로, 도착 시점으로는
          위치를 잴 수 없다. 서버가 정한 위치를 그대로 실어 보내야 한다.
        """
        blocks = self._split_into_blocks(answer_text)
        if not blocks:
            return [{"type": "text", "text": answer_text}]
        if not matched_images:
            return [{"type": "text", "text": "\n\n".join(blocks)}]

        generic = _generic_tokens(corpus or [])

        # 어느 블록에 놓일지는 '그림이 무엇을 그렸는가'(캡션)로만 잰다. 절 이름을 점수에 넣으면
        # 주제를 스치듯 언급한 블록이 그림을 끌어온다 — "제조사 A 또는 제조사 D 복합기를 이용하세요"
        # 라는 주의 문구 하나 때문에 제조사 D 절 그림이 거기 붙는 일이 실제로 있었다.
        # 절 이름은 자격(section)에서만 쓴다.
        identity = _identifying_tokens(
            {key: (cand.get("caption") or "") for key, cand in matched_images.items()},
            generic,
        )

        # 절 자격은 답변 전체로 판단한다. 절차의 뒷 단계 블록은 제조사·모델명을 다시 쓰지
        # 않으므로("사용권 계약 화면에서 동의 클릭"), 블록마다 절 이름을 요구하면 그 단계의
        # 그림이 통째로 빠진다. 지나가는 한마디로 엉뚱한 절이 딸려오는 문제는 아래 채점이
        # 캡션 내용만 보기 때문에 따로 막힌다.
        # 절 자격은 이번 질의가 검색한 그림 전체(sections)를 놓고 잰다. 인용 필터를 거친
        # 후보만 비교하면, 남은 것이 모두 한 절일 때 비교 대상이 없어져 자격 검사가 스스로
        # 꺼진다 — _section_identity 참고.
        pool = sections or matched_images
        section = _section_identity(pool, section_list)
        subject = _section_identity(pool, section_list, share=4)

        # 가장 잘 맞는 절만 남긴다. "한 번이라도 맞으면 통과"로는 못 거른다: 절 이름에는
        # 주제어(제조사 이름)와 부수어(Windows/스캔)가 섞여 있고, 답변은 어느 절을 설명하든
        # 부수어를 쓰기 마련이다. 실제로 어느 제조사의 설치 답변에서 "드라이버 파일명 (Windows, 10.8MB)"
        # 한 줄이 제조사 A Windows 절의 'windows'와 맞아 그 절을 통과시켰다.
        #
        # 단, 겨루는 상대는 '형제 절'이지 문서 전체가 아니다. 최고점 하나만 통과시키면
        # 제목이 문서 전체의 주제어를 그대로 담은 절(표지·개요처럼 문서를 대표하는 절)이
        # 영구 승자가 된다. 그런 절의 정체 토큰은 그 문서에 대한 어떤 답변에도 등장하므로
        # 항상 최고점이고, 정작 답을 그린 내용 절은 정체 토큰이 두어 개뿐이라 늘 진다.
        # 실측: 인용 필터를 지난 후보 6장이 여기서 전멸(6 -> 0)했다.
        # 승자독식이 원래 막으려던 것은 같은 주제를 다른 조건으로 다시 쓴 절(같은 제목에
        # 플랫폼·버전만 다른 절)이 서로 대신 통과하는 것이다. 그건 주제가 겹치는 절끼리
        # 비교하면 되지 주제가 다른 절과 겨룰 이유가 없다. 정체 토큰을 하나라도 공유하면
        # 형제로 본다 — 조건만 다른 절들은 주제어를 공유하므로 여전히 서로를 배제하고,
        # 주제가 다른 절끼리는 서로를 굶기지 않는다.
        #
        # 점수는 후보가 아니라 pool 전체로 낸다. 인용 필터를 지나 한 절만 남은 턴에서는
        # 후보끼리 재면 그 절이 곧 최고점이 되어 다시 통과한다 — 답변이 실제로 어느 절을
        # 말하고 있는지는 이번 질의가 가져온 절 전체를 봐야 알 수 있다.
        #
        # 그래서 형제 관계(누가 누구와 겨루는가)를 **주제어**로만 맺는다. 정체에 남는 낱말은
        # 절 목록 기준 df가 절 수의 절반 이하인 것들이라 '방법'처럼 절차 문서면 어디에나 있는
        # 말도 섞인다. 그런 말로 형제를 맺으면 아무 상관 없는 절이 서로를 물리친다 — 인용
        # 필터를 지난 그림이 **인용조차 안 된 절**에 밀려 전멸한 실측 두 건이 그 모양이었다
        # (`인용필터 16 → 3`, `절게이트 3 → 0`). 반대로 문턱을 정체 전체에 똑같이 조이면
        # 이 코퍼스에서는 '스캔'(df 7)이 '방법'(df 8)과 함께 떨어져 스캔 절이 정체를 잃는다.
        #
        # 그래서 두 척도를 나눈다: **정체**(무엇으로 점수를 내는가)는 넓게, **주제어**(누구와
        # 겨루는가)는 좁게. 조건만 다른 형제 절은 제조사·주제 이름을 공유하므로 여전히 서로를
        # 배제하고, 절차 문서의 흔한 말로는 형제가 되지 않는다.
        #
        # 절 점수는 '몇 개가 나왔나'가 아니라 '얼마나 쓰였나'로 잰다. 개수로 세면 지나가는
        # 한마디가 주제어와 같은 무게를 갖는다 — 스캔 절차를 설명하는 답변에서 설치 절이
        # 스캔 절과 동점이 된 실측이 그 모양이었다. 답변이 '스캔'을 일곱 번 쓰는 동안 설치
        # 절은 제목의 '방법' 한 낱말로 같은 점수를 받았고, 동점이면 서로를 이기지 못하므로
        # 설치 절 그림이 함께 붙었다.
        #
        # 개수 방식은 절 목록이 길어질수록 더 나빠진다. 정체 토큰은 '문서 절 목록 기준 df가
        # 절 수의 절반 이하'로 뽑는데, 절이 21개인 문서에서는 df 7~9인 절차 낱말
        # (설치·드라이버·방법·ver)이 그 문턱을 통과해 정체에 섞인다. 같은 낱말이 절 11개인
        # 문서에서는 걸러진다 — 즉 문서마다 정체의 순도가 달라진다. 빈도로 재면 그렇게
        # 섞여 들어온 낱말은 답변에서 한두 번밖에 안 쓰이므로 저절로 가벼워진다.
        scores = {key: _weight(toks, answer_text) for key, toks in section.items() if toks}
        eligible = {
            key for key in matched_images
            # 헤딩이 없거나 죄다 흔한 말뿐인 절은 판단 근거가 없으므로 배제하지 않는다.
            if not section.get(key)
            # 답변이 그 절의 무엇도 부르지 않았으면 근거가 없다(예전의 best==0 조건).
            or (scores.get(key, 0) > 0
                and not _beaten_by_sibling(key, section, subject, scores))
        }
        if len(eligible) != len(matched_images):
            logger.info(
                f"Figure eligibility by section: {len(matched_images)} -> {len(eligible)}"
            )

        # 블록×그림 점수를 모두 낸 뒤 가장 잘 맞는 짝부터 확정한다.
        #
        # 블록 순서대로 훑으며 "기준을 넘는 것 중 가장 좋은 것"을 집어 가면, 앞쪽의 제목이나
        # 정보 표처럼 두루뭉술한 블록이 먼저 그림을 채가고 정작 그 그림이 그리고 있는 단계
        # 블록은 굶는다. 실제로 다운로드 그림과 설치 그림이 제목·표에 붙어 14·15가 15·14로
        # 뒤집혀 나왔다. 그림은 자기가 가장 잘 맞는 블록으로 가야 한다.
        #
        # 토큰 하나만 겹치는 것은 근거가 못 된다. 지나가는 언급 한 번으로도 성립하기 때문이다.
        # 그림이 그 단계를 실제로 그린 것이라면 여러 낱말이 함께 겹친다.
        def _place(marks, floor=_MIN_FIGURE_MATCH):
            out = [
                (_occurrences(marks[key], block), bi, key)
                for bi, block in enumerate(blocks) if (_tokens(block) - generic)
                for key in eligible if marks.get(key)
            ]
            pairs = sorted((p for p in out if p[0] >= floor), reverse=True)

            placement = {}   # 블록 index -> 그림 key
            used = set()
            ambiguous_blocks = set()
            for score, bi, key in pairs:
                if bi in placement or bi in ambiguous_blocks or key in used:
                    continue
                # 같은 블록을 같은 점수로 다투는 다른 그림이 남아 있으면 이 블록에는 붙이지
                # 않는다. 답변이 아직 어느 쪽인지 정하지 않았다는 뜻이므로(선택지를 나열하고
                # 되묻는 답변) 하나를 골라 보여주는 것은 답을 지어내는 것과 같다.
                if any(
                    s == score and b == bi and k != key and k not in used
                    for s, b, k in pairs
                ):
                    ambiguous_blocks.add(bi)
                    continue
                placement[bi] = key
                used.add(key)
            return placement

        placement = _place(identity)
        # 판정 기준은 '짝이 나왔는가'가 아니라 '한 장이라도 붙었는가'다. 캡션이 다른 언어라도
        # 고유명사(제품·서비스 이름)는 그대로 실리므로 점수 자체는 종종 나온다 — 그런데 그
        # 고유명사는 후보 여럿이 함께 갖는 말이라 같은 블록에서 동점으로 부딪히고, 위의 동점
        # 규칙에 걸려 전부 보류된다. 실측 로그가 정확히 그 모양이었다: 후보 6장, 삽입 0장.
        if not placement and page_texts:
            # 캡션이 답변과 다른 언어로 쓰여 있으면 어떤 블록과도 낱말이 겹치지 않아 배치가
            # 통째로 빈다. 파서는 문서의 언어와 무관하게 캡션을 쓰므로 이건 코퍼스마다 갈린다.
            # 그럴 때만 그림이 실린 페이지의 본문으로 다시 잰다 — 본문은 문서 자신의 언어이고,
            # 그 페이지가 무엇을 보여 주는지 이미 적고 있다. 캡션으로 배치가 되는 코퍼스에서는
            # 이 경로가 실행되지 않으므로 기존 동작이 그대로 남는다.
            #
            # 캡션 정체가 빈 그림은 여기서도 뺀다. 모든 페이지에 똑같이 실리는 장식(로고·머리말)이
            # 그런 캡션을 갖는데, 페이지 본문만 보면 그 페이지 이야기에 완벽히 들어맞아 버린다.
            # "무엇을 그렸는가"는 끝까지 캡션이 답해야 하고, 페이지 본문은 언어만 잇는다.
            #
            # 여기서는 캡션 때와 달리 '후보 중 나만 가진 낱말'을 요구하지 않는다. 같은 절차가
            # 여러 문서에 실려 있으면(건물마다 같은 안내서) 페이지 본문이 서로 거의 같아서,
            # 유일성을 요구하는 순간 알맹이가 통째로 지워진다. 실측 — 같은 답변·같은 후보로:
            #
            #     유일 토큰 15개 → 블록 최고점 1      (문턱 미달, 0장)
            #     전체 토큰 88개 → 블록 최고점 10     (배치됨)
            #
            # 유일성은 캡션에는 맞는 요구다. 캡션은 '이 그림이 무엇인가'를 한 줄로 적은 것이라
            # 짧고, 후보끼리 구별되어야 어느 단계 그림인지 알 수 있다. 페이지 본문은 그 역할이
            # 아니다 — 어느 문서·어느 절의 그림인지는 이미 인용·스코프·절 게이트가 정했고,
            # 본문은 '이 페이지가 이 블록 이야기인가'만 답하면 된다.
            #
            # 대신 문턱을 두 배로 올린다. 본문은 캡션보다 스무 배쯤 길어서 같은 '두 낱말'이라도
            # 근거의 무게가 훨씬 가볍다.
            bridged = {
                key: _tokens(page_texts.get(key) or "") - generic
                for key in matched_images if identity.get(key)
            }
            placement = _place(bridged, floor=_MIN_FIGURE_MATCH * 2)
            # 성공했을 때만 찍으면 "폴백이 안 돌았다"와 "돌았는데 못 찾았다"가 로그에서
            # 똑같이 '줄 없음'으로 보인다. 이 파이프라인에서 그 구분이 안 돼 헤맨 적이 있어
            # (기록.md §5) 시도 자체를 남긴다.
            logger.info(
                f"Figure placement fallback by page text: {len(page_texts)} page texts, "
                f"{len(bridged)} bridged, {len(placement)} placed"
            )

        segments = []
        placed = set()
        # 오프셋은 반드시 '모델이 낸 원본 문자열' 위에서 재야 한다. 블록을 다시 이어 붙인
        # 문자열 위에서 세면 안 된다 — _split_into_blocks는 빈 줄을 버리고 줄을 "\n"으로
        # 다시 붙이므로, 원본과 길이가 어긋난다. 스트리밍 경로의 클라이언트는 원본 본문을
        # 이 오프셋으로 자르기 때문에, 그 차이가 그대로 밀린 자리가 되어 "**확|인**"처럼
        # 문장·단어 한가운데가 잘린다. 원본에서 블록의 끝을 찾아 그 자리를 쓰면 자르는
        # 지점은 언제나 블록 경계 = 문장이 끝난 자리가 된다.
        cursor = 0

        for bi, block in enumerate(blocks):
            start = answer_text.find(block, cursor)
            if start < 0:
                # 원본에 그대로 없는 블록(있어선 안 되지만)은 위치를 지어내지 않는다.
                segments.append({"type": "text", "text": block + "\n\n"})
                continue
            offset = start + len(block)
            segments.append({"type": "text", "text": answer_text[cursor:offset]})
            cursor = offset

            best_key = placement.get(bi)
            if best_key is None:
                continue

            cand = matched_images[best_key]
            url = _candidate_url(cand)
            if not url:
                continue
            placed.add(best_key)
            doc_uri, page = best_key
            segments.append({
                "type": "image",
                "page": page + 1,
                "image": url,
                "name": doc_uri.split("/")[-1] if doc_uri else "이미지",
                "at": offset,
            })

        # 마지막 블록 뒤에 남은 꼬리(후행 개행 등)까지 실어야 세그먼트를 이어 붙인 것이
        # 원본과 정확히 같아진다. 오프셋의 기준이 바로 그 원본이다.
        if cursor < len(answer_text):
            segments.append({"type": "text", "text": answer_text[cursor:]})

        logger.info(
            f"Block-image matching: {len(blocks)} blocks, {len(matched_images)} candidates, "
            f"{len(placed)} images inserted"
        )
        return segments

    def _split_into_blocks(self, text):
        """마크다운 텍스트를 블록 단위로 분할. 테이블은 하나의 블록으로 유지."""
        lines = text.split("\n")
        blocks = []
        current_block = []
        in_table = False

        for line in lines:
            stripped = line.strip()

            # 테이블 행 감지
            is_table_line = stripped.startswith("|") or (stripped.startswith("---") and in_table)

            if is_table_line:
                in_table = True
                current_block.append(line)
            elif in_table and not stripped:
                # 테이블 끝
                in_table = False
                if current_block:
                    blocks.append("\n".join(current_block))
                    current_block = []
            elif not stripped and not in_table:
                # 빈 줄 = 단락 구분
                if current_block:
                    blocks.append("\n".join(current_block))
                    current_block = []
            else:
                in_table = False
                current_block.append(line)

        if current_block:
            blocks.append("\n".join(current_block))

        return [b for b in blocks if b.strip()]

    def _build_citations(self, answer_text, text_results, scores):
        """답변 내 [N] 또는 [출처 N] 마커에서 인용 목록 구성."""
        # Match both [N] and [출처 N] patterns
        cited_numbers = _cited_numbers(answer_text)
        references = []

        for i, r in enumerate(text_results[:_CONTEXT_CHUNKS], 1):
            if i not in cited_numbers:
                continue
            content = (r.get("content") or {}).get("text") or ""
            meta = r.get("metadata") or {}
            uri = (r.get("location", {}).get("s3Location", {}) or {}).get("uri") or ""
            page = meta.get("x-amz-bedrock-kb-document-page-number")
            if page is None:
                marker = re.search(r"\[p(\d+)\]", content)
                page = int(marker.group(1)) - 1 if marker else None
            else:
                page = int(page)

            references.append({
                "number": i,
                "name": uri.split("/")[-1] if uri else "문서",
                "uri": uri,
                "page": int(page) + 1 if page is not None else None,
                "score": scores.get(content.strip()),
                "content": _clean_snippet(content),
                "type": "TEXT",
                "image": None,
                "metadata": meta,
            })

        return references

    def _extract_followup_queries(self, text_results, prompt: str) -> list:
        """1차 검색 결과를 보고 2차 검색이 필요한 쿼리를 Claude에게 판단시킴.

        질문이 두 단계일 때 필요하다: 1차 결과는 질문의 대상이 '무엇'인지만 알려주고
        (표에서 식별자 조회), 그 대상의 '절차'는 문서의 다른 절에 있어 원 질문의 표현으로는
        검색되지 않는다. 그 절을 가리키는 검색어를 여기서 만든다.
        """
        # 1차 결과를 Claude에게 보여줌.
        #
        # 청크를 앞 N자로 자르면 안 된다. 표 형태의 청크는 헤더와 첫 행들만 남고 질문이
        # 가리키는 행은 잘려나간다. 그러면 모델은 눈에 보이는 앞쪽 항목으로 후속 검색어를
        # 만들어 엉뚱한 절을 가져온다. 후속 검색어의 정확도는 이 요약이 대상 행을 담고
        # 있는지에 전적으로 달려 있으므로 청크를 통째로 준다. 상한은 프롬프트 크기를 묶기
        # 위한 안전장치일 뿐이다.
        snippets = []
        for r in text_results[:8]:
            text = ((r.get("content") or {}).get("text") or "").strip()
            if text:
                snippets.append(text[:_FOLLOWUP_SNIPPET_LIMIT])
        if not snippets:
            return []

        context_summary = "\n---\n".join(snippets)

        instruction = (
            "사용자 질문과 1차 검색 결과를 보고, 답변에 필요하지만 아직 검색되지 않은 정보가 있는지 판단하세요.\n\n"
            f"[사용자 질문]\n{prompt}\n\n"
            f"[1차 검색 결과 요약]\n{context_summary}\n\n"
            "[판단 규칙]\n"
            "- 질문이 방법/절차를 묻는데, 1차 결과에는 해당 항목의 이름/분류만 나오고 구체적 절차가 없으면 → 추가 검색 필요\n"
            "- 질문이 가능·허용 여부(되나요/써도 되나요/제한 있나요)를 묻는데 1차 결과에 절차만 있고\n"
            "  제한·예외·주의 규정이 보이지 않으면 → 추가 검색 필요. 절차가 실려 있다는 사실은\n"
            "  그것이 허용된다는 근거가 아니며, 제한 규정은 절차와 다른 곳(안내면·표지·주석)에\n"
            "  따로 적혀 있어 절차를 묻는 표현으로는 검색되지 않습니다.\n"
            "  이때 검색어는 대상 이름에 '제한/불가/주의/예외' 같은 말을 붙여 만드세요.\n"
            "- 이때 검색어는 질문의 표현이 아니라 1차 결과에서 확인된 '그 대상의 이름'으로 만드세요.\n"
            "  질문이 대상을 조건(위치·번호·소속 등)으로 가리키고 있다면, 문서의 절차 절은 그 조건이 아니라\n"
            "  대상의 이름으로 서술되어 있어 원래 표현으로는 검색되지 않습니다.\n"
            "- 답변에 대상의 속성값(주소·번호·식별자·수량 등)이 필요한데 1차 결과에 그 값이 없으면\n"
            "  → 그 값이 실린 목록·표를 찾는 검색어를 만드세요. 목록은 절차와 다른 곳에 있어\n"
            "  절차를 묻는 표현으로는 검색되지 않습니다.\n"
            "- 검색어에 값을 지어내지 마세요. 1차 결과에 없는 주소·번호·식별자를 추측해 넣으면\n"
            "  그 값은 어느 자료와도 맞지 않아 검색이 빗나갑니다. 값 자체를 찾는 것이 목적이라면\n"
            "  값 대신 '대상 이름 + 무엇을 찾는지'로 검색어를 만드세요.\n"
            "- 1차 결과에 이미 충분한 답변 정보가 있으면 → 추가 검색 불필요\n\n"
            # "설명 금지" is load-bearing, as it is in _triage and _plan. Without it the model
            # writes out its reasoning first — correct reasoning, naming the very section that
            # is missing — and runs out of maxTokens before the JSON. The parse then fails, the
            # handler below swallows it, and the second pass silently never runs: the answer
            # comes back as "자료에 없습니다" for material that is in the index.
            "다음 JSON만 출력하세요. 설명 금지.\n"
            '{"needs_more": true/false, "queries": ["추가 검색 쿼리1", ...]}\n'
            "- needs_more가 false면 queries는 빈 배열\n"
            "- queries는 최대 2개, 각 쿼리는 검색에 적합한 키워드 형태"
        )

        try:
            resp = self.bedrock_runtime_client.converse(
                modelId=self.model_id,
                messages=[{"role": "user", "content": [{"text": instruction}]}],
                inferenceConfig={"maxTokens": 200, "temperature": 0},
            )
            raw = resp["output"]["message"]["content"][0]["text"]
            parsed = json.loads(re.search(r"\{.*\}", raw, re.DOTALL).group(0))
            if parsed.get("needs_more") and parsed.get("queries"):
                queries = [str(q).strip() for q in parsed["queries"] if str(q).strip()]
                return queries[:2]
        except Exception as e:
            logger.warning(f"2-pass query extraction failed: {e}")

        return []

    def retrieve_and_converse(self, prompt: str):
        """Custom RAG 전체 흐름을 이 프로세스 안에서 수행 (REST 경로).

        스트리밍 경로는 같은 단계를 prepare_generation / finalize_generation으로 나눠 쓴다.
        생성만 프록시로 옮기고 검색·후처리는 여기 그대로 두기 위해서다.
        """
        prepared = self.prepare_generation(prompt)
        if "triage" in prepared:
            t = prepared["triage"]
            return {"completion": t, "references": [], "segments": [{"type": "text", "text": t}]}

        raw_answer = self._converse_generate(prepared["system_prompt"], prepared["messages"])
        return self.finalize_generation(prepared["state"], raw_answer)

    def prepare_generation(self, prompt: str):
        """검색 → 계획 → 2차 검색 → 이미지 후보 → Converse 입력 조립까지.

        생성 직전까지만 하고 멈춘다. 반환된 system_prompt/messages로 호출자가 생성을
        수행하며, 스트리밍 프록시는 여기서 ConverseStream을 돌려 토큰을 그대로 흘려보낸다.
        state는 finalize_generation이 인용·이미지 배치를 마무리하는 데 필요한 최소 정보이고,
        JSON 직렬화가 가능하다.
        """
        original_prompt = prompt
        prompt = self._rewrite_followup(prompt)

        # Triage + Retrieve 병렬 실행
        with ThreadPoolExecutor(max_workers=2) as pool:
            triage_task = pool.submit(self._triage, prompt)
            retrieval_task = pool.submit(self._resolve_retrieval, prompt)
            triage = triage_task.result()
            vector_search, scores, retrieved_images, results, retrieve_metadata = retrieval_task.result()

        if triage:
            # triage로 끝나는 답은 생성도 후처리도 없으므로 여기서 바로 기록한다.
            self._save_turn(original_prompt, triage)
            return {"triage": triage}

        # Plan (scope 결정 + intent 분리)
        plan = self._plan(prompt, results)

        # Scope: Custom RAG에서는 scope 필터를 적용하지 않음.
        # Claude가 검색 결과에서 질문에 관련된 정보만 선택하여 답변하므로,
        # 코드 레벨 필터링은 오히려 유효한 결과를 제거하는 부작용을 만듦.
        # (예: "대상 A 10층" 질문에 대상 B scope가 잡혀 대상 A 문서 제거)
        current_scope = plan["scope"] or ""
        self.chat_context.state["last_scope"] = current_scope

        # 다중 intent 처리: 각 intent별로 별도 Retrieve하여 결과 합산
        # (기존 RetrieveAndGenerate의 QUERY_DECOMPOSITION과 동일한 효과)
        if len(plan["intents"]) > 1:
            intent_scopes = plan.get("intent_scopes", [])
            all_results = list(results)  # 기본 검색 결과 유지
            with ThreadPoolExecutor(max_workers=3) as pool:
                def _retrieve_intent(intent, scope):
                    vs = vector_search
                    if scope and not self.metadata:
                        vs = {**vector_search, "filter": {"equals": {"key": "scope_key", "value": scope}}}
                    return self._retrieve(intent, vs)
                futures = [
                    pool.submit(_retrieve_intent, intent, intent_scopes[i] if i < len(intent_scopes) else "")
                    for i, intent in enumerate(plan["intents"])
                ]
                for f in futures:
                    intent_results = f.result()
                    all_results.extend(intent_results)
            # Dedup by content text
            seen_texts = set()
            deduped = []
            for r in all_results:
                text = ((r.get("content") or {}).get("text") or "").strip()
                byte_content = (r.get("content") or {}).get("byteContent") or ""
                key = text or byte_content[:100]
                if key and key not in seen_texts:
                    seen_texts.add(key)
                    deduped.append(r)
            results = deduped
            # Update scores from new results
            for r in results:
                text = ((r.get("content") or {}).get("text") or "").strip()
                if text and r.get("score") is not None and text not in scores:
                    scores[text] = r["score"]

        # TEXT/IMAGE 분리
        text_results = [r for r in results if (r.get("content") or {}).get("type") != "IMAGE"]
        image_results = [r for r in results if (r.get("content") or {}).get("type") == "IMAGE"]

        # ── 2-pass Retrieval ──
        # 질문이 두 단계일 때(1차 결과는 대상이 무엇인지만 알려주고, 그 대상의 절차는 문서의
        # 다른 절에 있어 원 질문 표현으로는 안 잡힘) 후속 검색어로 그 절을 가져온다.
        pass2_queries = self._extract_followup_queries(text_results, prompt)
        if pass2_queries:
            logger.info(f"2-pass retrieval: {pass2_queries}")
            existing_texts = {((er.get("content") or {}).get("text") or "").strip() for er in results}
            pass2_texts = []
            with ThreadPoolExecutor(max_workers=len(pass2_queries)) as pool:
                futures = [pool.submit(self._retrieve, q, vector_search) for q in pass2_queries]
                for f in futures:
                    for r in f.result():
                        text = ((r.get("content") or {}).get("text") or "").strip()
                        byte_content = (r.get("content") or {}).get("byteContent") or ""
                        key = text or byte_content[:100]
                        if not key or key in existing_texts:
                            continue
                        existing_texts.add(key)
                        results.append(r)
                        if (r.get("content") or {}).get("type") != "IMAGE":
                            pass2_texts.append(r)
                        else:
                            image_results.append(r)
                        if text and r.get("score") is not None:
                            scores[text] = r["score"]

            # 이어 붙이지 않고 번갈아 배치한다. 그냥 append하면 2차 결과가 리스트 꼬리에
            # 몰려 _CONTEXT_CHUNKS 상한에서 전부 잘려 나간다 — 정답 청크를 가져오고도
            # 모델에게 보여주지 못해 "자료에 없다"고 답하게 된다.
            if pass2_texts:
                text_results = _round_robin([text_results, pass2_texts], _PASS_MIX)
                logger.info(
                    f"2-pass merge: {len(pass2_texts)} new chunks interleaved, "
                    f"{sum(1 for r in text_results[:_CONTEXT_CHUNKS] if r in pass2_texts)} "
                    f"of them within the top {_CONTEXT_CHUNKS}"
                )

        # 질문이 지목한 대상의 자료를 컨텍스트 앞쪽에 놓는다.
        #
        # 다른 대상의 문서가 더 크면 검색 결과를 뒤덮는다 — "대상 A 4층" 질문인데 상위
        # 8건 중 6건이 대상 B으로 돌아온다. 그대로 _CONTEXT_CHUNKS에서 자르면 정작 질문한
        # 대상의 청크가 몇 개 남지 않아, 모델이 옆 문서의 같은 이름 절차를 그대로 옮겨 적는
        # 일이 생긴다.
        #
        # 걸러내지는 않는다. 어떤 대상의 문서에 그 절차가 빠져 있을 때 같은 절차를 다룬 다른
        # 문서를 인용해 답하는 것은 의도된 동작이고(위 Scope 주석), 실제로 도움이 된다.
        # 순서만 바꿔 우선권을 준다 — 자리가 남으면 다른 문서도 그대로 들어간다.
        # bool 키 정렬은 안정 정렬이라 각 그룹 안의 관련도 순서는 보존된다.
        allowed_scopes = {s for s in ([current_scope] + plan.get("intent_scopes", [])) if s}
        if allowed_scopes:
            before = sum(
                1 for r in text_results[:_CONTEXT_CHUNKS]
                if ((r.get("metadata") or {}).get("scope_key") or "") in allowed_scopes
            )
            text_results = _scope_first(text_results, allowed_scopes)
            after = sum(
                1 for r in text_results[:_CONTEXT_CHUNKS]
                if ((r.get("metadata") or {}).get("scope_key") or "") in allowed_scopes
            )
            logger.info(
                f"Scope-first ordering {sorted(allowed_scopes)}: in-scope chunks within the "
                f"top {_CONTEXT_CHUNKS}: {before} -> {after}"
            )

        # 한 페이지가 여러 청크로 쪼개져 있으면 붙여 놓는다. 설명 문단과 표가 다른 청크로
        # 갈리는데 짧고 주제어가 촘촘한 설명 쪽이 훨씬 높게 랭크되어(대상 B 4층: 4위 vs 19위),
        # 상한에서 자르면 "표가 있다는 설명"만 전달되고 표는 빠진다.
        text_results = _keep_pages_together(text_results)

        # 이미지-텍스트 페이지 매칭 (문서 URI 포함)
        matched_images = self._match_images_to_text(text_results, image_results)

        # 페이지 단위 키워드는 더 이상 쓰지 않는다. TEXT 청크 하나가 여러 페이지에 걸쳐 있어
        # ([p1]…[p2]가 한 청크) 페이지별 키워드 집합이 사실상 동일해지고, 남는 건
        # "설치/프린터/드라이버" 같은 어느 페이지에나 있는 일반어뿐이라 변별력이 없었다.
        # 이제 이미지의 <figure> 캡션으로 판단한다 — _parse_image_markers 참고.
        if len(matched_images) > 0:
            logger.info(
                "Matched image pages: "
                + str(sorted(f"{u.split('/')[-1]} p.{p+1}" for u, p in matched_images))
            )

        # Converse 메시지 구성
        system_prompt, messages = self._build_converse_messages(prompt, text_results, matched_images)

        # 후처리에 필요한 것만 남긴 상태. 검색 결과 원본은 이미지 바이트까지 포함해 수 MB라
        # 그대로 넘길 수 없다 — 인용에 쓰는 청크(_CONTEXT_CHUNKS개)와 이미지 후보의
        # 메타데이터만 담는다.
        state = {
            # 히스토리에는 사용자가 실제로 친 문장을 남긴다. rewrite된 문장을 남기면
            # 다음 후속 질문 해석의 근거가 사용자가 하지 않은 말로 바뀐다.
            "prompt": original_prompt,
            "text_results": [
                {
                    "text": ((r.get("content") or {}).get("text") or ""),
                    "uri": ((r.get("location") or {}).get("s3Location") or {}).get("uri") or "",
                    "metadata": r.get("metadata") or {},
                    "score": r.get("score"),
                }
                for r in text_results[:_CONTEXT_CHUNKS]
            ],
            "corpus": (
                [((r.get("content") or {}).get("text") or "") for r in text_results]
                + [c.get("caption") or "" for c in matched_images.values()]
            ),
            "images": [
                {**cand, "key": [doc, page]}
                for (doc, page), cand in matched_images.items()
            ],
            "allowed_scopes": sorted(allowed_scopes),
            # 이번 답변에 등장할 수 있는 문서들의 '전체' 절 목록. 절 정체를 재는 기준이며,
            # 후보로 재면 검색 운에 따라 같은 그림이 통과했다 배제됐다 한다 — _document_sections.
            "section_list": _document_sections({doc for doc, _ in matched_images}),
        }

        return {"system_prompt": system_prompt, "messages": messages, "state": state}

    def externalize_state_images(self, state: dict) -> dict:
        """Replace image bytes with S3 URLs so the state can cross a Lambda boundary.

        Only for the streaming path. The candidates carry ~300KB of base64 each — measured at
        5.6MB for one question after scope filtering — which no state record can hold. Uploading
        here (in parallel, before generation starts) costs a few hundred milliseconds, against a
        generation wait of many seconds that streaming removes from time-to-first-token.

        Out-of-scope figures are dropped first: they can never be shown, so uploading them would
        be pure waste.
        """
        allowed = set(state.get("allowed_scopes") or [])
        candidates = [
            c for c in state.get("images", [])
            if not allowed or not (c.get("scope_key") or "") or (c.get("scope_key") or "") in allowed
        ]
        if not candidates:
            state["images"] = []
            return state

        def _upload(cand):
            cand = dict(cand)
            cand["url"] = _candidate_url(cand)
            cand.pop("data", None)  # bytes must not travel with the state
            return cand

        with ThreadPoolExecutor(max_workers=8) as pool:
            state["images"] = list(pool.map(_upload, candidates))

        logger.info(f"Externalized {len(state['images'])} candidate images to S3")
        return state

    def finalize_generation(self, state: dict, raw_answer: str):
        """생성이 끝난 뒤의 후처리: 인용 구성, 이미지 선택·배치, 히스토리 저장.

        prepare_generation이 만든 state와 완성된 답변만 있으면 되므로, 생성이 다른
        프로세스(스트리밍 프록시)에서 일어나도 동일하게 동작한다.
        """
        text_results = [
            {
                "content": {"text": r.get("text") or ""},
                "location": {"s3Location": {"uri": r.get("uri") or ""}},
                "metadata": r.get("metadata") or {},
                "score": r.get("score"),
            }
            for r in state.get("text_results", [])
        ]
        scores = {
            (r.get("text") or "").strip(): r.get("score")
            for r in state.get("text_results", [])
            if r.get("score") is not None
        }
        matched_images = {
            (c["key"][0], c["key"][1]): c for c in state.get("images", []) if c.get("key")
        }
        # 좁히기 전의 후보 전체. 절 자격을 재는 기준이라 아래 필터들과 별도로 들고 있어야
        # 한다 — 무엇이 어느 절인지는 절들을 서로 비교해야만 알 수 있다.
        all_candidates = dict(matched_images)
        corpus = state.get("corpus") or []

        # [IMG:pN] 마커가 있으면 제거 (Claude가 넣었을 경우 대비)
        raw_answer = re.sub(r"\[IMG:p\d+\]", "", raw_answer)

        # [N] 인용 구성 (raw_answer에서 추출).
        # 이미지 필터의 기준이므로 segments보다 먼저 만든다.
        references = self._build_citations(raw_answer, text_results, scores)

        # 답변이 실제로 인용한 (문서, 페이지)의 이미지만 남긴다. 검색에는 걸렸지만
        # 답변이 쓰지 않은 문서(예: 대상 A 질문에 딸려온 대상 B p.6)의 이미지를
        # 여기서 잘라낸다. 답변 본문을 함께 넘기는 이유는 _cited_page_keys 참고 —
        # 부모 청크가 여러 페이지를 걸치므로, 그중 답변이 실제로 쓴 페이지만 통과시킨다.
        #
        # 인용이 하나도 없으면 후보를 전부 버린다. 예전에는 `if cited_keys:`로 감싸 두어
        # 인용이 없을 때 이 필터가 통째로 건너뛰어졌다 — 근거가 없을수록 더 많은 그림이
        # 통과하는, 정확히 반대로 된 동작이었다. 대화가 길어지면 모델이 짧은 후속 질문을
        # 검색 결과가 아니라 앞선 대화로 답하면서 [N]을 붙이지 않는 턴이 생기는데, 그 턴마다
        # 필터가 꺼져 후보 40~60장이 그대로 배치 단계로 넘어갔다. 운영 로그에서 확인:
        # citations=0인 턴은 "Image filter by citation" 줄이 없고 후보가 16·23·26장씩
        # 남았으며, 그중 18개 턴이 실제로 그림을 붙였다(2026-08-10~11).
        # 근거가 없으면 붙이지 않는다 — _parse_image_markers의 원칙과 같다.
        generic = _generic_tokens(corpus)
        section_list = tuple(state.get("section_list") or ())
        dropped = len(matched_images)

        if references:
            cited_keys = _cited_page_keys(references, text_results, raw_answer, generic)
            matched_images = {k: v for k, v in matched_images.items() if k in cited_keys}
            logger.info(f"Image filter by citation: {dropped} -> {len(matched_images)}")
        else:
            # 인용이 없으면 그림도 없다.
            #
            # 한동안 여기에 폴백이 있었다 — 답변이 절 이름을 부르면 그 절의 그림은 남기는.
            # 도입 당시 실측에서 최종 추가 이미지가 0장이라 "구조적 안전장치"로만 뒀는데,
            # QA에서 해가 측정됐다. 자료에 없는 것을 묻자 모델이 "자료에 없습니다. 아래
            # 대상만 포함돼 있습니다"라고 거절하면서 문서 이름들을 나열했고, 그 이름이
            # 곧 절 이름이라 폴백이 발동해 **거절 답변에 그림이 붙었다**(2/2회 재현).
            #
            # 근거 없이 통과시키는 쪽으로 기울면 예외 없이 이런 모양이 된다. 이득은
            # 측정되지 않았고 해는 측정됐으므로 뺀다.
            matched_images = {}
            logger.info(f"Image filter: no citation, dropping all {dropped} candidates")

        # 그림은 질문이 지목한 대상의 문서에서만 가져온다.
        allowed_scopes = set(state.get("allowed_scopes") or [])
        before = len(matched_images)
        matched_images = _images_in_scope(matched_images, allowed_scopes)
        if before != len(matched_images):
            logger.info(
                f"Image filter by scope {sorted(allowed_scopes)}: "
                f"{before} -> {len(matched_images)}"
            )

        # 인용 마커만 지우고 모델이 쓴 마크다운은 그대로 둔다.
        #
        # _format_answer는 여기서 부르지 않는다. 그것은 기본 RAG 프롬프트가 내놓던 run-on
        # 문장을 줄로 쪼개려고 만든 것이고(위 정의 참고), 이 경로의 모델은 answer_instructions
        # 지시대로 이미 마크다운으로 쓴다. 잘 쓰인 마크다운을 그 재조립기에 넣으면 오히려
        # 부서진다: 줄마다 블록을 다시 쌓기 때문에 들여쓴 하위 목록이 최상위로 올라가
        # 부모 단계에서 떨어져 나가고, 번호 목록 사이에 빈 줄이 끼어 목록이 조각난다.
        # 스트리밍 중에는 모델 원문이 보이므로 멀쩡하다가, 다 쓰고 나서 이 결과로 갈아끼우는
        # 순간 깨져 보였던 것이 이것이다.
        #
        # 부수 효과가 아니라 목적: 최종 본문 == 스트리밍된 본문이 되어 화면이 흔들리지 않고,
        # 이미지 오프셋도 클라이언트가 이미 그린 바로 그 문자열 위에서 재게 된다.
        clean_text = _strip_citations(raw_answer).strip()

        # 블록-이미지 매칭으로 segments 생성.
        # 이번 질의로 검색된 청크 + 이미지 캡션을 코퍼스로 넘겨, 어떤 단어가 흔해서
        # 근거가 못 되는지를 그 코퍼스에서 직접 재게 한다.
        segments = self._parse_image_markers(
            clean_text, matched_images, corpus, sections=all_candidates,
            section_list=section_list, page_texts=_page_texts(text_results),
        )

        logger.info(
            f"Converse RAG: text_results={len(text_results)}, images_matched={len(matched_images)}, "
            f"segments={len(segments)}, citations={len(references)}"
        )

        self._save_turn(state.get("prompt") or "", clean_text)

        return {
            "completion": clean_text,
            "references": references,
            "segments": segments,
        }

    def _save_turn(self, question: str, answer: str):
        """Append the exchange to the session history and persist it."""
        self.chat_context.history.extend([
            {'type': 'human', 'text': question},
            {'type': 'assistant', 'text': answer},
        ])
        # Keep session history under 300 KB (400KB is the DDB record size limit).
        while (self.__get_size_in_kb(self.chat_context.history) > 300
               and len(self.chat_context.history) > 1):
            self.chat_context.history.pop(0)
        self.chat_context_client.upsert(self.chat_context)

    def chat_with_agent(self, message: str):
        logger.info(f'Message from request is: {message}')

        response = self.retrieve_and_converse(message)
        logger.info(f'RAG response is: {str(response)[:500]}')

        # 히스토리 저장은 finalize_generation이 맡는다. 스트리밍 경로도 같은 지점을 지나므로
        # 어느 경로로 답하든 정확히 한 번 저장된다.

        body_content = {"message": response["completion"], "sessionId": self.session_id}
        if response["references"]:
            body_content["citations"] = response["references"]
        # segments로 인라인 이미지 위치 전달
        if response.get("segments"):
            body_content["segments"] = response["segments"]

        logger.info(
            f"Response stats: segments={len(response.get('segments', []))}, "
            f"citations={len(response.get('references', []))}"
        )
        logger.info('Returning RAG response')
        return body_content
