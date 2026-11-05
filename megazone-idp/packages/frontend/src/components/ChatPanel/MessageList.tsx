import { useTranslation } from 'react-i18next';
import { Check, Loader2 } from 'lucide-react';
import BouncingCirclesLoader from '../ui/bouncing-circles-loader';
import MarkdownRenderer from './MarkdownRenderer';
import ToolResultCard from './ToolResultCard';
import ToolUseIndicator from './ToolUseIndicator';
import { prepareMarkdown, getFileTypeInfo } from './utils';
import { renderMessageWithMentions } from './renderMessageWithMentions';
import type {
  StreamingBlock,
  ChatMessage,
  ChatArtifact,
  Document,
  GraphSearchResult,
} from './types';

interface MessageListProps {
  messages: ChatMessage[];
  streamingBlocks: StreamingBlock[];
  sending: boolean;
  expandedSources: Set<string>;
  onToggleExpand: (key: string) => void;
  onArtifactView?: (artifactId: string) => void;
  onArtifactDownload?: (artifact: ChatArtifact) => void;
  downloadingArtifact?: string | null;
  onSourceClick?: (documentId: string, segmentId: string) => void;
  loadingSourceKey?: string | null;
  onImageClick?: (img: { src: string; alt: string }) => void;
  onViewDetails?: (detail: {
    content: string;
    sources?: { document_id: string; segment_id: string }[];
    documents?: Document[];
    toolName?: string;
    toolInput?: Record<string, unknown>;
  }) => void;
  onGraphView?: (data: GraphSearchResult) => void;
  onGraphData?: (data: GraphSearchResult) => void;
  documents: Document[];
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}

export default function MessageList({
  messages,
  streamingBlocks,
  sending,
  expandedSources,
  onToggleExpand,
  onArtifactView,
  onArtifactDownload,
  downloadingArtifact,
  onSourceClick,
  loadingSourceKey,
  onImageClick,
  onViewDetails,
  onGraphView,
  onGraphData,
  documents,
  chatEndRef,
}: MessageListProps) {
  const { t } = useTranslation();

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto w-full">
      {messages.map((message) =>
        message.role === 'user' ? (
          <UserMessage key={message.id} message={message} />
        ) : message.isToolUse ? (
          <ToolUseIndicator
            key={message.id}
            name={message.toolUseName || ''}
            status={message.toolUseStatus}
          />
        ) : message.isToolResult ? (
          <ToolResultCard
            key={message.id}
            toolName={message.toolName}
            resultType={
              message.toolResultType as
                | 'image'
                | 'artifact'
                | 'text'
                | undefined
            }
            content={message.content}
            artifact={message.artifact}
            sources={message.sources}
            attachments={message.attachments}
            toolInput={message.toolInput}
            expandKeyPrefix={message.id}
            expandedSources={expandedSources}
            onToggleExpand={onToggleExpand}
            onArtifactView={onArtifactView}
            onArtifactDownload={onArtifactDownload}
            downloadingArtifact={downloadingArtifact}
            onSourceClick={onSourceClick}
            loadingSourceKey={loadingSourceKey}
            onImageClick={onImageClick}
            onViewDetails={onViewDetails}
            onGraphView={onGraphView}
            onGraphData={onGraphData}
            documents={documents}
          />
        ) : message.isStageResult ? (
          <StageResult key={message.id} message={message} />
        ) : (
          <AssistantMessage
            key={message.id}
            message={message}
            onImageClick={onImageClick}
          />
        ),
      )}

      {/* Streaming blocks */}
      {sending && (
        <div className="space-y-2">
          {streamingBlocks.length > 0 ? (
            streamingBlocks.map((block, idx) => {
              if (block.type === 'text') {
                return (
                  <div key={idx} className="flex gap-[13px]">
                    <img
                      src="/ai_chat_icon.svg"
                      alt=""
                      className="w-8 h-8 flex-shrink-0 select-none"
                      draggable={false}
                    />
                    <div className="min-w-0 flex-1 rounded-[16px_16px_16px_5px] border border-[#ece9f0] dark:border-[#21262d] bg-white dark:bg-[#1e1e22] px-[18px] py-[15px] shadow-[0_1px_3px_rgba(26,21,35,0.05)] prose prose-sm dark:prose-invert max-w-none text-[14.5px] leading-[1.7] text-[#2a2340] dark:text-[#c9d1d9] [&_p]:leading-[1.7] [&_strong]:!text-inherit">
                      <MarkdownRenderer>
                        {prepareMarkdown(block.content)}
                      </MarkdownRenderer>
                    </div>
                  </div>
                );
              }
              if (block.type === 'stage_start') {
                return (
                  <div key={idx} className="flex items-center gap-1.5 py-0.5">
                    <Loader2 className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 animate-spin flex-shrink-0" />
                    <span className="text-sm shimmer-text-effect text-amber-600 dark:text-amber-300">
                      {t(`chat.stage.${block.stage}`, block.stage)} ...
                    </span>
                  </div>
                );
              }
              if (block.type === 'stage_complete') {
                return (
                  <div key={idx} className="flex items-center gap-1.5 py-0.5">
                    <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400 flex-shrink-0" />
                    <span className="text-sm text-emerald-600 dark:text-emerald-400">
                      {t(`chat.stageResult.${block.stage}`, block.stage)}
                    </span>
                  </div>
                );
              }
              if (block.type === 'tool_result') {
                return (
                  <ToolResultCard
                    key={idx}
                    toolName={block.toolName}
                    resultType={block.resultType}
                    content={block.content}
                    images={block.images}
                    sources={block.sources}
                    toolInput={block.toolInput}
                    expandKeyPrefix={`streaming-tool-result-${idx}`}
                    expandedSources={expandedSources}
                    onToggleExpand={onToggleExpand}
                    onSourceClick={onSourceClick}
                    onImageClick={onImageClick}
                    onViewDetails={onViewDetails}
                    onGraphView={onGraphView}
                    onGraphData={onGraphData}
                    documents={documents}
                  />
                );
              }
              // tool_use
              return (
                <ToolUseIndicator
                  key={idx}
                  name={block.name}
                  status={block.status}
                />
              );
            })
          ) : (
            <BouncingCirclesLoader
              size={40}
              circleSize={8}
              circleCount={8}
              color="#a89fb8"
              speed={1.2}
            />
          )}
        </div>
      )}
      <div ref={chatEndRef} />
    </div>
  );
}

