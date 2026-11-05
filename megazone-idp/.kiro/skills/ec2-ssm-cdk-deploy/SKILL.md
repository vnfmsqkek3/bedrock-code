---
name: ec2-ssm-cdk-deploy
description: |
  megazone-idp(IDP-V2) CDK 앱을 빌드 EC2·SSM 경유로 자동 배포하는 플레이북. 필요 입력(AWS 프로파일·리전)을 받고,
  arm64 t4g.large 빌드 EC2를 생성하거나 재사용하며, 로컬 소스를 S3 경유로 전송한 뒤 EC2에서 cdk deploy를 원격 실행한다.
  전체 배포(--all, 2단계: Vpc 먼저 → 나머지)와 부분 배포(프론트만 S3 sync / 백엔드 IDP-V2-Application만 / 특정 스택만)를
  모두 지원한다. CDK bootstrap drift, agent 이미지용 arm64 QEMU 세팅, SSM 1시간 타임아웃, 스택 의존성을 사전 점검·자동
  복구한다. 사용 시점: 사용자가 이 프로젝트를 AWS(EC2/SSM)로 배포·재배포해달라고 요청할 때, 프론트/백엔드/특정 스택만
  배포를 언급할 때, cdk deploy 원격 배포나 배포 오류 복구가 필요할 때.
license: Proprietary
compatibility: |
  로컬에 AWS CLI가 설치되고 관리자 권한 프로파일이 구성되어야 한다. 배포 대상 리전에서 Bedrock 모델(Claude Sonnet 4.6 /
  Haiku 4.5, Titan Embed v2) + AgentCore가 지원되어야 한다. 빌드 EC2는 반드시 **arm64 (t4g.large)** — 이 프로젝트의
  백엔드·에이전트·Rust 람다가 arm64로 빌드되므로 x86 인스턴스를 쓰면 안 된다. AL2023 + Docker + Node 22(nvm) + pnpm +
  uv/Python 3.13 환경을 요구한다. workspace 루트에 이 CDK 앱(packages/infra, packages/frontend, packages/backend)이
  존재해야 한다.
---

# EC2 · SSM 자동 CDK 배포 — megazone-idp (Kiro 플레이북)

이 스킬은 Kiro가 **arm64 빌드 EC2에 SSM으로 접속해 IDP-V2 CDK 앱을 자동 배포**하고, 오류 시 스스로 진단·복구해 재배포하는
절차다. 스킬 설명 매칭으로 활성화된다.

> ⚠️ **이 프로젝트는 arm64 전용이다.** 빌드 EC2는 반드시 **t4g.large(arm64/Graviton)** 를 쓴다. 백엔드 Fargate 이미지,
> Bedrock AgentCore 런타임 이미지, Rust 람다(lancedb-service·toka·paddle-ocr)가 모두 arm64로 빌드되므로 x86(t3 등)에서
> 빌드하면 아키텍처 불일치로 실패한다.

## 0. 배포의 전제

- **빌드는 로컬이 아니라 EC2에서** 한다. Fargate/AgentCore 이미지 빌드에 Docker가 필요하고, 리전·권한 환경을 통제하기
  위함이다. 로컬은 소스를 tar로 묶어 S3에 올리는 역할만 한다.
- 프론트엔드 런타임 설정은 배포 시 버킷의 `runtime-config.json`이 담당한다 — **이 파일은 절대 덮어쓰지 않는다**(§4 참고).
- 14개 스택은 모두 SSM 파라미터(`packages/common/constructs/src/constants/ssm-keys.ts`)로 값을 주고받는다.

### 스택 목록 (`packages/infra/src/main.ts`)
`IDP-V2-Vpc`, `IDP-V2-Neptune`, `IDP-V2-Storage`, `IDP-V2-Event`, `IDP-V2-Ocr`, `IDP-V2-Bda`, `IDP-V2-Websocket`,
`IDP-V2-Mcp`, `IDP-V2-Worker`, `IDP-V2-Agent`, `IDP-V2-Webcrawler`, `IDP-V2-LanceService`, `IDP-V2-Workflow`,
`IDP-V2-Application`.

