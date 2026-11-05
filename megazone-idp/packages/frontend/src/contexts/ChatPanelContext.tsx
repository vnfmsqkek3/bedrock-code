import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface ChatPanelContextValue {
  isChatOpen: boolean;
  toggleChat: () => void;
  openChat: () => void;
  closeChat: () => void;
}

const STORAGE_KEY = 'idp-chat-panel-open';

const ChatPanelContext = createContext<ChatPanelContextValue | null>(null);

function getStoredValue(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function storeValue(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch (e) {
    console.error('Failed to save chat panel state:', e);
  }
}

export function ChatPanelProvider({ children }: { children: ReactNode }) {
  const [isChatOpen, setIsChatOpen] = useState(getStoredValue);

  const toggleChat = useCallback(() => {
    setIsChatOpen(prev => {
      const next = !prev;
      storeValue(next);
      return next;
    });
  }, []);

  const openChat = useCallback(() => {
    setIsChatOpen(true);
    storeValue(true);
  }, []);

  const closeChat = useCallback(() => {
    setIsChatOpen(false);
    storeValue(false);
  }, []);

  return (
    <ChatPanelContext.Provider value={{ isChatOpen, toggleChat, openChat, closeChat }}>
      {children}
    </ChatPanelContext.Provider>
  );
}

export function useChatPanel(): ChatPanelContextValue {
  const ctx = useContext(ChatPanelContext);
  if (!ctx) throw new Error('useChatPanel must be used within ChatPanelProvider');
  return ctx;
}
