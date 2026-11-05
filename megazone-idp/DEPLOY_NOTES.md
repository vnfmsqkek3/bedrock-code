# 배포 노트 — us-west-2 (profile: team3)

원본 프로젝트는 **us-east-1 전용**으로 만들어져 있어, us-west-2 배포 시 리전 이식성 문제가 여럿 발생. 이 문서는 리전 설정 + 트러블슈팅 기록.

## 대상 환경
| 항목 | 값 |
|------|-----|
| 리전 | us-west-2 |
| 계정 | 730335492431 (profile `team3`) |
| 빌드 EC2 | t4g.large (arm64), gp3 30GB, 키페어 없음(SSM 접속), public 서브넷 |
| VPC / Subnet | vpc-02932ce4d0a816062 / subnet-0a43043b44fbd04a2 (us-west-2a, public via igw-0fd86595aba044312) |
| 소스 전달 | `s3://czy1023-test-s3/idp-deploy/idp-src.tgz` |
| 배포 스크립트 | `deploy_ssm.sh` (리포 루트, EC2에서 실행) |
| 부트스트랩 | CDKToolkit: us-west-2 + **us-east-1**(CloudFront WAF용) 둘 다 필요 → 확인 완료 |

## 왜 EC2에서 빌드하나 (로컬 불가 사유)
- **회사 Zscaler TLS 검사(MITM)**: 로컬 podman 컨테이너가 crates.io/PyPI 인증서를 신뢰 못 해 모든 컨테이너 빌드(Rust/Python) TLS 실패. `ca-certificates` 재설치로 해결 안 됨(Zscaler는 공개 CA 아님).
- 백엔드 API CORS가 CloudFront 도메인만 허용 → localhost에서 실 API 호출도 불가.
- → **AWS 내부 EC2에서 빌드/배포**하면 Zscaler·CORS·툴체인 문제 모두 회피.

---

## 트러블슈팅 기록

### 1. 로컬 Docker 데몬 없음 → podman
- 로컬에 docker CLI만 있고 데몬 없음. podman 사용(`CDK_DOCKER=podman`).
- 이후 Zscaler 문제로 로컬 빌드 자체를 포기하고 EC2로 전환.

### 2. Rust Lambda 로컬 툴체인 없음
- `cargo-lambda-cdk`의 `RustFunction`이 로컬 cargo/zig 필요.
- 해결: 대부분 `forcedDockerBundling: true`로 컨테이너 빌드. **toka만 누락**돼 있어 추가함(`lance-service-stack.ts`).

### 3. VPC `fromLookup` — 첫 배포 실패
- **증상**: `[Error at /IDP-V2-Storage/Neptune/...] SSM parameter not available: /idp-v2/vpc/id` / `Could not find any VPCs matching dummy-value-for-/idp-v2/vpc/id`.
- **원인**: 여러 스택이 `Vpc.fromLookup`으로 VpcStack이 만드는 VPC를 조회하는데, 첫 배포라 VPC/SSM 파라미터가 아직 없음. `cdk deploy --all`은 전 스택을 먼저 synth하므로 조회 실패로 전체 중단.
- **해결**: **2단계 배포** — `cdk deploy IDP-V2-Vpc` 먼저 → 그 다음 `cdk deploy --all`. (`deploy_ssm.sh`에 반영)

### 4. arm64 에이전트 이미지 — 아키텍처 불일치
- **증상**: `docker build --platform linux/arm64 ... exec /bin/sh: exec format error` → `Failed to build asset IdpAgent/Runtime/AgentRuntimeArtifact`.
- **원인**: Bedrock AgentCore 런타임 이미지는 **arm64 고정**인데 빌드 EC2가 x86_64(t3.large)라 arm64 실행 불가.
- **해결(1차)**: QEMU 에뮬레이션. AL2023에서 `tonistiigi/binfmt`는 호스트에 등록 안 됨 / `qemu-user-static` dnf에 없음 → **`docker run --rm --privileged multiarch/qemu-user-static --reset -p yes`** 로 호스트 등록 성공(arm64 `uname -m`→aarch64).
- **문제점**: 에뮬레이션 하 `pip install` 의존성 해석이 **극도로 느림(이미지당 30분+)**.
- **해결(최종)**: 빌드 인스턴스를 **t4g.large(Graviton/arm64)** 로 교체 → arm64 네이티브 빌드(에뮬레이션 불필요). x86_64인 paddle-ocr는 cargo-lambda가 zig로 cross-compile하므로 arm64 호스트에서도 OK. **교훈: 이 워크로드(대부분 arm64 애셋)는 처음부터 Graviton 인스턴스가 정답.**

