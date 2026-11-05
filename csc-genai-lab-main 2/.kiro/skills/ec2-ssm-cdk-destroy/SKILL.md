---
name: ec2-ssm-cdk-destroy
description: |
  ec2-ssm-cdk-deploy 스킬로 배포한 모든 AWS 리소스를 완전히 정리하는 플레이북. scripts/deploy/deploy_list.json에
  기록된 리소스(CDK 스택, EC2, 보안그룹, IAM Role/Instance Profile, 소스 전송 S3 버킷)를 순서대로 삭제하고,
  KB 데이터소스 선삭제·CloudFormation export 잠금 회피·Bedrock Guardrails 등 스택 밖 독립 리소스까지 잔여
  검사를 수행한다. 사용 시점: 배포된 GenAI Lab을 완전히 지우고 싶을 때, 특정 리전의 GenAI Lab CDK 스택을 정리해달라고
  요청할 때, cdk destroy가 export 잠금이나 KB 데이터소스로 실패해서 복구가 필요할 때, 잔여 리소스(로그 그룹·가드레일·
  OpenSearch 컬렉션 등)를 확인·삭제해달라고 요청할 때.
license: Proprietary
compatibility: |
  로컬에 AWS CLI가 설치되어 있고 관리자 권한 프로파일이 구성되어야 한다. scripts/deploy/deploy_list.json이 있으면
  대부분 값을 자동으로 채운다. 없으면 프로파일·리전·EC2 인스턴스 ID를 사용자에게 직접 요청한다. cdk destroy는 EC2가
  살아 있는 동안 SSM으로 실행하므로 EC2 종료는 CDK 스택 삭제 이후에 진행한다.
---

# EC2 · CDK 전체 리소스 삭제 (Kiro 플레이북)

이 스킬은 `ec2-ssm-cdk-deploy`로 생성된 **모든 AWS 리소스를 완전히 삭제**하는 절차다. CDK 스택뿐 아니라 배포용 EC2,
IAM Role, 보안그룹, 소스 전송 S3 버킷, 잔여 CloudWatch 로그 그룹, 그리고 스택 밖 독립 리소스(Bedrock Guardrails 등)까지
남김없이 정리한다.

> ⚠️ **이 작업은 되돌릴 수 없다.** 실행 전 사용자에게 반드시 최종 확인을 받는다.

## 0. deploy_list.json 읽기 + 사용자 입력

### 0-1. deploy_list.json 자동 로드

먼저 `scripts/deploy/deploy_list.json`을 읽어 배포 시 생성한 리소스 목록을 자동으로 가져온다. 이 파일이 존재하면
프로파일·리전·인스턴스 ID 등 대부분의 정보를 **자동으로 채울 수 있다**.

```
파일 경로: scripts/deploy/deploy_list.json
```

파일이 없는 경우에만 사용자에게 직접 입력을 요청한다.

### 0-2. deploy_list에서 추출하는 값

| deploy_list 키 | 용도 |
|---|---|
| `metadata.profile` | AWS 프로파일 |
| `metadata.region` | 리전 |
| `resources.ec2_instance.id` | EC2 인스턴스 ID |
| `resources.security_group.id` | 보안 그룹 삭제 |
| `resources.security_group.name` | 보안 그룹 조회 폴백 |
| `resources.iam_role.name` | IAM Role 삭제 |
| `resources.instance_profile.name` | 인스턴스 프로파일 삭제 |
| `resources.s3_bucket.name` | 소스 전송용 임시 버킷 삭제 |
| `resources.vpc.id`, `resources.vpc.created_by_deploy` | 배포가 만든 VPC일 때만 삭제 (default/existing VPC는 유지) |
| `resources.internet_gateway.id`, `resources.route_table.id`, `resources.route_table.association_id`, `resources.subnet.id`, `resources.subnet.created_by_deploy` | 신규 VPC와 함께 만든 네트워크 리소스 (VPC 삭제 전 순서대로 정리) |
| `resources.cdk_stacks[]` | CDK 스택 삭제 대상 확인 |
| `resources.website_url` | CloudFront 배포 확인 |

