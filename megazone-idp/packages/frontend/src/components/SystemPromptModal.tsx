import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Terminal, Save, Loader2, Globe } from 'lucide-react';
import { useModal } from '../hooks/useModal';

export type PromptType =
  | 'chat'
  | 'webcrawler'
  | 'analysis-doc'
  | 'analysis-video'
  | 'analysis-text';

// R1/F5: analysis system-prompt editing is hidden from end users.
type TopTab = 'chat' | 'webcrawler';

interface PromptTab {
  type: PromptType;
  onLoad: () => Promise<string>;
  onSave: (content: string) => Promise<void>;
}

interface SystemPromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  tabs: PromptTab[];
  initialTab?: PromptType;
}

const TOP_TAB_CONFIG: {
  key: TopTab;
  labelKey: string;
  icon: typeof Terminal;
}[] = [
  { key: 'chat', labelKey: 'systemPrompt.tabChat', icon: Terminal },
  { key: 'webcrawler', labelKey: 'systemPrompt.tabWebcrawler', icon: Globe },
];

function getTopTab(type: PromptType): TopTab {
  return type === 'webcrawler' ? 'webcrawler' : 'chat';
}

const EMPTY_CONTENTS: Record<PromptType, string> = {
  chat: '',
  webcrawler: '',
  'analysis-doc': '',
  'analysis-video': '',
  'analysis-text': '',
};

export default function SystemPromptModal({
  isOpen,
  onClose,
  tabs,
  initialTab = 'chat',
}: SystemPromptModalProps) {
  const { t } = useTranslation();
  const [activeTopTab, setActiveTopTab] = useState<TopTab>(
    getTopTab(initialTab),
  );
  const [contents, setContents] = useState<Record<PromptType, string>>({
    ...EMPTY_CONTENTS,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadedTabs, setLoadedTabs] = useState<Set<PromptType>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activePromptType: PromptType = activeTopTab;
  const activeTabConfig = tabs.find((tab) => tab.type === activePromptType);

  const loadTabContent = useCallback(
    async (type: PromptType) => {
      const tabConfig = tabs.find((tab) => tab.type === type);
      if (!tabConfig) return;

      setLoading(true);
      try {
        const data = await tabConfig.onLoad();
        setContents((prev) => ({ ...prev, [type]: data }));
        setLoadedTabs((prev) => new Set(prev).add(type));
      } catch (error) {
        console.error(`Failed to load ${type} prompt:`, error);
      } finally {
        setLoading(false);
      }
    },
    [tabs],
  );

  useEffect(() => {
    if (!isOpen) {
      setLoadedTabs(new Set());
      setContents({ ...EMPTY_CONTENTS });
      return;
    }

    loadTabContent(activePromptType);
  }, [isOpen, activePromptType, loadTabContent]);

  useEffect(() => {
    if (isOpen && !loading && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [isOpen, loading, activePromptType]);

  const handleSave = useCallback(async () => {
    if (!activeTabConfig) return;

    setSaving(true);
    try {
      await activeTabConfig.onSave(contents[activePromptType]);
      onClose();
    } catch (error) {
      console.error(`Failed to save ${activePromptType} prompt:`, error);
    } finally {
      setSaving(false);
    }
  }, [activeTabConfig, activePromptType, contents, onClose]);

  const { handleBackdropClick } = useModal({
    isOpen,
    onClose,
    disableClose: saving,
  });

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === 'Enter' &&
        !saving &&
        !loading
      ) {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, saving, loading, handleSave]);

  const handleTopTabChange = (tab: TopTab) => {
    if (tab === activeTopTab || saving) return;
    setActiveTopTab(tab);
    if (!loadedTabs.has(tab)) {
      loadTabContent(tab);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 dark:bg-black/65 backdrop-blur-md animate-in fade-in duration-200"
      onClick={handleBackdropClick}
    >
      <div
        className="relative flex flex-col bg-white dark:bg-slate-900 rounded-2xl animate-in zoom-in-95 duration-200 overflow-hidden border border-[#ece9f0] dark:border-slate-700/80"
        style={{
          boxShadow:
            '0 25px 50px -12px rgba(0, 0, 0, 0.15), 0 0 40px rgba(99, 102, 241, 0.08)',
          width: '720px',
          maxWidth: '95vw',
          maxHeight: '85vh',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#ece9f0] dark:border-slate-700/80 bg-[#faf9fb]/50 dark:bg-slate-800/50">
          <div className="flex items-center gap-4">
            <h3 className="text-sm font-semibold text-[#1a1523] dark:text-white">
              {t('systemPrompt.title')}
            </h3>

            {/* Top-level Tabs */}
            <div className="flex items-center gap-1 p-0.5 bg-[#f2eefb] dark:bg-slate-800 rounded-lg">
              {TOP_TAB_CONFIG.map(({ key, labelKey, icon: Icon }) => {
                const isActive = activeTopTab === key;
                return (
                  <button
                    key={key}
                    onClick={() => handleTopTabChange(key)}
                    disabled={saving}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                      isActive
                        ? 'bg-white dark:bg-slate-700 text-[#1a1523] dark:text-white shadow-sm'
                        : 'text-[#6b6478] dark:text-slate-400 hover:text-[#3a3350] dark:hover:text-slate-300'
                    } disabled:opacity-50`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {t(labelKey)}
                  </button>
                );
              })}
            </div>

            <span className="text-[10px] font-medium text-[#6b6478] dark:text-slate-500 bg-[#f2eefb] dark:bg-slate-800 px-1.5 py-0.5 rounded">
              Ctrl+Shift+S
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-1.5 rounded-lg text-[#6b6478] hover:text-[#3a3350] dark:hover:text-white hover:bg-[#f2eefb] dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Editor */}
        <div className="flex-1 min-h-0 p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-[#7c3aed]" />
              <span className="text-sm text-[#6b6478]">
                {t('common.loading')}
              </span>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={contents[activePromptType]}
              onChange={(e) =>
                setContents((prev) => ({
                  ...prev,
                  [activePromptType]: e.target.value,
                }))
              }
              placeholder={t('systemPrompt.placeholder')}
              spellCheck={false}
              className="w-full rounded-xl border border-[#ece9f0] dark:border-slate-700/80 bg-[#faf9fb] dark:bg-slate-950/60 text-[#1a1523] dark:text-slate-200 placeholder-[#6b6478] dark:placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-[#7c3aed]/30 focus:border-[#7c3aed]/50 transition-all resize-none p-4"
              style={{
                fontFamily:
                  "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace",
                fontSize: '13px',
                lineHeight: '1.7',
                height: '420px',
                tabSize: 2,
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[#ece9f0] dark:border-slate-700/80 bg-[#faf9fb]/30 dark:bg-slate-800/30">
          <span className="text-[11px] text-[#6b6478] dark:text-slate-500">
            {t('systemPrompt.saveHint')}
          </span>
          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-3.5 py-1.5 text-sm font-medium text-[#3a3350] dark:text-slate-400 hover:text-[#1a1523] dark:hover:text-white hover:bg-[#f2eefb] dark:hover:bg-slate-800 rounded-lg border border-[#ece9f0] dark:border-slate-700 transition-all disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || loading}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium text-white bg-[#7c3aed] hover:bg-[#6d28d9] dark:bg-indigo-500 dark:hover:bg-indigo-600 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
