"""페이지 전사는 '그림 안에 글자가 들어 있는' 문서에만 돌아야 한다.

실제로 있었던 일: 486 KB 스프레드시트를 올리자 메타데이터 생성과 documents/ 게시가 7초 만에
끝나고 색인까지 성공했는데(검색도 됐다), 그 다음 전사 단계가 워커를 붙잡은 채 끝나지 않아
UI가 "1개 파일 처리 실패"로 표시했다. 업로드는 사실 성공한 상태였다.

스프레드시트는 페이지가 없고 셀이 곧 텍스트다 — 인덱스가 이미 다 읽는다. 전사는 모델 호출을
쓰고, 없는 페이지의 [pN] 마커를 지어내고, 워커 수명을 소진한다.

실행: pytest packages/cdk_infra/tests/test_transcription_scope.py
"""

import os
import sys
from pathlib import Path

LAMBDA_DIR = (
    Path(__file__).resolve().parents[1]
    / "src/backend/kb_management/lambda/kb_documents"
)
sys.path.insert(0, str(LAMBDA_DIR))
os.environ.setdefault("KB_BUCKET", "kb-bucket")
os.environ.setdefault("STATUS_BUCKET", "status-bucket")

import kb_documents  # noqa: E402


def _calls(monkeypatch):
    """모델 호출을 대역으로 바꾸고 호출된 파일명을 모은다."""
    seen = []

    def fake_converse(**kwargs):
        seen.append(kwargs)
        return {"output": {"message": {"content": [{"text": "[p1] 전사본"}]}}}

    monkeypatch.setattr(kb_documents.bedrock_runtime, "converse", fake_converse)
    return seen


def test_a_spreadsheet_is_not_transcribed(monkeypatch):
    """스프레드시트는 전사하지 않는다 — 업로드를 실패처럼 보이게 만든 그 단계."""
    seen = _calls(monkeypatch)
    out = kb_documents._extract_page_text(b"PK\x03\x04fake-xlsx", "점검표.xlsx")
    assert out == "", "스프레드시트를 전사했다"
    assert seen == [], "모델을 불렀다 — 워커 수명을 여기서 잃는다"


def test_text_native_formats_are_not_transcribed(monkeypatch):
    """셀·줄이 곧 텍스트인 형식은 전사가 중복만 만든다."""
    seen = _calls(monkeypatch)
    for name in ["표.csv", "메모.txt", "안내.md", "페이지.html", "구형.xls"]:
        assert kb_documents._extract_page_text(b"data", name) == "", name
    assert seen == []


def test_a_rendered_document_is_still_transcribed(monkeypatch):
    """PDF·워드는 그대로 전사한다 — 전사가 존재하는 이유가 그쪽이다."""
    seen = _calls(monkeypatch)
    out = kb_documents._extract_page_text(b"%PDF-fake", "매뉴얼.pdf")
    assert out.strip(), "PDF 전사가 사라졌다"
    assert len(seen) == 1, "PDF는 모델을 한 번 불러야 한다"

    kb_documents._extract_page_text(b"docx", "보고서.docx")
    assert len(seen) == 2, "워드 문서 전사가 사라졌다"


def test_an_unsupported_format_is_still_refused(monkeypatch):
    """Converse가 받지 않는 형식은 예전처럼 조용히 건너뛴다."""
    seen = _calls(monkeypatch)
    assert kb_documents._extract_page_text(b"\x00\x01", "그림.png") == ""
    assert seen == []