### 0-3. 사용자 입력 (deploy_list 없을 때만)

| 값 | 필수 | 예시 | 용도 |
|---|---|---|---|
| AWS 프로파일 | ✅ | `default` | AWS CLI 호출 |
| 리전 | ✅ | `us-west-2` | 리소스 삭제 대상 리전 |
| EC2 인스턴스 ID | ✅ | `i-0abc123…` | 배포에 사용한 EC2 (삭제 대상) |

### 0-4. 삭제 대상 요약 → 사용자 확인

deploy_list에서 읽은 값을 사용자에게 표로 보여주고, **삭제를 진행할지 최종 확인**을 받는다.

```
삭제 예정 리소스:
- EC2: i-0abc123… (GenAILab-Deploy, t3.large)
- 보안 그룹: sg-xxx (GenAILabDeploySG)
- IAM Role: GenAILabDeployRole
- 인스턴스 프로파일: GenAILabDeployProfile
- CDK 스택: CSCGenAILab-XxxStack, ...
- 소스 전송 S3 버킷: genailab-deploy-<account-id>
- (vpc.created_by_deploy=true인 경우) VPC/IGW/Subnet/RouteTable
```

이 단계에서 함께 확인할 사항:
- **CDKToolkit 부트스트랩 스택도 함께 지울지** (같은 리전에 다른 CDK 앱이 있으면 유지)
- **Bedrock Guardrails가 이번 배포 산출물인지** (스택 밖 독립 리소스라 자동 삭제 안 됨 — createdAt이 배포 창 안이면 삭제, 밖이면 유지)

사용자가 확인하면 §1로 진행한다. 모든 AWS CLI 명령에 `--profile <프로파일> --region <리전>`을 반드시 붙인다.

## 1. CDK 스택 삭제 (EC2에서 SSM으로 실행)

CDK로 배포한 인프라를 먼저 삭제한다. EC2가 아직 살아있는 동안 SSM으로 destroy를 수행한다.

> **반드시 `cdk destroy --all`을 쓴다 — 개별 `aws cloudformation delete-stack`로 스택을 하나씩 지우지 말 것.**
> 이 앱은 스택 간 값을 CloudFormation export/import로 공유하는데(예: ChatbotStack이 KB의 KnowledgeBaseId를,
> 모두가 CommonStack을 import), CloudFormation은 **export가 다른 스택에 import되는 동안 그 스택 삭제를 거부**한다
> ("export in use"). `cdk destroy --all`은 **의존성 역순으로 자동 정렬**(importer 먼저 → exporter 나중)해 이 잠금을
> 피한다. 수동 delete-stack은 순서가 어긋나 KB/Common이 `CREATE_COMPLETE`인 채로 삭제 거부되고, 반쯤 삭제된 고아
> nested 스택까지 남긴다.

### 1-1. [필수 선행] Bedrock KB 데이터소스 먼저 삭제

KB의 S3 데이터소스는 `dataDeletionPolicy: RETAIN`이라 스택 삭제 시 KB에서 자동 detach되지 않아, KB 삭제가
`"associated with more than zero data sources"`로 실패한다. `cdk destroy --all` **전에** KB의 데이터소스를 먼저 지운다:

```bash
KBID=$(aws bedrock-agent list-knowledge-bases --region <리전> --profile <프로파일> \
  --query "knowledgeBaseSummaries[?contains(name,'CSCGenAILab')].knowledgeBaseId" --output text)

for DS in $(aws bedrock-agent list-data-sources --knowledge-base-id "$KBID" --region <리전> \
  --profile <프로파일> --query 'dataSourceSummaries[].dataSourceId' --output text); do
  aws bedrock-agent delete-data-source --knowledge-base-id "$KBID" --data-source-id "$DS" \
    --region <리전> --profile <프로파일>
done
```

### 1-2. cdk destroy --all 백그라운드 실행

SSM Run Command는 출력·시간 제한이 있으므로, destroy도 **백그라운드 로그로 돌리고 tail**한다. 배포 스킬(deploy)에서
학습한 대로 `setsid ... </dev/null >/dev/null 2>&1 & disown`으로 완전히 분리한다.

