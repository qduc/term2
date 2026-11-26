'use client';

import { Check, CircleAlert, Copy, RotateCcw } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { openSettings } from '../../../lib/term2/navigation';
import { shallowEqual } from '../../../lib/term2/store';
import type { Term2TurnView } from '../../../lib/term2/types';
import { Term2RetryReply, Term2UserMessage } from '../Term2MessageActions';
import { Term2TurnTimeline } from '../Term2TurnTimeline';
import { useChatFacts, useSessionView, useShell, useShellEnv, useShellState } from './ShellContext';
import { currentTag } from '../../../lib/term2/shell-machine';

/** The conversation's turns. Each turn re-renders only when it, or what it reads, changes. */
export function TranscriptTurns() {
  const turns = useSessionView((v) => v.turns);
  const [copiedTurn, setCopiedTurn] = useState<string | null>(null);
  const copyTurn = useCallback((turnId: string, text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedTurn(turnId);
        window.setTimeout(() => setCopiedTurn((id) => (id === turnId ? null : id)), 1500);
      })
      .catch(() => undefined);
  }, []);
  return (
    <>
      {turns.map((turn, turnIndex) => (
        <TranscriptTurn
          key={turn.turnId}
          turn={turn}
          laterTurns={turns.length - 1 - turnIndex}
          isLast={turnIndex === turns.length - 1}
          copiedUser={copiedTurn === `${turn.turnId}:user`}
          copiedReply={copiedTurn === turn.turnId}
          copyTurn={copyTurn}
        />
      ))}
    </>
  );
}

