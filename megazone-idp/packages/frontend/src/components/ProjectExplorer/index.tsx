import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  Search,
  Plus,
  Settings,
  CloudUpload,
  ExternalLink,
  X,
  Trash2,
  Loader2,
} from 'lucide-react';
import { useAwsClient } from '../../hooks/useAwsClient';
import CubeLoader from '../CubeLoader';
import ProjectSettingsModal, {
  CARD_COLORS,
  LANGUAGES,
  type Project,
} from '../ProjectSettingsModal';
import DocumentUploadModal, { type DocumentProcessingOptions } from '../DocumentUploadModal';
import {
  buildDocTree,
  countDocs,
  collectDocs,
  type TreeNode,
  type FolderTreeMode,
} from '../FolderTree';
import MarkdownRenderer from '../ChatPanel/MarkdownRenderer';
import type {
  Document,
  DocumentUploadResponse,
  DocumentWorkflows,
  WorkflowDetail,
  SegmentData,
  Artifact,
  ArtifactsResponse,
} from '../../types/project';

const ACCENT = '#7c3aed';

function colorFor(project: Project): string {
  return CARD_COLORS[(project.color ?? 0) % CARD_COLORS.length].back;
}

function localeBadge(language: string | null): string {
  const match = LANGUAGES.find((l) => l.code === language);
  return match ? match.flag : (language || '—').slice(0, 2).toUpperCase();
}

/** Document status → pill label + tailwind classes. */
function statusPill(status: string): { label: string; cls: string } {
  if (status === 'completed')
    return {
      label: '완료',
      cls: 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300',
    };
  if (status === 'failed')
    return {
      label: '실패',
      cls: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    };
  return {
    label: '분석중',
    cls: 'bg-[#f2eefb] text-[#7c3aed] dark:bg-violet-500/15 dark:text-violet-300',
  };
}