| 무엇을 바꿨나 | 배포 대상 스택 | 방법 |
|---|---|---|
| 프론트(`packages/frontend`)만 | 없음(S3 직접) | §5 — 빌드 → S3 sync → CloudFront 무효화 (EC2 불필요, 빠름) |
| 백엔드(`packages/backend`)만 | `IDP-V2-Application` | §6 — `cdk deploy IDP-V2-Application --exclusively` |
| 분류기·파이프라인 | `IDP-V2-Workflow` | §6 — 스택명만 교체 |
| 채팅 프롬프트·에이전트 스킬 | `IDP-V2-Agent` | §6 — **arm64 이미지 재빌드 → QEMU 필요(§3-2)** |
| 인프라 전체/최초 | 전체 | §7 — 2단계 `--all`(Vpc 먼저) |

## 1. 사용자에게 입력받기 (먼저 질문)

**필수 항목**이 없으면 진행하지 않는다.

| 값 | 필수 | 예시 | 용도 |
|---|---|---|---|
| AWS 프로파일 | ✅ | `team3` | 로컬에서 EC2/SSM/CFN 호출 |
| 리전 | ✅ | `us-west-2` | 배포 대상 리전 |
| 배포 범위 | ✅ | `front` / `backend` / `<스택명>` / `all` | 위 표 참고 |
| 초기 이메일 | ✅(`all` 시) | `admin@example.com` | Cognito 초기 관리자 계정 이메일 (§7-1) |
| 초기 비밀번호 | ✅(`all` 시) | `MyP@ss1234!` | Cognito 초기 임시 비밀번호 (첫 로그인 시 변경 필수) |
| EC2 인스턴스 ID | 선택 | `i-0abc…` | 기존 빌드 EC2. 없으면 §2에서 자동 생성 |
| VPC 모드 | 선택 | `default`/`existing`/`new` | 기본 `default`. **빌드 EC2 전용 VPC는 IDP 앱 VPC(`IDP-V2-Vpc`)와 반드시 분리**할 것 |

> **초기 이메일/비밀번호**: 배포 범위가 `all`(최초 배포)인 경우 필수. Cognito User Pool은 `selfSignUpEnabled: false`로
> 설정되어 있어 관리자가 직접 사용자를 만들어야 한다. 배포 완료 후 §7-1에서 이 값으로 초기 관리자 계정을 자동 생성한다.
> 비밀번호 정책: **최소 8자, 대소문자 + 숫자 + 특수문자** 필수. 임시 비밀번호는 3일 유효이며 첫 로그인 시 변경된다.

> ⚠️ **빌드 EC2를 IDP 앱 VPC(`IDP-V2-Vpc/Vpc`) 안에 두지 말 것.** destroy 시 앱 VPC를 지우려는데 빌드 EC2가 그 안에
> 있으면 실행 주체가 죽고 VPC 삭제도 막힌다. 별도 VPC(default 또는 new)에 둔다.

로컬에서 프로파일·리전 즉시 확보 후:
```bash
export AWS_PROFILE=<프로파일> AWS_REGION=<리전> AWS_DEFAULT_REGION=<리전>
aws sts get-caller-identity   # 계정 확인
```

## 1-0. CDK Bootstrap 상태 확인 (프로파일·리전 확보 즉시)

CDKToolkit 스택 상태만 보고 판단하지 말 것 — **스택은 `CREATE_COMPLETE`인데 assets 버킷이 out-of-band로 삭제된 drift**가
흔하고, 이때 `cdk deploy`가 `No bucket named 'cdk-hnb659fds-assets-…'` / `needs bootstrapping`으로 실패한다. **① 스택 +
② assets 버킷 + ③ 버전 파라미터**를 함께 확인한다.

```bash
ACCT=$(aws sts get-caller-identity --query Account --output text)
Q=hnb659fds
aws cloudformation describe-stacks --stack-name CDKToolkit --query "Stacks[0].StackStatus" --output text 2>&1
aws s3api head-bucket --bucket "cdk-${Q}-assets-${ACCT}-<리전>" 2>&1 && echo BUCKET_OK || echo BUCKET_MISSING
aws ssm get-parameter --name /cdk-bootstrap/${Q}/version --query Parameter.Value --output text 2>&1
```