```bash
aws ssm send-command --instance-ids <INSTANCE_ID> \
  --document-name AWS-RunShellScript --profile <프로파일> --region <리전> \
  --timeout-seconds 60 \
  --parameters "commands=[\"cd <REPO_DIR> && setsid bash -c 'pnpm --filter cdk_infra exec cdk destroy --all --force --require-approval never > /tmp/destroy.log 2>&1' </dev/null >/dev/null 2>&1 & disown; sleep 3; pgrep -af 'cdk destroy'; echo DESTROY_STARTED\"]"
```

### 1-3. 진행 모니터

두 가지를 병행한다:

1. **CloudFormation 스택 상태**(주 진행 지표):
   ```bash
   aws cloudformation describe-stacks --profile <프로파일> --region <리전> \
     --query "Stacks[?contains(StackName,'CSCGenAILab')].[StackName,StackStatus]" --output text
   ```
2. **destroy.log tail**(에러 확인):
   ```bash
   aws ssm send-command --instance-ids <INSTANCE_ID> --document-name AWS-RunShellScript \
     --parameters 'commands=["tail -n 40 /tmp/destroy.log"]' --profile <프로파일> --region <리전>
   ```

**정상 삭제 순서 (실측)**: WebsiteStack → BasicRestApiStack → ChatbotStack → AgentsStack → BedrockKnowledgeBaseStack →
CommonStack. WebsiteStack의 CloudFront 배포 삭제가 가장 오래 걸린다 (~15분).

### 1-4. 삭제 실패 시 처방

| 증상 | 원인 | 처방 |
|---|---|---|
| `associated with more than zero data sources` (KB) | 데이터소스 RETAIN, KB에서 미detach | §1-1의 **KB 데이터소스 선삭제** 후 재시도 |
| `Export ... cannot be deleted as it is in use` / KB·Common이 `CREATE_COMPLETE`인 채 삭제 거부 | 교차 스택 export 잠금 (개별 delete-stack로 순서 어긋남) | 개별 delete 중단하고 **`cdk destroy --all`**로 재실행. 이미 고아 nested가 남았으면 importer(BasicRestApi→Agents)→KB→Common 순으로 delete-stack |
| S3 버킷이 비어있지 않아 삭제 실패 | 로그/버전 객체 잔존 (특히 CloudFront 로그버킷) | `aws s3 rm s3://<bucket> --recursive` + 버전 삭제 후 재시도 |
| `bucket you tried to delete is not empty`(반복) | CloudFront 로그 지연배송 레이스 | 코드가 로깅 비활성화돼 있어야 함(WebsiteStack). 아니면 버킷 비우며 재시도 |
| Custom resource `did not receive a response` / 60분 hang | 제공자 Lambda가 먼저 삭제된 고아 커스텀리소스 | `DELETE_FAILED` 후 `delete-stack --retain-resources <그 Custom:: 논리ID>` (인프라 없는 리소스라 유출 없음) |
| `Role ... is invalid or cannot be assumed` | 부트스트랩 exec-role이 out-of-band 삭제됨 | 유효한 역할을 `delete-stack --role-arn`으로 넘기거나 재부트스트랩 |
| CloudFront 배포가 비활성화 안 됨 | 전파 지연 | 비활성화 후 대기(~15분), 재시도 |
| `DELETE_FAILED` 상태 스택 (그 외) | 다양 | 이벤트에서 실패 리소스 확인 후 개별 처리, `--force` 재시도 |

### 1-5. 스택 삭제 확인

```bash
aws cloudformation describe-stacks \
  --query "Stacks[?contains(StackName, 'CSCGenAILab')].[StackName, StackStatus]" \
  --output text \
  --profile <프로파일> --region <리전>
```

출력이 비어 있으면 CDK 스택 삭제 완료.

## 2. CDK Bootstrap 스택 삭제 (선택)

더 이상 해당 리전에서 CDK를 사용하지 않을 경우 부트스트랩 스택도 삭제한다. **§0-4에서 사용자 승인이 없으면 건너뛴다.**

