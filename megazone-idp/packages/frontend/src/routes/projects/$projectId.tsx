import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { nanoid } from 'nanoid';
import { Plus, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import FolderTree, { collectDocs, type TreeNode } from '../../components/FolderTree';
import { useAwsClient } from '../../hooks/useAwsClient';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useChatPanel } from '../../contexts/ChatPanelContext';
import CubeLoader from '../../components/CubeLoader';
import ConfirmModal from '../../components/ConfirmModal';
import ProjectSettingsModal, {
  CARD_COLORS,
} from '../../components/ProjectSettingsModal';
import ProjectNavBar from '../../components/ProjectNavBar';
import ChatPanel, { type AttachedFile } from '../../components/ChatPanel';
import SidePanel from '../../components/SidePanel';
import WorkflowDetailModal from '../../components/WorkflowDetailModal';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '../../components/ui/resizable';
import AgentSelectModal from '../../components/AgentSelectModal';
import DocumentUploadModal from '../../components/DocumentUploadModal';
import ArtifactViewer from '../../components/ArtifactViewer';
import SystemPromptModal from '../../components/SystemPromptModal';
import ProjectGraphModal from '../../components/ProjectGraphModal';
import GraphSearchResultModal from '../../components/GraphSearchResultModal';
import type { GraphSearchResult } from '../../components/ChatPanel/types';
import { useSetSidebarSessions } from '../../contexts/SidebarSessionContext';

// Custom hooks
import { useProjectData } from '../../hooks/useProjectData';
import { usePanelLayout } from '../../hooks/usePanelLayout';
import { useSystemPrompts } from '../../hooks/useSystemPrompts';
import { useChatSession } from '../../hooks/useChatSession';
import { useAgents } from '../../hooks/useAgents';
import { useArtifacts } from '../../hooks/useArtifacts';
import { useDocuments } from '../../hooks/useDocuments';

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectDetailPage,
});

