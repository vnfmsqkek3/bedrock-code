/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import * as path from "path";
import { StaticWebsite, StaticWebsiteOrigin } from "@aws/pdk/static-website";
import { Stack, StackProps, CfnOutput, Duration } from "aws-cdk-lib";
import { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

export interface WebsiteStackProps extends StackProps {
  // Injected into runtime-config.json (served at the site root) so the SPA needs
  // no build-time env vars — values are wired at deploy time.
  API_URL: string;
  STREAMING_FUNCTION_NAME: string;
  USER_POOL_ID: string;
  USER_POOL_CLIENT_ID: string;
  IDENTITY_POOL_ID: string;
}

/**
 * Hosts the React SPA on CloudFront + S3 via the PDK StaticWebsite construct, and
 * injects backend configuration (API URL + Cognito ids) as runtime-config.json so
 * the same build works across deployments without editing aws-exports.js.
 *
 * Requires `packages/reactjs_ui/dist` to exist — run `pnpm --filter reactjs_ui vite build`
 * before `cdk synth`/`deploy`.
 */
export class WebsiteStack extends Stack {
  public readonly DISTRIBUTION_DOMAIN: string;

  constructor(scope: Construct, id: string, props: WebsiteStackProps) {
    super(scope, id, props);

    const website = new StaticWebsite(this, "ReactWebsite", {
      websiteContentPath: path.join(__dirname, "..", "..", "..", "reactjs_ui", "dist"),
      // Skip the CloudFront WAF/WebACL that PDK creates by default — not needed for this
      // prototype and it removes the us-east-1 WebACL custom resource from the stack.
      webAclProps: { disable: true },
      runtimeOptions: {
        jsonPayload: {
          region: this.region,
          apiUrl: props.API_URL,
          // streamingClient.js invokes the Lambda by name via InvokeWithResponseStream.
          streamingFunctionName: props.STREAMING_FUNCTION_NAME,
          userPoolId: props.USER_POOL_ID,
          userPoolWebClientId: props.USER_POOL_CLIENT_ID,
          identityPoolId: props.IDENTITY_POOL_ID,
        },
      },
      // SPA deep-link / refresh support. PDK's default only maps 404 -> index.html, but
      // the private S3 origin (OAI, no s3:ListBucket) returns 403 AccessDenied for unknown
      // keys like /knowledgebase. Map BOTH 403 and 404 to index.html so client-side routes
      // resolve. Providing errorResponses replaces PDK's default, so 404 is re-included here.
      // defaultBehavior.origin is a required type field; StaticWebsiteOrigin() is PDK's
      // compiler placeholder — the construct swaps in the real origin at runtime.
      distributionProps: {
        defaultBehavior: { origin: new StaticWebsiteOrigin() },
        errorResponses: [
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: Duration.seconds(10),
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: Duration.seconds(10),
          },
        ],
      },
    });

    // PDK's StaticWebsite hardcodes CloudFront access logging (enableLogging: true) and
    // creates a log bucket for it. CloudFront delivers those logs asynchronously — it keeps
    // dropping objects into the bucket for minutes after the distribution is deleted, which
    // re-fills the bucket right after auto-delete empties it, so stack DELETE fails with
    // "The bucket you tried to delete is not empty". This lab doesn't need CloudFront access
    // logs, so strip the Logging config entirely; the log bucket then stays empty and the
    // stack deploys and destroys cleanly in one pass.
    // ponytail: dropping logging is simpler and more reliable than racing the log delivery.
    const cfnDistribution = website.cloudFrontDistribution.node.defaultChild as CfnDistribution;
    cfnDistribution.addPropertyDeletionOverride("DistributionConfig.Logging");

    this.DISTRIBUTION_DOMAIN = website.cloudFrontDistribution.distributionDomainName;

    new CfnOutput(this, "WebsiteUrl", {
      description: "CloudFront URL of the web app",
      value: `https://${this.DISTRIBUTION_DOMAIN}`,
    });

    // AwsPrototypingChecks nag pack — suppress prototype-scope rules on the PDK StaticWebsite.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsPrototyping-CloudFrontDistributionGeoRestrictions",
        reason: "Geographic restrictions are not required for this prototype web app.",
      },
      {
        id: "AwsPrototyping-IAMNoWildcardPermissions",
        reason: "PDK StaticWebsite deployment role uses wildcards scoped to its own bucket (prototype scope).",
      },
      {
        id: "AwsPrototyping-LambdaLatestVersion",
        reason: "BucketDeployment Lambda runtime is managed by the PDK construct.",
      },
    ]);
  }
}