const TranscriptTurn = memo(function TranscriptTurn({
  turn,
  laterTurns,
  isLast,
  copiedUser,
  copiedReply,
  copyTurn,
}: {
  turn: Term2TurnView;
  laterTurns: number;
  isLast: boolean;
  copiedUser: boolean;
  copiedReply: boolean;
  copyTurn: (turnId: string, text: string) => void;
}) {
  const shell = useShell();
  const { ops } = shell;
  const { localControlEnabled } = useShellEnv();
  const f = useChatFacts(
    (facts) => ({
      sessionId: facts.sessionId,
      commandDisabled: facts.commandDisabled,
      sendBlocked: facts.sendBlocked,
      suggestedModel: facts.suggestedModel,
      modelBlocked: facts.modelBlocked,
      providerId: facts.providerId,
    }),
    shallowEqual,
  );
  // What this turn reads of the chat's own intent; it goes when the page shows something else.
  const local = useShellState(
    (s) => ({
      configBusy: s.configApply !== null,
      retryError: s.retryError?.turnId === turn.turnId ? s.retryError.message : null,
      retryDraft: s.retryDraft?.turnId === turn.turnId ? s.retryDraft : null,
    }),
    shallowEqual,
  );
  const displayMode = useStoreSelector(shell.prefs, (p) => p.displayMode);
  const { commandDisabled, sendBlocked, suggestedModel, modelBlocked } = f;
  const { configBusy, retryDraft } = local;

  return (
    <article className="t2-enter group space-y-5">
      {turn.userText !== undefined && (
        <Term2UserMessage
          turnId={turn.turnId}
          text={turn.userText}
          content={turn.userContent}
          copied={copiedUser}
          onCopy={() => copyTurn(`${turn.turnId}:user`, turn.userText ?? '')}
          disabled={commandDisabled}
          laterTurns={laterTurns}
          onResend={ops.resendFromTurn}
        />
      )}
      <div className="min-w-0 space-y-4">
        <Term2TurnTimeline turn={turn} displayMode={displayMode} />
        {turn.status !== 'completed' && turn.status !== 'streaming' && turn.status !== 'pending' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] px-2.5 py-0.5 text-xs text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-400">
              {turn.interruptedByFault
                ? 'Interrupted by an error (reload to check saved state)'
                : turn.status === 'aborted'
                ? 'Stopped'
                : `Turn ${turn.status}`}
            </span>
            {isLast &&
              (turn.status === 'failed' || turn.status === 'aborted') &&
              !turn.error &&
              !commandDisabled &&
              !sendBlocked && (
                <Button
                  type="button"
                  onClick={() => void ops.retryLastTurn()}
                  variant="outline"
                  size="xs"
                  className="rounded-full"
                >
                  <RotateCcw className="h-3 w-3" />
                  Retry turn
                </Button>
              )}
            {isLast &&
              turn.status === 'failed' &&
              !turn.error &&
              suggestedModel &&
              !modelBlocked &&
              !commandDisabled &&
              !configBusy &&
              retryDraft?.turnId !== turn.turnId && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void ops.retryLastTurn(suggestedModel)}
                >
                  Switch and retry with {suggestedModel.name ?? suggestedModel.id}
                </Button>
              )}
          </div>
        )}
        {(turn.error || turn.errorMessage) && (
          <div className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            <p className="flex min-w-0 flex-1 items-start gap-2">
              <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {turn.errorMessage
                  ? turn.errorMessage
                  : turn.error === 'provider_error' || turn.error === 'runtime_error'
                    ? 'The AI service could not reply. Check your provider settings or click Retry to try again.'
                    : turn.error}
              </span>
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {isLast &&
                turn.status === 'failed' &&
                suggestedModel &&
                !modelBlocked &&
                retryDraft?.turnId !== turn.turnId &&
                !commandDisabled &&
                !configBusy &&
                (turn.error === 'provider_error' || turn.error === 'runtime_error') && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void ops.retryLastTurn(suggestedModel)}
                  >
                    Switch and retry with {suggestedModel.name ?? suggestedModel.id}
                  </Button>
                )}
              {isLast && !commandDisabled && !sendBlocked && (
                <Button
                  type="button"
                  onClick={() => void ops.retryLastTurn()}
                  variant="destructive"
                  size="xs"
                >
                  Retry
                </Button>
              )}
              {localControlEnabled && (
                <Button
                  type="button"
                  onClick={() => openSettings('providers', f.providerId || null)}
                  variant="outline"
                  size="xs"
                >
                  Settings
                </Button>
              )}
            </div>
          </div>
        )}
        {turn.text && turn.status !== 'streaming' && (
          <div className="-ml-1.5 flex items-center gap-1 text-zinc-400 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <Button
              type="button"
              aria-label="Copy reply"
              title="Copy reply"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => copyTurn(turn.turnId, turn.text)}
            >
              {copiedReply ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
            {turn.userText ? (
              <Term2RetryReply
                turnId={turn.turnId}
                userText={turn.userText}
                disabled={commandDisabled}
                laterTurns={laterTurns}
                onResend={ops.retryReply}
              />
            ) : null}
            {turn.usage?.totalTokens ? (
              <span className="text-xs tabular-nums">
                {turn.usage.totalTokens.toLocaleString()} tokens
              </span>
            ) : null}
          </div>
        )}
        {local.retryError !== null && (
          <p role="alert" className="text-xs text-destructive">
            {local.retryError}
          </p>
        )}
        {retryDraft && turn.userText && (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              This chat couldn’t switch models. You can copy the last prompt into a new draft without
              changing this chat.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const { provider, id: model } = retryDraft.model;
                void ops.createNewChat();
                shell.dispatch({ type: 'DRAFT_CONFIG_PICKED', selection: { modelSelection: { provider, model } } });
                shell.dispatch({ type: 'COMPOSER_EDITED', patch: { input: turn.userText ?? '' } });
                shell.dispatch({ type: 'RETRY_DRAFT', tag: currentTag(shell.store.get()), draft: null });
              }}
            >
              Open a new draft with {retryDraft.model.name ?? retryDraft.model.id}
            </Button>
          </div>
        )}
      </div>
    </article>
  );
});
