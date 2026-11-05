/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import awsconfig from "../aws-exports"

// runtime-config.json is written by the WebsiteStack (PDK StaticWebsite) at deploy time
// and served at the site root, so the same build works across deployments. In local dev
// it does not exist — we fall back to aws-exports.js + VITE_API_URL.
let cachedConfig = null

export async function loadRuntimeConfig() {
    if (cachedConfig) return cachedConfig
    try {
        const res = await fetch("/runtime-config.json", { cache: "no-store" })
        if (res.ok) {
            cachedConfig = await res.json()
            return cachedConfig
        }
    } catch {
        // local dev — no runtime-config.json served
    }
    cachedConfig = {
        region: awsconfig.aws_project_region,
        apiUrl: import.meta.env.VITE_API_URL ?? "",
        userPoolId: awsconfig.aws_user_pools_id,
        userPoolWebClientId: awsconfig.aws_user_pools_web_client_id,
        identityPoolId: awsconfig.aws_cognito_identity_pool_id,
    }
    return cachedConfig
}

export function getRuntimeConfig() {
    return cachedConfig
}

// Map runtime config into the Amplify v6 configuration shape.
export function toAmplifyConfig(cfg) {
    return {
        aws_project_region: cfg.region,
        aws_cognito_region: cfg.region,
        aws_cognito_identity_pool_id: cfg.identityPoolId,
        aws_user_pools_id: cfg.userPoolId,
        aws_user_pools_web_client_id: cfg.userPoolWebClientId,
    }
}
