import contextlib
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.authz import require_project_owner
from app.config import get_config
from app.ddb import (
    Document,
    DocumentData,
    Project,
    delete_document_item,
    get_document_item,
    mark_project_updated,
    put_document_item,
    query_documents,
    update_document_data,
)
from app.ddb.workflows import delete_workflow_item, get_steps_batch, query_workflows
from app.lancedb import (
    DeleteByWorkflowInput,
    DeleteGraphKeywordsByProjectIdInput,
    DropTableInput,
    HybridSearchInput,
    LanceDbError,
    ScoredSegment,
)
from app.lancedb import delete_by_workflow as lancedb_delete_by_workflow
from app.lancedb import delete_graph_keywords_by_project_id as lancedb_delete_graph_keywords
from app.lancedb import drop_table as lancedb_drop_table
from app.lancedb import hybrid_search as lancedb_hybrid_search
from app.s3 import delete_s3_prefix, get_s3_client

router = APIRouter(prefix="/projects/{project_id}/documents", tags=["documents"])


class DocumentUploadRequest(BaseModel):
    file_name: str
    content_type: str
    file_size: int
    use_bda: bool = False
    use_ocr: bool | None = None
    ocr_model: str | None = None
    ocr_options: dict[str, object] | None = None
    document_prompt: str | None = None
    language: str | None = None
    source_url: str | None = None
    crawl_instruction: str | None = None
    # megazone-idp: relative folder path captured from folder upload (webkitRelativePath)
    folder_path: str | None = None


class DocumentUploadResponse(BaseModel):
    document_id: str
    upload_url: str
    file_name: str


class DocumentResponse(BaseModel):
    document_id: str
    project_id: str
    name: str
    file_type: str
    file_size: int
    status: str
    s3_key: str
    use_bda: bool
    use_ocr: bool | None = None
    ocr_model: str | None = None
    ocr_options: dict[str, object] | None = None
    document_prompt: str | None = None
    language: str | None = None
    source_url: str | None = None
    crawl_instruction: str | None = None
    folder_path: str | None = None
    category_path: str | None = None
    created_at: str
    updated_at: str

    @staticmethod
    def from_document(doc: Document) -> "DocumentResponse":
        return DocumentResponse(
            document_id=doc.data.document_id,
            project_id=doc.data.project_id,
            name=doc.data.name,
            file_type=doc.data.file_type,
            file_size=doc.data.file_size,
            status=doc.data.status,
            s3_key=doc.data.s3_key,
            use_bda=doc.data.use_bda,
            use_ocr=doc.data.use_ocr,
            ocr_model=doc.data.ocr_model,
            ocr_options=doc.data.ocr_options,
            document_prompt=doc.data.document_prompt,
            language=doc.data.language,
            source_url=doc.data.source_url,
            crawl_instruction=doc.data.crawl_instruction,
            folder_path=doc.data.folder_path,
            category_path=doc.data.category_path,
            created_at=doc.created_at,
            updated_at=doc.updated_at,
        )


class DocumentStatusUpdate(BaseModel):
    status: str


class DeletedDocumentInfo(BaseModel):
    document_id: str
    workflow_id: str | None = None
    lancedb_deleted: bool = False
    lancedb_error: str | None = None
    graph_delete_queued: bool = False
    graph_error: str | None = None
    workflow_deleted: bool = False
    # Set when this was the last document: whole-project index tables are dropped.
    project_emptied: bool = False


class DeleteDocumentResponse(BaseModel):
    message: str
    details: DeletedDocumentInfo


class StepProgress(BaseModel):
    status: str
    label: str
    error: str | None = None
    qa_regen: dict | None = None


class DocumentProgress(BaseModel):
    document_id: str
    workflow_id: str
    status: str
    current_step: str
    steps: dict[str, StepProgress]


