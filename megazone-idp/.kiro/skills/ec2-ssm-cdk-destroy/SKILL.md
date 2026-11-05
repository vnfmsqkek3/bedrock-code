---
name: ec2-ssm-cdk-destroy
description: |
  megazone-idp(IDP-V2)의 모든 AWS 리소스를 완전히 정리하는 플레이북. 빌드 EC2에서 SSM으로 cdk destroy --all을 실행해
  14개 IDP-V2 스택을 지우고, 삭제를 막는 요소(비어있지 않은 S3·S3 Express 버킷, Neptune 삭제보호)를 선처리하며, SSM 1시간
  타임아웃을 detached 실행으로 회피한다. 스택 삭제 후 빌드 EC2(t4g.large)와 그 전용 VPC까지 순서대로 정리한다. 사용 시점:
  배포된 IDP-V2를 완전히 지우고 싶을 때, cdk destroy가 S3/Neptune/타임아웃으로 멈춰 복구가 필요할 때, 빌드 EC2·VPC 잔여
  리소스를 정리해달라고 요청할 때.
license: Proprietary
compatibility: |
  로컬에 AWS CLI가 설치되고 관리자 권한 프로파일이 구성되어야 한다. scripts/deploy/deploy_list.json이 있으면 값 대부분을
  자동으로 채운다. 없으면 프로파일·리전·EC2 인스턴스 ID를 사용자에게 요청한다. cdk destroy는 빌드 EC2가 살아 있는 동안
  SSM으로 실행하므로 EC2 종료는 CDK 스택 삭제 이후에 한다. 빌드 EC2는 arm64(t4g.large)이며 IDP 앱 VPC와 분리돼 있어야 한다.
---

# EC2 · CDK 전체 삭제 — megazone-idp (Kiro 플레이북)

`ec2-ssm-cdk-deploy`로 만든 **모든 AWS 리소스를 완전히 삭제**한다. 14개 IDP-V2 CDK 스택 + 그 데이터(S3 문서·세션·에이전트·
모델 버킷, S3 Express 벡터, Neptune 그래프, DynamoDB) + 빌드 EC2 + (배포가 만든) VPC까지 정리한다.

> ⚠️ **되돌릴 수 없다.** 실행 전 사용자에게 반드시 최종 확인을 받는다. 문서·그래프·벡터가 영구 소실된다.

## 0. 입력 + 삭제 대상 확인

### 0-1. deploy_list.json 자동 로드
`scripts/deploy/deploy_list.json`이 있으면 프로파일·리전·EC2 ID·SG·IAM·VPC·소스버킷을 자동으로 가져온다. 없으면 §0-2 입력.

| deploy_list 키 | 용도 |
|---|---|
| `metadata.profile`, `metadata.region` | AWS 프로파일·리전 |
| `resources.ec2_instance.id` | 빌드 EC2 (삭제 대상) |
| `resources.security_group.id`/`.name` | 보안 그룹 |
| `resources.iam_role.name`, `resources.instance_profile.name` | IAM 정리 |
| `resources.s3_bucket.name` | 프로젝트 전용 배포버킷(`idp-v2-deploy-<account>-<리전>`, created_by_deploy=true면 삭제) |
| `resources.vpc.id`, `resources.vpc.created_by_deploy` | **true일 때만** 빌드 VPC 삭제 |
| `resources.internet_gateway.id`, `resources.subnet.id`, `resources.route_table.*` | VPC와 함께 만든 네트워크 |

### 0-2. 입력 (deploy_list 없을 때)
| 값 | 필수 | 예시 |
|---|---|---|
| AWS 프로파일 | ✅ | `team3` |
| 리전 | ✅ | `us-west-2` |
| 빌드 EC2 인스턴스 ID | ✅ | `i-0d74ac8e869291ecf` |

