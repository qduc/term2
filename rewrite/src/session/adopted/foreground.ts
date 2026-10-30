/** Bounded foreground composition. Interaction and scheduling commands are not installed here. */
import crypto from 'node:crypto';
import { toTerminalEvent } from '../../../../source/services/conversation/conversation-result-builder.js';
import type { ConversationEvent } from '../../../../source/services/conversation/conversation-events.js';
import type { LogEvent } from '../../../../source/services/logging/conversation-log-events.js';
import type { SessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import { parseToolCallArguments } from '../../../../source/services/tool-call-arguments.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from '../../../../source/services/interruption-info.js';
import { isRunBudgetInteraction } from '../../../../source/services/agent-runtime/run-budget.js';
import { injectSkillIntoTurn } from '../../../../source/types/user-turn.js';
import { decideInteraction, projectPendingInteraction } from '../../../../source/gateway/interaction-protocol.js';
import type { PendingInteractionDto } from '../../../../source/gateway/interaction-protocol.js';
import type { UserTurn } from '../../../../source/types/user-turn.js';
import type { AdoptedEngine, AdoptedTurnControl, AdoptedTurnRun } from '../../engine/adopted/index.js';
import { FatalPersistenceError, isFatalPersistenceError } from '../../engine/adopted/index.js';
import type { ApprovalDecision, TurnCheckpoint, TurnInput } from '../../engine/index.js';
import type { ToolCallId } from '../../model/index.js';
import type { SessionDriver } from '../local-store.js';
import type { Admission, SessionFact, SessionUpdate } from '../index.js';
import {
  captureAdoptedInput,
  type AdoptedAdmissionContext,
  type AdoptedSubmissionInput,
  type AdoptedSubmissionOptions,
  type AdoptedInteractionCommand,
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
  let activePostExecuteRunId: string | undefined;
  let cancellation = new AbortController();
  let poisoned: unknown;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;
  let decisionTail = Promise.resolve();
  let decideCurrent: ((command: AdoptedInteractionCommand) => Promise<void>) | undefined;
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
      if (activePostExecuteRunId) runtime.postExecutePending.closeRun(activePostExecuteRunId);
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
    let control: AdoptedTurnControl;
    let nextView: ((run: AdoptedTurnRun) => void) | undefined;
    let queuedView: AdoptedTurnRun | undefined;
    const takeView = () =>
      queuedView
        ? Promise.resolve(
            (() => {
              const value = queuedView!;
              queuedView = undefined;
              return value;
            })(),
          )
        : new Promise<AdoptedTurnRun>((resolve) => {
            nextView = resolve;
          });
    const deliverView = (view: AdoptedTurnRun) => {
      if (nextView) {
        const resolve = nextView;
        nextView = undefined;
        resolve(view);
      } else queuedView = view;
    };
    let interaction:
      | {
          dto: PendingInteractionDto;
          checkpoint?: TurnCheckpoint;
          checkpointReady: Promise<TurnCheckpoint>;
          setCheckpoint: (value: TurnCheckpoint) => void;
          ready: Promise<void>;
          controlAnswer?: string;
          validateSource?: () => void;
          postExecute?: boolean;
        }
      | undefined;
    let signalInteraction!: () => void;
    let interactionChanged = new Promise<void>((resolve) => {
      signalInteraction = resolve;
    });
    const notifyInteraction = () => {
      signalInteraction();
      interactionChanged = new Promise<void>((resolve) => {
        signalInteraction = resolve;
      });
    };
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
    const requestDecision = async (
      terminal: import('../../../../source/contracts/conversation.js').ConversationTerminal,
      address: unknown,
    ) => {
      if (terminal.type !== 'approval_required' || !isCurrent()) throw new Error('Interaction is stale');
      const staged = runtime.pendingInteraction.prepareTransition((draft) => draft.present(terminal.approval));
      const snapshot = staged.snapshot!;
      const dto = projectPendingInteraction(
        snapshot.approval,
        String(snapshot.interactionId),
        snapshot.revision!,
        snapshot.askUserAnswers,
        snapshot.currentAskUserQuestionIndex,
      );
      if (dto.variant === 'sandbox_network_access') throw new Error('Network interaction owner is not installed');
      let setCheckpoint!: (value: TurnCheckpoint) => void;
      const checkpointReady = new Promise<TurnCheckpoint>((resolve) => {
        setCheckpoint = resolve;
      });
      let setReady!: () => void;
      let failReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        setReady = resolve;
        failReady = reject;
      });
      void ready.catch(() => {});
      const owner: NonNullable<typeof interaction> = { dto, checkpointReady, setCheckpoint, ready };
      interaction = owner;
      notifyInteraction();
      const callId = dto.descriptor.callId as ToolCallId | undefined;
      if (dto.kind !== 'check_in' && !callId) throw new Error('Tool interaction lacks a call ID');
      const postExecute = terminal.approval.postExecute;
      owner.postExecute = !!postExecute;
      const pending = postExecute ? undefined : runtime.approvalFlow.getPending();
      if (!postExecute && (!pending || pending.interruption !== address))
        throw new Error('Missing pending source authority');
      const occurrences = pending ? pending.interruptions ?? [pending.interruption] : [];
      const snapshotCalls = () =>
        occurrences.flatMap((item) => {
          if (isRunBudgetInteraction(item)) return [];
          const id = getCallIdFromObject(item);
          if (!id) return [];
          const info = getToolInfoFromInterruption(item);
          return [{ callId: id as ToolCallId, toolName: info.toolName, input: info.rawArguments }];
        });
      const postEvidence =
        postExecute && callId
          ? runtime.record
              .exportToolEvidence()
              .reverse()
              .find(
                (item) =>
                  item.callId === callId &&
                  item.toolName === dto.descriptor.toolName &&
                  !!item.dispatchedAt &&
                  !item.completedAt,
              )
          : undefined;
      const pendingCalls = postEvidence
        ? [{ callId: callId!, toolName: postEvidence.toolName, input: postEvidence.arguments }]
        : snapshotCalls();
      const pendingIdentity = [...occurrences];
      const serializedPending = JSON.stringify(pendingCalls);
      const validateSource = () => {
        if (postExecute) {
          const current = runtime.postExecutePending.snapshot();
          if (
            current.closed ||
            current.sessionId !== postExecute.sessionId ||
            current.epoch !== postExecute.epoch ||
            current.revision !== postExecute.revision ||
            !postExecute.ids.length ||
            new Set(postExecute.ids).size !== postExecute.ids.length ||
            postExecute.ids.some(
              (id) =>
                !current.entries.some(
                  (entry) =>
                    entry.id === id &&
                    entry.runId === bound.postExecuteRunId &&
                    entry.toolCallId === callId &&
                    entry.toolName === dto.descriptor.toolName,
                ),
            )
          )
            throw new Error('Post-execute authority changed');
          return;
        }
        const current = runtime.approvalFlow.getPending();
        const currentOccurrences = current?.interruptions ?? (current ? [current.interruption] : []);
        if (
          !current ||
          current !== pending ||
          current.interruption !== address ||
          currentOccurrences.length !== pendingIdentity.length ||
          currentOccurrences.some((item, index) => item !== pendingIdentity[index]) ||
          JSON.stringify(snapshotCalls()) !== serializedPending
        )
          throw new Error('Pending source authority changed');
      };
      const exposed = pendingCalls.find((item) => item.callId === callId);
      if (callId && !exposed) throw new Error('Missing pending source call');
      owner.validateSource = validateSource;
      const parked = control.park({
        generation: token,
        isCurrent,
        decisionAddress: address,
        approvals: exposed
          ? [
              {
                callId: callId!,
                toolName: exposed.toolName,
                requirement: { kind: 'ask', summary: dto.descriptor.toolName },
              },
            ]
          : [],
        pendingCalls,
        validatePendingSnapshot(calls) {
          validateSource();
          if (JSON.stringify(calls) !== serializedPending) throw new Error('Pending calls changed');
        },
        validate(values) {
          validateSource();
          if (values.size !== (callId ? 1 : 0) || (callId && !values.has(callId)))
            throw new Error('Invalid decision set');
        },
      });
      void parked.catch(() => {});
      await Promise.race([
        checkpointReady,
        parked.then(() => {
          throw new Error('Unexpected early decision');
        }),
      ]);
      try {
        await commit([
          {
            type: 'session_interaction_pending',
            version: 1,
            turnId: receipt.turnId,
            generation: String(token),
            interaction: dto,
          },
        ]);
        if (!isCurrent() || interaction !== owner) throw new Error('Interaction became stale');
        staged.commit();
        setReady();
      } catch (error) {
        failReady(error);
        runtime.generationGuard.invalidate();
        runtime.postExecutePending.closeRun(bound.postExecuteRunId);
        active?.cancel();
        throw error;
      }
      const decisions = await parked;
      const decision = callId ? decisions.get(callId) : undefined;
      if (decision?.kind === 'answer') control.setAskUserAnswer(callId!, decision.answer);
      const answer =
        decision?.kind === 'reject' ? 'n' : decision?.kind === 'grant' ? decision.grant : owner.controlAnswer ?? 'y';
      if (postExecute) {
        validateSource();
        const result = runtime.postExecutePending.decide({
          revision: postExecute.revision,
          ids: postExecute.ids,
          decision: (answer === 'y'
            ? 'approve'
            : answer === 'n'
            ? 'reject'
            : answer) as import('../../../../source/contracts/conversation.js').PostExecuteDecision,
        });
        if (result.kind !== 'settled') throw new Error('Post-execute decision became stale');
      }
      return {
        answer,
        ...(decision?.kind === 'reject' && decision.reason ? { rejectionReason: decision.reason } : {}),
        ...(decision?.stopAfterApprovalResolution ? { stopAfterApprovalResolution: true } : {}),
      };
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
      requestDecision,
    );
    let accepted = false;
    let acceptedRef: { logId: string; eventId: string } | undefined;
    let unregister: () => void = () => {};
    let run: AdoptedTurnRun;
    const watcherStop = new AbortController();
    const watchPostExecute = async () => {
      while (!watcherStop.signal.aborted && isCurrent()) {
        const changed = interactionChanged;
        const registry = runtime.postExecutePending.snapshot();
        const entries = registry.entries.filter((entry) => entry.runId === bound.postExecuteRunId);
        if (entries.length && !interaction) {
          const terminal = bound.postExecuteTerminal(entries);
          await requestDecision(
            terminal,
            terminal.type === 'approval_required' ? terminal.approval.rawInterruption : undefined,
          );
          continue;
        }
        const watch = runtime.postExecutePending.watchForChange(registry.revision);
        let stopped!: () => void;
        const stop = new Promise<void>((resolve) => {
          stopped = resolve;
        });
        watcherStop.signal.addEventListener('abort', stopped, { once: true });
        try {
          if (!watcherStop.signal.aborted) await Promise.race([watch.promise, changed, stop]);
        } finally {
          watcherStop.signal.removeEventListener('abort', stopped);
          watch.unsubscribe();
        }
      }
    };
    let watcher: Promise<void> = Promise.resolve();
    decideCurrent = async (command) => {
      const owner = interaction;
      if (!command || typeof command !== 'object' || !['choose', 'navigate'].includes(command.kind))
        throw new Error('Malformed interaction command');
      const keys =
        command.kind === 'choose'
          ? ['kind', 'turnId', 'interactionId', 'revision', 'generation', 'decisions']
          : ['kind', 'turnId', 'interactionId', 'revision', 'generation', 'direction'];
      if (Object.keys(command).some((key) => !keys.includes(key))) throw new Error('Malformed interaction command');
      if (
        !owner ||
        !isCurrent() ||
        command.turnId !== receipt.turnId ||
        command.generation !== String(token) ||
        command.interactionId !== owner.dto.interactionId ||
        command.revision !== owner.dto.revision
      )
        throw new Error('Interaction is stale');
      const checkpoint = await Promise.race([
        Promise.all([owner.ready, owner.checkpointReady]).then(([, value]) => value),
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new Error('Interaction cancelled'));
          else signal.addEventListener('abort', () => reject(new Error('Interaction cancelled')), { once: true });
        }),
      ]);
      if (!isCurrent() || interaction !== owner) throw new Error('Interaction is stale');
      owner.validateSource?.();
      const snapshot = runtime.pendingInteraction.getSnapshot();
      if (!snapshot) throw new Error('Interaction is absent');
      let decision: ApprovalDecision | undefined;
      let choiceId: string | undefined;
      let controlAnswer: string | undefined;
      let resolvedAnswers: readonly (string | readonly string[])[] | undefined;
      let outcome: 'answered' | 'cancelled' = 'answered';
      const staged = runtime.pendingInteraction.prepareTransition((draft) => {
        if (command.kind === 'navigate') {
          if (command.direction !== 'next' && command.direction !== 'previous') throw new Error('Malformed navigation');
          if (owner.dto.kind !== 'ask_user') throw new Error('Navigation is not available');
          if (command.direction === 'next') {
            if (snapshot.currentAskUserQuestionIndex + 1 >= owner.dto.askUser!.questions.length)
              throw new Error('Navigation is out of bounds');
            draft.goToNextQuestion();
          } else draft.goToPreviousQuestion();
          return undefined;
        }
        if (
          !Array.isArray(command.decisions) ||
          command.decisions.length !== 1 ||
          !command.decisions[0] ||
          Object.keys(command.decisions[0]).some((key) => !['callId', 'choice'].includes(key)) ||
          command.decisions[0]!.callId !== owner.dto.descriptor.callId
        )
          throw new Error('Invalid exposed decision set');
        const choice = command.decisions[0]!.choice;
        if (
          !choice ||
          typeof choice !== 'object' ||
          typeof choice.answer !== 'string' ||
          Object.keys(choice).some((key) => !['answer', 'rejectionReason', 'approvalAnswer'].includes(key)) ||
          (choice.rejectionReason !== undefined && typeof choice.rejectionReason !== 'string') ||
          (choice.approvalAnswer !== undefined && typeof choice.approvalAnswer !== 'string')
        )
          throw new Error('Malformed interaction choice');
        const translated = decideInteraction(owner.dto, choice);
        if (
          !owner.postExecute &&
          owner.dto.kind === 'tool_approval' &&
          translated.answer !== 'y' &&
          translated.answer !== 'n' &&
          !(translated.answer === 'allow-once' && owner.dto.variant !== 'denied_read')
        )
          runtime.approvalFlow.validateGrant(translated.answer, snapshot.approval);
        choiceId = choice.answer;
        outcome = translated.outcome === 'cancelled' ? 'cancelled' : 'answered';
        const result = draft.resolve({
          expectedInteractionId: snapshot.interactionId,
          expectedRevision: snapshot.revision,
          answer: translated.answer,
          rejectionReason: translated.rejectionReason,
          approvalAnswer: translated.approvalAnswer,
        });
        if (result.kind === 'resolved') {
          if (owner.dto.kind === 'ask_user' && result.approvalAnswer) {
            try {
              const parsed: unknown = JSON.parse(result.approvalAnswer);
              if (
                Array.isArray(parsed) &&
                parsed.every(
                  (answer) =>
                    typeof answer === 'string' ||
                    (Array.isArray(answer) && answer.every((value) => typeof value === 'string')),
                )
              )
                resolvedAnswers = parsed;
            } catch {
              /* Terminal answers are not multi-question arrays. */
            }
          }
          decision =
            owner.dto.kind === 'ask_user'
              ? {
                  kind: 'answer',
                  answer: result.approvalAnswer ?? '',
                  ...(outcome === 'cancelled' ? { stopAfterApprovalResolution: true } : {}),
                }
              : translated.answer === 'n'
              ? { kind: 'reject', ...(translated.rejectionReason ? { reason: translated.rejectionReason } : {}) }
              : translated.answer === 'y' || (translated.answer === 'allow-once' && owner.dto.variant !== 'denied_read')
              ? { kind: 'approve' }
              : { kind: 'grant', grant: translated.answer as Extract<ApprovalDecision, { kind: 'grant' }>['grant'] };
          controlAnswer = translated.answer;
        }
        return result;
      });
      if (staged.snapshot) {
        const next = projectPendingInteraction(
          staged.snapshot.approval,
          String(staged.snapshot.interactionId),
          staged.snapshot.revision!,
          staged.snapshot.askUserAnswers,
          staged.snapshot.currentAskUserQuestionIndex,
        );
        if (next.revision === owner.dto.revision) return;
        await commit([
          {
            type: 'session_interaction_pending',
            version: 1,
            turnId: receipt.turnId,
            generation: String(token),
            interaction: next,
          },
        ]);
        if (!isCurrent() || interaction !== owner) throw new Error('Interaction became stale');
        owner.validateSource?.();
        staged.commit();
        owner.dto = next;
        return;
      }
      if (!decision) throw new Error('Interaction did not resolve');
      await commit([
        {
          type: 'session_interaction_resolved',
          version: 1,
          turnId: receipt.turnId,
          generation: String(token),
          interactionId: owner.dto.interactionId,
          revision: owner.dto.revision,
          outcome,
          answer: {
            choiceId,
            ...(decision.kind === 'reject' && decision.reason ? { rejectionReason: decision.reason } : {}),
            ...(resolvedAnswers ? { answers: resolvedAnswers } : {}),
          },
        },
      ]);
      if (!isCurrent() || interaction !== owner) throw new Error('Interaction became stale');
      owner.validateSource?.();
      if (decision.kind === 'grant' && !owner.postExecute)
        runtime.approvalFlow.validateGrant(decision.grant, snapshot.approval);
      staged.commit();
      owner.controlAnswer = controlAnswer;
      interaction = undefined;
      notifyInteraction();
      const decisions = new Map<ToolCallId, ApprovalDecision>();
      if (owner.dto.descriptor.callId) decisions.set(owner.dto.descriptor.callId as ToolCallId, decision);
      const view = engine.resume(checkpoint, decisions);
      active = view;
      deliverView(view);
    };
    try {
      unregister = engine.registerTurnBridge(receipt.turnId, { generation: token, isCurrent }, (boundControl) => {
        control = boundControl;
        activePostExecuteRunId = bound.postExecuteRunId;
        watcher = watchPostExecute();
        void watcher.catch(() => {
          runtime.generationGuard.invalidate();
          if (activePostExecuteRunId) runtime.postExecutePending.closeRun(activePostExecuteRunId);
          active?.cancel();
        });
        return {
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
        };
      });
      run = engine.start(options.makeInput(receipt.turnId));
    } catch (error) {
      watcherStop.abort();
      runtime.postExecutePending.closeRun(bound.postExecuteRunId);
      await watcher.catch(() => {});
      if (activePostExecuteRunId === bound.postExecuteRunId) activePostExecuteRunId = undefined;
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
        let view = run;
        while (true) {
          for await (const event of view.events) {
            if (event.type === 'checkpoint' && interaction) interaction.setCheckpoint(event.checkpoint);
            if (event.type === 'turn_ended') terminal = event;
            else if (event.type !== 'checkpoint' && isCurrent())
              publish({ kind: 'live', turnId: receipt.turnId, event });
          }
          if (terminal?.type !== 'turn_ended' || terminal.outcome.kind !== 'suspended') break;
          terminal = undefined;
          const next = await Promise.race([takeView(), run.waitForSettlement().then(() => undefined)]);
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
        watcherStop.abort();
        runtime.postExecutePending.closeRun(bound.postExecuteRunId);
        await watcher.catch(() => {});
        if (activePostExecuteRunId === bound.postExecuteRunId) activePostExecuteRunId = undefined;
        decideCurrent = undefined;
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
      decide(command: AdoptedInteractionCommand): Promise<void> {
        const owned = structuredClone(command);
        const operation = decisionTail
          .then(() => {
            if (closing || !decideCurrent) throw new Error('No current interaction');
            return decideCurrent(owned);
          })
          .catch(async (error) => {
            if (isFatalPersistenceError(error)) {
              runtime.generationGuard.invalidate();
              if (activePostExecuteRunId) runtime.postExecutePending.closeRun(activePostExecuteRunId);
              active?.cancel();
              try {
                await completion;
              } catch {
                /* Preserve the persistence error. */
              }
            }
            throw error;
          });
        decisionTail = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
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
        if (activePostExecuteRunId) runtime.postExecutePending.closeRun(activePostExecuteRunId);
        active?.cancel();
        await decisionTail;
        await serial;
        await completion;
        await writeTail;
      })();
      return shutdownPromise;
    },
  };
}
