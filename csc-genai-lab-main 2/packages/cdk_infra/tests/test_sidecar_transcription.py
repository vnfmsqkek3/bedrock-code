"""스택과 함께 배포되는 샘플 문서도 첫 배포부터 검색돼야 한다.

실제로 있었던 일: led-spec-test.pdf는 표와 그래프뿐이라 텍스트 레이어가 없다. 파서는 그런
페이지를 그림으로만 뽑으므로 인덱스에 TEXT 청크가 0개로 들어갔고("0 TEXT / 13 IMAGE"),
답변 파이프라인은 TEXT 청크로만 컨텍스트를 만들기 때문에 모든 질문에 "자료에 없습니다"로
답했다. 파일은 버젓이 색인된 것처럼 보이는데도.

전사본(.text.md)을 만드는 _put_extract는 업로드 경로(/kb/process)에만 있었다. 스택 자산으로
들어오는 문서는 그 경로를 지나지 않으므로 sidecar_handler가 같은 일을 해 줘야 한다.

실행: pytest packages/cdk_infra/tests/test_sidecar_transcription.py
"""

import io
import json
import sys
from pathlib import Path

import pytest

LAMBDA_DIR = (
    Path(__file__).resolve().parents[1]
    / "src/backend/kb_management/lambda/kb_documents"
)
sys.path.insert(0, str(LAMBDA_DIR))

import kb_documents  # noqa: E402


class _NoSuchKey(Exception):
    """botocore ClientError 대역 — 코드가 보는 것은 response['Error']['Code']뿐이다."""

    def __init__(self, code="404"):
        self.response = {"Error": {"Code": code}}


class FakeS3:
    """documents/ 아래 객체 몇 개를 들고 있는 최소 S3."""

    def __init__(self, objects):
        self.objects = dict(objects)
        self.put_keys = []

    def get_paginator(self, _name):
        outer = self

        class _P:
            def paginate(self, **_kw):
                return [{"Contents": [{"Key": k} for k in sorted(outer.objects)]}]

        return _P()

    def get_object(self, Bucket=None, Key=None):  # noqa: N803
        if Key not in self.objects:
            raise _NoSuchKey()
        return {"Body": io.BytesIO(self.objects[Key])}

    def head_object(self, Bucket=None, Key=None):  # noqa: N803
        if Key not in self.objects:
            raise _NoSuchKey()
        return {"ContentLength": len(self.objects[Key])}

    def put_object(self, Bucket=None, Key=None, Body=None, ContentType=None):  # noqa: N803
        self.objects[Key] = Body if isinstance(Body, bytes) else str(Body).encode()
        self.put_keys.append(Key)


@pytest.fixture
def env(monkeypatch):
    """모델 호출은 전부 대역으로 — 이 테스트가 재는 것은 '무엇을 언제 쓰는가'다."""
    monkeypatch.setattr(kb_documents, "ClientError", _NoSuchKey)
    monkeypatch.setattr(
        kb_documents, "_analyze_key",
        lambda key, filename: {"metadataAttributes": {"source_title": filename}},
    )
    calls = []

    def fake_extract(doc_bytes, filename):
        calls.append(filename)
        return f"[p1]\n{filename} 전사본"

    monkeypatch.setattr(kb_documents, "_extract_page_text", fake_extract)
    return calls


class _Ctx:
    """powertools의 inject_lambda_context가 읽는 필드만 갖춘 Lambda 컨텍스트."""

    function_name = "kb-sidecar-test"
    memory_limit_in_mb = 1024
    invoked_function_arn = "arn:aws:lambda:ap-northeast-2:000000000000:function:test"
    aws_request_id = "test-request-id"


def _run(fake, event_type="Create"):
    kb_documents.s3 = fake
    return kb_documents.sidecar_handler(
        {"RequestType": event_type, "ResourceProperties": {"Prefixes": ["documents/"]}},
        _Ctx(),
    )


def test_shipped_sample_gets_a_page_transcription(env, monkeypatch):
    """스택 자산으로 들어온 문서는 사이드카와 전사본을 함께 받아야 한다."""
    fake = FakeS3({"documents/led-spec-test.pdf": b"%PDF-fake"})
    _run(fake)

    assert "documents/led-spec-test.pdf.text.md" in fake.objects, "전사본이 없다"
    # 전사본도 그 자체로 하나의 KB 문서다 — 스코프 속성이 없으면 필터에서 통째로 빠진다.
    assert "documents/led-spec-test.pdf.text.md.metadata.json" in fake.objects
    assert env == ["led-spec-test.pdf"]


def test_existing_transcription_costs_no_model_call(env):
    """이미 전사본이 있으면(업로드 문서·재배포) 모델을 다시 부르지 않는다."""
    sidecar = json.dumps({"metadataAttributes": {"source_title": "manual"}}).encode()
    fake = FakeS3({
        "documents/manual.pdf": b"%PDF-fake",
        "documents/manual.pdf.metadata.json": sidecar,
        "documents/manual.pdf.text.md": b"[p1] already here",
        "documents/manual.pdf.text.md.metadata.json": sidecar,
    })
    _run(fake)

    assert env == [], "전사본이 있는데 다시 전사했다"
    assert fake.put_keys == [], "아무것도 덮어쓰지 않아야 한다"


def test_a_transcription_is_not_itself_transcribed(env):
    """.text.md를 문서로 착각하면 .text.md.text.md가 생긴다."""
    fake = FakeS3({
        "documents/manual.pdf": b"%PDF-fake",
        "documents/manual.pdf.text.md": b"[p1] already here",
    })
    _run(fake)

    assert not any(k.endswith(".text.md.text.md") for k in fake.objects)
    assert env == [], "원본에는 전사본이 이미 있고, 전사본은 대상이 아니다"
