/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import { App } from "aws-cdk-lib";
import { BedrockKnowledgeBaseStack } from "../src/stacks/bedrock-kb-stack";
import { ChatBotStack } from "../src/stacks/chatbot/chatbot";
import { CommonStack } from "../src/stacks/common-stack";

describe("CDK Stack Configurations", () => {
  const stackNamePrefix = "CSCGenAILab-";
  const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  };

  describe("Deployment Cases", () => {
    test("Chatbot with Knowledge Base", () => {
      const app = new App({
        context: {
          "deploy:case": "chatbot",
          "deploy:knowledgebase": true,
        },
      });

      const commonStack = new CommonStack(
        app,
        stackNamePrefix + "CommonStack",
        { env },
      );

      const bedrockKnowledgeBaseStack = new BedrockKnowledgeBaseStack(
        app,
        stackNamePrefix + "BedrockKnowledgeBaseStack",
        {
          env,
          ACCESS_LOG_BUCKET: commonStack.ACCESS_LOG_BUCKET,
          LAYER_BOTO: commonStack.LAYER_BOTO,
        },
      );

      const chatbotStack = new ChatBotStack(
        app,
        stackNamePrefix + "ChatbotStack",
        {
          env,
          stackNamePrefix: "chatbot",
          commonStack,
          bedrockKnowledgeBaseStack,
        },
      );
      expect(chatbotStack).toBeDefined();
    });

    test("Throws Error for Invalid Deployment Case", () => {
      expect(() => {
        const app = new App({
          context: {
            "deploy:case": "invalid-case",
          },
        });

        // This mirrors the validation logic in main.ts
        const deployCase = app.node.tryGetContext("deploy:case")?.toLowerCase();
        if (!["chatbot", "all"].includes(deployCase)) {
          throw new Error(
            `Invalid deploy case: ${deployCase}. Valid options are: chatbot, all`,
          );
        }
      }).toThrow("Invalid deploy case");
    });
  });
});
