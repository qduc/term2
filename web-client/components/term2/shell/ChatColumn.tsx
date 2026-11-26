'use client';

import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { Term2StatusBanner } from '../Term2StatusBanner';
import { ChatDock } from './ChatDock';
import { ChatHeaderRegion } from './ChatHeaderRegion';
import { EmptyChatCard, GoalBanner, ModelBlockedCard } from './ChatNotices';
import { useChatFacts, useSessionView, useShell, useShellEnv, useShellState } from './ShellContext';
import { DiagnosticsDetails, LiveStatusLine, PendingInteraction } from './TranscriptTail';
import { TranscriptPin, useTranscriptScroll } from './TranscriptScroll';
import { TranscriptTurns } from './TranscriptTurns';
import { WelcomeChecklist } from './WelcomeChecklist';

/** The chat column: header, status banner, the scrolling transcript and the dock with the message box. */
export function ChatColumn() {
  const shell = useShell();
  const { settingsOpen } = useShellEnv();
  const sidebarOpen = useShellState((s) => s.panels.sidebar);
  const sessionId = useChatFacts((f) => f.sessionId);
  const isDraft = useChatFacts((f) => f.isDraft);
  const pageError = useStoreSelector(shell.local, (l) => l.pageError);
  const status = useSessionView((v) => v.status);
  const viewError = useSessionView((v) => v.error);
  const { scrollRef, lastScrollTopRef, onScroll, scrollToLatest } = useTranscriptScroll();

  return (
    // Hidden, not unmounted, while settings is open so the chat keeps its draft and running stream.
    <div
      className={`flex min-w-0 flex-1 flex-col md:py-2 md:pr-2 ${sidebarOpen ? '' : 'md:pl-2'} ${
        settingsOpen ? 'hidden!' : ''
      }`}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-zinc-900 md:rounded-2xl md:border md:border-black/[0.06] md:shadow-[0_1px_3px_rgba(0,0,0,0.04)] md:dark:border-white/[0.06]">
        <ChatHeaderRegion />
        <section
          aria-label={sessionId ? 'Conversation' : 'Chat setup'}
          role={sessionId ? 'log' : undefined}
          aria-live={sessionId ? 'polite' : undefined}
          className="relative flex min-h-0 flex-1 flex-col"
        >
          {(sessionId || pageError) && (
            <Term2StatusBanner
              status={status}
              error={pageError ?? viewError}
              onRetry={() => {
                if (shell.local.get().pageError) void shell.ops.reloadLists();
                else void shell.session.refresh();
              }}
            />
          )}
          <TranscriptPin scrollRef={scrollRef} lastScrollTopRef={lastScrollTopRef} />
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className={`flex-1 overflow-y-auto px-4 pt-6 scrollbar-thin sm:px-6 ${
              sessionId || isDraft ? 'pb-60' : 'pb-12'
            }`}
          >
            <div className="mx-auto w-full max-w-[46rem] space-y-6">
              <WelcomeChecklist />
              <GoalBanner />
              <ModelBlockedCard />
              <EmptyChatCard />
              <TranscriptTurns />
              <LiveStatusLine />
              <PendingInteraction />
              <DiagnosticsDetails />
            </div>
          </div>
          <ChatDock scrollToLatest={scrollToLatest} />
        </section>
      </div>
    </div>
  );
}
