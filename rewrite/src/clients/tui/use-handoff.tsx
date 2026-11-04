import React, { useEffect, useRef } from 'react';
import { useApp } from 'ink';
import type { CommandResult, TuiConnection } from './integration.js';
import type { TuiState } from './state.js';
import { composeHandoffMessage, handoffFlowReducer, type HandoffAction, type HandoffState } from './handoff-flow.js';
import HandoffConfirmationPrompt from './presentation/components/prompt/HandoffConfirmationPrompt.js';
import { replaceSession } from './replace-session.js';

/** The handoff outlives the session it clears, so the app shell above the keyed session holds it. */
export type HandoffHolder = {
  /** `sendOnOpen`: No was chosen, so the new session sends the handoff as soon as it is up. */
  readonly state: (HandoffState & { readonly sendOnOpen?: true }) | null;
  set(next: (HandoffState & { readonly sendOnOpen?: true }) | null): void;
};

const HANDOFF_PROMPT_LABEL = 'Handoff message (enter to use default message): ';

/**
 * Legacy useHandoffFlow/HandoffSession: /handoff asks for a message, then "Change model?"; Yes starts a new
 * conversation and walks the model and effort menus, No starts it and sends at once. The plan-mode
 * "switch to Bare first" branch is not ported: the plan profile is dropped (accepted-differences.md).
 */
export function useHandoff(options: {
  readonly holder: HandoffHolder | undefined;
  readonly state: TuiState;
  readonly connection: TuiConnection;
  readonly switchSession:
    | ((sessionId: string, notice?: string, opening?: readonly string[]) => Promise<void>)
    | undefined;
  /** replaceSession's hooks: print usage as the conversation is left, then arm the new one's opening. */
  readonly resetHooks: Parameters<typeof replaceSession>[4];
  readonly menuOpen: boolean;
  readonly replaceInput: (text: string) => void;
  readonly notice: (text: string) => void;
  /** Send a chat message as if typed; settles once the send is admitted or refused. */
  readonly send: (text: string) => Promise<void>;
}) {
  const { holder, state, connection, menuOpen, replaceInput, notice, send } = options;
  const handoff = holder?.state ?? null;
  const dispatch = (action: HandoffAction) => holder?.set(handoffFlowReducer(handoff, action));
  const sendAndFinish = (current: HandoffState) => {
    const { capturedText, handoffMessage } = current;
    holder?.set(null);
    if (!capturedText) return Promise.resolve();
    return send(composeHandoffMessage({ capturedText, handoffMessage, stage: current.stage }));
  };
  // Legacy clearConversationAndRefreshBanner: the new session opens under the boundary with no welcome line.
  const clear = async (next: NonNullable<HandoffHolder['state']>) => {
    holder?.set(next);
    try {
      const failure = await replaceSession(connection, '/clear', options.switchSession, [], options.resetHooks);
      if (failure !== null) throw new Error(failure);
    } catch (error) {
      holder?.set(null);
      notice(error instanceof Error ? error.message : String(error));
    }
  };

  // After Yes the new session opens the model menu; after No it sends straight away.
  useEffect(() => {
    if (handoff?.stage === 'selecting_model') replaceInput('/model ');
    if (handoff?.sendOnOpen) void sendAndFinish(handoff);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Legacy completeHandoffWithEffort sends while the effort menu is still up, so the turn is painted under it
  // and the menu closes on a later frame. `shown` resolves once the sent turn is in the transcript.
  const { waitUntilRenderFlush } = useApp();
  const shown = useRef<{ readonly count: number; readonly done: () => void } | null>(null);
  useEffect(() => {
    if (shown.current && state.messages.length > shown.current.count) shown.current.done();
  });
  const sendUnderMenu = async (current: HandoffState) => {
    const count = state.messages.length;
    const painted = new Promise<void>((done) => {
      shown.current = { count, done };
      setTimeout(done, 1_000); // a refused send adds no turn; close the menu anyway
    });
    await sendAndFinish(current);
    await painted;
    shown.current = null;
    await waitUntilRenderFlush();
  };

  // The model menu closing without a choice sends the captured handoff (legacy's controller subscription).
  const selected = useRef(false);
  const wasOpen = useRef(menuOpen);
  useEffect(() => {
    const closed = wasOpen.current && !menuOpen;
    wasOpen.current = menuOpen;
    if (!closed || handoff?.stage !== 'selecting_model') return;
    if (selected.current) selected.current = false;
    else void sendAndFinish(handoff);
  });

  return {
    stage: handoff?.stage ?? null,
    promptLabel: handoff?.stage === 'entering_message' ? HANDOFF_PROMPT_LABEL : undefined,
    /** Bare or with arguments, legacy's /handoff takes the latest reply and asks for a message. */
    start(): void {
      const captured = state.messages
        .filter((message) => message.role === 'assistant' && message.text.length > 0)
        .at(-1)?.text;
      if (!captured) return notice('No assistant response available to hand off.');
      dispatch({ type: 'handoff/started', capturedText: captured });
    },
    /** The composer's Enter while the handoff message is asked for; true when it took the text. */
    submit(text: string): boolean {
      // The model menu runs its choice as a command; mark it before the menu's close is seen.
      if (handoff?.stage === 'selecting_model' && text.startsWith('/model ')) selected.current = true;
      if (handoff?.stage !== 'entering_message') return false;
      dispatch({ type: 'handoff/message_captured', handoffMessage: text.trim() || 'Implement this' });
      replaceInput('');
      return true;
    },
    /** Escape while the message is asked for (legacy use-app-keyboard-shortcuts). */
    escape(): boolean {
      if (handoff?.stage !== 'entering_message') return false;
      cancel();
      return true;
    },
    /** The menus' commands: the model and effort the handoff walks through. */
    async command(text: string, run: () => Promise<CommandResult>): Promise<CommandResult> {
      if (handoff?.stage === 'selecting_model' && text.startsWith('/model ')) {
        selected.current = true;
        const result = await run();
        holder?.set(handoffFlowReducer(handoff, { type: 'handoff/model_selected' }));
        setTimeout(() => replaceInput('/effort '), 0);
        // Legacy's selectModel sets the model without a line.
        return { ...result, message: undefined };
      }
      if (handoff?.stage === 'selecting_effort' && text.startsWith('/effort ')) {
        const result = await run();
        await sendUnderMenu(handoff);
        return { ...result, message: undefined };
      }
      return run();
    },
    prompt:
      handoff?.stage === 'confirm_model' ? (
        <HandoffConfirmationPrompt
          onConfirm={() => void clear(handoffFlowReducer(handoff, { type: 'handoff/model_confirmed' })!)}
          onDecline={() => void clear({ ...handoff, sendOnOpen: true })}
          onCancel={() => cancel()}
        />
      ) : null,
  };

  function cancel() {
    dispatch({ type: 'handoff/cancelled' });
    notice('Handoff cancelled');
    replaceInput('');
  }
}
