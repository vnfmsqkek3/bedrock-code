import { useState, useCallback } from 'react'
import ChatMessages from '../../components/ChatMessages/ChatMessages'
import ChatInput from '../../components/ChatInput/ChatInput'
import CitationPanel from '../../components/CitationPanel/CitationPanel'
import ModelChipDropdown from '../../components/ChipDropdown/ModelChipDropdown'
import PromptChipDropdown from '../../components/ChipDropdown/PromptChipDropdown'
import GuardrailChipDropdown from '../../components/ChipDropdown/GuardrailChipDropdown'
import { streamingFetch } from '../../utils/streamingClient'
import { buildContent } from '../../utils/messageHelpers'
import styles from './ChatView.module.css'

// UUID 생성
const LOCKED_REASON = '대화 중에는 변경할 수 없습니다. 초기화 후 새 대화에서 선택하세요.'

const createId = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const ChatView = () => {
  const [messages, setMessages] = useState([])
  const [citations, setCitations] = useState([])
  const [loading, setLoading] = useState(false)
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState(createId())
  const [modelId, setModelId] = useState(null)
  const [promptTemplate, setPromptTemplate] = useState(null)
  const [guardrailId, setGuardrailId] = useState(null)
  const [activeDropdown, setActiveDropdown] = useState(null) // null | 'model' | 'prompt' | 'guardrail'

  // 대화가 시작되면 모델·프롬프트·가드레일을 잠근다. 한 대화 안에서 이 값이 바뀌면
  // 앞 답변과 뒤 답변이 서로 다른 조건에서 생성돼, 무엇 때문에 답이 달라졌는지 알 수
  // 없게 된다. 바꾸려면 초기화 버튼으로 새 대화를 시작하면 된다.
  const settingsLocked = messages.length > 0

  // 상호 배타 드롭다운 토글
  const handleModelToggle = useCallback(() => {
    setActiveDropdown((prev) => (prev === 'model' ? null : 'model'))
  }, [])

  const handlePromptToggle = useCallback(() => {
    setActiveDropdown((prev) => (prev === 'prompt' ? null : 'prompt'))
  }, [])

  const handleGuardrailToggle = useCallback(() => {
    setActiveDropdown((prev) => (prev === 'guardrail' ? null : 'guardrail'))
  }, [])

  // 메시지 전송 (streaming)
  const sendMessage = async (text) => {
    const question = text !== undefined ? text : input
    if (!question.trim()) return

    setLoading(true)
    setCitations([])
    setInput('')

    const content = await buildContent(question, [])
    setMessages((prev) => [...prev, { role: 'user', content }])

    // 어시스턴트 빈 메시지 (스트리밍 대상)
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ])

    try {
      await streamingFetch(
        { message: question, sessionId, modelId, promptTemplate, guardrailId },
        {
          onStatus: (statusMsg) => {
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (!last._hasText) {
                updated[updated.length - 1] = {
                  ...last,
                  content: [{ type: 'text', text: `⏳ ${statusMsg}` }],
                  _isStatus: true,
                }
              }
              return updated
            })
          },
          onText: (chunk) => {
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              const currentText = last._isStatus ? '' : (last.content?.[0]?.text || '')
              updated[updated.length - 1] = {
                ...last,
                content: [{ type: 'text', text: currentText + chunk }],
                _isStatus: false,
                _hasText: true,
              }
              return updated
            })
          },
          onCitations: (citationsData) => {
            const parsed = citationsData.map((c, i) => ({
              number: c.number ?? i + 1,
              name: c.name || (c.uri || '').split('/').pop() || '문서',
              snippet: c.content || '',
              uri: c.uri || c.location?.s3Location?.uri || '',
              page: c.page ?? null,
              score: typeof c.score === 'number' ? c.score : null,
              metadata: c.metadata || {},
              type: c.type || 'TEXT',
              image: c.image || null,
            }))
            setCitations(parsed)
          },
          onImages: (imagesData) => {
            // Legacy fallback - allImages event (used with old RetrieveAndGenerate)
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              updated[updated.length - 1] = {
                ...last,
                images: imagesData,
              }
              return updated
            })
          },
          onFinalText: (finalText) => {
            // 스트리밍된 본문에는 [N] 인용 마커가 남아 있다. 서버가 마커를 제거한 최종
            // 본문으로 교체한다 — 이미지의 at 오프셋이 이 텍스트를 기준으로 계산돼 있다.
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              updated[updated.length - 1] = {
                ...last,
                content: [{ type: 'text', text: finalText }],
                _isStatus: false,
                _hasText: true,
              }
              return updated
            })
          },
          onInlineImage: (imageData) => {
            // 위치(at)는 서버가 정한다. 스트리밍에서는 이미지 이벤트가 본문을 다 받은 뒤에
            // 오므로 도착 시점으로는 위치를 잴 수 없다.
            setMessages((prev) => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              updated[updated.length - 1] = {
                ...last,
                inlineImages: [...(last.inlineImages || []), imageData],
              }
              return updated
            })
          },
          onDone: (data) => {
            if (data?.sessionId) setSessionId(data.sessionId)
            setLoading(false)
          },
          onError: (errMsg) => {
            setMessages((prev) => {
              const updated = [...prev]
              updated[updated.length - 1] = {
                role: 'assistant',
                content: [{ type: 'text', text: `오류: ${errMsg}` }],
              }
              return updated
            })
            setLoading(false)
          },
        },
      )
    } catch (e) {
      setMessages((prev) => {
        const updated = [...prev]
        updated[updated.length - 1] = {
          role: 'assistant',
          content: [{ type: 'text', text: `오류: ${e.message}` }],
        }
        return updated
      })
      setLoading(false)
    }
  }

  // 초기화
  const resetConversation = () => {
    setMessages([])
    setCitations([])
    setInput('')
    setSessionId(createId())
    setLoading(false)
  }

  // 추천 질문 클릭 시 즉시 전송
  const handleSuggestedQuestion = (question) => {
    setInput(question)
    sendMessage(question)
  }

  return (
    <div className={styles.chatView}>
      <div className={styles.chatColumn}>
        {/* Chat Header */}
        <div className={styles.chatHeader}>
          <span className={styles.chatTitle}>지식 베이스 Q&A 챗봇</span>
          <div className={styles.controls}>
            <ModelChipDropdown
              value={modelId}
              onChange={setModelId}
              isOpen={activeDropdown === 'model'}
              onToggle={handleModelToggle}
              disabled={settingsLocked}
              disabledReason={LOCKED_REASON}
            />
            <PromptChipDropdown
              value={promptTemplate}
              onChange={setPromptTemplate}
              isOpen={activeDropdown === 'prompt'}
              onToggle={handlePromptToggle}
              disabled={settingsLocked}
              disabledReason={LOCKED_REASON}
            />
            <GuardrailChipDropdown
              value={guardrailId}
              onChange={setGuardrailId}
              isOpen={activeDropdown === 'guardrail'}
              onToggle={handleGuardrailToggle}
              disabled={settingsLocked}
              disabledReason={LOCKED_REASON}
            />
            <button
              type="button"
              className={styles.resetBtn}
              onClick={resetConversation}
            >
              초기화
            </button>
          </div>
        </div>

        {/* Messages */}
        <ChatMessages
          messages={messages}
          loading={loading}
          onSuggestedQuestion={handleSuggestedQuestion}
        />

        {/* Input */}
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={() => sendMessage()}
          disabled={loading}
        />
      </div>

      {/* Citation Panel */}
      <CitationPanel citations={citations} />
    </div>
  )
}

export default ChatView