@router.get("/progress")
def get_documents_progress(
    project_id: str, _project: Project = Depends(require_project_owner)
) -> list[DocumentProgress]:
    """Get workflow step progress for all documents (including completed)."""
    documents = query_documents(project_id)
    active_docs = [doc for doc in documents if doc.data.status != "deleted"]

    if not active_docs:
        return []

    # Collect workflow_ids for each document
    doc_workflow_map: dict[str, tuple[str, str]] = {}  # workflow_id -> (document_id, wf_status)
    for doc in active_docs:
        workflows = query_workflows(doc.data.document_id)
        if workflows:
            wf = workflows[0]
            wf_id = wf.SK.replace("WF#", "")
            doc_workflow_map[wf_id] = (doc.data.document_id, wf.data.status)

    if not doc_workflow_map:
        return []

    # Batch-get all STEP records
    steps_by_wf = get_steps_batch(list(doc_workflow_map.keys()))

    results: list[DocumentProgress] = []
    for wf_id, (document_id, wf_status) in doc_workflow_map.items():
        steps_data = steps_by_wf.get(wf_id, {})
        current_step = steps_data.get("current_step", "")

        steps: dict[str, StepProgress] = {}
        for key, value in steps_data.items():
            if isinstance(value, dict) and "status" in value and "label" in value:
                step = StepProgress(status=value["status"], label=value["label"])
                if "error" in value:
                    step.error = value["error"]
                if "qa_regen" in value:
                    step.qa_regen = value["qa_regen"]
                steps[key] = step

        results.append(
            DocumentProgress(
                document_id=document_id,
                workflow_id=wf_id,
                status=wf_status,
                current_step=current_step,
                steps=steps,
            )
        )

    return results


@router.get("")
def list_documents(
    project_id: str, _project: Project = Depends(require_project_owner)
) -> list[DocumentResponse]:
    """List all documents for a project."""
    documents = query_documents(project_id)
    return [DocumentResponse.from_document(doc) for doc in documents]


@router.post("")
def create_document_upload(
    project_id: str,
    request: DocumentUploadRequest,
    _project: Project = Depends(require_project_owner),
) -> DocumentUploadResponse:
    """Create a document record and return a presigned URL for upload."""
    config = get_config()
    s3 = get_s3_client()

    # Validate file size (500MB max)
    max_size = 500 * 1024 * 1024  # 500MB
    if request.file_size > max_size:
        raise HTTPException(status_code=400, detail="File size exceeds 500MB limit")

    # Generate document ID and S3 key
    document_id = str(uuid.uuid4())
    # Use document_id as filename for S3 (original name stored in DynamoDB)
    ext = request.file_name.rsplit(".", 1)[-1] if "." in request.file_name else ""
    s3_key = f"projects/{project_id}/documents/{document_id}/{document_id}.{ext}"

    # Create document record in DynamoDB
    data = DocumentData(
        document_id=document_id,
        project_id=project_id,
        name=request.file_name,
        file_type=request.content_type,
        file_size=request.file_size,
        status="uploading",
        s3_key=s3_key,
        use_bda=request.use_bda,
        use_ocr=request.use_ocr if request.use_ocr is not None else True,
        ocr_model=request.ocr_model or "pp-ocrv5",
        ocr_options=request.ocr_options,
        document_prompt=request.document_prompt,
        language=request.language,
        source_url=request.source_url,
        crawl_instruction=request.crawl_instruction,
        folder_path=request.folder_path,
    )
    put_document_item(project_id, document_id, data)

    # Generate presigned URL for upload (valid for 1 hour)
    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": config.document_storage_bucket_name,
            "Key": s3_key,
            "ContentType": request.content_type,
        },
        ExpiresIn=3600,
    )

    return DocumentUploadResponse(
        document_id=document_id,
        upload_url=upload_url,
        file_name=request.file_name,
    )


