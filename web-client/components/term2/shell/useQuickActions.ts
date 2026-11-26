'use client';

import { Archive, CircleHelp, Folder, History, Plus, RotateCcw, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { openSettings } from '../../../lib/term2/navigation';
import { shallowEqual } from '../../../lib/term2/store';
import type { QuickActionItem } from '../Term2ComposerPopovers';
import { useChatFacts, useSessionView, useShell, useShellEnv } from './ShellContext';

/** The slash / Cmd+K quick actions, filtered by what follows the slash. */
export function useQuickActions(slashQuery: string | null, clearPalette: () => void): QuickActionItem[] {
  const shell = useShell();
  const { localControlEnabled } = useShellEnv();
  const f = useChatFacts(
    (facts) => ({
      selectedWorkspaceId: facts.selectedWorkspaceId,
      startingChat: facts.startingChat,
      commandDisabled: facts.commandDisabled,
      sendBlocked: facts.sendBlocked,
      lastTurnStatus: facts.lastTurn?.status,
    }),
    shallowEqual,
  );
  const hasTurns = useSessionView((v) => v.turns.length > 0);
  return useMemo(() => {
    const { dispatch, ops, session } = shell;
    const items: QuickActionItem[] = [
      {
        id: 'new-chat',
        label: 'New chat',
        hint: 'Start a fresh conversation in the selected folder',
        icon: Plus,
        disabled: !f.selectedWorkspaceId || f.startingChat,
        run: () => {
          clearPalette();
          void ops.createNewChat();
        },
      },
      {
        id: 'compact',
        label: 'Compact context',
        hint: 'Summarize older turns to free up context window',
        icon: Archive,
        disabled: f.commandDisabled,
        run: () => {
          clearPalette();
          void session.invokeCommand('compact');
        },
      },
      {
        id: 'rewind',
        label: 'Rewind conversation',
        hint: 'Undo back to an earlier message and edit your prompt',
        icon: History,
        disabled: f.commandDisabled || !hasTurns,
        run: () => {
          clearPalette();
          dispatch({ type: 'DIALOG_OPENED', dialog: 'rewind' });
        },
      },
      {
        id: 'retry-turn',
        label: 'Retry failed turn',
        hint: 'Regenerate the last failed reply',
        icon: RotateCcw,
        disabled:
          f.commandDisabled ||
          f.sendBlocked ||
          f.lastTurnStatus === undefined ||
          !['failed', 'aborted'].includes(f.lastTurnStatus),
        run: () => {
          clearPalette();
          void ops.retryLastTurn();
        },
      },
      {
        id: 'settings',
        label: 'Open settings',
        hint: 'Manage AI providers, API keys, models, and preferences',
        icon: Settings,
        disabled: !localControlEnabled,
        run: () => {
          clearPalette();
          openSettings();
        },
      },
      {
        id: 'folder',
        label: 'Choose a folder',
        hint: 'Grant access to a different local project folder',
        icon: Folder,
        disabled: !localControlEnabled,
        run: () => {
          clearPalette();
          dispatch({ type: 'DIALOG_OPENED', dialog: 'folder' });
        },
      },
      {
        id: 'help',
        label: 'Help & keyboard shortcuts',
        hint: 'Learn how to mention files, paste images, and manage chats',
        icon: CircleHelp,
        run: () => {
          clearPalette();
          dispatch({ type: 'DIALOG_OPENED', dialog: 'help' });
        },
      },
    ];
    const needle = (slashQuery ?? '').toLowerCase();
    return needle
      ? items.filter((item) => item.label.toLowerCase().includes(needle) || item.id.includes(needle))
      : items;
  }, [shell, f, hasTurns, localControlEnabled, slashQuery, clearPalette]);
}