### 0-3. 삭제 대상 요약 → 사용자 최종 확인
```
삭제 예정:
- IDP-V2 CDK 스택 14개 (Application/Workflow/Agent/…/Neptune/Vpc) + 모든 데이터
- 빌드 EC2: <id> (IdpV2-Deploy, t4g.large)
- (created_by_deploy=true면) 빌드 VPC/IGW/Subnet/RouteTable/SG
- 프로젝트 전용 배포버킷: <name> (예: idp-v2-deploy-<account>-<리전>)
보존:
- CDK 부트스트랩(CDKToolkit + cdk-hnb659fds-assets-*)  ← 재배포용, 기본 유지
```
함께 확인: **빌드 EC2가 `IDP-V2-Vpc`가 아닌 별도 VPC에 있는지**(그래야 destroy 중 실행 주체가 안 죽음). 아래로 검증:
```bash
BUILD_VPC=$(aws ec2 describe-instances --instance-ids <EC2> --query 'Reservations[].Instances[].VpcId' --output text)
APP_VPC=$(aws cloudformation describe-stack-resources --stack-name IDP-V2-Vpc --query "StackResources[?ResourceType=='AWS::EC2::VPC'].PhysicalResourceId" --output text 2>/dev/null)
echo "build=$BUILD_VPC  app=$APP_VPC  → 반드시 서로 달라야 함"
```
모든 CLI에 `--profile <프로파일> --region <리전>`(또는 env export)을 붙인다. 확인되면 §1로.

## 1. 삭제를 막는 요소 선처리 (cdk destroy 전에 반드시)

이 프로젝트는 아래 3가지 때문에 `cdk destroy`가 중간에 막힌다. **먼저 처리**한다.

### 1-1. Neptune 삭제보호 해제
```bash
aws neptune modify-db-cluster --db-cluster-identifier idp-v2-neptune \
  --no-deletion-protection --apply-immediately 2>&1 || true
```

### 1-2. S3 버킷 비우기 (Storage 스택이 비어야 지워짐)
문서·세션·에이전트·모델 + 각 `-logs` 버킷이 비어있지 않으면 `IDP-V2-Storage` 삭제가 실패한다. **일반 버킷 + S3 Express
디렉터리 버킷(lancedb)** 을 모두 비운다(버전 객체·삭제마커 포함):
```bash
for b in $(aws s3api list-buckets --query "Buckets[?starts_with(Name,'idp-v2')].Name" --output text); do
  aws s3 rm "s3://$b" --recursive 2>/dev/null || true
  # 버전 객체 + 삭제마커
  for key in Versions DeleteMarkers; do
    aws s3api list-object-versions --bucket "$b" --query "{O: $key[].{Key:Key,VersionId:VersionId}}" --output json 2>/dev/null | \
    python3 -c "import json,sys,subprocess;d=json.load(sys.stdin);o=(d or {}).get('O') or [];[subprocess.run(['aws','s3api','delete-objects','--bucket','$b','--delete',json.dumps({'Objects':[{'Key':x['Key'],'VersionId':x['VersionId']} for x in o[i:i+900]],'Quiet':True})],check=False) for i in range(0,len(o),900)]" 2>/dev/null || true
  done
done
# S3 Express (directory bucket) — lancedb 벡터
for b in $(aws s3api list-directory-buckets --query "Buckets[?contains(Name,'lancedb')].Name" --output text 2>/dev/null); do
  aws s3 rm "s3://$b" --recursive 2>/dev/null || true
done
```

## 2. cdk destroy --all (빌드 EC2에서 SSM · detached)

> **반드시 `cdk destroy --all`** — 개별 `delete-stack` 금지. 14개 스택은 SSM 파라미터로 얽혀 있어, `--all`이 의존성 역순으로
> 자동 정렬(Application 먼저 … Vpc 마지막)한다. 수동 삭제는 순서가 어긋나 export/param 잠금과 고아 리소스를 남긴다.

> ⚠️ **SSM `AWS-RunShellScript`는 executionTimeout(예 3600s)에 걸리면 cdk destroy를 KILL한다.** 전체 teardown은 1시간을
> 넘는다(Neptune ~10-15분, VPC ENI 정리, SageMaker 엔드포인트). 그래서 **detached로 분리** 실행하고, 로컬에서 폴링한다.

