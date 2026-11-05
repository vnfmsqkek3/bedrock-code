import { useEffect, useRef } from 'react'
import styles from './ChipDropdown.module.css'

// 답변 생성에 쓰는 모델. 한 가지로 고정한다.
//
// 답변 지침이 길어서 작은 모델은 끝까지 따라오지 못하고, 그때 서비스가 답변 대신 자기
// 거절 문구로 대체한다. 같은 질문이 한 번은 되고 한 번은 안 되는 형태로 나타나
// 사용자에게는 앱이 고장난 것으로 보인다. 실측: 한 질문에서 Haiku 4.5는 지침을 주면
// 6번 중 3번 거절했고 Sonnet 4.6은 0번이었다.
const MODELS = [
  { modelId: 'global.anthropic.claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6' },
  { modelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', modelName: 'Claude Sonnet 4.5' },
  { modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', modelName: 'Claude Haiku 4.5' },
]

/**
 * ModelChipDropdown — 모델 선택 칩 드롭다운
 * 보라 점 + 모델명 + ▾ 형태의 pill 칩으로 현재 선택된 모델을 표시하고,
 * 클릭 시 사용 가능한 모델 목록(getFMs 결과)을 드롭다운으로 보여줍니다.
 *
 * Props:
 *  - value: 현재 선택된 modelId (string)
 *  - onChange: 모델 선택 시 콜백 (modelId: string) => void
 *  - isOpen: 드롭다운 열림 상태 (부모에서 제어, 상호 배타 보장용)
 *  - onToggle: 드롭다운 토글 콜백 () => void
 */
const ModelChipDropdown = ({ value, onChange, isOpen, onToggle, disabled = false, disabledReason }) => {
  const models = MODELS
  const wrapperRef = useRef(null)

  // 선택값이 없으면 첫 모델을 기본 선택
  useEffect(() => {
    if (!value) onChange(MODELS[0].modelId)
  }, [value, onChange])

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (isOpen && wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        onToggle()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, onToggle])

  // 선택된 모델의 이름을 찾아 표시
  const getDisplayName = () => {
    if (!value || models.length === 0) return '모델 선택…'
    const found = models.find((m) => m.modelId === value)
    return found ? found.modelName : '모델 선택…'
  }

  const handleSelect = (modelId) => {
    onChange(modelId)
    onToggle()
  }

  return (
    <div className={styles.chipWrapper} ref={wrapperRef}>
      <button
        type="button"
        className={disabled ? `${styles.chip} ${styles.chipDisabled}` : styles.chip}
        onClick={onToggle}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={styles.dot} />
        <span className={styles.label}>{getDisplayName()}</span>
        <span className={styles.caret}>▾</span>
      </button>

      {isOpen && (
        <div className={styles.menu} role="listbox">
          {models.length === 0 ? (
            <div className={styles.menuEmpty}>모델 로딩 중…</div>
          ) : (
            models.map((m) => (
              <button
                key={m.modelId}
                type="button"
                role="option"
                aria-selected={m.modelId === value}
                className={
                  m.modelId === value
                    ? styles.menuItemActive
                    : styles.menuItem
                }
                onClick={() => handleSelect(m.modelId)}
              >
                {m.modelName}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default ModelChipDropdown
