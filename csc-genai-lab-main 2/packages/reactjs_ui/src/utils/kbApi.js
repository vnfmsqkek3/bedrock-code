/*
* Copyright Amazon.com and its affiliates; all rights reserved.
* SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
* Licensed under the Amazon Software License  https://aws.amazon.com/asl/
*/

import { apiFetch } from "./apiClient"

// List KB documents with metadata + latest ingestion status.
export const listDocuments = () => apiFetch("/kb/documents")

// Delete a document and its metadata sidecar.
export const deleteDocument = (key) =>
    apiFetch(`/kb/documents?key=${encodeURIComponent(key)}`, { method: "DELETE" })

const getIngestionStatus = (jobId) =>
    apiFetch(`/kb/ingestion?jobId=${encodeURIComponent(jobId)}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const startIngestion = () => apiFetch("/kb/ingestion", { method: "POST" })

const waitForIngestion = async (jobId) => {
    if (!jobId) return
    for (let i = 0; i < 60; i++) {
        const { status } = await getIngestionStatus(jobId)
        if (status === "COMPLETE") return
        if (status === "FAILED") throw new Error("Knowledge Base ingestion failed.")
        await sleep(3000)
    }
}

/**
 * Upload several documents at once.
 *
 * The per-document work — presigned PUT, then a background Lambda running the document
 * through Bedrock — is independent, so it runs concurrently. Vectorization is not: the
 * knowledge base indexes a data source with one job at a time, so it happens once for the
 * whole batch, after every document has landed.
 *
 * That final sync is also a correctness fix, not just a speed one. The S3 trigger skips
 * starting a job whenever one is already running, assuming the running job will pick up
 * whatever just arrived — which is false for an object that lands after that job has
 * already enumerated the bucket. Uploading concurrently makes the overlap routine, so the
 * batch asks for one sync at the end and waits for it.
 *
 * onFileStage(index, stage, data) reports each document's progress:
 *   "upload" | "analyze" | "metadata" | "vectorize" | "done" | "error"
 *
 * Returns { results, failures } — one document failing never cancels the others.
 */
export const uploadDocuments = async (files, onFileStage = () => {}, { concurrency = 3 } = {}) => {
    const results = new Array(files.length).fill(null)
    const failures = []
    let next = 0

    const worker = async () => {
        for (;;) {
            const index = next
            next += 1
            if (index >= files.length) return
            try {
                results[index] = await uploadDocument(files[index], (stage, data) =>
                    onFileStage(index, stage, data),
                )
            } catch (e) {
                failures.push({ index, name: files[index].name, error: e.message })
                onFileStage(index, "error", { error: e.message })
            }
        }
    }

    const lanes = Math.max(1, Math.min(concurrency, files.length))
    await Promise.all(Array.from({ length: lanes }, worker))

    const indexed = results.map((r, i) => (r ? i : -1)).filter((i) => i >= 0)
    if (indexed.length) {
        indexed.forEach((i) => onFileStage(i, "vectorize"))
        try {
            const { ingestionJobId } = await startIngestion()
            await waitForIngestion(ingestionJobId)
        } catch (e) {
            // The documents are in the knowledge base bucket either way; only the wait
            // failed. Say so rather than reporting the uploads as failed.
            indexed.forEach((i) => onFileStage(i, "error", { error: `색인 확인 실패: ${e.message}` }))
            return { results, failures }
        }
        indexed.forEach((i) => onFileStage(i, "done", { key: results[i].key }))
    }

    return { results, failures }
}

/**
 * Upload one document: presigned PUT, then the background analysis. Reports
 * "upload" -> "analyze" -> "metadata". Vectorization is left to the caller so a batch can
 * share a single ingestion job.
 */
export const uploadDocument = async (file, onStage = () => {}) => {
    const contentType = file.type || "application/octet-stream"

    // Stage 1 — upload to the staging area via a presigned URL.
    onStage("upload")
    const { uploadUrl, stagingKey, filename } = await apiFetch("/kb/upload-url", {
        method: "POST",
        body: { filename: file.name, contentType },
    })
    const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
    })
    if (!putRes.ok) throw new Error(`S3 upload failed: ${putRes.status}`)

    // Stages 2-3 — Bedrock reads the document, summarizes it, and generates metadata.
    // This runs in a background Lambda invocation (a big PDF takes well over API
    // Gateway's 29 s ceiling), so POST only hands back a taskId and we poll for the result.
    onStage("analyze")
    const { taskId } = await apiFetch("/kb/process", {
        method: "POST",
        body: { stagingKey, filename },
    })
    let processed = null
    for (let i = 0; i < 100 && !processed; i++) {
        await sleep(3000)
        const task = await apiFetch(`/kb/process?taskId=${encodeURIComponent(taskId)}`)
        if (task.status === "DONE") processed = task
        else if (task.status !== "RUNNING")
            throw new Error(task.message || "Document processing failed.")
    }
    if (!processed) throw new Error("Document processing timed out.")

    onStage("metadata", {
        summary: processed.summary,
        metadataAttributes: processed.metadataAttributes,
    })

    return processed
}
