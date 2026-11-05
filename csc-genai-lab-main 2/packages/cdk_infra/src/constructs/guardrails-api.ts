/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import * as path from "path";
import { PythonLayerVersion } from "@aws-cdk/aws-lambda-python-alpha";
import { Duration, CustomResource } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

// Seeded into Bedrock Guardrails on deploy so every account/region gets a default
// PII-masking guardrail in the 가드레일 list (phone numbers -> {PHONE} in answers).
const DEFAULT_GUARDRAIL_NAME = "default-phone-masking";
const DEFAULT_GUARDRAIL_TITLE = "기본 전화번호 마스킹";
const DEFAULT_GUARDRAIL_PII = "PHONE";

export interface GuardrailsApiProps {
  restApi: apigateway.RestApi;
  authorizer: apigateway.IAuthorizer;
  LAYER_BOTO: PythonLayerVersion;
  LAYER_POWERTOOLS: PythonLayerVersion;
  PREFIX: string;
}

/**
 * Server-side guardrail store applied to the RAG chat:
 *   GET/POST         /guardrails
 *   PUT/DELETE       /guardrails/{guardrail_id}
 * Guardrails live in Amazon Bedrock Guardrails (visible in the console). The chat lambda
 * applies a selected guardrail to RetrieveAndGenerate. Mirrors PromptsApi.
 */
export class GuardrailsApi extends Construct {
  constructor(scope: Construct, id: string, props: GuardrailsApiProps) {
    super(scope, id);

    const guardrailsLambda = new lambda.Function(this, props.PREFIX + "GuardrailsLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(path.join("src", "backend", "guardrails", "lambda")),
      handler: "guardrails.lambda_handler",
      timeout: Duration.seconds(30),
      memorySize: 256,
      layers: [props.LAYER_POWERTOOLS, props.LAYER_BOTO],
      environment: {
        POWERTOOLS_LOG_LEVEL: "INFO",
        POWERTOOLS_SERVICE_NAME: "Guardrails",
      },
    });
    // Guardrails are stored in Amazon Bedrock Guardrails.
    guardrailsLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:CreateGuardrail",
          "bedrock:ListGuardrails",
          "bedrock:GetGuardrail",
          "bedrock:UpdateGuardrail",
          "bedrock:DeleteGuardrail",
        ],
        resources: ["*"],
      }),
    );

    // Seed a default PII-masking guardrail into Bedrock Guardrails on deploy (idempotent
    // upsert by name), so a fresh account/region gets one out of the box.
    const guardrailSeedFn = new lambda.Function(this, props.PREFIX + "GuardrailSeedFn", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(path.join("src", "backend", "guardrails", "lambda")),
      handler: "guardrail_seed.handler",
      timeout: Duration.minutes(2),
      memorySize: 256,
      layers: [props.LAYER_POWERTOOLS, props.LAYER_BOTO],
      environment: {
        GUARDRAIL_NAME: DEFAULT_GUARDRAIL_NAME,
        GUARDRAIL_TITLE: DEFAULT_GUARDRAIL_TITLE,
        PII_TYPES: DEFAULT_GUARDRAIL_PII,
      },
    });
    guardrailSeedFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:CreateGuardrail",
          "bedrock:ListGuardrails",
          "bedrock:GetGuardrail",
          "bedrock:UpdateGuardrail",
          "bedrock:DeleteGuardrail",
        ],
        resources: ["*"],
      }),
    );
    const guardrailSeedProvider = new cr.Provider(this, props.PREFIX + "GuardrailSeedProvider", {
      onEventHandler: guardrailSeedFn,
    });
    new CustomResource(this, props.PREFIX + "GuardrailSeed", {
      serviceToken: guardrailSeedProvider.serviceToken,
      // Include the config so editing it re-seeds (upserts) on the next deploy.
      properties: {
        name: DEFAULT_GUARDRAIL_NAME,
        title: DEFAULT_GUARDRAIL_TITLE,
        pii: DEFAULT_GUARDRAIL_PII,
      },
    });

    const integration = new apigateway.LambdaIntegration(guardrailsLambda);
    const methodOptions = {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: props.authorizer,
    };
    const cors = {
      allowOrigins: apigateway.Cors.ALL_ORIGINS,
      allowMethods: apigateway.Cors.ALL_METHODS,
    };

    const guardrails = props.restApi.root.addResource("guardrails", {
      defaultCorsPreflightOptions: cors,
    });
    guardrails.addMethod("GET", integration, methodOptions);
    guardrails.addMethod("POST", integration, methodOptions);

    const guardrailItem = guardrails.addResource("{guardrail_id}", {
      defaultCorsPreflightOptions: cors,
    });
    guardrailItem.addMethod("PUT", integration, methodOptions);
    guardrailItem.addMethod("DELETE", integration, methodOptions);
  }
}
