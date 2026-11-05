/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import * as cdk from 'aws-cdk-lib';
import { BasicRestApiStack } from '../basic-rest-api-stack';
import { CommonStack } from '../common-stack';
import { BedrockKnowledgeBaseStack } from '../bedrock-kb-stack';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

interface ChatBotStackProps extends cdk.StackProps {
    env: cdk.Environment;
    stackNamePrefix: string;
    commonStack: CommonStack;
    bedrockKnowledgeBaseStack?: BedrockKnowledgeBaseStack;
}

export class ChatBotStack extends cdk.Stack {
    public API_URL?: string;
    public STREAMING_FUNCTION_NAME?: string;

    constructor(scope: Construct, id: string, props: ChatBotStackProps) {
        super(scope, id, props);

        // Skip BedrockAgentsStack — Bedrock Agent creation is blocked by SCP in this account.
        // BasicRestApiStack uses RetrieveAndGenerate directly, so Agent is not required for RAG Q&A.

        // Create BasicRestApiStack for Chatbot (without Agent)
        const basicRestApiStack = new BasicRestApiStack(
            this,
            "BasicRestApiStack",
            {
                env: props.env,
                LAYER_POWERTOOLS: props.commonStack.LAYER_POWERTOOLS,
                LAYER_BOTO: props.commonStack.LAYER_BOTO,
                LAYER_PYDANTIC: props.commonStack.LAYER_PYDANTIC,
                AGENT_KB: props.bedrockKnowledgeBaseStack?.AGENT_KB ?? null,
                KB_DATA_BUCKET: props.bedrockKnowledgeBaseStack?.KB_DATA_BUCKET,
                USER_POOL: props.commonStack.USER_IDENTITY.userPool,
                PREFIX: props.stackNamePrefix
            },
        );
        this.API_URL = basicRestApiStack.API_URL;
        this.STREAMING_FUNCTION_NAME = basicRestApiStack.STREAMING_FUNCTION_NAME;

        // Add NAG suppressions
        NagSuppressions.addStackSuppressions(this, [
            {
                id: "AwsSolutions-IAM4",
                reason: "Using AWS Managed Policies just for the scope of the prototype, these policies need to be created and maintain by the implementer of this solution",
            },
            {
                id: "AwsSolutions-IAM5",
                reason: "Using IAM Policies with wildcard iot action permissions, but with a restricted scope of only that account and region. This is done just for the scope of the prototype, these policies need to be created and maintain by the implementer of this solution",
            },
            {
                id: "AwsSolutions-L1",
                reason: "The non-container Lambda function is not configured to use the latest runtime version. This is due to the use of s3deploy.BucketDeployment, which is not updated to use latest runtime",
            },
        ]);
    }
}