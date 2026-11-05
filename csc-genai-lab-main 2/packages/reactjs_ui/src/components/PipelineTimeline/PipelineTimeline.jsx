import React from 'react'
import styles from './PipelineTimeline.module.css'

/**
 * PipelineTimeline — 문서 처리 4단계 세로 타임라인
 *
 * Props:
 *   show       - boolean: true이면 타임라인 표시, false이면 플레이스홀더
 *   completed  - 0~4: 완료된 단계 수
 *   active     - -1~3: 현재 진행 중인 단계 인덱스 (-1 = 없음)
 *   currentFile - string|null: 현재 처리 중인 파일명
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7
 */

const STEPS = [
  { title: '파일 업로드', description: '안전한 저장소(Amazon S3)로 직접 업로드합니다.' },
  { title: 'AI 문서 분석', description: 'Claude 모델이 문서 내용을 읽고 이해합니다.' },
  { title: '메타데이터 자동 생성', description: '주제·유형·키워드를 태그로 자동 추출합니다.' },
  { title: '벡터화 & 저장', description: '청크로 나눠 임베딩 후 OpenSearch에 저장합니다.' },
]

const PipelineTimeline = ({ show, completed, active, currentFile }) => {
  // Placeholder when pipeline is not active (Req 11.6)
  if (!show) {
    return (
      <div className={styles.placeholder}>
        <span className={styles.placeholderIcon}>⚙️</span>
        <span className={styles.placeholderText}>
          문서를 업로드하면 처리 단계가 여기에<br />실시간으로 표시됩니다.
        </span>
      </div>
    )
  }

  // Progress percentage for bar and connector line
  const progressPercent = (completed / 4) * 100

  // Connector gradient: green portion = completed, grey = remaining
  const connectorStyle = {
    background: `linear-gradient(to bottom, #059669 ${progressPercent}%, #e4dfec ${progressPercent}%)`,
  }

  return (
    <div className={styles.card}>
      {/* Header: title + step count */}
      <div className={styles.header}>
        <span className={styles.title}>처리 진행 상황</span>
        <span className={styles.stepCount}>{completed}/4</span>
      </div>

      {/* Filename being processed */}
      {currentFile && (
        <div className={styles.filename}>{currentFile}</div>
      )}

      {/* Progress bar (Req 11.2) */}
      <div className={styles.progressTrack}>
        <div
          className={styles.progressFill}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Vertical timeline (Req 11.1, 11.3, 11.4, 11.5) */}
      <div className={styles.timeline}>
        {/* Connector line */}
        <div className={styles.connector} style={connectorStyle} />

        {STEPS.map((step, index) => {
          const isCompleted = index < completed
          const isActive = index === active

          return (
            <div className={styles.step} key={index}>
              {/* Node */}
              {isCompleted ? (
                <div className={styles.nodeCompleted}>✓</div>
              ) : isActive ? (
                <div className={styles.nodeActive}>
                  <div className={styles.nodeActiveInner} />
                </div>
              ) : (
                <div className={styles.nodePending} />
              )}

              {/* Step content */}
              <div className={styles.stepContent}>
                <div className={styles.stepTitleRow}>
                  <span className={isActive ? styles.stepTitleActive : styles.stepTitle}>
                    {step.title}
                  </span>
                  {isActive && (
                    <span className={styles.badge}>진행 중</span>
                  )}
                </div>
                <span className={styles.stepDescription}>{step.description}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default PipelineTimeline
