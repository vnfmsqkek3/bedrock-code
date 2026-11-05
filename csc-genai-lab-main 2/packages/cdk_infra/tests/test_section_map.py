"""페이지→절 맵 회귀 테스트.

인제스트가 전사본에서 뽑아 두는 맵이다. 질의 시점에 그림의 헤딩끼리 비교해 절을 되살리던
방식이 계속 깨졌기 때문에(제조사가 여러 절에 걸치면 이름이 상쇄되고, 파서가 헤딩을 안 남긴
페이지는 절이 아예 없었다) 인덱싱 시점에 한 번 적어 두는 쪽으로 옮겼다.

실행: pytest packages/cdk_infra/tests/test_section_map.py
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("KB_BUCKET", "test-bucket")
os.environ.setdefault("STATUS_BUCKET", "test-status")

sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1]
        / "src/backend/kb_management/lambda/kb_documents"),
)

from kb_documents import _page_sections  # noqa: E402

# 실제 전사본 모양 — 프롬프트가 페이지 마커 뒤와 각 블록 앞에 〔section: …〕을 넣는다.
TRANSCRIPT = """[p1]
〔section: 메가존 빌딩 복합기 스캐너 설치 매뉴얼〕

# 메가존 빌딩

[p2]
〔section: 01 층별 복합기 정보〕

## 01 층별 복합기 정보

| 층 | 제조사 |
|---|---|

[p4]
〔section: 02 삼성 복합기 드라이버 설치 방법 (Windows ver.)〕

## 02 삼성 복합기 드라이버 설치 방법 (Windows ver.)

〔section: 02 삼성 복합기 드라이버 설치 방법 (Windows ver.)〕

**[화면 1]** 다운로드 링크 버튼

[p5]
〔section: 02 삼성 복합기 드라이버 설치 방법 (Windows ver.)〕

**[화면 2]** 설치 마법사

[p6]
본문만 있고 절 표시가 없는 페이지

[p15]
〔section: 07 코니카 미놀타 복합기 드라이버 설치 방법 (Windows ver.)〕

**[화면 1]** 사용권 계약
"""


def test_every_page_gets_a_section():
    m = _page_sections(TRANSCRIPT)["pages"]
    assert m["0"] == "메가존 빌딩 복합기 스캐너 설치 매뉴얼"
    assert m["1"] == "01 층별 복합기 정보"
    assert m["3"] == "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"
    assert m["14"] == "07 코니카 미놀타 복합기 드라이버 설치 방법 (Windows ver.)"


def test_a_page_without_its_own_marker_inherits_the_running_section():
    """절이 페이지를 걸쳐 이어지는 건 흔하다 — 빈칸으로 두면 그 페이지만 다시 추측 대상이 된다."""
    assert _page_sections(TRANSCRIPT)["pages"]["5"] == \
        "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"


def test_the_first_section_on_a_page_wins():
    """절 경계가 페이지 중간에 떨어져도 페이지 전체가 아래쪽 절로 뒤바뀌면 안 된다."""
    text = ("[p1]\n〔section: A절〕\n본문\n〔section: B절〕\n아래쪽에서 시작하는 절\n")
    assert _page_sections(text)["pages"]["0"] == "A절"


def test_sections_are_listed_in_document_order_without_duplicates():
    """절 정체를 재는 기준이라 순서와 중복 제거가 그대로 결과에 영향을 준다."""
    assert _page_sections(TRANSCRIPT)["sections"] == [
        "메가존 빌딩 복합기 스캐너 설치 매뉴얼",
        "01 층별 복합기 정보",
        "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)",
        "07 코니카 미놀타 복합기 드라이버 설치 방법 (Windows ver.)",
    ]


def test_markdown_headings_still_work_without_the_tag():
    """태그가 생기기 전에 전사된 문서도 맵을 낼 수 있어야 한다 — 재전사는 모델 호출이다."""
    legacy = "[p1]\n\n## 01 층별 복합기 정보\n\n표\n\n[p2]\n\n## 02 삼성 드라이버 설치\n\n화면\n"
    m = _page_sections(legacy)
    assert m["pages"] == {"0": "01 층별 복합기 정보", "1": "02 삼성 드라이버 설치"}
    assert m["sections"] == ["01 층별 복합기 정보", "02 삼성 드라이버 설치"]


def test_a_transcription_without_any_structure_yields_no_map():
    """근거가 없으면 빈 맵 — 호출자가 기존 방식으로 되돌아간다."""
    assert _page_sections("[p1]\n그냥 본문\n[p2]\n계속\n")["pages"] == {}
    assert _page_sections("")["pages"] == {}
