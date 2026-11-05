"""답변 세그먼트 회귀 테스트.

실제로 발생했던 버그들을 고정한다:
1. 세그먼트를 이어 붙였을 때 마크다운 테이블이 앞 문장에 달라붙어 깨짐
   (스트리밍 프록시가 세그먼트를 구분자 없이 연결한다)
2. 답변이 인용하지 않은 문서의 이미지가 페이지 번호만 같다는 이유로 붙음
3. 답변 내용과 무관한 이미지가 붙음 (페이지 단어 뭉치 겹침으로 판단하던 시절)

도메인 어휘를 코드에 박지 않는지도 함께 검증한다 — 어떤 단어가 흔한지는 corpus에서
측정되어야 하고, 문서 집합이 바뀌면 결과도 따라 바뀌어야 한다.

실행: pytest packages/cdk_infra/tests/test_image_segments.py
"""

import sys
from pathlib import Path

LAMBDA_DIR = (
    Path(__file__).resolve().parents[1]
    / "src/backend/basic_rest_api/lambda/qna_agent_rest_api"
)
sys.path.insert(0, str(LAMBDA_DIR))

from dispatch.bedrock_chat_router import (  # noqa: E402
    _CONTEXT_CHUNKS,
    BedrockChatRouter,
    _cited_numbers,
    _cited_page_keys,
    _figure_caption,
    _format_answer,
    _generic_tokens,
    _images_in_scope,
    _keep_pages_together,
    _round_robin,
    _scope_first,
    _strip_citations,
    _tokens,
)

DOC_A = "s3://kb/manual-a.pdf"
DOC_B = "s3://kb/manual-b.pdf"


def _router():
    """__init__(Bedrock 클라이언트 생성)을 건너뛴 빈 인스턴스."""
    return BedrockChatRouter.__new__(BedrockChatRouter)


def _image(uri, caption="", page=None, scope=None):
    """실제 Retrieve 응답 모양. description은 페이지 마크다운 + <figure> 캡션."""
    meta = {"x-amz-bedrock-kb-description": f"# 섹션\n<figure>\n{caption}\n</figure>\n"}
    if page is not None:
        meta["x-amz-bedrock-kb-document-page-number"] = page
    if scope is not None:
        meta["scope_key"] = scope
    return {
        "content": {"type": "IMAGE", "byteContent": "data:image/png;base64,AAAA"},
        "location": {"s3Location": {"uri": uri}},
        "metadata": meta,
    }


def _cand(doc, caption="", page=0, scope=""):
    """_match_images_to_text가 만들어 내는 직렬화 가능한 후보 모양."""
    return {
        "doc": doc,
        "page": page,
        "caption": caption,
        "scope_key": scope,
        "data": "",
        # 실제 경로에서는 S3 presigned URL. 테스트는 업로드 없이 이 값을 쓴다.
        "url": f"https://example.invalid/{doc.split('/')[-1]}-p{page}.png",
    }


def _text(uri, text, page=None):
    meta = {}
    if page is not None:
        meta["x-amz-bedrock-kb-document-page-number"] = page
    return {
        "content": {"type": "TEXT", "text": text},
        "location": {"s3Location": {"uri": uri}},
        "metadata": meta,
    }


# ── 1. 마크다운 ──────────────────────────────────────────────────────────────

ANSWER_WITH_TABLE = """총 14대가 있습니다.

| 층 | 제조사 |
|---|---|
| 2층 | BROTHER |
| 4층 | SAMSUNG |

자세한 내용은 매뉴얼을 참고하세요."""


def test_segments_rejoin_without_breaking_the_table():
    """세그먼트를 그대로 이어 붙여도 테이블 앞의 빈 줄이 살아 있어야 한다."""
    segments = _router()._parse_image_markers(ANSWER_WITH_TABLE, {})

    joined = "".join(s["text"] for s in segments if s["type"] == "text")
    assert "있습니다.| 층" not in joined, "테이블이 앞 문장에 달라붙었다"
    assert "\n\n| 층 | 제조사 |" in joined
    assert "|---|---|\n| 2층" in joined, "테이블 행 사이에 빈 줄이 끼면 안 된다"


# ── 2. 변별력은 corpus에서 측정된다 ──────────────────────────────────────────


def test_generic_tokens_are_measured_not_declared():
    """흔한 단어는 corpus마다 다르다. 같은 단어가 corpus에 따라 반대로 분류돼야 한다."""
    printer_corpus = [
        "프린터 드라이버 설치 방법",
        "프린터 드라이버 설치 순서",
        "프린터 설치 확인",
        "프린터 드라이버 제거",
        "프린터 스캔 설정",
        "계약 해지 조항",
    ]
    contract_corpus = [
        "계약 조항 제1조",
        "계약 조항 제2조",
        "계약 해지 조항",
        "계약 갱신 조항",
        "계약 당사자 조항",
        "프린터 드라이버 설치",
    ]

    printer_generic = _generic_tokens(printer_corpus)
    contract_generic = _generic_tokens(contract_corpus)

    # 복합기 문서에서는 "프린터"가 흔해서 근거가 못 된다
    assert "프린터" in printer_generic
    # 계약 문서에서는 같은 단어가 오히려 변별력을 가진다
    assert "프린터" not in contract_generic
    assert "계약" in contract_generic
    assert "계약" not in printer_generic


def test_small_corpus_excludes_nothing():
    """측정할 표본이 없으면 아무것도 흔하다고 단정하지 않는다."""
    assert _generic_tokens(["프린터 설치", "프린터 제거"]) == set()


def test_tokenizer_handles_mixed_scripts():
    toks = _tokens("KONICA Bizhub 028DN 10층 10.13.1.241 복합기")
    assert {"konica", "bizhub", "10층", "10.13.1.241", "복합기"} <= toks


# ── 3. 2차 검색 결과가 컨텍스트 상한에서 잘리지 않아야 한다 ──────────────────


def test_second_round_results_survive_the_context_cap():
    """2차 검색은 1차에 없던 정보를 가져오려고 도는 것이다.

    이어 붙이면 결과가 많을 때 상한 뒤로 밀려 통째로 잘린다 — 정답 청크를 가져오고도
    모델이 못 보고 "자료에 없다"고 답한다.
    """
    pass1 = [f"round1-{i}" for i in range(50)]
    pass2 = [f"round2-{i}" for i in range(5)]

    # 기존 동작(이어 붙이기)에서는 2차 결과가 상한 안에 하나도 못 들어온다
    assert not [r for r in (pass1 + pass2)[:_CONTEXT_CHUNKS] if r.startswith("round2")]

    merged = _round_robin([pass1, pass2])
    within_cap = [r for r in merged[:_CONTEXT_CHUNKS] if r.startswith("round2")]
    assert len(within_cap) == len(pass2), "2차 결과가 전부 상한 안에 들어와야 한다"
    # 각 라운드의 내부 순서(관련도 순)는 보존된다
    assert [r for r in merged if r.startswith("round1")] == pass1


def test_round_robin_handles_a_single_round():
    assert _round_robin([["a", "b"], []]) == ["a", "b"]


def test_the_second_round_does_not_take_half_the_context():
    """2차 검색이 15칸 중 7칸을 가져가면 1차의 8위 아래가 통째로 잘린다.

    실제 사례: "과천 4층" 질문에 필요한 층별 IP 표가 1차 14위에 있었는데, 2차 결과가 한 칸씩
    끼어들며 상한 밖으로 밀어냈고 답변은 "4층 복합기 정보가 자료에 없다"가 됐다.
    """
    pass1 = [f"a{i}" for i in range(20)]
    pass2 = [f"b{i}" for i in range(20)]

    merged = _round_robin([pass1, pass2], (3, 1))
    top = merged[:_CONTEXT_CHUNKS]

    assert sum(1 for r in top if r.startswith("b")) < _CONTEXT_CHUNKS // 2, "2차가 절반을 넘본다"
    assert "a10" in top, "1차 11위까지는 상한 안에 있어야 한다"
    assert [r for r in merged if r.startswith("a")] == pass1, "라운드 내부 순서는 보존"
    assert len(merged) == len(pass1) + len(pass2), "무엇도 버리지 않는다"


def test_round_robin_still_lands_the_second_round_inside_the_cut():
    """비율을 줬다고 2차가 상한 밖으로 밀려나면 이어 붙이기와 같아진다."""
    merged = _round_robin([[f"a{i}" for i in range(50)], ["b0", "b1"]], (3, 1))
    assert {"b0", "b1"} <= set(merged[:_CONTEXT_CHUNKS])


def _chunk(scope, tag):
    return {"content": {"text": tag}, "metadata": {"scope_key": scope}, "tag": tag}


def test_the_asked_about_subject_leads_the_context():
    """다른 대상의 큰 문서가 검색 결과를 뒤덮어도 질문한 대상이 앞에 와야 한다.

    실제 사례: "메가존빌딩 4층" 질문에 상위 8건 중 6건이 과천사옥이었고, 컨텍스트 상한에서
    잘리자 모델이 옆 건물 절차를 옮겨 적었다.
    """
    results = [
        _chunk("subject-a", "a1"), _chunk("subject-b", "b1"), _chunk("subject-b", "b2"),
        _chunk("subject-b", "b3"), _chunk("subject-a", "a2"), _chunk("subject-b", "b4"),
    ]
    ordered = _scope_first(results, {"subject-a"})

    assert [r["tag"] for r in ordered[:2]] == ["a1", "a2"], "질문한 대상이 앞에 와야 한다"
    # 걸러내지 않는다 — 자리가 남으면 다른 대상 자료도 그대로 들어간다
    assert len(ordered) == len(results)
    assert [r["tag"] for r in ordered[2:]] == ["b1", "b2", "b3", "b4"], "그룹 내 순서 보존"


