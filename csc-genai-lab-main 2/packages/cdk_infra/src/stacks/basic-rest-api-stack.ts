/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import * as path from "path";
import { PythonLayerVersion } from "@aws-cdk/aws-lambda-python-alpha";
import { bedrock } from "@cdklabs/generative-ai-cdk-constructs";
import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { ChatSummaryWithSessionId } from "../constructs/chat-summary-with-sessionid";
import { KbManagementApi } from "../constructs/kb-management-api";
import { PromptsApi } from "../constructs/prompts-api";
import { GuardrailsApi } from "../constructs/guardrails-api";

interface BasicRestApiStackProps extends StackProps {
  LAYER_BOTO: PythonLayerVersion;
  LAYER_POWERTOOLS: PythonLayerVersion;
  LAYER_PYDANTIC: PythonLayerVersion;
  AGENT_KB: bedrock.IKnowledgeBase | null;
  KB_DATA_BUCKET?: s3.IBucket;
  KB_DATA_SOURCE_ID?: string;
  USER_POOL: cognito.IUserPool;
  PREFIX: string;
}

export class BasicRestApiStack extends Stack {
  public readonly SESSIONS_TABLE: dynamodb.Table;
  public readonly API_URL: string;
  public readonly STREAMING_FUNCTION_NAME: string;

