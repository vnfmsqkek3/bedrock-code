use aws_sdk_bedrockruntime::Client;
use aws_sdk_bedrockruntime::primitives::Blob;
use serde::{Deserialize, Serialize};
use tracing::info;

// Amazon Titan Text Embeddings V2 (available in us-west-2; 1024-dim, same as the
// previous Nova model so the LanceDB vector schema is unchanged).
const DEFAULT_MODEL_ID: &str = "amazon.titan-embed-text-v2:0";
const EMBEDDING_DIMENSION: usize = 1024;

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    #[serde(rename = "inputText")]
    input_text: &'a str,
    dimensions: usize,
    normalize: bool,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    embedding: Vec<f32>,
}

pub async fn generate_embedding(client: &Client, text: &str) -> Result<Vec<f32>, aws_sdk_bedrockruntime::Error> {
    let value = text.trim();
    if value.is_empty() {
        return Ok(vec![0.0; EMBEDDING_DIMENSION]);
    }

    info!("[generate_embedding] Invoking bedrock embedding, text length: {}", value.len());

    let request = EmbeddingRequest {
        input_text: value,
        dimensions: EMBEDDING_DIMENSION,
        normalize: true,
    };

    let body = serde_json::to_vec(&request).unwrap();
    let response = client
        .invoke_model()
        .model_id(DEFAULT_MODEL_ID)
        .body(Blob::new(body))
        .content_type("application/json")
        .send()
        .await?;

    let result: EmbeddingResponse = serde_json::from_slice(response.body().as_ref()).unwrap();
    let embedding = result.embedding;
    info!("[generate_embedding] Got embedding with {} dimensions", embedding.len());

    Ok(embedding)
}