def test_scope_first_is_a_noop_without_an_identified_subject():
    results = [_chunk("subject-b", "b1"), _chunk("subject-a", "a1")]
    assert _scope_first(results, set()) == results


def _page_chunk(doc, page, text):
    return {
        "content": {"text": f"[p{page}] {text}"},
        "location": {"s3Location": {"uri": f"{doc}.text.md"}},
        "metadata": {},
        "tag": text,
    }


def test_the_two_halves_of_one_page_stay_together():
    """설명 문단과 표가 다른 청크로 갈려도 함께 전달돼야 한다.

    실제 사례: 과천 4층 p.8이 "표가 있다"는 설명(4위)과 표 본문(19위)으로 쪼개져 있었고,
    컨텍스트 상한 15에서 표만 잘려 모델이 "상세 정보가 자료에 없다"고 답했다.
    """
    doc = "s3://kb/manual-a.pdf"
    results = (
        [_page_chunk(doc, 8, "4층 평면도 설명")]
        + [_page_chunk(doc, 99, f"noise{i}") for i in range(13)]
        + [_page_chunk(doc, 8, "4층 표 본문")]
    )
    ordered = _keep_pages_together(results)
    top = [r["tag"] for r in ordered[:_CONTEXT_CHUNKS]]

    assert "4층 평면도 설명" in top
    assert "4층 표 본문" in top, "같은 페이지의 나머지 절반이 잘렸다"
    assert len(ordered) == len(results), "무엇도 버리거나 더하지 않는다"


def test_page_grouping_keeps_the_best_page_first():
    doc = "s3://kb/manual-a.pdf"
    results = [_page_chunk(doc, 3, "a"), _page_chunk(doc, 9, "b"), _page_chunk(doc, 3, "c")]
    assert [r["tag"] for r in _keep_pages_together(results)] == ["a", "c", "b"]


# ── 4. 이미지 선택 ───────────────────────────────────────────────────────────

# 두 문서가 공유하는 일반 어휘 — corpus에서 흔하다고 측정될 것
COMMON = "장비 설치 안내 문서 페이지 그림 화면"
CORPUS = [
    f"{COMMON} 자료 1",
    f"{COMMON} 자료 2",
    f"{COMMON} 자료 3",
    f"{COMMON} 자료 4",
    f"{COMMON} 자료 5",
    f"{COMMON} XR-500 세부 절차",
    f"{COMMON} QT-900 세부 절차",
]

ANSWER_ABOUT_XR500 = (
    "요청하신 장비는 **XR-500** 입니다.\n\n"
    "XR-500 마법사에서 포트를 선택한 뒤 설치를 진행합니다."
)
XR500_FIGURE = f"{COMMON} XR-500 마법사 포트 선택 단계"
QT900_FIGURE = f"{COMMON} QT-900 초기 등록 단계"


def test_image_must_share_a_corpus_rare_token_with_the_block():
    """블록과 캡션이 '이 corpus에서 드문' 토큰을 여럿 공유할 때만 붙인다."""
    matched = {
        (DOC_A, 5): _cand(DOC_A, XR500_FIGURE, page=5),
        (DOC_B, 6): _cand(DOC_B, QT900_FIGURE, page=6),
    }
    segments = _router()._parse_image_markers(ANSWER_ABOUT_XR500, matched, CORPUS)
    images = [s for s in segments if s["type"] == "image"]

    assert len(images) == 1
    assert "manual-a" in images[0]["name"]


def test_one_shared_word_is_not_enough():
    """지나가는 언급 한 번으로 그림이 붙으면 안 된다."""
    matched = {(DOC_B, 6): _cand(DOC_B, QT900_FIGURE, page=6)}
    segments = _router()._parse_image_markers(
        "다른 장비로는 **QT-900** 도 있습니다.", matched, CORPUS
    )
    assert [s for s in segments if s["type"] == "image"] == []


def test_image_carries_its_offset_into_the_answer():
    """스트리밍 경로에서는 클라이언트가 위치를 잴 수 없어 서버가 at을 실어 보내야 한다."""
    matched = {(DOC_A, 5): _cand(DOC_A, XR500_FIGURE, page=5)}
    segments = _router()._parse_image_markers(ANSWER_ABOUT_XR500, matched, CORPUS)

    text = "".join(s["text"] for s in segments if s["type"] == "text")
    img = next(s for s in segments if s["type"] == "image")
    assert isinstance(img["at"], int)
    assert 0 < img["at"] <= len(text)
    # at 앞부분이 그 이미지를 부른 블록으로 끝나야 한다
    assert "XR-500" in text[: img["at"]]


# 모델이 실제로 내는 본문에는 줄 끝 공백과 여분의 빈 줄이 섞인다. 블록을 다시 이어 붙인
# 문자열은 그것들을 잃어버리므로, 재조립본 위에서 오프셋을 세면 원본과 어긋난다. 그림이
# 마지막 블록에 붙으면 어긋남이 드러나지 않으므로, 그림 뒤에 블록을 하나 더 둔다.
_LEAD_BLOCK = "요청하신 장비는 **XR-500** 입니다.   "
_FIGURE_BLOCK = "XR-500 마법사에서 포트를 선택한 뒤 **설치**를 진행합니다."
_TAIL_BLOCK = "그 다음 화면에서 마침을 누릅니다."
ANSWER_WITH_LOOSE_SPACING = f"{_LEAD_BLOCK}\n\n\n\n{_FIGURE_BLOCK}\n\n{_TAIL_BLOCK}"


def test_offset_indexes_the_original_answer_not_the_rejoined_blocks():
    """이미지는 문장 한가운데가 아니라 블록이 끝난 자리에서만 끼어들어야 한다.

    클라이언트는 모델이 낸 원본 본문을 at으로 자른다. 오프셋을 블록 재조립본 위에서 세면
    버려진 빈 줄·후행 공백만큼 밀려, 실제로 "**확|인**"처럼 단어 한가운데가 잘려 나왔다.
    """
    matched = {(DOC_A, 5): _cand(DOC_A, XR500_FIGURE, page=5)}
    segments = _router()._parse_image_markers(ANSWER_WITH_LOOSE_SPACING, matched, CORPUS)

    # 세그먼트를 이어 붙이면 원본 그대로여야 오프셋의 기준이 성립한다.
    text = "".join(s["text"] for s in segments if s["type"] == "text")
    assert text == ANSWER_WITH_LOOSE_SPACING

    # 그림을 부른 블록이 원본에서 끝나는 바로 그 자리여야 한다.
    at = next(s for s in segments if s["type"] == "image")["at"]
    assert at == ANSWER_WITH_LOOSE_SPACING.index(_FIGURE_BLOCK) + len(_FIGURE_BLOCK)
    assert ANSWER_WITH_LOOSE_SPACING[:at].endswith("진행합니다.")


def test_a_citation_with_words_inside_the_brackets_still_counts():
    """"[출처 6 그림 참조]"처럼 괄호 안에 말이 붙어도 인용으로 세어야 한다.

    실제 사례: LED 치수 질문에서 모델이 도면을 "[출처 6 그림 참조]"로 가리켰다. 이 형태를
    못 알아보자 출처 6이 인용 목록에서 빠졌고, 인용된 페이지로 그림을 거르는 단계에서
    정작 그 도면(p.6)이 후보에서 탈락했다. 화면에는 상관없는 제품 사진(p.1)만 남고,
    지워지지도 않은 대괄호가 본문에 그대로 노출됐다.
    """
    assert _cited_numbers("아래는 치수입니다. [출처 6 그림 참조]") == {6}
    assert _cited_numbers("자세한 내용은 [출처 6의 그림] 참고") == {6}
    # 기존에 이미 되던 형태도 그대로 된다
    assert _cited_numbers("문장.[6]") == {6}
    assert _cited_numbers("문장.[1][2]") == {1, 2}
    assert _cited_numbers("문장.[출처 6]") == {6}


def test_reading_and_erasing_a_citation_agree():
    """세는 것과 지우는 것이 어긋나면 마커가 화면에 남는다 — 같은 것을 가리켜야 한다."""
    assert _strip_citations("아래는 치수입니다. [출처 6 그림 참조]") == "아래는 치수입니다."
    assert _strip_citations("문장.[1][2]") == "문장."


def test_erasing_citations_leaves_real_content_alone():
    """숫자로 시작하는 괄호를 무엇이든 삼키면 본문이 지워진다."""
    for text in ("전체 높이: [35.5 ± 0.55]", "페이지 마커 [p6] 은 인용이 아니다", "표 항목 [A] 참고"):
        assert _strip_citations(text) == text
        assert _cited_numbers(text) == set()


def test_emphasis_split_across_a_soft_wrap_is_rejoined():
    """볼드 한가운데서 줄이 바뀌면 문단이 갈려 별표가 그대로 보인다.

    실제 사례: 모델이 "**TLHR540. (Red\\n빨간색)**"처럼 긴 라벨을 접어 냈고, 줄 단위로
    블록을 다시 쌓는 과정에서 그 접힘이 빈 줄로 승격돼 ** 짝이 두 블록으로 갈라졌다.
    챗봇 창에는 마크다운이 끊긴 채 별표가 노출됐다.
    """
    formatted = _format_answer(
        "자료에는 아래 두 가지 제품이 있습니다:\n\n"
        "- **TLHR540. (Red\n빨간색)**\n"
        "- **TLHY540. (Yellow\n노란색)**\n"
    )

    assert "**TLHR540. (Red 빨간색)**" in formatted
    assert "**TLHY540. (Yellow 노란색)**" in formatted
    # 어느 줄에서도 ** 짝이 열린 채 끝나면 안 된다.
    assert not [ln for ln in formatted.split("\n") if ln.count("**") % 2]