| 스택 | assets 버킷 | 조치 |
|---|---|---|
| COMPLETE | 존재(+version) | 정상 → 부트스트랩 건너뛰고 배포로 |
| COMPLETE | **없음** | **drift** → §1-0-1로 버킷 재생성 (또는 재부트스트랩) |
| ROLLBACK/없음 | 무관 | `cdk bootstrap` 정상 실행 |

### 1-0-1. Bootstrap assets 버킷 drift 복구 (실측 처방)
스택은 있는데 버킷만 삭제된 경우, 버킷만 재생성하면 배포가 통한다:
```bash
B=cdk-hnb659fds-assets-${ACCT}-<리전>
aws s3api create-bucket --bucket "$B" --region <리전> --create-bucket-configuration LocationConstraint=<리전>
aws s3api put-bucket-versioning --bucket "$B" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-public-access-block --bucket "$B" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-policy --bucket "$B" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"DenyInsecure\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$B\",\"arn:aws:s3:::$B/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
```

## 2. 빌드 EC2 자동 생성 (arm64 t4g.large)

인스턴스 ID를 주면 재사용하고, 없으면 아래로 생성한다. **인스턴스 타입·AMI는 arm64여야 한다.**

### 2-1. IAM Role (Admin + SSM) — 없으면 생성
```bash
cat > /tmp/ec2-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam create-role --role-name IdpV2DeployRole --assume-role-policy-document file:///tmp/ec2-trust.json 2>&1 || echo "exists"
aws iam attach-role-policy --role-name IdpV2DeployRole --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam attach-role-policy --role-name IdpV2DeployRole --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name IdpV2DeployProfile 2>&1 || echo "exists"
aws iam add-role-to-instance-profile --instance-profile-name IdpV2DeployProfile --role-name IdpV2DeployRole 2>&1 || true
sleep 10
```

### 2-2. VPC/서브넷/보안그룹
기본은 계정 default VPC의 퍼블릭 서브넷을 쓴다(가장 빠름). `new` 모드가 필요하면 겹치지 않는 `/16`을 골라 VPC+IGW+
퍼블릭 서브넷+라우트를 만든다. **어느 경우든 `IDP-V2-Vpc`와 분리**해야 한다(§1 경고). SSM만 쓰므로 인바운드 불필요:
```bash
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query "Vpcs[0].VpcId" --output text)
SUBNET_ID=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=default-for-az,Values=true" --query "Subnets[0].SubnetId" --output text)
SG_ID=$(aws ec2 create-security-group --group-name idp-deploy-sg --description "IDP-V2 build EC2 (outbound only)" --vpc-id "$VPC_ID" --query GroupId --output text)
```

### 2-3. 최신 **arm64** AL2023 AMI
```bash
AMI_ID=$(aws ssm get-parameters \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query "Parameters[0].Value" --output text)
```
> ⚠️ 반드시 **`…-arm64`** 파라미터. x86_64 AMI를 t4g에 붙이면 부팅 안 됨.

### 2-4. EC2 생성 (t4g.large)
```bash
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" --instance-type t4g.large \
  --iam-instance-profile Name=IdpV2DeployProfile \
  --subnet-id "$SUBNET_ID" --security-group-ids "$SG_ID" --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications '[{"ResourceType":"instance","Tags":[{"Key":"Name","Value":"IdpV2-Deploy"}]}]' \
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2" \
  --query "Instances[0].InstanceId" --output text)
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
```
| 항목 | 값 |
|---|---|
| 타입 | **`t4g.large`** (2 vCPU, 8 GiB, **arm64/Graviton**) |
| 스토리지 | gp3 30 GB |
| IAM | `IdpV2DeployRole` (Admin + SSM) |
| OS | Amazon Linux 2023 **arm64** |

### 2-5. SSM 연결 대기 + 도구 설치
```bash
for i in $(seq 1 18); do
  S=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE_ID" --query "InstanceInformationList[0].PingStatus" --output text 2>/dev/null)
  [ "$S" = "Online" ] && { echo SSM_READY; break; }; sleep 10
done
```
필요 도구(SSM으로 설치): Node 22(nvm), `corepack enable pnpm`, uv/Python 3.13, git, **Docker**(`dnf install docker -y &&
systemctl start docker`). arm64 네이티브라 QEMU 없이도 arm64 이미지를 빌드하지만, **AgentCore 이미지 빌드가 특정 베이스를
요구하면** §3-2의 QEMU 세팅을 그대로 따른다.

