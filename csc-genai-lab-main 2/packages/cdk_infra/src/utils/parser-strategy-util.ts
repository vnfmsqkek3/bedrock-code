/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import { bedrock } from "@cdklabs/generative-ai-cdk-constructs";
import { CfnDataSource } from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * Valid parser strategy codes
 */
export const VALID_PARSER_STRATEGIES = ['DEFAULT', 'FOUNDATION_MODEL', 'DATA_AUTOMATION'] as const;

/**
 * Parser strategy code type
 */
export type ParserStrategyCode = typeof VALID_PARSER_STRATEGIES[number];

/**
 * Parser strategy utility
 */
export class ParserStrategyUtil {
  /**
   * Validate if parser strategy code is valid
   */
  static isValid(code: string): code is ParserStrategyCode {
    return VALID_PARSER_STRATEGIES.includes(code as ParserStrategyCode);
  }

  /**
   * Create parsing strategy object based on parser strategy code.
   *
   * `foundationModelId` — the inference-profile id to use for the FOUNDATION_MODEL
   * parser. Callers should resolve it against the deploy region first (e.g. via
   * scripts/deploy/resolve_bedrock_models.py) so a region without the pinned version
   * still gets a working profile of the same tier.
   */
  static createStrategy(
    code: ParserStrategyCode,
    region: string,
    account: string,
    foundationModelId: string = 'global.anthropic.claude-sonnet-4-6',
  ): bedrock.ParsingStategy | undefined {
    switch (code) {
      case 'FOUNDATION_MODEL': {
        const ipArn = `arn:aws:bedrock:${region}:${account}:inference-profile/${foundationModelId}`;
        // Strip the geo prefix (global./us./apac./eu.) to reconstruct the underlying
        // foundation-model ARN — the parser role needs BOTH the inference-profile
        // resource (to invoke it) and the underlying foundation model (the profile
        // delegates the actual generation to it).
        const baseModelName = foundationModelId.replace(/^(global|us|apac|eu)\./, '');
        const fmArn = `arn:aws:bedrock:*::foundation-model/${baseModelName}`;
        class ConfigurableFoundationModelParsing extends bedrock.ParsingStategy {
          public readonly configuration: CfnDataSource.ParsingConfigurationProperty = {
            parsingStrategy: "BEDROCK_FOUNDATION_MODEL",
            bedrockFoundationModelConfiguration: {
              modelArn: ipArn,
              // MULTIMODAL extracts figures/tables as actual images into the knowledge
              // base's supplemental storage, so retrieval can return them as IMAGE
              // content. Without it the parser only writes a prose description of each
              // figure into the text and the image itself is lost — which is a poor
              // trade for documents whose substance lives in diagrams and tables.
              parsingModality: "MULTIMODAL",
              // No parsingPrompt on purpose. A custom prompt REPLACES the service
              // default, and the default already classifies each element correctly: a
              // table printed on the page is transcribed at page level (step 5), while a
              // picture is wrapped in <figure> (step 4) and extracted as an image.
              //
              // Earlier revisions here stressed wrapping pictures in <figure>, which made
              // the model reclassify pages whose table sits beside a diagram as one big
              // figure. MULTIMODAL then lifted that figure out as an image and the table
              // left with it — the rows became unsearchable. Verified by running both
              // prompts against the same document: the default emits the table as page
              // text with no <figure> at all; the custom one wraps the page in a figure.
              // Leave this out unless a document type is measurably parsed better with it.
            },
          };
          public generatePolicyStatements(): iam.PolicyStatement[] {
            return [ new iam.PolicyStatement({
              actions: ["bedrock:InvokeModel", "bedrock:GetInferenceProfile"],
              resources: [ ipArn, fmArn ],
            }) ];
          }
        }
        return new ConfigurableFoundationModelParsing();
      }

      // NOTE: Bedrock Data Automation is not offered in every Region — ap-northeast-2 is
      // one that lacks it, where the API answers AccessDenied even for a principal holding
      // the actions. Check regional availability before selecting this strategy.
      case 'DATA_AUTOMATION': {
        // Amazon Bedrock Data Automation (BDA) as parser — the console's managed
        // multimodal parser that OCRs image-based PDFs (e.g. Notion exports). The
        // construct (0.1.293) ships no dataAutomation() factory, so build the strategy
        // by extending the abstract ParsingStategy class directly.
        class DataAutomationParsing extends bedrock.ParsingStategy {
          public readonly configuration: CfnDataSource.ParsingConfigurationProperty = {
            parsingStrategy: "BEDROCK_DATA_AUTOMATION",
            bedrockDataAutomationConfiguration: { parsingModality: "MULTIMODAL" },
          };
          public generatePolicyStatements(): iam.PolicyStatement[] {
            // The KB service role must be able to invoke BDA during ingestion.
            return [
              new iam.PolicyStatement({
                actions: [
                  "bedrock:InvokeDataAutomationAsync",
                  "bedrock:GetDataAutomationStatus",
                ],
                resources: ["*"],
              }),
            ];
          }
        }
        return new DataAutomationParsing();
      }
        
      case 'DEFAULT':
      default:
        return undefined;
    }
  }
} 