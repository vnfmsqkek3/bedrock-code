/*
 * Copyright Amazon.com and its affiliates; all rights reserved.
 * SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 * Licensed under the Amazon Software License  https://aws.amazon.com/asl/
 */

import { useState, useEffect, useCallback } from 'react'
import {
  listGuardrails,
  createGuardrail,
  updateGuardrail,
  deleteGuardrail,
} from '../../utils/guardrailApi'
// Reuse the System Prompts settings styling for a consistent settings look.
import styles from '../SystemPrompts/SystemPrompts.module.css'
import guardrailStyles from './Guardrails.module.css'

// ─── 설명 패널 콘텐츠 ─────────────────────────────────────────────────────────
const HELP_CONTENT = {
  deniedTopics: {
    title: '거부 주제 (Denied Topics)',
    description:
      '특정 주제에 대한 응답을 차단합니다. 주제 이름과 정의를 입력하면, 모델이 해당 주제를 감지할 경우 차단 메시지를 반환합니다.',
    examples: [
      { name: '투자 조언', definition: '주식, 코인, 부동산 등 특정 자산에 투자하라고 권유하는 내용' },
      { name: '정치 의견', definition: '특정 정당이나 정치인을 지지·비판하는 의견' },
      { name: '의료 진단', definition: '특정 질병 진단이나 처방을 내리는 의료 행위' },
    ],
  },
  wordFilters: {
    title: '단어 필터 (Word Filters)',
    description:
      '입력 또는 출력에 포함된 특정 단어·문구를 차단합니다. 정확히 일치하는 단어가 감지되면 즉시 차단됩니다. 비속어, 경쟁사명, 내부 용어 유출 방지 등에 활용할 수 있습니다.',
    examples: [
      { word: '비속어 예시' },
      { word: '경쟁사 A 제품명' },
      { word: '내부 프로젝트 코드네임' },
    ],
  },
  piiEntities: {
    title: '개인정보 (PII) 처리',
    description:
      '입출력에 포함된 개인 식별 정보(PII)를 마스킹하거나 차단합니다. 유형별로 마스킹({PHONE} 등으로 대체) 또는 완전 차단을 선택할 수 있습니다.',
    examples: [
      { type: '전화번호', action: '마스킹', result: '010-1234-5678 → {PHONE}' },
      { type: '이메일', action: '마스킹', result: 'user@example.com → {EMAIL}' },
      { type: '카드번호', action: '차단', result: '카드번호 포함 시 응답 거부' },
    ],
  },
}

// Bedrock 관리형 PII 유형
const PII_TYPES = [
  { value: 'PHONE', label: '전화번호' },
  { value: 'EMAIL', label: '이메일' },
  { value: 'NAME', label: '이름' },
  { value: 'ADDRESS', label: '주소' },
  { value: 'AGE', label: '나이' },
  { value: 'USERNAME', label: '사용자명' },
  { value: 'PASSWORD', label: '비밀번호' },
  { value: 'CREDIT_DEBIT_CARD_NUMBER', label: '카드번호' },
  { value: 'US_SOCIAL_SECURITY_NUMBER', label: '주민/SSN' },
  { value: 'IP_ADDRESS', label: 'IP 주소' },
  { value: 'URL', label: 'URL' },
]
const PII_ACTIONS = [
  { value: 'ANONYMIZE', label: '마스킹' },
  { value: 'BLOCK', label: '차단' },
]
const piiLabel = (type) => (PII_TYPES.find((t) => t.value === type)?.label || type)

const emptyForm = {
  title: '',
  deniedTopics: [],
  wordFilters: [],
  piiEntities: [],
  blockedInputMessaging: '죄송합니다. 해당 요청은 정책상 답변할 수 없습니다.',
  blockedOutputsMessaging: '죄송합니다. 해당 내용은 정책상 제공할 수 없습니다.',
}

