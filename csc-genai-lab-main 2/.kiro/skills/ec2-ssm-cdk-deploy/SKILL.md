---
name: ec2-ssm-cdk-deploy
description: |
  GenAI Lab CDK 앱을 EC2·SSM 경유로 자동 배포하는 플레이북. 필요 입력(AWS 프로파일·리전·관리자 이메일)을 받고,
  EC2를 생성하거나 재사용하며, 소스를 S3 경유로 전송한 뒤 remote-deploy.sh를 원격 실행한다. CDK bootstrap drift,
  리전별 Bedrock 모델 미스매치, 고정이름 IAM 역할 충돌, 스택 의존성 race 등 반복 발생하는 실패를 사전 점검·자동
  복구하고, 생성된 모든 리소스를 scripts/deploy/deploy_list.json에 기록한다. 사용 시점: 사용자가 이 프로젝트를
  AWS(EC2/SSM)로 배포·재배포해달라고 요청할 때, remote-deploy.sh 실행이나 CDK 원격 배포를 언급할 때, 새 리전으로
  배포하기 전 리전별 하드코딩 점검이 필요할 때.
license: Proprietary
compatibility: |
  로컬에 AWS CLI가 설치되어 있고 관리자 권한을 가진 프로파일이 구성되어 있어야 한다. 배포 대상 리전에서 Bedrock
  모델·guardrails가 지원되어야 하며, EC2는 Amazon Linux 2023 + Docker + Node 20/pnpm/Python 3.10+ 환경을
  요구한다. workspace 루트에 이 CDK 앱(packages/cdk_infra, packages/reactjs_ui, scripts/deploy/)이 존재해야 한다.
---

# EC2 · SSM 자동 CDK 배포 (Kiro 플레이북)

이 스킬은 Kiro가 사용자의 EC2에 **SSM으로 접속해 이 CDK 앱을 자동 배포**하고, 배포 중 오류가 나면 **스스로 진단·복구해
재배포**하며, **Cognito·이메일 설정을 자동 구성**하는 절차를 담는다. 스킬 설명 매칭으로 활성화되므로 별도 트리거
문자열은 필요 없다. 활성화되면 아래 순서를 그대로 따른다.

## 0. 이 배포의 전제

- 프론트엔드 Cognito 설정은 **더 이상 수동 입력이 아니다.** `WebsiteStack`(PDK StaticWebsite)이 배포 시
  `runtime-config.json`(API URL + Cognito ID)을 사이트 루트에 주입한다. 즉 배포만 성공하면 웹앱 설정은 자동으로
  맞춰진다. 스킬의 역할은 "배포를 끝까지 성공시키는 것".
- Lambda 번들링에 **Docker가 필요**하므로 EC2에 Docker 데몬이 떠 있어야 한다.

## 1. 사용자에게 입력받기 (먼저 질문)

다음을 물어보고 확보한 뒤 진행한다. **필수 항목**이 없으면 진행하지 않는다.

| 값 | 필수 | 예시 | 용도 |
|---|---|---|---|
| AWS 프로파일 | ✅ | `default` | 로컬에서 EC2 생성·SSM/CFN 호출 |
| 리전 | ✅ | `us-west-2` | EC2 생성 및 배포 대상 리전 |
| 관리자 이메일 | ✅ | `you@example.com` | Cognito admin 임시 비밀번호 수신 |
| 배포 케이스 | 선택 | `all`(기본) / `chatbot` | `deploy:case` |
| 리포지토리 경로(EC2) | 선택 | `/home/ec2-user/app` | 기본값: `/home/ec2-user/app` |
| EC2 인스턴스 ID | 선택 | `i-0abc123…` | 기존 EC2 사용 시 입력. 없으면 §1-1에서 자동 생성 |
| VPC 모드 | 선택 | `default` / `existing` / `new` | 기본값: `default`. `new`는 §1-1-2에서 신규 VPC 생성 |
| VPC ID | 선택 | `vpc-0abc123…` | 모드 `existing`일 때 필수. `default`면 기본 VPC 자동 조회, `new`면 자동 생성 |
| Subnet ID | 선택 | `subnet-0abc123…` | 모드 `existing`일 때 필수(퍼블릭 서브넷). 나머지 모드는 자동 선택/생성 |
| AMI ID | 선택 | `ami-0abc123…` | 기본값: Amazon Linux 2023 최신. 직접 지정 가능 |

> **EC2 인스턴스 ID를 입력하지 않으면** 아래 §1-1 절차에 따라 EC2를 자동으로 생성한다.

## 1-0. CDK Bootstrap 상태 확인 (프로파일·리전 확보 즉시 수행)

프로파일과 리전을 입력받으면, EC2 생성 전에 배포 대상 리전의 부트스트랩이 **정말로 건강한지** 확인한다.
**CDKToolkit 스택 상태만 보고 판단하지 말 것** — 스택은 `CREATE_COMPLETE`인데 부트스트랩 리소스(assets 버킷·IAM 역할)가
out-of-band(계정 nuke 등)로 **삭제된 drift 상태**가 흔하고, 이때 "부트스트랩됨"으로 오판하면 `cdk deploy`가
`needs bootstrapping` / `SSM parameter /cdk-bootstrap/... not found`로 실패한다. 따라서 **① 스택 + ② assets 버킷 +
③ 버전 파라미터**를 함께 확인한다.

```bash
ACCT=$(aws sts get-caller-identity --query Account --output text --profile <프로파일>)
QUALIFIER=hnb659fds   # 기본 부트스트랩 한정자 (cdk.json에서 커스텀 지정 시 그 값)

# ① CDKToolkit 스택
CDK_STATUS=$(aws cloudformation describe-stacks --stack-name CDKToolkit \
  --query "Stacks[0].StackStatus" --output text \
  --profile <프로파일> --region <리전> 2>&1)

# ② assets 버킷 실제 존재 여부 (스택 상태와 별개로 반드시 확인)
CDK_BUCKET="cdk-${QUALIFIER}-assets-${ACCT}-<리전>"
if aws s3api head-bucket --bucket "$CDK_BUCKET" --profile <프로파일> --region <리전> 2>/dev/null; then
  BUCKET_OK=yes; else BUCKET_OK=no; fi

# ③ 부트스트랩 버전 파라미터 (roles/bucket이 살아있으면 보통 함께 존재)
BOOT_VER=$(aws ssm get-parameter --name /cdk-bootstrap/${QUALIFIER}/version \
  --query Parameter.Value --output text \
  --profile <프로파일> --region <리전> 2>/dev/null)

echo "CDKToolkit=$CDK_STATUS  bucket($CDK_BUCKET)=$BUCKET_OK  version=$BOOT_VER"
```

