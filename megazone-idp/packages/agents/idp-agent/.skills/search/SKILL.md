---
name: searching
description: "Search documents and knowledge graph for information. Combines hybrid search, graph traversal, and keyword graph lookup. Use when user asks questions, requests information lookup, needs explanations, summaries, or comparisons from uploaded documents. Any user question requiring information lookup. When in doubt, use this skill."
---

# Search Skill

Do NOT mention internal search strategy or tool selection reasoning to the user. Just search and answer.

## Available Search Methods

You have these search methods. Use your judgment to pick the right combination for each query.

**`search___summarize`**
Hybrid search (vector + keyword) on uploaded documents. Returns matching content with sources.

**`search___graph_traverse`**
Follows entity connections from search results to discover additional related pages. Requires `qa_ids` from `search___summarize` results.

**`search___graph_keyword`**
Finds pages by keyword similarity in the knowledge graph. Useful when a specific concept or term is the focus.

**`search` + `fetch_content`**
Web search via DuckDuckGo. Use only when document search is insufficient. Fetch 3+ URLs. Clearly distinguish document vs. web sources.

## Combinations

**Default for any substantive question about the documents:** run `search___summarize`
first, then ALSO call `search___graph_traverse` with the `qa_ids` it returns, and add
`search___graph_keyword` when a specific concept or term is central. The graph tools
surface related pages and the entity relationships that power the Insights and Graph
views — so for real questions, always follow `summarize` with at least one graph tool.

- `search___summarize` alone — ONLY for a trivial fact lookup or a direct follow-up on
  results already retrieved this conversation. Not for substantive questions.
- `search___summarize` → `search___graph_traverse` — the normal path: answer + related pages
- `search___summarize` + `search___graph_keyword` — when a concept/term is the focus
- `search___summarize` → `search___graph_traverse` + `search___graph_keyword` — maximum coverage
- Any of the above + web search — when documents are not enough

If a graph tool returns no results, that is fine — just answer from the summarize
results; do not retry it. Document search first. Web search last.

## Citations

Use inline citations naturally within the text. For document results, reference the source document and section. For web results, include the URL.

Do not fabricate information or citations that don't exist in search results.