## 2-1. 로컬 소스를 S3 경유로 EC2에 전송 (git clone 아님)

### 2-1-0. 프로젝트 전용 배포버킷 확보 (`<배포버킷>` 결정)
소스·스크립트·로그 전송에 쓸 버킷은 **이 프로젝트 전용 고유 버킷**을 쓴다(공용 유틸 버킷 재사용 금지). S3 버킷명은 전역
유일해야 하므로 **계정 ID + 리전**을 넣어 결정적이면서 계정 간 충돌이 없게 만든다. 없으면 자동 생성한다:
```bash
ACCT=$(aws sts get-caller-identity --query Account --output text)
DEPLOY_BUCKET="idp-v2-deploy-${ACCT}-<리전>"          # 예: idp-v2-deploy-730335492431-us-west-2
if ! aws s3api head-bucket --bucket "$DEPLOY_BUCKET" 2>/dev/null; then
  if [ "<리전>" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$DEPLOY_BUCKET" --region us-east-1
  else
    aws s3api create-bucket --bucket "$DEPLOY_BUCKET" --region <리전> \
      --create-bucket-configuration LocationConstraint=<리전>
  fi
  aws s3api put-public-access-block --bucket "$DEPLOY_BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi
echo "DEPLOY_BUCKET=$DEPLOY_BUCKET"   # 이후 모든 <배포버킷> 자리에 이 값을 쓴다
```
> 계정 ID+리전 조합이라 **다시 배포해도 같은 이름을 재사용**(멱등)하고, 다른 계정/리전과 겹치지 않는다. 이 버킷은 배포
> 전용이므로 destroy 스킬이 정리 대상으로 인식하도록 §8 `resources.s3_bucket`에 `purpose: "idp-v2 배포 전송 전용"`,
> `created_by_deploy: true`로 기록한다. (원하면 사용자가 `-<날짜>`나 랜덤 접미사를 더 붙여 완전 고유화해도 되지만,
> 계정+리전만으로 이미 충돌하지 않는다.)

```bash
# 로컬에서: node_modules 등 제외하고 tar → S3
tar czf /tmp/idp-src.tgz \
  --exclude='./.git' --exclude='node_modules' --exclude='./.venv' \
  --exclude='./dist' --exclude='./.nx' --exclude='cdk.out' \
  --exclude='./packages/*/dist' --exclude='*.log' \
  -C "$(pwd)" .
aws s3 cp /tmp/idp-src.tgz "s3://$DEPLOY_BUCKET/idp-deploy/idp-src.tgz" --region <리전>
```
> EC2에서는 `/root/idp`에 **덮어쓰기 추출**한다 — 기존 `node_modules`가 유지돼 의존성 추가가 없으면 `pnpm install` 불필요.

## 3. 배포 실행 (SSM · detached + 로그 미러)

> ⚠️ **SSM `AWS-RunShellScript`에는 executionTimeout이 있고 그 시간이 지나면 실행 중인 명령을 KILL한다.** 이 프로젝트의
> 전체 배포/agent 이미지 빌드는 길 수 있으니, **detached로 분리**(`setsid … </dev/null >/dev/null 2>&1 & disown`)하고,
> 로그를 S3로 15초마다 미러링해 로컬에서 tail한다. 배포 스크립트는 `deploy_ssm.sh`(온-EC2 레퍼런스)를 참고한다.