destroy 스크립트 골격(§1을 스크립트 앞부분에 포함해도 됨):
```bash
set -x
export HOME=/root AWS_REGION=<리전> AWS_DEFAULT_REGION=<리전> CDK_DEFAULT_REGION=<리전>
export NVM_DIR=/root/.nvm; . "$NVM_DIR/nvm.sh"; nvm use 22; export PATH=/root/.local/bin:$PATH
LOG=/var/log/idp-destroy.log; exec > "$LOG" 2>&1
S3PREFIX=s3://<배포버킷>/idp-deploy       # deploy_list의 s3_bucket.name (idp-v2-deploy-<account>-<리전>)
( while true; do aws s3 cp "$LOG" "$S3PREFIX/destroy.log" --region <리전> >/dev/null 2>&1; sleep 15; done ) & HB=$!
# (§1-1 Neptune, §1-2 버킷 비우기를 여기서 먼저 실행해도 좋다)
cd /root/idp/packages/infra || { echo NO_INFRA; kill $HB; exit 1; }
npx cdk destroy --all --force 2>&1
echo "CDK_DESTROY_EXIT=$?"
aws cloudformation describe-stacks --region <리전> --query "Stacks[?starts_with(StackName,'IDP-V2')].[StackName,StackStatus]" --output table
kill $HB 2>/dev/null; aws s3 cp "$LOG" "$S3PREFIX/destroy.log" --region <리전>
```

### 2-1. detached 실행 (타임아웃 회피)
스크립트를 S3에 올리고, EC2가 내려받아 **분리 실행**(중첩 따옴표를 피하려 params는 JSON 파일):
```bash
aws s3 cp /tmp/destroy-script.sh s3://<배포버킷>/idp-deploy/destroy-script.sh
python3 -c "import json;json.dump({'commands':['aws s3 cp s3://<배포버킷>/idp-deploy/destroy-script.sh /root/d.sh; setsid bash /root/d.sh </dev/null >/dev/null 2>&1 & disown; sleep 3; pgrep -af d.sh || echo NONE; echo LAUNCHED'],'executionTimeout':['120']},open('/tmp/p.json','w'))"
aws ssm send-command --instance-ids <EC2> --document-name AWS-RunShellScript --timeout-seconds 90 --parameters file:///tmp/p.json --query Command.CommandId --output text
```

### 2-2. 진행 모니터 (로컬 폴링)
CloudFormation 스택 잔여 수 + EC2 프로세스 생존을 병행 확인:
```bash
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'IDP-V2')].[StackName,StackStatus]" --output table
# 프로세스 생존 (SSM):
aws ssm send-command --instance-ids <EC2> --document-name AWS-RunShellScript --timeout-seconds 30 \
  --parameters 'commands=["pgrep -f d.sh >/dev/null && echo ALIVE || echo DEAD; tail -3 /var/log/idp-destroy.log"]' --query Command.CommandId --output text
```
**실측 삭제 순서(대략)**: Application → Workflow/LanceService/Webcrawler/Agent → Worker/Mcp → Bda/Ocr/Event →
Storage(버킷 비운 뒤) → Neptune(느림) → Vpc(마지막). 잔여 수가 0이면 스택 삭제 완료.

### 2-3. 실패 처방
| 증상 | 원인 | 처방 |
|---|---|---|
| SSM 명령이 도중에 죽고 스택 일부만 삭제됨 | executionTimeout KILL | **detached 재실행**(§2-1) + 로컬 폴링 |
| `IDP-V2-Storage` DELETE_FAILED / 버킷 not empty | S3/S3 Express에 객체·버전 잔존 | §1-2로 버킷 전부 비우고 재실행 |
| Neptune 삭제 거부 | 삭제보호 on | §1-1로 해제 |
| DELETE_IN_PROGRESS에서 오래 멈춤 | Neptune/VPC ENI 정리 지연 | 정상 — 기다림(총 >1h 가능) |
| cdk destroy 프로세스가 이미 죽었는데 스택 남음 | 이전 타임아웃 잔재 | EC2에서 `pgrep -f "cdk destroy"`로 확인 후 §2-1 재개 |

