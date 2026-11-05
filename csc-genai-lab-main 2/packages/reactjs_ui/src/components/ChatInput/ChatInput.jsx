import React from 'react'
import styles from './ChatInput.module.css'

/**
 * ChatInput — 하단 고정 캡슐형 입력창 + 원형 전송 버튼
 *
 * Props:
 *   value    — 현재 입력 텍스트
 *   onChange — 텍스트 변경 콜백 (string)
 *   onSend   — 전송 콜백
 *   disabled — 로딩 중 비활성화 플래그
 */
const ChatInput = ({ value, onChange, onSend, disabled }) => {
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (value.trim()) onSend()
    }
  }

  const isSendDisabled = disabled || !value.trim()

  return (
    <div className={styles.inputWrapper}>
      <div className={styles.inputCapsule}>
        <textarea
          className={styles.textInput}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="무엇이든 물어보세요…"
          disabled={disabled}
          rows={1}
        />
        <button
          className={styles.sendBtn}
          onClick={onSend}
          disabled={isSendDisabled}
          aria-label="전송"
          type="button"
        >
          ↑
        </button>
      </div>
    </div>
  )
}

export default ChatInput