```bash
BUCKET=$(aws cloudformation describe-stack-resources \
  --stack-name CDKToolkit \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" \
  --output text \
  --profile <프로파일> --region <리전>)

# 버킷 비우기 (버전 객체 포함)
aws s3 rm "s3://$BUCKET" --recursive \
  --profile <프로파일> --region <리전>

aws s3api list-object-versions --bucket "$BUCKET" \
  --query "Versions[].{Key:Key,VersionId:VersionId}" --output json \
  --profile <프로파일> --region <리전> | \
  jq -c '.[]' | while read obj; do
    KEY=$(echo $obj | jq -r '.Key')
    VID=$(echo $obj | jq -r '.VersionId')
    aws s3api delete-object --bucket "$BUCKET" --key "$KEY" --version-id "$VID" \
      --profile <프로파일> --region <리전>
  done

# 스택 삭제
aws cloudformation delete-stack --stack-name CDKToolkit \
  --profile <프로파일> --region <리전>
aws cloudformation wait stack-delete-complete --stack-name CDKToolkit \
  --profile <프로파일> --region <리전>
```

> 다른 CDK 앱이 같은 리전에서 돌고 있다면 이 단계는 건너뛴다.

## 2-1. 소스 전송용 S3 버킷 삭제

deploy_list.json의 `resources.s3_bucket.name`에 기록된 버킷을 삭제한다.

```bash
DEPLOY_BUCKET="<deploy_list.resources.s3_bucket.name>"

aws s3 rm "s3://$DEPLOY_BUCKET" --recursive \
  --profile <프로파일> --region <리전>
aws s3 rb "s3://$DEPLOY_BUCKET" \
  --profile <프로파일> --region <리전>

echo "소스 전송 S3 버킷 삭제 완료: $DEPLOY_BUCKET"
```

## 3. EC2 인스턴스 종료

```bash
aws ec2 terminate-instances \
  --instance-ids <instance-id> \
  --profile <프로파일> --region <리전>

aws ec2 wait instance-terminated \
  --instance-ids <instance-id> \
  --profile <프로파일> --region <리전>
```

> **주의**: `aws ec2 wait instance-terminated`는 SSM Run Command 및 로컬 셸 컨텍스트에서 자주 exit 1로 리턴되지만
> 실제로는 정상 종료가 되어 있는 경우가 많다. wait 종료 후 `describe-instances`로 상태를 직접 확인한다.

## 4. 보안 그룹 삭제

```bash
# deploy_list.json에서 id를 알고 있으면 바로 사용, 없으면 이름으로 조회
SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=GenAILabDeploySG" \
  --query "SecurityGroups[0].GroupId" --output text \
  --profile <프로파일> --region <리전>)

if [ "$SG_ID" != "None" ] && [ -n "$SG_ID" ]; then
  aws ec2 delete-security-group \
    --group-id $SG_ID \
    --profile <프로파일> --region <리전>
fi
```

## 4-1. 신규 VPC · 네트워크 리소스 삭제 (조건부)

**`deploy_list.resources.vpc.created_by_deploy`가 `true`일 때만** 수행한다. `default`/`existing` 모드로 재사용한
VPC·서브넷은 삭제하지 않는다(공용 리소스).

**삭제 순서가 중요**하다: 라우트 테이블 연결 해제 → 라우트 테이블 → 서브넷 → IGW detach → IGW → VPC. 순서가 어긋나면
"DependencyViolation"으로 실패한다. §3(EC2 종료)·§4(SG 삭제) 이후에 수행해야 서브넷과 VPC가 비어 있다.