def test_rejoining_never_welds_two_table_rows():
    """표의 셀에 볼드가 있으면 행마다 ** 개수가 홀수일 수 있다 — 행을 붙이면 표가 깨진다."""
    table = "| 항목 | 값 |\n|---|---|\n| **VF** | 2 V |\n| **VR** | 6 V |"
    assert _format_answer(table).count("\n| **VR**") == 1


def test_the_answer_is_delivered_as_the_model_wrote_it():
    """Custom RAG 경로는 모델이 쓴 마크다운을 다시 짜지 않는다.

    _format_answer는 기본 RAG 프롬프트의 run-on 출력을 줄로 쪼개려고 만든 것이라, 이미
    잘 쓰인 마크다운을 넣으면 오히려 부순다: 들여쓴 하위 목록이 최상위로 승격돼 부모
    단계에서 떨어져 나가고, 번호 목록 사이에 빈 줄이 끼어 목록이 조각난다. 스트리밍
    중에는 멀쩡하다가 다 쓰고 나서 깨져 보이던 원인이 이것이었다.

    여기서는 그 손상이 실재함을 고정한다 — 이 성질이 사라지면 finalize 경로에 다시
    끼워 넣어도 되지만, 그때까지는 끼워 넣으면 안 된다.
    """
    written_by_the_model = (
        "1. 브라더 드라이버 링크에 접속합니다\n"
        "2. 다음 항목을 입력합니다\n"
        "   - 이름\n"
        "   - 이메일 주소\n"
        "3. **확인** 버튼 클릭"
    )
    reshaped = _format_answer(written_by_the_model)

    assert "   - 이름" not in reshaped, "하위 목록의 들여쓰기가 살아 있다면 이 테스트는 낡았다"
    assert "\n\n- 이름" in reshaped, "들여쓴 항목이 최상위 목록으로 승격돼 부모와 끊긴다"


# 같은 절차를 대상만 바꿔 설명하는 두 절 — 캡션의 단어가 대부분 겹친다.
SIBLING_CORPUS = [
    "장비 스캔 이용방법 주소록 이메일 등록 화면 터치 자료 1",
    "장비 스캔 이용방법 주소록 이메일 등록 화면 터치 자료 2",
    "장비 스캔 이용방법 주소록 이메일 등록 화면 터치 자료 3",
    "장비 스캔 이용방법 주소록 이메일 등록 화면 터치 자료 4",
    "장비 스캔 이용방법 주소록 이메일 등록 화면 터치 자료 5",
    "XR-500 스캔 이용방법",
    "QT-900 스캔 이용방법",
]
SIBLING_IMAGES = {
    (DOC_A, 36): _cand(
        DOC_A, "XR-500 준비 화면과 대상 선택 화면. 주소록 이메일 등록 화면 터치", page=36),
    (DOC_A, 32): _cand(
        DOC_A, "QT-900 복사 메뉴와 팩스 메뉴. 주소록 이메일 등록 화면 터치", page=32),
}
for _c, _h in ((SIBLING_IMAGES[(DOC_A, 36)], "07 XR-500 스캔 이용방법"),
               (SIBLING_IMAGES[(DOC_A, 32)], "06 QT-900 스캔 이용방법")):
    _c["heading"] = _h


def test_figure_whose_subject_the_answer_never_mentions_is_dropped():
    """답변이 XR-500 얘기만 하는데 QT-900 그림이 붙으면 안 된다.

    두 절이 같은 절차를 다루면 '이메일·주소록·등록' 같은 말이 양쪽에 다 있어 구분이 안 된다.
    후보끼리 비교해 뽑은 정체 토큰(XR-500 / QT-900)만이 어느 쪽인지 말해 준다.
    """
    answer = (
        "**XR-500** 장비의 스캔 방법입니다.\n\n"
        "**① 이메일 주소 등록 (최초 1회)**\n\n"
        "XR-500 준비 화면에서 대상 선택 후 스캔을 진행합니다."
    )
    segments = _router()._parse_image_markers(answer, SIBLING_IMAGES, SIBLING_CORPUS)
    pages = [s["page"] for s in segments if s["type"] == "image"]

    assert 37 in pages, "XR-500 그림은 붙어야 한다"
    assert 33 not in pages, "답변에 없는 QT-900 그림이 붙었다"


def test_subject_name_alone_does_not_place_a_figure():
    """주제만 언급하고 그림이 그린 내용은 없는 블록에는 붙지 않아야 한다.

    실제 사례: "브라더는 스캔 불가, 삼성 또는 신도 복합기를 이용하세요"라는 주의 문구에
    신도 절 그림이 붙었다. 절 이름은 자격 판단용이고, 자리는 캡션 내용으로 정해야 한다.
    """
    answer = (
        "**XR-500** 장비의 스캔 방법입니다.\n\n"
        "XR-500 준비 화면에서 대상 선택 후 스캔을 진행합니다.\n\n"
        "> 주의: XR-500 과 QT-900 은 서로 다른 장비입니다. QT-900 은 별도 안내를 참고하세요."
    )
    segments = _router()._parse_image_markers(answer, SIBLING_IMAGES, SIBLING_CORPUS)
    placed = [(s["page"], s["at"]) for s in segments if s["type"] == "image"]
    text = "".join(s["text"] for s in segments if s["type"] == "text")

    assert 33 not in [p for p, _ in placed], "이름만 언급한 블록에 QT-900 그림이 붙었다"
    for page, at in placed:
        assert "준비 화면" in text[:at], "그림이 자기 내용을 설명한 블록 뒤에 와야 한다"


def test_passing_mention_of_another_section_does_not_pull_in_its_figure():
    """답변 끝의 한 줄 언급으로 다른 절 그림이 앞에 붙던 문제.

    실제 사례: 삼성 스캔 답변 끝 "삼성 또는 신도 복합기를 이용하세요" 한 줄 때문에
    신도 절 그림이 답변 맨 앞에 붙었다.
    """
    answer = (
        "**XR-500** 장비의 스캔 방법입니다.\n\n"
        "XR-500 준비 화면에서 대상 선택 후 스캔을 진행합니다.\n\n"
        "> 참고: 이 절차가 안 되면 **QT-900** 장비를 이용하세요."
    )
    segments = _router()._parse_image_markers(answer, SIBLING_IMAGES, SIBLING_CORPUS)
    pages = [s["page"] for s in segments if s["type"] == "image"]

    assert 33 not in pages, "지나가는 언급만으로 QT-900 그림이 붙었다"


def test_no_figure_when_the_answer_has_not_chosen_between_subjects():
    """선택지를 나열하고 되묻는 답변에 한쪽 그림만 붙이면 답을 지어내는 셈이다."""
    answer = "장비 모델이 두 가지(**XR-500**, **QT-900**)로 나뉘어 있습니다. 어느 모델인지 알려주세요."
    segments = _router()._parse_image_markers(answer, SIBLING_IMAGES, SIBLING_CORPUS)
    assert [s for s in segments if s["type"] == "image"] == []


def test_citation_covers_the_other_pages_the_answer_used():
    """청크가 걸친 다른 페이지도, 답변이 그 페이지의 말을 썼다면 인용된 것이다.

    대표 페이지만 세면 같은 절의 다음 화면 그림이 배제되어 본문 단계와 그림이 어긋난다.
    """
    chunk = {
        "content": {"text": "[p31] 절 제목\n[p32] 주소록에 추가하고 적용을 누른다"},
        "location": {"s3Location": {"uri": f"{DOC_A}.text.md"}},
        "metadata": {},
    }
    answer = "주소록에서 추가를 누르고 적용을 클릭합니다."
    keys = _cited_page_keys([{"number": 1}], [chunk], answer)

    assert (DOC_A, 30) in keys      # [p31] 대표 페이지
    assert (DOC_A, 31) in keys      # [p32] — 답변이 그 페이지의 말을 쓴다


def test_citation_does_not_open_pages_the_answer_never_used():
    """계층형 청킹의 부모 청크는 여러 페이지를 걸친다 — 전부 열면 필터가 사라진다.

    실제 사례: 메가존빌딩 2층(브라더) 질문에 4층 IP 입력 화면(p.18)과 삼성 설치 화면이
    붙었다. 두 페이지 모두 인용된 청크가 '걸쳐만 있었을 뿐' 답변은 그 내용을 쓰지 않았다.
    """
    chunk = {
        "content": {"text": (
            "[p8] 브라더 드라이버 다운로드 링크 접속 화면\n"
            "[p9] Brother 인쇄 장치 설치 언어 선택 화면\n"
            "[p18] 브라우저 주소창에 10.4.2.241 을 입력\n"
            "[p5] Samsung M267x 287x Series 설치 마법사"
        )},
        "location": {"s3Location": {"uri": f"{DOC_A}.text.md"}},
        "metadata": {},
    }
    answer = (
        "브라더 드라이버 다운로드 링크에 접속합니다. "
        "Brother 인쇄 장치 설치에서 언어 선택 후 다음을 클릭합니다. "
        "2층 복합기 IP는 10.2.1.243 입니다."
    )
    keys = _cited_page_keys([{"number": 1}], [chunk], answer)

    assert (DOC_A, 7) in keys, "대표 페이지"
    assert (DOC_A, 8) in keys, "답변이 쓴 페이지"
    assert (DOC_A, 17) not in keys, "4층 IP 화면 — 답변이 쓰지 않았다"
    assert (DOC_A, 4) not in keys, "삼성 설치 화면 — 브라더 답변과 무관"


def test_citation_covers_the_whole_span_when_there_is_no_answer_to_check():
    """답변을 못 받은 호출자에게는 예전 동작이 그대로 남는다."""
    chunk = {
        "content": {"text": "[p31] 절 제목\n[p32] 주소록에 추가하고 적용을 누른다"},
        "location": {"s3Location": {"uri": f"{DOC_A}.text.md"}},
        "metadata": {},
    }
    assert _cited_page_keys([{"number": 1}], [chunk]) == {(DOC_A, 30), (DOC_A, 31)}


