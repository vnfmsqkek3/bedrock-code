import { useState, useEffect } from 'react'
import styles from './DocumentManager.module.css'
import { listDocuments, deleteDocument, uploadDocuments } from '../../utils/kbApi'
import UploadDropzone from '../../components/UploadDropzone/UploadDropzone'
import UploadProgress from '../../components/UploadProgress/UploadProgress'
import PipelineTimeline from '../../components/PipelineTimeline/PipelineTimeline'
import DocumentTable from '../../components/DocumentTable/DocumentTable'

/**
 * DocumentManager — 문서 관리 페이지
 *
 * 파일 업로드, 파이프라인 시각화, 문서 목록을 통합 제공합니다.
 *
 * Requirements: 12.5, 12.6, 14.3
 */
const DocumentManager = () => {
  const [documents, setDocuments] = useState([])
  const [staged, setStaged] = useState([]) // [{ name, size, file }]
  const [progress, setProgress] = useState([]) // [{ name, stage, error }]
  const [processing, setProcessing] = useState(false)
  const [currentFile, setCurrentFile] = useState(null)
  const [completed, setCompleted] = useState(0) // 0~4
  const [active, setActive] = useState(-1) // -1~3
  const [showPipe, setShowPipe] = useState(false)
  const [ingestionStatus, setIngestionStatus] = useState(null)
  const [error, setError] = useState(null)

  // ── Fetch documents ────────────────────────────────────────────────────
  const refresh = async () => {
    setError(null)
    try {
      const res = await listDocuments()
      setDocuments(res.documents || [])
      setIngestionStatus(res.ingestionStatus || null)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  // ── Upload pipeline stage callback ─────────────────────────────────────
  const onStage = (stage) => {
    switch (stage) {
      case 'upload':
        setCompleted(0)
        setActive(0)
        break
      case 'analyze':
        setCompleted(1)
        setActive(1)
        break
      case 'metadata':
        setCompleted(2)
        setActive(2)
        break
      case 'vectorize':
        setCompleted(3)
        setActive(3)
        break
      case 'done':
        setCompleted(4)
        setActive(-1)
        break
      default:
        break
    }
  }

  // ── Upload handler ─────────────────────────────────────────────────────
  const handleUpload = async () => {
    if (!staged.length) return
    setProcessing(true)
    setShowPipe(true)
    setError(null)
    setProgress(staged.map((f) => ({ name: f.name, stage: 'pending' })))

    // 문서별 분석은 서로 독립이라 동시에 처리한다. 벡터화만은 데이터소스당 한 번에
    // 하나씩이라 배치 끝에 한 번 돌린다 (kbApi.uploadDocuments가 담당).
    const { failures } = await uploadDocuments(
      staged.map((f) => f.file),
      (index, stage, data) => {
        setProgress((prev) =>
          prev.map((p, idx) => (idx === index ? { ...p, stage, ...(data || {}) } : p)),
        )
        // 파이프라인 타임라인은 한 파일만 보여줄 수 있다. 동시에 여러 개가 도는 동안은
        // 가장 최근에 진행된 파일을 비춘다.
        setCurrentFile(staged[index]?.name || null)
        onStage(stage, data)
      },
    )

    await refresh()
    // 실패한 파일만 남겨 다시 시도할 수 있게 한다.
    const failedNames = failures.map((f) => f.name)
    setStaged(staged.filter((f) => failedNames.includes(f.name)))
    if (failedNames.length) {
      setError(`${failedNames.length}개 파일 처리 실패: ${failedNames.join(', ')}`)
    }
    setProcessing(false)
  }

  // ── Delete handler ─────────────────────────────────────────────────────
  const handleDelete = async (key) => {
    // 벡터 삭제는 Bedrock ingestion 동기화를 거치므로 목록에서 사라진 뒤에도
    // 챗봇 검색 결과에서 빠지기까지 시간이 걸린다. 미리 알려준다.
    if (
      !window.confirm(
        `${key.split('/').pop()}\n\n` +
          '문서가 완전히 삭제되는데 5분 정도 걸립니다. 삭제하시겠습니까?',
      )
    )
      return
    setError(null)
    try {
      await deleteDocument(key)
      await refresh()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.pageTitle}>문서 관리</h1>
          <p className={styles.pageDesc}>
            문서를 올리면 AI가 자동으로 분석·태깅하고, 챗봇이 검색할 수 있도록 벡터로 변환해 저장합니다.
          </p>
        </div>
        <button className={styles.refreshBtn} onClick={refresh} type="button">
          ↻ 새로고침
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {/* Content */}
      <div className={styles.content}>
        <UploadDropzone
          staged={staged}
          onStage={setStaged}
          onUpload={handleUpload}
          processing={processing}
        />

        <UploadProgress items={progress} />

        <div className={styles.grid}>
          <PipelineTimeline
            show={showPipe}
            completed={completed}
            active={active}
            currentFile={currentFile}
          />
          <DocumentTable
            documents={documents}
            ingestionStatus={ingestionStatus}
            onDelete={handleDelete}
          />
        </div>
      </div>
    </div>
  )
}

export default DocumentManager
