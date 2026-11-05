import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './CitationPanel.module.css'

const EmptyCitations = () => (
  <div className={styles.emptyState}>
    <span className={styles.emptyIcon}>🔎</span>
    <p className={styles.emptyText}>
      질문하면 검색된
      <br />
      근거 문서가 여기에 표시됩니다.
    </p>
  </div>
)

// Markdown renderer shared by the card preview and the full-content modal.
const Markdown = ({ children }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      a: ({ node, ...props }) => (
        <a {...props} target="_blank" rel="noopener noreferrer" />
      ),
    }}
  >
    {children}
  </ReactMarkdown>
)

const metaTags = (metadata) =>
  Object.entries(metadata || {}).filter(
    ([k, v]) => !k.startsWith('x-amz') && v != null && String(v).length,
  )

// Relevance score (0~1) -> percentage pill. Higher = greener.
const ScorePill = ({ score }) => {
  if (typeof score !== 'number') return null
  const pct = Math.round(score * 100)
  const tone = pct >= 60 ? styles.scoreHigh : pct >= 40 ? styles.scoreMid : styles.scoreLow
  return (
    <span className={`${styles.score} ${tone}`} title="관련도 (정확도)">
      {pct}%
    </span>
  )
}

// 문서에서 추출된 그림 근거. data: URI라 마크다운을 거치지 않고 직접 img로 그린다
// (react-markdown은 기본 정책에서 data: URI를 막는다).
const CitationImage = ({ src, alt, className }) =>
  src ? <img className={className} src={src} alt={alt} loading="lazy" /> : null

const CitationCard = ({ citation, highlight, onOpen }) => {
  const { number, name, snippet, uri, page, score, metadata, image } = citation
  const tags = metaTags(metadata)
  return (
    <button
      type="button"
      className={highlight ? styles.cardHighlight : styles.card}
      onClick={onOpen}
      title="클릭하면 전체 내용을 봅니다"
    >
      <div className={styles.cardTop}>
        <span className={styles.numBadge}>{number}</span>
        <span className={styles.fileName}>
          {name}
          {page != null && <span className={styles.pageTag}>p.{page}</span>}
        </span>
        <ScorePill score={score} />
        <span className={styles.expandHint}>⤢</span>
      </div>
      <CitationImage src={image} alt={`${name} 발췌 이미지`} className={styles.thumb} />
      {snippet && (
        <div className={styles.snippet}>
          <Markdown>{snippet}</Markdown>
        </div>
      )}
      {tags.length > 0 && (
        <div className={styles.tagRow}>
          {tags.map(([k, v]) => (
            <span key={k} className={styles.tag}>
              {k}: {String(v)}
            </span>
          ))}
        </div>
      )}
      {uri && (
        <p className={styles.uri} title={uri}>
          {uri}
        </p>
      )}
    </button>
  )
}

const CitationModal = ({ citation, onClose }) => {
  const tags = metaTags(citation.metadata)
  return (
    <div
      className={styles.modalOverlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={styles.modalCard}>
        <div className={styles.modalHeader}>
          <span className={styles.numBadge}>{citation.number}</span>
          <span className={styles.modalTitle}>
            {citation.name}
            {citation.page != null && (
              <span className={styles.pageTag}>p.{citation.page}</span>
            )}
          </span>
          <ScorePill score={citation.score} />
          <button type="button" className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        {citation.uri && (
          <p className={styles.modalUri} title={citation.uri}>
            {citation.uri}
          </p>
        )}
        {tags.length > 0 && (
          <div className={styles.modalTagRow}>
            {tags.map(([k, v]) => (
              <span key={k} className={styles.tag}>
                {k}: {String(v)}
              </span>
            ))}
          </div>
        )}
        <div className={styles.modalBody}>
          <CitationImage
            src={citation.image}
            alt={`${citation.name} 발췌 이미지`}
            className={styles.modalImage}
          />
          {(citation.snippet || !citation.image) && (
            <Markdown>{citation.snippet || '(내용 없음)'}</Markdown>
          )}
        </div>
      </div>
    </div>
  )
}

const CitationPanel = ({ citations }) => {
  const [active, setActive] = useState(null)
  return (
    <aside className={styles.panel}>
      <div className={styles.panelHeader}>
        <span className={styles.headerTitle}>근거 문서</span>
        <span className={styles.badge}>{citations.length}</span>
      </div>
      <div className={styles.panelList}>
        {citations.length === 0 ? (
          <EmptyCitations />
        ) : (
          citations.map((c, i) => (
            <CitationCard
              key={c.number ?? i}
              citation={c}
              highlight={i === 0}
              onOpen={() => setActive(c)}
            />
          ))
        )}
      </div>
      {active && (
        <CitationModal citation={active} onClose={() => setActive(null)} />
      )}
    </aside>
  )
}

export default CitationPanel