def test_citation_ignores_out_of_range_numbers():
    """모델이 존재하지 않는 출처 번호를 쓰더라도 터지지 않아야 한다."""
    assert _cited_page_keys([{"number": 99}, {}], []) == set()


def test_each_figure_goes_to_the_block_it_best_matches():
    """앞쪽의 두루뭉술한 블록이 그림을 먼저 채가면 안 된다.

    실제 사례: 제목과 정보 표가 다운로드/설치 그림을 집어가 14·15가 15·14로 뒤집혔고,
    정작 그 그림이 그리고 있는 단계 블록에는 아무것도 남지 않았다.
    """
    section = "07 XR-500 설치 방법"
    imgs = {
        (DOC_A, 13): _cand(DOC_A, "다운로드 목록 화면. 압축 파일 ZIP 선택", page=13),
        (DOC_A, 14): _cand(DOC_A, "사용권 계약 화면. 동의 버튼과 언어 선택", page=14),
    }
    for c in imgs.values():
        c["heading"] = section

    answer = (
        "## XR-500 설치 방법 (Windows)\n\n"
        "장비 정보를 먼저 확인합니다. 압축 동의 목록 계약 화면 선택 파일\n\n"
        "**1단계.** 다운로드 목록에서 압축 ZIP 파일을 받습니다.\n\n"
        "**2단계.** 사용권 계약 화면에서 언어 선택 후 동의 버튼을 누릅니다."
    )
    segments = _router()._parse_image_markers(answer, imgs, SIBLING_CORPUS)
    pages = [s["page"] for s in segments if s["type"] == "image"]

    assert pages == [14, 15], "각 그림이 자기 단계 블록으로 가야 한다"

    # 그림이 자기를 부른 단계 뒤에 놓였는지 오프셋으로 확인
    text = "".join(s["text"] for s in segments if s["type"] == "text")
    for seg in segments:
        if seg["type"] != "image":
            continue
        before = text[: seg["at"]]
        assert ("1단계" in before) if seg["page"] == 14 else ("2단계" in before)


def test_a_wrong_section_with_several_pages_is_still_excluded():
    """절 판별은 페이지가 아니라 '절' 단위로 해야 한다.

    실제 사례: 브라더 연결 답변에 삼성 절 그림(p.4·p.5)이 붙었다. 삼성 절이 후보 페이지를
    2장 내니 페이지끼리 비교하면 '삼성'이 서로 상쇄돼 고유 토큰이 사라지고, 절 전체가
    '구분할 것 없음'으로 분류돼 무사통과했다.
    """
    wrong = "02 QT-900 드라이버 설치 방법 (Windows ver.)"
    right = "04 XR-500 드라이버 설치 방법 (Windows ver.)"
    imgs = {
        (DOC_A, 3): _cand(DOC_A, "다운로드 페이지 화면", page=3),
        (DOC_A, 4): _cand(DOC_A, "설치 마법사 화면", page=4),
        (DOC_A, 8): _cand(DOC_A, "다운로드 페이지 화면. 연결 유형 선택", page=8),
    }
    imgs[(DOC_A, 3)]["heading"] = wrong          # 같은 절, 페이지 2장
    imgs[(DOC_A, 4)]["heading"] = wrong
    imgs[(DOC_A, 8)]["heading"] = right

    answer = (
        "**XR-500** 연결 방법입니다.\n\n"
        "**1단계.** 다운로드 페이지에서 연결 유형을 선택해 내려받습니다.\n\n"
        "**2단계.** 설치 마법사 화면의 안내를 따릅니다."
    )
    segments = _router()._parse_image_markers(answer, imgs, SIBLING_CORPUS)
    pages = [s["page"] for s in segments if s["type"] == "image"]

    assert 9 in pages, "XR-500 절 그림은 붙어야 한다"
    assert 4 not in pages and 5 not in pages, "QT-900 절 그림이 붙었다"


def test_consecutive_pages_of_one_section_are_kept():
    """헤딩이 같은 연속 페이지는 서로 구분할 근거가 없다 — 절 전체가 답변의 대상이므로 남긴다.

    "고유 토큰이 없으면 배제"로 만들면 한 절이 여러 페이지에 걸친 절차 그림이 통째로 사라진다.
    """
    section = "07 XR-500 설치 방법"
    imgs = {
        (DOC_A, 13): _cand(DOC_A, "다운로드 목록 화면. ZIP 파일 선택", page=13),
        (DOC_A, 14): _cand(DOC_A, "사용권 계약 화면. 동의 버튼", page=14),
    }
    for c in imgs.values():
        c["heading"] = section

    answer = (
        "**XR-500** 설치 방법입니다.\n\n"
        "**1단계.** 다운로드 목록에서 ZIP 파일을 받습니다.\n\n"
        "**2단계.** 사용권 계약 화면에서 동의를 누릅니다."
    )
    segments = _router()._parse_image_markers(answer, imgs, SIBLING_CORPUS)
    assert len([s for s in segments if s["type"] == "image"]) == 2


def test_no_image_when_only_common_words_overlap():
    """일반 어휘만 겹치면 근거가 없다 — 틀린 그림보다 없는 편이 낫다."""
    matched = {(DOC_B, 6): _cand(DOC_B, f"{COMMON} QT-900 설치 화면", page=6)}
    segments = _router()._parse_image_markers(
        "장비 설치 안내 문서를 확인하세요.", matched, CORPUS
    )
    assert [s for s in segments if s["type"] == "image"] == []


def test_images_without_a_caption_are_skipped():
    """무엇을 담았는지 모르면 붙이지 않는다 — 판단 근거 자체가 없다."""
    router = _router()
    text_results = [_text(DOC_A, "본문 [p3]")]
    no_caption = _image(DOC_A, "", page=2)
    no_caption["metadata"].pop("x-amz-bedrock-kb-description")

    assert _figure_caption(no_caption) == ""
    assert router._match_images_to_text(text_results, [no_caption]) == {}


def test_figures_from_another_subject_are_dropped():
    """본문은 다른 문서를 인용할 수 있지만, 그림은 캡션에 출처명이 붙어 나가 모순돼 보인다."""
    matched = {
        (DOC_A, 6): _cand(DOC_A, "설치 화면", page=6, scope="subject-a"),
        (DOC_B, 9): _cand(DOC_B, "설치 화면", page=9, scope="subject-b"),
    }
    kept = _images_in_scope(matched, {"subject-a"})
    assert set(kept) == {(DOC_A, 6)}


def test_documents_without_scope_metadata_are_kept():
    """scope를 쓰지 않는 문서 집합에서 그림이 통째로 사라지면 안 된다."""
    matched = {(DOC_A, 6): _cand(DOC_A, "설치 화면", page=6, scope="")}
    assert _images_in_scope(matched, {"subject-a"}) == matched


def test_no_identified_scope_keeps_everything():
    matched = {(DOC_A, 6): _cand(DOC_A, "설치 화면", page=6, scope="subject-a")}
    assert _images_in_scope(matched, set()) == matched


def test_multi_subject_question_allows_each_subject():
    matched = {
        (DOC_A, 6): _cand(DOC_A, "설치 화면", page=6, scope="subject-a"),
        (DOC_B, 9): _cand(DOC_B, "설치 화면", page=9, scope="subject-b"),
    }
    kept = _images_in_scope(matched, {"subject-a", "subject-b"})
    assert set(kept) == {(DOC_A, 6), (DOC_B, 9)}


# 실제 KB에서 그대로 가져온 절 구성 — 한 문서 안에 제조사별 설치 절이 나란히 있다.
REAL_SECTIONS = {
    (DOC_A, 3): ("02 삼성 복합기 드라이버 설치 방법 (Windows ver.)",
                 "다운로드 링크 버튼에 커서. 삼성 다운로드 자료실 페이지에서 모델명 검색"),
    (DOC_A, 4): ("02 삼성 복합기 드라이버 설치 방법 (Windows ver.)",
                 "Samsung M267x 287x Series 드라이버 설치 마법사 화면. 언어 선택 후 동의 클릭"),
    (DOC_A, 14): ("07 코니카 미놀타 복합기 드라이버 설치 방법 (Windows ver.)",
                  "KONICA MINOLTA 설치 사용권 계약 화면. 언어 선택 후 동의 클릭"),
    (DOC_A, 7): ("04 브라더 복합기 & 스캔 드라이버 설치 방법 (Windows ver.)",
                 "브라더 드라이버 다운로드 링크 접속 화면. 다운로드 링크 버튼"),
    (DOC_A, 12): ("06 신도리코 복합기 드라이버 설치 방법 (Windows ver.)",
                  "신도리코 사이트 다운로드 링크 버튼에 커서"),
}
REAL_CORPUS = [
    "메가존빌딩 층별 복합기 정보 위치 제조사 모델명 IP 주소",
    "10층 업무공간 KONICA Bizhub 028DN 10.13.1.241",
    "코니카 미놀타 드라이버 다운로드 링크 접속 설치",
    "삼성 복합기 드라이버 다운로드 링크 접속 설치",
    "브라더 복합기 드라이버 다운로드 링크 접속 설치",
    "신도리코 복합기 드라이버 다운로드 링크 접속 설치",
    "설치 마법사 화면에서 언어 선택 후 동의 클릭",
]

