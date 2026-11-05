import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, Settings2, Sparkles } from 'lucide-react';
import type { Agent } from './types';

interface ToolsMenuPopoverProps {
  onAgentSelect?: (agentName: string | null) => void;
  selectedAgent: Agent | null;
  agents: Agent[];
  messagesLength: number;
  onAgentClick: () => void;
  onClose: () => void;
  onPendingAgentChange: (agentName: string | null) => void;
  onShowRemoveAgentConfirm: () => void;
}

export default function ToolsMenuPopover({
  onAgentSelect,
  selectedAgent,
  agents,
  messagesLength,
  onAgentClick,
  onClose,
  onPendingAgentChange,
  onShowRemoveAgentConfirm,
}: ToolsMenuPopoverProps) {
  const { t } = useTranslation();
  const [showAgentSubmenu, setShowAgentSubmenu] = useState(false);

  return (
    <div className="absolute bottom-full left-0 mb-2 w-56 bg-white dark:bg-slate-800 border border-[#ece9f0] dark:border-white/30 rounded-xl shadow-[0_10px_30px_-8px_rgba(60,40,100,0.25)] z-50 py-1">
      {/* Agent submenu */}
      {onAgentSelect && (
        <>
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowAgentSubmenu((v) => !v);
              }}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors text-[#3a3350] dark:text-slate-300 glass-menu-item"
            >
              <Sparkles className="w-4 h-4 text-[#6b6478] dark:text-slate-400" />
              <span className="flex-1 text-left">{t('chat.useAgent')}</span>
              <ChevronRight className="w-4 h-4 text-[#a89fb8]" />
            </button>

            {/* Agent submenu panel */}
            {showAgentSubmenu && (
              <div className="absolute left-full bottom-0 ml-1 w-52 max-h-72 overflow-y-auto bg-white dark:bg-slate-800 border border-[#ece9f0] dark:border-white/30 rounded-xl shadow-[0_10px_30px_-8px_rgba(60,40,100,0.25)] z-[60] py-1">
                {/* Default agent */}
                <button
                  type="button"
                  onClick={() => {
                    if (messagesLength > 0 && selectedAgent !== null) {
                      onPendingAgentChange(null);
                      onShowRemoveAgentConfirm();
                    } else {
                      onAgentSelect(null);
                    }
                    onClose();
                    setShowAgentSubmenu(false);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors glass-menu-item"
                >
                  <Sparkles
                    className={`w-4 h-4 ${!selectedAgent ? 'text-[#7c3aed]' : 'text-[#a89fb8] dark:text-slate-500'}`}
                  />
                  <span
                    className={
                      !selectedAgent
                        ? 'text-[#6d28d9] dark:text-[#a78bfa]'
                        : 'text-[#3a3350] dark:text-slate-300'
                    }
                  >
                    {t('agent.default')}
                  </span>
                  {!selectedAgent && (
                    <Check className="w-4 h-4 text-[#7c3aed] ml-auto" />
                  )}
                </button>

                {/* Custom agents */}
                {agents.map((agent) => {
                  const isSelected = selectedAgent?.agent_id === agent.agent_id;
                  return (
                    <button
                      key={agent.agent_id}
                      type="button"
                      onClick={() => {
                        if (
                          messagesLength > 0 &&
                          selectedAgent?.agent_id !== agent.agent_id
                        ) {
                          onPendingAgentChange(agent.name);
                          onShowRemoveAgentConfirm();
                        } else {
                          onAgentSelect(agent.name);
                        }
                        onClose();
                        setShowAgentSubmenu(false);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors glass-menu-item"
                    >
                      <Sparkles
                        className={`w-4 h-4 ${isSelected ? 'text-[#7c3aed]' : 'text-[#a89fb8] dark:text-slate-500'}`}
                      />
                      <span
                        className={`flex-1 text-left truncate ${
                          isSelected
                            ? 'text-[#6d28d9] dark:text-[#a78bfa]'
                            : 'text-[#3a3350] dark:text-slate-300'
                        }`}
                      >
                        {agent.name}
                      </span>
                      {isSelected && (
                        <Check className="w-4 h-4 text-[#7c3aed] flex-shrink-0" />
                      )}
                    </button>
                  );
                })}

                {/* Manage agents */}
                <div className="my-1 border-t border-[#ece9f0] dark:border-white/30" />
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    setShowAgentSubmenu(false);
                    onAgentClick();
                  }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#3a3350] dark:text-slate-300 glass-menu-item transition-colors"
                >
                  <Settings2 className="w-4 h-4 text-[#a89fb8] dark:text-slate-500" />
                  <span>{t('chat.manageAgents')}</span>
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