### 판정 로직

| CDKToolkit 스택 | assets 버킷 | 의미 | 조치 |
|---|---|---|---|
| `CREATE_COMPLETE`/`UPDATE_COMPLETE` | **존재(+version 있음)** | 정상 부트스트랩됨 | **재부트스트랩 하지 말 것. §3의 `cdk bootstrap`을 건너뛰고 곧장 빌드 → `cdk deploy`로 진행** |
| `CREATE_COMPLETE`/`UPDATE_COMPLETE` | **없음** 또는 version 없음 | **drift**(스택만 남고 버킷/역할 삭제됨) | §1-0-1로 스택+잔여버킷 정리 후 재부트스트랩 |
| `ROLLBACK_COMPLETE`/`DELETE_FAILED` | 무관 | 이전 배포 실패 잔해 | §1-0-1로 정리 후 재부트스트랩 |
| `does not exist`/`ValidationError` | 무관 | 부트스트랩 안 됨 | §3에서 정상적으로 `cdk bootstrap` 실행 |

> **핵심:** 첫 행(스택·버킷 모두 정상)이면 **이미 잘 배포된 부트스트랩이므로 삭제/재생성 금지** —
> §3의 부트스트랩 단계만 건너뛰고 `pnpm vite build` → `cdk deploy --all` 부터 실행한다.
> 스택은 있는데 버킷이 없으면(두 번째 행) 반드시 §1-0-1을 거쳐야 한다. 그렇지 않으면 이후 `cdk bootstrap`이
> `AWS::EarlyValidation::ResourceExistenceCheck` 실패(잔여 버킷 충돌) 또는 `cdk deploy`가 `needs bootstrapping`으로 실패한다.

### 1-0-1. CDK Bootstrap 실패 복구 (잔여 S3 정리)

`cdk bootstrap`이 실패하는 경우, 대부분 **이전에 만들어진 CDK용 S3 버킷이 남아있기 때문**이다. 아래 순서로 정리하고 재배포한다.

```bash
# 1. CDKToolkit 스택에 연결된 S3 버킷 확인
CDK_BUCKET=$(aws cloudformation describe-stack-resources \
  --stack-name CDKToolkit \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" \
  --output text \
  --profile <프로파일> --region <리전> 2>/dev/null)

# 버킷이 없으면 이름 패턴으로 직접 검색
if [ -z "$CDK_BUCKET" ] || [ "$CDK_BUCKET" = "None" ]; then
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile <프로파일>)
  CDK_BUCKET="cdk-hnb659fds-assets-${ACCOUNT_ID}-<리전>"
fi

# 2. S3 버킷 비우기 (버전 관리 객체 포함)
aws s3 rm "s3://$CDK_BUCKET" --recursive \
  --profile <프로파일> --region <리전> 2>/dev/null || true

# 버전 관리된 객체 삭제
aws s3api list-object-versions --bucket "$CDK_BUCKET" \
  --query "{Objects: Versions[].{Key:Key,VersionId:VersionId}}" --output json \
  --profile <프로파일> --region <리전> 2>/dev/null | \
  python3 -c "
import json, sys, subprocess
data = json.load(sys.stdin)
for obj in (data.get('Objects') or []):
    subprocess.run(['aws', 's3api', 'delete-object', '--bucket', '$CDK_BUCKET',
                    '--key', obj['Key'], '--version-id', obj['VersionId'],
                    '--profile', '<프로파일>', '--region', '<리전>'], check=False)
" 2>/dev/null || true

# 3. S3 버킷 삭제
aws s3 rb "s3://$CDK_BUCKET" --force \
  --profile <프로파일> --region <리전> 2>/dev/null || true

# 4. CDKToolkit 스택 삭제 (ROLLBACK_COMPLETE 등 비정상 상태)
aws cloudformation delete-stack \
  --stack-name CDKToolkit \
  --profile <프로파일> --region <리전> 2>/dev/null || true

aws cloudformation wait stack-delete-complete \
  --stack-name CDKToolkit \
  --profile <프로파일> --region <리전> 2>/dev/null || true

echo "CDK 잔여 리소스 정리 완료. cdk bootstrap 재실행 가능"
```

> 정리 후 §3의 `cdk bootstrap`이 정상 실행된다. **이 절차는 EC2가 아닌 로컬에서 먼저 수행해도 되고**, EC2 생성 후 SSM으로 수행해도 된다.

## 1-1. EC2 인스턴스 자동 생성 (인스턴스 ID 미제공 시)

사용자가 EC2 인스턴스 ID를 제공하지 않은 경우, 아래 절차로 EC2를 생성한다.
모든 AWS CLI 명령에 `--profile <프로파일> --region <리전>`을 반드시 붙인다.

### 1-1-1. IAM Role 생성 (Admin 권한 + SSM 접속용)

```bash
# 신뢰 정책 생성
cat > /tmp/ec2-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# IAM Role 생성
aws iam create-role \
  --role-name GenAILabDeployRole \
  --assume-role-policy-document file:///tmp/ec2-trust-policy.json \
  --profile <프로파일> --region <리전>

# AdministratorAccess 정책 연결 (CDK 배포에 필요한 전체 권한)
aws iam attach-role-policy \
  --role-name GenAILabDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess \
  --profile <프로파일> --region <리전>

# SSM 접속용 정책 연결
aws iam attach-role-policy \
  --role-name GenAILabDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore \
  --profile <프로파일> --region <리전>

# 인스턴스 프로파일 생성 및 역할 연결
aws iam create-instance-profile \
  --instance-profile-name GenAILabDeployProfile \
  --profile <프로파일> --region <리전>

aws iam add-role-to-instance-profile \
  --instance-profile-name GenAILabDeployProfile \
  --role-name GenAILabDeployRole \
  --profile <프로파일> --region <리전>

# 인스턴스 프로파일 전파 대기 (약 10초)
sleep 10
```

> ⚠️ 이미 `GenAILabDeployRole`/`GenAILabDeployProfile`이 존재하면 생성 단계는 건너뛴다.

