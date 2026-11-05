#!/bin/bash
# Canonical EC2/SSM deploy script for megazone-idp -> us-west-2 (profile team3 account).
# Runs ON the build EC2 (x86_64, admin instance role). Idempotent: already-complete
# CDK stacks are skipped, so it is safe to re-run after a partial/failed deploy.
#
# Prereqs already handled by the EC2 bootstrap (user-data):
#   - Node 22 (nvm), pnpm 10.29.3, uv+python3.13, docker, aws cli
#   - source at /root/idp (downloaded from s3://czy1023-test-s3/idp-deploy/idp-src.tgz)
#   - pnpm install + frontend bundle already done
#
# Key fixes baked in:
#   1. 2-phase deploy: IDP-V2-Vpc first (creates the VPC + /idp-v2/vpc/id SSM param that
#      other stacks resolve via Vpc.fromLookup), THEN --all.
#   2. QEMU binfmt so the x86_64 EC2 can docker-build the arm64 Bedrock AgentCore images.
set -x
export HOME=/root AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 CDK_DEFAULT_REGION=us-west-2
export NVM_DIR=/root/.nvm
. "$NVM_DIR/nvm.sh"
nvm use 22
export PATH=/root/.local/bin:$PATH

LOG=/var/log/idp-deploy-ssm.log
exec > "$LOG" 2>&1
S3PREFIX=s3://czy1023-test-s3/idp-deploy
mark() { echo "===== PHASE: $1 ($(date -u +%H:%M:%S)) ====="; aws s3 cp "$LOG" "$S3PREFIX/deploy-ssm.log" --region us-west-2 >/dev/null 2>&1 || true; }
( while true; do aws s3 cp "$LOG" "$S3PREFIX/deploy-ssm.log" --region us-west-2 >/dev/null 2>&1; sleep 20; done ) &

mark "enable-arm64-emulation"
# The x86_64 EC2 must emulate arm64 to docker-build the Bedrock AgentCore images.
# On AL2023, tonistiigi/binfmt does NOT persist the handler to the host and
# qemu-user-static is not in the repos; multiarch/qemu-user-static registers it
# correctly on the host (verified: arm64 `uname -m` -> aarch64).
mount | grep -q binfmt_misc || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc || true
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes 2>&1
ARM_OK=$(docker run --rm --platform linux/arm64 public.ecr.aws/docker/library/python:3.12-slim uname -m 2>&1)
echo "arm64-emulation-check: $ARM_OK"

cd /root/idp/packages/infra || exit 1

mark "phase1-deploy-vpc"
npx cdk deploy IDP-V2-Vpc --require-approval never 2>&1
echo "VPC_RC=$?"

mark "phase2-deploy-all"
npx cdk deploy --all --require-approval never --concurrency 3 2>&1
RC=$?
echo "===== CDK_DEPLOY_EXIT=$RC ====="

mark "done-rc-$RC"
echo "DEPLOY_SSM_COMPLETE rc=$RC" > /root/DEPLOY_SSM_STATUS
aws s3 cp /root/DEPLOY_SSM_STATUS "$S3PREFIX/DEPLOY_SSM_STATUS" --region us-west-2 || true
aws s3 cp "$LOG" "$S3PREFIX/deploy-ssm.log" --region us-west-2 || true
