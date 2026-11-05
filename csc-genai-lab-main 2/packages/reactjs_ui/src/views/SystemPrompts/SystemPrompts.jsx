/*
 * Copyright Amazon.com and its affiliates; all rights reserved.
 * SPDX-License-Identifier: LicenseRef-.amazon.com.-AmznSL-1.0
 * Licensed under the Amazon Software License  https://aws.amazon.com/asl/
 */

import { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
} from '../../utils/promptApi'
import styles from './SystemPrompts.module.css'

// ─── Seed Data (shown until server prompts load / when none exist) ────────────
// Prompts are Bedrock CHAT prompts: 시스템 지침 + 사용자/어시스턴트 예시 메시지.
const SEED_PROMPTS = [
  {
    id: 'seed-1',
    title: '친절한 고객지원',
    system:
      '당신은 공손하고 친근한 고객지원 상담원입니다. 사용자의 문제에 공감하며 단계적으로 해결 방법을 안내하고, 문서에 근거가 없으면 모른다고 답합니다.',
    user: '비밀번호를 어떻게 변경하나요?',
    assistant: '안녕하세요! 비밀번호 변경은 다음 단계로 하실 수 있어요. 1) …',
  },
  {
    id: 'seed-2',
    title: '간결한 기술 요약',
    system:
      '당신은 기술 문서를 간결하게 요약하는 도우미입니다. 핵심만 불릿으로 정리하고 수치는 굵게 표기합니다.',
    user: '이 서비스의 제한 사항을 알려줘',
    assistant: '- 최대 파일 크기: **50MB**\n- 초당 요청: **5개**',
  },
]

// ─── Guide ────────────────────────────────────────────────────────────────────
const GUIDE_ROWS = [
  { item: '시스템 지침', example: '"공손한 고객지원 상담원"', role: '역할·규칙·말투를 정의 (가장 중요)' },
  { item: '사용자 메시지', example: '"비밀번호 변경 방법은?"', role: '예시 질문 (few-shot)' },
  { item: '어시스턴트 메시지', example: '"다음 단계로…"', role: '예시 답변 형식 (few-shot)' },
]

// ─── Component ───────────────────────────────────────────────────────────────
const emptyForm = { title: '', system: '', user: '', assistant: '' }

// Defined at module scope (not inside the component) so inputs don't lose focus
// on every keystroke from a remount.
const Field = ({ label, value, placeholder, onChange, textarea, rows }) => (
  <div className={styles.formGroup}>
    <label className={styles.formLabel}>{label}</label>
    {textarea ? (
      <textarea
        className={styles.formTextarea}
        rows={rows || 3}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
      />
    ) : (
      <input
        className={styles.formInput}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
      />
    )}
  </div>
)

