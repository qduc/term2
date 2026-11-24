/**
 * Header chrome for the agent surface, salvaged from ChatForge's
 * `components/ChatHeader.tsx`.
 *
 * Adapted for the slice: the model selector
 * (`./ui/ModelSelector`), its `./ui/TabbedSelect` type and the auth button
 * (`./auth/AuthButton`) are pruned. The slice never renders them —
 * `Term2SessionShell` passes `showModelSelector={false}` and there is no login
 * flow to show — and they are the only paths that pulled ChatForge's product
 * surface (model catalog, comparison, auth modals) into this client. The
 * model-selector-only props are retained for call-site compatibility and
 * ignored. Theme handling is unchanged; the chrome itself is a slim
 * breadcrumb bar (workspace / session title) with ghost icon buttons.
 */
import { Sun, Moon, Settings, PanelLeft, PanelRight, Plus, CircleHelp, Folder } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

interface ChatHeaderProps {
  isStreaming: boolean;
  onNewChat?: () => void;
  /** Label for the new-chat button. */
  newChatLabel?: string;
  /** Accepted for call-site compatibility; model selection lives in Term2ModelPicker. */
  model: string;
  /** Accepted for call-site compatibility. */
  onModelChange: (model: string) => void;
  /** Accepted for call-site compatibility. */
  showModelSelector?: boolean;
  onOpenSettings?: () => void;
  onOpenHelp?: () => void;
  onOpenFolder?: () => void;
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
  showThemeToggle?: boolean;
}

export function ChatHeader({
  onOpenSettings,
  onOpenHelp,
  onOpenFolder,
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
  showThemeToggle = true,
}: ChatHeaderProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const toggleTheme = () => {
    if (theme === 'dark') {
      setTheme('light');
    } else {
      setTheme('dark');
    }
  };

  const iconButton =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100';

  return (
    <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center justify-between gap-2 border-b border-black/[0.04] px-2 sm:px-3 dark:border-white/[0.05]">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {showLeftSidebarButton && onToggleLeftSidebar && (
          <button
            onClick={onToggleLeftSidebar}
            className={`${alwaysShowLeftSidebarButton ? '' : 'md:hidden'} ${iconButton}`}
            title={leftSidebarToggleLabel}
            aria-label={leftSidebarToggleLabel}
            type="button"
          >
            <PanelLeft className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
        )}

        <div className="ml-1 flex min-w-0 items-center gap-1.5 text-sm">
          {subtitle && (
            <>
              {onOpenFolder ? (
                <button
                  type="button"
                  onClick={onOpenFolder}
                  title={subtitleTooltip || 'Switch or add folder'}
                  className="hidden shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-900 sm:inline-flex dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
                >
                  <Folder className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span className="max-w-[10rem] truncate">{subtitle}</span>
                </button>
              ) : (
                <span
                  className="hidden shrink-0 text-zinc-500 sm:inline dark:text-zinc-400"
                  title={subtitleTooltip || undefined}
                >
                  {subtitle}
                </span>
              )}
              <span aria-hidden className="hidden text-zinc-300 sm:inline dark:text-zinc-600">
                /
              </span>
            </>
          )}
          <h1 className="truncate font-medium text-zinc-900 dark:text-zinc-100">{title}</h1>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {onNewChat && (
          <button
            onClick={onNewChat}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-black/[0.08] px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-black/[0.04] hover:text-zinc-950 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/[0.06] dark:hover:text-white"
            title={newChatLabel}
            aria-label={newChatLabel}
            type="button"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            <span className="hidden sm:inline">{newChatLabel}</span>
          </button>
        )}
        {onExit && (
          <button
            onClick={onExit}
            className="h-8 rounded-lg px-2.5 text-sm text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100"
            type="button"
          >
            {exitLabel}
          </button>
        )}
        {onOpenHelp && (
          <button onClick={onOpenHelp} className={iconButton} title="Help & shortcuts" aria-label="Help and shortcuts" type="button">
            <CircleHelp className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
        )}
        {showSettingsButton && (
          <button onClick={onOpenSettings} className={iconButton} title="Open settings" aria-label="Open settings" type="button">
            <Settings className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
        )}
        {showThemeToggle && (
        <button
          onClick={toggleTheme}
          className={iconButton}
          title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
          aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
          type="button"
        >
          {resolvedTheme === 'dark' ? (
            <Sun className="h-[18px] w-[18px]" strokeWidth={1.75} />
          ) : (
            <Moon className="h-[18px] w-[18px]" strokeWidth={1.75} />
          )}
        </button>
        )}

        {showRightSidebarButton && onToggleRightSidebar && (
          <button
            onClick={onToggleRightSidebar}
            className={`md:hidden ${iconButton}`}
            title="Toggle system prompts"
            aria-label="Toggle system prompts"
            type="button"
          >
            <PanelRight className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
        )}
      </div>
    </header>
  );
}
