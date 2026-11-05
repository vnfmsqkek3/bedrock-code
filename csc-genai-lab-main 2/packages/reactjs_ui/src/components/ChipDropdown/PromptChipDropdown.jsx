import { useState, useEffect, useRef } from 'react'
import { listPrompts } from '../../utils/promptApi'
import styles from './ChipDropdown.module.css'

/**
 * PromptChipDropdown — 프롬프트 선택 칩 드롭다운
 * "PROMPT" 모노 라벨 + 선택된 프롬프트 타이틀(말줄임) + ▾ 형태의 pill 칩으로
 * 현재 선택된 프롬프트를 표시하고, 클릭 시 저장된 프롬프트 목록을 드롭다운으로 보여줍니다.
 *
 * Props:
 *  - value: null이면 기본 답변 형식(내장 시스템 프롬프트), ''이면 프롬프트 없음,
 *           그 외에는 선택된 프롬프트 템플릿 문자열
 *  - onChange: 프롬프트 선택 시 콜백 (template: string|null) => void
 *  - isOpen: 드롭다운 열림 상태 (부모에서 제어, 상호 배타 보장용)
 *  - onToggle: 드롭다운 토글 콜백 () => void
 */
// 내장 시스템 프롬프트를 가리키는 항목의 이름. 배포 시 같은 이름의 프롬프트가
// Bedrock 프롬프트 관리에도 등록되므로, 목록에서 그 항목을 다시 그리면 이름이 같은
// 선택지가 두 개 보인다. 아래 목록에서 이 이름은 건너뛴다.
const BUILT_IN_TITLE = '기본 답변 형식'

const PromptChipDropdown = ({ value, onChange, isOpen, onToggle, disabled = false, disabledReason }) => {
  const [prompts, setPrompts] = useState([])
  const wrapperRef = useRef(null)

  // 마운트 시 저장된 프롬프트 목록 로드
  useEffect(() => {
    let cancelled = false
    listPrompts()
      .then((res) => {
        if (!cancelled) {
          setPrompts((res?.prompts || []).filter((p) => p.title !== BUILT_IN_TITLE))
        }
      })
      .catch(() => {
        // 프롬프트 로드 실패 시 빈 배열 유지
      })
    return () => { cancelled = true }
  }, [])

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

  // 세 가지 상태를 구분한다.
  //   null  — 기본 답변 형식: 백엔드에 내장된 시스템 프롬프트를 적용 (기본 선택)
  //   ''    — 프롬프트 없음: 어떤 템플릿도 적용하지 않고 서비스 기본 동작에 맡김
  //   문자열 — 사용자가 저장한 프롬프트
  const getDisplayTitle = () => {
    if (value === null || value === undefined) return BUILT_IN_TITLE
    if (value === '') return '프롬프트 없음'
    const found = prompts.find((p) => p.template === value)
    return found ? found.title : '사용자 프롬프트'
  }

  const handleSelect = (template) => {
    onChange(template)
    onToggle()
  }

  const isDefault = value === null || value === undefined
  const isNone = value === ''

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
        <span className={styles.monoLabel}>PROMPT</span>
        <span className={styles.label}>{getDisplayTitle()}</span>
        <span className={styles.caret}>▾</span>
      </button>

      {isOpen && (
        <div className={styles.menu} role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={isDefault}
            className={isDefault ? styles.menuItemActive : styles.menuItem}
            onClick={() => handleSelect(null)}
            title="서비스에 내장된 시스템 프롬프트를 적용합니다"
          >
            {BUILT_IN_TITLE}
          </button>
          <button
            type="button"
            role="option"
            aria-selected={isNone}
            className={isNone ? styles.menuItemActive : styles.menuItem}
            onClick={() => handleSelect('')}
            title="어떤 프롬프트도 적용하지 않습니다"
          >
            프롬프트 없음
          </button>
          {prompts.length === 0 ? (
            <div className={styles.menuEmpty}>프롬프트 로딩 중…</div>
          ) : (
            <>
              {prompts.map((p) => (
                <button
                  key={p.promptId}
                  type="button"
                  role="option"
                  aria-selected={p.template === value}
                  className={
                    p.template === value
                      ? styles.menuItemActive
                      : styles.menuItem
                  }
                  onClick={() => handleSelect(p.template)}
                >
                  {p.title}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default PromptChipDropdown
