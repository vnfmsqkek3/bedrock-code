import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Layers,
  Loader2,
  MoreVertical,
  Trash2,
  Copy,
  Download,
  PanelRightClose,
  RefreshCw,
  Eye,
  Search,
  X,
  Network,
  Sparkles,
} from 'lucide-react';
import ConfirmModal from './ConfirmModal';
import {
  Artifact,
  Document,
  Workflow,
  WorkflowProgress,
} from '../types/project';
import { formatFileSize, getExtensionFromMimeType } from '../lib/fileTypeUtils';
import type { GraphSearchResult } from './ChatPanel/types';

const EXT_COLORS: Record<string, string> = {
  pdf: '#6882A0',
  doc: '#6882A0',
  docx: '#6882A0',
  ppt: '#6882A0',
  pptx: '#6882A0',
  txt: '#6882A0',
  md: '#6882A0',
  xls: '#6A9E7E',
  xlsx: '#6A9E7E',
  csv: '#6A9E7E',
  png: '#8878A0',
  jpg: '#8878A0',
  jpeg: '#8878A0',
  gif: '#8878A0',
  tiff: '#8878A0',
  mp4: '#8878A0',
  mov: '#8878A0',
  mp3: '#8878A0',
  wav: '#8878A0',
  flac: '#8878A0',
  dxf: '#5E9494',
  webreq: '#5E9494',
  web: '#5E9494',
};

const FileTypeBadge = ({ ext }: { ext: string }) => {
  const color = EXT_COLORS[ext] || '#64748B';
  const label = ext.toUpperCase();
  return (
    <svg
      width="20"
      height="24"
      viewBox="0 0 20 24"
      fill="none"
      className="flex-shrink-0"
    >
      <path
        d="M2 1.5C2 .67 2.67 0 3.5 0H13l5 5v17.5c0 .83-.67 1.5-1.5 1.5h-13C2.67 24 2 23.33 2 22.5V1.5z"
        className="ftb-body"
        fill={color}
        stroke={color}
        strokeWidth="0.5"
      />
      <path
        d="M13 0l5 5h-3.5c-.83 0-1.5-.67-1.5-1.5V0z"
        className="ftb-fold"
        fill={color}
      />
      <path
        d="M2 15h16v7.5c0 .83-.67 1.5-1.5 1.5h-13C2.67 24 2 23.33 2 22.5V15z"
        fill={color}
      />
      <text
        x="10"
        y="21.5"
        textAnchor="middle"
        fill="white"
        fontSize={label.length > 3 ? '5.5' : '6.5'}
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {label}
      </text>
    </svg>
  );
};

const ArtifactCircle = ({ ext }: { ext: string }) => {
  const color = EXT_COLORS[ext] || '#64748B';
  const label = ext.toUpperCase();
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      className="flex-shrink-0"
    >
      <circle cx="10" cy="10" r="9.5" fill={color} fillOpacity="0.6" />
      <text
        x="10"
        y="10.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="white"
        fontSize={label.length > 3 ? '4.5' : '5.5'}
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {label}
      </text>
    </svg>
  );
};

const getArtifactBadge = (contentType: string, fileName?: string) => {
  const ext = getExtensionFromMimeType(contentType, fileName);
  return <ArtifactCircle ext={ext || 'file'} />;
};

const getFileIcon = (fileType: string, fileName?: string) => {
  const ext = getExtensionFromMimeType(fileType, fileName);
  return <FileTypeBadge ext={ext ? ext.replace('webreq', 'web') : 'file'} />;
};

const getStatusBadge = (status: string) => {
  const statusColors: Record<string, string> = {
    completed:
      'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-500',
    processing:
      'bg-yellow-50 text-yellow-600 dark:bg-yellow-900/20 dark:text-yellow-500',
    in_progress:
      'bg-[#f2eefb] text-[#6d28d9] dark:bg-blue-900/20 dark:text-blue-500',
    reanalyzing:
      'bg-purple-50 text-purple-600 dark:bg-purple-900/20 dark:text-purple-500',
    failed: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-500',
    uploading:
      'bg-cyan-50 text-cyan-600 dark:bg-cyan-900/20 dark:text-cyan-500',
    uploaded:
      'bg-[#f2eefb] text-[#6d28d9] dark:bg-indigo-900/20 dark:text-indigo-500',
    pending: 'bg-[#f2eefb] text-[#6b6478] dark:bg-white/10 dark:text-slate-500',
  };
  return (
    statusColors[status] ||
    'bg-[#f2eefb] text-[#3a3350] dark:bg-white/10 dark:text-slate-500'
  );
};