# 사용자가 실제로 받은 답변 — 코니카 미놀타 설치 절차만 설명한다.
KONICA_ANSWER = (
    "메가존빌딩 10층 복합기는 KONICA MINOLTA Bizhub 028DN 입니다.\n\n"
    "**Step 1. 드라이버 다운로드**\n\n"
    "코니카 미놀타 드라이버 다운로드 링크에 접속합니다. "
    "Bizhub 028DN 드라이버 목록에서 423_Series_PCL 을 다운로드 합니다.\n\n"
    "**Step 2. 사용권 계약 동의**\n\n"
    "언어를 Korean 으로 선택하고 사용권 계약 내용을 확인 후 동의 버튼을 클릭합니다."
)


# 실제 과천사옥 매뉴얼의 절 목록 그대로 — 목차 줄과 본문 헤딩이 나란히 들어와 21개다.
# 절이 이만큼 많으면 정체 문턱(df ≤ 절 수의 절반 = 10)을 절차 낱말이 통과한다:
# 설치 7, 방법 8, 드라이버 9, ver 9. 절이 11개인 문서에서는 같은 낱말이 걸러진다.
LONG_SECTION_LIST = [
    "과천사옥 복합기 스캐너 설치 매뉴얼", "목차", "안내",
    "01. 층별 복합기 정보", "01 층별 복합기 정보",
    "02. 삼성 복합기 드라이버 (Windows ver. macOS ver.)",
    "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)",
    "02 삼성 복합기 드라이버 설치 방법 (macOS ver.)",
    "03. 신도 복합기 드라이버 (Windows ver. macOS ver.)",
    "03 신도 복합기 드라이버 설치 방법 (Windows ver.)",
    "03 신도 복합기 드라이버 설치 방법 (macOS ver.)",
    "04. 브라더 복합기 드라이버 (Windows ver. macOS ver.)",
    "04 브라더 복합기 & 스캔 드라이버 설치 방법 (Windows ver.)",
    "04 브라더 복합기 & 스캔 드라이버 설치 방법 (macOS ver.)",
    "05 근무지 이동시 복합기 아이피 변경 방법",
    "05. 근무지 이동 시 복합기 아이피 변경 방법",
    "06. 삼성 복합기 스캔 이용방법", "06 삼성 복합기 스캔 이용방법",
    "07. 신도 복합기 스캔 이용방법", "07 신도 복합기(N620) 스캔 이용방법",
    "07 신도 복합기(D321) 스캔 이용방법",
]


# 실제 메가존빌딩 매뉴얼의 절 구성 — 제조사마다 Windows/macOS/스캔 절이 따로 있어
# 제조사 이름이 여러 헤딩에 반복된다.
REAL_HEADINGS = [
    "01 층별 복합기 정보",
    "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)",
    "03 삼성 복합기 드라이버 설치 방법 (macOS ver.)",
    "04 브라더 복합기 & 스캔 드라이버 설치 방법 (Windows ver.)",
    "05 브라더 복합기 & 스캔 드라이버 설치 방법 (macOS ver.)",
    "06 신도리코 복합기 드라이버 설치 방법 (Windows ver.)",
    "07 코니카 미놀타 복합기 드라이버 설치 방법 (Windows ver.)",
    "1) 삼성 복합기 스캔",
    "2) 신도리코 & 코니카 미놀타 스캔",
]


def test_section_identity_is_measured_against_the_whole_document():
    """절 정체는 '이번에 검색된 그림'이 아니라 문서의 전체 절 목록으로 재야 한다.

    후보로 재면 같은 그림이 검색 운에 따라 통과했다 배제됐다 한다. 인제스트가 적어 둔
    절 목록(section_list)을 주면 어느 질문에서든 같은 결과가 나와야 한다.
    """
    from dispatch.bedrock_chat_router import _section_identity  # noqa: E402

    samsung = "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"
    # 이번 질의에 삼성 절 그림 하나만 검색된 최악의 경우
    lone = {(DOC_A, 4): {"heading": samsung}}

    without = _section_identity(lone)[(DOC_A, 4)]
    with_map = _section_identity(lone, tuple(REAL_HEADINGS))[(DOC_A, 4)]

    assert "삼성" in with_map, "전체 절 목록을 주면 '삼성'이 정체로 남아야 한다"
    # 후보만으로는 비교 대상이 없어 헤딩 전체가 정체가 되고, 흔한 말까지 섞여 들어온다.
    assert with_map < without or without != with_map, "전체 목록이 정체를 좁혀야 한다"


def test_a_maker_documented_in_several_sections_keeps_its_identity():
    """제조사에 절이 여러 개 있다고 그 이름이 정체에서 사라지면 안 된다.

    실제 사례: 메가존빌딩 매뉴얼은 "삼성"으로 시작하는 절이 셋(Windows 설치·macOS 설치·
    스캔)이다. 정확히 한 헤딩에만 있는 토큰만 정체로 인정하면 "삼성"이 상쇄되어 삼성 절의
    정체가 빈 집합이 되고, 빈 집합은 무조건 통과다. 브라더·코니카·신도리코도 마찬가지여서
    이 문서에서는 절 게이트가 통째로 죽어 있었다 — 코니카 답변에 삼성 설치 그림이 붙은
    원인이다.
    """
    pool = {
        (DOC_A, i): {"heading": h, "caption": "", "doc": DOC_A, "page": i, "url": "u"}
        for i, h in enumerate(REAL_HEADINGS)
    }
    from dispatch.bedrock_chat_router import _section_identity  # noqa: E402

    ident = _section_identity(pool)
    samsung = ident[(DOC_A, REAL_HEADINGS.index("02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"))]
    konica = ident[(DOC_A, REAL_HEADINGS.index("07 코니카 미놀타 복합기 드라이버 설치 방법 (Windows ver.)"))]

    assert "삼성" in samsung, "절이 셋이라는 이유로 '삼성'이 정체에서 빠졌다"
    assert samsung, "빈 정체는 모든 그림을 무조건 통과시킨다"
    assert {"코니카", "미놀타"} & konica, "'코니카/미놀타'가 상쇄됐다"
    # 절마다 붙는 흔한 말은 정체가 될 수 없다
    assert not ({"복합기", "드라이버", "설치", "방법"} & samsung)


def test_condition_words_survive_even_when_the_corpus_says_they_are_common():
    """조건어(플랫폼·버전)는 코퍼스에서 흔해도 절 정체에서 빠지면 안 된다.

    QA에서 나온 실제 결함: macOS 설치를 물었는데 Windows 절 그림이 붙었다. 원인은 절 게이트가
    코퍼스 흔한말 집합을 빼고 있었다는 것 — 한 문서가 같은 절차를 조건별로 나눠 설명하면
    그 조건어는 문서 어디에나 나오므로 코퍼스 기준으로 흔한말이 된다(인제스트가 블록마다 절
    제목을 반복해 적기 때문에 더 그렇다). 그러면 두 형제 절의 정체가 **완전히 같아지고**,
    같으면 서로를 이길 수 없어 게이트가 통째로 무력화된다(로그에 자격 줄이 아예 없었다).
    """
    from dispatch.bedrock_chat_router import _section_identity  # noqa: E402

    win = "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"
    mac = "03 삼성 복합기 드라이버 설치 방법 (macOS ver.)"
    pool = {(DOC_A, 4): {"heading": win}, (DOC_A, 6): {"heading": mac}}
    ident = _section_identity(pool, tuple(REAL_HEADINGS))

    assert "windows" in ident[(DOC_A, 4)], "조건어가 정체에서 빠졌다"
    assert "macos" in ident[(DOC_A, 6)], "조건어가 정체에서 빠졌다"
    assert ident[(DOC_A, 4)] != ident[(DOC_A, 6)], \
        "조건만 다른 두 절의 정체가 같아지면 서로를 이길 수 없다"


def test_a_macos_answer_does_not_pull_the_windows_section():
    """위 정체를 게이트에 걸면 실제로 Windows 절 그림이 배제되는지 (QA 재현 케이스)."""
    win = "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"
    mac = "03 삼성 복합기 드라이버 설치 방법 (macOS ver.)"
    pool = {
        (DOC_A, 4): _cand_with_heading((DOC_A, 4), win, "설치 마법사 화면 언어 선택 동의"),
        (DOC_A, 6): _cand_with_heading((DOC_A, 6), mac, "프린터 및 스캐너 화면에서 추가"),
    }
    answer = (
        "# 삼성 복합기 드라이버 설치 방법 (macOS)\n\n"
        "**1단계.** macOS 시스템 환경설정에서 프린터 및 스캐너를 엽니다.\n\n"
        "**2단계.** 추가 버튼을 눌러 IP를 입력합니다."
    )
    segments = _router()._parse_image_markers(
        answer, {(DOC_A, 4): pool[(DOC_A, 4)]}, REAL_CORPUS,
        sections=pool, section_list=tuple(REAL_HEADINGS),
    )
    assert [s for s in segments if s["type"] == "image"] == [], \
        "macOS 답변에 Windows 절 그림이 붙었다"


