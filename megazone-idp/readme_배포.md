# 배포 가이드 (readme_배포)

이 앱의 **프론트엔드**와 **백엔드/CDK** 배포 방법. 로컬에서 코드를 수정하고, 프론트는 S3에 직접 sync, 백엔드는 소스를 S3에 올려 EC2에서 `cdk deploy` 하는 방식.

## 0. 공통 환경

| 항목 | 값 |
|---|---|
| AWS 프로필 | `team3` |
| 리전 | `us-west-2` (오레곤) |
| 계정 | `730335492431` |
| 빌드 EC2 | `i-0d74ac8e869291ecf` (arm64 t4g.large, SSM 관리) |
| 프론트 버킷 | `idp-v2-frontend-730335492431` |
| CloudFront 배포 ID | `E38S6AGOLELCCH` (`https://ds8kle6o7q7ws.cloudfront.net`) |
| 소스 tarball 경로 | `s3://czy1023-test-s3/idp-deploy/idp-src.tgz` |
| 백엔드 스택 | `IDP-V2-Application` (Fargate 위 FastAPI) |

```bash
export AWS_PROFILE=team3 AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
```

> ⚠️ **runtime-config.json 절대 덮어쓰지 말 것.** 빌드 산출물에는 잘못된 계정(us-east-1/975050239358) placeholder가 들어있고, 버킷의 실제 라이브 설정(us-west-2/730335492431)을 반드시 보존해야 합니다. 아래 sync 명령의 `--exclude "runtime-config.json"` 필수.

---

## 1. 프론트엔드 배포 (빠름 · EC2 불필요)

프론트만 바뀐 경우. 빌드 → S3 sync → CloudFront 무효화.

```bash
cd <repo-root>
export AWS_PROFILE=team3 AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2

# 1) 프로덕션 번들 빌드 (lint 게이트 우회 위해 build 대신 bundle 타깃)
npx nx bundle frontend --skip-nx-cache

# 2) S3 sync (runtime-config.json 제외 필수)
aws s3 sync dist/packages/frontend/bundle/ s3://idp-v2-frontend-730335492431/ \
  --delete --exclude "runtime-config.json"

# 3) CloudFront 무효화
aws cloudfront create-invalidation --distribution-id E38S6AGOLELCCH --paths "/*"
```

**검증**
```bash
# 새 index.html 이 참조하는 JS 해시가 로컬 빌드와 같은지
curl -s https://ds8kle6o7q7ws.cloudfront.net/index.html | grep -oE 'assets/index-[A-Za-z0-9_]+\.js' | head -1
# 200 이면 OK
```
브라우저에서 강력 새로고침(Cmd+Shift+R).

---

## 2. 백엔드 / CDK 배포 (EC2에서 cdk deploy)

백엔드(`packages/backend`) 또는 CDK(`packages/infra`)가 바뀐 경우. 백엔드는 Fargate 이미지라 CDK 배포(이미지 재빌드 + 롤링 업데이트)가 필요.

### 2-1. 로컬: 소스 압축 → S3 업로드

`node_modules` 등은 제외 (EC2의 `/root/idp`에 덮어쓰기 방식이라 EC2의 node_modules는 유지됨). 의존성 추가가 없으면 pnpm install 불필요.

```bash
cd <repo-root>
tar czf /tmp/idp-src.tgz \
  --exclude='./.git' --exclude='node_modules' --exclude='./.venv' \
  --exclude='./dist' --exclude='./.nx' --exclude='cdk.out' \
  --exclude='./packages/*/dist' --exclude='*.log' \
  -C "$(pwd)" .

aws s3 cp /tmp/idp-src.tgz s3://czy1023-test-s3/idp-deploy/idp-src.tgz --region us-west-2
```

### 2-2. EC2: SSM으로 다운로드 → 추출 → cdk deploy

아래 스크립트를 SSM `AWS-RunShellScript`로 EC2에서 실행. (전체 스택이 아니라 백엔드 스택만: `IDP-V2-Application --exclusively`)