function useMouseGlow(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      el.style.setProperty('--glow-x', `${e.clientX - rect.left}px`);
      el.style.setProperty('--glow-y', `${e.clientY - rect.top}px`);
    };
    el.addEventListener('mousemove', onMove);
    return () => el.removeEventListener('mousemove', onMove);
  }, [ref]);
}

function SectionHeader({
  accent,
  icon,
  label,
  children,
}: {
  accent: 'teal' | 'violet';
  icon: React.ReactNode;
  label: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useMouseGlow(ref);

  return (
    <div
      ref={ref}
      className={`section-header section-header--${accent} flex items-center gap-1.5 px-4 py-2.5 flex-shrink-0 min-w-0 overflow-hidden`}
    >
      <span className="section-header__icon">{icon}</span>
      <span className="section-header__label">{label}</span>
      {children}
    </div>
  );
}

type SideTab = 'insights' | 'artifacts' | 'graph';

interface SidePanelProps {
  artifacts?: Artifact[];
  currentArtifactId?: string;
  onArtifactSelect?: (artifactId: string) => void;
  onArtifactCopy?: (artifact: Artifact) => void;
  onArtifactDownload?: (artifact: Artifact) => void;
  onArtifactDelete?: (artifactId: string) => Promise<void>;
  onRefreshArtifacts?: () => void;
  onCollapse?: () => void;
  documents?: Document[];
  workflows?: Workflow[];
  workflowProgressMap?: Record<string, WorkflowProgress>;
  uploading?: boolean;
  onAddDocument?: () => void;
  onRefreshDocuments?: () => void;
  onViewWorkflow?: (documentId: string, workflowId: string) => void;
  onDeleteDocument?: (documentId: string) => void;
  onDeleteAll?: () => void;
  deletingAll?: boolean;
  onViewProjectGraph?: () => void;
  /** Latest knowledge-graph answer (entities + evidence sources) from chat. */
  graphResult?: GraphSearchResult | null;
  /** Open the graph focused on the latest answer. */
  onViewAnswerGraph?: () => void;
}

export default function SidePanel({
  artifacts = [],
  currentArtifactId,
  onArtifactSelect,
  onArtifactCopy,
  onArtifactDownload,
  onArtifactDelete,
  onRefreshArtifacts,
  onCollapse,
  documents = [],
  workflows = [],
  onViewWorkflow,
  onViewProjectGraph,
  graphResult,
  onViewAnswerGraph,
}: SidePanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SideTab>('insights');

  const [openArtifactMenuId, setOpenArtifactMenuId] = useState<string | null>(
    null,
  );
  const [artifactMenuPos, setArtifactMenuPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const [artifactToDelete, setArtifactToDelete] = useState<Artifact | null>(
    null,
  );
  const [deletingArtifactId, setDeletingArtifactId] = useState<string | null>(
    null,
  );

  // Artifact search state
  const [artSearchOpen, setArtSearchOpen] = useState(false);
  const [artSearchQuery, setArtSearchQuery] = useState('');
  const artInputRef = useRef<HTMLInputElement>(null);
  const artComposing = useRef(false);

  const filteredArtifacts = useMemo(() => {
    if (!artSearchQuery) return artifacts;
    const q = artSearchQuery.normalize('NFC').toLowerCase();
    return artifacts.filter((a) =>
      a.filename.normalize('NFC').toLowerCase().includes(q),
    );
  }, [artifacts, artSearchQuery]);

  // Insights are driven ONLY by the latest chat answer's knowledge-graph result
  // (entities + evidence sources). Nothing shows until the user asks something —
  // we intentionally do NOT fall back to the full document list.
  const answerEntities = graphResult?.entities ?? [];
  // Evidence documents with the specific page(s) each was cited from.
  const answerSourceDocs = useMemo(() => {
    if (!graphResult?.sources?.length)
      return [] as { doc: Document; pages: number[] }[];
    const pagesByDoc = new Map<string, Set<number>>();
    for (const s of graphResult.sources) {
      if (!pagesByDoc.has(s.document_id))
        pagesByDoc.set(s.document_id, new Set());
      if (typeof s.segment_index === 'number')
        pagesByDoc.get(s.document_id)!.add(s.segment_index + 1);
    }
    return [...pagesByDoc.entries()]
      .map(([id, pages]) => {
        const doc = documents.find((d) => d.document_id === id);
        return doc
          ? { doc, pages: [...pages].sort((a, b) => a - b) }
          : null;
      })
      .filter((x): x is { doc: Document; pages: number[] } => !!x);
  }, [graphResult, documents]);

  const openDoc = useCallback(
    (doc: Document) => {
      const wf = workflows.find((w) => w.document_id === doc.document_id);
      if (wf && onViewWorkflow) onViewWorkflow(doc.document_id, wf.workflow_id);
    },
    [workflows, onViewWorkflow],
  );

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-artifact-menu]')) {
        setOpenArtifactMenuId(null);
        setArtifactMenuPos(null);
      }
    };

    if (openArtifactMenuId) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [openArtifactMenuId]);

  const hasArtifactActions =
    onArtifactCopy || onArtifactDownload || onArtifactDelete;

  const handleArtifactMenuToggle = (
    artifactId: string,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    if (openArtifactMenuId === artifactId) {
      setOpenArtifactMenuId(null);
      setArtifactMenuPos(null);
    } else {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setArtifactMenuPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
      setOpenArtifactMenuId(artifactId);
    }
  };

  const handleArtifactCopyClick = (artifact: Artifact) => {
    setOpenArtifactMenuId(null);
    setArtifactMenuPos(null);
    onArtifactCopy?.(artifact);
  };

  const handleArtifactDownloadClick = (artifact: Artifact) => {
    setOpenArtifactMenuId(null);
    setArtifactMenuPos(null);
    onArtifactDownload?.(artifact);
  };

  const handleArtifactDeleteClick = (artifact: Artifact) => {
    setOpenArtifactMenuId(null);
    setArtifactMenuPos(null);
    setArtifactToDelete(artifact);
  };

  const handleConfirmArtifactDelete = async () => {
    if (!artifactToDelete || !onArtifactDelete) return;

    setDeletingArtifactId(artifactToDelete.artifact_id);
    try {
      await onArtifactDelete(artifactToDelete.artifact_id);
    } catch (error) {
      console.error('Failed to delete artifact:', error);
    } finally {
      setDeletingArtifactId(null);
      setArtifactToDelete(null);
    }
  };

  const TABS: { id: SideTab; label: string }[] = [
    { id: 'insights', label: t('sidepanel.insights', '인사이트') },
    { id: 'artifacts', label: t('chat.artifacts', '아티팩트') },
    { id: 'graph', label: t('sidepanel.graph', '그래프') },
  ];

  return (
    <>
      <div className="h-full flex flex-col bg-[var(--color-panel)]">
        {/* Tab bar (accent underline on active, screenshot 1c style) */}
        <div className="flex items-center gap-1 px-2 h-11 border-b border-[var(--color-border)] flex-shrink-0">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`relative px-2.5 h-11 text-xs font-medium transition-colors ${
                tab === id
                  ? 'text-[#7c3aed] dark:text-blue-400'
                  : 'text-[#6b6478] hover:text-[#3a3350] dark:hover:text-slate-300'
              }`}
            >
              {label}
              {tab === id && (
                <span className="absolute left-1.5 right-1.5 bottom-0 h-0.5 rounded-full bg-[#7c3aed] dark:bg-blue-400" />
              )}
            </button>
          ))}
          <div className="flex-1" />
          {tab === 'artifacts' && (
            <>
              <button
                onClick={() => {
                  setArtSearchOpen((v) => !v);
                  if (artSearchOpen) {
                    setArtSearchQuery('');
                    if (artInputRef.current) artInputRef.current.value = '';
                  }
                }}
                className={`p-1 rounded transition-colors flex-shrink-0 ${
                  artSearchOpen
                    ? 'text-[#7c3aed] bg-[#f2eefb] dark:bg-violet-900/30'
                    : 'text-[#a89fb8] hover:text-[#3a3350] dark:hover:text-slate-300 hover:bg-[#f2eefb] dark:hover:bg-white/10'
                }`}
                title={t('common.search')}
              >
                <Search className="h-3.5 w-3.5" />
              </button>
              {onRefreshArtifacts && (
                <button
                  onClick={onRefreshArtifacts}
                  className="p-1 text-[#a89fb8] hover:text-[#3a3350] dark:hover:text-slate-300 hover:bg-[#f2eefb] dark:hover:bg-white/10 rounded transition-colors flex-shrink-0"
                  title={t('artifacts.refresh', 'Refresh')}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          )}
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="p-1 text-[#a89fb8] hover:text-[#3a3350] dark:hover:text-slate-300 hover:bg-[#f2eefb] dark:hover:bg-white/10 rounded transition-colors flex-shrink-0"
              title={t('nav.collapse')}
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* INSIGHTS TAB */}
        {tab === 'insights' && (
          <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-4">
            {/* 관련 엔터티 */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="h-3.5 w-3.5 text-[#7c3aed]" />
                <span className="text-xs font-semibold text-[#3a3350] dark:text-slate-200">
                  {t('sidepanel.relatedEntities', '관련 엔터티')}
                </span>
              </div>
              {answerEntities.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {answerEntities.map((e, i) => (
                    <span
                      key={`${e.name}-${i}`}
                      title={e.description || undefined}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium bg-[#f2eefb] text-[#6d28d9] dark:bg-blue-900/20 dark:text-blue-300"
                    >
                      {e.name}
                      {e.type && (
                        <span className="text-[10px] text-[#a89fb8] dark:text-blue-400/70">
                          {e.type}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[#a89fb8] px-1 py-2">
                  {t('sidepanel.noEntities', '질문하면 관련 엔터티가 표시됩니다')}
                </p>
              )}
            </div>

            {/* 근거 문서 */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-xs font-semibold text-[#3a3350] dark:text-slate-200">
                  {t('sidepanel.evidenceDocs', '근거 문서')}
                </span>
                <span className="text-[11px] text-[#a89fb8]">
                  {answerSourceDocs.length}
                </span>
              </div>
              {answerSourceDocs.length === 0 ? (
                <p className="text-xs text-[#a89fb8] px-1 py-2">
                  {t('sidepanel.noEvidence', '질문하면 근거 문서가 표시됩니다')}
                </p>
              ) : (
                <div className="space-y-1">
                  {answerSourceDocs.map(({ doc, pages }) => {
                    const hasWorkflow = workflows.some(
                      (w) => w.document_id === doc.document_id,
                    );
                    return (
                      <button
                        key={doc.document_id}
                        type="button"
                        onClick={() => openDoc(doc)}
                        disabled={!hasWorkflow}
                        className="group w-full flex items-center gap-2 px-2 py-2 rounded-lg border border-[#ece9f0] dark:border-white/[0.08] bg-white dark:bg-white/[0.03] hover:border-[#e4dfec] dark:hover:border-white/20 hover:bg-[#f2eefb]/50 dark:hover:bg-white/[0.06] transition-all text-left disabled:opacity-60 disabled:cursor-default"
                      >
                        <div className="flex-shrink-0 p-1.5 rounded-lg doc-icon-bg">
                          {getFileIcon(doc.file_type, doc.name)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p
                            className="text-xs font-medium text-[#1a1523] dark:text-slate-200 truncate"
                            title={doc.name}
                          >
                            {doc.name}
                          </p>
                          <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                            <span
                              className={`inline-block text-[10px] px-1 py-0.5 rounded font-medium ${getStatusBadge(doc.status)}`}
                            >
                              {t(`documents.${doc.status}`, doc.status)}
                            </span>
                            {pages.length > 0 && (
                              <span
                                className="inline-block text-[10px] px-1.5 py-0.5 rounded font-medium bg-[#f2eefb] text-[#6d28d9] dark:bg-violet-500/15 dark:text-violet-300"
                                title={t('sidepanel.evidencePages', '근거 페이지')}
                              >
                                {t('sidepanel.pageAbbr', 'p.')}
                                {pages.slice(0, 5).join(', ')}
                                {pages.length > 5 ? '…' : ''}
                              </span>
                            )}
                          </div>
                        </div>
                        {hasWorkflow && (
                          <Eye className="h-3.5 w-3.5 text-[#a89fb8] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ARTIFACTS TAB */}
        {tab === 'artifacts' && (
          <div className="flex-1 flex flex-col min-h-0">
            <SectionHeader
              accent="violet"
              icon={<Layers className="w-4 h-4" />}
              label={t('chat.artifacts', 'Artifacts')}
            >
              <div className="flex-1" />
              <span className="text-xs text-[#a89fb8]">
                {artSearchQuery
                  ? `${filteredArtifacts.length}/${artifacts.length}`
                  : artifacts.length}
              </span>
            </SectionHeader>

            {/* Artifacts Search Toolbar */}
            {artSearchOpen && (
              <div className="px-3 py-2 bg-[#faf9fb] dark:bg-white/[0.03] border-b border-[#f0ecf7] dark:border-white/[0.08] flex-shrink-0">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[#a89fb8]" />
                  <input
                    ref={artInputRef}
                    type="text"
                    defaultValue=""
                    onChange={(e) => {
                      if (!artComposing.current) {
                        setArtSearchQuery(e.target.value);
                      }
                    }}
                    onCompositionStart={() => {
                      artComposing.current = true;
                    }}
                    onCompositionEnd={(e) => {
                      artComposing.current = false;
                      setArtSearchQuery((e.target as HTMLInputElement).value);
                    }}
                    placeholder={t('artifacts.searchPlaceholder')}
                    className="w-full h-7 pl-7 pr-7 text-xs rounded-md border border-[#e4dfec] dark:border-white/[0.12] bg-white dark:bg-white/[0.06] text-[#3a3350] dark:text-slate-200 placeholder:text-[#a89fb8] focus:outline-none focus:ring-1 focus:ring-[#a78bfa]"
                  />
                  {artSearchQuery && (
                    <button
                      onClick={() => {
                        setArtSearchQuery('');
                        if (artInputRef.current) artInputRef.current.value = '';
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[#a89fb8] hover:text-[#3a3350] dark:hover:text-slate-300"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Artifacts List */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {artifacts.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full px-4">
                  <Layers className="w-8 h-8 mb-2 text-[#e4dfec] dark:text-slate-500" />
                  <p className="text-xs text-[#6b6478]">
                    {t('chat.noArtifacts', 'No artifacts yet')}
                  </p>
                </div>
              ) : filteredArtifacts.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full px-4">
                  <Search className="w-8 h-8 mb-2 text-[#e4dfec] dark:text-slate-500" />
                  <p className="text-xs text-[#6b6478]">
                    {t('artifacts.noMatchingArtifacts')}
                  </p>
                </div>
              ) : (
                <div className="p-2 pb-3 space-y-1">
                  {filteredArtifacts.map((artifact) => {
                    return (
                      <div
                        key={artifact.artifact_id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            'application/x-artifact',
                            JSON.stringify({
                              artifact_id: artifact.artifact_id,
                              filename: artifact.filename,
                              s3_bucket: artifact.s3_bucket,
                              s3_key: artifact.s3_key,
                            }),
                          );
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        className={`group relative flex items-center gap-2 px-3 py-2 rounded-lg border transition-all cursor-pointer ${
                          artifact.artifact_id === currentArtifactId
                            ? 'bg-[#f2eefb] dark:bg-blue-900/30 border-[#e4dfec] dark:border-blue-500/30 shadow-sm text-[#6d28d9] font-semibold dark:text-blue-400'
                            : 'bg-[#faf9fb] dark:bg-white/[0.03] border-[#ece9f0] dark:border-white/[0.08] hover:bg-[#f2eefb] dark:hover:bg-white/[0.06] hover:border-[#e4dfec] dark:hover:border-white/20 hover:shadow-sm text-[#3a3350] dark:text-slate-300'
                        }`}
                        onClick={() => onArtifactSelect?.(artifact.artifact_id)}
                      >
                        {getArtifactBadge(
                          artifact.content_type,
                          artifact.filename,
                        )}
                        <span className="text-sm truncate flex-1">
                          {artifact.filename}
                        </span>
                        <span className="text-xs text-[#a89fb8] dark:text-slate-500">
                          {formatFileSize(artifact.file_size)}
                        </span>

                        {hasArtifactActions && (
                          <div className="relative" data-artifact-menu>
                            <button
                              onClick={(e) =>
                                handleArtifactMenuToggle(
                                  artifact.artifact_id,
                                  e,
                                )
                              }
                              className={`p-1 rounded transition-opacity ${
                                openArtifactMenuId === artifact.artifact_id
                                  ? 'opacity-100'
                                  : 'opacity-0 group-hover:opacity-100'
                              } text-[#a89fb8] hover:text-[#3a3350] dark:hover:text-slate-300 hover:bg-[#f2eefb] dark:hover:bg-white/10`}
                            >
                              {deletingArtifactId === artifact.artifact_id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <MoreVertical className="w-3.5 h-3.5" />
                              )}
                            </button>

                            {openArtifactMenuId === artifact.artifact_id &&
                              artifactMenuPos &&
                              createPortal(
                                <div
                                  className="fixed z-[9999] min-w-[150px] bg-white dark:bg-slate-800 border border-[#ece9f0] dark:border-white/[0.15] rounded-lg shadow-[0_10px_30px_-8px_rgba(60,40,100,0.25)] py-1"
                                  style={{
                                    top: artifactMenuPos.top,
                                    right: artifactMenuPos.right,
                                  }}
                                  data-artifact-menu
                                >
                                  {onArtifactCopy && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleArtifactCopyClick(artifact);
                                      }}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-[#3a3350] dark:text-slate-300 glass-menu-item"
                                    >
                                      <Copy className="w-3.5 h-3.5" />
                                      {t('common.copy', 'Copy')}
                                    </button>
                                  )}
                                  {onArtifactDownload && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleArtifactDownloadClick(artifact);
                                      }}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-[#3a3350] dark:text-slate-300 glass-menu-item"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                      {t('common.download', 'Download')}
                                    </button>
                                  )}
                                  {onArtifactDelete && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleArtifactDeleteClick(artifact);
                                      }}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                      {t('common.delete')}
                                    </button>
                                  )}
                                </div>,
                                document.body,
                              )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* GRAPH TAB */}
        {tab === 'graph' && (
          <div className="flex-1 overflow-y-auto min-h-0 p-4 flex flex-col items-center justify-center text-center gap-3">
            <Network className="w-10 h-10 text-[#c9bde6] dark:text-slate-500" />
            <p className="text-xs text-[#6b6478] max-w-[220px]">
              {t(
                'sidepanel.graphHint',
                '문서 간 지식 그래프에서 엔터티와 관계를 살펴보세요.',
              )}
            </p>
            {graphResult && onViewAnswerGraph && (
              <button
                type="button"
                onClick={onViewAnswerGraph}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-[#7c3aed] hover:bg-[#6d28d9] transition-colors"
              >
                <Network className="h-3.5 w-3.5" />
                {t('sidepanel.viewAnswerGraph', '이 답변의 그래프 보기')}
                {graphResult.entities?.length ? (
                  <span className="text-[10px] opacity-80">
                    {graphResult.entities.length}
                  </span>
                ) : null}
              </button>
            )}
            {onViewProjectGraph ? (
              <button
                type="button"
                onClick={onViewProjectGraph}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white bg-[#7c3aed] hover:bg-[#6d28d9] transition-colors"
              >
                <Network className="h-3.5 w-3.5" />
                {t('workflow.graph.title', 'Knowledge Graph')}
              </button>
            ) : (
              <p className="text-[11px] text-[#a89fb8]">
                {t('sidepanel.graphUnavailable', '그래프를 사용할 수 없습니다')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Delete Artifact Confirmation Modal */}
      <ConfirmModal
        isOpen={!!artifactToDelete}
        onClose={() => setArtifactToDelete(null)}
        onConfirm={handleConfirmArtifactDelete}
        title={t('chat.deleteArtifact', 'Delete Artifact')}
        message={t(
          'chat.deleteArtifactConfirm',
          'Are you sure you want to delete this artifact? This action cannot be undone.',
        )}
        confirmText={t('common.delete')}
        variant="danger"
      />
    </>
  );
}
