/**
 * Drives one session's foreground turns: admission, launch, the turn's
 * completion facts, and the submit and decide commands. Each turn's pending
 * interaction lives in turn-interaction.ts; the other commands have their own
 * files.
 */
import crypto from 'node:crypto';
import { toTerminalEvent } from '../../../../source/services/conversation/conversation-result-builder.js';
import type { ConversationEvent } from '../../../../source/services/conversation/conversation-events.js';
import type { LogEvent } from '../../../../source/services/logging/conversation-log-events.js';
import type { SessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import { parseToolCallArguments } from '../../../../source/services/tool-call-arguments.js';
import { injectSkillIntoTurn } from '../../../../source/types/user-turn.js';
import type { UserTurn } from '../../../../source/types/user-turn.js';
import type { AdoptedEngine, AdoptedTurnControl, AdoptedTurnRun } from '../../engine/adopted/index.js';
import { FatalPersistenceError, isFatalPersistenceError } from '../../engine/adopted/index.js';
import type { TurnInput } from '../../engine/index.js';
import type { SessionDriver } from '../local-store.js';
import type { Admission, SessionFact, SessionUpdate } from '../index.js';
import { createHistoryCommands } from './history-command.js';
import { createInterruptCommand } from './interrupt-command.js';
import { createRetryCommand } from './retry-command.js';
import { createSettingsCommand, type AdoptedRuntimeSettings } from './settings-command.js';
import {
  captureAdoptedInput,
  type AdoptedAdmissionContext,
  type AdoptedAdmissionReceipt,
  type AdoptedCommandDeps,
  type AdoptedSubmissionInput,
  type AdoptedSubmissionOptions,
  type AdoptedInteractionCommand,
} from './submission.js';
import { createTurnControl } from './turn-control.js';
import { createTurnInteraction } from './turn-interaction.js';

/**
 * Installs the source collaborators on the exact engine which owns their client.
 * This first foreground capability rejects tools and interactive commands until
 * their durable interaction owner is installed. It must not be selected as a
 * general-purpose client driver.
 */
export function createAdoptedForeground(options: {
  context: AdoptedAdmissionContext;
  engine: AdoptedEngine;
  runtime: SessionRuntimeInternals;
  /** Canonical source replay for this handle, including native history and tool ledger. */
  restored: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: Parameters<SessionRuntimeInternals['state']['importState']>[0]['toolLedger'];
  };
  onSourceEvent?: (update: {
    requestId?: string;
    turnId: string;
    generation: number;
    event: ConversationEvent;
    droppedInput?: UserTurn;
  }) => void;
  makeInput: (turnId: TurnInput['turnId']) => TurnInput;
  /** Request cancellation of this handle's source-owned background work. */
  cancelBackground?: () => void;
  runtimeSettings?: AdoptedRuntimeSettings;
  /** Human grant on the exact client owning this foreground. */
  grantHumanRunBudgetExtension?: () => { granted: boolean; extensionsGranted: number };
  /** Combined store handles publish canonical facts themselves. */
  publishFacts?: boolean;
}) {
  const { context, engine, runtime } = options;
  runtime.state.importState(options.restored);
  const listeners = new Set<(update: SessionUpdate) => void>();
  const pending = new Map<string, { hash: string; result: Promise<Admission> }>();
  const turn = createTurnControl({ engine, runtime });
  let shutdownPromise: Promise<void> | undefined;
  let decideCurrent: ((command: AdoptedInteractionCommand) => Promise<void>) | undefined;
  const buffered: LogEvent[] = [];
  const poison = (error: unknown): unknown => {
    turn.poisoned = error ?? new Error('Session mutation failed');
    context.poison(turn.poisoned);
    return turn.poisoned;
  };
  const capture = (event: LogEvent) => {
    if (turn.poisoned !== undefined) return;
    try {
      buffered.push(structuredClone(event));
    } catch (error) {
      poison(error);
    }
  };
  runtime.record.setJournalSink(capture);
  runtime.conversationLogger.setLogSink(capture);
  const publish = (update: SessionUpdate) => {
    for (const listener of listeners) {
      try {
        const result: unknown = listener(update);
        if (
          result != null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        )
          void Promise.resolve(result).catch(() => {});
      } catch {
        /* A subscriber cannot undo a durable append. */
      }
    }
  };
  let writeTail = Promise.resolve();
  const commit = (facts: readonly SessionFact[]) => {
    const operation = writeTail.then(async () => {
      if (turn.poisoned !== undefined) throw new FatalPersistenceError(turn.poisoned);
      const count = buffered.length;
      try {
        const entries = await context.commit([...buffered.slice(0, count), ...facts]);
        context.assertHealthy();
        buffered.splice(0, count);
        if (options.publishFacts !== false) for (const entry of entries) publish({ kind: 'fact', entry });
        return facts.length ? entries.slice(-facts.length) : [];
      } catch (error) {
        throw new FatalPersistenceError(poison(error));
      }
    });
    writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('Foreground capability does not support this command');
  };
  const driver: SessionDriver = {
    submit: unsupported,
    decide: unsupported,
    retry: unsupported,
    compact: unsupported,
    setModel: unsupported,
    async cancel() {
      turn.stop();
      await turn.serial;
      await turn.completion;
    },
    subscribe(_fromSeq, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const execute = async (
    submitted: AdoptedSubmissionInput,
    signal: AbortSignal,
    inputSurgeApproval?: AdoptedSubmissionOptions['inputSurgeApproval'],
  ): Promise<Admission> => {
    if (turn.poisoned !== undefined) throw turn.poisoned;
    await turn.completion;
    if (turn.active) await turn.active.waitForSettlement(signal);
    await engine.waitForAdmission(signal);
    signal.throwIfAborted();
    const admitted = await context.admit(submitted, {
      id: crypto.randomUUID(),
      sender: 'user',
      text: submitted.input.text,
      ...(submitted.input.skill ? { skill: submitted.input.skill } : {}),
      submittedTurn: submitted.input,
    });
    if (admitted.kind !== 'admitted') return admitted;
    const receipt = admitted.receipt;
    const token = runtime.generationGuard.capture();
    const isCurrent = () => !signal.aborted && runtime.generationGuard.isCurrent(token);
    const settleBeforeActivation = async () => {
      await commit([
        {
          type: 'session_admission_settled',
          version: 1,
          clientRequestId: receipt.requestId,
          turnId: receipt.turnId,
          result: 'aborted',
        },
      ]);
    };
    if (!isCurrent()) {
      await settleBeforeActivation();
      throw new Error('Admission cancelled');
    }
    try {
      await context.activate(receipt);
    } catch (error) {
      throw error;
    }
    if (!isCurrent()) {
      await commit([
        { type: 'session_turn_ended', version: 1, turnId: receipt.turnId, outcome: 'cancelled' },
        {
          type: 'session_admission_settled',
          version: 1,
          clientRequestId: receipt.requestId,
          turnId: receipt.turnId,
          result: 'aborted',
        },
      ]);
      throw new Error('Activation cancelled');
    }
    return launch(receipt, token, signal, false, inputSurgeApproval);
  };
  const launch = async (
    receipt: Omit<AdoptedAdmissionReceipt, 'requestId' | 'userMessageRef'> & {
      requestId?: AdoptedAdmissionReceipt['requestId'];
      userMessageRef?: AdoptedAdmissionReceipt['userMessageRef'];
    },
    token: number,
    signal: AbortSignal,
    retryOrigin: boolean,
    inputSurgeApproval?: AdoptedSubmissionOptions['inputSurgeApproval'],
  ): Promise<Admission> => {
    const isCurrent = () => !signal.aborted && runtime.generationGuard.isCurrent(token);
    const sourceEvents: ConversationEvent[] = [];
    let control: AdoptedTurnControl;
    const emitSource = (update: { event: ConversationEvent; droppedInput?: UserTurn }) => {
      if (!isCurrent() || update.event.type === 'approval_required') return;
      try {
        const result: unknown = options.onSourceEvent?.({
          ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
          turnId: receipt.turnId,
          generation: token,
          ...update,
        });
        if (
          result != null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        )
          void Promise.resolve(result).catch(() => {});
      } catch {
        /* Observer failures do not alter the turn. */
      }
    };
    const interactions = createTurnInteraction({
      runtime,
      engine,
      turn,
      commit,
      grantHumanRunBudgetExtension: () => options.grantHumanRunBudgetExtension?.(),
      turnId: receipt.turnId,
      token,
      signal,
      isCurrent,
      control: () => control,
      bound: () => bound,
    });
    const domain = runtime.createTurnDomain();
    const postExecuteRunId = `${context.id}:adopted:${receipt.turnId}:${token}`;
    const bound = domain.beginAdoptedTurn(
      retryOrigin ? receipt.input : injectSkillIntoTurn(receipt.input),
      (event) => {
        sourceEvents.push(event);
        if (
          isCurrent() &&
          event.type !== 'error' &&
          event.type !== 'final' &&
          event.type !== 'approval_required' &&
          event.type !== 'tool_started'
        ) {
          runtime.conversationLogger.dispatchEventToLog(event);
          emitSource({ event });
        }
      },
      {
        token,
        signal,
        ...(inputSurgeApproval ? { inputSurgeApproval } : {}),
        ...(retryOrigin ? { skipUserMessage: true, replayFromHistory: true } : {}),
      },
      async (terminal, address) => {
        const answer = await interactions.requestDecision(terminal, address);
        if (!isCurrent()) throw new Error('Adopted turn is stale');
        return {
          init: runtime.approvalFlow.buildApprovalDecision(
            answer.answer,
            answer.rejectionReason,
            answer.stopAfterApprovalResolution,
          ),
        };
      },
      postExecuteRunId,
    );
    let accepted = false;
    let acceptedRef: { logId: string; eventId: string } | undefined;
    let unregister: () => void = () => {};
    let run: AdoptedTurnRun;
    const watcherStop = new AbortController();
    let watcher: Promise<void> = Promise.resolve();
    decideCurrent = interactions.decide;
    try {
      unregister = engine.registerTurnBridge(receipt.turnId, { generation: token, isCurrent }, (boundControl) => {
        control = boundControl;
        turn.activePostExecuteRunId = bound.postExecuteRunId;
        watcher = interactions.watchPostExecute(watcherStop.signal);
        void watcher.catch(() => turn.cancelRun());
        return {
          ...bound.session,
          async prepare(s) {
            const ready = await bound.session.prepare(s);
            if (!ready || accepted || retryOrigin) return ready;
            if (!isCurrent()) throw new Error('Turn became stale before acceptance');
            const entries = await commit([
              {
                type: 'user_input_accepted',
                version: 1,
                turnId: receipt.turnId,
                userMessageRef: receipt.userMessageRef!,
                snapshot: runtime.state.getCurrentSnapshot(),
              },
            ]);
            acceptedRef = entries[0]!.ref;
            accepted = true;
            if (!isCurrent()) throw new Error('Turn became stale after acceptance');
            return ready;
          },
          async beforeToolDispatch(callId) {
            const call = runtime.record
              .exportToolEvidence()
              .reverse()
              .find((entry) => entry.callId === callId && !entry.dispatchedAt);
            if (!call || !isCurrent())
              throw new FatalPersistenceError(new Error('Missing current tool dispatch evidence'));
            const event: ConversationEvent = {
              type: 'tool_started',
              toolCallId: callId,
              toolName: call.toolName,
              arguments: parseToolCallArguments(call.arguments, {
                callId,
                toolName: call.toolName,
                sessionId: context.id,
                traceId: runtime.logger.getCorrelationId() ?? 'trace-unknown',
              }).arguments,
            };
            runtime.conversationLogger.dispatchEventToLog(event);
            await commit([]);
            if (!isCurrent()) throw new FatalPersistenceError(new Error('Tool dispatch became stale'));
            emitSource({ event });
          },
          isFatalError: isFatalPersistenceError,
          getAcceptedHistory: () => runtime.record.getHistory(),
        };
      });
      run = engine.start(options.makeInput(receipt.turnId));
    } catch (error) {
      watcherStop.abort();
      runtime.postExecutePending.closeRun(bound.postExecuteRunId);
      await watcher.catch(() => {});
      if (turn.activePostExecuteRunId === bound.postExecuteRunId) turn.activePostExecuteRunId = undefined;
      unregister();
      bound.finish();
      await commit([
        { type: 'session_turn_ended', version: 1, turnId: receipt.turnId, outcome: 'failed' },
        ...(receipt.requestId
          ? [
              {
                type: 'session_admission_settled',
                version: 1 as const,
                clientRequestId: receipt.requestId,
                turnId: receipt.turnId,
                result: 'failed' as const,
              } as const,
            ]
          : []),
      ]);
      throw error;
    }
    turn.active = run;
    turn.completion = (async () => {
      let terminal: Extract<SessionUpdate, { kind: 'live' }>['event'] | undefined;
      try {
        let view = run;
        while (true) {
          for await (const event of view.events) {
            if (event.type === 'checkpoint') interactions.offerCheckpoint(event.checkpoint);
            if (event.type === 'turn_ended') terminal = event;
            else if (event.type !== 'checkpoint' && isCurrent())
              publish({ kind: 'live', turnId: receipt.turnId, event });
          }
          if (terminal?.type !== 'turn_ended' || terminal.outcome.kind !== 'suspended') break;
          terminal = undefined;
          const next = await Promise.race([interactions.takeView(), run.waitForSettlement().then(() => undefined)]);
          if (!next) {
            terminal = { type: 'turn_ended', outcome: { kind: 'cancelled' } };
            break;
          }
          view = next;
        }
        await run.waitForSettlement();
        const outcome = bound.finish();
        if (outcome.kind === 'response') sourceEvents.push(toTerminalEvent(outcome.terminal));
        if (outcome.kind === 'failed' && !sourceEvents.some((event) => event.type === 'error')) {
          sourceEvents.push({
            type: 'error',
            message: 'Conversation turn failed before producing an authoritative terminal event.',
          });
        }
        if (isCurrent())
          for (const event of sourceEvents)
            if (event.type === 'error' || event.type === 'final') runtime.conversationLogger.dispatchEventToLog(event);
        const dropped = sourceEvents.some((event) => event.type === 'error' && !!event.droppedUserMessage);
        const kind = terminal?.type === 'turn_ended' ? terminal.outcome.kind : 'failed';
        const result =
          kind === 'completed' && outcome.kind === 'response'
            ? 'accepted'
            : kind === 'cancelled'
            ? 'aborted'
            : 'failed';
        const facts: SessionFact[] = [];
        const pendingInteraction = context.state().pendingInteraction;
        if (pendingInteraction?.turnId === receipt.turnId) {
          facts.push({
            type: 'session_interaction_resolved',
            version: 1,
            turnId: receipt.turnId,
            interactionId: pendingInteraction.interaction.interactionId,
            revision: pendingInteraction.interaction.revision,
            generation: pendingInteraction.generation,
            outcome: 'cancelled',
          });
        }
        if (dropped) {
          if (!receipt.userMessageRef)
            throw new FatalPersistenceError(new Error('Dropped input has no canonical user reference'));
          facts.push({
            type: 'events_retracted',
            version: 1,
            refs: [receipt.userMessageRef, ...(acceptedRef ? [acceptedRef] : [])],
          });
          facts.push({ type: 'undo', removedUserTurns: 1, snapshot: runtime.state.getCurrentSnapshot() });
        }
        facts.push({
          type: 'session_turn_ended',
          version: 1,
          turnId: receipt.turnId,
          outcome: result === 'accepted' ? 'completed' : result === 'aborted' ? 'cancelled' : 'failed',
        });
        if (receipt.requestId)
          facts.push({
            type: 'session_admission_settled',
            version: 1,
            clientRequestId: receipt.requestId,
            turnId: receipt.turnId,
            result,
          });
        await commit(facts);
        if (result === 'accepted' && !retryOrigin && !interactions.askedForDecision && isCurrent()) {
          for await (const event of runtime.automaticMemoryFinalizer.record(receipt.input)) {
            if (!isCurrent()) break;
            runtime.conversationLogger.dispatchEventToLog(event);
            await commit([]);
            if (isCurrent()) emitSource({ event });
          }
        }
        if (isCurrent()) {
          for (const event of sourceEvents) {
            if (event.type === 'error' || event.type === 'final' || event.type === 'approval_required') {
              emitSource({
                event,
                ...(event.type === 'error' && event.droppedUserMessage
                  ? { droppedInput: structuredClone(receipt.input) }
                  : {}),
              });
            }
          }
        }
        if (terminal && isCurrent()) publish({ kind: 'live', turnId: receipt.turnId, event: terminal });
      } finally {
        watcherStop.abort();
        runtime.postExecutePending.closeRun(bound.postExecuteRunId);
        await watcher.catch(() => {});
        if (turn.activePostExecuteRunId === bound.postExecuteRunId) turn.activePostExecuteRunId = undefined;
        decideCurrent = undefined;
        unregister();
        if (turn.active === run) turn.active = undefined;
      }
    })();
    // Observe failure immediately; later submissions still await the original promise.
    void turn.completion.catch(() => {});
    return { kind: 'started', turnId: receipt.turnId };
  };
  const commandDeps: AdoptedCommandDeps = { context, runtime, turn, commit, poison };
  const history = createHistoryCommands(commandDeps);
  const interrupt = createInterruptCommand(commandDeps, {
    foreground: () => driver.cancel(),
    background: options.cancelBackground?.bind(options),
  });
  const settings = createSettingsCommand(commandDeps, options.runtimeSettings);
  const retry = createRetryCommand(commandDeps, launch);
  return {
    driver,
    /** The ordered canonical writer; it flushes buffered source facts before the given ones. */
    commit,
    submission: {
      ...history,
      ...interrupt,
      ...settings,
      ...retry,
      decide(command: AdoptedInteractionCommand): Promise<void> {
        try {
          context.assertHealthy();
        } catch (error) {
          return Promise.reject(error);
        }
        if (turn.poisoned !== undefined) return Promise.reject(turn.poisoned);
        if (turn.interrupting) return Promise.reject(new Error('User interrupt is in progress'));
        const owned = structuredClone(command);
        const operation = turn.decisionTail
          .then(() => {
            context.assertHealthy();
            if (turn.closing || !decideCurrent) throw new Error('No current interaction');
            return decideCurrent(owned);
          })
          .catch(async (error) => {
            if (isFatalPersistenceError(error)) {
              turn.cancelRun();
              try {
                await turn.completion;
              } catch {
                /* Preserve the persistence error. */
              }
            }
            throw error;
          });
        turn.decisionTail = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
      submit(value: AdoptedSubmissionInput, submitOptions?: AdoptedSubmissionOptions): Promise<Admission> {
        try {
          context.assertHealthy();
        } catch (error) {
          return Promise.reject(error);
        }
        if (turn.poisoned !== undefined) return Promise.reject(turn.poisoned);
        if (turn.closing) return Promise.resolve({ kind: 'rejected', reason: 'closed' });
        if (turn.interrupting || turn.settingMutation)
          return Promise.reject(new Error('Session mutation is in progress'));
        const captured = captureAdoptedInput(value.input);
        if (context.state().status === 'closed') return Promise.resolve({ kind: 'rejected', reason: 'closed' });
        const existing = pending.get(value.requestId);
        if (existing) {
          if (existing.hash !== captured.hash) return Promise.resolve({ kind: 'rejected', reason: 'request_conflict' });
          return existing.result.then((result) =>
            result.kind === 'started' ? { kind: 'duplicate', turnId: result.turnId } : result,
          );
        }
        const prior = context.state().admissions[value.requestId];
        if (prior && Date.parse(prior.expiresAt) > Date.now()) {
          return Promise.resolve(
            prior.normalizedBodyHash === captured.hash
              ? { kind: 'duplicate', turnId: prior.turnId }
              : { kind: 'rejected', reason: 'request_conflict' },
          );
        }
        const submitted = { requestId: value.requestId, input: captured.input };
        const signal = turn.cancellation.signal;
        const inputSurgeApproval = submitOptions?.inputSurgeApproval;
        const result = turn.queue(() => execute(submitted, signal, inputSurgeApproval));
        pending.set(value.requestId, { hash: captured.hash, result });
        void result.finally(() => pending.delete(value.requestId)).catch(() => {});
        return result;
      },
    },
    failPersistence(error: unknown): void {
      poison(error);
      turn.cancellation.abort();
      turn.cancelRun();
    },
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        turn.closing = true;
        turn.cancellation.abort();
        turn.cancelRun();
        await turn.decisionTail;
        await turn.serial;
        await turn.completion;
        await writeTail;
        if (turn.interrupting) await turn.interrupting;
      })();
      return shutdownPromise;
    },
  };
}