배포 스크립트 골격(SSM으로 EC2에 전달):
```bash
set -x
export HOME=/root AWS_REGION=<리전> AWS_DEFAULT_REGION=<리전> CDK_DEFAULT_REGION=<리전>
export NVM_DIR=/root/.nvm; . "$NVM_DIR/nvm.sh"; nvm use 22
export PATH=/root/.local/bin:$PATH
LOG=/var/log/idp-deploy.log; exec > "$LOG" 2>&1
S3PREFIX=s3://<배포버킷>/idp-deploy       # §2-1-0의 idp-v2-deploy-<account>-<리전>
( while true; do aws s3 cp "$LOG" "$S3PREFIX/deploy.log" --region <리전> >/dev/null 2>&1; sleep 15; done ) &
HB=$!
aws s3 cp "$S3PREFIX/idp-src.tgz" /tmp/idp-src.tgz --region <리전>
mkdir -p /root/idp && tar xzf /tmp/idp-src.tgz -C /root/idp
cd /root/idp

# ⚠️ 프론트엔드 빌드 (CDK synth 전 필수)
# IDP-V2-Application 스택이 dist/packages/frontend/bundle 을 S3 에셋으로 참조하므로,
# cdk deploy 전에 반드시 프론트엔드 번들을 생성해야 한다.
# 이 단계 없이 cdk deploy를 하면 "Cannot find asset at .../frontend/bundle" 에러로 실패한다.
pnpm install --frozen-lockfile
npx nx bundle frontend --skip-nx-cache

cd /root/idp/packages/infra || { echo NO_INFRA; exit 1; }
# ↓↓↓ 배포 범위에 따라 이 줄만 교체 ↓↓↓
npx cdk deploy <스택 또는 --all> --require-approval never --exclusively 2>&1
echo "CDK_DEPLOY_EXIT=$?"
kill $HB 2>/dev/null
aws s3 cp "$LOG" "$S3PREFIX/deploy.log" --region <리전>
```

> ⚠️ **CDK synth 시 프론트엔드 빌드 필수**: `IDP-V2-Application` 스택은 `dist/packages/frontend/bundle` 디렉터리를
> `BucketDeployment` 에셋으로 참조한다. 이 디렉터리가 존재하지 않으면 CDK synth 자체가 `ValidationError: Cannot find
> asset at /root/idp/dist/packages/frontend/bundle`로 실패한다. 따라서 **`cdk deploy` 전에 반드시
> `npx nx bundle frontend --skip-nx-cache`를 실행**해야 한다. 이는 배포 범위가 프론트와 무관한 스택이라도 마찬가지다
> (`--all`이든 `--exclusively`든 CDK는 전체 앱을 synth하기 때문).

### 3-1. detached 실행 (SSM 타임아웃 회피)
스크립트를 S3에 올린 뒤, EC2가 내려받아 **분리 실행**하게 한다(중첩 따옴표 파싱 문제를 피하려 params는 JSON 파일로):
```bash
aws s3 cp /tmp/deploy-script.sh s3://<배포버킷>/idp-deploy/deploy-script.sh --region <리전>
python3 -c "import json;json.dump({'commands':['aws s3 cp s3://<배포버킷>/idp-deploy/deploy-script.sh /root/d.sh --region <리전>; setsid bash /root/d.sh </dev/null >/dev/null 2>&1 & disown; sleep 3; pgrep -af d.sh || echo NONE; echo LAUNCHED'],'executionTimeout':['120']},open('/tmp/p.json','w'))"
aws ssm send-command --instance-ids <INSTANCE_ID> --document-name AWS-RunShellScript --timeout-seconds 90 --parameters file:///tmp/p.json --query Command.CommandId --output text
```
진행 모니터: 로컬에서 `aws cloudformation describe-stacks` + `aws s3 cp s3://<배포버킷>/idp-deploy/deploy.log - | tail`.

### 3-2. Agent 스택은 arm64 QEMU 세팅 필요
`IDP-V2-Agent` 또는 `--all`을 배포할 때 AgentCore arm64 이미지를 빌드한다. arm64 EC2라도 특정 베이스 emulation이 필요하면
배포 전에 (스크립트 안에서) 아래를 실행하고 `aarch64` 확인:
```bash
mount | grep -q binfmt_misc || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc || true
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes
docker run --rm --platform linux/arm64 public.ecr.aws/docker/library/python:3.12-slim uname -m   # → aarch64
```

## 4. 프론트 배포 (S3 sync · EC2 불필요)

프론트(`packages/frontend`)만 바뀐 경우 — 빠름:
```bash
export AWS_PROFILE=<프로파일> AWS_REGION=<리전> AWS_DEFAULT_REGION=<리전>
npx nx bundle frontend --skip-nx-cache        # lint 게이트 우회 위해 build 대신 bundle
aws s3 sync dist/packages/frontend/bundle/ s3://<프론트버킷>/ --delete --exclude "runtime-config.json"
aws cloudfront create-invalidation --distribution-id <배포ID> --paths "/*"
```
> ⚠️ **`runtime-config.json`을 절대 sync하지 말 것**(`--exclude` 필수). 빌드 산출물엔 잘못된 계정/리전 placeholder가 들어
> 있고, 버킷의 라이브 설정을 보존해야 한다. 기본값: 프론트버킷 `idp-v2-frontend-<account>`, 배포ID는 CloudFront에서 조회.
검증: `curl -s https://<도메인>/index.html | grep -oE 'assets/index-[A-Za-z0-9_]+\.js' | head -1` 가 로컬 빌드 해시와 일치.

