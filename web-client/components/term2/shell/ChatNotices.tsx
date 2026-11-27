'use client';

import { Info, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { shallowEqual } from '../../../lib/term2/store';
import { useChatFacts, useSessionView, useShell, useShellState } from './ShellContext';

const STARTER_PROMPTS = [
  'What files are in this folder?',
  'Summarize how this project is organized',
  'Find any TODOs or potential issues here',
];

/** Calm inline runtime notices (compaction outcomes, automatic memory, session notices). */
export function SessionNotices() {
  const notices = useSessionView((v) => v.session?.notices);
  const hasStreamingTurn = useChatFacts((f) => f.hasStreamingTurn);
  const visible = (notices ?? []).filter((n) => {
    const msg = n.message.trim();
    if (!msg) return false;
    if (hasStreamingTurn && n.kind === 'context_compaction' && /compacting/iu.test(msg)) return false;
    return true;
  });
  if (visible.length === 0) return null;
  return (
    <div role="status" aria-label="Session notices" className="space-y-1.5">
      {visible.map((notice, index) => {
        const failed = /fail/iu.test(notice.message);
        return (
          <p
            key={`${notice.kind}:${index}:${notice.message}`}
            className={`flex items-start gap-2 text-xs ${
              failed ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
            }`}
          >
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{notice.message}</span>
          </p>
        );
      })}
    </div>
  );
}

/** The session's active goal and any proposed goal, with interactive actions when supported. */
export function GoalBanner() {
  const shell = useShell();
  const sessionId = useChatFacts((f) => f.sessionId);
  const activeGoal = useSessionView((v) => v.session?.goal);
  const goalProposal = useSessionView((v) => v.session?.goalProposal);
  const activeVerification = useSessionView((v) => v.session?.verification);
  const canWrite = useStoreSelector(shell.data.settings, (s) => s.data?.capabilities?.goalsWrite !== false);
  if (!sessionId || (!activeGoal && !goalProposal)) return null;
  return (
    <div className="space-y-2">
      {activeGoal && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-teal-500/25 bg-teal-500/[0.06] px-4 py-3 text-xs dark:border-teal-400/20 dark:bg-teal-500/10">
          <Target className="mt-0.5 h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-teal-950 dark:text-teal-100">
              Goal{typeof activeGoal.status === 'string' ? ` · ${activeGoal.status}` : ''}
            </p>
            <p className="mt-0.5 text-zinc-700 dark:text-zinc-300">{activeGoal.text}</p>
            {activeVerification && (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Verification: {String(activeVerification.status ?? 'recorded')}
              </p>
            )}
            {canWrite && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {activeGoal.status === 'active' && (
                  <>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => void shell.session.setGoal({ action: 'achieved' })}
                    >
                      Mark achieved
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => void shell.session.setGoal({ action: 'abandon' })}
                    >
                      Abandon
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => void shell.session.setGoal({ action: 'clear' })}
                >
                  Clear
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      {goalProposal && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-xs">
          <Target className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-foreground">Suggested goal</p>
            <p className="mt-0.5 text-muted-foreground">{goalProposal.text}</p>
            {canWrite && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void shell.session.setGoal({ action: 'accept_proposal' })}
                >
                  Accept goal
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The chosen model cannot reply (no connection, unlisted, disabled), or a model must be chosen first. */
export function ModelBlockedCard() {
  const shell = useShell();
  const { ops } = shell;
  const f = useChatFacts(
    (facts) => ({
      modelBlocked: facts.modelBlocked,
      needsModelChoice: facts.needsModelChoice,
      hasAnyConfiguredProvider: facts.hasAnyConfiguredProvider,
      missingCredential: facts.missingCredential,
      pickerWarning: facts.pickerWarning,
      suggestedModel: facts.suggestedModel,
      pickerDisabled: facts.pickerDisabled,
      lastTurnFailed: facts.lastTurn?.status === 'failed',
    }),
    shallowEqual,
  );
  const settingsLoaded = useStoreSelector(shell.data.settings, (s) => Boolean(s.data));
  const configBusy = useShellState((s) => s.configApply !== null);
  if (!(f.modelBlocked || (f.needsModelChoice && settingsLoaded))) return null;
  const { suggestedModel } = f;
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/50 dark:text-amber-100">
      <h2 className="font-semibold">
        {f.needsModelChoice
          ? f.hasAnyConfiguredProvider
            ? 'Choose a model to send'
            : 'Connect an AI service to send'
          : f.missingCredential
          ? 'Connect an AI service to send'
          : 'This model isn’t ready to reply'}
      </h2>
      <p className="mt-1">{f.pickerWarning} You can keep drafting your message.</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {!f.needsModelChoice && suggestedModel && (
          <Button
            type="button"
            disabled={f.pickerDisabled || configBusy}
            onClick={() => {
              if (f.lastTurnFailed) void ops.retryLastTurn(suggestedModel);
              else
                void ops.updateSessionConfig({
                  modelSelection: { provider: suggestedModel.provider, model: suggestedModel.id },
                });
            }}
            size="sm"
          >
            {f.lastTurnFailed ? 'Switch and retry with' : 'Use'}{' '}
            {suggestedModel.name ?? suggestedModel.id}
          </Button>
        )}
        <Button type="button" onClick={ops.openProviderSetup} variant="outline" size="sm">
          {f.hasAnyConfiguredProvider ? 'Open provider settings' : 'Connect an AI service'}
        </Button>
      </div>
    </div>
  );
}

/** A chat or draft with no turns yet: starter prompts. */
export function EmptyChatCard() {
  const shell = useShell();
  const sessionId = useChatFacts((f) => f.sessionId);
  const isDraft = useChatFacts((f) => f.isDraft);
  const composerDisabled = useChatFacts((f) => f.composerDisabled);
  const folderName = useChatFacts((f) => f.selectedWorkspaceInfo.displayName);
  const noTurns = useSessionView((v) => v.turns.length === 0);
  const hasText = useShellState((s) => Boolean(s.composer.input.trim()));
  if (!((sessionId && noTurns) || isDraft)) return null;
  return (
    <div className="rounded-2xl border border-black/[0.06] bg-zinc-50/70 p-5 dark:border-white/[0.07] dark:bg-white/[0.02]">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
        What would you like help with in {folderName || 'this folder'}?
      </h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Click a suggestion to add it to your message, type <code className="font-mono">@</code> to mention
        a file, or paste an image.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {STARTER_PROMPTS.map((prompt) => (
          <Button
            key={prompt}
            type="button"
            disabled={composerDisabled || hasText}
            onClick={() => shell.composer.current?.setText(prompt)}
            variant="outline"
            size="sm"
            className="rounded-full"
          >
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  );
}