```bash
# 사전 조건: EC2가 이미 terminated, SG가 이미 삭제됨.
VPC_ID="<deploy_list.resources.vpc.id>"
IGW_ID="<deploy_list.resources.internet_gateway.id>"
SUBNET_ID="<deploy_list.resources.subnet.id>"
RTB_ID="<deploy_list.resources.route_table.id>"
RTB_ASSOC_ID="<deploy_list.resources.route_table.association_id>"

# 1) 라우트 테이블 연결 해제 (association_id를 잃었으면 describe-route-tables로 재조회)
if [ -n "$RTB_ASSOC_ID" ] && [ "$RTB_ASSOC_ID" != "None" ]; then
  aws ec2 disassociate-route-table --association-id "$RTB_ASSOC_ID" \
    --profile <프로파일> --region <리전> 2>&1 || true
fi

# 2) 라우트 테이블 삭제
aws ec2 delete-route-table --route-table-id "$RTB_ID" \
  --profile <프로파일> --region <리전> 2>&1 || true

# 3) 서브넷 삭제
aws ec2 delete-subnet --subnet-id "$SUBNET_ID" \
  --profile <프로파일> --region <리전> 2>&1 || true

# 4) IGW detach + 삭제
aws ec2 detach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" \
  --profile <프로파일> --region <리전> 2>&1 || true
aws ec2 delete-internet-gateway --internet-gateway-id "$IGW_ID" \
  --profile <프로파일> --region <리전> 2>&1 || true

# 5) 남아있는 기본 라우트 테이블 정리 (VPC 생성 시 자동 생성됨, main=true인 것은 자동 삭제됨)
# 명시적으로 만든 게 아니면 이 단계는 생략 가능

# 6) VPC 삭제
aws ec2 delete-vpc --vpc-id "$VPC_ID" \
  --profile <프로파일> --region <리전>
```

> **DependencyViolation이 뜨면** 어떤 리소스가 VPC를 붙잡고 있는 것이다. 대개 이 스킬이 예상하지 못한 ENI(예: KB 배포가
> 남긴 VPC endpoint, 남아있는 EC2, NAT gateway 등)이므로 `aws ec2 describe-network-interfaces --filters
> Name=vpc-id,Values=$VPC_ID`로 조사한 뒤 해당 리소스를 먼저 지운다.

## 5. IAM Role · 인스턴스 프로파일 삭제

```bash
# 인스턴스 프로파일에서 역할 분리
aws iam remove-role-from-instance-profile \
  --instance-profile-name GenAILabDeployProfile \
  --role-name GenAILabDeployRole \
  --profile <프로파일>

aws iam delete-instance-profile \
  --instance-profile-name GenAILabDeployProfile \
  --profile <프로파일>

# 정책 detach
aws iam detach-role-policy --role-name GenAILabDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess --profile <프로파일>
aws iam detach-role-policy --role-name GenAILabDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore --profile <프로파일>

aws iam delete-role --role-name GenAILabDeployRole --profile <프로파일>
```

## 6. 잔여 리소스 점검·삭제

CDK가 자동으로 삭제하지 못하는 리소스가 남아있을 수 있다. 아래를 점검하고, 발견되면 사용자 확인 후 삭제한다.

```bash
# 1. S3 버킷 (GenAILab 관련)
aws s3 ls --profile <프로파일> --region <리전> 2>/dev/null | grep -i "genailab\|cscgenai"

# 2. CloudWatch 로그 그룹 (Lambda 함수 삭제해도 남는 게 기본 동작)
aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/CSCGenAILab" \
  --query "logGroups[].logGroupName" --output text \
  --profile <프로파일> --region <리전>

# 3. Cognito User Pool
aws cognito-idp list-user-pools --max-results 30 \
  --query "UserPools[?contains(Name,'GenAI') || contains(Name,'CSC')].[Id,Name]" --output text \
  --profile <프로파일> --region <리전>

# 4. OpenSearch Serverless Collection (Bedrock KB용)
aws opensearchserverless list-collections \
  --query "collectionSummaries[?contains(name,'genai') || contains(name,'csc')].[name,id,status]" --output text \
  --profile <프로파일> --region <리전>

# 5. Bedrock Knowledge Base
aws bedrock-agent list-knowledge-bases \
  --query "knowledgeBaseSummaries[?contains(name,'GenAI') || contains(name,'CSC')].[knowledgeBaseId,name]" --output text \
  --profile <프로파일> --region <리전>

# 6. Bedrock Guardrails (앱/시드·UI가 만든 독립 리소스 — CFN 스택에 없어 cdk destroy로 안 지워짐)
aws bedrock list-guardrails \
  --query "guardrails[].[id,name,status]" --output text \
  --profile <프로파일> --region <리전>
```

