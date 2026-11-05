import styles from './UploadProgress.module.css'

/**
 * UploadProgress — 업로드 배치의 파일별 진행 목록
 *
 * 파이프라인 타임라인은 지금 처리 중인 한 파일의 4단계를 보여준다. 여러 파일을
 * 올릴 때는 그것만으로 "어디까지 됐는지"를 알 수 없어, 배치 전체를 파일 단위로
 * 나열한다.
 *
 * Props:
 *   items — [{ name, stage, error }] — stage: pending|upload|analyze|metadata|vectorize|done|error
 */

// 백엔드 파이프라인 단계와 1:1 대응. kbApi.uploadDocuments가 onFileStage로 넘기는 값이다.
// 벡터화는 배치 전체가 한 작업을 공유하므로 여러 파일이 동시에 이 단계에 머문다.
const STAGE_LABEL = {
  pending: '대기 중',
  upload: '업로드 중',
  analyze: 'AI 분석 중',
  metadata: '메타데이터 생성 중',
  vectorize: '벡터 변환 중',
  done: '완료',
  error: '실패',
}

const STAGE_ORDER = ['upload', 'analyze', 'metadata', 'vectorize']

const UploadProgress = ({ items = [] }) => {
  if (!items.length) return null

  const finished = items.filter((i) => i.stage === 'done').length
  const failed = items.filter((i) => i.stage === 'error').length

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <h3 className={styles.title}>파일별 진행</h3>
        <span className={styles.counter}>
          {finished}/{items.length} 완료
          {failed > 0 && <span className={styles.failedCount}> · {failed} 실패</span>}
        </span>
      </div>

      <ul className={styles.list}>
        {items.map((item) => {
          const stepIndex = STAGE_ORDER.indexOf(item.stage)
          // 완료는 4/4, 실패는 멈춘 지점까지만 채운다.
          const filled = item.stage === 'done' ? STAGE_ORDER.length : Math.max(stepIndex, 0)
          return (
            <li key={item.name} className={styles.row}>
              <span className={`${styles.dot} ${styles[`dot_${item.stage}`] || ''}`} />
              <span className={styles.name} title={item.name}>
                {item.name}
              </span>
              <span className={styles.steps} aria-hidden="true">
                {STAGE_ORDER.map((_, i) => (
                  <span
                    key={i}
                    className={`${styles.step} ${i < filled ? styles.stepFilled : ''} ${
                      item.stage === 'error' ? styles.stepFailed : ''
                    }`}
                  />
                ))}
              </span>
              <span
                className={`${styles.stage} ${item.stage === 'error' ? styles.stageError : ''}`}
                title={item.error || undefined}
              >
                {STAGE_LABEL[item.stage] || item.stage}
              </span>
            </li>
          )
        })}
      </ul>

      {failed > 0 && (
        <p className={styles.hint}>
          실패한 파일은 목록에 남습니다. 원인을 확인한 뒤 다시 올려주세요.
        </p>
      )}
    </div>
  )
}

export default UploadProgress
