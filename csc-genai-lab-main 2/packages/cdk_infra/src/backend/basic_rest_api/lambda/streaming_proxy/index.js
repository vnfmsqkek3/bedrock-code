/**
 * Node.js Lambda streaming handler.
 *
 * Generation runs HERE rather than inside the Python QnA Lambda. Lambda response streaming is
 * only available to Node.js runtimes, so a Python function cannot push tokens outward as they
 * are produced — it can only return a finished answer. Keeping generation there meant the user
 * waited for the whole answer and then watched a replay of it.
 *
 * So the Python Lambda is called twice, around the model call:
 *   prepare  → retrieval, planning, prompt assembly (returns systemPrompt + messages)
 *   <stream> → ConverseStream here; every token goes straight to the browser
 *   finalize → citations and figure placement, computed from the finished text
 *
 * Retrieval and post-processing stay in Python; only the model call moved. The alternative —
 * reimplementing chunk selection, citation numbering and figure matching in JS — would have
 * meant two copies of that logic drifting apart.
 *
 * Protocol (NDJSON):
 *   {"type":"status","content":"..."}
 *   {"type":"text","content":"partial answer text"}
 *   {"type":"inlineImage","content":{page,image,name,at}}
 *   {"type":"citations","content":[...]}
 *   {"type":"done","content":"sessionId"}
 */

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const QNA_FUNCTION_NAME = process.env.QNA_FUNCTION_NAME || '';
const REGION = process.env.AWS_REGION || 'ap-northeast-2';

const lambdaClient = new LambdaClient({ region: REGION });
const bedrockClient = new BedrockRuntimeClient({ region: REGION });

/** Invoke the Python QnA Lambda and return its parsed body. Throws on a non-200. */
async function callQna(request) {
  const result = await lambdaClient.send(new InvokeCommand({
    FunctionName: QNA_FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify({
      body: JSON.stringify(request),
      requestContext: { authorizer: { principalId: 'streaming-proxy' } },
    })),
  }));

  const payload = JSON.parse(Buffer.from(result.Payload).toString());
  const body = JSON.parse(payload.body || '{}');
  if (payload.statusCode !== 200) {
    throw new Error(body.message || `QnA Lambda returned ${payload.statusCode}`);
  }
  return body;
}

exports.handler = awslambda.streamifyResponse(async (event, responseStream, _context) => {
  responseStream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,authorization,x-amz-date,x-amz-security-token,x-amz-content-sha256',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });

  const send = (type, content) => {
    responseStream.write(JSON.stringify({ type, content }) + '\n');
  };

  try {
    let body = event.body || '{}';
    if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf-8');
    const request = JSON.parse(body);

    if (!request.message) {
      send('error', 'Message not provided');
      responseStream.end();
      return;
    }

    send('status', '지식 베이스에서 관련 문서를 검색하고 있습니다...');

    // ── 1. Retrieval + prompt assembly ─────────────────────────────────────
    const prepared = await callQna({ ...request, mode: 'prepare' });

    // Small talk / refusals never reach the model — prepare already answered.
    if (prepared.triage) {
      send('text', prepared.triage);
      send('done', prepared.sessionId || '');
      await new Promise(r => setTimeout(r, 100));
      responseStream.end();
      return;
    }

    // ── 2. Generation, streamed straight through ───────────────────────────
    const converse = {
      modelId: prepared.modelId,
      system: [{ text: prepared.systemPrompt }],
      messages: prepared.messages,
      inferenceConfig: { maxTokens: 4096, temperature: 0.1 },
    };
    if (prepared.guardrail) converse.guardrailConfig = prepared.guardrail;

    const stream = await bedrockClient.send(new ConverseStreamCommand(converse));

    let answer = '';
    for await (const chunk of stream.stream) {
      const delta = chunk.contentBlockDelta?.delta?.text;
      if (delta) {
        answer += delta;
        send('text', delta);
      }
    }

    if (!answer) {
      send('error', '모델이 빈 응답을 반환했습니다.');
      responseStream.end();
      return;
    }

    // ── 3. Citations + figure placement ────────────────────────────────────
    // The answer the client already has is the raw model output; finalize returns the same
    // text with citation markers stripped, so figure offsets are measured against THAT.
    // The client replaces its accumulated text with `message` before applying the offsets.
    const finalized = await callQna({
      ...request,
      mode: 'finalize',
      sessionId: prepared.sessionId,
      stateKey: prepared.stateKey,
      answer,
    });

    send('finalText', finalized.message || answer);

    for (const seg of finalized.segments || []) {
      if (seg.type === 'image' && seg.image) {
        send('inlineImage', { page: seg.page, image: seg.image, name: seg.name, at: seg.at });
      }
    }
    if ((finalized.citations || []).length) {
      send('citations', finalized.citations);
    }

    send('done', finalized.sessionId || prepared.sessionId || '');
    await new Promise(r => setTimeout(r, 100));
  } catch (err) {
    send('error', err.message || 'Unknown error');
  }

  responseStream.end();
});