### 6-1. Bedrock Guardrails 판정 (배포 창 안에 생성됐는지)

Guardrails는 CFN 스택에 속하지 않는 독립 리소스라 자동 삭제되지 않는다. **이번 배포 산출물인지**를 판정하려면
`createdAt`이 배포 시작~완료 창 안에 있는지 확인한다 (deploy_list.json의 `metadata.created_at` /
`metadata.deployed_at`을 사용):

```bash
aws bedrock get-guardrail --guardrail-identifier <id> --guardrail-version DRAFT \
  --query "{name:name,createdAt:createdAt}" --output json \
  --profile <프로파일> --region <리전>
```

`createdAt`이 배포 창 안이면 **이번 배포 산출물** → 삭제. 밖이면 **이전 배포 잔재 또는 수동 생성물** → 유지 (사용자에게
목록만 보고).

### 6-2. 잔여 리소스 삭제

발견된 잔여 리소스는 사용자에게 목록을 보여주고 확인을 받은 뒤 삭제한다.

```bash
# S3 버킷 (비우기 → 삭제)
aws s3 rm s3://<bucket-name> --recursive --profile <프로파일> --region <리전>
aws s3 rb s3://<bucket-name> --profile <프로파일> --region <리전>

# CloudWatch 로그 그룹 (많으면 xargs 병렬 삭제로 타임아웃 회피)
aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/CSCGenAILab" \
  --query "logGroups[].logGroupName" --output text \
  --profile <프로파일> --region <리전> | \
  tr '\t' '\n' | xargs -P 10 -I {} aws logs delete-log-group --log-group-name "{}" \
  --profile <프로파일> --region <리전>

# Bedrock Guardrail 삭제 (§6-1 판정 결과 "삭제"인 경우만)
aws bedrock delete-guardrail --guardrail-identifier <guardrail-id> \
  --profile <프로파일> --region <리전>
```

## 7. deploy_list.json 리셋 (템플릿 상태로 복원)

모든 리소스 삭제·검증이 끝나면 `scripts/deploy/deploy_list.json`을 **빈 템플릿**으로 덮어쓴다. 지난 배포의 metadata,
리소스 ID, 이력, notes 등은 남기지 않는다. 다음 배포 스킬은 이 빈 껍데기의 필드를 채워 나가면 된다.

> 파일을 삭제(`rm`)하지 말 것 — 다음 배포 스킬이 이 파일 경로를 참조하며, 최소 스키마가 있어야 `jq`/`python` 등이
> 안전하게 값을 병합할 수 있다.

**리셋 후 파일 내용**:

```json
{
  "metadata": {
    "profile": "",
    "region": "",
    "admin_email": "",
    "deploy_case": "",
    "created_at": "",
    "status": ""
  },
  "resources": {
    "iam_role": {},
    "instance_profile": {},
    "vpc": {},
    "internet_gateway": {},
    "subnet": {},
    "route_table": {},
    "security_group": {},
    "ec2_instance": {},
    "s3_bucket": {},
    "cdk_stacks": [],
    "website_url": ""
  }
}
```

리셋 명령 예:

```bash
cat > scripts/deploy/deploy_list.json <<'EOF'
{
  "metadata": {
    "profile": "",
    "region": "",
    "admin_email": "",
    "deploy_case": "",
    "created_at": "",
    "status": ""
  },
  "resources": {
    "iam_role": {},
    "instance_profile": {},
    "vpc": {},
    "internet_gateway": {},
    "subnet": {},
    "route_table": {},
    "security_group": {},
    "ec2_instance": {},
    "s3_bucket": {},
    "cdk_stacks": [],
    "website_url": ""
  }
}
EOF
```

## 8. 최종 확인 체크리스트

모든 삭제가 완료되면 아래를 확인하고 사용자에게 보고한다.

