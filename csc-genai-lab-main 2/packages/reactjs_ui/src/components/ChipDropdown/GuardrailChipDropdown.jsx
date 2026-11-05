import { useState, useEffect, useRef } from 'react'
import { listGuardrails } from '../../utils/guardrailApi'
import styles from './ChipDropdown.module.css'

/**
 * GuardrailChipDropdown — 가드레일 선택 칩 드롭다운
 * "GUARD" 모노 라벨 + 선택된 가드레일 이름 + ▾ 형태의 pill 칩으로 현재 적용 중인
 * 가드레일을 표시하고, 클릭 시 저장된 가드레일 목록을 드롭다운으로 보여줍니다.
 *
 * Props:
 *  - value: 현재 선택된 guardrailId (null이면 미적용)
 *  - onChange: 선택 시 콜백 (guardrailId: string|null) => void
 *  - isOpen: 드롭다운 열림 상태 (부모에서 제어, 상호 배타 보장용)
 *  - onToggle: 드롭다운 토글 콜백 () => void
 */
const GuardrailChipDropdown = ({ value, onChange, isOpen, onToggle, disabled = false, disabledReason }) => {
  const [guardrails, setGuardrails] = useState([])
  const wrapperRef = useRef(null)

  // 마운트 시 저장된 가드레일 목록 로드
  useEffect(() => {
    let cancelled = false
    listGuardrails()
      .then((res) => {
        if (!cancelled) setGuardrails(res?.guardrails || [])
      })
      .catch(() => {
        // 로드 실패 시 빈 배열 유지
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

  const getDisplayTitle = () => {
    if (!value) return '가드레일 없음'
    const found = guardrails.find((g) => g.guardrailId === value)
    return found ? found.title : '가드레일 없음'
  }

  const handleSelect = (guardrailId) => {
    onChange(guardrailId)
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
        <span className={styles.monoLabel}>GUARD</span>
        <span className={styles.label}>{getDisplayTitle()}</span>
        <span className={styles.caret}>▾</span>
      </button>

      {isOpen && (
        <div className={styles.menu} role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={!value}
            className={!value ? styles.menuItemActive : styles.menuItem}
            onClick={() => handleSelect(null)}
          >
            가드레일 없음
          </button>
          {guardrails.length === 0 ? (
            <div className={styles.menuEmpty}>저장된 가드레일 없음</div>
          ) : (
            guardrails.map((g) => (
              <button
                key={g.guardrailId}
                type="button"
                role="option"
                aria-selected={g.guardrailId === value}
                className={
                  g.guardrailId === value ? styles.menuItemActive : styles.menuItem
                }
                onClick={() => handleSelect(g.guardrailId)}
              >
                {g.title}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default GuardrailChipDropdown