## 5. 부분/전체 배포 대상별 명령

§3 스크립트의 `cdk deploy` 줄만 교체한다.

| 범위 | 명령 | 비고 |
|---|---|---|
| 백엔드만 | `npx cdk deploy IDP-V2-Application --require-approval never --exclusively` | Fargate 이미지 재빌드+롤링, ~3-5분 |
| 분류기·파이프라인 | `npx cdk deploy IDP-V2-Workflow --require-approval never --exclusively` | Python 람다 번들, 가벼움 |
| 에이전트·프롬프트 | `npx cdk deploy IDP-V2-Agent --require-approval never --exclusively` | **arm64 이미지 재빌드 → §3-2 QEMU 먼저** |
| 전체/최초 | **2단계**: `npx cdk deploy IDP-V2-Vpc --require-approval never` → 성공 후 `npx cdk deploy --all --require-approval never --concurrency 3` | Vpc가 먼저 SSM 파라미터를 만들어야 나머지가 `Vpc.fromLookup` 해결 |

> **⚠️ 채팅 프롬프트 재시딩 함정**: `IDP-V2-Agent`의 chat/webcrawler system prompt는 `onCreate`-only 커스텀 리소스라
> **재배포로 갱신되지 않는다**. `packages/infra/src/prompts/chat/system_prompt.txt` 등을 바꿨으면 배포 후 수동 업로드:
> `aws s3 cp packages/infra/src/prompts/chat/system_prompt.txt s3://idp-v2-agent-storage-<account>/__prompts/chat/system_prompt.txt --content-type text/plain`.
> (analysis 프롬프트와 `.skills/**/SKILL.md`는 정상 반영됨 — SKILL.md는 이미지에 포함.)

## 6. 오류 자동 수정 루프

로그에서 오류가 보이면 **근본 원인 한 곳만** 고쳐 재배포(최대 5회 후 보고).

| 증상 | 원인 | 처방 |
|---|---|---|
| `Cannot find asset at …/frontend/bundle` | 프론트엔드 미빌드 상태에서 CDK synth | `cdk deploy` 전에 `npx nx bundle frontend --skip-nx-cache` 실행 (§3 스크립트 참고) |
| `No bucket named 'cdk-hnb659fds-assets-…'` / `needs bootstrapping` | bootstrap assets 버킷 drift | §1-0-1로 버킷 재생성 |
| `Cannot connect to the Docker daemon` | Docker 미기동 | `systemctl start docker`; ec2-user docker 그룹 |
| arm64/exec format / `exec /… : exec format error` | **x86 EC2에서 빌드**했거나 QEMU 미설정 | 반드시 **t4g(arm64)**; agent 이미지엔 §3-2 QEMU |
| `AccessDeniedException … bedrock … model` | 리전에 모델 미활성 | Bedrock 콘솔에서 모델 액세스 활성화, 또는 `models.json`을 그 리전 ACTIVE 모델로 |
| SSM 명령이 도중에 죽음 | executionTimeout에 KILL | §3-1 **detached** 실행 |
| `Export … cannot be deleted/updated as it is in use` | 스택 간 SSM/export 의존 | `--exclusively` 유지, 필요시 `--all`로 |
| 프론트 배포 후 반영 안 됨 | CloudFront 캐시 | 무효화 `create-invalidation` + 강력 새로고침 |

## 7. 배포 후 검증

