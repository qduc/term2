'use client';

import { useEffect, useState } from 'react';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { shellSandboxMachineFact } from '../../../lib/term2/shell-sandbox-notice';
import { currentTag } from '../../../lib/term2/shell-machine';
import { Term2InteractionPanel } from '../Term2InteractionPanel';
import { Term2NativeEvidence } from '../Term2NativeEvidence';
import { Term2SessionConfig } from '../Term2SessionConfig';
import { useChatFacts, useSessionView, useShell, useShellEnv } from './ShellContext';

/**
 * The live status line under the last turn, like the TUI's working line: `Thinking… 12s`. While a turn runs it
 * always has text, so status changes swap words in a fixed slot instead of making the line come and go.
 */
export function LiveStatusLine() {
  const hasStreamingTurn = useChatFacts((f) => f.hasStreamingTurn);
  const liveStatus = useChatFacts((f) => f.liveStatus);
  const interactionPending = useChatFacts((f) => f.interactionPending);
  const runningTurnId = useChatFacts((f) => f.runningTurnId);
  // While a prompt is pending the card below is the status; a second line would repeat it.
  // The 1-line slot (16px gap + 24px height) matches the reply action bar, so turn completion doesn't bounce the transcript.
  if (!((hasStreamingTurn || liveStatus) && !interactionPending)) return null;
  return (
    <p role="status" className={`-mt-2 flex h-6 items-center gap-2.5 text-sm ${liveStatus ? '' : 'invisible'}`}>
      {liveStatus && (
        <>
          <span
            aria-hidden
            className="t2-heartbeat h-2 w-2 shrink-0 rounded-full bg-teal-500 ring-2 ring-teal-400/30"
          />
          <span className="t2-shimmer truncate">{liveStatus}</span>
          {runningTurnId && <TurnElapsed turnId={runningTurnId} />}
        </>
      )}
    </p>
  );
}

/** When this page first saw the running turn, so hiding the line for an approval does not restart the count. */
let turnSeen: { readonly turnId: string; readonly at: number } | null = null;

/** Seconds since this page first saw the running turn. */
function TurnElapsed({ turnId }: { turnId: string }) {
  if (turnSeen?.turnId !== turnId) turnSeen = { turnId, at: Date.now() };
  const startedAt = turnSeen.at;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="shrink-0 tabular-nums text-zinc-400 dark:text-zinc-500">
      {Math.max(0, Math.floor((now - startedAt) / 1000))}s
    </span>
  );
}

/** An approval or question waiting for the user, a live AI safety review, or a budget pause. */
export function PendingInteraction() {
  const shell = useShell();
  const pendingInteraction = useSessionView((v) => v.pendingInteraction);
  const reviewing = useSessionView((v) => v.session?.reviewingApprovals);
  const pendingBudgets = useSessionView((v) => v.session?.pendingBudgets);
  const aborting = useChatFacts((f) => f.aborting);
  const sandboxNotice = useStoreSelector(shell.data.settings, (s) => s.data?.shellSandboxNotice);
  const canTakeOver = useStoreSelector(
    shell.data.settings,
    (s) => s.data?.capabilities?.approvalReviewTakeover !== false,
  );
  if (pendingInteraction?.state === 'pending')
    return (
      <div id="term2-pending-interaction" className="scroll-mt-4">
        <Term2InteractionPanel
          key={`${pendingInteraction.interaction.interactionId}:${
            pendingInteraction.interaction.revision
          }:${pendingInteraction.interaction.askUser?.currentQuestionIndex ?? 0}`}
          interaction={pendingInteraction.interaction}
          subagent={pendingInteraction.subagent}
          shellSandboxNotice={shellSandboxMachineFact(sandboxNotice) ?? undefined}
          onResolve={shell.session.resolveInteraction}
          disabled={aborting}
        />
      </div>
    );
  if (pendingInteraction?.state === 'recovered')
    return (
      <Term2InteractionPanel
        key={`${pendingInteraction.interaction.interactionId}:${pendingInteraction.interaction.revision}:recovered`}
        interaction={pendingInteraction.interaction}
        recovered
        onResolve={shell.session.resolveInteraction}
      />
    );
  if (pendingInteraction?.state === 'unavailable') {
    const budget = pendingBudgets?.find((entry) => entry.requestId === pendingInteraction.requestId);
    if (budget) {
      return (
        <div
          id="term2-pending-interaction"
          role="region"
          aria-label="Run budget paused"
          className="scroll-mt-4 rounded-2xl border border-amber-300 bg-amber-50/70 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/40"
        >
          <p className="font-medium text-amber-950 dark:text-amber-100">Run budget paused</p>
          <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-200/80">
            {budget.evidence.type === 'tool_stall'
              ? `Repeated tool calls detected (${budget.evidence.toolName}).`
              : `Run budget limit reached (${budget.evidence.stage}).`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={aborting}
              onClick={() =>
                void shell.session.resolveInteraction({ interactionId: budget.requestId, revision: 1, answer: 'approve' })
              }
              className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              Extend budget
            </button>
            <button
              type="button"
              disabled={aborting}
              onClick={() =>
                void shell.session.resolveInteraction({ interactionId: budget.requestId, revision: 1, answer: 'reject' })
              }
              className="rounded-md border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              Stop
            </button>
          </div>
        </div>
      );
    }
  }
  const activeReview = reviewing?.[0];
  if (activeReview) {
    return (
      <div
        role="status"
        aria-label="Safety review in progress"
        className="flex items-center justify-between gap-3 rounded-xl border bg-muted/40 px-3.5 py-2.5 text-xs text-muted-foreground"
      >
        <span className="min-w-0 truncate">
          AI reviewer is checking <span className="font-medium text-foreground">{activeReview.toolName}</span>…
        </span>
        {canTakeOver && (
          <button
            type="button"
            disabled={aborting}
            onClick={() =>
              void shell.session.resolveInteraction({
                interactionId: activeReview.requestId,
                revision: 1,
                answer: 'take_over_review',
              })
            }
            className="shrink-0 rounded-md border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            Decide myself
          </button>
        )}
      </div>
    );
  }
  return null;
}

/** With diagnostics on: the open chat's config and the raw session state. */
export function DiagnosticsDetails() {
  const shell = useShell();
  const { localControlEnabled } = useShellEnv();
  const showDiagnostics = useStoreSelector(shell.prefs, (p) => p.showDiagnostics);
  const sessionId = useChatFacts((f) => f.sessionId);
  const sessionConfig = useChatFacts((f) => f.sessionConfig);
  const settings = useStoreSelector(shell.data.settings, (s) => s.data);
  const view = useSessionView((v) => v);
  if (!(showDiagnostics && sessionId && (view.turns.length > 0 || Boolean(view.error)))) return null;
  return (
    <details className="pt-2 text-xs text-zinc-400 dark:text-zinc-500">
      <summary className="cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300">
        Diagnostics &amp; raw session state
      </summary>
      <div className="mt-2 space-y-2 text-zinc-600 dark:text-zinc-400">
        {localControlEnabled && (
          <Term2SessionConfig
            key={sessionId}
            config={sessionConfig}
            onDiscovered={(config) =>
              shell.dispatch({ type: 'CONFIG_LOADED', tag: currentTag(shell.store.get()), config })
            }
            settings={settings}
            sessionId={sessionId}
            onCreateNewSession={() => void shell.ops.createNewChat()}
          />
        )}
        <Term2NativeEvidence view={view} frames={shell.session.frames()} />
      </div>
    </details>
  );
}