def test_a_passing_word_does_not_tie_with_the_word_the_answer_is_built_on():
    """절 점수는 '몇 개 나왔나'가 아니라 '얼마나 쓰였나'로 재야 한다.

    QA에서 나온 실제 결함: 스캔 방법을 물었는데 같은 제조사의 **설치** 절 그림이 함께 붙었다.
    답변이 '스캔'을 일곱 번 쓰는 동안, 설치 절은 제목에 든 '방법' 한 낱말이 답변 제목에
    나왔다는 이유로 같은 점수를 받았다. 동점이면 형제끼리 서로를 이기지 못해 둘 다 통과한다.

    절이 많은 문서일수록 심해진다 — 정체 토큰을 'df ≤ 절 수의 절반'으로 뽑으므로, 절이 21개인
    문서에서는 절차 낱말(설치·드라이버·방법)이 문턱을 통과해 정체에 섞인다.
    """
    install = "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"
    scan = "06 삼성 복합기 스캔 이용방법"
    pool = {
        # 두 절 모두 브라우저로 복합기에 접속하는 화면을 싣는다 — 캡션만으로는 갈리지 않는
        # 것이 실제 모습이고, 그래서 절 자격이 판정을 맡는다.
        (DOC_A, 4): _cand_with_heading(
            (DOC_A, 4), install, "브라우저 주소창에 복합기 IP를 입력해 접속하는 화면"),
        (DOC_A, 12): _cand_with_heading(
            (DOC_A, 12), scan, "주소록 탭에서 이메일을 추가하는 화면"),
    }
    answer = (
        "## 삼성 복합기 스캔 이용 방법\n\n"
        "삼성 복합기로 스캔하려면 먼저 주소록에 본인 이메일을 등록한 뒤 스캔을 진행합니다.\n\n"
        "**1단계.** 브라우저에서 복합기 IP로 접속해 주소록 탭을 엽니다.\n\n"
        "**2단계.** 추가 버튼을 눌러 이메일을 등록합니다.\n\n"
        "**3단계.** 복합기에서 스캔 후 이메일을 선택해 스캔합니다."
    )
    # 실제 문서의 절 목록 그대로 — 목차 줄과 헤딩이 나란히 들어 있어 절이 21개다.
    # 이 길이라야 절차 낱말('설치/드라이버/방법/ver', df 7~9)이 문턱(10)을 통과해 정체에 섞인다.
    from dispatch.bedrock_chat_router import _occurrences, _section_identity, _weight  # noqa: E402

    ident = _section_identity(
        {"i": {"heading": install}, "s": {"heading": scan}}, tuple(LONG_SECTION_LIST))
    assert _occurrences(ident["i"], answer) == _occurrences(ident["s"], answer), \
        "전제가 깨졌다 — 개수로 세면 두 절이 동점이어야 이 테스트가 의미가 있다"

    segments = _router()._parse_image_markers(
        answer, {(DOC_A, 4): pool[(DOC_A, 4)]}, REAL_CORPUS,
        sections=pool, section_list=tuple(LONG_SECTION_LIST),
    )
    assert [s for s in segments if s["type"] == "image"] == [], \
        "스캔 답변에 설치 절 그림이 붙었다"
    assert _weight(ident["s"], answer) > _weight(ident["i"], answer)


def test_a_process_word_does_not_make_unrelated_sections_siblings():
    """형제 관계는 주제어로만 맺어야 한다 — '방법' 같은 절차 낱말로 맺으면 안 된다.

    QA에서 나온 실제 결함: 인용 필터를 지난 그림이 절 게이트에서 전멸했다
    (`인용필터 16 → 3`, `절게이트 3 → 0`). 원인은 IP 변경 절과 드라이버 설치 절이 **'방법'**
    하나로 형제가 되어, 인용조차 안 된 절이 인용된 절의 그림을 물리친 것.

    정체(점수를 내는 낱말)까지 같이 조이면 이 코퍼스에서는 주제어 '스캔'(df 7)이
    '방법'(df 8)과 함께 떨어져 스캔 절이 정체를 잃는다. 그래서 척도를 둘로 나눈다.
    """
    from dispatch.bedrock_chat_router import (  # noqa: E402
        _beaten_by_sibling, _section_identity, _siblings)

    ip = "05 근무지 이동시 복합기 아이피 변경 방법"
    install = "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"
    scan = "06 삼성 복합기 스캔 이용방법"
    macos = "02 삼성 복합기 드라이버 설치 방법 (macOS ver.)"
    other_maker = "03 신도 복합기 드라이버 설치 방법 (Windows ver.)"
    pool = {h: {"heading": h} for h in LONG_SECTION_LIST}

    ident = _section_identity(pool, tuple(LONG_SECTION_LIST))
    subj = _section_identity(pool, tuple(LONG_SECTION_LIST), share=4)
    rel = lambda a, b: _siblings(ident[a], ident[b], subj[a], subj[b])  # noqa: E731

    assert ident[ip] & ident[install] == {"방법"}, "전제: 정체 낱말 하나로는 이어져 있다"
    assert not rel(ip, install), "절차 낱말 하나로 상관없는 절이 형제가 됐다"

    # 진짜 형제 관계 세 가지는 그대로 남아야 한다
    assert rel(install, macos), "조건만 다른 형제 절이 끊겼다 (주제어 공유)"
    assert rel(install, scan), "같은 제조사의 설치·스캔 절이 끊겼다 (주제어 공유)"
    assert rel(install, other_maker), \
        "제조사만 다른 같은 절차가 끊겼다 (주제어는 안 겹치고 절차 낱말을 여럿 공유)"

    # 인용된 절(ip)이 인용도 안 된 절(install)에 밀리지 않는다
    assert not _beaten_by_sibling(ip, ident, subj, {ip: 3, install: 99}), \
        "상관없는 절이 생존자를 물리쳤다"
    assert _beaten_by_sibling(install, ident, subj, {install: 1, scan: 9}), \
        "형제 절 비교까지 꺼지면 안 된다"


def test_a_section_written_two_ways_does_not_beat_itself():
    """같은 절이 목차 표기와 본문 헤딩으로 두 번 들어와도 서로 겨루면 안 된다.

    실측: 한 절의 연속된 세 페이지가 두 가지 표기로 매핑돼 있었다
    (`05 근무지 이동시 …` / `05. 근무지 이동 시 …`, 점·띄어쓰기만 다름).
    게이트가 둘을 경쟁자로 보고 1점 낮은 표기 쪽 페이지를 떨어뜨렸고, 남은 것은 그 절에서
    가장 본문이 빈약한 페이지뿐이라 결국 그림이 한 장도 안 붙었다.
    """
    heading = "05 근무지 이동시 복합기 아이피 변경 방법"
    toc_form = "05. 근무지 이동 시 복합기 아이피 변경 방법"
    pool = {
        (DOC_A, 20): _cand_with_heading(
            (DOC_A, 20), heading, "포트 탭에서 포트 추가 버튼을 누르는 화면"),
        (DOC_A, 21): _cand_with_heading(
            (DOC_A, 21), toc_form, "제어판에서 프린터 속성을 여는 화면"),
    }
    answer = (
        "# 근무지 이동 시 복합기 아이피 변경 방법\n\n"
        "**1단계.** 제어판에서 프린터 속성을 엽니다.\n\n"
        "**2단계.** 포트 탭에서 포트 추가 버튼을 누릅니다."
    )
    segments = _router()._parse_image_markers(
        answer, {(DOC_A, 20): pool[(DOC_A, 20)]}, REAL_CORPUS,
        sections=pool, section_list=tuple(LONG_SECTION_LIST + [toc_form]),
    )
    assert [s["page"] for s in segments if s["type"] == "image"] == [21], \
        "같은 절의 다른 표기에 밀려 그림이 사라졌다"


def test_a_cited_figure_survives_a_higher_scoring_unrelated_section():
    """인용을 지난 그림이, 인용도 안 된 다른 주제의 절에 밀려 사라지면 안 된다 (배선까지 확인).

    실측: IP 변경 방법을 물었고 답변이 그 절차를 그대로 설명했는데 그림이 0장이었다.
    같은 답변이 설치 절의 낱말(설치·드라이버·삼성)도 쓰다 보니 설치 절 점수가 더 높았고,
    두 절이 '방법' 하나로 형제였기 때문에 인용된 IP 변경 절 그림이 배제됐다.
    """
    ip = "05 근무지 이동시 복합기 아이피 변경 방법"
    install = "02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"
    pool = {
        (DOC_A, 20): _cand_with_heading(
            (DOC_A, 20), ip, "프린터 속성 창의 포트 탭에서 포트 추가 버튼을 누르는 화면"),
        # 인용 필터에서 떨어진 후보 — 답변의 낱말과는 더 많이 겹친다
        (DOC_A, 5): _cand_with_heading(
            (DOC_A, 5), install, "삼성 드라이버 설치 마법사 화면"),
    }
    answer = (
        "# 근무지 이동 시 복합기 IP 변경 방법\n\n"
        "설치된 삼성 드라이버는 그대로 두고 포트만 바꿉니다. Windows 기준입니다.\n\n"
        "**1단계.** 제어판에서 설치된 복합기를 우클릭해 프린터 속성을 엽니다.\n\n"
        "**2단계.** 포트 탭에서 포트 추가 버튼을 눌러 IP를 변경합니다.\n\n"
        "드라이버 설치 자체는 제조사별 설치 방법을 참고하세요."
    )
    segments = _router()._parse_image_markers(
        answer, {(DOC_A, 20): pool[(DOC_A, 20)]}, REAL_CORPUS,
        sections=pool, section_list=tuple(LONG_SECTION_LIST),
    )
    assert [s["page"] for s in segments if s["type"] == "image"] == [21], \
        "인용된 절의 그림이 상관없는 절에 밀려 사라졌다"


def test_konica_answer_does_not_pull_the_samsung_section():
    """위 정체를 자격 게이트에 걸었을 때 실제로 삼성 그림이 배제되는지."""
    pool = {}
    for i, h in enumerate(REAL_HEADINGS):
        pool[(DOC_A, i)] = _cand_with_heading((DOC_A, i), h, "설치 마법사 화면 언어 선택 동의 클릭")
    samsung_key = (DOC_A, REAL_HEADINGS.index("02 삼성 복합기 드라이버 설치 방법 (Windows ver.)"))
    survivors = {samsung_key: pool[samsung_key]}

    segments = _router()._parse_image_markers(
        KONICA_ANSWER, survivors, REAL_CORPUS, sections=pool
    )
    assert [s for s in segments if s["type"] == "image"] == [], \
        "코니카 답변에 삼성 절 그림이 붙었다"


def _cand_with_heading(key, heading, caption):
    c = _cand(key[0], caption, page=key[1])
    c["heading"] = heading
    return c


