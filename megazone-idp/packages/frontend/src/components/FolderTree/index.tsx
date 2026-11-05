import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderOpen, FileText, FileSpreadsheet, Image, File, Presentation, Trash2 } from 'lucide-react';
import type { Document } from '../../types/project';

export type FolderTreeMode = 'folder' | 'category';

export interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  docs: Document[];
}

const UNCATEGORIZED = '미분류';

/** Returns a colored icon element based on document file extension. */
function getDocIcon(fileName: string): React.ReactElement {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  switch (ext) {
    case 'pdf':
      return <FileText className="h-4 w-4 shrink-0 text-red-500" strokeWidth={1.5} />;
    case 'doc':
    case 'docx':
      return <FileText className="h-4 w-4 shrink-0 text-blue-500" strokeWidth={1.5} />;
    case 'xls':
    case 'xlsx':
    case 'csv':
      return <FileSpreadsheet className="h-4 w-4 shrink-0 text-green-600" strokeWidth={1.5} />;
    case 'ppt':
    case 'pptx':
      return <Presentation className="h-4 w-4 shrink-0 text-orange-500" strokeWidth={1.5} />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'tiff':
    case 'webp':
      return <Image className="h-4 w-4 shrink-0 text-purple-500" strokeWidth={1.5} />;
    case 'txt':
    case 'md':
    case 'html':
    case 'htm':
      return <FileText className="h-4 w-4 shrink-0 text-slate-400" strokeWidth={1.5} />;
    case 'dxf':
      return <File className="h-4 w-4 shrink-0 text-teal-500" strokeWidth={1.5} />;
    default:
      return <FileText className="h-4 w-4 shrink-0 text-slate-400" strokeWidth={1.5} />;
  }
}

/**
 * megazone-idp: build a nested folder tree from a document list.
 * mode='folder'   → groups by the uploaded relative path (folder_path)
 * mode='category' → groups by the auto-classified path (category_path)
 * Documents with no path land under an "미분류" root folder.
 * Exported (and pure) so it can be unit-tested independently of React.
 */
export function buildDocTree(
  documents: Document[],
  mode: FolderTreeMode,
): TreeNode {
  const root: TreeNode = {
    name: '',
    path: '',
    children: new Map(),
    docs: [],
  };

  for (const doc of documents) {
    const raw = (mode === 'category' ? doc.category_path : doc.folder_path) || '';
    const parts = raw
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean);
    const segments = parts.length ? parts : [UNCATEGORIZED];

    let node = root;
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, path: acc, children: new Map(), docs: [] };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.docs.push(doc);
  }

  return root;
}

/** Count documents in a subtree (for the folder badge). */
export function countDocs(node: TreeNode): number {
  let n = node.docs.length;
  for (const child of node.children.values()) n += countDocs(child);
  return n;
}

/** Flatten every document in a subtree (for folder-level delete). */
export function collectDocs(node: TreeNode): Document[] {
  const out = [...node.docs];
  for (const child of node.children.values()) out.push(...collectDocs(child));
  return out;
}

interface FolderTreeProps {
  documents: Document[];
  mode: FolderTreeMode;
  selectedDocumentId?: string | null;
  onSelectDocument?: (doc: Document) => void;
  /** Called when a folder node is clicked (e.g. to scope chat to that folder). */
  onSelectFolder?: (path: string) => void;
  /** Called with the folder node to delete (all documents in its subtree). */
  onDeleteFolder?: (node: TreeNode) => void;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return Array.from(node.children.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function FolderRow({
  node,
  depth,
  selectedDocumentId,
  onSelectDocument,
  onSelectFolder,
  onDeleteFolder,
}: {
  node: TreeNode;
  depth: number;
  selectedDocumentId?: string | null;
  onSelectDocument?: (doc: Document) => void;
  onSelectFolder?: (path: string) => void;
  onDeleteFolder?: (node: TreeNode) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(depth < 1);
  const pad = { paddingLeft: `${depth * 14 + 8}px` };

  return (
    <div>
      <div
        style={pad}
        className="group flex items-center rounded pr-1 hover:bg-black/5 dark:hover:bg-white/5"
      >
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            onSelectFolder?.(node.path);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-sm text-[#334155] dark:text-[#cbd5e1]"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          {open ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" strokeWidth={1.5} />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-amber-500" strokeWidth={1.5} />
          )}
          <span className="truncate">{node.name}</span>
          <span className="ml-auto pl-2 text-xs text-[#94a3b8]">{countDocs(node)}</span>
        </button>
        {onDeleteFolder && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteFolder(node);
            }}
            title={t('projects.deleteFolder', '폴더 삭제')}
            className="ml-1 shrink-0 rounded p-1 text-[#94a3b8] hover:bg-black/5 hover:text-red-600 dark:hover:bg-white/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div>
          {sortedChildren(node).map((child) => (
            <FolderRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedDocumentId={selectedDocumentId}
              onSelectDocument={onSelectDocument}
              onSelectFolder={onSelectFolder}
              onDeleteFolder={onDeleteFolder}
            />
          ))}
          {node.docs.map((doc) => (
            <button
              key={doc.document_id}
              type="button"
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
              onClick={() => onSelectDocument?.(doc)}
              className={`flex w-full items-center gap-1.5 py-1.5 pr-2 text-sm rounded hover:bg-black/5 dark:hover:bg-white/5 ${
                selectedDocumentId === doc.document_id
                  ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300'
                  : 'text-[#475569] dark:text-[#94a3b8]'
              }`}
            >
              {getDocIcon(doc.name)}
              <span className="truncate">{doc.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FolderTree({
  documents,
  mode,
  selectedDocumentId,
  onSelectDocument,
  onSelectFolder,
  onDeleteFolder,
}: FolderTreeProps) {
  const root = useMemo(() => buildDocTree(documents, mode), [documents, mode]);
  const topLevel = sortedChildren(root);

  if (documents.length === 0) return null;

  return (
    <div className="space-y-0.5">
      {topLevel.map((node) => (
        <FolderRow
          key={node.path}
          node={node}
          depth={0}
          selectedDocumentId={selectedDocumentId}
          onSelectDocument={onSelectDocument}
          onSelectFolder={onSelectFolder}
          onDeleteFolder={onDeleteFolder}
        />
      ))}
      {/* documents attached directly to root (shouldn't normally happen) */}
      {root.docs.map((doc) => (
        <button
          key={doc.document_id}
          type="button"
          onClick={() => onSelectDocument?.(doc)}
          className="flex w-full items-center gap-1.5 py-1.5 px-2 text-sm text-[#475569] dark:text-[#94a3b8] rounded hover:bg-black/5 dark:hover:bg-white/5"
        >
          {getDocIcon(doc.name)}
          <span className="truncate">{doc.name}</span>
        </button>
      ))}
    </div>
  );
}
