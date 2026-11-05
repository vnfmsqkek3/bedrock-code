import type { HybridResult } from '../types.js';

export interface PromptItem {
  result: HybridResult;
  /** Presigned https URL of this result's page image (undefined if none). */
  image_url?: string;
}

export function buildPrompt(query: string, items: PromptItem[]): string {
  const searchResultsText = items
    .map(({ result: r, image_url }, i) => {
      const imgLine = image_url ? `, page_image_url: ${image_url}` : '';
      return `[${i + 1}] document_id: ${r.document_id}, segment_id: ${r.segment_id}${imgLine}\n${r.content}`;
    })
    .join('\n\n');

  return `You are an assistant that organizes document search results.

<query>
${query}
</query>

<search_results>
${searchResultsText}
</search_results>

Organize the information related to the query based on the search results above.

Rules:
1. Preserve the original document's expressions and content as much as possible. Do not interpret or infer arbitrarily.
2. Exclude search results that are not related to the query.
3. If related information is found from multiple documents, organize them by source.
4. Always specify the source (document_id, segment_id) for each piece of information.
5. If no related information is found, respond with "No related information found."
6. Respond in the same language as the document content.
7. If the query asks to SEE something visual — a location, floor plan (평면도), layout, seat/room/desk position, where something is, a diagram, a map, or says "보여줘 / 사진 / 그림 / show me" — you MUST embed the most relevant result's page image inline as markdown: \`![관련 페이지](page_image_url)\`, using that result's page_image_url value verbatim. Show the REAL page image. Do NOT draw, reconstruct, or approximate the layout as a mermaid diagram, ASCII art, or a table.

Output format:
[Source: document_id=xxx, segment_id=yyy]
(Information based on original content)
![관련 페이지](page_image_url)   ← include this line only when the query is visual (rule 7)`;
}