### 1-1-2. VPC·서브넷·보안그룹 확인

VPC 모드는 세 가지다. 사용자 입력에 따라 하나를 고른다:

- **`default`** (기본): 계정의 기본 VPC + 그 안의 default-for-az 퍼블릭 서브넷을 사용. 가장 빠르고 리소스도 안 만듦.
- **`existing`**: 사용자가 지정한 `VPC_ID` + `SUBNET_ID`를 사용. 반드시 퍼블릭 서브넷(IGW 라우팅 있음)이어야 SSM
  에이전트가 인터넷을 통해 등록되고 Docker 이미지도 pull 가능.
- **`new`**: 배포 전용 VPC를 새로 만든다. 계정의 기존 VPC들과 겹치지 않는 `/16` CIDR을 자동 선택해 VPC + IGW +
  퍼블릭 서브넷(`/24`) + 라우트 테이블(0.0.0.0/0 → IGW)을 구성. 배포 정리 시 destroy 스킬이 함께 삭제한다.

```bash
# --- VPC 모드 결정 ---
VPC_MODE="${VPC_MODE:-default}"   # default | existing | new
VPC_CREATED_BY_DEPLOY=false        # destroy 스킬이 참조

case "$VPC_MODE" in
  existing)
    # 사용자 입력 그대로 사용. 값이 비어 있으면 에러.
    if [ -z "${VPC_ID:-}" ] || [ -z "${SUBNET_ID:-}" ]; then
      echo "existing 모드는 VPC_ID와 SUBNET_ID를 모두 요구합니다." >&2; exit 1
    fi
    ;;

  new)
    # 겹치지 않는 /16 선택: 계정 모든 VPC의 CidrBlock(및 associated CIDRs)을 조회해
    # 10.20.0.0/16 ~ 10.250.0.0/16 순회하며 첫 non-overlap 대역을 채택.
    NEW_CIDR=$(aws ec2 describe-vpcs --profile <프로파일> --region <리전> \
      --query "Vpcs[].CidrBlockAssociationSet[?CidrBlockState.State=='associated'].CidrBlock" \
      --output json | python3 -c '
import json, sys, ipaddress
raw = json.load(sys.stdin)
existing = []
for lst in raw:
    for c in lst:
        try: existing.append(ipaddress.ip_network(c))
        except Exception: pass
for i in range(20, 251):
    cand = ipaddress.ip_network(f"10.{i}.0.0/16")
    if all(not cand.overlaps(n) for n in existing):
        print(cand); break
')
    if [ -z "$NEW_CIDR" ]; then
      echo "겹치지 않는 /16 대역을 찾지 못했습니다. VPC_MODE=existing로 재시도하세요." >&2; exit 1
    fi
    SUBNET_CIDR="${NEW_CIDR%/16}/24"   # 예: 10.20.0.0/16 → 10.20.0.0/24
    echo "선택된 신규 VPC CIDR=$NEW_CIDR (subnet=$SUBNET_CIDR)"

    # 1) VPC
    VPC_ID=$(aws ec2 create-vpc \
      --cidr-block "$NEW_CIDR" \
      --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=GenAILabDeployVPC},{Key=CreatedBy,Value=GenAILabDeploy}]' \
      --profile <프로파일> --region <리전> \
      --query "Vpc.VpcId" --output text)
    aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames --profile <프로파일> --region <리전>
    aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support   --profile <프로파일> --region <리전>

    # 2) 인터넷 게이트웨이
    IGW_ID=$(aws ec2 create-internet-gateway \
      --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=GenAILabDeployIGW},{Key=CreatedBy,Value=GenAILabDeploy}]' \
      --profile <프로파일> --region <리전> \
      --query "InternetGateway.InternetGatewayId" --output text)
    aws ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" \
      --profile <프로파일> --region <리전>

    # 3) 퍼블릭 서브넷 (첫 번째 가용 AZ 사용)
    AZ=$(aws ec2 describe-availability-zones --profile <프로파일> --region <리전> \
      --query "AvailabilityZones[?State=='available']|[0].ZoneName" --output text)
    SUBNET_ID=$(aws ec2 create-subnet \
      --vpc-id "$VPC_ID" \
      --cidr-block "$SUBNET_CIDR" \
      --availability-zone "$AZ" \
      --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=GenAILabDeploySubnet},{Key=CreatedBy,Value=GenAILabDeploy}]' \
      --profile <프로파일> --region <리전> \
      --query "Subnet.SubnetId" --output text)
    aws ec2 modify-subnet-attribute --subnet-id "$SUBNET_ID" --map-public-ip-on-launch \
      --profile <프로파일> --region <리전>

    # 4) 라우트 테이블: 0.0.0.0/0 → IGW, 그리고 서브넷에 연결
    RTB_ID=$(aws ec2 create-route-table \
      --vpc-id "$VPC_ID" \
      --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=GenAILabDeployRTB},{Key=CreatedBy,Value=GenAILabDeploy}]' \
      --profile <프로파일> --region <리전> \
      --query "RouteTable.RouteTableId" --output text)
    aws ec2 create-route --route-table-id "$RTB_ID" --destination-cidr-block 0.0.0.0/0 \
      --gateway-id "$IGW_ID" --profile <프로파일> --region <리전> >/dev/null
    RTB_ASSOC_ID=$(aws ec2 associate-route-table --route-table-id "$RTB_ID" --subnet-id "$SUBNET_ID" \
      --profile <프로파일> --region <리전> --query "AssociationId" --output text)

    VPC_CREATED_BY_DEPLOY=true
    echo "신규 VPC 구성 완료: VPC=$VPC_ID IGW=$IGW_ID SUBNET=$SUBNET_ID RTB=$RTB_ID"
    ;;

  default|*)
    if [ -z "${VPC_ID:-}" ]; then
      VPC_ID=$(aws ec2 describe-vpcs \
        --filters "Name=isDefault,Values=true" \
        --query "Vpcs[0].VpcId" --output text \
        --profile <프로파일> --region <리전>)
      if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
        echo "기본 VPC가 없습니다. VPC_MODE를 existing 또는 new로 지정하세요." >&2; exit 1
      fi
    fi
    if [ -z "${SUBNET_ID:-}" ]; then
      SUBNET_ID=$(aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=$VPC_ID" "Name=default-for-az,Values=true" \
        --query "Subnets[0].SubnetId" --output text \
        --profile <프로파일> --region <리전>)
    fi
    ;;
esac

# --- 보안 그룹 생성 (SSM만 사용하므로 인바운드 불필요, 아웃바운드만 허용) ---
SG_ID=$(aws ec2 create-security-group \
  --group-name GenAILabDeploySG \
  --description "Security group for GenAI Lab deploy EC2 - outbound only" \
  --vpc-id "$VPC_ID" \
  --query "GroupId" --output text \
  --profile <프로파일> --region <리전>)
```

