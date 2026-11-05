/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import { apiFetch } from "./apiClient"

// Server-side prompt store (persisted per user, applied to the RAG chat).
export const listPrompts = () => apiFetch("/prompts")

// prompt = { title, system, user, assistant } — a Bedrock CHAT prompt.
export const createPrompt = (prompt) =>
    apiFetch("/prompts", { method: "POST", body: prompt })

export const updatePrompt = (promptId, prompt) =>
    apiFetch(`/prompts/${encodeURIComponent(promptId)}`, { method: "PUT", body: prompt })

export const deletePrompt = (promptId) =>
    apiFetch(`/prompts/${encodeURIComponent(promptId)}`, { method: "DELETE" })
