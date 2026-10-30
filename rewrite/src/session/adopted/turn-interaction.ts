/**
 * One turn's pending interaction. It parks the turn when the source asks for
 * a decision, records the interaction durably, applies the user's commands to
 * it, and resumes the engine with the answer. A new owner is made for each
 * turn launch; the foreground keeps turn start and turn completion.
 */
import { decideInteraction, projectPendingInteraction } from '../../../../source/gateway/interaction-protocol.js';
import type { PendingInteractionDto } from '../../../../source/gateway/interaction-protocol.js';
import { isRunBudgetInteraction } from '../../../../source/services/agent-runtime/run-budget.js';
import { getCallIdFromObject, getToolInfoFromInterruption } from '../../../../source/services/interruption-info.js';
import type { SessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import type { AdoptedEngine, AdoptedTurnControl, AdoptedTurnRun } from '../../engine/adopted/index.js';
import type { ApprovalDecision, TurnCheckpoint, TurnInput } from '../../engine/index.js';
import type { ToolCallId } from '../../model/index.js';
import type { AdoptedCommandDeps, AdoptedInteractionCommand } from './submission.js';
import type { TurnControl } from './turn-control.js';

export class RunBudgetExtensionRefused extends Error {
  constructor() {
    super('No further budget extension is available.');
    this.name = 'RunBudgetExtensionRefused';
  }
}

type BoundTurn = ReturnType<ReturnType<SessionRuntimeInternals['createTurnDomain']>['beginAdoptedTurn']>;

export function createTurnInteraction(deps: {
  runtime: SessionRuntimeInternals;
  engine: AdoptedEngine;
  turn: TurnControl;
  commit: AdoptedCommandDeps['commit'];
  grantHumanRunBudgetExtension: () => { granted: boolean; extensionsGranted: number } | undefined;
  turnId: TurnInput['turnId'];
  token: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
  /** Late-bound: the engine hands over the turn control when the turn bridge opens. */
  control: () => AdoptedTurnControl;
  /** Late-bound: the source turn begins after this owner exists. */
  bound: () => Pick<BoundTurn, 'postExecuteRunId' | 'postExecuteTerminal'>;
}) {
  const { runtime, engine, turn, commit, grantHumanRunBudgetExtension, turnId, token, signal, isCurrent } = deps;
  const { control, bound } = deps;
  let askedForDecision = false;
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
        runBudget: boolean;
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
  const requestDecision = async (
    terminal: import('../../../../source/contracts/conversation.js').ConversationTerminal,
    address: unknown,
  ) => {
    askedForDecision = true;
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
    const owner: NonNullable<typeof interaction> = {
      dto,
      checkpointReady,
      setCheckpoint,
      ready,
      runBudget: isRunBudgetInteraction(address),
    };
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
                  entry.runId === bound().postExecuteRunId &&
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
    const parked = control().park({
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
          turnId,
          generation: String(token),
          interaction: dto,
        },
      ]);
      if (!isCurrent() || interaction !== owner) throw new Error('Interaction became stale');
      staged.commit();
      setReady();
    } catch (error) {
      failReady(error);
      turn.cancelRun(bound().postExecuteRunId);
      throw error;
    }
    const decisions = await parked;
    const decision = callId ? decisions.get(callId) : undefined;
    if (decision?.kind === 'answer') control().setAskUserAnswer(callId!, decision.answer);
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
  const watchPostExecute = async (stopSignal: AbortSignal) => {
    while (!stopSignal.aborted && isCurrent()) {
      const changed = interactionChanged;
      const registry = runtime.postExecutePending.snapshot();
      const entries = registry.entries.filter((entry) => entry.runId === bound().postExecuteRunId);
      if (entries.length && !interaction) {
        askedForDecision = true;
        const terminal = bound().postExecuteTerminal(entries);
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
      stopSignal.addEventListener('abort', stopped, { once: true });
      try {
        if (!stopSignal.aborted) await Promise.race([watch.promise, changed, stop]);
      } finally {
        stopSignal.removeEventListener('abort', stopped);
        watch.unsubscribe();
      }
    }
  };
  const decide = async (command: AdoptedInteractionCommand) => {
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
      command.turnId !== turnId ||
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
          turnId,
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
    if (owner.runBudget && controlAnswer === 'y') {
      if (!isCurrent() || interaction !== owner) throw new Error('Interaction is stale');
      owner.validateSource?.();
      const grant = grantHumanRunBudgetExtension();
      if (!grant?.granted) throw new RunBudgetExtensionRefused();
    }
    await commit([
      {
        type: 'session_interaction_resolved',
        version: 1,
        turnId,
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
    turn.active = view;
    deliverView(view);
  };
  return {
    /** Parks the turn on a source approval and resolves with the user's answer. */
    requestDecision,
    /** Applies one user command to the pending interaction. */
    decide,
    /** Raises post-execute approvals for this turn until `stopSignal` aborts. */
    watchPostExecute,
    /** The engine view to continue with once a decision resumes the turn. */
    takeView,
    /** Gives the suspended turn's checkpoint to the pending interaction, if any. */
    offerCheckpoint(checkpoint: TurnCheckpoint): void {
      if (interaction) interaction.setCheckpoint(checkpoint);
    },
    /** True once the turn has asked for any decision; such turns skip automatic memory. */
    get askedForDecision(): boolean {
      return askedForDecision;
    },
  };
}