  constructor(scope: Construct, id: string, props: BasicRestApiStackProps) {
    super(scope, id, props);

    // Prefix name for the api.
    const prefixName = props.PREFIX

    // * Amazon DynamoDB
    const sessionsTable = new dynamodb.Table(this, prefixName+"SessionsTable", {
      partitionKey: {
        name: "sessionId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
      // Streamed answers park their retrieval state here between the prepare and finalize
      // calls (see qna_agent_rest_api.py). Those records are useful for one request and are
      // never read again, so they expire themselves rather than accumulating forever.
      timeToLiveAttribute: "expiresAt",
    });

    this.SESSIONS_TABLE = sessionsTable;

    // * AWS Lambda
    let basicRestApiLambdaDir = "src/backend/basic_rest_api/lambda";

    // Cognito User Pool authorizer for API Gateway (validates the caller's Cognito ID token)
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      prefixName + "CognitoAuthorizer",
      {
        cognitoUserPools: [props.USER_POOL],
      },
    );

    // Lambda function role for log access, dynamodb read/write permissions, and bedrock invocation permissions.
    const lambdaRole = new iam.Role(this, prefixName+"QnAAgentRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
      inlinePolicies: {
        dynamoDBAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
              ],
              resources: [sessionsTable.tableArn],
            }),
          ],
        }),
        bedrockRagAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["bedrock:RetrieveAndGenerate", "bedrock:Retrieve"],
              resources: props.AGENT_KB ? [props.AGENT_KB.knowledgeBaseArn] : ["*"],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["bedrock:InvokeModel", "bedrock:GetInferenceProfile"],
              resources: [
                `arn:aws:bedrock:*::foundation-model/*`,
                `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
              ],
            }),
            // Apply a user-selected guardrail to RetrieveAndGenerate.
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["bedrock:ApplyGuardrail"],
              resources: [`arn:aws:bedrock:*:${this.account}:guardrail/*`],
            }),
          ],
        }),
      },
      description: "Role for Lambda API Interface",
    });
    lambdaRole.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // Lambda Function that serves as the backend of the QnA Agent Rest API
    const qnaAgentRestApiBackend = new lambda.Function(
      this,
      prefixName+"QnAAgentRestApiBackend",
      {
        runtime: lambda.Runtime.PYTHON_3_11,
        code: lambda.Code.fromAsset(
          path.join(basicRestApiLambdaDir, "qna_agent_rest_api"),
        ),
        handler: "qna_agent_rest_api.lambda_handler",
        environment: {
          POWERTOOLS_LOG_LEVEL: "INFO",
          POWERTOOLS_SERVICE_NAME: "QnaAgentApi",
          DEBUG: "false",
          SESSIONS_TABLE: sessionsTable.tableName,
          ACCOUNT_ID: this.account,
          DEFAULT_MODEL_ID:
            this.node.tryGetContext("chat:defaultModelId") ||
            "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        },
        timeout: Duration.seconds(300),
        memorySize: 512,
        layers: [props.LAYER_POWERTOOLS, props.LAYER_BOTO],
        reservedConcurrentExecutions: 5,
        role: lambdaRole,
      },
    );

    const knowledgeBase = props.AGENT_KB;
    if (knowledgeBase) {
      // Add Knolwedge Base id in environment
      qnaAgentRestApiBackend.addEnvironment(
        "KNOWLEDGE_BASE_ID",
        knowledgeBase.knowledgeBaseId,
      );
    }

    // ========================================================================
    // Lambda Function URL with Response Streaming for QnA Agent
    // ========================================================================
    // Node.js Lambda that uses awslambda.streamifyResponse() for real-time
    // streaming. It invokes the Python QnA Lambda internally and streams the
    // response text character by character to the browser.
    const streamingLambda = new lambda.Function(
      this,
      prefixName + "QnAAgentStreamingBackend",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        code: lambda.Code.fromAsset(
          path.join(basicRestApiLambdaDir, "streaming_proxy"),
          {
            bundling: {
              image: lambda.Runtime.NODEJS_20_X.bundlingImage,
              // --cache is load-bearing. CDK runs the bundling container as the host uid, which
              // has no passwd entry inside the image, so HOME resolves to "/" and npm tries to
              // create its cache at /.npm — not writable for that uid. npm exits EACCES, the
              // asset fails to bundle and the whole stack deploy stops. /tmp is writable for
              // any uid.
              command: [
                "bash", "-c",
                "cp -r /asset-input/* /asset-output/ && cd /asset-output && npm install --omit=dev --cache /tmp/.npm",
              ],
            },
          },
        ),
        handler: "index.handler",
        environment: {
          QNA_FUNCTION_NAME: qnaAgentRestApiBackend.functionName,
        },
        timeout: Duration.seconds(300),
        memorySize: 512,
      },
    );

    // Grant streaming proxy permission to invoke the QnA Lambda
    qnaAgentRestApiBackend.grantInvoke(streamingLambda);

    // The proxy runs the model itself so it can stream tokens as they are produced — Lambda
    // response streaming is a Node.js-runtime feature, so the Python function cannot do it.
    // Retrieval and post-processing still happen in Python, via the two invokes above.
    streamingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModelWithResponseStream", "bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/*`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }),
    );
    streamingLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:ApplyGuardrail"],
        resources: [`arn:aws:bedrock:*:${this.account}:guardrail/*`],
      }),
    );

    // Note: streaming proxy doesn't need KNOWLEDGE_BASE_ID — it invokes the QnA Lambda which has it.

    // Grant S3 access for presigned image URLs (QnA Lambda)
    if (props.KB_DATA_BUCKET) {
      qnaAgentRestApiBackend.addEnvironment("IMAGE_BUCKET", props.KB_DATA_BUCKET.bucketName);
      lambdaRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["s3:PutObject", "s3:GetObject"],
          resources: [
            `${props.KB_DATA_BUCKET.bucketArn}/_tmp_images/*`,
            // Page -> section maps written at ingestion. Read-only in practice, but this
            // statement is shared; the prefix holds nothing the QnA path would overwrite.
            `${props.KB_DATA_BUCKET.bucketArn}/_sections/*`,
          ],
        }),
      );
    }

    // The browser calls this Lambda through the SDK's InvokeWithResponseStream (signed with
    // Cognito Identity Pool credentials), not over HTTP — see streamingClient.js. So the SPA
    // needs the FUNCTION NAME, and nothing needs the Function URL.
    //
    // A Function URL is also attached out-of-band: CloudFormation cannot create Lambda URL
    // resources in this account (an AWS::EarlyValidation::PropertyValidation hook blocks them),
    // so it is added post-deploy via the CLI. Do NOT route the SPA through that URL — a value
    // that only exists post-deploy gets published as "" on every `cdk deploy`, which is exactly
    // how runtime-config.json lost its streaming config once already.
    this.STREAMING_FUNCTION_NAME = streamingLambda.functionName;

    new CfnOutput(this, prefixName + "QnAStreamingLambdaArn", {
      description: "ARN of the streaming Lambda (Function URL added post-deploy via CLI)",
      value: streamingLambda.functionArn,
    });

    new CfnOutput(this, prefixName + "QnAStreamingLambdaName", {
      description: "Name of the streaming Lambda",
      value: streamingLambda.functionName,
    });

    // Suppress CDK Nag warnings for streaming Lambda.
    NagSuppressions.addResourceSuppressions(
      streamingLambda,
      [
        {
          id: "AwsPrototyping-LambdaLatestVersion",
          reason: "Python 3.11 is used for compatibility with the existing codebase layers.",
        },
      ],
      true,
    );

    new CfnOutput(this, prefixName + "QnAStreamingFunctionUrl", {
      description: "Function URL for streaming QnA responses (populated post-deploy)",
      value: "PENDING_POST_DEPLOY",
    });

    // * Amazon API Gateway

    // Basic Rest API with a Custom AWS Lambda Authorizer that calls the QnA Agent
    const qnaAgentRestApi = new apigateway.RestApi(this, prefixName+"QnAAgentRestApi");
    this.API_URL = qnaAgentRestApi.url;
    const apiResource = qnaAgentRestApi.root.addResource("qna-agent", {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });
    apiResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(qnaAgentRestApiBackend),
      {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: cognitoAuthorizer,
      },
    );

    // Invoke URL for the frontend (wire into VITE_API_URL)
    new CfnOutput(this, prefixName + "QnAAgentApiUrl", {
      description: "Base invoke URL for the QnA Agent REST API",
      value: qnaAgentRestApi.url,
    });

    // * Pluggable Constructs can be added below this line

    // Knowledge Base document management (upload + metadata + status) — only when a KB is deployed.
    if (knowledgeBase && props.KB_DATA_BUCKET) {
      new KbManagementApi(this, prefixName + "KbManagementApi", {
        restApi: qnaAgentRestApi,
        authorizer: cognitoAuthorizer,
        kbBucket: props.KB_DATA_BUCKET,
        knowledgeBaseArn: knowledgeBase.knowledgeBaseArn,
        knowledgeBaseId: knowledgeBase.knowledgeBaseId,
        // dataSourceId intentionally omitted — resolved at runtime by the lambda so the
        // KB data source can be recreated without a cross-stack export blocking it.
        metadataModelId:
          this.node.tryGetContext("metadata:modelId") ||
          "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        LAYER_BOTO: props.LAYER_BOTO,
        LAYER_POWERTOOLS: props.LAYER_POWERTOOLS,
        PREFIX: prefixName,
      });
    }

    // Server-side prompt management, applied to the RAG chat.
    new PromptsApi(this, prefixName + "PromptsApi", {
      restApi: qnaAgentRestApi,
      authorizer: cognitoAuthorizer,
      LAYER_BOTO: props.LAYER_BOTO,
      LAYER_POWERTOOLS: props.LAYER_POWERTOOLS,
      PREFIX: prefixName,
    });

    // Server-side guardrail management, applied to the RAG chat.
    new GuardrailsApi(this, prefixName + "GuardrailsApi", {
      restApi: qnaAgentRestApi,
      authorizer: cognitoAuthorizer,
      LAYER_BOTO: props.LAYER_BOTO,
      LAYER_POWERTOOLS: props.LAYER_POWERTOOLS,
      PREFIX: prefixName,
    });

    // Chat Summary feature addition to API interface
    new ChatSummaryWithSessionId(this, prefixName+"ChatSummaryWithSessionId", {
      restApi: qnaAgentRestApi,
      sessionTable: sessionsTable,
      authorizer: cognitoAuthorizer,
      LAYER_BOTO: props.LAYER_BOTO,
      LAYER_POWERTOOLS: props.LAYER_POWERTOOLS,
      PREFIX: prefixName
    });
  }
}
