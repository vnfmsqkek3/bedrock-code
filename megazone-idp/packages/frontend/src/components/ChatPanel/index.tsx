import {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useAwsClient } from '../../hooks/useAwsClient';
import { useToast } from '../Toast';
import ImageModal from '../ImageModal';
import ToolResultDetailModal from '../ToolResultDetailModal';
import GraphSearchResultModal from '../GraphSearchResultModal';
import ConfirmModal from '../ConfirmModal';
import ChatInputBox from './ChatInputBox';
import MessageList from './MessageList';
import WelcomeScreen from './WelcomeScreen';
import type {
  ChatPanelProps,
  AttachedFile,
  ChatArtifact,
  GraphSearchResult,
  ToolResultSource,
  Document,
} from './types';

// Re-exports for backward compatibility
export type { AttachedFile, StreamingBlock } from './types';

export default function ChatPanel({
  projectName,
  projectColor,
  messages,
  inputMessage,
  sending,
  streamingBlocks,
  loadingHistory = false,
  agents = [],
  selectedAgent,
  artifacts = [],
  documents = [],
  onInputChange,
  onSendMessage,
  onAgentSelect,
  onAgentClick,
  onNewChat,
  onArtifactView,
  onSourceClick,
  onGraphResult,
  loadingSourceKey,
  scrollPositionRef,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const { getPresignedDownloadUrl } = useAwsClient();
  const { showToast } = useToast();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageCountRef = useRef(messages.length);
  const userScrolledUpRef = useRef(false);
  const [showScrollDown, setShowScrollDown] = useState(false);

  // Attached files state (shared between orchestrator and ChatInputBox)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);

  // Modal states
  const [toolResultDetail, setToolResultDetail] = useState<{
    content: string;
    sources?: ToolResultSource[];
    documents?: Document[];
    toolName?: string;
    toolInput?: Record<string, unknown>;
  } | null>(null);
  const [modalImage, setModalImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);
  const [graphSearchData, setGraphSearchData] =
    useState<GraphSearchResult | null>(null);
  const [downloadingArtifact, setDownloadingArtifact] = useState<string | null>(
    null,
  );
  const [expandedSources, setExpandedSources] = useState<Set<string>>(
    new Set(),
  );

  // Confirm modals state
  const [showRemoveAgentConfirm, setShowRemoveAgentConfirm] = useState(false);
  const [pendingAgentChange, setPendingAgentChange] = useState<
    string | null | undefined
  >(undefined);

  // Artifact download
  const handleArtifactDownload = useCallback(
    async (artifact: ChatArtifact) => {
      setDownloadingArtifact(artifact.artifact_id);
      try {
        let bucket = artifact.s3_bucket;
        if (!bucket && artifact.url) {
          const urlMatch = artifact.url.match(
            /https:\/\/([^.]+)\.s3\.[^.]+\.amazonaws\.com\//,
          );
          bucket = urlMatch?.[1];
        }
        if (!bucket || !artifact.s3_key) {
          throw new Error('Missing bucket or s3_key for artifact');
        }

        const presignedUrl = await getPresignedDownloadUrl(
          bucket,
          artifact.s3_key,
        );
        const response = await fetch(presignedUrl);

        if (!response.ok) {
          if (response.status === 404 || response.status === 403) {
            showToast(
              'error',
              t(
                'chat.artifactNotFound',
                'File not found. It may have been deleted.',
              ),
            );
            return;
          }
          throw new Error(`Download failed: ${response.status}`);
        }

        const blob = await response.blob();
        if (blob.type.includes('xml')) {
          const text = await blob.text();
          if (text.includes('NoSuchKey')) {
            showToast(
              'error',
              t(
                'chat.artifactNotFound',
                'File not found. It may have been deleted.',
              ),
            );
            return;
          }
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = artifact.filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch (error) {
        console.error('Failed to download artifact:', error);
        showToast('error', t('chat.downloadFailed', 'Download failed'));
      } finally {
        setDownloadingArtifact(null);
      }
    },
    [getPresignedDownloadUrl, showToast, t],
  );

  // Toggle expand for collapsible sections
  const handleToggleExpand = useCallback((key: string) => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Restore scroll position on remount
  useLayoutEffect(() => {
    if (scrollPositionRef && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollPositionRef.current;
    }
  }, [scrollPositionRef]);

  // Save scroll position continuously & detect user scroll-up
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (scrollPositionRef) {
        scrollPositionRef.current = el.scrollTop;
      }
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      const scrolledUp = distanceFromBottom > 100;
      userScrolledUpRef.current = scrolledUp;
      setShowScrollDown(scrolledUp);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [scrollPositionRef]);

  // Smooth-scroll to bottom when new messages arrive
  useEffect(() => {
    if (
      messages.length > messageCountRef.current &&
      !userScrolledUpRef.current
    ) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    messageCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    if (streamingBlocks.length > 0 && !userScrolledUpRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamingBlocks]);

  // Reset scroll lock when streaming ends
  useEffect(() => {
    if (streamingBlocks.length === 0 && !sending) {
      userScrolledUpRef.current = false;
      setShowScrollDown(false);
    }
  }, [streamingBlocks.length, sending]);

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    userScrolledUpRef.current = false;
    setShowScrollDown(false);
  }, []);

  const hasMessages = messages.length > 0 || sending;

  // Keep focus on input when view changes
  useEffect(() => {
    if (hasMessages && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [hasMessages]);

  // Input box element
  const inputBox = (
    <ChatInputBox
      inputMessage={inputMessage}
      sending={sending}
      attachedFiles={attachedFiles}
      setAttachedFiles={setAttachedFiles}
      artifacts={artifacts}
      documents={documents}
      agents={agents}
      selectedAgent={selectedAgent}
      onInputChange={onInputChange}
      onSendMessage={onSendMessage}
      onAgentSelect={onAgentSelect}
      onAgentClick={onAgentClick}
      messagesLength={messages.length}
      setPendingAgentChange={(val) => setPendingAgentChange(val)}
      setShowRemoveAgentConfirm={(val) => setShowRemoveAgentConfirm(val)}
      inputRef={inputRef}
      fileInputRef={fileInputRef}
    />
  );

  return (
    <div className="glow-through w-full h-full flex flex-col bg-[#faf9fb] dark:bg-[#161b22] border-r border-[#ece9f0] dark:border-[#21262d] overflow-hidden relative">
      {/* Messages Container */}
      <div
        ref={scrollContainerRef}
        className="chat-messages-scroll flex-1 overflow-y-auto"
      >
        {loadingHistory ? (
          <div className="flex flex-col items-center justify-center h-full p-6">
            <div className="flex items-center gap-2 text-[#6b6478] dark:text-[#8b949e]">
              <svg
                className="w-5 h-5 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span className="text-sm">
                {t('chat.loadingHistory', 'Loading conversation...')}
              </span>
            </div>
          </div>
        ) : !hasMessages ? (
          <WelcomeScreen
            inputBox={inputBox}
            projectName={projectName}
            projectColor={projectColor}
          />
        ) : (
          <MessageList
            messages={messages}
            streamingBlocks={streamingBlocks}
            sending={sending}
            expandedSources={expandedSources}
            onToggleExpand={handleToggleExpand}
            onArtifactView={onArtifactView}
            onArtifactDownload={handleArtifactDownload}
            downloadingArtifact={downloadingArtifact}
            onSourceClick={onSourceClick}
            loadingSourceKey={loadingSourceKey}
            onImageClick={(img) => setModalImage(img)}
            onViewDetails={(detail) => setToolResultDetail(detail)}
            onGraphView={(data) => {
              setGraphSearchData(data);
              onGraphResult?.(data);
            }}
            onGraphData={(data) => onGraphResult?.(data)}
            documents={documents}
            chatEndRef={chatEndRef}
          />
        )}
      </div>

      {/* Scroll to bottom button */}
      {showScrollDown && hasMessages && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-24 z-10">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-white dark:bg-[#1e1e22] border border-[#ece9f0] dark:border-[#21262d] shadow-md text-[#6b6478] dark:text-[#8b949e] hover:bg-[#faf9fb] dark:hover:bg-[#161b22] transition-all"
          >
            <svg
              className="w-4 h-4"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      )}

      {/* Bottom Input */}
      {hasMessages && (
        <div className="p-4">
          <div className="max-w-3xl mx-auto">{inputBox}</div>
        </div>
      )}

      {/* Image Modal */}
      {modalImage && (
        <ImageModal
          src={modalImage.src}
          alt={modalImage.alt}
          onClose={() => setModalImage(null)}
        />
      )}
      {/* Tool Result Detail Modal */}
      <ToolResultDetailModal
        isOpen={!!toolResultDetail}
        onClose={() => setToolResultDetail(null)}
        content={toolResultDetail?.content ?? ''}
        sources={toolResultDetail?.sources}
        documents={toolResultDetail?.documents}
        toolName={toolResultDetail?.toolName}
        toolInput={toolResultDetail?.toolInput}
        onSourceClick={onSourceClick}
        loadingSourceKey={loadingSourceKey}
      />
      {/* Graph Search Result Modal */}
      {graphSearchData && (
        <GraphSearchResultModal
          isOpen={!!graphSearchData}
          onClose={() => setGraphSearchData(null)}
          data={graphSearchData}
        />
      )}
      <ConfirmModal
        isOpen={showRemoveAgentConfirm}
        onClose={() => {
          setShowRemoveAgentConfirm(false);
          setPendingAgentChange(undefined);
        }}
        onConfirm={() => {
          setShowRemoveAgentConfirm(false);
          onAgentSelect?.(pendingAgentChange ?? null);
          setPendingAgentChange(undefined);
        }}
        title={t('chat.useAgent')}
        message={t('chat.removeAgentConfirm')}
        confirmText={t('common.confirm')}
        variant="warning"
      />
    </div>
  );
}
