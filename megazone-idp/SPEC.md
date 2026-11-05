# megazone-idp — 웹 UI 제품 스펙 & 구현 현황

`sample-aws-idp-pipeline`를 fork(복사)한 뒤, **AWS/Bedrock을 모르는 사용자용 문서 관리 웹 제품**으로 개조하는 작업 폴더.

## 대상 사용자 & 목표
- AWS/Bedrock 개념(SageMaker·OCR 모델·BDA·Step Functions)을 **전혀 노출하지 않는다.**
- 회사 내부 자료를 올리면 → **자동 인덱싱 + 자동 분류 + 폴더구조 자동 생성** → 채팅으로 상세 질의.
- **여러 파일을 동시에** 올려도 동시에 처리되고 진행상황이 실시간으로 보인다.

---

## 요구사항 → 설계

### R1. 비기술 사용자용 UI (복잡성 은닉)
- **은닉/제거 대상**: `routes/settings.tsx`(SageMaker 관리), `OcrSettingsForm`, `TranscribeSettingsForm`, `VoiceModelSettingsModal`, `SystemPromptModal`, 워크플로 스텝 내부 모달.
- **기본값 자동화**: 업로드 시 `use_ocr=true`, `use_bda=false`, `use_transcribe`는 파일타입 자동판정, `ocr_model=pp-ocrv5`. 사용자는 아무 옵션도 고르지 않는다.
- **진행 표시**: Step Functions 스텝명 대신 친근한 상태(업로드됨 → 분석 중 → 완료).
- **"프로젝트" 개념 완화**: 기본 워크스페이스 자동 생성 또는 "자료실"로 리네이밍(과한 관리 개념 제거).

### R2. 업로드 → 파일경로 자동 인덱싱 → 폴더구조 표시
- **폴더 업로드**: `<input webkitdirectory>` + `File.webkitRelativePath`로 상대경로 캡처 → 업로드 시 `folder_path`로 전송.
- **데이터 모델**: 문서에 `folder_path`(업로드 원본 경로) 저장.
- **UI**: 평면 리스트 → **폴더 트리 뷰**(업로드 경로 기준).

### R3. 자동 분류 → 폴더구조 자동 생성
- **분류기(신규 파이프라인 단계)**: 문서 요약(이미 생성됨)을 근거로 LLM이 `category_path`(예: `인사/규정`) 부여.
- **일관성**: 프로젝트별 택소노미(카테고리 목록)를 저장하고, 신규 문서는 기존 카테고리 재사용 우선 → 폴더구조가 난립하지 않음.
- **UI**: 트리 뷰 두 관점 토글 — "업로드 폴더"(R2) / "자동 분류"(R3).
- (향후) 규모 커지면 요약 임베딩 재클러스터링으로 구조 재정리.

### R4. 채팅 답변 상세화
- 기존 idp-agent + 하이브리드검색 + 그래프 + Cohere 리랭크로 **이미 상세**.
- 개선: 출처(문서·페이지) 표기, 선택한 폴더/카테고리로 **질의 범위 지정**.

### R5. 다중 파일 동시 처리 + UI
- **인프라 병목 해소**: 기존 전역 락(문서 1건씩 분석)을 **동시성 예산(N개 병렬)**으로 변경.
- **배치 대시보드**: 기존 WebSocket 실시간 인프라(`workflow-stream`) 재사용 → 파일별 상태 카드(대기/분석중/완료/실패).

---

## ✅ 이 fork에서 구현 완료 (백엔드 · 파이프라인)

| 영역 | 변경 | 파일 |
|------|------|------|
| **동시성(R5)** | 전역 분석 락 → 예산 기반(`MAX_CONCURRENT_ANALYSES`, 기본 3). 여러 문서 병렬 분석 | `infra/.../shared/ddb_client.py` `is_analysis_busy()`, `infra/.../check-preprocess-status` env |
| **폴더경로 모델(R2)** | 문서·워크플로에 `folder_path` 추가, 업로드→워크플로까지 전달 | `backend/app/ddb/models.py`, `backend/app/routers/documents.py`, `infra/.../shared/ddb_client.py` `create_workflow()`, `infra/.../preprocessing/type-detection/index.py` |
| **분류 모델(R3)** | 문서에 `category_path`+`category_confidence`, 프로젝트 택소노미(`CATEGORIES` 아이템) | `backend/app/ddb/models.py`, `infra/.../shared/ddb_client.py` `update_document_category()`/`get_project_categories()`/`add_project_category()` |
| **분류기 Lambda(R3)** | 요약 기반 LLM 분류(best-effort, 실패 시 파이프라인 비차단). 경로 정규화 셀프체크 포함 | **신규** `infra/.../step-functions/document-classifier/index.py` |
| **워크플로 배선(R3)** | `PostAnalysisParallel`(요약 완료) → `ClassifyDocument` → `FinalizeWorkflow`. IAM grant·모델 env 추가 | `infra/src/stacks/workflow-stack.ts` |
| **응답 노출** | `DocumentResponse`에 `folder_path`/`category_path` 포함 | `backend/app/routers/documents.py` |

