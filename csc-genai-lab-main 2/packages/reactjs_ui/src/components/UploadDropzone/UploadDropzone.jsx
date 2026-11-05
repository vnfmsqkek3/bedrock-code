import React, { useRef } from 'react'
import styles from './UploadDropzone.module.css'

/**
 * UploadDropzone — 파일 업로드 드롭존 + 스테이징 목록 + 업로드 버튼
 *
 * Props:
 *   staged     — [{ name, size, file }] — 스테이징된 파일 목록
 *   onStage    — (files: [{name, size, file}]) => void — 목록 갱신
 *   onUpload   — () => void — 업로드 시작
 *   processing — boolean — 처리 중 여부
 */
const UploadDropzone = ({ staged = [], onStage, onUpload, processing }) => {
  const fileInputRef = useRef(null)

  const handleDropzoneClick = () => {
    if (!processing) {
      fileInputRef.current?.click()
    }
  }

  // 같은 파일을 두 번 담지 않도록 이름+크기로 구분한다. 여러 번 나눠 고르거나
  // 끌어다 놓을 수 있으므로 교체가 아니라 추가한다.
  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || [])
    if (!incoming.length) return
    const key = (f) => `${f.name}:${f.size}`
    const seen = new Set(staged.map(key))
    const added = incoming
      .filter((f) => !seen.has(key(f)))
      .map((f) => ({ name: f.name, size: f.size, file: f }))
    if (added.length) onStage([...staged, ...added])
  }

  const handleFileChange = (e) => {
    addFiles(e.target.files)
    // reset input so the same file can be re-selected
    e.target.value = ''
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (processing) return
    addFiles(e.dataTransfer.files)
  }

  const handleRemove = (index) => {
    onStage(staged.filter((_, i) => i !== index))
  }

  const formatSize = (bytes) => {
    const kb = bytes / 1024
    return `${kb.toFixed(1)} KB`
  }

  const isUploadDisabled = staged.length === 0 || processing

  return (
    <div className={styles.card}>
      <h3 className={styles.title}>문서 올리기</h3>

      <div
        className={styles.dropzone}
        onClick={handleDropzoneClick}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        role="button"
        tabIndex={0}
        aria-label="파일 선택 또는 드래그 앤 드롭"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleDropzoneClick()
          }
        }}
      >
        <div className={styles.iconBox}>
          <span className={styles.uploadIcon}>↥</span>
        </div>
        <p className={styles.dropText}>
          <strong>파일 선택</strong> 하거나 여기로 끌어다 놓으세요 (여러 개 가능)
        </p>
        <span className={styles.formats}>PDF · DOCX · XLSX · CSV · TXT · MD · HTML</span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        onChange={handleFileChange}
        accept=".pdf,.txt,.md,.doc,.docx,.html,.htm,.csv,.xls,.xlsx"
        tabIndex={-1}
      />

      {staged.map((item, index) => (
        <div className={styles.stagedRow} key={`${item.name}:${item.size}`}>
          <span className={styles.fileIcon}>📄</span>
          <span className={styles.fileName} title={item.name}>
            {item.name}
          </span>
          <span className={styles.fileSize}>{formatSize(item.size)}</span>
          <button
            className={styles.removeBtn}
            onClick={() => handleRemove(index)}
            aria-label={`${item.name} 제거`}
            disabled={processing}
            type="button"
          >
            ✕
          </button>
        </div>
      ))}

      <div className={styles.actions}>
        <button
          className={`${styles.uploadBtn} ${isUploadDisabled ? styles.uploadBtnDisabled : styles.uploadBtnPrimary}`}
          onClick={onUpload}
          disabled={isUploadDisabled}
          type="button"
        >
          {processing
            ? '처리 중…'
            : staged.length > 1
              ? `${staged.length}개 업로드 및 처리 시작`
              : '업로드 및 처리 시작'}
        </button>
      </div>
    </div>
  )
}

export default UploadDropzone
