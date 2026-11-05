/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import { fetchAuthSession } from "aws-amplify/auth"
import { getRuntimeConfig } from "./runtimeConfig"

// Base invoke URL of the QnA Agent REST API, injected at deploy time via runtime-config.json
// (falls back to VITE_API_URL in local dev). See utils/runtimeConfig.js.
function apiBaseUrl() {
    const cfg = getRuntimeConfig()
    return (cfg?.apiUrl ?? "").replace(/\/$/, "")
}

/**
 * Authenticated fetch against the REST API. Attaches the caller's Cognito ID token
 * so the API Gateway Cognito authorizer accepts the request.
 */
export async function apiFetch(path, { method = "GET", body, headers = {} } = {}) {
    const API_BASE_URL = apiBaseUrl()
    if (!API_BASE_URL) {
        throw new Error("API URL is not configured — runtime-config.json missing and VITE_API_URL unset.")
    }

    const session = await fetchAuthSession()
    // API Gateway Cognito authorizer validates the raw JWT in the Authorization header.
    const idToken = session.tokens?.idToken?.toString()

    const res = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(idToken ? { Authorization: idToken } : {}),
            ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`API ${method} ${path} failed: ${res.status} ${text}`)
    }

    const contentType = res.headers.get("content-type") || ""
    return contentType.includes("application/json") ? res.json() : res.text()
}