> - `new` 모드에서 만든 VPC/IGW/서브넷/라우트테이블은 §7의 deploy_list에 **반드시** 기록해야 destroy 스킬이 인식·삭제한다.
>   기록 항목은 §7 참고 (`resources.vpc.created_by_deploy=true` 플래그가 destroy 대상 판별 기준).
> - 보안 그룹이 이미 존재하면 기존 것을 사용한다. `new` 모드는 새 VPC라 SG도 항상 새로 생긴다.
> - 서울/도쿄 리전처럼 `10.0.0.0/16` 대역이 이미 default VPC에 쓰이는 경우에도, 자동 선택은 `10.20.0.0/16`부터
>   시작하므로 충돌 없이 잡힌다.

### 1-1-3. 최신 Amazon Linux 2023 AMI 조회

SSM Parameter Store에서 최신 AL2023 AMI를 조회한다 (가장 정확하고 빠름).

```bash
# 방법 1: SSM Parameter (권장)
AMI_ID=$(aws ssm get-parameters \
  --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query "Parameters[0].Value" --output text \
  --profile <프로파일> --region <리전>)

# 방법 2: describe-images 폴백 (SSM 실패 시)
if [ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ]; then
  AMI_ID=$(aws ec2 describe-images \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023*-x86_64" \
               "Name=state,Values=available" \
    --query "sort_by(Images, &CreationDate)[-1].ImageId" --output text \
    --profile <프로파일> --region <리전>)
fi
```

> **Amazon Linux 2023 (AL2023)** 을 사용한다. AL2023은 `dnf` 패키지 매니저를 사용하며, Node.js 20+, Docker,
> Python 3.12 등을 쉽게 설치할 수 있다. 사용자가 별도 AMI ID를 제공하면 그것을 우선 사용한다.

### 1-1-4. EC2 인스턴스 생성

퍼블릭 IP를 할당하여 인터넷 접근(패키지 설치, Docker 이미지 pull 등)을 가능하게 한다.

```bash
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type t3.large \
  --iam-instance-profile Name=GenAILabDeployProfile \
  --subnet-id $SUBNET_ID \
  --security-group-ids $SG_ID \
  --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications '[{"ResourceType":"instance","Tags":[{"Key":"Name","Value":"GenAILab-Deploy"}]}]' \
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2" \
  --query "Instances[0].InstanceId" --output text \
  --profile <프로파일> --region <리전>)

echo "생성된 인스턴스: $INSTANCE_ID"
```

> `--associate-public-ip-address` 플래그로 퍼블릭 IP가 할당된다. SSM 접속은 퍼블릭 IP 없이도 가능하지만,
> 패키지 설치·Docker pull 등 아웃바운드 인터넷 접근에 필요하다. 서브넷에 IGW 라우팅이 없으면 NAT Gateway가
> 필요하므로, 퍼블릭 서브넷 사용을 권장한다.

**스펙 요약:**
| 항목 | 값 |
|---|---|
| 인스턴스 타입 | `t3.large` (2 vCPU, 8 GiB RAM) |
| 스토리지 | gp3 30 GB (루트 볼륨) |
| IAM Role | `GenAILabDeployRole` (AdministratorAccess + AmazonSSMManagedInstanceCore) |
| OS | Amazon Linux 2023 (최신) |
| 네트워크 | 퍼블릭 IP 할당, 아웃바운드 허용 (SSM + 인터넷 접근) |

### 1-1-5. SSM 접속 가능 대기

```bash
# 인스턴스 running 상태 대기
aws ec2 wait instance-running --instance-ids $INSTANCE_ID \
  --profile <프로파일> --region <리전>

# SSM 에이전트가 연결될 때까지 반복 확인 (최대 3분)
for i in $(seq 1 18); do
  STATUS=$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query "InstanceInformationList[0].PingStatus" --output text \
    --profile <프로파일> --region <리전> 2>/dev/null)
  if [ "$STATUS" = "Online" ]; then
    echo "SSM 연결 준비 완료"
    break
  fi
  echo "SSM 연결 대기 중... ($i/18)"
  sleep 10
done
```

SSM 연결이 확인되면 `$INSTANCE_ID`를 이후 모든 단계에서 사용한다.

## 2. 사전 점검 (SSM 연결·도구)

로컬 리포의 헬퍼로 EC2에 명령을 보낸다: `scripts/deploy/ssm-run.sh <profile> <region> <instance-id> "<command>"`

> §1-1에서 EC2를 새로 생성한 경우, 인스턴스 역할(AdministratorAccess)과 SSM은 이미 구성되어 있으므로 1·3번은
> 건너뛰어도 된다.

1. **SSM 연결 확인**: `ssm-run.sh … "echo ok && whoami"` → 실패하면 인스턴스가 SSM에 등록됐는지(인스턴스 프로파일에
   `AmazonSSMManagedInstanceCore`), SSM 에이전트 실행 여부 확인.
2. **도구 확인**: `ssm-run.sh … "node -v; pnpm -v; python3 -V; docker info >/dev/null 2>&1 && echo docker-ok; git --version"`
   - 없으면 설치: Node 20(nvm), `corepack enable pnpm`, python3.12, git, Docker(`sudo dnf install docker -y && sudo systemctl start docker && sudo usermod -aG docker ec2-user`).
3. **배포 권한 확인**: EC2 인스턴스 역할이 CDK 배포에 충분한 권한을 가졌는지. §1-1에서 생성한 경우 `AdministratorAccess`가
   연결되어 있으므로 충분하다. 기존 인스턴스를 사용하는 경우 부족하면 사용자에게 역할 보강을 요청(자격증명을 EC2에 심지 말 것).
4. **리포 전송**: 아래 §2-1 절차로 로컬 소스를 EC2로 전송한다 (git clone 불필요).

### 2-1. 로컬 소스를 S3 경유로 EC2에 전송