## 3. 빌드 EC2 종료 (스택 삭제 완료 후)

스택 14개가 모두 사라진 걸 확인한 뒤 EC2를 종료한다(그 전에 종료하면 cdk destroy가 멈춘다). **VPC 삭제 전 ENI 해제를 위해
`instance-terminated`까지 대기**:
```bash
aws ec2 terminate-instances --instance-ids <EC2>
aws ec2 wait instance-terminated --instance-ids <EC2> 2>&1 || true
aws ec2 describe-instances --instance-ids <EC2> --query 'Reservations[].Instances[].State.Name' --output text   # terminated 확인
```
> EBS는 `DeleteOnTermination=true`라 함께 삭제된다.

## 4. 빌드 VPC 삭제 (created_by_deploy=true일 때만)

**`deploy_list.resources.vpc.created_by_deploy`가 true**(배포가 만든 전용 VPC)일 때만 지운다. default/existing VPC는 유지.
삭제 전 **VPC 안에 빌드 EC2 외 다른 리소스가 없는지** 확인:
```bash
VPC=<빌드VPC>
aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$VPC" --query 'NetworkInterfaces[].{id:NetworkInterfaceId,attach:Attachment.InstanceId}' --output json
```
비어 있으면 **순서대로**(어긋나면 DependencyViolation): IGW detach+삭제 → 서브넷 → 비-main 라우트테이블 → 비-default SG → VPC.
```bash
IGW=$(aws ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=$VPC" --query 'InternetGateways[0].InternetGatewayId' --output text)
aws ec2 detach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC" 2>&1 || true
aws ec2 delete-internet-gateway --internet-gateway-id "$IGW" 2>&1 || true
for s in $(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" --query 'Subnets[].SubnetId' --output text); do aws ec2 delete-subnet --subnet-id "$s" 2>&1 || true; done
for r in $(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$VPC" --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text); do aws ec2 delete-route-table --route-table-id "$r" 2>&1 || true; done
for g in $(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC" --query "SecurityGroups[?GroupName!='default'].GroupId" --output text); do aws ec2 delete-security-group --group-id "$g" 2>&1 || true; done
aws ec2 delete-vpc --vpc-id "$VPC" && echo VPC_DELETED
```
> **DependencyViolation**이면 남은 ENI(예상 못한 리소스)를 `describe-network-interfaces`로 찾아 먼저 지운다.

## 5. IAM Role · 인스턴스 프로파일 · 소스 버킷 (선택)

배포가 만든 것만 정리. 다른 배포가 공유하면 유지:
```bash
aws iam remove-role-from-instance-profile --instance-profile-name IdpV2DeployProfile --role-name IdpV2DeployRole 2>&1 || true
aws iam delete-instance-profile --instance-profile-name IdpV2DeployProfile 2>&1 || true
aws iam detach-role-policy --role-name IdpV2DeployRole --policy-arn arn:aws:iam::aws:policy/AdministratorAccess 2>&1 || true
aws iam detach-role-policy --role-name IdpV2DeployRole --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>&1 || true
aws iam delete-role --role-name IdpV2DeployRole 2>&1 || true
```
프로젝트 전용 배포버킷(deploy_list의 `s3_bucket.name`, 보통 `idp-v2-deploy-<account>-<리전>`)은 배포 전용이므로 **비우고
삭제**한다. (여러 배포가 공유하는 공용 유틸 버킷을 실수로 지정했다면 유지.)
```bash
DEPLOY_BUCKET="<deploy_list.resources.s3_bucket.name>"   # 예: idp-v2-deploy-730335492431-us-west-2
aws s3 rm "s3://$DEPLOY_BUCKET" --recursive 2>/dev/null || true
aws s3 rb "s3://$DEPLOY_BUCKET" 2>&1 || true
```

## 6. 잔여 리소스 점검 (CFN 밖 / 고정이름)

