'use client';

import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { shellSandboxMachineFact } from '../../../lib/term2/shell-sandbox-notice';
import { currentTag } from '../../../lib/term2/shell-machine';
import { Term2InteractionPanel } from '../Term2InteractionPanel';
import { Term2NativeEvidence } from '../Term2NativeEvidence';
import { Term2SessionConfig } from '../Term2SessionConfig';
import { useChatFacts, useSessionView, useShell, useShellEnv } from './ShellContext';

/** The live status line under the last turn. */
export function LiveStatusLine() {
  const hasStreamingTurn = useChatFacts((f) => f.hasStreamingTurn);
  const visibleLiveStatus = useChatFacts((f) => f.visibleLiveStatus);
  const interactionPending = useChatFacts((f) => f.interactionPending);
  // While a prompt is pending the card below is the status; a second line would repeat it.
  // Reserve the 1-line slot during an active turn so status transitions don't bounce the transcript.
  if (!((hasStreamingTurn || visibleLiveStatus) && !interactionPending)) return null;
  return (
    <p
      role="status"
      className={`flex min-h-5 items-center gap-2.5 text-sm ${visibleLiveStatus ? '' : 'invisible'}`}
    >
      {visibleLiveStatus && (
        <>
          <span
            aria-hidden
            className="t2-heartbeat h-2 w-2 shrink-0 rounded-full bg-teal-500 ring-2 ring-teal-400/30"
          />
          <span className="t2-shimmer truncate">{visibleLiveStatus}</span>
        </>
      )}
    </p>
  );
}

/** An approval or question waiting for the user, or one recovered after a restart. */
export function PendingInteraction() {
  const shell = useShell();
  const pendingInteraction = useSessionView((v) => v.pendingInteraction);
  const aborting = useChatFacts((f) => f.aborting);
  const sandboxNotice = useStoreSelector(shell.data.settings, (s) => s.data?.shellSandboxNotice);
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