### 6. S3 presigned URL 리전 리다이렉트 — 업로드 "CORS 오류"
- **증상**: 앱에서 문서 업로드 시 브라우저가 "CORS 오류". 파일이 S3에 안 올라가고 파이프라인 미시작(Step Functions 실행 이력 0).
- **원인**: 백엔드 boto3 S3 클라이언트가 presigned URL을 **글로벌 엔드포인트(`bucket.s3.amazonaws.com`) + SigV2**로 생성. us-west-2 버킷이라 S3가 **307 Temporary Redirect**(→`s3-us-west-2.amazonaws.com`) 반환. 브라우저는 PUT+body의 307을 안 따라가고, 리다이렉트 응답에 CORS 헤더가 없어 "CORS 오류"로 표시. (버킷 CORS·IAM·암호화는 모두 정상이었음 — 전형적 오진 함정)
- **해결**: `packages/backend/app/s3.py` `get_s3_client()`에 `region_name` + `Config(signature_version="s3v4", s3={"addressing_style":"virtual"})` 추가 → `bucket.s3.us-west-2.amazonaws.com` + SigV4로 서명되어 리다이렉트 제거. 검증: 직접 presigned PUT 200 확인.
- **적용**: 백엔드(ECS) 재배포(`cdk deploy IDP-V2-Application`)로 이미지 재빌드.

### 7. 임베딩 모델 us-west-2 부재 — 색인 실패(채팅 답변 없음)
- **증상**: 문서 업로드·분석은 SUCCEEDED인데 **채팅 답변이 안 나옴**. lancedb-writer 로그: `LanceDB response: 500 "ValidationException: The provided model identifier is invalid."`
- **원인**: 색인(LanceDB 쓰기)은 SFN **밖 비동기**(SQS→lancedb-writer→lance-service→임베딩)라 SFN은 성공해도 여기서 실패. 임베딩 모델 `amazon.nova-2-multimodal-embeddings-v1:0`이 **us-east-1 전용, us-west-2엔 없음**.
- **해결**: **Amazon Titan Text Embeddings V2**(`amazon.titan-embed-text-v2:0`, 1024차원 동일 → LanceDB 스키마 유지)로 교체. 요청/응답 형식이 달라 **두 임베딩 구현 모두** 수정:
  - `packages/lambda/lancedb-service/src/client/bedrock.rs` (Rust, 색인+검색) — 모델 ID + 요청(`{inputText,dimensions,normalize}`)/응답(`{embedding}`) 구조체
  - `packages/infra/src/functions/shared/embeddings.py` (Python) — 동일 형식
  - `packages/infra/src/models.json` `embedding` → titan
- **적용**: `cdk deploy --all` (LanceService Rust 재빌드 + Workflow 레이어).
- **주의**: 색인 실패했던 문서는 **재업로드**(또는 LanceDB write SQS/DLQ 재구동) 필요 — 분석은 됐어도 벡터가 안 들어갔음.

### 5. S3 Express One Zone 버킷 AZ 하드코딩 — Storage 실패
- **증상**: `IDP-V2-Storage` CREATE_FAILED / `ExpressStorageDirectoryBucket ... The specified bucket is not valid`. 버킷명 `lancedb-ex-...--use1-az4--x-s3` (us-east-1 AZ).
- **원인**: `storage-stack.ts`에 `availabilityZoneId: 'use1-az4'`(us-east-1 AZ) **하드코딩**(152행 + 162행 SSM 파라미터). us-west-2엔 없는 AZ.
- **해결**: `use1-az4` → **`usw2-az1`**(us-west-2a) 로 변경. (로컬 + EC2 소스 패치)
- **주의**: ROLLBACK_FAILED 스택은 `delete-stack --retain-resources`가 **DELETE_FAILED 상태에서만** 허용됨. → 일반 `delete-stack`(→DELETE_FAILED) 후 `--retain-resources ExpressStorageDirectoryBucket...`(실재하지 않는 버킷 스킵)으로 삭제.

