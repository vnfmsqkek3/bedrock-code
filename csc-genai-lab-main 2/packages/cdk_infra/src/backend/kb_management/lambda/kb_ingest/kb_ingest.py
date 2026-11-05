# Copyright Amazon.com and its affiliates; all rights reserved.
# SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
# Licensed under the Amazon Software License  https://aws.amazon.com/asl/

import os
import boto3
from botocore.exceptions import ClientError
from aws_lambda_powertools import Logger

logger = Logger(use_rfc3339=True)

knowledge_base_id = os.getenv("KNOWLEDGE_BASE_ID")
data_source_id = os.getenv("DATA_SOURCE_ID")

bedrock_agent = boto3.client("bedrock-agent")


@logger.inject_lambda_context(log_event=True)
def lambda_handler(event: dict, context):
    """
    Triggered by S3 ObjectCreated on the KB data bucket. Starts a Bedrock KB
    ingestion job so uploaded documents are indexed without a manual console sync.

    Metadata sidecars (*.metadata.json) are skipped — they are picked up alongside
    their parent document. If an ingestion job is already running for this data
    source, we skip: the in-flight job will pick up the newly landed objects.
    """
    records = event.get("Records", [])
    keys = [r.get("s3", {}).get("object", {}).get("key", "") for r in records]

    # Skip if every object in this event is a metadata sidecar.
    if keys and all(k.endswith(".metadata.json") for k in keys):
        logger.info(f"Only metadata sidecars in event ({keys}); skipping ingestion trigger.")
        return {"skipped": "metadata-only"}

    try:
        response = bedrock_agent.start_ingestion_job(
            knowledgeBaseId=knowledge_base_id,
            dataSourceId=data_source_id,
        )
        job_id = response.get("ingestionJob", {}).get("ingestionJobId")
        logger.info(f"Started ingestion job {job_id} for keys {keys}")
        return {"ingestionJobId": job_id}
    except ClientError as e:
        # A job is already in progress for this data source — it will cover new objects.
        if e.response.get("Error", {}).get("Code") == "ConflictException":
            logger.info("Ingestion job already in progress; skipping (in-flight job covers new objects).")
            return {"skipped": "already-running"}
        logger.error(f"Failed to start ingestion job: {e}")
        raise