const SystemPrompts = () => {
  const [tab, setTab] = useState('list') // 'list' | 'add'
  const [prompts, setPrompts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [form, setForm] = useState(emptyForm)
  const [editing, setEditing] = useState(null) // { id, title, system, user, assistant }

  const setField = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))
  const setEditField = (key) => (e) =>
    setEditing((p) => ({ ...p, [key]: e.target.value }))

  const loadPrompts = useCallback(async () => {
    setError(null)
    try {
      const res = await listPrompts()
      const items = (res.prompts || []).map((p) => ({
        id: p.promptId,
        title: p.title,
        system: p.system || '',
        user: p.user || '',
        assistant: p.assistant || '',
      }))
      setPrompts(items)
    } catch (e) {
      setError(e.message || '프롬프트 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPrompts()
  }, [loadPrompts])

  const displayPrompts = prompts.length > 0 ? prompts : SEED_PROMPTS

  const handleCreate = async () => {
    if (!form.title.trim() || !form.system.trim()) return
    setError(null)
    try {
      await createPrompt({
        title: form.title.trim(),
        system: form.system.trim(),
        user: form.user.trim(),
        assistant: form.assistant.trim(),
      })
      setForm(emptyForm)
      await loadPrompts()
      setTab('list')
    } catch (e) {
      setError(e.message || '저장에 실패했습니다.')
    }
  }

  const openEdit = (p) =>
    setEditing({ id: p.id, title: p.title, system: p.system, user: p.user, assistant: p.assistant })

  const handleUpdate = async () => {
    if (!editing?.title.trim() || !editing?.system.trim()) return
    setError(null)
    const payload = {
      title: editing.title.trim(),
      system: editing.system.trim(),
      user: (editing.user || '').trim(),
      assistant: (editing.assistant || '').trim(),
    }
    try {
      // Seed samples aren't real saved prompts — save creates a new one.
      if (String(editing.id).startsWith('seed-')) {
        await createPrompt(payload)
      } else {
        await updatePrompt(editing.id, payload)
      }
      setEditing(null)
      await loadPrompts()
    } catch (e) {
      setError(e.message || '저장에 실패했습니다.')
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    if (String(editing.id).startsWith('seed-')) {
      setEditing(null)
      return
    }
    setError(null)
    try {
      await deletePrompt(editing.id)
      setEditing(null)
      await loadPrompts()
    } catch (e) {
      setError(e.message || '삭제에 실패했습니다.')
    }
  }

  const cancelAdd = () => {
    setForm(emptyForm)
    setTab('list')
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerRow}>
          <div className={styles.headerLeft}>
            <h1 className={styles.pageTitle}>시스템 프롬프트</h1>
            <p className={styles.pageDesc}>
              시스템 지침과 예시 메시지로 모델의 역할·말투·답변 형식을 정의합니다. 챗봇에서 골라 바로 적용할 수 있어요.
            </p>
          </div>
          <button className={styles.addBtn} onClick={() => setTab('add')}>
            + 새 프롬프트
          </button>
        </div>

        <div className={styles.tabBar}>
          <button
            className={tab === 'list' ? styles.tabItemActive : styles.tabItem}
            onClick={() => setTab('list')}
          >
            샘플 역할 정의
          </button>
          <button
            className={tab === 'add' ? styles.tabItemActive : styles.tabItem}
            onClick={() => setTab('add')}
          >
            새로 추가
          </button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {tab === 'list' && (
        <div className={styles.listContent}>
          {loading ? (
            <div className={styles.loading}>불러오는 중…</div>
          ) : (
            <div className={styles.grid}>
              {displayPrompts.map((p) => (
                <div key={p.id} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <h3 className={styles.cardTitle}>{p.title}</h3>
                    <button
                      className={styles.editBtn}
                      onClick={() => openEdit(p)}
                      aria-label={`${p.title} 편집`}
                    >
                      ✎
                    </button>
                  </div>
                  <div className={styles.cardField}>
                    <div className={styles.cardLabel}>SYSTEM · 시스템 지침</div>
                    <div className={styles.cardValue}>
                      {p.system ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.system}</ReactMarkdown>
                      ) : (
                        '(없음)'
                      )}
                    </div>
                  </div>
                  {p.user && (
                    <div className={styles.cardField}>
                      <div className={styles.cardLabel}>USER · 사용자 메시지</div>
                      <div className={styles.cardValue}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.user}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                  {p.assistant && (
                    <div className={styles.cardField}>
                      <div className={styles.cardLabel}>ASSISTANT · 어시스턴트 메시지</div>
                      <div className={styles.cardValue}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.assistant}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'add' && (
        <div className={styles.addContent}>
          <div className={styles.addLayout}>
            <div className={styles.formCard}>
              <h2 className={styles.formTitle}>새 프롬프트 추가</h2>
              <Field label="이름" value={form.title} onChange={setField('title')} placeholder="예: 친절한 고객지원" />
              <Field
                label="시스템 지침 (System) *"
                value={form.system}
                onChange={setField('system')}
                placeholder="모델의 역할·규칙·말투를 지시하세요. 예: 공손한 고객지원 상담원으로서…"
                textarea
                rows={4}
              />
              <Field
                label="사용자 메시지 (User) — 예시, 선택"
                value={form.user}
                onChange={setField('user')}
                placeholder="예시 질문"
                textarea
                rows={2}
              />
              <Field
                label="어시스턴트 메시지 (Assistant) — 예시, 선택"
                value={form.assistant}
                onChange={setField('assistant')}
                placeholder="예시 답변(원하는 형식)"
                textarea
                rows={3}
              />
              <div className={styles.formActions}>
                <button className={styles.btnCancel} onClick={cancelAdd}>
                  취소
                </button>
                <button
                  className={styles.btnPrimary}
                  onClick={handleCreate}
                  disabled={!form.title.trim() || !form.system.trim()}
                >
                  저장
                </button>
              </div>
            </div>

            <div className={styles.guideCard}>
              <div className={styles.guideHeader}>
                <span className={styles.guideIcon}>💡</span>
                <h3 className={styles.guideTitle}>프롬프트 구성 요소</h3>
              </div>
              <p className={styles.guideDesc}>
                시스템 지침이 핵심이고, 사용자/어시스턴트 예시는 원하는 답변 형식을 보여주는 few-shot입니다.
              </p>
              <table className={styles.guideTable}>
                <thead>
                  <tr>
                    <th>구성</th>
                    <th>예시</th>
                    <th>역할</th>
                  </tr>
                </thead>
                <tbody>
                  {GUIDE_ROWS.map((row) => (
                    <tr key={row.item}>
                      <td>{row.item}</td>
                      <td>{row.example}</td>
                      <td>{row.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div
          className={styles.modalOverlay}
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditing(null)
          }}
        >
          <div className={styles.modalCard}>
            <h2 className={styles.modalTitle}>프롬프트 편집</h2>
            <Field label="이름" value={editing.title} onChange={setEditField('title')} />
            <Field label="시스템 지침 (System) *" value={editing.system} onChange={setEditField('system')} textarea rows={4} />
            <Field label="사용자 메시지 (User)" value={editing.user} onChange={setEditField('user')} textarea rows={2} />
            <Field label="어시스턴트 메시지 (Assistant)" value={editing.assistant} onChange={setEditField('assistant')} textarea rows={3} />
            <div className={styles.modalActions}>
              <button className={styles.btnDanger} onClick={handleDelete}>
                삭제
              </button>
              <div className={styles.modalRight}>
                <button className={styles.btnCancel} onClick={() => setEditing(null)}>
                  취소
                </button>
                <button
                  className={styles.btnPrimary}
                  onClick={handleUpdate}
                  disabled={!editing.title.trim() || !editing.system.trim()}
                >
                  저장
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default SystemPrompts