| # | 항목 | 확인 방법 | 기대 결과 |
|---|---|---|---|
| 1 | CDK 스택 (CSCGenAILab-*) | `describe-stacks` 필터 | 빈 결과 |
| 2 | CDKToolkit 스택 | `describe-stacks --stack-name CDKToolkit` | 삭제 승인 시 없음, 아니면 CREATE_COMPLETE 유지 |
| 3 | EC2 인스턴스 | `describe-instances` state | `terminated` |
| 4 | 보안 그룹 | `describe-security-groups` | `InvalidGroup.NotFound` |
| 5 | (`vpc.created_by_deploy=true`인 경우) VPC/IGW/Subnet/RouteTable | `describe-vpcs --vpc-ids …` 등 | 각각 `InvalidVpcID.NotFound`, `InvalidInternetGatewayID.NotFound`, `InvalidSubnetID.NotFound`, `InvalidRouteTableID.NotFound` |
| 6 | IAM Role | `get-role` | `NoSuchEntity` |
| 7 | 인스턴스 프로파일 | `get-instance-profile` | `NoSuchEntity` |
| 8 | S3 소스 버킷 | `head-bucket` | `404 Not Found` |
| 9 | CloudWatch 로그 그룹 | `describe-log-groups --prefix /aws/lambda/CSCGenAILab` | `length=0` |
| 10 | OpenSearch Serverless | `list-collections` 필터 | `length=0` |
| 11 | Bedrock Knowledge Base | `list-knowledge-bases` | `length=0` |
| 12 | Bedrock Guardrails | `list-guardrails` 또는 `get-guardrail` | 이번 배포 산출물이면 `ResourceNotFound`, 아니면 유지 리스트에 있음 |
| 13 | Cognito User Pool (GenAI/CSC) | `list-user-pools` 필터 | 빈 결과 |

## 9. 가드레일

- **사용자 확인 필수**: 삭제 시작 전(§0-4), 잔여 리소스 삭제 전(§6-2), 그리고 CDKToolkit·Guardrail 처럼 판정이 필요한
  단계에서 반드시 사용자 승인을 받는다.
- **순서 엄수**: KB 데이터소스 선삭제 → CDK 스택 → S3 소스 버킷 → EC2 종료 → 보안그룹 → (신규 VPC면 §4-1) → IAM
  순서를 지킨다. EC2를 먼저 종료하면 SSM으로 `cdk destroy`를 실행할 수 없다. VPC는 서브넷·SG가 비어야 지울 수 있다.
- **다른 워크로드 확인**: CDKToolkit 삭제 전 같은 리전에 다른 CDK 앱이 없는지 확인한다.
- **비용 확인**: EC2가 terminate되면 EBS도 함께 삭제된다 (`DeleteOnTermination=true`로 생성됨).
- **되돌릴 수 없음**: terminate된 인스턴스, 삭제된 S3 데이터는 복구 불가능하다. 사용자에게 명확히 고지.
- **Guardrails 보수적 판정**: `createdAt`이 배포 창 밖이면 이전 배포·수동 생성물일 수 있으니 **유지**를 기본값으로 한다.

## 10. 관련 자료

- **[.kiro/skills/ec2-ssm-cdk-deploy/SKILL.md](../ec2-ssm-cdk-deploy/SKILL.md)**: 짝이 되는 배포 스킬. 이 destroy 스킬은
  거기서 만든 리소스를 되돌리는 역할.
- **[scripts/deploy/deploy_list.json](../../../scripts/deploy/deploy_list.json)**: 삭제 대상의 원천 데이터. `status`가
  `destroyed`이면 이미 정리된 배포로 간주.
- **[scripts/deploy/ssm-run.sh](../../../scripts/deploy/ssm-run.sh)**: SSM Run Command 헬퍼. 백그라운드 실행에는 대신
  `aws ssm send-command` 직접 호출 + `setsid ... </dev/null >/dev/null 2>&1 & disown`를 권장 — SSM wait가 백그라운드
  명령을 실패로 오인해 exit 1로 리턴하면 재시도 시 이중 실행이 발생한다.
