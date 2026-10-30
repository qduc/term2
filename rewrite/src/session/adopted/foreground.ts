/** Bounded foreground composition. Interaction and scheduling commands are not installed here. */
import crypto from 'node:crypto';
import { toTerminalEvent } from '../../../../source/services/conversation/conversation-result-builder.js';
import type { ConversationEvent } from '../../../../source/services/conversation/conversation-events.js';
import type { LogEvent } from '../../../../source/services/logging/conversation-log-events.js';
import type { SessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import { parseToolCallArguments } from '../../../../source/services/tool-call-arguments.js';
import { injectSkillIntoTurn } from '../../../../source/types/user-turn.js';
import type { UserTurn } from '../../../../source/types/user-turn.js';
import type { AdoptedEngine, AdoptedTurnRun } from '../../engine/adopted/index.js';
import { FatalPersistenceError, isFatalPersistenceError } from '../../engine/adopted/index.js';
import type { TurnInput } from '../../engine/index.js';
import type { SessionDriver } from '../local-store.js';
import type { Admission, SessionFact, SessionUpdate } from '../index.js';
import {
  captureAdoptedInput,
  type AdoptedAdmissionContext,
  type AdoptedSubmissionInput,
  type AdoptedSubmissionOptions,
} from './submission.js';

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
    requestId: string;
    turnId: string;
    generation: number;
    event: ConversationEvent;
    droppedInput?: UserTurn;
  }) => void;
  makeInput: (turnId: TurnInput['turnId']) => TurnInput;
  /** Combined store handles publish canonical facts themselves. */
  publishFacts?: boolean;
}) {
  const { context, engine, runtime } = options;
  runtime.state.importState(options.restored);
  const listeners = new Set<(update: SessionUpdate) => void>();
  const pending = new Map<string, { hash: string; result: Promise<Admission> }>();
  let serial = Promise.resolve();
  let completion: Promise<void> = Promise.resolve();
  let active: AdoptedTurnRun | undefined;
  let cancellation = new AbortController();
  let poisoned: unknown;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;
  const buffered: LogEvent[] = [];
  const capture = (event: LogEvent) => {
    if (poisoned !== undefined) return;
    try {
      buffered.push(structuredClone(event));
    } catch (error) {
      poisoned = error;
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
      if (poisoned !== undefined) throw new FatalPersistenceError(poisoned);
      const count = buffered.length;
      try {
        const entries = await context.commit([...buffered.slice(0, count), ...facts]);
        buffered.splice(0, count);
        if (options.publishFacts !== false) for (const entry of entries) publish({ kind: 'fact', entry });
        return facts.length ? entries.slice(-facts.length) : [];
      } catch (error) {
        poisoned = error;
        throw new FatalPersistenceError(error);
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
      cancellation.abort();
      cancellation = new AbortController();
      runtime.generationGuard.invalidate();
      active?.cancel();
      await completion;
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
    if (poisoned !== undefined) throw poisoned;
    await completion;
    if (active) await active.waitForSettlement(signal);
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
    const sourceEvents: ConversationEvent[] = [];
    const emitSource = (update: { event: ConversationEvent; droppedInput?: UserTurn }) => {
      if (!isCurrent() || update.event.type === 'approval_required') return;
      try {
        const result: unknown = options.onSourceEvent?.({
          requestId: receipt.requestId,
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
    const bound = runtime.turnAdapter.beginAdoptedTurn(
      injectSkillIntoTurn(receipt.input),
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
      },
    );
    let accepted = false;
    let acceptedRef: { logId: string; eventId: string } | undefined;
    let unregister: () => void = () => {};
    let run: AdoptedTurnRun;
    try {
      unregister = engine.registerTurnBridge(receipt.turnId, { generation: token, isCurrent }, () => ({
        ...bound.session,
        async prepare(s) {
          const ready = await bound.session.prepare(s);
          if (!ready || accepted) return ready;
          if (!isCurrent()) throw new Error('Turn became stale before acceptance');
          const entries = await commit([
            {
              type: 'user_input_accepted',
              version: 1,
              turnId: receipt.turnId,
              userMessageRef: receipt.userMessageRef,
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
      }));
      run = engine.start(options.makeInput(receipt.turnId));
    } catch (error) {
      unregister();
      bound.finish();
      await commit([
        { type: 'session_turn_ended', version: 1, turnId: receipt.turnId, outcome: 'failed' },
        {
          type: 'session_admission_settled',
          version: 1,
          clientRequestId: receipt.requestId,
          turnId: receipt.turnId,
          result: 'failed',
        },
      ]);
      throw error;
    }
    active = run;
    completion = (async () => {
      let terminal: Extract<SessionUpdate, { kind: 'live' }>['event'] | undefined;
      try {
        for await (const event of run.events) {
          if (event.type === 'turn_ended') terminal = event;
          else if (isCurrent()) publish({ kind: 'live', turnId: receipt.turnId, event });
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
        if (dropped) {
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
        facts.push({
          type: 'session_admission_settled',
          version: 1,
          clientRequestId: receipt.requestId,
          turnId: receipt.turnId,
          result,
        });
        await commit(facts);
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
        unregister();
        if (active === run) active = undefined;
      }
    })();
    // Observe failure immediately; later submissions still await the original promise.
    void completion.catch(() => {});
    return { kind: 'started', turnId: receipt.turnId };
  };
  return {
    driver,
    submission: {
      submit(value: AdoptedSubmissionInput, submitOptions?: AdoptedSubmissionOptions): Promise<Admission> {
        if (closing) return Promise.resolve({ kind: 'rejected', reason: 'closed' });
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
        const signal = cancellation.signal;
        const inputSurgeApproval = submitOptions?.inputSurgeApproval;
        const result = serial.then(() => execute(submitted, signal, inputSurgeApproval));
        serial = result.then(
          () => undefined,
          () => undefined,
        );
        pending.set(value.requestId, { hash: captured.hash, result });
        void result.finally(() => pending.delete(value.requestId)).catch(() => {});
        return result;
      },
    },
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        closing = true;
        cancellation.abort();
        runtime.generationGuard.invalidate();
        active?.cancel();
        await serial;
        await completion;
        await writeTail;
      })();
      return shutdownPromise;
    },
  };
}
