import { useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './ChatMessages.module.css'
import aiChatIcon from '../../assets/images/ai_chat_icon.svg'

// 시드 문서(bedrock.pdf = Bedrock 할당량, lambda.pdf = Lambda API 문서) 기반 추천 질문
const SUGGESTED_QUESTIONS = [
  'Amazon Bedrock에는 어떤 할당량(quota)들이 있나요?',
  'AWS Lambda API 요청의 초당 속도 제한을 알려주세요',
  'Bedrock 모델 평가 작업의 제한은 무엇인가요?',
]

const EmptyState = ({ onSuggestedQuestion }) => (
  <div className={styles.emptyState}>
    <img src={aiChatIcon} alt="" className={styles.emptyIcon} />
    <p className={styles.emptyTitle}>무엇이든 물어보세요</p>
    <p className={styles.emptyDesc}>
      지식 베이스 문서를 근거로 답변하고
      <br />
      참고자료를 오른쪽에 함께 보여줍니다.
    </p>
    <div className={styles.chipRow}>
      {SUGGESTED_QUESTIONS.map((q) => (
        <button
          key={q}
          className={styles.chip}
          onClick={() => onSuggestedQuestion(q)}
        >
          {q}
        </button>
      ))}
    </div>
  </div>
)

const UserBubble = ({ content }) => {
  const text = content?.[0]?.text || ''
  return <div className={styles.userBubble}>{text}</div>
}

// Deduplicate by document+page — the same figure can arrive twice with different
// presigned URLs, so the URL is not a usable identity. Falls back to URL when the
// image carries no page.
const dedupeImages = (images) => {
  const seen = new Set()
  const out = []
  for (const img of images || []) {
    if (!img?.image) continue
    const key = img.page != null ? `${img.name}:${img.page}` : img.image
    if (seen.has(key)) continue
    seen.add(key)
    out.push(img)
  }
  return out
}

/**
 * Lay out the answer as text/image/text/image, in the order the backend placed them.
 *
 * The streaming proxy emits an `inlineImage` event at the point in the answer where the
 * figure belongs, so ChatView records how much text had arrived at that moment (`at`) and
 * this splits the accumulated text back apart at those offsets. Cutting at an arbitrary
 * offset would be unsafe, but the backend only emits images between whole markdown blocks
 * (tables and lists are never split), so every cut lands on a block boundary and each piece
 * renders as valid markdown on its own.
 *
 * Images with no `at` (the legacy non-segment path) go after the answer in page order.
 */
const buildContent = (text, images) => {
  const unique = dedupeImages(images)
  const positioned = unique
    .filter((img) => typeof img.at === 'number')
    .sort((a, b) => a.at - b.at)
  const trailing = unique
    .filter((img) => typeof img.at !== 'number')
    .sort((a, b) => (a.page ?? 999) - (b.page ?? 999))

  const result = []
  let cursor = 0
  for (const img of positioned) {
    const chunk = text.slice(cursor, img.at)
    if (chunk.trim()) result.push({ type: 'text', text: chunk })
    result.push({ type: 'image', image: img })
    cursor = Math.max(cursor, img.at)
  }
  const rest = text.slice(cursor)
  if (rest.trim()) result.push({ type: 'text', text: rest })

  for (const img of trailing) {
    result.push({ type: 'image', image: img })
  }

  return result
}

const AssistantBubble = ({ content, showCaret, images, inlineImages }) => {
  const text = content?.[0]?.text || ''

  // Custom RAG streams inlineImage events carrying their position in the answer; the legacy
  // path sends a trailing images array with no position. buildContent handles both.
  const segments = buildContent(text, inlineImages?.length ? inlineImages : images)

  return (
    <div className={styles.assistantRow}>
      <img src={aiChatIcon} alt="" className={styles.avatar} />
      <div className={styles.assistantCard}>
        {/* Nothing has arrived yet.
            One honest line, not a timed narration of stages: the earlier version cycled
            "질문을 분석" → "문서를 검색" → "응답을 생성" on 1/4/8s timers that had no
            connection to what the backend was doing. The server does send a status event,
            but Lambda's response stream holds that first small write in its buffer until
            tokens start flowing, so it arrives too late to show — the client cannot rely
            on it and says only what it actually knows: the request is still open. */}
        {showCaret && !text && (
          <span className={styles.thinkingText}>답변을 준비하고 있습니다…</span>
        )}
        {segments.map((seg, i) =>
          seg.type === 'text' ? (
            <div key={`seg-${i}`} className={styles.markdown}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ node, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer" />
                  ),
                }}
              >
                {seg.text}
              </ReactMarkdown>
            </div>
          ) : (
            <figure key={`img-${seg.image.name}:${seg.image.page ?? i}`} className={styles.inlineFigure}>
              <img src={seg.image.image} alt={`${seg.image.name} 발췌 이미지`} loading="lazy" />
              <figcaption>
                {seg.image.number != null && `[${seg.image.number}] `}
                {seg.image.name}
                {seg.image.page != null && ` p.${seg.image.page}`}
              </figcaption>
            </figure>
          ),
        )}
        {showCaret && <span className={styles.caret} style={{ display: 'none' }} />}
      </div>
    </div>
  )
}

const ChatMessages = ({ messages, loading, onSuggestedQuestion }) => {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, messages[messages.length - 1]?.content?.[0]?.text])

  if (messages.length === 0) {
    return (
      <div className={styles.messageArea}>
        <EmptyState onSuggestedQuestion={onSuggestedQuestion} />
      </div>
    )
  }

  return (
    <div className={styles.messageArea}>
      <div className={styles.messageList}>
        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1
          return msg.role === 'user' ? (
            <UserBubble key={i} content={msg.content} />
          ) : (
            <AssistantBubble
              key={i}
              content={msg.content}
              images={msg.images}
              inlineImages={msg.inlineImages}
              showCaret={loading && isLast && msg.role === 'assistant'}
            />
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

export default ChatMessages