@router.put("/{document_id}/status")
def update_document_status(
    project_id: str,
    document_id: str,
    request: DocumentStatusUpdate,
    _project: Project = Depends(require_project_owner),
) -> DocumentResponse:
    """Update document status after upload completion."""
    existing = get_document_item(project_id, document_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Document not found")

    data = existing.data.model_copy()
    data.status = request.status

    update_document_data(project_id, document_id, data)

    # Update project's updated_at for sorting by recent activity
    mark_project_updated(project_id)

    # Get updated document
    doc = get_document_item(project_id, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return DocumentResponse.from_document(doc)


class DocumentSearchHit(BaseModel):
    document_id: str
    name: str
    segment_index: int
    page: int
    score: float
    snippet: str


@router.get("/search")
def search_documents(
    project_id: str,
    q: str,
    _project: Project = Depends(require_project_owner),
) -> list[DocumentSearchHit]:
    """Keyword/content search over a project's indexed document chunks (LanceDB
    hybrid FTS + vector). Returns EVERY matching segment (one per page/segment),
    so all occurrences across a document are shown — not just the top one."""
    q = q.strip()
    if not q:
        return []
    try:
        out = lancedb_hybrid_search(
            HybridSearchInput(
                project_id=project_id,
                query=q,
                limit=50,
                language=_project.data.language,
            )
        )
    except LanceDbError:
        # Project not indexed yet / search backend unavailable → no content hits.
        return []
    docs = {d.data.document_id: d for d in query_documents(project_id)}
    # Keep the best-scoring row per (document, segment) — a segment can produce
    # several LanceDB rows (multiple QA chunks), but it's one page to the user.
    best: dict[tuple[str, int], ScoredSegment] = {}
    for seg in out.results:
        if seg.document_id not in docs:
            continue
        key = (seg.document_id, seg.segment_index)
        cur = best.get(key)
        if cur is None or seg.score > cur.score:
            best[key] = seg
    hits = [
        DocumentSearchHit(
            document_id=seg.document_id,
            name=docs[seg.document_id].data.name,
            segment_index=seg.segment_index,
            page=seg.segment_index + 1,
            score=seg.score,
            # Full matched content (the frontend renders it as markdown + highlight).
            snippet=seg.content,
        )
        for seg in best.values()
    ]
    hits.sort(key=lambda h: h.score, reverse=True)
    return hits


@router.get("/{document_id}")
def get_document(
    project_id: str, document_id: str, _project: Project = Depends(require_project_owner)
) -> DocumentResponse:
    """Get a single document."""
    doc = get_document_item(project_id, document_id)

    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    return DocumentResponse.from_document(doc)


@router.delete("/{document_id}")
def delete_document(
    project_id: str, document_id: str, _project: Project = Depends(require_project_owner)
) -> DeleteDocumentResponse:
    """Delete a document and all related data (DynamoDB, S3, LanceDB)."""
    config = get_config()
    s3 = get_s3_client()

    # Check document exists and get info
    doc = get_document_item(project_id, document_id)

    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    s3_key = doc.data.s3_key

    # Find related workflow for this document
    workflow_id = None
    workflows = query_workflows(document_id)
    if workflows:
        wf = workflows[0]
        workflow_id = wf.SK.replace("WF#", "")

    deleted_info = DeletedDocumentInfo(document_id=document_id, workflow_id=workflow_id)

    # 1. Delete from LanceDB via Lambda. Do this FIRST and abort the whole delete
    #    if it never succeeds — a swallowed failure here leaves the search index
    #    referencing a document that's gone from DDB/S3 (chatbot keeps citing it).
    if workflow_id and config.lancedb_function_name:
        last_error: LanceDbError | None = None
        for attempt in range(3):
            try:
                lancedb_delete_by_workflow(DeleteByWorkflowInput(project_id=project_id, workflow_id=workflow_id))
                deleted_info.lancedb_deleted = True
                last_error = None
                break
            except LanceDbError as e:
                last_error = e
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
        if last_error is not None:
            deleted_info.lancedb_error = str(last_error)
            raise HTTPException(
                status_code=502,
                detail=f"Failed to clear search index for document {document_id}; delete aborted. {last_error}",
            )

    # 1b. Queue graph deletion via SQS (async, handles large documents)
    if workflow_id and config.graph_delete_queue_url:
        try:
            import json

            import boto3

            sqs_client = boto3.client("sqs", region_name=config.aws_region)
            sqs_client.send_message(
                QueueUrl=config.graph_delete_queue_url,
                MessageBody=json.dumps(
                    {
                        "project_id": project_id,
                        "workflow_id": workflow_id,
                        "phase": "analyses",
                        "batch_size": 500,
                    }
                ),
            )
            deleted_info.graph_delete_queued = True
        except Exception as e:
            deleted_info.graph_error = str(e)

    # 2. Delete from S3 - document file
    if s3_key:
        with contextlib.suppress(Exception):
            s3.delete_object(Bucket=config.document_storage_bucket_name, Key=s3_key)

    # 3. Delete from S3 - entire document folder
    doc_prefix = f"projects/{project_id}/documents/{document_id}/"
    with contextlib.suppress(Exception):
        delete_s3_prefix(config.document_storage_bucket_name, doc_prefix)

    # 4. Delete workflow data from DynamoDB
    if workflow_id:
        with contextlib.suppress(Exception):
            delete_workflow_item(document_id, workflow_id)
            deleted_info.workflow_deleted = True

    # 5. Delete document item from DynamoDB
    delete_document_item(project_id, document_id)

    # 6. If this was the last document, drop the whole-project index tables.
    #    graph_keywords has no per-document key (only project_id), so it can't be
    #    pruned per-document — clearing it is only safe once the project is empty.
    if config.lancedb_function_name and not query_documents(project_id):
        # Best-effort opportunistic cleanup — must not fail the (already done) delete.
        with contextlib.suppress(Exception):
            lancedb_drop_table(DropTableInput(project_id=project_id))
            lancedb_delete_graph_keywords(DeleteGraphKeywordsByProjectIdInput(project_id=project_id))
            deleted_info.project_emptied = True

    return DeleteDocumentResponse(message=f"Document {document_id} deleted", details=deleted_info)
