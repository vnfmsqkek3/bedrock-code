/*
 * QnA Streaming Client — invokes the streaming Lambda via AWS SDK
 * InvokeWithResponseStream and delivers chunks in real-time via callbacks.
 */

import { fetchAuthSession } from "aws-amplify/auth"
import { getRuntimeConfig } from "./runtimeConfig"
import { LambdaClient, InvokeWithResponseStreamCommand } from "@aws-sdk/client-lambda"

/**
 * Call the QnA streaming Lambda and deliver events in real-time.
 * 
 * @param {Object} body - { message, sessionId, modelId, promptTemplate, guardrailId }
 * @param {Object} callbacks - { onStatus, onText, onCitations, onImages, onDone, onError }
 */
export async function streamingFetch(body, { onStatus, onText, onFinalText, onCitations, onImages, onInlineImage, onDone, onError }) {
    const cfg = getRuntimeConfig()
    const functionName = cfg?.streamingFunctionName || ""
    const region = cfg?.region || "ap-northeast-2"

    if (!functionName) {
        onError?.("Streaming function name not configured")
        return
    }

    try {
        const session = await fetchAuthSession({ forceRefresh: false })
        const credentials = session.credentials
        if (!credentials) {
            onError?.("Not authenticated")
            return
        }

        const client = new LambdaClient({
            region,
            credentials: {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
                sessionToken: credentials.sessionToken,
                expiration: credentials.expiration,
            },
        })

        // Build Lambda event payload (mimics Function URL / API Gateway event)
        const lambdaEvent = {
            body: JSON.stringify(body),
            isBase64Encoded: false,
            requestContext: { http: { method: "POST" } },
            headers: {},
        }

        const command = new InvokeWithResponseStreamCommand({
            FunctionName: functionName,
            Payload: new TextEncoder().encode(JSON.stringify(lambdaEvent)),
        })

        const response = await client.send(command)

        // Process the streaming EventStream in real-time
        const decoder = new TextDecoder()
        let buffer = ""
        // 스트림이 'done' 없이 끝나는 경우를 잡기 위한 표시. 아래 loop 끝에서 확인한다.
        let reported = false
        const wrappedError = (msg) => { reported = true; onError?.(msg) }
        const wrappedDone = (arg) => { reported = true; onDone?.(arg) }

        for await (const event of response.EventStream) {
            if (event.PayloadChunk) {
                const chunk = decoder.decode(event.PayloadChunk.Payload, { stream: true })
                buffer += chunk

                // Process complete NDJSON lines as they arrive
                const lines = buffer.split("\n")
                buffer = lines.pop() // keep incomplete last line

                for (const line of lines) {
                    processLine(line, { onStatus, onText, onFinalText, onCitations, onImages, onInlineImage, onDone: wrappedDone, onError: wrappedError })
                }
            }
            if (event.InvokeComplete) {
                // Flush remaining buffer
                if (buffer.trim()) {
                    processLine(buffer, { onStatus, onText, onFinalText, onCitations, onImages, onInlineImage, onDone: wrappedDone, onError: wrappedError })
                }
                if (event.InvokeComplete.ErrorCode) {
                    wrappedError(`Lambda error: ${event.InvokeComplete.ErrorCode}`)
                }
            }
        }

        // 여기까지 왔는데 'done'도 오류도 없었다면 스트림이 도중에 끊긴 것이다. 조용히 두면
        // 화면에는 빈 답변만 남고 사용자는 무엇이 잘못됐는지 알 수 없다 — 실측에서 이벤트가
        // 한 개도 오지 않은 회차가 있었고(그 시각 Lambda 호출 기록조차 없다), 화면에는 아무
        // 표시 없이 빈 말풍선으로 끝났다.
        if (!reported) {
            onError?.("응답이 도중에 끊겼습니다. 다시 시도해 주세요.")
        }
    } catch (e) {
        console.error("Streaming error:", e)
        onError?.(`${e.name || "Error"}: ${e.message}`)
    }
}

function processLine(line, { onStatus, onText, onFinalText, onCitations, onImages, onInlineImage, onDone, onError }) {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
        const event = JSON.parse(trimmed)
        switch (event.type) {
            case "status": onStatus?.(event.content); break
            case "text": onText?.(event.content); break
            // 인용 마커가 제거된 최종 본문. 이미지 오프셋(at)이 이 텍스트 기준이라 교체해야 한다.
            case "finalText": onFinalText?.(event.content); break
            case "citations": onCitations?.(event.content); break
            case "images": onImages?.(event.content); break
            case "image": onImages?.([event.content]); break
            case "allImages": onImages?.(event.content); break
            case "inlineImage": onInlineImage?.(event.content); break
            case "done": onDone?.({ sessionId: event.content || event.sessionId }); break
            case "error": onError?.(event.content || event.message); break
        }
    } catch (e) {
        console.warn("NDJSON parse error:", trimmed.substring(0, 200))
    }
}
