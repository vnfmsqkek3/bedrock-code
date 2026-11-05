import { useState, useRef, useCallback, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CloudUpload,
  FolderUp,
  X,
  FileText,
  Loader2,
  ArrowRight,
} from 'lucide-react';
import { useModal } from '../hooks/useModal';

// megazone-idp: advertised + backend pre-checked cap (documents.py:214-216).
const MAX_FILE_SIZE = 500 * 1024 * 1024;

export interface DocumentProcessingOptions {
  use_bda: boolean;
  use_ocr?: boolean;
  use_transcribe?: boolean;
  ocr_model?: string;
  ocr_options?: Record<string, unknown>;
  transcribe_options?: {
    language_mode: 'auto' | 'direct' | 'multi';
    language_code?: string;
    language_options?: string[];
  };
  document_prompt?: string;
  language?: string;
  source_url?: string;
  crawl_instruction?: string;
}

interface DocumentUploadModalProps {
  isOpen: boolean;
  uploading: boolean;
  projectLanguage?: string;
  projectDocumentPrompt?: string;
  onClose: () => void;
  onUpload: (
    files: File[],
    options: DocumentProcessingOptions,
  ) => Promise<void>;
  showProjectSelector?: boolean;
  projects?: Array<{
    project_id: string;
    name: string;
    language?: string | null;
    document_prompt?: string | null;
  }>;
  selectedProjectId?: string;
  onProjectSelect?: (projectId: string) => void;
  projectsLoading?: boolean;
  projectsError?: string | null;
}