git clone 대신, **로컬 리포를 tar로 묶어 S3에 올리고 EC2에서 내려받는** 방식을 사용한다. 이 방식은 사설 리포 접근 설정이
불필요하고, SSM만으로 완결된다.

```bash
# --- 로컬에서 실행 ---
# 1. 소스를 tar.gz로 압축 (node_modules 등 불필요한 파일 제외)
#    macOS의 xattr 헤더가 EC2 tar에서 경고를 유발하므로 --no-xattrs 옵션으로 억제.
COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/genai-lab-source.tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='cdk.out' \
  --exclude='dist' \
  --exclude='.venv' \
  -C <로컬_리포_루트> .

# 2. S3 버킷에 업로드 (임시 버킷 또는 기존 버킷 사용)
BUCKET="genailab-deploy-$(aws sts get-caller-identity --query Account --output text --profile <프로파일>)"
aws s3 mb "s3://$BUCKET" --profile <프로파일> --region <리전> 2>/dev/null || true
aws s3 cp /tmp/genai-lab-source.tar.gz "s3://$BUCKET/source.tar.gz" \
  --profile <프로파일> --region <리전>
```

SSM으로 EC2에서 실행할 명령:

```bash
# --- EC2에서 실행 (SSM send-command) ---
mkdir -p <REPO_DIR>
aws s3 cp "s3://$BUCKET/source.tar.gz" /tmp/source.tar.gz --region <리전>
tar -xzf /tmp/source.tar.gz -C <REPO_DIR>
rm -f /tmp/source.tar.gz
ls <REPO_DIR>/package.json && echo "소스 전송 완료"
```

> **장점**: git 설정·SSH 키·토큰 불필요. 로컬의 최신 코드(수정 포함)가 그대로 반영됨.
> **주의**: `node_modules`는 제외하고 EC2에서 `pnpm install`을 다시 수행한다 (remote-deploy.sh가 처리).

## 2-2. 리전별 코드 점검·수정 (배포 전 필수)

이 코드베이스에는 **리전 종속 하드코딩**이 있어, 입력받은 리전과 맞지 않으면 배포 또는 런타임에서 실패한다(APAC
인퍼런스 프로파일, EOL 모델, 서울 리전 전용 IAM 역할로 반복 실패한 이력 있음). **배포 전에 반드시 아래를 입력 리전에
맞춰 확인·수정한다.**

### 2-2-1. 먼저 그 리전에서 쓸 수 있는 모델 확인
```bash
aws bedrock list-inference-profiles --region <리전> --profile <프로파일> \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'claude')].[inferenceProfileId,status]" --output text
```
- 나오는 프로파일 접두사(`us.` / `eu.` / `apac.` / `global.`)와 ACTIVE 여부를 기준으로 아래 값들을 정한다.
- **enum과 실제 가용 모델은 다를 수 있다.** construct(`@cdklabs/generative-ai-cdk-constructs`)의
  `BedrockFoundationModel` 멤버명은 모델 ID와 다르므로, 아래로 실제 멤버명을 확인한다:
  ```bash
  D=$(find <REPO_DIR>/node_modules/.pnpm -maxdepth 1 -type d -name '*generative-ai-cdk-constructs*' | head -1)
  grep -Rh "<모델ID 예: claude-3-sonnet-20240229>" "$D" --include=*.js | grep -oE "BedrockFoundationModel.ANTHROPIC_CLAUDE[A-Za-z0-9_]*" | sort -u
  ```

### 2-2-2. 리전에 맞춰 수정할 코드 위치
| 파일 | 무엇을 | 비고 |
|---|---|---|
| `packages/cdk_infra/src/stacks/chatbot/bedrock-agents-stack.ts` | Agent 인퍼런스 프로파일: `geoRegion`(리전 자동 선택되어 있음)와 `model` enum | 그 리전에 **ACTIVE 프로파일이 있는 모델**의 정확한 enum 멤버명으로 |
| `packages/cdk_infra/cdk.json` | `chat:defaultModelId`, `metadata:modelId` | 그 리전 ACTIVE 프로파일 ID로. **context 값이 코드 기본값을 덮으므로 반드시 여기서 수정.** EOL 모델(예: `claude-3-5-sonnet-20240620`) 금지 |
| `packages/reactjs_ui/src/components/ChipDropdown/ModelChipDropdown.jsx` | UI에 노출할 모델 3개(`MODELS`) | 그 리전 ACTIVE 프로파일 ID로 |
| `packages/cdk_infra/src/constructs/chat-summary-with-sessionid.ts` | 하드코딩된 `us-east-1/us-east-2/us-west-2` Nova 인퍼런스 프로파일 ARN | 그 리전으로 교체(또는 그 리전 모델로) |
| `packages/cdk_infra/.../qna_agent_rest_api/dispatch/bedrock_chat_router.py` | `_model_arn`의 프로파일 접두사 매핑 | `us./eu./apac./global.` 처리 확인 |

