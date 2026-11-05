"""배포가 OpenAPI 스키마를 만들 수 있는 상태인지 확인한다.

실제로 있었던 일: 배포 로그에 `ModuleNotFoundError: No module named 'aws_lambda_powertools'`
가 찍혔는데도 배포는 계속 진행돼 전 스택이 ✅ 로 끝났다. remote-deploy.sh 는 venv 를 만들며
`agents/lambda/requirements.txt` 를 설치하는데 **그 파일이 없었다** — venv 가 빈 채로 만들어지고
스키마 생성 단계가 죽은 것. 그 순간에는 티가 안 나고, 액션그룹 스키마를 바꾸는 날 옛 스키마가
조용히 배포된다.

버전은 액션 Lambda 가 실제로 쓰는 레이어와 같아야 한다. 스키마를 만드는 쪽과 그 스키마대로
동작하는 쪽이 어긋나면, 배포된 에이전트가 실제 핸들러와 다른 규격을 광고하게 된다.

실행: pytest packages/cdk_infra/tests/test_openapi_build_deps.py
"""

import json
import re
from pathlib import Path

CDK = Path(__file__).resolve().parents[1]
AGENTS = CDK / "src/backend/agents/lambda"
LAYERS = CDK / "src/backend/common/layers"
BUILD_REQS = AGENTS / "requirements.txt"


def _pins(path):
    """{패키지 이름: 고정 버전} — 주석과 빈 줄은 무시한다."""
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        found = re.match(r"^([A-Za-z0-9_.\-\[\]]+)==([\w.]+)$", line)
        if found:
            out[found.group(1).split("[")[0].lower()] = found.group(2)
    return out


def test_the_build_requirements_file_exists():
    """remote-deploy.sh 가 이 경로를 설치한다. 없으면 venv 가 비고 스키마 생성이 죽는다."""
    assert BUILD_REQS.is_file(), f"{BUILD_REQS} 가 없다 — 배포의 venv 가 빈 채로 만들어진다"
    assert "aws-lambda-powertools" in _pins(BUILD_REQS), "스키마 생성기가 쓰는 powertools 가 없다"


def test_build_versions_match_the_runtime_layers():
    """스키마를 만드는 버전과 런타임 레이어 버전이 같아야 한다."""
    build = _pins(BUILD_REQS)
    for layer_dir in LAYERS.iterdir():
        req = layer_dir / "requirements.txt"
        if not req.is_file():
            continue
        for name, version in _pins(req).items():
            if name in build:
                assert build[name] == version, (
                    f"{name}: 빌드 {build[name]} vs 런타임 레이어 {version} — "
                    "스키마와 실제 핸들러가 어긋난다")


def test_the_generated_schema_is_openapi_30():
    """Bedrock 에이전트 액션그룹은 OpenAPI 3.0.x 를 요구한다.

    powertools 3.x + pydantic v2 조합은 "3.0 과 호환되지 않는다"며 3.1 로 올려 버린다.
    생성기가 요청하는 버전과 실제 파일이 모두 3.0.x 인지 함께 본다.
    """
    schema = json.loads((AGENTS / "account_actions/openapi.json").read_text(encoding="utf-8"))
    assert schema["openapi"].startswith("3.0."), f"OpenAPI {schema['openapi']} 는 액션그룹이 못 받는다"

    source = (AGENTS / "account_actions/account_actions.py").read_text(encoding="utf-8")
    requested = re.search(r'openapi_version="([\d.]+)"', source)
    assert requested and requested.group(1).startswith("3.0."), "생성기가 3.0.x 를 요청하지 않는다"
    assert schema["openapi"] == requested.group(1), (
        f"생성기는 {requested.group(1)} 를 요청하는데 파일은 {schema['openapi']} — "
        "다른 버전 조합으로 만들어진 스키마다")