function ProjectDetailPage() {
  const { t } = useTranslation();
  const { projectId } = Route.useParams();
  const { fetchApi, getPresignedDownloadUrl } = useAwsClient();
  const { sendMessage, status: wsStatus } = useWebSocket();
  const { isChatOpen } = useChatPanel();

  // --- Hook initialization (respecting dependency order) ---

  // 1. Independent hooks
  const projectData = useProjectData({ fetchApi, projectId });
  const panelLayout = usePanelLayout();
  const { systemPromptTabs } = useSystemPrompts({ fetchApi });

  // 2. Chat session (provides handleNewSession, setMessages, setStreamingBlocks)
  const chatSession = useChatSession({ projectId });

  // 3. Agents (needs handleNewSession)
  const agentsHook = useAgents({
    fetchApi,
    projectId,
    onNewSession: useCallback(() => {
      chatSession.handleNewSession();
      agentsHook_setSelectedAgent(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatSession.handleNewSession]),
  });

  // Workaround: we need a stable reference for the agent setter
  // that is used in the onNewSession callback above.
  // Since useAgents returns setSelectedAgent, we keep a local alias.
  const agentsHook_setSelectedAgent = agentsHook.setSelectedAgent;

  // 5. Artifacts (needs panel layout)
  const artifactsHook = useArtifacts({
    fetchApi,
    getPresignedDownloadUrl,
    projectId,
    sidePanelCollapsed: panelLayout.sidePanelCollapsed,
    setSidePanelCollapsed: panelLayout.setSidePanelCollapsed,
  });

  // 6. Documents (needs wsStatus)
  const documentsHook = useDocuments({
    fetchApi,
    projectId,
    wsStatus,
  });

  // --- System prompt modal state ---
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [showProjectGraph, setShowProjectGraph] = useState(false);
  // Latest knowledge-graph answer from chat (drives Insights + answer graph).
  const [answerGraph, setAnswerGraph] = useState<GraphSearchResult | null>(null);
  const [answerGraphOpen, setAnswerGraphOpen] = useState(false);

  // --- Left document-tree zone (Workbench 3-zone); open by default ---
  const [docTreeCollapsed, setDocTreeCollapsed] = useState(
    () => localStorage.getItem('idp-doctree-collapsed') === 'true',
  );
  const [docTreeSearch, setDocTreeSearch] = useState('');

  // --- Folder delete: no backend folder entity, so fan out one document
  // delete per doc in the selected folder subtree, then reload. ---
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<TreeNode | null>(
    null,
  );
  const [deletingFolder, setDeletingFolder] = useState(false);
  const confirmDeleteFolder = useCallback(async () => {
    if (!folderDeleteTarget) return;
    setDeletingFolder(true);
    try {
      await Promise.allSettled(
        collectDocs(folderDeleteTarget).map((d) =>
          fetchApi(`projects/${projectId}/documents/${d.document_id}`, {
            method: 'DELETE',
          }),
        ),
      );
      await documentsHook.loadDocuments();
      setFolderDeleteTarget(null);
    } catch (err) {
      console.error('Failed to delete folder:', err);
    } finally {
      setDeletingFolder(false);
    }
  }, [folderDeleteTarget, fetchApi, projectId, documentsHook.loadDocuments]);

  const toggleDocTree = useCallback(() => {
    setDocTreeCollapsed((v) => {
      const next = !v;
      localStorage.setItem('idp-doctree-collapsed', String(next));
      return next;
    });
  }, []);

  // --- Subscribe to project WebSocket notifications ---
  useEffect(() => {
    if (wsStatus === 'connected') {
      sendMessage({ action: 'subscribe', projectId });
    }
  }, [projectId, sendMessage, wsStatus]);

  // --- Reset chat state when project changes ---
  useEffect(() => {
    chatSession.setCurrentSessionId(nanoid(33));
    chatSession.setMessages([]);
    chatSession.setInputMessage('');
    chatSession.setSending(false);
    chatSession.setStreamingBlocks([]);
    agentsHook.setSelectedAgent(null);
    artifactsHook.setSelectedArtifact(null);
    chatSession.pendingMessagesRef.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // --- Initial data load ---
  useEffect(() => {
    const load = async () => {
      projectData.setLoading(true);
      await Promise.all([
        projectData.loadProject(),
        documentsHook.loadDocuments(),
        documentsHook.loadWorkflows(),
        chatSession.loadSessions(),
        agentsHook.loadAgents(),
        artifactsHook.loadArtifacts(),
      ]);
      projectData.setLoading(false);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectData.loadProject,
    documentsHook.loadDocuments,
    documentsHook.loadWorkflows,
    chatSession.loadSessions,
    agentsHook.loadAgents,
    artifactsHook.loadArtifacts,
  ]);

  // Fetch real step progress for in-progress workflows on page load (once)
  useEffect(() => {
    documentsHook.fetchProgressOnLoad(projectData.loading);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectData.loading, documentsHook.fetchProgressOnLoad]);

  // --- Ctrl+Shift+S keyboard shortcut for system prompt modal ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyS') {
        e.preventDefault();
        setShowSystemPrompt(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // --- Wrapped callbacks for ChatPanel/Sidebar compatibility ---

  // handleNewSession that also resets voice/agent state
  const handleNewSession = useCallback(() => {
    chatSession.handleNewSession();
    agentsHook.setSelectedAgent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSession.handleNewSession]);

  // handleSessionSelect with agent/voice context
  const handleSessionSelect = useCallback(
    (sessionId: string) => {
      chatSession.handleSessionSelect(sessionId, {
        agents: agentsHook.agents,
        setSelectedAgent: agentsHook.setSelectedAgent,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatSession.handleSessionSelect, agentsHook.agents],
  );

  // handleSessionDelete with voice/agent context
  const handleSessionDelete = useCallback(
    async (sessionId: string) => {
      await chatSession.handleSessionDelete(sessionId, {
        setSelectedAgent: agentsHook.setSelectedAgent,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatSession.handleSessionDelete],
  );

  // handleSendMessage wrapper passing selectedAgent
  const handleSendMessage = useCallback(
    (files: AttachedFile[], message?: string) => {
      chatSession.handleSendMessage(files, message, agentsHook.selectedAgent);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatSession.handleSendMessage, agentsHook.selectedAgent],
  );

  // --- Sidebar sessions sync ---
  useSetSidebarSessions(
    useMemo(
      () => ({
        sessions: chatSession.sessions,
        currentSessionId: chatSession.currentSessionId,
        onSessionSelect: handleSessionSelect,
        onSessionRename: chatSession.handleSessionRename,
        onSessionDelete: handleSessionDelete,
        onNewSession: handleNewSession,
        hasMoreSessions: !!chatSession.sessionsNextCursor,
        loadingMoreSessions: chatSession.loadingMoreSessions,
        onLoadMoreSessions: chatSession.loadMoreSessions,
      }),
      [
        chatSession.sessions,
        chatSession.currentSessionId,
        handleSessionSelect,
        chatSession.handleSessionRename,
        handleSessionDelete,
        handleNewSession,
        chatSession.sessionsNextCursor,
        chatSession.loadingMoreSessions,
        chatSession.loadMoreSessions,
      ],
    ),
  );

  // --- Render ---

  const projectColorObj =
    CARD_COLORS[(projectData.project?.color ?? 0) % CARD_COLORS.length] ||
    CARD_COLORS[0];

  if (projectData.loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <CubeLoader />
      </div>
    );
  }

  if (!projectData.project) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <div className="text-[#6b6478]">{t('projects.notFound')}</div>
        <Link
          to="/"
          className="text-[#7c3aed] hover:text-[#6d28d9] hover:underline"
        >
          {t('projects.backToProjects')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* Ambient background glow (dark mode) */}
      <div
        className="absolute inset-0 hidden dark:block pointer-events-none"
        style={{
          background: `radial-gradient(ellipse 800px 400px at 50% 0%, ${projectColorObj.glow}, transparent)`,
        }}
      />

      {/* Navigation Bar */}
      <ProjectNavBar
        project={projectData.project}
        onSettingsClick={() => projectData.setShowProjectSettings(true)}
      />

      {/* Main Content - 3-Zone Workbench: [Doc Tree] · [Chat | Insights] */}
      <div className="flex-1 min-h-0 flex">
        {/* Left - Document tree zone (hidden on the AI chat page) */}
        {!isChatOpen && (
          <aside
            className={`shrink-0 h-full flex flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)] transition-[width] duration-200 ${
              docTreeCollapsed ? 'w-11' : 'w-64'
            }`}
          >
          {docTreeCollapsed ? (
            <button
              type="button"
              onClick={toggleDocTree}
              title={t('documents.title', 'Documents')}
              className="flex flex-col items-center gap-2 pt-3.5 text-[#6b6478] hover:text-[#7c3aed] transition-colors"
            >
              <PanelLeftOpen className="h-5 w-5" />
              <span className="text-[10px] [writing-mode:vertical-rl] tracking-wide">
                {t('documents.title', 'Documents')} ·{' '}
                {documentsHook.documents.length}
              </span>
            </button>
          ) : (
            <>
              <div className="flex items-center justify-between px-3 h-11 border-b border-[var(--color-border)] shrink-0">
                <span className="text-xs font-semibold text-[#3a3350] dark:text-slate-200 tracking-wide">
                  {t('documents.title', 'Documents')}
                  <span className="ml-1.5 font-normal text-[#a89fb8]">
                    {documentsHook.documents.length}
                  </span>
                </span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => documentsHook.setShowUploadModal(true)}
                    title={t('documents.uploadDocuments', 'Upload')}
                    className="p-1 rounded text-[#6b6478] hover:text-[#7c3aed] hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={toggleDocTree}
                    title={t('nav.collapse', 'Collapse')}
                    className="p-1 rounded text-[#6b6478] hover:text-[#7c3aed] hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {documentsHook.documents.length > 0 && (
                <div className="px-2 py-2 border-b border-[var(--color-border)] shrink-0">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[#a89fb8]" />
                    <input
                      type="text"
                      value={docTreeSearch}
                      onChange={(e) => setDocTreeSearch(e.target.value)}
                      placeholder={t('documents.searchPlaceholder', 'Search')}
                      className="w-full h-7 pl-7 pr-2 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[#3a3350] dark:text-slate-200 placeholder:text-[#a89fb8] focus:outline-none focus:ring-1 focus:ring-[#a78bfa]"
                    />
                  </div>
                </div>
              )}
              <div className="flex-1 min-h-0 overflow-y-auto p-2">
                {(() => {
                  const q = docTreeSearch.normalize('NFC').toLowerCase();
                  const treeDocs = q
                    ? documentsHook.documents.filter((d) =>
                        d.name.normalize('NFC').toLowerCase().includes(q),
                      )
                    : documentsHook.documents;
                  if (documentsHook.documents.length === 0) {
                    return (
                      <p className="px-2 py-6 text-xs text-center text-[#a89fb8]">
                        {t('documents.noDocuments', 'No documents yet')}
                      </p>
                    );
                  }
                  if (treeDocs.length === 0) {
                    return (
                      <p className="px-2 py-6 text-xs text-center text-[#a89fb8]">
                        {t('documents.noMatchingDocuments', 'No matches')}
                      </p>
                    );
                  }
                  return (
                    <FolderTree
                      documents={treeDocs}
                      mode="category"
                      onSelectDocument={(doc) => {
                        const wf = documentsHook.workflows.find(
                          (w) => w.document_id === doc.document_id,
                        );
                        if (wf)
                          documentsHook.loadWorkflowDetail(
                            doc.document_id,
                            wf.workflow_id,
                          );
                      }}
                      onDeleteFolder={setFolderDeleteTarget}
                    />
                  );
                })()}
              </div>
            </>
          )}
          </aside>
        )}

        <ResizablePanelGroup
          key={`${isChatOpen ? 'c' : 'n'}-${panelLayout.sidePanelCollapsed ? 'sl' : 'se'}`}
          orientation="horizontal"
          defaultSize={(() => {
            const sizes = panelLayout.sidePanelSizeBeforeCollapse.current;
            if (!isChatOpen && !panelLayout.sidePanelCollapsed) {
              return [100];
            }
            if (!isChatOpen && panelLayout.sidePanelCollapsed) {
              return [100];
            }
            if (panelLayout.sidePanelCollapsed) {
              return [sizes[0] + sizes[1]];
            }
            return sizes;
          })()}
          onResizeEnd={panelLayout.handlePanelResizeEnd}
          onCollapse={(details: { panelId: string }) => {
            if (details.panelId === 'side') {
              panelLayout.setSidePanelCollapsed(true);
            }
          }}
          panels={(() => {
            const panels: {
              id: string;
              minSize: number;
              maxSize: number;
              collapsible?: boolean;
            }[] = [];
            if (isChatOpen) {
              panels.push({ id: 'chat', minSize: 40, maxSize: 100 });
            }
            if (!panelLayout.sidePanelCollapsed) {
              panels.push({
                id: 'side',
                minSize: isChatOpen ? 15 : 100,
                maxSize: isChatOpen ? 45 : 100,
                collapsible: isChatOpen ? true : undefined,
              });
            }
            return panels;
          })()}
          className="h-full flex-1 min-w-0"
        >
          {/* Left - Chat Panel (conditionally rendered) */}
          {isChatOpen && (
            <ResizablePanel id="chat">
              <div className="h-full">
                <ChatPanel
                  projectName={projectData.project?.name}
                  projectDescription={projectData.project?.description}
                  projectColor={projectData.project?.color ?? 0}
                  messages={chatSession.messages}
                  inputMessage={chatSession.inputMessage}
                  sending={chatSession.sending}
                  streamingBlocks={chatSession.streamingBlocks}
                  loadingHistory={chatSession.loadingHistory}
                  agents={agentsHook.agents}
                  selectedAgent={agentsHook.selectedAgent}
                  artifacts={artifactsHook.artifacts}
                  documents={documentsHook.documents}
                  onInputChange={chatSession.setInputMessage}
                  onSendMessage={handleSendMessage}
                  onAgentSelect={agentsHook.handleAgentSelect}
                  onAgentClick={() => agentsHook.setShowAgentModal(true)}
                  onNewChat={handleNewSession}
                  onArtifactView={artifactsHook.handleArtifactSelect}
                  onSourceClick={documentsHook.handleSourceClick}
                  onGraphResult={setAnswerGraph}
                  loadingSourceKey={documentsHook.loadingSourceKey}
                  scrollPositionRef={chatSession.chatScrollPositionRef}
                />
              </div>
            </ResizablePanel>
          )}

          {isChatOpen && !panelLayout.sidePanelCollapsed && (
            <ResizableHandle id="chat:side" />
          )}

          {/* Right - Documents & Artifacts (or full-width when chat is closed) */}
          {!panelLayout.sidePanelCollapsed && (
            <ResizablePanel id="side">
              <div className="h-full relative">
                <SidePanel
                  artifacts={artifactsHook.artifacts}
                  currentArtifactId={
                    artifactsHook.selectedArtifact?.artifact_id
                  }
                  onArtifactSelect={artifactsHook.handleArtifactSelect}
                  onArtifactDownload={artifactsHook.handleArtifactDownload}
                  onArtifactDelete={artifactsHook.handleArtifactDelete}
                  onRefreshArtifacts={artifactsHook.loadArtifacts}
                  onCollapse={() => panelLayout.setSidePanelCollapsed(true)}
                  documents={documentsHook.documents}
                  workflows={documentsHook.workflows}
                  workflowProgressMap={documentsHook.workflowProgressMap}
                  uploading={documentsHook.uploading}
                  onAddDocument={() => documentsHook.setShowUploadModal(true)}
                  onRefreshDocuments={documentsHook.loadDocuments}
                  onViewWorkflow={documentsHook.loadWorkflowDetail}
                  onDeleteDocument={documentsHook.handleDeleteDocument}
                  onDeleteAll={documentsHook.deleteAllDocuments}
                  deletingAll={documentsHook.deletingAll}
                  onViewProjectGraph={() => setShowProjectGraph(true)}
                  graphResult={answerGraph}
                  onViewAnswerGraph={() => setAnswerGraphOpen(true)}
                />
                {/* Artifact Viewer - overlays SidePanel */}
                {artifactsHook.selectedArtifact && (
                  <ArtifactViewer
                    artifact={artifactsHook.selectedArtifact}
                    onClose={artifactsHook.handleArtifactViewerClose}
                    onDownload={artifactsHook.handleArtifactDownload}
                    getPresignedUrl={getPresignedDownloadUrl}
                  />
                )}
              </div>
            </ResizablePanel>
          )}
        </ResizablePanelGroup>

        {/* Collapsed Side Bar */}
        {panelLayout.sidePanelCollapsed && (
          <div
            className="side-collapsed-bar"
            onClick={panelLayout.expandSidePanel}
            title={t('nav.expand')}
          >
            <div className="docs-collapsed-badge">
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span>{documentsHook.documents.length}</span>
            </div>
            <span className="docs-collapsed-label">
              {t('documents.title', 'Documents')}
            </span>
            <div className="docs-collapsed-badge mt-2">
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
                <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
                <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
              </svg>
              <span>{artifactsHook.artifacts.length}</span>
            </div>
            <span className="docs-collapsed-label">
              {t('chat.artifacts', 'Artifacts')}
            </span>
            <div className="docs-collapsed-expand">
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M11 17l-5-5 5-5" />
                <path d="M18 17l-5-5 5-5" />
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Workflow Detail Modal */}
      {documentsHook.selectedWorkflow && (
        <WorkflowDetailModal
          workflow={documentsHook.selectedWorkflow}
          projectId={projectId}
          projectColor={projectData.project?.color ?? 0}
          loadingWorkflow={documentsHook.loadingWorkflow}
          onClose={() => {
            documentsHook.setSelectedWorkflow(null);
            documentsHook.setInitialSegmentIndex(0);
          }}
          onReanalyze={documentsHook.handleReanalyze}
          reanalyzing={documentsHook.reanalyzing}
          onRegenerateQa={documentsHook.handleRegenerateQa}
          onAddQa={documentsHook.handleAddQa}
          onDeleteQa={documentsHook.handleDeleteQa}
          initialSegmentIndex={documentsHook.initialSegmentIndex}
          onLoadSegment={documentsHook.handleLoadSegment}
        />
      )}

      {/* Project Settings Modal */}
      <ProjectSettingsModal
        project={projectData.project}
        isOpen={projectData.showProjectSettings}
        onClose={() => projectData.setShowProjectSettings(false)}
        onSave={projectData.handleProjectSave}
      />

      {/* Delete Document Confirmation Modal */}
      <ConfirmModal
        isOpen={!!documentsHook.deleteTarget}
        onClose={() => documentsHook.setDeleteTarget(null)}
        onConfirm={documentsHook.confirmDeleteDocument}
        title={t('documents.deleteConfirm')}
        message={documentsHook.deleteTarget?.name || ''}
        confirmText={t('common.delete')}
        variant="danger"
        loading={documentsHook.deleting}
      />

      {/* Delete Folder Confirmation Modal (deletes every document inside) */}
      <ConfirmModal
        isOpen={!!folderDeleteTarget}
        onClose={() => setFolderDeleteTarget(null)}
        onConfirm={confirmDeleteFolder}
        title={t('projects.deleteFolder', '폴더 삭제')}
        message={
          folderDeleteTarget
            ? t(
                'projects.deleteFolderConfirm',
                '"{{name}}" 폴더의 문서 {{n}}개를 삭제합니다. 되돌릴 수 없습니다.',
                {
                  name: folderDeleteTarget.name,
                  n: collectDocs(folderDeleteTarget).length,
                },
              )
            : ''
        }
        confirmText={t('common.delete')}
        variant="danger"
        loading={deletingFolder}
      />

      {/* Agent Select Modal */}
      <AgentSelectModal
        isOpen={agentsHook.showAgentModal}
        agents={agentsHook.agents}
        selectedAgentName={agentsHook.selectedAgent?.name || null}
        loading={agentsHook.loadingAgents}
        onClose={() => agentsHook.setShowAgentModal(false)}
        onSelect={agentsHook.handleAgentSelect}
        onCreate={agentsHook.handleAgentCreate}
        onUpdate={agentsHook.handleAgentUpdate}
        onDelete={agentsHook.handleAgentDelete}
        onLoadDetail={agentsHook.loadAgentDetail}
      />

      {/* Document Upload Modal */}
      <DocumentUploadModal
        isOpen={documentsHook.showUploadModal}
        uploading={documentsHook.uploading}
        projectLanguage={projectData.project?.language || undefined}
        projectDocumentPrompt={
          projectData.project?.document_prompt || undefined
        }
        onClose={() => documentsHook.setShowUploadModal(false)}
        onUpload={documentsHook.processFiles}
      />

      {/* System Prompt Modal (Ctrl+Shift+S) */}
      <SystemPromptModal
        isOpen={showSystemPrompt}
        onClose={() => setShowSystemPrompt(false)}
        tabs={systemPromptTabs}
      />

      {/* Project Graph Modal */}
      {showProjectGraph && (
        <ProjectGraphModal
          projectId={projectId}
          projectName={projectData.project?.name || projectId}
          fetchApi={fetchApi}
          onClose={() => setShowProjectGraph(false)}
        />
      )}

      {/* Answer graph — entities/relations for the latest chat answer */}
      {answerGraph && (
        <GraphSearchResultModal
          isOpen={answerGraphOpen}
          onClose={() => setAnswerGraphOpen(false)}
          data={answerGraph}
        />
      )}
    </div>
  );
}
