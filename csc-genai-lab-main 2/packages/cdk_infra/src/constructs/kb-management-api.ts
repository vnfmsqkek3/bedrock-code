/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import * as path from "path";
import { PythonLayerVersion } from "@aws-cdk/aws-lambda-python-alpha";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface KbManagementApiProps {
  restApi: apigateway.RestApi;
  authorizer: apigateway.IAuthorizer;
  kbBucket: s3.IBucket;
  knowledgeBaseArn: string;
  knowledgeBaseId: string;
  dataSourceId?: string;
  // Bedrock model used to auto-generate document metadata (must support document input, e.g. Claude 3+).
  metadataModelId: string;
  LAYER_BOTO: PythonLayerVersion;
  LAYER_POWERTOOLS: PythonLayerVersion;
  PREFIX: string;
}

/**
 * REST endpoints for managing Knowledge Base documents from the UI:
 *   POST   /kb/upload-url   -> presigned S3 PUT URL
 *   POST   /kb/documents    -> write <key>.metadata.json sidecar
 *   GET    /kb/documents    -> list documents + metadata + latest ingestion status
 *   DELETE /kb/documents    -> delete document (?key=) and its sidecar
 */
export class KbManagementApi extends Construct {
  constructor(scope: Construct, id: string, props: KbManagementApiProps) {
    super(scope, id);

    // Async upload task status lives here, NOT in the KB data bucket. The knowledge base
    // data source scans its bucket in full, and a status object is necessarily alive while
    // the very upload that created it is kicking off an ingestion job — so parking status
    // there gets it embedded as a document. Deleting the object on the final poll does not
    // prevent that: once a chunk is indexed it survives the object, and an abandoned upload
    // (closed tab) never reaches the final poll at all. A bucket outside the data source
    // makes the outcome independent of timing.
    const statusBucket = new s3.Bucket(this, props.PREFIX + "KbUploadStatusBucket", {
      enforceSSL: true,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Backstop for tasks whose poller never collected them.
      lifecycleRules: [
        { id: "ExpireAbandonedTasks", enabled: true, expiration: Duration.days(1) },
      ],
    });

    const kbLambda = new lambda.Function(this, props.PREFIX + "KbDocumentsLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(
        path.join("src", "backend", "kb_management", "lambda", "kb_documents"),
      ),
      handler: "kb_documents.lambda_handler",
      // The background half of /kb/process reads a whole document twice — once for metadata,
      // once to transcribe every page — and a long document takes several minutes for the
      // second pass alone. This is the Lambda ceiling; a document that outgrows it needs the
      // transcription split into page ranges rather than a larger number here.
      timeout: Duration.minutes(15),
      memorySize: 512,
      layers: [props.LAYER_POWERTOOLS, props.LAYER_BOTO],
      environment: {
        POWERTOOLS_LOG_LEVEL: "INFO",
        POWERTOOLS_SERVICE_NAME: "KbDocuments",
        KB_BUCKET: props.kbBucket.bucketName,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        // DATA_SOURCE_ID is intentionally NOT wired cross-stack — the lambda resolves it
        // at runtime from the KB. Passing it here created a CloudFormation export that
        // blocked ever recreating the data source (e.g. to change the parser).
        ...(props.dataSourceId ? { DATA_SOURCE_ID: props.dataSourceId } : {}),
        METADATA_MODEL_ID: props.metadataModelId,
        STATUS_BUCKET: statusBucket.bucketName,
      },
    });

    props.kbBucket.grantReadWrite(kbLambda);
    statusBucket.grantReadWrite(kbLambda);
    // POST /kb/process returns 202 immediately and re-invokes this same Lambda
    // asynchronously to do the Bedrock analysis, which routinely outlives API Gateway's
    // 29 s integration timeout on large PDFs.
    // A standalone Policy, NOT kbLambda.grantInvoke(kbLambda): that folds the function's
    // own ARN into the role's DefaultPolicy, which the API Gateway deployment already
    // depends on — CloudFormation rejects the resulting cycle.
    new iam.Policy(this, props.PREFIX + "KbDocumentsSelfInvoke", {
      roles: [kbLambda.role!],
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["lambda:InvokeFunction"],
          resources: [kbLambda.functionArn],
        }),
      ],
    });
    // Ingestion control + status polling for the KB data source.
    kbLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:StartIngestionJob",
          "bedrock:GetIngestionJob",
          "bedrock:ListIngestionJobs",
          // Needed to resolve the data source id at runtime (no longer passed as env).
          "bedrock:ListDataSources",
          "bedrock:GetDataSource",
          // Direct vector deletion on document delete (immediate purge, vs. waiting on a full ingestion sync).
          "bedrock:DeleteKnowledgeBaseDocuments",
        ],
        resources: [props.knowledgeBaseArn],
      }),
    );
    // Auto-metadata generation reads the uploaded document via Bedrock Converse.
    kbLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/*`,
          `arn:aws:bedrock:*:${Stack.of(this).account}:inference-profile/*`,
        ],
      }),
    );

    // /kb/{proxy+} routed to the Powertools resolver in the Lambda.
    const kbResource = props.restApi.root.addResource("kb", {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });
    kbResource.addProxy({
      anyMethod: true,
      defaultIntegration: new apigateway.LambdaIntegration(kbLambda),
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: props.authorizer,
      },
    });
  }
}
