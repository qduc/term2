/**
 * Header chrome for the agent surface, salvaged from ChatForge's
 * `components/ChatHeader.tsx`.
 *
 * Adapted (not redesigned) for the slice: the model selector
 * (`./ui/ModelSelector`), its `./ui/TabbedSelect` type and the auth button
 * (`./auth/AuthButton`) are pruned. The slice never renders them —
 * `Term2SessionShell` passes `showModelSelector={false}` and there is no login
 * flow to show — and they are the only paths that pulled ChatForge's product
 * surface (model catalog, comparison, auth modals) into this client. The props
 * the shell passes are kept unchanged so the shell needed no edit; the
 * model-selector-only props are retained for call-site compatibility and
 * ignored. Theme handling is unchanged.
 */
import { Sun, Moon, Settings, PanelLeft, PanelRight, Plus } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

interface ChatHeaderProps {
  isStreaming: boolean;
  onNewChat?: () => void;
  /** Label for the mobile new-chat button; reflects whether it resumes an existing session. */
  newChatLabel?: string;
  /** Accepted for call-site compatibility; model selection is not part of the slice. */
  model: string;
  /** Accepted for call-site compatibility; model selection is not part of the slice. */
  onModelChange: (model: string) => void;
  /** Accepted for call-site compatibility; the header always renders the title block. */
  showModelSelector?: boolean;
  onOpenSettings?: () => void;
  onToggleLeftSidebar?: () => void;
  onToggleRightSidebar?: () => void;
  showLeftSidebarButton?: boolean;
  alwaysShowLeftSidebarButton?: boolean;
  leftSidebarToggleLabel?: string;
  showRightSidebarButton?: boolean;
  title?: string;
  subtitle?: string;
  subtitleTooltip?: string;
  onExit?: () => void;
  exitLabel?: string;
  showSettingsButton?: boolean;
}

export function ChatHeader({
  onOpenSettings,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  showLeftSidebarButton = false,
  alwaysShowLeftSidebarButton = false,
  leftSidebarToggleLabel = 'Toggle conversation history',
  showRightSidebarButton = false,
  onNewChat,
  newChatLabel = 'New chat',
  title = 'Term2 agent',
  subtitle,
  subtitleTooltip,
  onExit,
  exitLabel = 'Chat',
  showSettingsButton = true,
}: ChatHeaderProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const toggleTheme = () => {
    if (theme === 'dark') {
      setTheme('light');
    } else {
      setTheme('dark');
    }
  };

  return (
    <header className="sticky top-0 z-40 bg-white dark:bg-zinc-900 border-b border-zinc-200/50 dark:border-zinc-800/50 backdrop-blur-sm bg-white/80 dark:bg-zinc-900/80">
      <div className="px-2 sm:px-4 md:px-6 py-2 sm:py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 sm:gap-2 flex-1 min-w-0">
          {/* Left Sidebar Toggle */}
          {showLeftSidebarButton && onToggleLeftSidebar && (
            <button
              onClick={onToggleLeftSidebar}
              className={`${
                alwaysShowLeftSidebarButton ? 'flex' : 'md:hidden flex'
              } w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 items-center justify-center text-zinc-600 dark:text-zinc-400 transition-colors flex-shrink-0`}
              title={leftSidebarToggleLabel}
              aria-label={leftSidebarToggleLabel}
              type="button"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          )}

          {/* New Chat Button - Mobile Only */}
          {onNewChat && (
            <button
              onClick={onNewChat}
              className="md:hidden w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-400 transition-colors flex-shrink-0"
              title={newChatLabel}
              aria-label={newChatLabel}
              type="button"
            >
              <Plus className="w-4 h-4" />
            </button>
          )}

          <div className="min-w-0">
            {subtitle && (
              <p
                className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
                title={subtitleTooltip || undefined}
              >
                {subtitle}
              </p>
            )}
            <h1 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
          </div>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          {onExit && (
            <button
              onClick={onExit}
              className="inline-flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              type="button"
            >
              {exitLabel}
            </button>
          )}
          {showSettingsButton && (
            <button
              onClick={onOpenSettings}
              className="w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 transition-colors"
              title="Open settings"
              aria-label="Open settings"
              type="button"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={toggleTheme}
            className="w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 transition-colors"
            title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
            type="button"
          >
            {resolvedTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* Right Sidebar Toggle - Mobile Only */}
          {showRightSidebarButton && onToggleRightSidebar && (
            <button
              onClick={onToggleRightSidebar}
              className="md:hidden w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 transition-colors"
              title="Toggle system prompts"
              aria-label="Toggle system prompts"
              type="button"
            >
              <PanelRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