### 2-2-3. 고정 이름 IAM 역할의 리전 충돌 (주의)
KB/Agent 실행 역할은 **고정 이름**(`AmazonBedrockExecutionRoleForKnowledgeBase*`, `AmazonBedrockExecutionRoleForAgents*`)이라
**다른 리전 배포와 IAM(글로벌)에서 충돌**한다. 다른 리전(예: 서울)에서 먼저 배포된 적이 있으면, 다른 리전 배포가 그
역할을 재사용하게 되고 역할의 모든 권한이 **그 다른 리전 리소스**를 가리켜 실패한다. 인제스트 실패 사유
(`get-ingestion-job --query ingestionJob.failureReasons`)를 보며 아래를 **전부** 그 배포 리전으로 교체한다:
- `... already exists`(배포 시) → 배포 전 그 고아 역할 삭제(정책 detach 후 delete-role).
- `unable to assume the given role` → 역할 **신뢰정책 SourceArn 리전**을 `arn:aws:bedrock:*:<acct>:knowledge-base/*`로 `update-assume-role-policy`.
- `not authorized to InvokeModel ... embedding model` → 역할 정책의 **임베딩 모델 ARN 리전**을 `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`로 InvokeModel 허용.
- `[security_exception] 403`(OpenSearch) → 역할 관리형 정책의 **`aoss:APIAccessAll` 컬렉션 ARN 리전**을 `arn:aws:aoss:*:<acct>:collection/*`로 `create-policy-version --set-as-default`.
- `s3:ListBucket ... is not authorized`(인제스트 잡 실패) → 역할의 **S3 데이터버킷 ARN 리전**. 실제 KB 버킷에 `s3:ListBucket`(버킷) + `s3:GetObject`(버킷/*) inline 정책 추가.
> ⚠️ 이 IAM 수정은 **라이브 패치**라 다음 `cdk deploy`에서 되돌아갈 수 있다. 영구 해결은 고정이름 충돌 자체를 없애는 것(타 리전 배포 정리, 또는 충돌 없는 리전 사용).

## 2-3. 라이브러리 버전 확인·호환성·최신화 (배포 전 필수)

핵심 CDK 구성 라이브러리가 **최신인지 확인하고, 호환되는 선에서 최신으로 올린 뒤** 배포한다. 무작정 `latest`로 올리면 안
된다 — **최신 버전이 더 높은 `aws-cdk-lib`/`constructs` peer를 요구**하면, 현재 핀과 충돌해 synth가 깨진다(실측:
`@cdklabs/generative-ai-cdk-constructs@0.1.318`은 `aws-cdk-lib@^2.254`·`constructs@^10.6`를 요구하고
`aws-cdk-lib/aws-s3vectors`를 import해서, 핀된 `aws-cdk-lib@2.178`에선 `Package subpath './aws-s3vectors' is not
defined`로 synth 실패).

### 2-3-1. 현재 핀 + 최신 버전 파악
```bash
grep -E "generative-ai-cdk-constructs|\"aws-cdk-lib\"|\"constructs\"" packages/cdk_infra/package.json
for P in @cdklabs/generative-ai-cdk-constructs aws-cdk-lib constructs; do
  echo "$P latest: $(npm view "$P" version 2>/dev/null)"
done
```

### 2-3-2. 호환성 체크 (업그레이드 후보의 peer 확인)
```bash
npm view @cdklabs/generative-ai-cdk-constructs@<후보버전> peerDependencies
```
판정:
- **후보의 peer가 현재 핀된 `aws-cdk-lib`/`constructs`를 만족** → 그 버전으로 올린다(가장 단순).
- **후보가 더 높은 `aws-cdk-lib`를 요구** → 둘 중 하나:
  - (A) **`aws-cdk-lib`·`constructs`도 함께 최신으로** 올려 peer를 맞춘다(앱 전체 영향 → synth·배포로 반드시 검증).
  - (B) **현재 `aws-cdk-lib`와 호환되는 "가장 높은" 버전**을 고른다. npm에서 버전을 내려가며
    `peerDependencies.aws-cdk-lib`가 현재 핀을 만족하고, 필요한 기능(예: `supplementalDataStorageLocations`)이 있는 최고 버전을 찾는다.

### 2-3-3. 업데이트 → **반드시 synth 검증** → 배포
```bash
pnpm install
pnpm --filter cdk_infra exec cdk synth <스택> --exclusively <컨텍스트> 2>&1 | tail -40
```
- 버전업은 **오타 수정·API 리네임**을 동반할 수 있다(실측: `ParsingStategy`→`ParsingStrategy`는 0.1.31x에서 수정됨).
  synth의 `error TS2724 ... has no exported member` / `has no exported member named`를 보고 코드의 심볼명을 그 버전에 맞춘다.
- synth가 **템플릿을 실제로 생성**하고(파일 존재 확인), 의도한 속성이 들어갔는지 확인한 뒤에만 배포한다.
  `SYNTH_EXIT=0`만으로 안심하지 말 것 — 모듈 로드 에러가 나도 0이 나올 수 있으니 **template.json 존재**를 확인한다.

## 3. 배포 실행 (remote-deploy.sh · 비동기 + 로그 tail)

소스 전송이 완료되면, EC2의 `<REPO_DIR>/scripts/deploy/remote-deploy.sh`를 실행한다. SSM Run Command는 출력·시간 제한이
있으므로, 배포는 **백그라운드 로그로 돌리고 tail**한다.

> **⚠️ 중복 실행 방지**: `ssm-run.sh`가 `aws ssm wait command-executed`를 걸면 백그라운드 실행이 exit 1로 잘못
> 리턴돼, 호출자가 실패로 오인하고 재시도하면 두 개의 remote-deploy.sh가 동시에 돌 수 있다. **`aws ssm send-command`
> 직접 호출 + `setsid ... </dev/null >/dev/null 2>&1 & disown`** 로 완전 분리해서 이 오류를 애초에 없앤다.
> remote-deploy.sh 상단 `pgrep` 가드가 이중 실행을 감지하면 `[ABORT]`로 즉시 종료하니, 그런 메시지가 로그에 뜨면
> **재시도 전 반드시** `pkill -9 -f "cdk deploy"; pkill -9 -f "remote-deploy.sh"; rm -rf packages/cdk_infra/cdk.out
> .cdk.staging`으로 정리한다.

1. 시작:
   ```bash
   aws ssm send-command --instance-ids <INSTANCE_ID> \
     --document-name AWS-RunShellScript --profile <프로파일> --region <리전> \
     --timeout-seconds 60 \
     --parameters "commands=[\"cd <REPO_DIR> && setsid bash -c 'REPO_DIR=<REPO_DIR> AWS_REGION=<리전> ADMIN_EMAIL=<이메일> DEPLOY_CASE=<케이스> bash scripts/deploy/remote-deploy.sh > /tmp/deploy.log 2>&1' </dev/null >/dev/null 2>&1 & disown; sleep 3; pgrep -af remote-deploy.sh; echo DEPLOY_STARTED\"]"
   ```
2. 진행 확인(반복): `ssm-run.sh … "tail -n 120 /tmp/deploy.log"` 를 주기적으로 호출.
3. 종료 판정: 로그에 `DEPLOY_DONE`가 보이면 성공. 프로세스가 죽었는데 없으면 오류로 간주.

`remote-deploy.sh`가 하는 일 (전체 배포를 한 스크립트로 수행):
1. 도구/도커 확인 및 설치 (Node 20, pnpm, Python 3.12, Docker, Git)
2. `pnpm install`
3. Python venv 초기화 + OpenAPI 스키마 생성
   - **주의**: `packages/cdk_infra/src/backend/agents/lambda/requirements.txt` 파일은 실제로 없어서 pip install이
     silent skip될 수 있다. `openapi.json`이 리포에 커밋되어 있어 배포엔 무영향이지만, 재생성이 필요하면 venv에
     `aws-lambda-powertools`, `pydantic`을 별도로 설치한다.
4. `cdk bootstrap` (멱등) — **단, §1-0 판정이 "정상 부트스트랩됨"(스택+버킷 모두 존재)이면 이 단계를 건너뛴다.**
   drift(스택만 있고 버킷/역할 삭제)면 §1-0-1 정리를 먼저 끝낸 뒤에만 부트스트랩한다.
5. `vite build` (WebsiteStack용 프론트엔드 dist)
6. `cdk deploy --all -c deploy:case=… -c admin:email=…`
7. 스택 Outputs 출력

## 4. 오류 자동 수정 루프

로그에서 오류가 보이면 **원인을 진단 → 최소 수정 → 재배포**를 반복한다(최대 5회, 그 뒤 사용자에게 보고).
자주 나오는 오류와 처방:

| 증상(로그) | 원인 | 처방 |
|---|---|---|
| `... needs bootstrapping` / `SSM parameter /cdk-bootstrap/... not found` | 부트스트랩 안 됨 | `cdk bootstrap aws://<acct>/<region>` (remote-deploy가 이미 시도; 권한 문제면 역할 보강) |
| `Cannot connect to the Docker daemon` | 도커 미기동 | `sudo service docker start`; ec2-user를 docker 그룹에 추가 후 재시도 |
| `AccessDeniedException ... bedrock ... model` / `could not access model` | 리전에 모델 미활성 | Bedrock 콘솔에서 모델 액세스 활성화, 또는 `-c chat:defaultModelId=…`/`-c metadata:modelId=…`로 활성 모델 지정 |
| `No export named ... KnowledgeBaseId... found. Rollback requested` | AgentsStack이 KB stack 완료 전에 배포됨 | **정상적인 코드베이스에선 이미 `main.ts`의 `chatbotStack.addDependency(bedrockKnowledgeBaseStack)`로 방지됨.** 그래도 발생하면 그 라인이 리팩터링 중 삭제됐는지 먼저 확인. 임시 복구: 실패한 AgentsStack `delete-stack` → orphan cdk가 자동 재시도 |
| `Another CLI (PID=...) is currently synthing to cdk.out` | 이전 배포 프로세스의 orphan cdk가 락을 잡고 있음 (`remote-deploy.sh` 상단 가드가 사전 차단하지만, 예전 실패로 남은 orphan은 별개) | `pkill -9 -f "cdk deploy"; sleep 3; rm -rf packages/cdk_infra/cdk.out .cdk.staging` 후 재시도 |
| `Property 'SEMANTIC' does not exist on ChunkingStrategy` 등 청킹 API 불일치 | 구성요소 버전 차이 | `bedrock-kb-stack.ts`의 프리셋을 `.semantic({...})` 팩토리로 교체하거나 `-c chunking:strategy=fixed` |
| `does not exist ... reactjs_ui/dist` | 프론트 빌드 누락 | `pnpm run vite build` 먼저(remote-deploy에 포함; 실패 원인 별도 확인) |
| `ModuleNotFoundError: No module named 'aws_lambda_powertools'` | venv에 파이썬 의존성 누락 (remote-deploy.sh의 `pip install`이 없는 requirements.txt를 참조해 조용히 skip됨) | `source .venv/bin/activate && pip install aws-lambda-powertools==2.43.1 pydantic==1.10.12`; openapi.json이 리포에 이미 있으면 배포 자체엔 영향 없음 |
| `AccessDenied` (배포 중 IAM) | EC2 역할 권한 부족 | 사용자에게 인스턴스 역할 권한 보강 요청 |
| `spawn ... ENOMEM` / 번들링 OOM | 메모리 부족 | 더 큰 인스턴스, 또는 스왑 추가 |
| `throttl`/`Rate exceeded` | API 스로틀 | 잠시 대기 후 재배포 |

원칙: **근본 원인 한 곳만** 고친다(호출부마다 땜질 금지). 코드 수정 시 EC2의 리포에 반영해야 하므로 로컬에서 고쳤으면
SSM으로 직접 패치. 재배포는 3번을 다시 실행.

## 5. 배포 후 구성 (Cognito·이메일 자동)

1. **Cognito/웹 설정**: 자동. `WebsiteStack`이 `runtime-config.json`에 API URL·User Pool·Client·Identity Pool ID를
   주입한다. 별도 `aws-exports.js` 수정 불필요.
2. **웹사이트 URL 확인**: `CSCGenAILab-*-WebsiteStack`의 `WebsiteUrl` 출력(§3 Outputs)에서 CloudFront URL 확보 →
   사용자에게 전달.
3. **관리자 이메일/로그인**: `admin:email`을 넘겼으므로 admin 사용자가 이메일로 임시 비밀번호를 받는다. 안 왔으면 스팸함
   확인, 또는
   ```bash
   aws cognito-idp admin-create-user --user-pool-id <id> --username admin \
     --user-attributes Name=email,Value=<email> Name=email_verified,Value=true \
     --desired-delivery-mediums EMAIL --message-action RESEND
   ```
   로 재발송.

## 6. 검증 (완료 판정 전 필수)

1. `WebsiteUrl` 접속 → 로그인 화면 표시.
2. admin 임시 비밀번호로 로그인 → 새 비밀번호 설정.
3. "지식 베이스 → 문서 관리"에서 파일 업로드 → 4단계 진행(업로드→분석→메타데이터→벡터화)이 끝까지 감.
4. "지식 베이스 Q&A"에서 모델·프롬프트를 바꿔가며 질문 → 답변·참고자료 표시.
5. **가드레일**: "설정 → 가드레일"에 기본 가드레일(`default-phone-masking`)이 보이는지 확인(배포 시 `guardrail_seed.py`
   커스텀 리소스가 시드). 마스킹 검증은 **`aws bedrock-runtime apply-guardrail`** 로 직접 호출해서 `{PHONE}`
   치환을 확인하는 방식이 가장 확실:
   ```bash
   aws bedrock-runtime apply-guardrail \
     --guardrail-identifier <guardrail-id> --guardrail-version DRAFT \
     --source OUTPUT \
     --content '[{"text":{"text":"고객센터 010-1234-5678로 문의 주세요."}}]' \
     --profile <프로파일> --region <리전>
   ```
   또는 챗봇 상단 **GUARD 드롭다운**에서 `기본 전화번호 마스킹`을 선택해 답변 속 번호가 `{PHONE}`로 치환되는지 확인.
6. 실패 시 §4로 복귀. 모두 통과해야 "배포 완료"로 보고.

> **가드레일 배포 참고:** 가드레일 기능은 `BasicRestApiStack`에 자동 포함된다 — `GuardrailsApi` construct
> (`/guardrails` REST API + `guardrails.py` Lambda), 챗봇 Lambda의 `bedrock:ApplyGuardrail` 권한, 그리고 기본 가드레일을
> 시드하는 커스텀 리소스(`guardrail_seed.py`). 별도 배포 단계는 없고 `cdk deploy --all`에 함께 올라간다. 챗봇 요청은
> `guardrailId`(옵션)를 받아 `RetrieveAndGenerate`에 `guardrailConfiguration`(버전 `DRAFT`)으로 적용한다. Bedrock
> Guardrails가 그 리전에서 지원되는지 사전 확인한다.
>
> **알려진 이슈**: 시드 스크립트는 이름을 `default-phone-masking`으로 만들도록 되어 있지만 `guardrails.py`의
> `_make_name()` 폴백 로직이 한글 title을 ASCII로 필터링하면서 실제 이름이 `guardrail-<uuid>`로 생길 수 있다.
> 정책(PHONE + ANONYMIZE)이 맞으면 동작에는 영향 없음.

## 7. deploy_list 기록 (각 단계 완료 시 즉시 갱신)

배포 과정에서 생성한 모든 AWS 리소스를 `scripts/deploy/deploy_list.json`에 기록한다. 이 파일은 나중에 destroy 스킬에서
삭제 대상을 결정하는 데 사용된다.

### 기록 시점과 항목

| 단계 | 기록 항목 |
|---|---|
| §1 입력값 확보 | `metadata.profile`, `metadata.region`, `metadata.admin_email`, `metadata.deploy_case`, `metadata.created_at` |
| §1-1-1 IAM Role 생성 | `resources.iam_role.name`, `resources.iam_role.arn` |
| §1-1-1 인스턴스 프로파일 | `resources.instance_profile.name` |
| §1-1-2 VPC 결정/생성 | `resources.vpc.id`, `resources.vpc.cidr`, `resources.vpc.created_by_deploy` (true면 destroy가 삭제). `new` 모드면 `resources.internet_gateway.id`, `resources.route_table.id`, `resources.route_table_association_id`도 함께 |
| §1-1-2 서브넷 | `resources.subnet.id`, `resources.subnet.cidr`, `resources.subnet.created_by_deploy` |
| §1-1-2 보안그룹 생성 | `resources.security_group.name`, `resources.security_group.id` |
| §1-1-4 EC2 생성 | `resources.ec2_instance.id`, `resources.ec2_instance.name`, `resources.ec2_instance.type`, `resources.ec2_instance.public_ip` |
| §2-1 소스 전송 | `resources.s3_bucket.name`, `resources.s3_bucket.purpose` |
| §3 배포 완료 | `resources.cdk_stacks[]` (배포된 스택 이름 목록) – **remote-deploy.sh가 자동 기록** |
| §5 배포 후 | `resources.website_url` – **remote-deploy.sh가 자동 기록** |

> **remote-deploy.sh**가 배포 완료 시점에 CloudFormation에서 스택 목록과 Website URL을 조회하여 `deploy_list.json`에
> 자동으로 기록한다. Kiro가 별도로 갱신할 필요 없음. Kiro는 EC2/IAM/SG/S3 등 CFN 외부 리소스 생성 시점에 즉시 갱신.

### JSON 스키마

```json
{
  "metadata": {
    "profile": "<프로파일>",
    "region": "<리전>",
    "admin_email": "<이메일>",
    "deploy_case": "<케이스>",
    "created_at": "<ISO8601>"
  },
  "resources": {
    "iam_role": { "name": "...", "arn": "..." },
    "instance_profile": { "name": "..." },
    "vpc": {
      "id": "vpc-xxx",
      "cidr": "10.20.0.0/16",
      "name": "GenAILabDeployVPC",
      "created_by_deploy": true
    },
    "internet_gateway": { "id": "igw-xxx", "name": "GenAILabDeployIGW" },
    "subnet": {
      "id": "subnet-xxx",
      "cidr": "10.20.0.0/24",
      "az": "ap-northeast-2a",
      "created_by_deploy": true
    },
    "route_table": { "id": "rtb-xxx", "association_id": "rtbassoc-xxx" },
    "security_group": { "name": "...", "id": "sg-xxx" },
    "ec2_instance": { "id": "i-xxx", "name": "...", "type": "...", "public_ip": "x.x.x.x" },
    "s3_bucket": { "name": "genailab-deploy-<account-id>", "purpose": "소스 전송용 임시 버킷" },
    "cdk_stacks": ["CSCGenAILab-xxx", "..."],
    "website_url": "https://..."
  }
}
```

> 배포 중단되더라도 이미 생성된 리소스는 기록되어 있으므로 정리가 가능하다.

## 8. 가드레일

- EC2에 **장기 자격증명을 심지 않는다**(인스턴스 역할 사용).
- 사용자 확인 없이 기존 스택을 **삭제하지 않는다**. destroy는 별도 스킬(`ec2-ssm-cdk-destroy`)로 명시 요청 시에만.
- 이메일 등 입력값을 로그/커밋에 남기지 않는다.
- 자동 수정은 **인프라/앱 코드 범위**로 한정. IAM 권한 확대·계정 설정 변경은 사용자 승인 후.

## 9. 관련 자료

- **[scripts/deploy/deploy_list.json](../../../scripts/deploy/deploy_list.json)**: 마지막 배포에서 생성된 리소스 목록.
  destroy 스킬이 참조한다.
- **[scripts/deploy/remote-deploy.sh](../../../scripts/deploy/remote-deploy.sh)**: EC2에서 실행되는 실제 배포 스크립트.
- **[scripts/deploy/ssm-run.sh](../../../scripts/deploy/ssm-run.sh)**: SSM Run Command 헬퍼. 백그라운드 실행 시엔 대신
  `aws ssm send-command` 직접 호출을 권장.