// ─── 공통 필드 컴포넌트 ─────────────────────────────────────────────────────────
const Field = ({ label, value, placeholder, onChange, textarea, rows }) => (
  <div className={styles.formGroup}>
    <label className={styles.formLabel}>{label}</label>
    {textarea ? (
      <textarea className={styles.formTextarea} rows={rows || 3} placeholder={placeholder} value={value} onChange={onChange} />
    ) : (
      <input className={styles.formInput} type="text" placeholder={placeholder} value={value} onChange={onChange} />
    )}
  </div>
)

// ─── 설명 버튼이 달린 섹션 ─────────────────────────────────────────────────────
const Section = ({ title, helpKey, activeHelp, onHelpToggle, children }) => (
  <div
    style={{
      border: '1px solid var(--color-border-strong, #e4dfec)',
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 14,
    }}
  >
    <div className={guardrailStyles.sectionHeader}>
      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-text-body, #3a3350)' }}>
        {title}
      </div>
      {helpKey && (
        <button
          type="button"
          className={`${guardrailStyles.helpBtn} ${activeHelp === helpKey ? guardrailStyles.helpBtnActive : ''}`}
          onClick={() => onHelpToggle(helpKey)}
          aria-label={`${title} 설명 보기`}
          title="설명 및 예시 보기"
        >
          ?
        </button>
      )}
    </div>
    {children}
  </div>
)

// ─── 개인정보(PII) 처리 필드 ─────────────────────────────────────────────────
const PiiField = ({ entities, onChange }) => {
  const setRow = (i, key) => (e) => {
    const next = entities.map((row, idx) => (idx === i ? { ...row, [key]: e.target.value } : row))
    onChange(next)
  }
  const addRow = () => onChange([...entities, { type: 'PHONE', action: 'ANONYMIZE' }])
  const removeRow = (i) => onChange(entities.filter((_, idx) => idx !== i))
  return (
    <div className={styles.formGroup}>
      <label className={styles.formLabel}>PII 유형 추가</label>
      {entities.map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <select className={styles.formInput} style={{ flex: 1 }} value={row.type} onChange={setRow(i, 'type')}>
            {PII_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <select className={styles.formInput} style={{ flex: '0 0 30%' }} value={row.action} onChange={setRow(i, 'action')}>
            {PII_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
          <button type="button" className={styles.btnCancel} onClick={() => removeRow(i)}>삭제</button>
        </div>
      ))}
      <button type="button" className={styles.btnCancel} onClick={addRow}>+ PII 추가</button>
    </div>
  )
}

// ─── 거부 주제 편집기 ─────────────────────────────────────────────────────────
const TopicsField = ({ topics, onChange }) => {
  const setTopic = (i, key) => (e) => {
    const next = topics.map((t, idx) => (idx === i ? { ...t, [key]: e.target.value } : t))
    onChange(next)
  }
  const addTopic = () => onChange([...topics, { name: '', definition: '' }])
  const removeTopic = (i) => onChange(topics.filter((_, idx) => idx !== i))
  return (
    <div className={styles.formGroup}>
      <label className={styles.formLabel}>거부 주제 목록</label>
      {topics.map((t, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className={styles.formInput} style={{ flex: '0 0 30%' }} type="text"
            placeholder="주제 이름" value={t.name} onChange={setTopic(i, 'name')} />
          <input className={styles.formInput} style={{ flex: 1 }} type="text"
            placeholder="주제 정의 (무엇을 차단할지)" value={t.definition} onChange={setTopic(i, 'definition')} />
          <button type="button" className={styles.btnCancel} onClick={() => removeTopic(i)}>삭제</button>
        </div>
      ))}
      <button type="button" className={styles.btnCancel} onClick={addTopic}>+ 주제 추가</button>
    </div>
  )
}

