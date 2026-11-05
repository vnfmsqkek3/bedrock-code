import React, { useState } from 'react'
import styles from './DocumentTable.module.css'

const PAGE_SIZE = 4

/**
 * DocumentTable — 저장된 문서 목록을 4열 그리드로 표시합니다.
 * 문서가 4개를 초과하면 페이지네이션을 제공합니다.
 *
 * Props:
 *  - documents: Array<{ key, size, metadataAttributes: {[k]: string} }>
 *  - ingestionStatus: string|null (e.g., "COMPLETE")
 *  - onDelete: (key: string) => void
 */
const DocumentTable = ({ documents = [], ingestionStatus, onDelete }) => {
  const [page, setPage] = useState(0)
  const totalPages = Math.max(1, Math.ceil(documents.length / PAGE_SIZE))
  const pagedDocs = documents.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const formatSize = (bytes) => {
    if (bytes == null) return '—'
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  const extractFilename = (key) => {
    if (!key) return ''
    return key.replace(/^documents\//, '')
  }

  return (
    <div className={styles.card}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>저장된 문서 ({documents.length})</span>
        {ingestionStatus && (
          <span className={styles.badge}>색인: {ingestionStatus}</span>
        )}
      </div>

      {/* Column headers */}
      <div className={styles.columnHeader}>
        <span>문서</span>
        <span>크기</span>
        <span>메타데이터</span>
        <span></span>
      </div>

      {/* Data rows */}
      <div className={styles.body}>
        {documents.length === 0 ? (
          <div className={styles.empty}>아직 문서가 없습니다.</div>
        ) : (
          pagedDocs.map((doc) => (
            <div key={doc.key} className={styles.row}>
              <span className={styles.filename} title={extractFilename(doc.key)}>
                {extractFilename(doc.key)}
              </span>
              <span className={styles.size}>{formatSize(doc.size)}</span>
              <span className={styles.metadata}>
                {doc.metadataAttributes &&
                  Object.entries(doc.metadataAttributes).map(([k, v]) => (
                    <span key={k} className={styles.chip} title={`${k}=${v}`}>
                      {k}={v}
                    </span>
                  ))}
              </span>
              <button
                className={styles.deleteBtn}
                onClick={() => onDelete(doc.key)}
                aria-label={`${extractFilename(doc.key)} 삭제`}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {documents.length > PAGE_SIZE && (
        <div className={styles.pagination}>
          <button
            className={styles.pageBtn}
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            ←
          </button>
          <span className={styles.pageInfo}>
            {page + 1} / {totalPages}
          </span>
          <button
            className={styles.pageBtn}
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            →
          </button>
        </div>
      )}
    </div>
  )
}

export default DocumentTable