cdk destroy가 못 지우는 것들을 점검하고, 사용자 확인 후 삭제:
```bash
# 남은 idp-v2 S3 버킷 / S3 Express
aws s3api list-buckets --query "Buckets[?starts_with(Name,'idp-v2')].Name" --output text
aws s3api list-directory-buckets --query "Buckets[?contains(Name,'lancedb')].Name" --output text
# Neptune / SageMaker / ElastiCache
aws neptune describe-db-clusters --query 'DBClusters[?contains(DBClusterIdentifier,`idp`)].DBClusterIdentifier' --output text
aws sagemaker list-endpoints --query "Endpoints[?contains(EndpointName,'paddle')].EndpointName" --output text
aws elasticache describe-serverless-caches --query "ServerlessCaches[?contains(ServerlessCacheName,'idp')].ServerlessCacheName" --output text 2>/dev/null
# 고정이름 IAM 역할 (Bedrock KB/AgentCore 실행용) — 남으면 사용자 확인 후 정리
aws iam list-roles --query "Roles[?contains(RoleName,'AmazonBedrock') || contains(RoleName,'IDP-V2')].RoleName" --output text
# CloudWatch 로그 그룹
aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/idp-v2" --query 'logGroups[].logGroupName' --output text
aws logs describe-log-groups --log-group-name-prefix "/aws/bedrock-agentcore" --query 'logGroups[].logGroupName' --output text
```
로그 그룹이 많으면 병렬 삭제: `… --output text | tr '\t' '\n' | xargs -P 10 -I {} aws logs delete-log-group --log-group-name "{}"`.

## 7. 최종 확인 체크리스트

| # | 항목 | 확인 | 기대 |
|---|---|---|---|
| 1 | IDP-V2 스택 | `describe-stacks` 필터 length | 0 |
| 2 | 빌드 EC2 | `describe-instances` state | `terminated` |
| 3 | (created_by_deploy면) 빌드 VPC | `describe-vpcs --vpc-ids …` | `InvalidVpcID.NotFound` |
| 4 | idp-v2 S3 버킷 | `list-buckets` 필터 | 빈 결과 |
| 5 | S3 Express (lancedb) | `list-directory-buckets` 필터 | 빈 결과 |
| 6 | Neptune | `describe-db-clusters` | 빈 결과 |
| 7 | SageMaker 엔드포인트 | `list-endpoints` 필터 | 빈 결과 |
| 8 | IAM Role/프로파일 | `get-role IdpV2DeployRole` | `NoSuchEntity`(정리 시) |
| 9 | 부트스트랩 | `describe-stacks CDKToolkit` | 보존(재배포용) — 기본 유지 |

## 8. deploy_list.json 리셋 (선택)
모든 정리가 끝나면 `scripts/deploy/deploy_list.json`을 빈 템플릿으로 덮어쓴다(`rm` 금지 — 다음 배포가 참조). 스키마는 배포
스킬 §8과 동일.

## 9. 가드레일

- **사용자 확인 필수**: 삭제 시작 전(§0-3), 잔여/고정이름 IAM 삭제 전(§6).
- **순서 엄수**: (§1 선처리 Neptune·S3) → **cdk destroy --all** → 스택 0 확인 → **EC2 종료** → **빌드 VPC 삭제** → IAM.
  EC2를 먼저 종료하면 SSM으로 destroy를 못 돌린다. VPC는 EC2·ENI가 빠져야 지워진다.
- **detached + 폴링**: SSM 타임아웃에 destroy가 죽지 않게 반드시 분리 실행하고 로컬에서 스택 잔여 수를 폴링.
- **보존 기본값**: CDK 부트스트랩은 재배포용이라 기본 유지. 프로젝트 전용 배포버킷(`idp-v2-deploy-*`)은 배포 전용이라 §5에서 삭제.
- **되돌릴 수 없음**: 문서·그래프·벡터·DDB·Cognito 사용자 전부 영구 삭제. 명확히 고지.

## 10. 관련 자료
- **[.kiro/skills/ec2-ssm-cdk-deploy/SKILL.md](../ec2-ssm-cdk-deploy/SKILL.md)**: 짝이 되는 배포 스킬.
- **[deploy_ssm.sh](../../../deploy_ssm.sh)**: 온-EC2 배포 레퍼런스(destroy 스크립트 골격도 여기서 파생).
