import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from './clients.js';
import { buildPrompt } from './prompt.js';
import { presignS3Uri } from './presign.js';
import type { HybridResult, SearchAnswer } from '../types.js';

const MODEL_ID =
  process.env.SUMMARIZE_MODEL_ID ??
  'global.anthropic.claude-haiku-4-5-20251001-v1:0';

export async function summarizeWithHaiku(
  query: string,
  results: HybridResult[],
): Promise<SearchAnswer> {
  // Presign each result's page image up front (s3:// → https, local signing) so
  // BOTH the summary prompt (so the image lands in the answer text) and the
  // structured sources use the same URL.
  const items = await Promise.all(
    results.map(async (result) => ({
      result,
      image_url: await presignS3Uri(result.image_uri),
    })),
  );

  const prompt = buildPrompt(query, items);

  const command = new ConverseCommand({
    modelId: MODEL_ID,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: {
      maxTokens: 2048,
    },
  });

  const response = await bedrockClient.send(command);
  const answer = response.output?.message?.content?.[0]?.text ?? '';

  const sources = items.map(({ result: r, image_url }) => ({
    document_id: r.document_id,
    segment_id: r.segment_id,
    qa_id: r.qa_id,
    image_url,
  }));

  return { answer, sources };
}
