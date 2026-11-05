"""버려진 업로드 작업이 영원히 RUNNING으로 남지 않아야 한다.

실제로 있었던 일: `/kb/process`의 백그라운드 워커가 Lambda 타임아웃이나 OOM으로 죽으면
except 블록에 도달하지 못해 DONE/FAILED를 아무도 쓰지 않는다. `tasks/<id>.json`이 RUNNING인
채로 남고, UI는 그 상태를 영영 폴링한다.

실행: pytest packages/cdk_infra/tests/test_task_status.py
"""

import io
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

LAMBDA_DIR = (
    Path(__file__).resolve().parents[1]
    / "src/backend/kb_management/lambda/kb_documents"
)
sys.path.insert(0, str(LAMBDA_DIR))
os.environ.setdefault("KB_BUCKET", "kb-bucket")
os.environ.setdefault("STATUS_BUCKET", "status-bucket")

import kb_documents  # noqa: E402


class _NoSuchKey(Exception):
    pass


class FakeS3:
    """tasks/ 객체 하나와 그 LastModified만 갖춘 최소 S3."""

    exceptions = type("_E", (), {"NoSuchKey": _NoSuchKey})

    def __init__(self, payload, age_seconds):
        self.payload = payload
        self.last_modified = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
        self.deleted = []

    def get_object(self, Bucket=None, Key=None):  # noqa: N803
        return {
            "Body": io.BytesIO(json.dumps(self.payload).encode()),
            "LastModified": self.last_modified,
        }

    def delete_object(self, Bucket=None, Key=None):  # noqa: N803
        self.deleted.append(Key)


def _poll(payload, age_seconds):
    kb_documents.s3 = FakeS3(payload, age_seconds)
    return kb_documents._get_task("abc"), kb_documents.s3


def test_a_running_task_is_still_running_while_the_worker_could_be_alive():
    result, fake = _poll({"status": "RUNNING"}, age_seconds=60)
    assert result["status"] == "RUNNING"
    assert fake.deleted == [], "아직 살아 있을 수 있는 작업을 지웠다"


def test_a_running_task_past_the_worker_lifetime_is_reported_failed():
    """워커가 살아 있을 수 없는 시점을 넘기면 실패로 확정한다 — 폴링을 끝내는 유일한 근거."""
    result, fake = _poll({"status": "RUNNING"}, age_seconds=kb_documents._TASK_MAX_AGE + 1)
    assert result["status"] == "FAILED"
    assert result["message"], "UI가 보여줄 사유가 있어야 한다"
    assert fake.deleted == ["tasks/abc.json"], "확정된 작업은 정리돼야 한다"


def test_a_done_task_is_not_touched_by_the_age_check():
    """오래된 DONE은 결과가 있으니 그대로 돌려준다 — 나이로 결과를 뒤집으면 안 된다."""
    result, _ = _poll(
        {"status": "DONE", "key": "documents/a.pdf"},
        age_seconds=kb_documents._TASK_MAX_AGE + 1,
    )
    assert result["status"] == "DONE" and result["key"] == "documents/a.pdf"