// ─── 단어 필터 편집기 ─────────────────────────────────────────────────────────
const WordFiltersField = ({ words, onChange }) => {
  const setWord = (i) => (e) => {
    const next = words.map((w, idx) => (idx === i ? e.target.value : w))
    onChange(next)
  }
  const addWord = () => onChange([...words, ''])
  const removeWord = (i) => onChange(words.filter((_, idx) => idx !== i))
  return (
    <div className={styles.formGroup}>
      <label className={styles.formLabel}>차단 단어/문구 목록</label>
      {words.map((w, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className={styles.formInput} style={{ flex: 1 }} type="text"
            placeholder="차단할 단어 또는 문구" value={w} onChange={setWord(i)} />
          <button type="button" className={styles.btnCancel} onClick={() => removeWord(i)}>삭제</button>
        </div>
      ))}
      <button type="button" className={styles.btnCancel} onClick={addWord}>+ 단어 추가</button>
    </div>
  )
}

// ─── 설명 팝업 (모달) ─────────────────────────────────────────────────────────
const HelpPopup = ({ helpKey, onClose }) => {
  if (!helpKey) return null
  const content = HELP_CONTENT[helpKey]
  if (!content) return null

  return (
    <div className={guardrailStyles.helpOverlay} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={guardrailStyles.helpPopup}>
        <div className={guardrailStyles.helpPopupHeader}>
          <div className={guardrailStyles.helpPopupHeaderLeft}>
            <span className={guardrailStyles.helpPanelIcon}>💡</span>
            <h3 className={guardrailStyles.helpPanelTitle}>{content.title}</h3>
          </div>
          <button type="button" className={guardrailStyles.helpCloseBtn} onClick={onClose} aria-label="닫기">
            &times;
          </button>
        </div>
        <p className={guardrailStyles.helpPanelDesc}>{content.description}</p>

        <div className={guardrailStyles.helpPanelExamples}>
          <h4 className={guardrailStyles.helpPanelSubtitle}>예시</h4>
          {helpKey === 'deniedTopics' && (
            <table className={styles.guideTable}>
              <thead><tr><th>주제 이름</th><th>정의</th></tr></thead>
              <tbody>
                {content.examples.map((ex, i) => (
                  <tr key={i}><td>{ex.name}</td><td>{ex.definition}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {helpKey === 'wordFilters' && (
            <ul className={guardrailStyles.helpList}>
              {content.examples.map((ex, i) => (
                <li key={i}>{ex.word}</li>
              ))}
            </ul>
          )}
          {helpKey === 'piiEntities' && (
            <table className={styles.guideTable}>
              <thead><tr><th>유형</th><th>처리</th><th>결과</th></tr></thead>
              <tbody>
                {content.examples.map((ex, i) => (
                  <tr key={i}><td>{ex.type}</td><td>{ex.action}</td><td>{ex.result}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 메인 컴포넌트 ─────────────────────────────────────────────────────────────
const Guardrails = () => {
  const [tab, setTab] = useState('list') // 'list' | 'add'
  const [guardrails, setGuardrails] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [form, setForm] = useState(emptyForm)
  const [editing, setEditing] = useState(null)
  const [activeHelp, setActiveHelp] = useState(null) // 'deniedTopics' | 'wordFilters' | 'piiEntities' | null

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))
  const setEditField = (key) => (e) => setEditing((p) => ({ ...p, [key]: e.target.value }))

  const toggleHelp = (key) => setActiveHelp((prev) => (prev === key ? null : key))

  const loadGuardrails = useCallback(async () => {
    setError(null)
    try {
      const res = await listGuardrails()
      setGuardrails(res.guardrails || [])
    } catch (e) {
      setError(e.message || '가드레일 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadGuardrails() }, [loadGuardrails])

  const payloadOf = (f) => ({
    title: f.title.trim(),
    deniedTopics: (f.deniedTopics || []).filter((t) => t.name.trim() && t.definition.trim()),
    wordFilters: (f.wordFilters || []).filter((w) => w.trim()),
    piiEntities: (f.piiEntities || []).filter((e) => e.type),
    blockedInputMessaging: f.blockedInputMessaging,
    blockedOutputsMessaging: f.blockedOutputsMessaging,
  })

  const handleCreate = async () => {
    if (!form.title.trim()) return
    setError(null)
    try {
      await createGuardrail(payloadOf(form))
      setForm(emptyForm)
      setActiveHelp(null)
      await loadGuardrails()
      setTab('list')
    } catch (e) {
      setError(e.message || '저장에 실패했습니다.')
    }
  }

  const openEdit = (g) => setEditing({
    id: g.guardrailId,
    title: g.title || '',
    deniedTopics: g.deniedTopics || [],
    wordFilters: g.wordFilters || [],
    piiEntities: g.piiEntities || [],
    blockedInputMessaging: g.blockedInputMessaging || emptyForm.blockedInputMessaging,
    blockedOutputsMessaging: g.blockedOutputsMessaging || emptyForm.blockedOutputsMessaging,
  })

  const handleUpdate = async () => {
    if (!editing?.title.trim()) return
    setError(null)
    try {
      await updateGuardrail(editing.id, payloadOf(editing))
      setEditing(null)
      await loadGuardrails()
    } catch (e) {
      setError(e.message || '저장에 실패했습니다.')
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    setError(null)
    try {
      await deleteGuardrail(editing.id)
      setEditing(null)
      await loadGuardrails()
    } catch (e) {
      setError(e.message || '삭제에 실패했습니다.')
    }
  }

  const cancelAdd = () => {
    setForm(emptyForm)
    setActiveHelp(null)
    setTab('list')
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.headerLeft}>
            <h1 className={styles.pageTitle}>가드레일</h1>
            <p className={styles.pageDesc}>
              거부 주제·단어 필터·개인정보(PII)를 설정하는 Amazon Bedrock 가드레일을 만들고 관리합니다. 챗봇 상단에서 골라 바로 적용할 수 있어요.
            </p>
          </div>
          <button className={styles.addBtn} onClick={() => setTab('add')}>+ 새 가드레일</button>
        </div>

        <div className={styles.tabBar}>
          <button className={tab === 'list' ? styles.tabItemActive : styles.tabItem} onClick={() => setTab('list')}>
            가드레일 목록
          </button>
          <button className={tab === 'add' ? styles.tabItemActive : styles.tabItem} onClick={() => setTab('add')}>
            새로 추가
          </button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {tab === 'list' && (
        <div className={styles.listContent}>
          {loading ? (
            <div className={styles.loading}>불러오는 중…</div>
          ) : guardrails.length === 0 ? (
            <div className={styles.loading}>저장된 가드레일이 없습니다. "새 가드레일"로 만들어 보세요.</div>
          ) : (
            <div className={styles.grid}>
              {guardrails.map((g) => (
                <div key={g.guardrailId} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <h3 className={styles.cardTitle}>{g.title}</h3>
                    <button className={styles.editBtn} onClick={() => openEdit(g)} aria-label={`${g.title} 편집`}>✎</button>
                  </div>
                  {g.deniedTopics?.length > 0 && (
                    <div className={styles.cardField}>
                      <div className={styles.cardLabel}>거부 주제</div>
                      <div className={styles.cardValue}>{g.deniedTopics.map((t) => t.name).join(', ')}</div>
                    </div>
                  )}
                  {g.wordFilters?.length > 0 && (
                    <div className={styles.cardField}>
                      <div className={styles.cardLabel}>단어 필터</div>
                      <div className={styles.cardValue}>{g.wordFilters.join(', ')}</div>
                    </div>
                  )}
                  {g.piiEntities?.length > 0 && (
                    <div className={styles.cardField}>
                      <div className={styles.cardLabel}>개인정보(PII)</div>
                      <div className={styles.cardValue}>
                        {g.piiEntities.map((e) => `${piiLabel(e.type)}(${e.action === 'BLOCK' ? '차단' : '마스킹'})`).join(', ')}
                      </div>
                    </div>
                  )}
                  <div className={styles.cardField}>
                    <div className={styles.cardLabel}>상태</div>
                    <div className={styles.cardValue}>{g.status || '—'}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'add' && (
        <div className={styles.addContent}>
          <div className={styles.formCard}>
            <h2 className={styles.formTitle}>새 가드레일 추가</h2>
            <Field label="이름 *" value={form.title} onChange={setField('title')} placeholder="예: 기본 안전 가드레일" />
            <Section title="거부 주제" helpKey="deniedTopics" activeHelp={activeHelp} onHelpToggle={toggleHelp}>
              <TopicsField topics={form.deniedTopics} onChange={(t) => setForm((f) => ({ ...f, deniedTopics: t }))} />
            </Section>
            <Section title="단어 필터" helpKey="wordFilters" activeHelp={activeHelp} onHelpToggle={toggleHelp}>
              <WordFiltersField words={form.wordFilters} onChange={(w) => setForm((f) => ({ ...f, wordFilters: w }))} />
            </Section>
            <Section title="개인정보(PII)" helpKey="piiEntities" activeHelp={activeHelp} onHelpToggle={toggleHelp}>
              <PiiField entities={form.piiEntities} onChange={(p) => setForm((f) => ({ ...f, piiEntities: p }))} />
            </Section>
            <Section title="차단 메시지">
              <Field label="입력 차단 메시지" value={form.blockedInputMessaging} onChange={setField('blockedInputMessaging')} textarea rows={2} />
              <Field label="출력 차단 메시지" value={form.blockedOutputsMessaging} onChange={setField('blockedOutputsMessaging')} textarea rows={2} />
            </Section>
            <div className={styles.formActions}>
              <button className={styles.btnCancel} onClick={cancelAdd}>취소</button>
              <button className={styles.btnPrimary} onClick={handleCreate} disabled={!form.title.trim()}>저장</button>
            </div>
          </div>
        </div>
      )}

      <HelpPopup helpKey={activeHelp} onClose={() => setActiveHelp(null)} />

      {editing && (
        <div className={styles.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) setEditing(null) }}>
          <div className={styles.modalCard}>
            <h2 className={styles.modalTitle}>가드레일 편집</h2>
            <Field label="이름 *" value={editing.title} onChange={setEditField('title')} />
            <Section title="거부 주제" helpKey="deniedTopics" activeHelp={activeHelp} onHelpToggle={toggleHelp}>
              <TopicsField topics={editing.deniedTopics} onChange={(t) => setEditing((p) => ({ ...p, deniedTopics: t }))} />
            </Section>
            <Section title="단어 필터" helpKey="wordFilters" activeHelp={activeHelp} onHelpToggle={toggleHelp}>
              <WordFiltersField words={editing.wordFilters || []} onChange={(w) => setEditing((p) => ({ ...p, wordFilters: w }))} />
            </Section>
            <Section title="개인정보(PII)" helpKey="piiEntities" activeHelp={activeHelp} onHelpToggle={toggleHelp}>
              <PiiField entities={editing.piiEntities} onChange={(p) => setEditing((prev) => ({ ...prev, piiEntities: p }))} />
            </Section>
            <Section title="차단 메시지">
              <Field label="입력 차단 메시지" value={editing.blockedInputMessaging} onChange={setEditField('blockedInputMessaging')} textarea rows={2} />
              <Field label="출력 차단 메시지" value={editing.blockedOutputsMessaging} onChange={setEditField('blockedOutputsMessaging')} textarea rows={2} />
            </Section>
            <div className={styles.modalActions}>
              <button className={styles.btnDanger} onClick={handleDelete}>삭제</button>
              <div className={styles.modalRight}>
                <button className={styles.btnCancel} onClick={() => setEditing(null)}>취소</button>
                <button className={styles.btnPrimary} onClick={handleUpdate} disabled={!editing.title.trim()}>저장</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Guardrails