function relativeTime(
  iso: string,
  t: (k: string, d: string) => string,
): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return t('projects.justNow', '방금 전');
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${t('projects.minutesAgo', '분 전')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${t('projects.hoursAgo', '시간 전')}`;
  const d = Math.floor(h / 24);
  return `${d}${t('projects.daysAgo', '일 전')}`;
}

// ── Upload / processing progress ─────────────────────────────────────────────

interface DocProgress {
  document_id: string;
  workflow_id: string;
  status: string;
  current_step: string;
  steps: Record<string, { status: string; label: string; error?: string }>;
}

/** Percent complete from the workflow step map (min 6% so the bar is visible). */
function progressPct(p: DocProgress | undefined, docStatus: string): number {
  if (docStatus === 'failed' || p?.status === 'failed') return 100;
  if (docStatus === 'completed' || p?.status === 'completed') return 100;
  const steps = p?.steps ? Object.values(p.steps) : [];
  if (!steps.length) return 6;
  const done = steps.filter((s) => s.status === 'completed').length;
  return Math.max(6, Math.round((done / steps.length) * 100));
}

function currentStepLabel(
  p: DocProgress | undefined,
  t: (k: string, d: string) => string,
): string {
  if (!p) return t('workflow.uploading', '업로드 중…');
  if (p.status === 'failed') return t('workflow.failed', '실패');
  if (p.status === 'completed') return t('projects.completed', '분석완료');
  const cur = p.current_step ? p.steps?.[p.current_step] : undefined;
  return cur?.label || p.current_step || t('workflow.processing', '처리 중…');
}

// ── Category tree (folders + document rows with status pills) ────────────────

/** A document matches a search query by name or its classified category path. */
function docMatches(doc: Document, q: string): boolean {
  return (
    doc.name.toLowerCase().includes(q) ||
    (doc.category_path || '').toLowerCase().includes(q) ||
    (doc.folder_path || '').toLowerCase().includes(q)
  );
}

function CategoryNode({
  node,
  depth,
  forceOpen,
  onSelectDoc,
  selectedDocId,
  onSelectFolder,
  selectedFolderPath,
}: {
  node: TreeNode;
  depth: number;
  forceOpen?: boolean;
  onSelectDoc?: (doc: Document) => void;
  selectedDocId?: string;
  onSelectFolder?: (node: TreeNode) => void;
  selectedFolderPath?: string;
}) {
  const [localOpen, setLocalOpen] = useState(depth < 1);
  const open = forceOpen || localOpen;
  const setOpen = setLocalOpen;
  const children = Array.from(node.children.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const pad = { paddingLeft: `${depth * 14 + 28}px` };
  const isSelected = selectedFolderPath === node.path;

  return (
    <div>
      <button
        type="button"
        style={pad}
        onClick={() => {
          setOpen((v) => !v);
          onSelectFolder?.(node);
        }}
        className={`flex w-full items-center gap-1.5 py-1 pr-2 text-sm rounded transition-colors ${
          isSelected
            ? 'bg-[#f2eefb] text-[#6d28d9] dark:bg-violet-500/10 dark:text-violet-300'
            : 'text-[#3a3350] dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/5'
        }`}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {open ? (
          <FolderOpen
            className="h-4 w-4 shrink-0 text-amber-500"
            strokeWidth={1.5}
          />
        ) : (
          <Folder
            className="h-4 w-4 shrink-0 text-amber-500"
            strokeWidth={1.5}
          />
        )}
        <span className="truncate">{node.name}</span>
        <span className="ml-auto pl-2 text-xs text-[#a89fb8]">
          {countDocs(node)}
        </span>
      </button>
      {open && (
        <div>
          {children.map((child) => (
            <CategoryNode
              key={child.path}
              node={child}
              depth={depth + 1}
              forceOpen={forceOpen}
              onSelectDoc={onSelectDoc}
              selectedDocId={selectedDocId}
              onSelectFolder={onSelectFolder}
              selectedFolderPath={selectedFolderPath}
            />
          ))}
          {node.docs.map((doc) => {
            const pill = statusPill(doc.status);
            return (
              <button
                key={doc.document_id}
                type="button"
                onClick={() => onSelectDoc?.(doc)}
                style={{ paddingLeft: `${(depth + 1) * 14 + 28}px` }}
                className={`flex w-full items-center gap-1.5 py-1 pr-2 text-sm rounded transition-colors ${
                  selectedDocId === doc.document_id
                    ? 'bg-[#f2eefb] text-[#6d28d9] dark:bg-violet-500/10 dark:text-violet-300'
                    : 'text-[#6b6478] dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                <FileText className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="truncate">{doc.name}</span>
                <span
                  className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${pill.cls}`}
                >
                  {pill.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectTreeRow({
  project,
  docs,
  expanded,
  selected,
  onToggle,
  onSelect,
  query,
  onSelectDoc,
  selectedDocId,
  matchDoc,
  groupMode,
  onSelectFolder,
  selectedFolderPath,
}: {
  project: Project;
  docs: Document[];
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  query?: string;
  onSelectDoc?: (doc: Document) => void;
  selectedDocId?: string;
  matchDoc?: (doc: Document, q: string) => boolean;
  groupMode: FolderTreeMode;
  onSelectFolder?: (node: TreeNode) => void;
  selectedFolderPath?: string;
}) {
  // While searching, show only matching documents and force the tree open so
  // matches inside nested folders are visible.
  const shownDocs = useMemo(
    () =>
      query
        ? docs.filter((d) =>
            matchDoc ? matchDoc(d, query) : docMatches(d, query),
          )
        : docs,
    [docs, query, matchDoc],
  );
  const tree = useMemo(
    () => buildDocTree(shownDocs, groupMode),
    [shownDocs, groupMode],
  );
  const topLevel = Array.from(tree.children.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const isOpen = expanded || !!query;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          onSelect();
          onToggle();
        }}
        className={`flex w-full items-center gap-2 py-2 pl-2 pr-3 rounded-lg text-left transition-colors ${
          selected
            ? 'bg-[#f2eefb] dark:bg-violet-500/10'
            : 'hover:bg-black/5 dark:hover:bg-white/5'
        }`}
      >
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-[#a89fb8] transition-transform ${isOpen ? 'rotate-90' : ''}`}
        />
        {isOpen ? (
          <FolderOpen
            className="h-5 w-5 shrink-0"
            strokeWidth={1.5}
            style={{ color: colorFor(project) }}
          />
        ) : (
          <Folder
            className="h-5 w-5 shrink-0"
            strokeWidth={1.5}
            style={{ color: colorFor(project) }}
          />
        )}
        <span className="truncate font-semibold text-[#1a1523] dark:text-slate-100">
          {project.name}
        </span>
        <span className="shrink-0 rounded-md bg-black/5 dark:bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[#6b6478] dark:text-slate-400">
          {localeBadge(project.language)}
        </span>
        <span className="ml-auto shrink-0 text-xs text-[#a89fb8]">
          {shownDocs.length}
        </span>
      </button>
      {isOpen && (
        <div className="mt-0.5 mb-1">
          {topLevel.length === 0 ? (
            <p
              style={{ paddingLeft: '28px' }}
              className="py-1 text-sm text-[#a89fb8]"
            >
              —
            </p>
          ) : (
            topLevel.map((node) => (
              <CategoryNode
                key={node.path}
                node={node}
                depth={0}
                forceOpen={!!query}
                onSelectDoc={onSelectDoc}
                selectedDocId={selectedDocId}
                onSelectFolder={onSelectFolder}
                selectedFolderPath={selectedFolderPath}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Right detail panel ──────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: number;
  valueClass?: string;
}) {
  return (
    <div className="flex-1 rounded-xl border border-[var(--color-border)] dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2.5 text-center">
      <div
        className={`text-xl font-bold ${valueClass || 'text-[#1a1523] dark:text-slate-100'}`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs text-[#6b6478] dark:text-slate-400">
        {label}
      </div>
    </div>
  );
}

function DetailPanel({
  project,
  docs,
  artifacts,
  progress,
  uploading,
  onOpen,
  onUpload,
  onSettings,
  onDelete,
}: {
  project: Project;
  docs: Document[];
  artifacts: Artifact[];
  progress: Record<string, DocProgress>;
  uploading: boolean;
  onOpen: () => void;
  onUpload: () => void;
  onSettings: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const completed = docs.filter((d) => d.status === 'completed').length;

  // Documents still uploading/processing → show live progress instead of activity.
  const activeDocs = docs.filter(
    (d) => d.status !== 'completed' && d.status !== 'failed',
  );
  const showProgress = uploading || activeDocs.length > 0;

  const activity = useMemo(() => {
    const items = [
      ...docs.map((d) => ({
        id: d.document_id,
        text: d.name,
        at: d.created_at,
        dot: statusPill(d.status).cls,
      })),
      ...artifacts.map((a) => ({
        id: a.artifact_id,
        text: a.filename,
        at: a.created_at,
        dot: 'bg-[#7c3aed]',
      })),
    ];
    return items
      .filter((i) => i.at)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 3);
  }, [docs, artifacts]);

  return (
    <aside className="flex w-[360px] shrink-0 flex-col rounded-2xl border border-[var(--color-border)] dark:border-slate-700 bg-[var(--color-panel)] dark:bg-slate-800/40 p-5">
      <div className="flex flex-col items-center text-center">
        <FolderOpen
          className="h-14 w-14"
          strokeWidth={1.25}
          style={{ color: colorFor(project) }}
        />
        <h2 className="mt-2 text-2xl font-bold text-[#1a1523] dark:text-slate-100">
          {project.name}
        </h2>
        {project.description && (
          <p className="mt-1 text-sm text-[#6b6478] dark:text-slate-400 line-clamp-3">
            {project.description}
          </p>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <StatTile label={t('projects.documents', '문서')} value={docs.length} />
        <StatTile
          label={t('projects.completed', '분석완료')}
          value={completed}
          valueClass="text-green-600 dark:text-green-400"
        />
        <StatTile
          label={t('nav.artifacts', '아티팩트')}
          value={artifacts.length}
          valueClass="text-[#7c3aed] dark:text-violet-400"
        />
      </div>

      {showProgress ? (
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#a89fb8]">
            {t('projects.uploadProgress', '진행 상황')}
          </h3>
          {activeDocs.length === 0 ? (
            <p className="text-sm text-[#a89fb8]">
              {t('workflow.uploading', '업로드 중…')}
            </p>
          ) : (
            <ul className="space-y-3">
              {activeDocs.map((d) => {
                const p = progress[d.document_id];
                const pct = progressPct(p, d.status);
                const failed = d.status === 'failed' || p?.status === 'failed';
                return (
                  <li key={d.document_id}>
                    <div className="flex items-center gap-1.5 text-sm">
                      <FileText
                        className="h-3.5 w-3.5 shrink-0 text-[#6b6478]"
                        strokeWidth={1.5}
                      />
                      <span className="truncate text-[#3a3350] dark:text-slate-300">
                        {d.name}
                      </span>
                      <span
                        className={`ml-auto shrink-0 text-xs font-medium ${
                          failed ? 'text-[#c0392b]' : 'text-[#7c3aed]'
                        }`}
                      >
                        {pct}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          failed ? 'bg-[#c0392b]' : 'bg-[#7c3aed]'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-1 text-[11px] text-[#a89fb8]">
                      {currentStepLabel(p, t)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#a89fb8]">
            {t('projects.recentActivity', '최근 활동')}
          </h3>
          {activity.length === 0 ? (
            <p className="text-sm text-[#a89fb8]">
              {t('projects.noActivity', '활동 없음')}
            </p>
          ) : (
            <ul className="space-y-2">
              {activity.map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-sm">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${item.dot}`}
                  />
                  <span className="truncate text-[#3a3350] dark:text-slate-300">
                    {item.text}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-[#a89fb8]">
                    {relativeTime(item.at, t)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 border-t border-[var(--color-border)] dark:border-slate-700 pt-3 text-xs text-[#a89fb8]">
        {project.created_by && (
          <div className="truncate">{project.created_by}</div>
        )}
        {project.created_at && (
          <div>{new Date(project.created_at).toLocaleDateString()}</div>
        )}
      </div>

      <div className="mt-auto flex gap-2 pt-4">
        <button
          type="button"
          onClick={onUpload}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-colors"
          style={{ backgroundColor: ACCENT }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.backgroundColor = '#6d28d9')
          }
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = ACCENT)}
        >
          <CloudUpload className="h-4 w-4" />
          {t('documents.uploadDocuments', '문서 업로드')}
        </button>
        <button
          type="button"
          onClick={onOpen}
          title={t('projects.openWorkspace', '워크스페이스 열기')}
          className="rounded-xl border border-[var(--color-border)] dark:border-slate-700 px-3 py-2.5 text-[#3a3350] dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          <ExternalLink className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onSettings}
          title={t('projects.editProject', '프로젝트 편집')}
          className="rounded-xl border border-[var(--color-border)] dark:border-slate-700 px-3 py-2.5 text-[#6b6478] dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Settings className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title={t('projects.deleteProject', '프로젝트 삭제')}
          className="rounded-xl border border-[var(--color-border)] dark:border-slate-700 px-3 py-2.5 text-[#6b6478] hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:border-red-500/40 dark:hover:bg-red-500/10"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}

// ── Document detail (content + summary + delete) ─────────────────────────────

// Common words to NOT highlight (so a phrase query like "PII에 관련된 문제"
// highlights "PII", not the generic "관련"/"문제").
const HIGHLIGHT_STOPWORDS = new Set([
  // Korean
  '문제',
  '관련',
  '관련된',
  '대한',
  '관한',
  '위한',
  '있는',
  '되는',
  '하는',
  '그리고',
  '또는',
  '무엇',
  '어떤',
  '어떻게',
  '방법',
  '내용',
  '정보',
  '문서',
  '페이지',
  '부분',
  '경우',
  '통해',
  '대해',
  '에서',
  '으로',
  // English
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'is',
  'are',
  'with',
  'about',
  'related',
  'problem',
  'problems',
  'question',
  'questions',
]);

/**
 * Extract meaningful highlight terms from a query. Tokenizes English/number
 * runs and Korean runs separately (so "PII에" → "PII"), drops single chars
 * (Korean particles) and common stopwords.
 */
function highlightTerms(query: string): string[] {
  const tokens = query.match(/[A-Za-z0-9]+|[가-힣]+/g) || [];
  const terms = tokens.filter(
    (tok) =>
      tok.length >= 2 && !HIGHLIGHT_STOPWORDS.has(tok.toLowerCase()),
  );
  return [...new Set(terms)];
}

/** Wrap query-term occurrences in <mark> for the markdown (rehype-raw) renderer. */
function highlightMarkdown(text: string, query: string): string {
  const terms = highlightTerms(query);
  if (!terms.length) return text;
  const esc = terms.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(`(${esc.join('|')})`, 'gi'), '<mark>$1</mark>');
}

function DocumentDetailPanel({
  projectId,
  doc,
  highlight,
  matches,
  onClose,
  onDeleted,
}: {
  projectId: string;
  doc: Document;
  highlight?: string;
  matches?: { page: number; snippet: string }[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { fetchApi } = useAwsClient();
  // The workflow-detail endpoint returns segments=[]; real analysis content
  // lives in the per-segment endpoint, so we fetch the first N segments here.
  const MAX_SEGMENTS = 12;
  const [segments, setSegments] = useState<SegmentData[]>([]);
  const [totalSegments, setTotalSegments] = useState(0);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // When opened from a search match, keep the content/summary collapsed behind
  // a button so the matched excerpt is the focus.
  const [showSummary, setShowSummary] = useState(
    !(highlight && matches && matches.length > 0),
  );
  const pill = statusPill(doc.status);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSegments([]);
    setTotalSegments(0);
    (async () => {
      try {
        const wfs = await fetchApi<DocumentWorkflows[]>(
          `projects/${projectId}/workflows`,
        );
        const wfId = wfs.find((w) => w.document_id === doc.document_id)
          ?.workflows?.[0]?.workflow_id;
        if (!wfId) return;
        const d = await fetchApi<WorkflowDetail>(
          `documents/${doc.document_id}/workflows/${wfId}`,
        );
        if (cancelled) return;
        const total = d.total_segments || 0;
        setTotalSegments(total);
        const n = Math.min(total, MAX_SEGMENTS);
        const segs = await Promise.all(
          Array.from({ length: n }, (_, i) =>
            fetchApi<SegmentData>(
              `documents/${doc.document_id}/workflows/${wfId}/segments/${i}`,
            ).catch(() => null),
          ),
        );
        if (!cancelled)
          setSegments(segs.filter((s): s is SegmentData => !!s));
      } catch (err) {
        console.error('Failed to load document detail:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, doc.document_id, fetchApi]);

  // The AI analysis across segments is the document's analyzed content/summary.
  const analysis = useMemo(() => {
    const out: { key: string; page: number; query: string; content: string }[] =
      [];
    segments.forEach((seg, si) => {
      (seg.ai_analysis ?? []).forEach((a, ai) => {
        if (a.content?.trim())
          out.push({
            key: `${si}-${ai}`,
            page: seg.segment_index + 1,
            query: a.analysis_query,
            content: a.content,
          });
      });
      if (!seg.ai_analysis?.length && seg.text_content?.trim())
        out.push({
          key: `${si}-text`,
          page: seg.segment_index + 1,
          query: '',
          content: seg.text_content,
        });
    });
    return out;
  }, [segments]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await fetchApi(`projects/${projectId}/documents/${doc.document_id}`, {
        method: 'DELETE',
      });
      onDeleted();
    } catch (err) {
      console.error('Failed to delete document:', err);
      setDeleting(false);
    }
  };

  return (
    <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] dark:border-slate-700 bg-[var(--color-panel)] dark:bg-slate-800/40">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] dark:border-slate-700 px-4 py-3">
        <FileText
          className="h-5 w-5 shrink-0 text-[#6b6478]"
          strokeWidth={1.5}
        />
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-semibold text-[#1a1523] dark:text-slate-100"
            title={doc.name}
          >
            {doc.name}
          </p>
          <p className="text-[11px] text-[#a89fb8]">
            {doc.file_type || '—'}
            {' · '}
            <span className={`rounded px-1 ${pill.cls}`}>{pill.label}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('common.close', '닫기')}
          className="rounded-lg p-1 text-[#a89fb8] hover:bg-black/5 dark:hover:bg-white/5"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {highlight && matches && matches.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[#a89fb8]">
              {t('documents.searchMatch', '검색 일치')} ({matches.length})
            </p>
            <div className="space-y-3">
              {matches.map((m, i) => (
                <div
                  key={`${m.page}-${i}`}
                  className="rounded-xl border border-yellow-300/60 bg-yellow-50 px-3 py-2.5 dark:border-yellow-400/30 dark:bg-yellow-400/10"
                >
                  <span className="mb-1.5 inline-block rounded bg-[#7c3aed] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {t('sidepanel.pageAbbr', 'p.')}
                    {m.page}
                  </span>
                  <div className="prose prose-sm max-w-none text-xs leading-relaxed text-[#3a3350] dark:prose-invert dark:text-slate-300 prose-headings:text-[#1a1523] dark:prose-headings:text-slate-100 prose-pre:text-xs prose-hr:my-2">
                    <MarkdownRenderer>
                      {highlightMarkdown(m.snippet, highlight)}
                    </MarkdownRenderer>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#a89fb8]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('common.loading', '불러오는 중…')}
          </div>
        ) : analysis.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#a89fb8]">
            {doc.status === 'completed'
              ? t('sidepanel.noAnalysis', '분석 내용이 없습니다')
              : t('documents.processing', '문서 처리 중입니다…')}
          </p>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setShowSummary((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-[#a89fb8] hover:bg-black/5 dark:hover:bg-white/5"
            >
              {t('sidepanel.contentSummary', '내용 · 요약')}
              <ChevronRight
                className={`h-3.5 w-3.5 shrink-0 transition-transform ${showSummary ? 'rotate-90' : ''}`}
              />
            </button>
            {showSummary && (
              <div className="mt-2 space-y-4">
                {analysis.map((a) => (
                  <div key={a.key}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-[#6b6478] dark:bg-white/10 dark:text-slate-300">
                        p.{a.page}
                      </span>
                      {a.query && (
                        <span className="truncate text-[11px] font-medium text-[#7c3aed]">
                          {a.query}
                        </span>
                      )}
                    </div>
                    <div className="prose prose-sm max-w-none text-xs leading-relaxed text-[#3a3350] dark:prose-invert dark:text-slate-300 prose-headings:text-[#1a1523] dark:prose-headings:text-slate-100 prose-pre:text-xs">
                      <MarkdownRenderer>
                        {highlight
                          ? highlightMarkdown(a.content, highlight)
                          : a.content}
                      </MarkdownRenderer>
                    </div>
                  </div>
                ))}
                {totalSegments > segments.length && (
                  <p className="pt-1 text-[11px] text-[#a89fb8]">
                    {t('sidepanel.moreSegments', '일부 페이지만 표시됩니다')} (
                    {segments.length}/{totalSegments})
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--color-border)] dark:border-slate-700 p-3">
        {confirming ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#c0392b] px-3 py-2 text-sm font-semibold text-white hover:bg-[#a53125] disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t('common.confirmDelete', '삭제 확인')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={deleting}
              className="rounded-xl border border-[var(--color-border)] dark:border-slate-700 px-3 py-2 text-sm text-[#3a3350] dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
            >
              {t('common.cancel', '취소')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#c0392b]/40 px-3 py-2 text-sm font-medium text-[#c0392b] hover:bg-[#c0392b]/5"
          >
            <Trash2 className="h-4 w-4" />
            {t('documents.deleteDocument', '문서 삭제')}
          </button>
        )}
      </div>
    </aside>
  );
}

// ── Main explorer ───────────────────────────────────────────────────────────

// Folder summary card shown on the right when a folder is clicked in the tree.
function FolderDetailPanel({
  node,
  onClose,
  onSelectDoc,
  onDelete,
}: {
  node: TreeNode;
  onClose: () => void;
  onSelectDoc?: (doc: Document) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const docs = collectDocs(node);
  return (
    <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] dark:border-slate-700 bg-[var(--color-panel)] dark:bg-slate-800/40">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] dark:border-slate-700 px-4 py-3">
        <FolderOpen
          className="h-5 w-5 shrink-0 text-amber-500"
          strokeWidth={1.5}
        />
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-semibold text-[#1a1523] dark:text-slate-100"
            title={node.path}
          >
            {node.name}
          </p>
          <p className="text-[11px] text-[#a89fb8]">
            {t('projects.documentCount', '{{n}} 문서', { n: docs.length })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('common.close', '닫기')}
          className="rounded-lg p-1 text-[#a89fb8] hover:bg-black/5 dark:hover:bg-white/5"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-[#a89fb8]">
          {t('projects.folderContents', '폴더 내용')}
        </p>
        <div className="space-y-0.5">
          {docs.map((doc) => {
            const pill = statusPill(doc.status);
            return (
              <button
                key={doc.document_id}
                type="button"
                onClick={() => onSelectDoc?.(doc)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-sm text-[#6b6478] dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <FileText className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="truncate">{doc.name}</span>
                <span
                  className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${pill.cls}`}
                >
                  {pill.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-[var(--color-border)] dark:border-slate-700 p-3">
        <button
          type="button"
          onClick={onDelete}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700"
        >
          <Trash2 className="h-4 w-4" />
          {t('projects.deleteFolder', '폴더 삭제')}
          <span className="opacity-80">({docs.length})</span>
        </button>
      </div>
    </aside>
  );
}

interface ProjectExplorerProps {
  initialProjects: Project[];
  onProjectsChanged: () => void;
}

export default function ProjectExplorer({
  initialProjects,
  onProjectsChanged,
}: ProjectExplorerProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { fetchApi } = useAwsClient();

  const [projects] = useState<Project[]>(initialProjects);
  const [docsByProject, setDocsByProject] = useState<
    Record<string, Document[]>
  >({});
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedId, setSelectedId] = useState<string>(
    initialProjects[0]?.project_id ?? '',
  );
  // A selected document shows its content/summary panel instead of project detail.
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initialProjects[0] ? [initialProjects[0].project_id] : []),
  );
  const [viewMode, setViewMode] = useState<'tree' | 'grid'>('tree');
  // Tree grouping: 'folder' = uploaded folder structure (folder_path),
  // 'category' = AI auto-classification (category_path).
  const [groupMode, setGroupMode] = useState<FolderTreeMode>('folder');
  // A selected folder shows a folder summary card (with delete) on the right.
  const [selectedFolder, setSelectedFolder] = useState<{
    projectId: string;
    node: TreeNode;
  } | null>(null);
  // Pending folder delete (collected docs shown in the confirm modal).
  const [folderDelete, setFolderDelete] = useState<{
    projectId: string;
    node: TreeNode;
    docs: Document[];
  } | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  // Pending project delete (backend cascade removes all its documents/data).
  const [projectDelete, setProjectDelete] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [docsLoading, setDocsLoading] = useState(true);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadingFromExplorer, setUploadingFromExplorer] = useState(false);
  // Live processing progress for the selected project's documents.
  const [progressMap, setProgressMap] = useState<Record<string, DocProgress>>(
    {},
  );
  const [pollTick, setPollTick] = useState(0);
  const docsByProjectRef = useRef(docsByProject);
  docsByProjectRef.current = docsByProject;

  // Fetch documents for every project up front (counts show in the tree).
  useEffect(() => {
    let cancelled = false;
    setDocsLoading(true);
    Promise.all(
      projects.map((p) =>
        fetchApi<Document[]>(`projects/${p.project_id}/documents`)
          .then((docs) => [p.project_id, docs] as const)
          .catch((err) => {
            console.error('Failed to load documents:', err);
            return [p.project_id, [] as Document[]] as const;
          }),
      ),
    ).then((entries) => {
      if (cancelled) return;
      const map = Object.fromEntries(entries);
      setDocsByProject(map);
      docsByProjectRef.current = map;
      setDocsLoading(false);
      // If any document is still processing (e.g. after a page refresh mid-run),
      // kick the progress poller so its progress resumes updating.
      const anyActive = Object.values(map).some((docs) =>
        docs.some((d) => d.status !== 'completed' && d.status !== 'failed'),
      );
      if (anyActive) setPollTick((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [projects, fetchApi]);

  // Lazily fetch artifacts for the selected project.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetchApi<ArtifactsResponse>(`artifacts?project_id=${selectedId}`)
      .then((res) => {
        if (!cancelled) setArtifacts(res.items);
      })
      .catch((err) => {
        console.error('Failed to load artifacts:', err);
        if (!cancelled) setArtifacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, fetchApi]);

  // Poll processing progress for the selected project while any document is
  // still being processed (or right after an upload kicks it via pollTick).
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isActive = () =>
      (docsByProjectRef.current[selectedId] || []).some(
        (d) => d.status !== 'completed' && d.status !== 'failed',
      );
    const poll = async () => {
      try {
        const [prog, docs] = await Promise.all([
          fetchApi<DocProgress[]>(
            `projects/${selectedId}/documents/progress`,
          ),
          fetchApi<Document[]>(`projects/${selectedId}/documents`),
        ]);
        if (cancelled) return;
        const map: Record<string, DocProgress> = {};
        for (const p of prog) map[p.document_id] = p;
        setProgressMap(map);
        setDocsByProject((prev) => ({ ...prev, [selectedId]: docs }));
        docsByProjectRef.current = {
          ...docsByProjectRef.current,
          [selectedId]: docs,
        };
        if (
          docs.some((d) => d.status !== 'completed' && d.status !== 'failed')
        ) {
          timer = setTimeout(poll, 3000);
        }
      } catch (err) {
        console.error('Failed to poll progress:', err);
        if (!cancelled) timer = setTimeout(poll, 5000);
      }
    };
    if (isActive() || pollTick > 0) poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedId, pollTick, fetchApi]);

  const totalDocs = Object.values(docsByProject).reduce(
    (n, d) => n + d.length,
    0,
  );

  const searchQuery = search.trim().toLowerCase();

  // Server-side content/keyword search (LanceDB) for the selected project,
  // debounced. Returns matching document_ids to merge with client-side name/path
  // matching. Scoped to selectedId to avoid N Lambda invokes per keystroke.
  const [contentHits, setContentHits] = useState<Set<string>>(new Set());
  // document_id → every matched segment (page + excerpt) for the detail panel.
  const [hitSegments, setHitSegments] = useState<
    Record<string, { page: number; snippet: string }[]>
  >({});
  useEffect(() => {
    const q = search.trim();
    if (!q || !selectedId) {
      setContentHits(new Set());
      setHitSegments({});
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      fetchApi<
        { document_id: string; page: number; snippet: string }[]
      >(`projects/${selectedId}/documents/search?q=${encodeURIComponent(q)}`)
        .then((hits) => {
          if (cancelled) return;
          setContentHits(new Set(hits.map((h) => h.document_id)));
          const byDoc: Record<string, { page: number; snippet: string }[]> = {};
          for (const h of hits) {
            (byDoc[h.document_id] ||= []).push({
              page: h.page,
              snippet: h.snippet,
            });
          }
          for (const k of Object.keys(byDoc))
            byDoc[k].sort((a, b) => a.page - b.page);
          setHitSegments(byDoc);
        })
        .catch(() => {
          if (!cancelled) {
            setContentHits(new Set());
            setHitSegments({});
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [search, selectedId, fetchApi]);

  const matches = useCallback(
    (doc: Document, q: string) =>
      docMatches(doc, q) || contentHits.has(doc.document_id),
    [contentHits],
  );

  const filtered = useMemo(() => {
    if (!searchQuery) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(searchQuery) ||
        (docsByProject[p.project_id] || []).some((d) => matches(d, searchQuery)),
    );
  }, [projects, searchQuery, docsByProject, matches]);

  const selected = projects.find((p) => p.project_id === selectedId) || null;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleCreate = async (data: {
    name: string;
    description: string;
    language: string;
    color: number;
    document_prompt: string;
  }) => {
    try {
      await fetchApi<Project>('projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      onProjectsChanged();
    } catch (err) {
      console.error('Failed to create project:', err);
    }
  };

  const handleEditSave = async (data: {
    name: string;
    description: string;
    language: string;
    color: number;
    document_prompt: string;
  }) => {
    if (!selected) return;
    try {
      await fetchApi(`projects/${selected.project_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      onProjectsChanged();
    } catch (err) {
      console.error('Failed to update project:', err);
    }
  };

  const openWorkspace = () => {
    if (!selectedId) return;
    navigate({ to: '/projects/$projectId', params: { projectId: selectedId } });
  };

  const handleUploadFromExplorer = useCallback(
    async (files: File[], options: DocumentProcessingOptions) => {
      if (!selectedId) return;
      setUploadingFromExplorer(true);
      try {
        for (const file of files) {
          // Preserve any uploaded folder structure (webkitRelativePath).
          const relPath =
            (file as File & { webkitRelativePath?: string })
              .webkitRelativePath || '';
          const folderPath = relPath.includes('/')
            ? relPath.slice(0, relPath.lastIndexOf('/'))
            : '';
          const contentType = file.type || 'application/octet-stream';

          // 1) Create the document record + get a presigned S3 PUT URL.
          const info = await fetchApi<DocumentUploadResponse>(
            `projects/${selectedId}/documents`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                file_name: file.name,
                content_type: contentType,
                file_size: file.size,
                use_bda: options.use_bda,
                use_ocr: options.use_ocr,
                ocr_model: options.ocr_model,
                ocr_options: options.ocr_options,
                document_prompt: options.document_prompt,
                language: options.language,
                folder_path: folderPath || undefined,
              }),
            },
          );

          // 2) Upload the file bytes straight to S3 via the presigned URL.
          const put = await fetch(info.upload_url, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': contentType },
          });
          if (!put.ok) {
            throw new Error(`S3 upload failed (${put.status}) for ${file.name}`);
          }

          // 3) Mark 'uploaded' — this triggers the processing/indexing pipeline
          // (OCR → analysis → embedding → graph). Without it the document is
          // never indexed, so the AI chat can't find it.
          await fetchApi(
            `projects/${selectedId}/documents/${info.document_id}/status`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'uploaded' }),
            },
          );
        }
        const updatedDocs = await fetchApi<Document[]>(
          `projects/${selectedId}/documents`,
        );
        setDocsByProject((prev) => ({ ...prev, [selectedId]: updatedDocs }));
        // Kick the progress poller so the bar/steps start updating live.
        setPollTick((n) => n + 1);
      } catch (err) {
        console.error('Upload failed:', err);
      } finally {
        setUploadingFromExplorer(false);
        setShowUploadModal(false);
      }
    },
    [fetchApi, selectedId],
  );

  // Folder delete: the backend has no folder entity, so fan out one delete per
  // document in the folder subtree, then refresh the project's document list.
  const confirmDeleteFolder = useCallback(async () => {
    if (!folderDelete) return;
    const { projectId: pid, docs } = folderDelete;
    setDeletingFolder(true);
    try {
      await Promise.allSettled(
        docs.map((d) =>
          fetchApi(`projects/${pid}/documents/${d.document_id}`, {
            method: 'DELETE',
          }),
        ),
      );
      const fresh = await fetchApi<Document[]>(`projects/${pid}/documents`);
      setDocsByProject((prev) => ({ ...prev, [pid]: fresh }));
      setSelectedDoc((cur) =>
        cur && docs.some((d) => d.document_id === cur.document_id) ? null : cur,
      );
      setSelectedFolder(null);
    } catch (err) {
      console.error('Failed to delete folder:', err);
    } finally {
      setDeletingFolder(false);
      setFolderDelete(null);
    }
  }, [fetchApi, folderDelete]);

  // Project delete: the backend DELETE /projects/{id} cascades — it drops the
  // project's LanceDB tables + graph keywords, all workflow items, the entire
  // S3 project folder, session/agent files, and every DDB item. So a single
  // call cleans up all documents and (virtual) folders inside.
  const confirmDeleteProject = useCallback(async () => {
    if (!projectDelete) return;
    const pid = projectDelete.project_id;
    setDeletingProject(true);
    try {
      await fetchApi(`projects/${pid}`, { method: 'DELETE' });
      setSelectedFolder(null);
      setSelectedDoc(null);
      if (selectedId === pid) setSelectedId('');
      setDocsByProject((prev) => {
        const next = { ...prev };
        delete next[pid];
        return next;
      });
      setProjectDelete(null);
      onProjectsChanged();
    } catch (err) {
      console.error('Failed to delete project:', err);
    } finally {
      setDeletingProject(false);
    }
  }, [fetchApi, projectDelete, selectedId, onProjectsChanged]);

  const selectedProject = projects.find(p => p.project_id === selectedId) || null;

  if (docsLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <CubeLoader />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[#1a1523] dark:text-slate-100">
            {t('projects.explorerTitle', '프로젝트 탐색기')}
          </h1>
          <p className="text-sm text-[#6b6478] dark:text-slate-400">
            {t('projects.projectCount', '{{n}} 프로젝트', {
              n: projects.length,
            })}
            {' · '}
            {t('projects.documentCount', '{{n}} 문서', { n: totalDocs })}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#a89fb8]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('projects.searchPlaceholder', '이름·내용 검색…')}
              className="w-56 rounded-full border border-[var(--color-border)] dark:border-slate-700 bg-white dark:bg-slate-800 py-2 pl-9 pr-4 text-sm text-[#1a1523] dark:text-slate-100 placeholder:text-[#a89fb8] focus:outline-none focus:ring-2 focus:ring-[#7c3aed]/30"
            />
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 rounded-full px-4 py-2 text-sm font-semibold text-white transition-colors"
            style={{ backgroundColor: ACCENT }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = '#6d28d9')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = ACCENT)
            }
          >
            <Plus className="h-4 w-4" />
            {t('projects.newProject', '새 프로젝트')}
          </button>
        </div>
      </div>

      {/* Body: center column + right detail */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Center column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-3 flex items-center justify-between">
            <div className="inline-flex rounded-lg border border-[var(--color-border)] dark:border-slate-700 p-0.5">
              {(['tree', 'grid'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                    viewMode === mode
                      ? 'bg-[#7c3aed] text-white'
                      : 'text-[#6b6478] dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  {mode === 'tree'
                    ? t('projects.viewTree', '트리')
                    : t('projects.viewGrid', '그리드')}
                </button>
              ))}
            </div>
            {viewMode === 'tree' && (
              <div className="flex items-center gap-3">
                <div className="inline-flex rounded-lg border border-[var(--color-border)] dark:border-slate-700 p-0.5">
                  {(['folder', 'category'] as const).map((gm) => (
                    <button
                      key={gm}
                      type="button"
                      onClick={() => setGroupMode(gm)}
                      className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                        groupMode === gm
                          ? 'bg-[#7c3aed] text-white'
                          : 'text-[#6b6478] dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5'
                      }`}
                    >
                      {gm === 'folder'
                        ? t('projects.groupFolder', '폴더')
                        : t('projects.groupCategory', '분류')}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setExpanded(new Set())}
                  className="text-sm text-[#6b6478] dark:text-slate-400 hover:text-[#7c3aed]"
                >
                  {t('projects.collapseAll', '모두 접기')}
                </button>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-[var(--color-border)] dark:border-slate-700 bg-[var(--color-panel)] dark:bg-slate-800/40 p-2">
            {filtered.length === 0 ? (
              <p className="p-6 text-center text-sm text-[#a89fb8]">
                {t('projects.noResults', '결과가 없습니다')}
              </p>
            ) : viewMode === 'tree' ? (
              <div className="space-y-0.5">
                {filtered.map((p) => (
                  <ProjectTreeRow
                    key={p.project_id}
                    project={p}
                    docs={docsByProject[p.project_id] || []}
                    expanded={expanded.has(p.project_id)}
                    selected={selectedId === p.project_id}
                    onToggle={() => toggle(p.project_id)}
                    onSelect={() => {
                      setSelectedId(p.project_id);
                      setSelectedDoc(null);
                      setSelectedFolder(null);
                    }}
                    query={searchQuery || undefined}
                    onSelectDoc={(doc) => {
                      setSelectedId(p.project_id);
                      setSelectedDoc(doc);
                      setSelectedFolder(null);
                    }}
                    selectedDocId={selectedDoc?.document_id}
                    matchDoc={matches}
                    groupMode={groupMode}
                    onSelectFolder={(node) => {
                      setSelectedId(p.project_id);
                      setSelectedDoc(null);
                      setSelectedFolder({ projectId: p.project_id, node });
                    }}
                    selectedFolderPath={
                      selectedFolder?.projectId === p.project_id
                        ? selectedFolder.node.path
                        : undefined
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 p-1 xl:grid-cols-3">
                {filtered.map((p) => (
                  <button
                    key={p.project_id}
                    type="button"
                    onClick={() => {
                      setSelectedId(p.project_id);
                      setSelectedDoc(null);
                      setSelectedFolder(null);
                    }}
                    className={`flex flex-col items-start gap-2 rounded-2xl border p-4 text-left transition-colors ${
                      selectedId === p.project_id
                        ? 'border-[#7c3aed] bg-[#f2eefb] dark:bg-violet-500/10'
                        : 'border-[var(--color-border)] dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-[#7c3aed]/40'
                    }`}
                  >
                    <Folder
                      className="h-8 w-8"
                      strokeWidth={1.5}
                      style={{ color: colorFor(p) }}
                    />
                    <span className="truncate font-semibold text-[#1a1523] dark:text-slate-100">
                      {p.name}
                    </span>
                    <span className="text-xs text-[#a89fb8]">
                      {t('projects.documentCount', '{{n}} 문서', {
                        n: (docsByProject[p.project_id] || []).length,
                      })}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right panel — document content/summary when a file is selected,
            otherwise the project detail. */}
        {selectedDoc ? (
          <DocumentDetailPanel
            key={selectedDoc.document_id}
            projectId={selectedId}
            doc={selectedDoc}
            highlight={searchQuery || undefined}
            matches={hitSegments[selectedDoc.document_id]}
            onClose={() => setSelectedDoc(null)}
            onDeleted={async () => {
              const pid = selectedId;
              setSelectedDoc(null);
              try {
                const docs = await fetchApi<Document[]>(
                  `projects/${pid}/documents`,
                );
                setDocsByProject((prev) => ({ ...prev, [pid]: docs }));
              } catch (err) {
                console.error('Failed to refresh documents:', err);
              }
            }}
          />
        ) : selectedFolder ? (
          <FolderDetailPanel
            key={selectedFolder.node.path}
            node={selectedFolder.node}
            onClose={() => setSelectedFolder(null)}
            onSelectDoc={(doc) => setSelectedDoc(doc)}
            onDelete={() =>
              setFolderDelete({
                projectId: selectedFolder.projectId,
                node: selectedFolder.node,
                docs: collectDocs(selectedFolder.node),
              })
            }
          />
        ) : selected ? (
          <DetailPanel
            project={selected}
            docs={docsByProject[selected.project_id] || []}
            artifacts={artifacts}
            progress={progressMap}
            uploading={uploadingFromExplorer}
            onOpen={openWorkspace}
            onUpload={() => setShowUploadModal(true)}
            onSettings={() => setEditing(true)}
            onDelete={() => setProjectDelete(selected)}
          />
        ) : null}
      </div>

      <ProjectSettingsModal
        project={null}
        isOpen={creating}
        onClose={() => setCreating(false)}
        onSave={handleCreate}
        isCreating
      />
      <ProjectSettingsModal
        project={selected}
        isOpen={editing}
        onClose={() => setEditing(false)}
        onSave={handleEditSave}
      />
      <DocumentUploadModal
        isOpen={showUploadModal}
        uploading={uploadingFromExplorer}
        projectLanguage={selectedProject?.language || undefined}
        projectDocumentPrompt={selectedProject?.document_prompt || undefined}
        onClose={() => setShowUploadModal(false)}
        onUpload={handleUploadFromExplorer}
        showProjectSelector={true}
        projects={projects}
        selectedProjectId={selectedId}
        onProjectSelect={(id) => setSelectedId(id)}
      />

      {folderDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !deletingFolder && setFolderDelete(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] dark:border-slate-700 bg-white dark:bg-slate-800 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-[#1a1523] dark:text-slate-100">
              <Trash2 className="h-5 w-5 text-red-600" />
              <h3 className="text-base font-semibold">
                {t('projects.deleteFolder', '폴더 삭제')}
              </h3>
            </div>
            <p className="mt-3 text-sm text-[#6b6478] dark:text-slate-400">
              {t(
                'projects.deleteFolderConfirm',
                '"{{name}}" 폴더의 문서 {{n}}개를 삭제합니다. 되돌릴 수 없습니다.',
                { name: folderDelete.node.name, n: folderDelete.docs.length },
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={deletingFolder}
                onClick={() => setFolderDelete(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-[#6b6478] dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
              >
                {t('common.cancel', '취소')}
              </button>
              <button
                type="button"
                disabled={deletingFolder}
                onClick={confirmDeleteFolder}
                className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deletingFolder && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('common.delete', '삭제')}
              </button>
            </div>
          </div>
        </div>
      )}

      {projectDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !deletingProject && setProjectDelete(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] dark:border-slate-700 bg-white dark:bg-slate-800 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-[#1a1523] dark:text-slate-100">
              <Trash2 className="h-5 w-5 text-red-600" />
              <h3 className="text-base font-semibold">
                {t('projects.deleteProject', '프로젝트 삭제')}
              </h3>
            </div>
            <p className="mt-3 text-sm text-[#6b6478] dark:text-slate-400">
              {t(
                'projects.deleteProjectConfirm',
                '"{{name}}" 프로젝트와 그 안의 문서 {{n}}개, 폴더, 인덱스가 모두 삭제됩니다. 되돌릴 수 없습니다.',
                {
                  name: projectDelete.name,
                  n: (docsByProject[projectDelete.project_id] || []).length,
                },
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={deletingProject}
                onClick={() => setProjectDelete(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-[#6b6478] dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
              >
                {t('common.cancel', '취소')}
              </button>
              <button
                type="button"
                disabled={deletingProject}
                onClick={confirmDeleteProject}
                className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deletingProject && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('common.delete', '삭제')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