**검증**: `python3 -m py_compile` 전 파일 통과, 분류기 경로정규화 셀프체크(`python3 .../document-classifier/index.py`) 통과.

### 설정 노브
- `MAX_CONCURRENT_ANALYSES`(check-preprocess-status Lambda env, 기본 `3`) — 동시 분석 문서 수. Bedrock 쿼터에 맞춰 조정.

---

## ✅ 프론트엔드 구현 완료 (F1·F2)

| 기능 | 변경 | 파일 |
|------|------|------|
| **F1 폴더경로 캡처(R2)** | 업로드 모달에 폴더 선택 input(`webkitdirectory`) 추가, `webkitRelativePath`→`folder_path` 도출 후 업로드 API로 전송, 로컬 상태 반영 | `DocumentUploadModal.tsx`, `useDocuments.ts`, `types/project.ts` |
| **F2 폴더 트리 뷰(R2·R3)** | 신규 `FolderTree` 컴포넌트(업로드 폴더/자동 분류 트리, 접기/펼치기, 문서수 배지), SidePanel에 **List/Folder/Category 토글** 통합. 트리 알고리즘 Node 검증 + vitest 테스트 | 신규 `components/FolderTree/`, `SidePanel.tsx` |

- 트리 노드→문서 선택 시 기존 워크플로 상세 뷰(`onViewWorkflow`)로 연결.
- 검증: `buildDocTree` 알고리즘 Node 등가 어서션 통과, `buildDocTree.test.ts`(vitest) 작성(deps 설치 후 실행).

---

## ⏳ 남은 작업 (F3·F4·F5)

### F3. 배치 진행 대시보드 (R5)
- **부분 완료**: SidePanel이 이미 `workflowProgressMap`+WebSocket으로 문서별 실시간 진행상태 표시. 백엔드 동시성 완화(구현됨)로 실제 병렬 처리됨.
- 남은 것: 다중 업로드 직후 "N개 처리 중" 요약 배너/전용 대시보드(선택 고도화).
- **신규** `frontend/src/components/UploadDashboard/` — 다중 업로드 후 파일별 상태 카드. 기존 `contexts/WebSocketContext.tsx` + `/documents/progress` API 재사용(둘 다 이미 존재).

### F4. 채팅 범위 지정 (R4)
- 채팅 요청에 선택된 `category_path`/`folder_path`/`document_id` 필터 전달. 검색 MCP는 이미 `document_id` 필터 지원 → 폴더 단위로 확장.

### F5. UX 은닉 (R1)
- `routes/settings.tsx` 및 AWS 노출 모달 라우팅 제거/숨김. 업로드 기본값 하드코딩(옵션 UI 제거).
- 진행 상태 라벨을 친근한 문구로 매핑(`i18n/locales/*`).

### 백엔드 보강(선택)
- 카테고리 조회 API: `GET /projects/{id}/categories`(택소노미), 폴더별 문서 조회 — 트리 뷰 데이터 소스. `routers/projects.py`/`documents.py`에 추가.

---

## 배포 영향
- 신규 Lambda 1개(`idp-v2-document-classifier`) 추가 → CDK `WorkflowStack` 재배포 필요.
- 스키마 변경은 **추가 전용**(신규 옵셔널 필드 + 신규 DDB `CATEGORIES` 아이템) → 기존 데이터 하위호환.
- 분류기는 best-effort라 실패해도 문서 처리 워크플로는 정상 완료.

---

## 미해결/주의
- **인증 신뢰경계**(별도 이슈): 백엔드가 `x-user-id` 헤더를 무검증 신뢰. 비기술 다중 사용자 제품이면 반드시 함께 해결(JWT 검증 등). `../plan-idp.md` §7 참조.
- **동시성 상한**: `MAX_CONCURRENT_ANALYSES`는 Bedrock 쿼터와 직결. 너무 높이면 스로틀, `segment-analyzer`에 이미 재시도 존재.
- **분류 품질**: 요약 기반 단건 배정. 초기 문서가 적을 땐 카테고리가 흔들릴 수 있음 → 향후 재클러스터링(R3 후속).
