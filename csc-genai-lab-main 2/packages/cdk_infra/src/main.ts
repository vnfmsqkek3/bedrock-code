/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import { CdkGraph, FilterPreset, Filters } from "@aws/pdk/cdk-graph";
import { CdkGraphDiagramPlugin } from "@aws/pdk/cdk-graph-plugin-diagram";
import { CdkGraphThreatComposerPlugin } from "@aws/pdk/cdk-graph-plugin-threat-composer";
import { AwsPrototypingChecks, PDKNag } from "@aws/pdk/pdk-nag";
import { App, Tags } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";
import { BedrockKnowledgeBaseStack } from "./stacks/bedrock-kb-stack";
import { CommonStack } from "./stacks/common-stack";
import { ChatBotStack } from "./stacks/chatbot/chatbot"
import { WebsiteStack } from "./stacks/website-stack";

// Define deployment case enum
enum DeployCase {
  CHATBOT = "chatbot",
  ALL = "all",
}

// Function to get the deployment case
function getDeployCase(app: App): DeployCase {
  const deployCase = app.node.tryGetContext("deploy:case")?.toLowerCase();

  // Return CHATBOT as default if no input or explicitly set to 'chatbot'
  if (!deployCase || deployCase === DeployCase.CHATBOT) {
    return DeployCase.CHATBOT;
  }

  // Check for ALL case
  if (deployCase === DeployCase.ALL) {
    return DeployCase.ALL;
  }

  // Throw error for invalid input
  throw new Error(
    `Invalid deploy case: ${deployCase}. Valid options are: ${Object.values(DeployCase).join(", ")}`,
  );
}

/* eslint-disable @typescript-eslint/no-floating-promises */
(async () => {
  const app = PDKNag.app({
    nagPacks: [new AwsPrototypingChecks()],
  });
  // * Setting stack name prefix
  // Unique per deployment (region by default) so the Bedrock constructs' fixed-name
  // IAM roles (which are global) don't collide across regional deployments.
  // Override with `-c deploy:id=<token>` to pick your own suffix.
  const deployId = (app.node.tryGetContext("deploy:id") || process.env.CDK_DEFAULT_REGION || "default")
    .replace(/[^a-zA-Z0-9]/g, "");
  const stackNamePrefix = `CSCGenAILab-${deployId}-`;

  // Setting Common Environment
  const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  };

  // Get the deployment case
  const deployCase = getDeployCase(app);
  const pace_deployment_version = "1.1.0"
  const deployment_name = "pace_developer_workshop_prime"
  // * Create commonStack
  const commonStack = new CommonStack(app, stackNamePrefix + "CommonStack", {
    env: env,
    description:"CSC GENAILAB WORKSHOP (uksb-arjmsrldpz)(tag:" + deployCase + ", " + pace_deployment_version + ", " + deployment_name + ")",
    stackName: stackNamePrefix + "CommonStack",
  });


  // Declare bedrockKnowledgeBaseStack outside the switch statement
  let bedrockKnowledgeBaseStack: BedrockKnowledgeBaseStack | undefined;

  // Decide to deploy Amazon Bedrock Knowledge Base
  const deployKnowledgeBase = app.node.tryGetContext("deploy:knowledgebase");
  if (deployKnowledgeBase) {
    bedrockKnowledgeBaseStack = new BedrockKnowledgeBaseStack(
      app,
      stackNamePrefix + "BedrockKnowledgeBaseStack",
      {
        env: env,
        ACCESS_LOG_BUCKET: commonStack.ACCESS_LOG_BUCKET,
        LAYER_BOTO: commonStack.LAYER_BOTO,
        LAYER_POWERTOOLS: commonStack.LAYER_POWERTOOLS,
      },
    );
    bedrockKnowledgeBaseStack.addDependency(commonStack);
  }

  // Create stacks based on deployment case
  let chatbotStack: ChatBotStack | undefined;
  switch (deployCase) {
    case DeployCase.CHATBOT:
    case DeployCase.ALL:
      chatbotStack = new ChatBotStack(
        app,
        stackNamePrefix + "ChatbotStack",
        {
          env: env,
          stackNamePrefix: "chatbot",
          commonStack: commonStack,
          bedrockKnowledgeBaseStack: bedrockKnowledgeBaseStack
        },
      );
      // KB stack publishes exports (KnowledgeBaseId 등)을 ChatbotStack의 nested AgentsStack이
      // import하므로, KB 완료 전에 병렬 배포되면 "No export named ... found"로 rollback된다.
      // cdk deploy --all이 KB → Chatbot 순으로 배포하도록 명시적 의존성 부여.
      if (bedrockKnowledgeBaseStack) {
        chatbotStack.addDependency(bedrockKnowledgeBaseStack);
      }
      break;

    default:
      throw new Error("Invalid deployment case");
  }

  // * Website hosting (CloudFront + S3) with runtime config injection.
  // Requires packages/reactjs_ui/dist (run `vite build` before synth/deploy).
  const deployWebsite = app.node.tryGetContext("deploy:website") ?? true;
  if (deployWebsite && chatbotStack?.API_URL) {
    const websiteStack = new WebsiteStack(app, stackNamePrefix + "WebsiteStack", {
      env: env,
      stackName: stackNamePrefix + "WebsiteStack",
      API_URL: chatbotStack.API_URL,
      STREAMING_FUNCTION_NAME: chatbotStack.STREAMING_FUNCTION_NAME || "",
      USER_POOL_ID: commonStack.USER_IDENTITY.userPool.userPoolId,
      USER_POOL_CLIENT_ID: commonStack.USER_IDENTITY.userPoolClient.userPoolClientId,
      IDENTITY_POOL_ID: commonStack.USER_IDENTITY.identityPool.identityPoolId,
    });
    websiteStack.addDependency(chatbotStack);
  }

  // * Architecture Diagram
  const graph = new CdkGraph(app, {
    plugins: [
      new CdkGraphDiagramPlugin({
        defaults: {
          filterPlan: {
            preset: FilterPreset.COMPACT,
            filters: [{ store: Filters.pruneCustomResources() }],
          },
        },
      }),
      new CdkGraphThreatComposerPlugin(),
    ],
  });

  // * Custom Tags
  Tags.of(app).add("creator", "AWS PACE");
  Tags.of(app).add("project", "Generative AI Developer Workshop");
  app.synth();
  await graph.report();
})();