- **프론트**: `curl` 로 라이브 `index.html` JS 해시가 새 빌드와 일치 + HTTP 200. CloudFront 무효화 `Completed`.
- **백엔드**: ECS 서비스 `running==desired`, `deployments[0].rolloutState=COMPLETED`.
  ```bash
  CL=$(aws ecs list-clusters --query 'clusterArns[?contains(@,`IDP-V2`)]|[0]' --output text)
  SV=$(aws ecs list-services --cluster "$CL" --query 'serviceArns[?contains(@,`Backend`)]|[0]' --output text)
  aws ecs describe-services --cluster "$CL" --services "$SV" --query 'services[0].{r:runningCount,d:desiredCount,s:deployments[0].rolloutState}'
  ```
- **분류기/워크플로우**: `aws lambda get-function-configuration --function-name idp-v2-document-classifier --query '{Model:Environment.Variables.CLASSIFIER_MODEL_ID,Modified:LastModified}'`.
- **에이전트 이미지**: ECR `cdk-hnb659fds-container-assets-<account>-<리전>`에 새 이미지 push 시각 확인.

### 7-1. Cognito 초기 관리자 계정 생성 (전체 배포 시 필수)

배포 범위가 `all`(최초 배포)이고 §1에서 초기 이메일/비밀번호를 입력받았으면, 배포 완료 직후 Cognito User Pool에
관리자 계정을 생성한다. **User Pool은 `selfSignUpEnabled: false`이므로 이 단계 없이는 로그인 불가.**

```bash
# User Pool ID 조회 (SSM 파라미터 또는 CFN 출력에서)
USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 \
  --query "UserPools[?Name.contains(@,'IDP-V2')].Id|[0]" --output text)
# 또는 직접: aws cloudformation describe-stacks --stack-name IDP-V2-Application 에서 Cognito UserPool 리소스 조회

# 초기 관리자 사용자 생성
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username admin \
  --user-attributes \
    Name=email,Value=<초기이메일> \
    Name=email_verified,Value=true \
  --temporary-password '<초기비밀번호>' \
  --message-action SUPPRESS

echo "Cognito admin user created. First login will require password change."
```

| 항목 | 값 |
|---|---|
| Username | `admin` |
| Email | §1에서 입력받은 초기 이메일 |
| 임시 비밀번호 | §1에서 입력받은 초기 비밀번호 |
| 상태 | `FORCE_CHANGE_PASSWORD` (첫 로그인 시 변경 필수) |
| 유효기간 | 3일 (이후 만료되면 재생성 필요) |

> **비밀번호 정책**: 최소 8자, 대문자 + 소문자 + 숫자 + 특수문자 필수. 정책에 맞지 않으면 생성이 거부된다.
> 입력받은 비밀번호가 정책에 맞지 않으면 사용자에게 알리고 재입력을 요청한다.

> **재배포 시**: User Pool에 이미 사용자가 있으면 이 단계를 건너뛴다. `aws cognito-idp list-users --user-pool-id
> "$USER_POOL_ID" --limit 1`로 확인 후, 사용자가 존재하면 skip.

## 8. deploy_list 기록 (CFN 밖 리소스 생성 즉시)

배포 중 만든 EC2·IAM·SG·(new VPC면 네트워크)·소스버킷을 `scripts/deploy/deploy_list.json`에 기록한다(destroy 스킬이
참조). 스키마는 destroy 스킬 §7과 동일. **`resources.vpc.created_by_deploy`** 플래그가 destroy의 VPC 삭제 여부를 가른다.

## 9. 가드레일

- EC2에 장기 자격증명을 심지 않는다(인스턴스 역할 사용).
- **arm64(t4g) 아닌 인스턴스로 빌드하지 않는다.**
- `runtime-config.json`을 프론트 sync에서 **항상 제외**한다.
- 사용자 확인 없이 기존 스택을 삭제하지 않는다. destroy는 짝 스킬 `ec2-ssm-cdk-destroy`로 명시 요청 시에만.
- 빌드 EC2를 `IDP-V2-Vpc` 안에 두지 않는다.

## 10. 관련 자료
- **[.kiro/skills/ec2-ssm-cdk-destroy/SKILL.md](../ec2-ssm-cdk-destroy/SKILL.md)**: 짝이 되는 삭제 스킬.
- **[deploy_ssm.sh](../../../deploy_ssm.sh)**: 온-EC2 전체 배포(`--all` 2단계 + QEMU) 레퍼런스 스크립트.
- **[readme_배포.md](../../../readme_배포.md)**: 프론트/백엔드 배포 치트시트와 트러블슈팅.