---

## 리전 이식성 관련 하드코딩(원본이 us-east-1 전용) — 발견 목록
| 위치 | 문제 | 조치 |
|------|------|------|
| `storage-stack.ts:152,162` | S3 Express AZ `use1-az4` 하드코딩 | → `usw2-az1` |
| `backend/app/s3.py` | presign 글로벌 엔드포인트+SigV2 → 307 리다이렉트 | → SigV4 + virtual + region (§6) |
| `lancedb-service/.../bedrock.rs` + `shared/embeddings.py` + `models.json` | 임베딩 모델 Nova가 us-west-2 부재 | → Titan v2 (§7) |
| `common/constructs/.../static-website.ts` | CloudFront WAF `region: 'us-east-1'` 고정 | AWS 규정상 정상(CloudFront WAF는 us-east-1 필수). us-east-1 부트스트랩 필요 |
| `models.json` 기타 Bedrock 모델 ID | 리전별 모델 가용성 | Claude/Titan/Cohere는 us-west-2 OK, 배포 후 모델 액세스 확인 |

## 배포 절차 (요약)
1. 소스 압축 → S3 업로드 (`idp-src.tgz`)
2. EC2(t4g.large, admin 인스턴스 프로파일) 생성 → user-data가 툴체인 설치 + 소스 다운로드 + pnpm install + 프론트 빌드
3. `deploy_ssm.sh` 실행 (2단계: Vpc → --all)
4. 로그: `s3://czy1023-test-s3/idp-deploy/deploy-ssm.log` (20초 동기화), 완료 마커 `DEPLOY_SSM_STATUS`
5. 실패 시: 실패 스택 삭제(위 §5 주의) → 소스 패치 → 재실행(애셋 캐시로 빠름)

## ✅ 배포 완료 (14/14 스택 CREATE_COMPLETE)

### 최종 출력값 (IDP-V2-Application)
| 항목 | 값 |
|------|-----|
| **앱 URL (CloudFront)** | https://ds8kle6o7q7ws.cloudfront.net |
| Backend API | https://nxrz1cfxki.execute-api.us-west-2.amazonaws.com/ |
| Cognito UserPool | us-west-2_ZgxEqvzdX |
| Cognito ClientId | 23osvm81hn1m5rqr5b8g83372o |
| Cognito IdentityPool | us-west-2:f59f3421-1d0a-448b-ae81-f0bf5b681f03 |
| Frontend 버킷 | idp-v2-frontend-730335492431 |

### 완료 체크리스트
- [x] Storage(usw2-az1) 재배포 성공
- [x] 전체 스택 배포 (Vpc·Neptune·Storage·Bda·Event·Ocr·LanceService·Workflow·Mcp·Websocket·Worker·Webcrawler·Agent·Application)
- [ ] **Bedrock 모델 액세스(team3, us-west-2) 활성화** — 배포와 별개, 런타임 분석/채팅에 필요 (Bedrock 콘솔 → Model access)
- [ ] **Cognito 로그인 사용자 생성** — Hosted UI 대신 자체 SRP 로그인이라 실제 Cognito 유저 필요 (admin/admin 목 우회는 프로덕션 빌드에서 제거됨). `aws cognito-idp admin-create-user --user-pool-id us-west-2_ZgxEqvzdX ...`
- [ ] 빌드 EC2(t4g, i-0d74ac8e869291ecf) 정리(종료) — 배포 완료 후 비용 절감

### 빌드 인스턴스
- t4g.large `i-0d74ac8e869291ecf` (arm64), 공인 IP 54.188.28.142 — 배포 후 종료 가능
- IAM: role `idp-deploy-ec2-role`(AdministratorAccess), profile `idp-deploy-ec2-profile`, SG `sg-0dedf9b2ea77c561d` (재사용 가능)