def test_a_lone_wrong_section_is_still_ruled_out():
    """후보가 전부 '틀린 한 절'만 남았을 때가 가장 위험하다.

    실제 사례: 메가존빌딩 10층(코니카 미놀타) 답변에 "02 삼성 복합기 드라이버 설치 방법"
    절의 p.4·p.5가 붙었다. 인용 필터를 지나고 남은 후보 둘이 모두 삼성 절이라
    _section_identity의 distinct가 1개로 접히고, 자격 검사가 스스로 꺼져 무사통과했다.
    절 정체는 서로 비교해야만 나오므로, 좁히기 전의 후보 전체를 기준으로 재야 한다.
    """
    survivors = {k: _cand_with_heading(k, *REAL_SECTIONS[k]) for k in [(DOC_A, 3), (DOC_A, 4)]}
    everything = {k: _cand_with_heading(k, *v) for k, v in REAL_SECTIONS.items()}

    segments = _router()._parse_image_markers(
        KONICA_ANSWER, survivors, REAL_CORPUS, sections=everything
    )
    assert [s for s in segments if s["type"] == "image"] == [], \
        "코니카 답변에 삼성 절 그림이 붙었다"


def test_the_matching_section_still_gets_its_figure():
    """넓힌 절 게이트가 정작 답변이 말하는 절의 그림까지 막으면 안 된다.

    위 테스트와 같은 pool·같은 답변인데 살아남은 후보만 코니카 절이다. 절 자격을 전체
    후보로 재도 이쪽은 통과해야 한다 — 답변이 그 절을 명시하고 있기 때문이다.
    """
    konica = _cand_with_heading(
        (DOC_A, 14), REAL_SECTIONS[(DOC_A, 14)][0],
        "KONICA MINOLTA Bizhub 028DN 설치 사용권 계약 화면",
    )
    everything = {k: _cand_with_heading(k, *v) for k, v in REAL_SECTIONS.items()}

    segments = _router()._parse_image_markers(
        KONICA_ANSWER, {(DOC_A, 14): konica}, REAL_CORPUS, sections=everything
    )
    assert [s["page"] for s in segments if s["type"] == "image"] == [15], \
        "답변이 말하는 절의 그림이 배제됐다"


# 실제 한국앤컴퍼니 PPT의 절 구성 — 표지 제목이 문서 전체의 주제어를 그대로 담고 있다.
PPT_HEADINGS = [
    "한국앤컴퍼니 AI 경진대회 AWS 인프라 구축",
    "1. 사전 준비 사항",
    "2. Base 아키텍처",
    "3-1. AWS 콘솔 로그인 방법",
    "3-2. 각 팀별로 생성된 IAM User 권한으로 로그인",
    "4. SageMaker Studio 도메인 접속",
]
PPT_CORPUS = [
    "한국앤컴퍼니 AI 경진대회 AWS 인프라 구축 안내",
    "사전 준비 사항 계정 발급",
    "Base 아키텍처 VPC 서브넷 SageMaker 도메인",
    "AWS 콘솔 로그인 방법 안내",
    "IAM User 권한으로 로그인 비밀번호 변경",
    "SageMaker Studio 도메인 접속 절차",
]
ARCH_ANSWER = (
    "한국앤컴퍼니 AI 경진대회 AWS 인프라의 Base 아키텍처는 다음과 같습니다.\n\n"
    "**네트워크 구성**\n\n"
    "VPC 안에 서브넷을 두고 SageMaker 도메인을 연결하는 다이어그램입니다."
)


def test_a_cover_slide_does_not_starve_the_section_the_answer_is_about():
    """절 자격을 문서 전체 최고점과 겨루게 하면 표지 슬라이드가 영구 승자가 된다.

    실제 사례: 한국앤컴퍼니 PPT에 "아키텍처도 보여줘" → 인용 필터를 지난 6장이 절 게이트에서
    전멸(6 -> 0). 표지 제목이 문서 주제어를 다 담고 있어 이 문서에 대한 어떤 답변이든 최고점을
    가져가고, 정작 아키텍처 그림이 있는 "2. Base 아키텍처" 절은 1점이라 탈락한다.
    게다가 최고점 절(표지)이 인용 필터에서 떨어지면 생존자 중 동점자가 없어 전멸한다.

    승자독식이 원래 막으려던 것은 "05 브라더 (macOS)"가 "04 브라더 (Windows)" 대신 통과하는
    것이므로, 주제가 겹치는 형제 절끼리만 비교하면 된다.
    """
    pool = {
        (DOC_A, 0): _cand_with_heading(
            (DOC_A, 0), PPT_HEADINGS[0], "한국앤컴퍼니 AI 경진대회 AWS 인프라 구축 표지"),
        (DOC_A, 5): _cand_with_heading(
            (DOC_A, 5), PPT_HEADINGS[2],
            "VPC 서브넷과 SageMaker 도메인을 잇는 Base 아키텍처 다이어그램"),
        (DOC_A, 9): _cand_with_heading(
            (DOC_A, 9), PPT_HEADINGS[4], "IAM User 로그인 화면"),
    }
    survivors = {(DOC_A, 5): pool[(DOC_A, 5)]}

    segments = _router()._parse_image_markers(
        ARCH_ANSWER, survivors, PPT_CORPUS, sections=pool,
        section_list=tuple(PPT_HEADINGS),
    )
    assert [s["page"] for s in segments if s["type"] == "image"] == [6], \
        "답변이 말하는 절의 그림이 표지 슬라이드에 밀려 배제됐다"


def test_a_sibling_section_with_a_worse_match_is_still_excluded():
    """형제 절 비교로 바꿔도 같은 주제의 다른 절은 그대로 걸러야 한다.

    "04 브라더 (Windows)"와 "05 브라더 (macOS)"처럼 주제어를 공유하는 절끼리는 여전히
    가장 잘 맞는 쪽만 통과한다. 이게 승자독식의 원래 목적이고, 그것만 남긴다.
    """
    windows = "04 브라더 복합기 & 스캔 드라이버 설치 방법 (Windows ver.)"
    macos = "05 브라더 복합기 & 스캔 드라이버 설치 방법 (macOS ver.)"
    pool = {
        (DOC_A, 7): _cand_with_heading((DOC_A, 7), windows, "다운로드 링크 접속 화면"),
        (DOC_A, 9): _cand_with_heading((DOC_A, 9), macos, "다운로드 링크 접속 화면"),
    }
    answer = (
        "브라더 복합기를 Windows 에 연결하는 방법입니다.\n\n"
        "**1단계.** 다운로드 링크에 접속해 드라이버를 내려받습니다."
    )
    segments = _router()._parse_image_markers(
        answer, {(DOC_A, 9): pool[(DOC_A, 9)]}, REAL_CORPUS, sections=pool,
        section_list=tuple(REAL_HEADINGS),
    )
    assert [s for s in segments if s["type"] == "image"] == [], \
        "Windows 답변에 macOS 절 그림이 붙었다"


# 파서가 캡션을 문서의 언어가 아니라 영어로 쓴 경우. 답변은 한국어라 캡션과 낱말이 겹치지
# 않는다 — 배치 점수가 어느 짝에서도 0이 되어 그림이 한 장도 안 붙던 상황.
FOREIGN_CAPTION = "A two-part architecture diagram showing the AS-IS and TO-BE states"
DECORATION_CAPTION = "Company logo displayed in the bottom right corner of the slide"


def test_a_caption_in_another_language_falls_back_to_the_page_text():
    """캡션이 답변과 다른 언어면 그 페이지의 본문으로 배치한다.

    실측: 캡션이 영어인 문서는 인용·절 게이트를 통과하고도 배치 단계에서 항상 0장이었다
    ("6 candidates, 0 images inserted"). 페이지 본문은 문서 자신의 언어이고 이미 손에 있다.
    """
    imgs = {
        (DOC_A, 4): _cand_with_heading((DOC_A, 4), "2. 기준 구성도", FOREIGN_CAPTION),
    }
    answer = (
        "기준 구성도는 다음과 같습니다.\n\n"
        "**구성 요약**\n\n"
        "가상 네트워크 안에 분석 도메인을 두고 저장소를 연결하는 구조입니다."
    )
    page_texts = {(DOC_A, 4): "가상 네트워크 분석 도메인 저장소 연결 구조 구성도"}

    segments = _router()._parse_image_markers(
        answer, imgs, SIBLING_CORPUS, page_texts=page_texts)
    assert [s["page"] for s in segments if s["type"] == "image"] == [5], \
        "캡션 언어가 달라 그림이 한 장도 붙지 않았다"


def test_the_page_text_bridge_survives_the_same_procedure_in_two_documents():
    """같은 절차가 여러 문서에 실려 있어도 다리가 끊기면 안 된다.

    실측: 같은 IP 변경 절차가 건물마다 안내서에 들어 있어 페이지 본문이 서로 거의 같았다.
    '후보 중 나만 가진 낱말'을 요구하면 공통어가 통째로 지워져 최고점이 1까지 떨어진다
    (전체 낱말로 재면 10). 유일성은 캡션에 맞는 요구이지 페이지 본문에는 맞지 않는다 —
    어느 문서·어느 절인지는 이미 인용·스코프·절 게이트가 정했다.
    """
    section = "05 주소 변경 방법"
    # 캡션은 문서 언어가 아니라 영어다 — 답변 블록과는 한 낱말도 안 겹친다
    imgs = {
        (DOC_A, 6): _cand_with_heading(
            (DOC_A, 6), section, "A screenshot of the control panel properties window"),
        (DOC_A, 7): _cand_with_heading(
            (DOC_A, 7), section, "A screenshot of the port tab add dialog"),
    }
    answer = (
        "주소 변경 방법입니다.\n\n"
        "**1단계.** 제어판에서 장비를 우클릭해 속성 창을 엽니다.\n\n"
        "**2단계.** 속성 창의 포트 탭에서 포트 추가 버튼을 눌러 주소를 입력합니다."
    )
    # 한 절의 연속 단계 — 절차 낱말은 공유하고 자기 단계 낱말만 다르다
    page_texts = {
        (DOC_A, 6): "제어판에서 장비를 우클릭해 속성 창을 여는 화면",
        (DOC_A, 7): "속성 창의 포트 탭에서 포트 추가 버튼을 눌러 주소를 입력하는 화면",
    }
    segments = _router()._parse_image_markers(
        answer, imgs, SIBLING_CORPUS, page_texts=page_texts)
    pages = [s["page"] for s in segments if s["type"] == "image"]
    assert pages == [7, 8], f"연속 단계 그림이 각자 단계에 붙지 않았다: {pages}"


