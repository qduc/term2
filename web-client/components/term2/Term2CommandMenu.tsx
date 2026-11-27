'use client';

import { useRef, useState } from 'react';
import {
  Archive,
  ArrowRightLeft,
  AtSign,
  ImagePlus,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Wand2,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TERM2_COMMAND_IDS, type Term2CommandId } from '../../lib/term2/types';

const COMMAND_LABELS: Record<Term2CommandId, string> = {
  compact: 'Compact context',
  rollover: 'Roll over context',
  'retry-tool': 'Retry last tool',
  'retry-turn': 'Retry failed turn',
};

const COMMAND_HINTS: Record<Term2CommandId, string> = {
  compact: 'Summarise history to free up context',
  rollover: 'Start a fresh context window in this chat',
  'retry-tool': 'Run the last tool call again',
  'retry-turn': 'Start the failed turn over',
};

const COMMAND_ICONS: Record<Term2CommandId, typeof Archive> = {
  compact: Archive,
  rollover: RefreshCw,
  'retry-tool': Wrench,
  'retry-turn': RotateCcw,
};

/**
 * The composer's single "+" menu: add-to-message actions (image, file mention,
 * skill) and session commands, so they don't crowd the input as separate buttons.
 */
export function Term2CommandMenu({
  composerDisabled,
  commandsDisabled,
  pending,
  notice,
  onAttachImage,
  onMentionFile,
  onUseSkill,
  onCommand,
  onHandoff,
}: {
  composerDisabled: boolean;
  commandsDisabled: boolean;
  pending: boolean;
  notice: { tone: 'neutral' | 'error'; message: string } | null;
  onAttachImage: () => void;
  onMentionFile: () => void;
  /** Opens the skill picker; called after the menu has closed so the picker can take focus. */
  onUseSkill: () => void;
  onCommand: (commandId: Term2CommandId) => void;
  onHandoff?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Actions that move focus elsewhere (composer, skill picker) must stop the
  // menu from returning focus to the "+" button as it closes.
  const keepFocusRef = useRef(false);
  const disabled = composerDisabled && commandsDisabled;
  const select = (action: () => void, keepFocus = true) => () => {
    keepFocusRef.current = keepFocus;
    action();
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <DropdownMenu modal={false} open={open && !disabled} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Add to message and session commands"
            title="Attach, mention, skills and commands"
            className="rounded-full"
          >
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          className="w-64"
          onCloseAutoFocus={(event) => {
            if (!keepFocusRef.current) return;
            keepFocusRef.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={composerDisabled} onSelect={select(onAttachImage, false)}>
              <ImagePlus aria-hidden strokeWidth={1.75} />
              Attach image
            </DropdownMenuItem>
            <DropdownMenuItem disabled={composerDisabled} onSelect={select(onMentionFile)}>
              <AtSign aria-hidden strokeWidth={1.75} />
              Mention a file
              <DropdownMenuShortcut>@</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={composerDisabled}
              onSelect={select(() => {
                // Let the menu finish closing before the picker opens and takes focus.
                window.setTimeout(onUseSkill, 0);
              })}
            >
              <Wand2 aria-hidden strokeWidth={1.75} />
              Use a skill…
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Session</DropdownMenuLabel>
            {TERM2_COMMAND_IDS.map((commandId) => {
              const Icon = COMMAND_ICONS[commandId];
              return (
                <DropdownMenuItem
                  key={commandId}
                  disabled={commandsDisabled}
                  onSelect={select(() => onCommand(commandId), false)}
                  className="items-start"
                >
                  <Icon aria-hidden className="mt-0.5" strokeWidth={1.75} />
                  <span className="min-w-0">
                    <span className="block">{COMMAND_LABELS[commandId]}</span>
                    <span className="block text-xs text-muted-foreground">{COMMAND_HINTS[commandId]}</span>
                  </span>
                </DropdownMenuItem>
              );
            })}
            {onHandoff && (
              <DropdownMenuItem
                disabled={commandsDisabled}
                onSelect={select(onHandoff, false)}
                className="items-start"
              >
                <ArrowRightLeft aria-hidden className="mt-0.5" strokeWidth={1.75} />
                <span className="min-w-0">
                  <span className="block">Hand off to new chat</span>
                  <span className="block text-xs text-muted-foreground">Continue from the latest reply in a fresh chat</span>
                </span>
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {pending && <span className="text-xs text-zinc-500">Running…</span>}
      {notice && (
        <p
          role="status"
          className={`truncate text-xs ${notice.tone === 'error' ? 'text-red-700 dark:text-red-400' : 'text-zinc-500'}`}
        >
          {notice.message}
        </p>
      )}
    </div>
  );
}