// --- Internal sub-components ---

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[84%] space-y-2">
        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 justify-end">
            {message.attachments.map((attachment) => {
              if (attachment.type === 'image' && attachment.preview) {
                return (
                  <img
                    key={attachment.id}
                    src={attachment.preview}
                    alt={attachment.name}
                    className="max-w-48 max-h-48 rounded-xl object-cover border border-[#ece9f0] dark:border-[#21262d]"
                  />
                );
              }
              const fileInfo = getFileTypeInfo(attachment.name);
              const FileIcon = fileInfo.icon;
              return (
                <div
                  key={attachment.id}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[#faf9fb] dark:bg-[#1e1e22] border border-[#ece9f0] dark:border-[#21262d] shadow-sm"
                >
                  <div
                    className={`flex items-center justify-center w-10 h-10 rounded-lg ${fileInfo.bgColor}`}
                  >
                    <FileIcon className={`w-5 h-5 ${fileInfo.color}`} />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-[#3a3350] dark:text-[#c9d1d9] truncate max-w-[150px]">
                      {attachment.name}
                    </span>
                    <span className="text-xs text-[#6b6478] dark:text-[#8b949e] uppercase">
                      {attachment.name.split('.').pop()} file
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* Text content */}
        {message.content && (
          <div className="px-4 py-3 rounded-[16px_16px_5px_16px] bg-[#f0ebfa] dark:bg-[color:var(--color-user-bubble)] shadow-sm text-[#2a2340] dark:text-[#c9d1d9]">
            <p className="text-sm leading-[1.55]">
              {renderMessageWithMentions(message.content)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StageResult({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5 py-0.5">
      <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400 flex-shrink-0" />
      <span className="text-sm text-emerald-600 dark:text-emerald-400">
        {t(`chat.stageResult.${message.stageName}`, message.stageName ?? '')}
      </span>
    </div>
  );
}

function AssistantMessage({
  message,
  onImageClick,
}: {
  message: ChatMessage;
  onImageClick?: (img: { src: string; alt: string }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-[13px]">
      <img
        src="/ai_chat_icon.svg"
        alt=""
        className="w-8 h-8 flex-shrink-0 select-none"
        draggable={false}
      />
      <div className="min-w-0 flex-1 space-y-3 rounded-[16px_16px_16px_5px] border border-[#ece9f0] dark:border-[#21262d] bg-white dark:bg-[#1e1e22] px-[18px] py-[15px] shadow-[0_1px_3px_rgba(26,21,35,0.05)]">
        {/* AI generated images */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {message.attachments.map((attachment) =>
              attachment.type === 'image' && attachment.preview ? (
                <button
                  key={attachment.id}
                  type="button"
                  onClick={() =>
                    onImageClick?.({
                      src: attachment.preview ?? '',
                      alt: attachment.name,
                    })
                  }
                  className="group relative rounded-xl overflow-hidden cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#7c3aed] focus:ring-offset-2"
                >
                  <img
                    src={attachment.preview}
                    alt={attachment.name}
                    className="max-w-80 max-h-80 object-contain border border-[#ece9f0] dark:border-[#21262d]"
                  />
                  <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="text-xs text-white font-medium">
                      {t('chat.clickToEnlarge', 'Click to enlarge')}
                    </span>
                  </div>
                </button>
              ) : null,
            )}
          </div>
        )}
        {/* Text content */}
        {message.content && (
          <div className="prose prose-sm dark:prose-invert max-w-none text-[14.5px] leading-[1.7] text-[#2a2340] dark:text-[#c9d1d9] [&_p]:leading-[1.7] [&_strong]:!text-inherit">
            <MarkdownRenderer>
              {prepareMarkdown(message.content)}
            </MarkdownRenderer>
          </div>
        )}
      </div>
    </div>
  );
}
