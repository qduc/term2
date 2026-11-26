'use client';

import { ArrowDown, CircleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Term2QueueBar } from '../Term2QueueBar';
import { Composer } from './Composer';
import { useChatFacts, useSessionView, useShell, useShellState } from './ShellContext';

/** The bottom dock while a chat or draft is open: jump to latest, the queue, the notice banner and the composer. */
export function ChatDock({ scrollToLatest }: { scrollToLatest: () => void }) {
  const shell = useShell();
  const sessionId = useChatFacts((f) => f.sessionId);
  const isDraft = useChatFacts((f) => f.isDraft);
  const pinned = useShellState((s) => s.pinned);
  const submitError = useChatFacts((f) => f.submitError);
  const notices = useShellState((s) => s.notices);
  if (!(sessionId || isDraft)) return null;
  const { config: configError, attachment: attachmentError, resend: resendNotice } = notices;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 overflow-visible bg-gradient-to-t from-white from-65% to-transparent px-3 pb-3 pt-10 dark:from-zinc-900 sm:px-6 sm:pb-4">
      {!pinned && (
        <div className="mb-2 flex justify-center">
          <Button
            type="button"
            aria-label="Jump to latest"
            variant="outline"
            size="icon"
            className="t2-enter pointer-events-auto rounded-full shadow-md"
            onClick={scrollToLatest}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        </div>
      )}

      <DockQueueBar />

      {(submitError || configError || attachmentError || resendNotice) && (
        <div
          role="alert"
          className="pointer-events-auto mx-auto mb-2 flex max-w-[46rem] items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/60 dark:text-red-300"
        >
          <span className="flex items-center gap-1.5">
            <CircleAlert className="h-3.5 w-3.5 shrink-0" />
            {submitError ?? configError ?? attachmentError ?? resendNotice}
          </span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={shell.ops.dismissNotices}
            className="rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-900/50"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <Composer />
    </div>
  );
}

/** The queued messages; it reads the whole view, so it subscribes on its own and the composer does not. */
function DockQueueBar() {
  const shell = useShell();
  const view = useSessionView((v) => v);
  return <Term2QueueBar view={view} onManageQueue={shell.session.manageQueue} />;
}