```bash
# 스크립트 파일 작성
cat > /tmp/be-deploy.sh <<'EOF'
set -x
export HOME=/root AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 CDK_DEFAULT_REGION=us-west-2
export NVM_DIR=/root/.nvm
. "$NVM_DIR/nvm.sh"; nvm use 22
export PATH=/root/.local/bin:$PATH
LOG=/var/log/idp-backend-deploy.log
exec > "$LOG" 2>&1
S3PREFIX=s3://czy1023-test-s3/idp-deploy
( while true; do aws s3 cp "$LOG" "$S3PREFIX/backend-deploy.log" --region us-west-2 >/dev/null 2>&1; sleep 15; done ) &
HB=$!
aws s3 cp "$S3PREFIX/idp-src.tgz" /tmp/idp-src.tgz --region us-west-2
mkdir -p /root/idp && tar xzf /tmp/idp-src.tgz -C /root/idp
cd /root/idp/packages/infra || { echo "NO INFRA DIR"; exit 1; }
npx cdk deploy IDP-V2-Application --require-approval never --exclusively 2>&1
RC=$?
echo "===== CDK_DEPLOY_EXIT=$RC ====="
kill $HB 2>/dev/null
aws s3 cp "$LOG" "$S3PREFIX/backend-deploy.log" --region us-west-2
EOF

# SSM 파라미터 JSON 생성 후 전송
python3 - <<'PY'
import json
json.dump({"commands":[open("/tmp/be-deploy.sh").read()],"executionTimeout":["3600"]}, open("/tmp/ssm-params.json","w"))
PY

aws ssm send-command --instance-ids i-0d74ac8e869291ecf \
  --document-name "AWS-RunShellScript" --timeout-seconds 600 \
  --parameters file:///tmp/ssm-params.json \
  --query 'Command.CommandId' --output text
```

### 2-3. 진행/결과 확인

```bash
CMD_ID=<위에서 나온 CommandId>
# 상태 폴링 (Success/Failed)
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id i-0d74ac8e869291ecf --query 'Status' --output text
# 배포 로그
aws s3 cp s3://czy1023-test-s3/idp-deploy/backend-deploy.log - | tail -40
# 성공 시: "✅ IDP-V2-Application" + "CDK_DEPLOY_EXIT=0"
```

**ECS 안정화 확인**
```bash
CL=$(aws ecs list-clusters --query 'clusterArns[?contains(@,`IDP-V2`)]|[0]' --output text)
SV=$(aws ecs list-services --cluster "$CL" --query 'serviceArns[?contains(@,`Backend`)]|[0]' --output text)
aws ecs describe-services --cluster "$CL" --services "$SV" \
  --query 'services[0].{running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}' --output json
# running==desired, rollout=COMPLETED 이면 OK
```

소요: 약 3~5분 (도커 레이어 캐시 + Fargate 롤링 업데이트).

---

## 3. 트러블슈팅

### "No bucket named 'cdk-hnb659fds-assets-730335492431-us-west-2'. Is account bootstrapped?"
CDK 부트스트랩 에셋 버킷이 **삭제된** 경우. (CDKToolkit 스택은 소유한다고 표시하지만 실물이 없음.) 재생성하면 해결:

```bash
B=cdk-hnb659fds-assets-730335492431-us-west-2
aws s3api create-bucket --bucket "$B" --region us-west-2 --create-bucket-configuration LocationConstraint=us-west-2
aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-public-access-block --bucket "$B" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-policy --bucket "$B" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"DenyInsecure\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$B\",\"arn:aws:s3:::$B/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
```
그 후 2-2 재실행.

### 전체 스택을 배포해야 할 때
`deploy_ssm.sh`가 참고용(온-EC2, `--all` 2단계: VPC 먼저 → 나머지). AgentCore arm64 이미지 빌드용 QEMU 세팅 포함.

### 채팅이 안 될 때 (참고)
- WebSocket은 `runtime-config.json`의 `websocketUrl`(https)을 프론트에서 `wss://`로 변환해 연결. 이 파일이 보존됐는지 먼저 확인.
- "An internal error occurred" 는 Bedrock AgentCore 런타임 측 에러(콜드스타트/타임아웃)일 수 있음 — 프론트 재배포로는 안 고쳐짐. 에이전트 로그: `/aws/bedrock-agentcore/runtimes/idp_agent-*-DEFAULT`.

---

## 4. 요약 치트시트

```bash
# 프론트만
npx nx bundle frontend --skip-nx-cache
aws s3 sync dist/packages/frontend/bundle/ s3://idp-v2-frontend-730335492431/ --delete --exclude "runtime-config.json"
aws cloudfront create-invalidation --distribution-id E38S6AGOLELCCH --paths "/*"

# 백엔드/CDK
tar czf /tmp/idp-src.tgz --exclude='./.git' --exclude='node_modules' --exclude='./.venv' --exclude='./dist' --exclude='./.nx' --exclude='cdk.out' --exclude='./packages/*/dist' --exclude='*.log' -C "$(pwd)" .
aws s3 cp /tmp/idp-src.tgz s3://czy1023-test-s3/idp-deploy/idp-src.tgz --region us-west-2
# → 2-2 의 SSM send-command 실행
```
