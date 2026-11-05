"""스프레드시트는 표로 옮겨 넣어야 청크가 스스로를 설명한다.

실제로 있었던 일: 엑셀을 올리면 색인은 되는데 챗봇 답이 엉성했다. 색인된 청크를 열어 보니
파서가 셀을 탭으로 이어 붙인 덩어리였고, **열 이름이 없었다** — 헤더 행은 시트 맨 위에만
있어 청킹이 잘라냈기 때문이다. 같은 회사 이름이 '소유자' 칸에도 '수행주체' 칸에도 나오는데
청크만 봐서는 어느 쪽인지 알 수 없다.

여기서 만드는 마크다운은 시트마다 절을 두고, 표 안에서 열 이름을 주기적으로 되풀이한다.
정리.md §1의 "행은 스스로를 설명해야 한다"를 스프레드시트에 그대로 적용한 것.

실행: pytest packages/cdk_infra/tests/test_spreadsheet_markdown.py
"""

import io
import os
import sys
import zipfile
from pathlib import Path

LAMBDA_DIR = (
    Path(__file__).resolve().parents[1]
    / "src/backend/kb_management/lambda/kb_documents"
)
sys.path.insert(0, str(LAMBDA_DIR))
os.environ.setdefault("KB_BUCKET", "kb-bucket")
os.environ.setdefault("STATUS_BUCKET", "status-bucket")

import kb_documents  # noqa: E402

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _xlsx(sheets):
    """{시트명: [[셀, …], …]} → 최소 xlsx 바이트. openpyxl 없이 만든다."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        names = list(sheets)
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/'
                   'package/2006/content-types"/>')
        z.writestr("xl/workbook.xml",
                   f'<workbook xmlns="{NS}" xmlns:r="{RNS}"><sheets>'
                   + "".join(f'<sheet name="{n}" sheetId="{i+1}" r:id="rId{i+1}"/>'
                             for i, n in enumerate(names))
                   + "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                   'relationships">'
                   + "".join(f'<Relationship Id="rId{i+1}" Target="worksheets/sheet{i+1}.xml"/>'
                             for i in range(len(names)))
                   + "</Relationships>")
        for i, name in enumerate(names):
            rows = []
            for r, row in enumerate(sheets[name], start=1):
                cells = []
                for c, value in enumerate(row):
                    if value == "":
                        continue
                    ref = f"{chr(65 + c)}{r}"
                    cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>')
                rows.append(f'<row r="{r}">{"".join(cells)}</row>')
            z.writestr(f"xl/worksheets/sheet{i+1}.xml",
                       f'<worksheet xmlns="{NS}"><sheetData>{"".join(rows)}</sheetData></worksheet>')
    return buf.getvalue()


HEADER = ["구분", "항목", "소유자", "수행주체"]
BODY = [[f"분류{i}", f"항목{i}", "회사갑", "회사을"] for i in range(40)]


def test_every_chunk_carries_the_column_names():
    """표를 잘라도 어느 조각이든 열 이름이 함께 온다 — 청킹은 아무 데나 자른다."""
    md = kb_documents._extract_page_text(_xlsx({"점검표": [HEADER] + BODY}), "점검.xlsx")
    assert md, "마크다운이 비었다"

    header_line = "| 구분 | 항목 | 소유자 | 수행주체 |"
    assert md.count(header_line) >= len(BODY) // kb_documents._HEADER_EVERY, \
        "열 이름이 표 안에서 되풀이되지 않는다"

    # 헤더 사이 간격이 실제로 _HEADER_EVERY 를 넘지 않아야 한다
    positions = [i for i, line in enumerate(md.split("\n")) if line == header_line]
    body_lines = [i for i, line in enumerate(md.split("\n")) if line.startswith("| 분류")]
    for line_no in body_lines:
        assert any(0 < line_no - p <= kb_documents._HEADER_EVERY + 2 for p in positions), \
            f"{line_no}번째 줄이 열 이름 없이 떨어져 있다"


def test_each_sheet_becomes_a_section_and_a_page():
    """시트는 절이자 페이지다 — 인용과 절 맵이 PDF와 같은 방식으로 동작해야 한다."""
    md = kb_documents._extract_page_text(
        _xlsx({"요약": [HEADER] + BODY[:3], "상세": [HEADER] + BODY[:3]}), "두시트.xlsx")
    section_map = kb_documents._page_sections(md)
    assert section_map["sections"] == ["요약", "상세"]
    assert section_map["pages"] == {"0": "요약", "1": "상세"}


def test_the_header_is_found_below_a_title_block():
    """제목·요약 줄이 위에 있어도 진짜 열 이름 줄을 찾는다.

    업무용 시트는 대개 제목 한 줄, 측정 기준일 한 줄, 요약 몇 줄 뒤에 표가 시작된다.
    맨 윗줄을 헤더로 잡으면 표 전체가 열 이름 없이 색인된다.
    """
    sheet = [["2026년 점검 결과"], ["기준일 2026-08-06"], ["총 40건"], HEADER] + BODY[:5]
    md = kb_documents._extract_page_text(_xlsx({"점검": sheet}), "제목있는.xlsx")
    assert "| 구분 | 항목 | 소유자 | 수행주체 |" in md, "열 이름 줄을 못 찾았다"
    # 제목·요약 줄은 표 밖에서 그대로 살아 있어야 한다 (그 자체가 답이 되는 정보다)
    assert "2026년 점검 결과" in md and "기준일 2026-08-06" in md
    assert "| 2026년 점검 결과 |" not in md, "제목 줄을 헤더로 잡았다"


def test_a_file_that_is_not_a_workbook_is_refused_quietly():
    """열 수 없는 파일이면 빈 문자열 — 호출자는 원본만 색인한다(이 함수 없을 때와 같음)."""
    assert kb_documents._extract_page_text(b"not a zip at all", "깨진.xlsx") == ""


def test_a_workbook_costs_no_model_call(monkeypatch):
    """스프레드시트 변환은 순수 계산이다 — 모델을 부르면 그때가 15분 타임아웃의 시작이었다."""
    called = []
    monkeypatch.setattr(kb_documents.bedrock_runtime, "converse",
                        lambda **kw: called.append(kw) or {"output": {"message": {"content": [{"text": ""}]}}})
    md = kb_documents._extract_page_text(_xlsx({"시트": [HEADER] + BODY}), "무모델.xlsx")
    assert md and called == [], "모델을 호출했다"
