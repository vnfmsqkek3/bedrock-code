import { invokeLanceDB } from '../lib/clients.js';
import { summarizeWithHaiku } from '../lib/summarize.js';
import { rerankResults } from '../lib/rerank.js';
import type { SearchInput, HybridResult, SearchAnswer } from '../types.js';

// Over-fetch a larger candidate pool from hybrid search, then let the
// cross-encoder reranker (Cohere Rerank v3.5 via Bedrock) pick the most
// relevant `limit` before summarizing. Hybrid search alone ranks by bi-encoder
// similarity, so a wrong-but-semantically-similar doc (e.g. another building's
// identical manual) can outrank the right one; the reranker re-scores each
// candidate against the FULL query and fixes that.
const CANDIDATE_POOL = 50;

export const handler = async (event: SearchInput): Promise<SearchAnswer> => {
  const { project_id, query, document_id, limit = 10, language } = event;

  const poolSize = Math.max(limit * 5, CANDIDATE_POOL);
  const result = await invokeLanceDB('hybrid_search', {
    project_id,
    query,
    limit: poolSize,
    document_id,
    language,
  });

  const results = (result.results ?? []) as HybridResult[];

  if (results.length === 0) {
    return {
      answer: '관련 정보를 찾을 수 없습니다.',
      sources: [],
    };
  }

  // Rerank the pool down to `limit`. On any rerank error, fall back to the
  // hybrid order so search never hard-fails on a reranker hiccup.
  let topResults: HybridResult[];
  try {
    topResults = await rerankResults(query, results, limit);
  } catch (err) {
    console.error('[summarize] rerank failed, using hybrid order:', err);
    topResults = results.slice(0, limit);
  }

  return summarizeWithHaiku(query, topResults);
};
