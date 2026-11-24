'use client';

import { useState } from 'react';
import { Archive, Ellipsis, Loader2, RotateCcw, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { TERM2_COMMAND_IDS, type Term2CommandId } from '../../lib/term2/types';

const COMMAND_LABELS: Record<Term2CommandId, string> = {
  compact: 'Compact context',
  'retry-tool': 'Retry last tool',
  'retry-turn': 'Retry failed turn',
};

const COMMAND_HINTS: Record<Term2CommandId, string> = {
  compact: 'Summarise history to free up context',
  'retry-tool': 'Run the last tool call again',
  'retry-turn': 'Start the failed turn over',
};

const COMMAND_ICONS: Record<Term2CommandId, typeof Archive> = {
  compact: Archive,
  'retry-tool': Wrench,
  'retry-turn': RotateCcw,
};

/** Session commands live behind one composer button so they don't crowd the input. */
export function Term2CommandMenu({
  disabled,
  pending,
  notice,
  onCommand,
}: {
  disabled: boolean;
  pending: boolean;
  notice: { tone: 'neutral' | 'error'; message: string } | null;
  onCommand: (commandId: Term2CommandId) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <DropdownMenu modal={false} open={open && !disabled} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Session commands"
            title="Session commands"
            className="rounded-full"
          >
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : <Ellipsis aria-hidden />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64">
          {TERM2_COMMAND_IDS.map((commandId) => {
            const Icon = COMMAND_ICONS[commandId];
            return (
              <DropdownMenuItem key={commandId} onSelect={() => onCommand(commandId)} className="items-start">
                <Icon aria-hidden className="mt-0.5" strokeWidth={1.75} />
                <span className="min-w-0">
                  <span className="block">{COMMAND_LABELS[commandId]}</span>
                  <span className="block text-xs text-muted-foreground">{COMMAND_HINTS[commandId]}</span>
                </span>
              </DropdownMenuItem>
            );
          })}
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
