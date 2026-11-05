/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import { apiFetch } from "./apiClient"

// Server-side guardrail store (Amazon Bedrock Guardrails), applied to the RAG chat.
export const listGuardrails = () => apiFetch("/guardrails")

// guardrail = { title, filterStrength, deniedTopics, blockedInputMessaging, blockedOutputsMessaging }
export const createGuardrail = (guardrail) =>
    apiFetch("/guardrails", { method: "POST", body: guardrail })

export const updateGuardrail = (guardrailId, guardrail) =>
    apiFetch(`/guardrails/${encodeURIComponent(guardrailId)}`, { method: "PUT", body: guardrail })

export const deleteGuardrail = (guardrailId) =>
    apiFetch(`/guardrails/${encodeURIComponent(guardrailId)}`, { method: "DELETE" })
