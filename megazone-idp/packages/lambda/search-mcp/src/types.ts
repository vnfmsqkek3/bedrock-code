export interface SearchInput {
  project_id: string;
  query: string;
  document_id?: string;
  limit?: number;
  language?: string;
}

export interface HybridResult {
  workflow_id: string;
  document_id: string;
  segment_id: string;
  qa_id: string;
  segment_index: number;
  qa_index: number;
  question: string;
  content: string;
  keywords: string;
  image_uri?: string | null;
  score: number;
}

export interface SearchAnswer {
  answer: string;
  sources: Array<{
    document_id: string;
    segment_id: string;
    qa_id: string;
    // Presigned https URL of the source page image, so the agent can embed the
    // actual document page (![](image_url)) instead of drawing a diagram.
    image_url?: string;
  }>;
}

export interface OverviewInput {
  project_id: string;
}

export interface DocumentOverview {
  document_id: string;
  language: string;
  document_summary: string;
  total_pages: number;
}

export interface OverviewOutput {
  documents: DocumentOverview[];
}