def test_a_decoration_repeated_on_every_page_is_not_placed_by_page_text():
    """페이지마다 똑같이 실리는 장식(로고·머리말)은 폴백에서도 붙으면 안 된다.

    페이지 본문만 보면 로고는 그 페이지 이야기에 완벽히 들어맞는다. '무엇을 그렸는가'는
    끝까지 캡션이 답해야 하고, 캡션이 후보들 사이에서 아무것도 구별하지 못하는 그림
    — 즉 모든 페이지에 반복되는 장식 — 은 그 자격이 없다.
    """
    imgs = {
        (DOC_A, 4): _cand_with_heading((DOC_A, 4), "2. 기준 구성도", DECORATION_CAPTION),
        (DOC_A, 6): _cand_with_heading((DOC_A, 6), "2. 기준 구성도", DECORATION_CAPTION),
    }
    answer = (
        "기준 구성도는 다음과 같습니다.\n\n"
        "가상 네트워크 안에 분석 도메인을 두고 저장소를 연결하는 구조입니다."
    )
    page_texts = {
        (DOC_A, 4): "가상 네트워크 분석 도메인 저장소 연결 구조",
        (DOC_A, 6): "예상 리소스 항목 목록",
    }

    segments = _router()._parse_image_markers(
        answer, imgs, SIBLING_CORPUS, page_texts=page_texts)
    assert [s for s in segments if s["type"] == "image"] == [], "장식 그림이 붙었다"


def test_page_text_is_not_used_when_the_caption_already_places():
    """캡션으로 배치가 되는 코퍼스에서는 폴백이 아예 실행되지 않아야 한다.

    페이지 본문은 캡션보다 훨씬 길어 어떤 블록과도 잘 겹친다. 캡션이 통할 때까지 그걸
    섞으면, 지금 잘 도는 코퍼스의 배치가 조용히 바뀐다.
    """
    imgs = {(DOC_A, 5): _cand(DOC_A, XR500_FIGURE, page=5)}
    answer = (
        "**XR-500** 설치 방법입니다.\n\n"
        "마법사에서 포트를 선택한 뒤 설치를 진행합니다.\n\n"
        "완료 후 인쇄 테스트를 합니다."
    )
    # 폴백이 돌면 본문이 긴 마지막 블록으로 그림이 옮겨간다.
    page_texts = {(DOC_A, 5): "완료 인쇄 테스트 문서 출력 확인 절차"}

    with_pages = _router()._parse_image_markers(
        answer, imgs, CORPUS, page_texts=page_texts)
    without = _router()._parse_image_markers(answer, imgs, CORPUS)
    assert [s.get("at") for s in with_pages if s["type"] == "image"] == \
           [s.get("at") for s in without if s["type"] == "image"], \
        "캡션으로 배치되는데도 페이지 본문이 위치를 바꿨다"


def _finalize(answer):
    """finalize_generation을 히스토리 저장 없이 돌린다 — 반환값만 본다."""
    router = _router()
    router._save_turn = lambda *a, **k: None
    state = {
        "prompt": "XR-500 설치 방법 알려줘",
        "text_results": [{
            "text": "[p6] XR-500 마법사에서 포트를 선택한 뒤 설치를 진행한다",
            "uri": f"{DOC_A}.text.md",
            "metadata": {},
            "score": 0.5,
        }],
        "corpus": CORPUS,
        "images": [{**_cand(DOC_A, XR500_FIGURE, page=5), "key": [DOC_A, 5]}],
        "allowed_scopes": [],
    }
    result = router.finalize_generation(state, answer)
    return [s for s in result["segments"] if s["type"] == "image"]


def _finalize_no_citation(answer, cands):
    """인용이 없는 답변으로 finalize를 돌린다. cands: {(doc,page): candidate}."""
    router = _router()
    router._save_turn = lambda *a, **k: None
    state = {
        "prompt": "10층 프린터 연결 방법",
        "text_results": [{
            "text": "[p15] 코니카 미놀타 드라이버 설치 사용권 계약 동의",
            "uri": f"{DOC_A}.text.md", "metadata": {}, "score": 0.5,
        }],
        "corpus": REAL_CORPUS,
        "images": [{**c, "key": [k[0], k[1]]} for k, c in cands.items()],
        "allowed_scopes": [],
        "section_list": REAL_HEADINGS,
    }
    return [s for s in router.finalize_generation(state, answer)["segments"]
            if s["type"] == "image"]


KONICA_FIG = "KONICA MINOLTA Bizhub 028DN 설치 사용권 계약 화면"


def test_a_refusal_that_names_the_documents_it_has_gets_no_figure():
    """자료에 없다고 거절하면서 가진 자료를 나열하는 답변에 그림이 붙으면 안 된다.

    QA에서 2/2회 재현된 실제 결함. 없는 대상을 물으면 모델은 "자료에 없습니다. 아래 대상만
    포함돼 있습니다"라고 답하며 문서 이름들을 나열하는데, 그 이름이 곧 절 이름이라
    '답변이 절 이름을 부르면 통과' 폴백이 발동해 거절 답변에 그림이 붙었다.

    인용이 없다 = 답변이 자료에 기대지 않았다. 그 턴에 그림을 붙일 근거는 없다.
    """
    refusal = (
        "제공된 자료에는 해당 대상에 관한 정보가 포함되어 있지 않습니다.\n\n"
        "자료에는 아래 문서만 포함되어 있습니다:\n"
        "- 07 코니카 미놀타 복합기 드라이버 설치 방법 (Windows ver.)\n"
        "- 01 층별 복합기 정보\n\n"
        "담당 부서에 문의하시기 바랍니다."
    )
    cands = {(DOC_A, 14): _cand_with_heading(
        (DOC_A, 14), REAL_SECTIONS[(DOC_A, 14)][0], KONICA_FIG)}
    assert _finalize_no_citation(refusal, cands) == [], "거절 답변에 그림이 붙었다"


def test_without_a_citation_even_the_matching_section_is_refused():
    """답변이 그 절을 설명하고 있어도 인용이 없으면 붙이지 않는다.

    폴백이 되살아나면 위 거절 케이스도 함께 되살아나므로, 경계를 여기서 못 박는다.
    """
    cands = {(DOC_A, 14): _cand_with_heading(
        (DOC_A, 14), REAL_SECTIONS[(DOC_A, 14)][0], KONICA_FIG)}
    assert _finalize_no_citation(KONICA_ANSWER, cands) == []


def test_without_a_citation_a_figure_with_no_section_is_refused():
    """절을 알 수 없는 그림은 인용이 없을 때 통과시키지 않는다.

    평소 경로는 '판단 근거가 없으니 배제하지 않는다'로 통과시키지만, 인용이라는 다른 근거가
    없는 상태에서 그것까지 열면 근거 없이 붙는 예전 동작과 같아진다.
    """
    cand = _cand(DOC_A, KONICA_FIG, page=14)   # heading 없음
    assert _finalize_no_citation(KONICA_ANSWER, {(DOC_A, 14): cand}) == []


def test_an_answer_that_cites_nothing_gets_no_figure():
    """인용이 없으면 그림 후보를 전부 버린다 — 근거가 없을수록 더 붙던 버그.

    실제 사례: 대화가 길어지면 모델이 짧은 후속 질문("브라더 프린터는 스캔이 되?")을
    검색 결과가 아니라 앞선 대화로 답하면서 [N]을 붙이지 않는 턴이 생긴다. 그 턴마다
    인용 필터가 `if cited_keys:`에 막혀 통째로 건너뛰어졌고, 후보 16~26장이 걸러지지 않은
    채 배치 단계로 넘어가 엉뚱한 페이지의 그림이 붙었다.
    """
    assert _finalize(
        "**XR-500** 장비입니다.\n\nXR-500 마법사에서 포트를 선택한 뒤 설치를 진행합니다."
    ) == [], "인용 없는 답변에 그림이 붙었다"


def test_the_same_answer_with_a_citation_still_gets_its_figure():
    """위 필터가 인용된 페이지의 그림까지 죽이면 안 된다 — 같은 입력, 인용만 추가."""
    images = _finalize(
        "**XR-500** 장비입니다.[1]\n\nXR-500 마법사에서 포트를 선택한 뒤 설치를 진행합니다.[1]"
    )
    assert len(images) == 1
    assert images[0]["page"] == 6, "인용된 [p6]의 그림이어야 한다"


def test_image_index_keys_are_document_scoped():
    """같은 페이지 번호의 서로 다른 문서 이미지가 한 칸에 합쳐지면 안 된다."""
    router = _router()
    text_results = [_text(DOC_A, "A [p3]", page=2), _text(DOC_B, "B [p3]", page=2)]
    image_results = [
        _image(DOC_A, "XR-500 설치 화면", page=2),
        _image(DOC_B, "QT-900 설치 화면", page=2),
    ]

    matched = router._match_images_to_text(text_results, image_results)

    assert set(matched) == {(DOC_A, 2), (DOC_B, 2)}
