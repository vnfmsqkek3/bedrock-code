/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import * as fs from "fs";
import * as path from "path";
import { PythonLayerVersion } from "@aws-cdk/aws-lambda-python-alpha";
import { Duration, CustomResource } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

// Seeded into Bedrock Prompt Management on deploy so 프롬프트 관리 shows the default that
// actually runs. Read from the chat router's own instruction file rather than restated here:
// when the same wording lived in both places they drifted, and the version people could read
// and edit was no longer the version answering their questions.
//
// Only the instruction body is shared. Each side supplies its own $search_results$ and
// $output_format_instructions$ placeholders — the seeded prompt gets them from
// prompts.py::_compose_template, the router builds them in directly — so the body must not
// carry them or they would appear twice.
const DEFAULT_PROMPT_SYSTEM = fs
  .readFileSync(
    path.join(
      "src", "backend", "basic_rest_api", "lambda", "qna_agent_rest_api",
      "dispatch", "answer_instructions.txt",
    ),
    "utf-8",
  )
  .trim();
// No one-shot example. The previous one answered a question about a different product
// entirely, which read as part of the default behaviour and taught the wrong subject.
const DEFAULT_PROMPT_USER = "";
const DEFAULT_PROMPT_ASSISTANT = "";

export interface PromptsApiProps {
  restApi: apigateway.RestApi;
  authorizer: apigateway.IAuthorizer;
  LAYER_BOTO: PythonLayerVersion;
  LAYER_POWERTOOLS: PythonLayerVersion;
  PREFIX: string;
}

/**
 * Server-side prompt store applied to the RAG chat:
 *   GET/POST         /prompts
 *   PUT/DELETE       /prompts/{prompt_id}
 * Prompts are scoped per Cognito user and persisted in DynamoDB so they survive
 * across browsers/sessions. The saved template feeds RetrieveAndGenerate.
 */
export class PromptsApi extends Construct {
  constructor(scope: Construct, id: string, props: PromptsApiProps) {
    super(scope, id);

    // Prompts live entirely in Amazon Bedrock Prompt Management (see IAM below) — no
    // DynamoDB table. The lambda reads/writes prompts via the bedrock-agent API only.
    const promptsLambda = new lambda.Function(this, props.PREFIX + "PromptsLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(path.join("src", "backend", "prompts", "lambda")),
      handler: "prompts.lambda_handler",
      timeout: Duration.seconds(30),
      memorySize: 256,
      layers: [props.LAYER_POWERTOOLS, props.LAYER_BOTO],
      environment: {
        POWERTOOLS_LOG_LEVEL: "INFO",
        POWERTOOLS_SERVICE_NAME: "Prompts",
      },
    });
    // Prompts are stored in Amazon Bedrock Prompt Management.
    promptsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:CreatePrompt",
          "bedrock:ListPrompts",
          "bedrock:GetPrompt",
          "bedrock:UpdatePrompt",
          "bedrock:DeletePrompt",
        ],
        resources: ["*"],
      }),
    );

    // Seed a default "기본 답변 형식" prompt into Bedrock Prompt Management on deploy.
    const promptSeedFn = new lambda.Function(this, props.PREFIX + "PromptSeedFn", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(path.join("src", "backend", "prompts", "lambda")),
      handler: "prompt_seed.handler",
      timeout: Duration.minutes(2),
      memorySize: 256,
      layers: [props.LAYER_POWERTOOLS, props.LAYER_BOTO],
      // The prompt text goes in the custom resource's properties below, NOT here. Lambda caps
      // an UpdateFunctionConfiguration request at 5120 bytes across all environment variables,
      // so carrying the answer instructions here broke every deploy with a 413 as soon as the
      // file grew past it. The properties carry the same text and already trigger a re-seed
      // when it changes.
      environment: {
        PROMPT_NAME: "default-answer-format",
        PROMPT_TITLE: "기본 답변 형식",
      },
    });
    promptSeedFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:CreatePrompt",
          "bedrock:ListPrompts",
          "bedrock:GetPrompt",
          "bedrock:UpdatePrompt",
          "bedrock:DeletePrompt",
        ],
        resources: ["*"],
      }),
    );
    const promptSeedProvider = new cr.Provider(this, props.PREFIX + "PromptSeedProvider", {
      onEventHandler: promptSeedFn,
    });
    new CustomResource(this, props.PREFIX + "PromptSeed", {
      serviceToken: promptSeedProvider.serviceToken,
      // Include the prompt text so editing it re-seeds on the next deploy.
      properties: {
        system: DEFAULT_PROMPT_SYSTEM,
        user: DEFAULT_PROMPT_USER,
        assistant: DEFAULT_PROMPT_ASSISTANT,
      },
    });

    const integration = new apigateway.LambdaIntegration(promptsLambda);
    const methodOptions = {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: props.authorizer,
    };
    const cors = {
      allowOrigins: apigateway.Cors.ALL_ORIGINS,
      allowMethods: apigateway.Cors.ALL_METHODS,
    };

    const prompts = props.restApi.root.addResource("prompts", {
      defaultCorsPreflightOptions: cors,
    });
    prompts.addMethod("GET", integration, methodOptions);
    prompts.addMethod("POST", integration, methodOptions);

    const promptItem = prompts.addResource("{prompt_id}", {
      defaultCorsPreflightOptions: cors,
    });
    promptItem.addMethod("PUT", integration, methodOptions);
    promptItem.addMethod("DELETE", integration, methodOptions);
  }
}