export default function DocumentUploadModal({
  isOpen,
  uploading,
  projectLanguage,
  projectDocumentPrompt,
  onClose,
  onUpload,
  showProjectSelector,
  projects,
  selectedProjectId,
  onProjectSelect,
  projectsLoading,
  projectsError,
}: DocumentUploadModalProps) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [oversizeError, setOversizeError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // megazone-idp: separate input for folder upload (preserves webkitRelativePath)
  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  }, []);

  // megazone-idp: enforce the advertised 500MB cap client-side (backend only
  // pre-checks the client-declared size), skipping oversized files with notice.
  const addFiles = useCallback(
    (incoming: File[]) => {
      const ok = incoming.filter((f) => f.size <= MAX_FILE_SIZE);
      const tooBig = incoming.filter((f) => f.size > MAX_FILE_SIZE);
      if (ok.length) setFiles((prev) => [...prev, ...ok]);
      setOversizeError(
        tooBig.length
          ? t('documents.fileTooLarge', {
              names: tooBig.map((f) => f.name).join(', '),
              defaultValue: `Skipped — over 500MB: ${tooBig
                .map((f) => f.name)
                .join(', ')}`,
            })
          : null,
      );
    },
    [t],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length > 0) addFiles(droppedFiles);
    },
    [addFiles],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileArray = Array.from(e.target.files ?? []);
      if (fileArray.length > 0) addFiles(fileArray);
      // Reset the input that fired (works for both file and folder inputs)
      // so re-selecting the same files/folder triggers onChange again.
      e.target.value = '';
    },
    [addFiles],
  );

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleUpload = useCallback(async () => {
    if (files.length === 0) return;
    // R1/F5: AWS/processing options are hidden — always upload with sensible defaults.
    await onUpload(files, {
      use_bda: false,
      use_ocr: true,
      ocr_model: 'pp-ocrv5',
      language: projectLanguage || 'en',
      ...(projectDocumentPrompt?.trim()
        ? { document_prompt: projectDocumentPrompt.trim() }
        : {}),
    });
    setFiles([]);
  }, [files, onUpload, projectLanguage, projectDocumentPrompt]);

  const handleClose = useCallback(() => {
    if (!uploading) {
      setFiles([]);
      setOversizeError(null);
      onClose();
    }
  }, [uploading, onClose]);

  useModal({ isOpen, onClose: handleClose, disableClose: uploading });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/55 dark:bg-black/65 backdrop-blur-md"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="upload-modal-container relative rounded-2xl w-full max-w-lg mx-4 flex flex-col overflow-hidden border border-white/70 dark:border-indigo-500/20 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.15)] dark:shadow-[0_0_80px_rgba(99,102,241,0.08),0_25px_50px_-12px_rgba(0,0,0,0.5)]">
        {/* Gradient glow (light) */}
        <div
          className="dark:hidden absolute inset-0 pointer-events-none rounded-2xl"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 80% 0%, rgba(99, 140, 241, 0.1) 0%, transparent 70%)',
          }}
        />
        <div
          className="hidden dark:block absolute inset-0 pointer-events-none rounded-2xl"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 80% 0%, rgba(99, 102, 241, 0.15) 0%, transparent 70%)',
          }}
        />
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-black/[0.06] dark:border-[#2a2f45] flex-shrink-0">
          <h2 className="text-lg font-semibold text-[#1a1523] dark:text-[#f8fafc]">
            {t('documents.uploadDocuments')}
          </h2>
          <button
            onClick={handleClose}
            disabled={uploading}
            className="p-1.5 hover:bg-white/40 dark:hover:bg-[#1e2235] rounded-lg transition-colors disabled:opacity-50"
          >
            <X className="h-5 w-5 text-[#6b6478]" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* Project Selector (when opened from landing page) */}
          {showProjectSelector && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-[#3a3350] dark:text-[#cbd5e1]">
                {t('documents.selectProject', '프로젝트 선택')}
              </label>
              {projectsLoading ? (
                <div className="flex items-center gap-2 p-2">
                  <Loader2 className="h-4 w-4 animate-spin text-[#6b6478]" />
                  <span className="text-sm text-[#6b6478]">{t('common.loading', 'Loading')}</span>
                </div>
              ) : projectsError ? (
                <p className="text-xs text-[#c0392b] dark:text-red-400">{projectsError}</p>
              ) : (
                <select
                  value={selectedProjectId || ''}
                  onChange={(e) => onProjectSelect?.(e.target.value)}
                  className="w-full p-2.5 rounded-lg border border-black/10 dark:border-[#3b4264] bg-white dark:bg-[#0d1117] text-sm text-[#3a3350] dark:text-[#cbd5e1] focus:outline-none focus:ring-2 focus:ring-[#7c3aed]/30"
                >
                  {projects?.map(p => (
                    <option key={p.project_id} value={p.project_id}>{p.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Drop Zone */}
          <div
            className={`relative border-2 border-dashed rounded-xl transition-colors ${
              isDragging
                ? 'border-[#a78bfa] bg-[#f2eefb] dark:bg-blue-500/10'
                : 'border-black/10 dark:border-[#3b4264] dark:bg-[#0d1117] hover:border-black/20 dark:hover:border-[#4f5680]'
            }`}
            onDragOver={handleDragOver}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <label
              htmlFor="file-upload-input"
              className="flex flex-col items-center justify-center p-8 cursor-pointer"
            >
              <CloudUpload
                className={`h-12 w-12 mb-3 ${
                  isDragging ? 'text-[#7c3aed]' : 'text-[#6b6478]'
                }`}
                strokeWidth={1.5}
              />
              <p
                className={`text-sm font-medium mb-1 ${
                  isDragging
                    ? 'text-[#6d28d9]'
                    : 'text-[#3a3350] dark:text-[#cbd5e1]'
                }`}
              >
                {isDragging
                  ? t('documents.dropHere', 'Drop files here')
                  : t(
                      'documents.dragDrop',
                      'Drag & drop files or click to browse',
                    )}
              </p>
              <p className="text-xs text-[#6b6478] text-center">
                {t('documents.supportedFormats', 'PDF, Images (max 500MB)')}
              </p>
              <input
                id="file-upload-input"
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.html,.htm,.csv,.xlsx,.xls,.png,.jpg,.jpeg,.gif,.tiff,.webp,.dxf"
                className="hidden"
                onChange={handleFileSelect}
                disabled={uploading}
              />
            </label>
          </div>

          {/* megazone-idp: folder upload — preserves the folder structure */}
          <div className="flex justify-center">
            <label
              htmlFor="folder-upload-input"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#3a3350] dark:text-[#cbd5e1] cursor-pointer hover:text-[#7c3aed] dark:hover:text-blue-400"
            >
              <FolderUp className="h-4 w-4" strokeWidth={1.5} />
              {t('documents.uploadFolder', 'Upload a folder (keeps structure)')}
              <input
                id="folder-upload-input"
                ref={folderInputRef}
                type="file"
                className="hidden"
                onChange={handleFileSelect}
                disabled={uploading}
                {...({ webkitdirectory: '', directory: '' } as Record<
                  string,
                  string
                >)}
              />
            </label>
          </div>

          {oversizeError && (
            <p className="text-xs text-center text-[#c0392b] dark:text-red-400">
              {oversizeError}
            </p>
          )}

          {/* Selected Files */}
          {files.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-[#3a3350] dark:text-[#cbd5e1]">
                {t('documents.selectedFiles', 'Selected Files')} ({files.length}
                )
              </p>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {files.map((file, index) => (
                  <div
                    key={`${file.name}-${index}`}
                    className="flex items-center gap-2 p-2 bg-transparent dark:bg-[#0d1117] rounded-lg"
                  >
                    <FileText className="h-4 w-4 text-[#6b6478] flex-shrink-0" />
                    <span className="text-sm text-[#3a3350] dark:text-[#cbd5e1] truncate flex-1">
                      {file.name}
                    </span>
                    <span className="text-xs text-[#6b6478]">
                      {(file.size / 1024 / 1024).toFixed(1)} MB
                    </span>
                    <button
                      onClick={() => removeFile(index)}
                      disabled={uploading}
                      className="p-1 hover:bg-white/50 dark:hover:bg-[#1e2235] rounded transition-colors disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5 text-[#6b6478]" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* megazone-idp: processing pipeline preview — mirrors the actual
              backend flow (type detect → PaddleOCR → Sonnet analysis → embed/graph).
              No audio/video branch: Transcribe is not supported end-to-end. */}
          {files.length > 0 && (
            <div className="rounded-xl border border-[#e7e2db] dark:border-[#2a2f45] bg-[#f7f4fb] dark:bg-[#0d1117] px-3 py-3">
              <p className="text-xs font-medium text-[#7c3aed] dark:text-indigo-300 mb-2.5">
                {t('documents.pipeline', 'Processing pipeline')}
                <span className="text-[#a89fb8] dark:text-slate-500 font-normal">
                  {'  ·  '}
                  {t('documents.pipelineAuto', 'auto-routed')}
                </span>
              </p>
              <div className="flex items-center gap-1 flex-wrap">
                {[
                  {
                    key: 'detect',
                    label: t('documents.pipelineDetect', 'Detect type'),
                    cls: 'border-[#e7e2db] bg-white text-[#3a3350] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200',
                  },
                  {
                    key: 'ocr',
                    label: 'OCR · PaddleOCR',
                    cls: 'border-[#c7d2fe] bg-[#eef2ff] text-[#4f46e5] dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300',
                  },
                  {
                    key: 'analyze',
                    label: t('documents.pipelineAnalyze', 'Analyze · Sonnet'),
                    cls: 'border-[#e9d8fd] bg-[#f2eefb] text-[#7c3aed] dark:border-purple-500/40 dark:bg-purple-500/10 dark:text-purple-300',
                  },
                  {
                    key: 'embed',
                    label: t('documents.pipelineEmbed', 'Embed · Graph'),
                    cls: 'border-[#e7e2db] bg-white text-[#3a3350] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200',
                  },
                ].map((s, i) => (
                  <Fragment key={s.key}>
                    {i > 0 && (
                      <ArrowRight className="h-3.5 w-3.5 text-[#c4bcd4] dark:text-slate-600 flex-shrink-0" />
                    )}
                    <span
                      className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border ${s.cls}`}
                    >
                      {s.label}
                    </span>
                  </Fragment>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-4 border-t border-black/[0.06] dark:border-[#2a2f45] flex-shrink-0">
          <button
            onClick={handleClose}
            disabled={uploading}
            className="px-4 py-2 text-sm font-medium text-[#3a3350] dark:text-[#cbd5e1] hover:bg-[#f1f5f9] dark:hover:bg-[#0d1117] rounded-lg transition-colors disabled:opacity-50 border border-black/10 dark:border-[#3b4264]"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            onClick={handleUpload}
            disabled={files.length === 0 || uploading || (showProjectSelector && !!projectsError)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#7c3aed] hover:bg-[#6d28d9] dark:bg-indigo-600 dark:hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed dark:shadow-[0_0_20px_rgba(99,102,241,0.15)]"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('documents.uploading', 'Uploading...')}
              </>
            ) : (
              <>
                <CloudUpload className="h-4 w-4" />
                {t('documents.upload', 'Upload')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
