/** Serializes command admission, revision checks and accepted history mutation. */
import type { TurnResult } from '../engine/index.js';
import type { CommandAdmission, CommandOwner } from './conversation-command-admission.js';
import { ConversationGeneration, type PreparedConversationGeneration } from './conversation-generation.js';
import { ConversationJournal } from './conversation-journal.js';
import { runConversationRollover } from './conversation-rollover.js';
import { listDirectRewindTargets, planDirectHistoryCommand } from './direct-command-history.js';
import { planDirectCommandFinish, planDirectCommandStart } from './direct-command-receipts.js';
import type { DirectCommandOutcome, DirectCommandResult } from './direct-command-types.js';
import type { DirectPreparedConfiguration } from './direct-configuration.js';
import { captureDirectCommandHistory } from './direct-history-capture.js';
import { directPreviewConfiguration } from './direct-preview.js';
import { directRolloverAtBoundary } from './direct-rollover.js';
import type { Conversation, ConversationDeps, StartedConversationTurn } from './direct-types.js';

export class ConversationCommands {
  owner: CommandOwner | null = null;
  constructor(
    private readonly id: string,
    private readonly journal: ConversationJournal,
    private readonly generation: ConversationGeneration,
    private readonly admission: CommandAdmission,
    private readonly rotationBoundary: ConversationDeps['rotationBoundary'],
    private readonly installGeneration: (
      candidate: DirectPreparedConfiguration,
      prepared: PreparedConversationGeneration,
    ) => void,
  ) {}
  readonly destination = (): string | undefined => {
    for (const receipt of this.journal.commandReceipts) {
      if (receipt.outcome?.kind === 'rolled_over' && receipt.outcome.sessionId !== this.id)
        return receipt.outcome.sessionId;
    }
    return undefined;
  };
  readonly revision = (): string => `${this.id}:${this.journal.historyRevision}`;
  private readonly snapshot = () =>
    captureDirectCommandHistory({
      sessionId: this.id,
      revision: this.revision(),
      facts: this.journal.facts,
      history: this.journal.liveReplay().history,
      executionsSettled: !this.admission.active && !this.admission.completionHeld,
    });
  // Live detached work is allowed. Only actual foreground/pending decisions veto.
  private readonly rolloverBlocked = (commandId: string): boolean => {
    if (this.admission.active || this.journal.queueState.active) return true;
    if (
      this.admission.completionHeld &&
      directRolloverAtBoundary(this.journal.facts, this.admission.completionHeld)?.commandId !== commandId
    )
      return true;
    if (this.journal.taskStates.some((task) => task.pendingInteractions.length > 0)) return true;
    const waiting = new Set<string>();
    for (const fact of this.journal.facts) {
      if (fact.type === 'interaction_opened') waiting.add(fact.request.requestId);
      if (fact.type === 'budget_opened') waiting.add(fact.requestId);
      if (fact.type === 'interaction_closed' || fact.type === 'budget_closed') waiting.delete(fact.requestId);
    }
    return waiting.size > 0;
  };
  readonly rewindTargets: Conversation['rewindTargets'] = () => {
    if (
      this.admission.active ||
      this.admission.completionHeld ||
      this.owner ||
      this.admission.closed ||
      this.journal.failure
    )
      return [];
    return listDirectRewindTargets(this.snapshot());
  };
  readonly cancel = (): void => {
    this.owner?.abort.abort();
  };
  readonly command: Conversation['command'] = (request, settings, settleForeground) => {
    request = structuredClone(request);
    if (this.admission.closed || this.journal.failure || !this.journal.recover())
      return Promise.resolve({
        result: { kind: 'not_admitting' as const, reason: this.journal.failure?.message ?? 'Session is closed' },
      });
    const proposal = planDirectCommandStart(this.journal.commandReceipts, request, this.revision());
    if (proposal.kind !== 'start')
      return Promise.resolve({
        result: proposal.kind === 'conflict' ? proposal : { ...structuredClone(proposal), replayed: true },
      });
    if (this.destination())
      return Promise.resolve({
        result: { kind: 'not_admitting' as const, reason: `Session rolled over to ${this.destination()}` },
      });
    // Reserve synchronously, before cancellation or any async model operation.
    if (!this.journal.commit([proposal.fact])) throw new Error(this.journal.failure!.message);
    const finish = (outcome: DirectCommandOutcome): DirectCommandResult => {
      if (!this.journal.commit([planDirectCommandFinish(this.journal.commandReceipts, request.commandId, outcome)]))
        throw new Error(this.journal.failure!.message);
      return {
        kind: 'finished',
        replayed: false,
        receipt: structuredClone(
          this.journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
        ),
      };
    };
    // These optional caller preconditions are checked in this synchronous
    // admission, not in a host preflight followed by a racy later mutation.
    // The original keyed receipt was already replayed above; later state
    // must not turn that same invocation into a different outcome or grant.
    if (request.expectedRevision !== undefined && request.expectedRevision !== proposal.fact.revision)
      return Promise.resolve({
        result: finish({ kind: 'rejected', code: 'stale', message: 'The command revision is no longer current.' }),
      });
    if (
      request.admission === 'idle' &&
      (this.admission.active ||
        this.admission.completionHeld ||
        this.journal.queueState.active ||
        (!this.journal.queueState.pause && this.journal.queueState.pending.length > 0))
    )
      return Promise.resolve({
        result: finish({ kind: 'rejected', code: 'busy', message: 'This command requires an idle Session.' }),
      });
    const boundaryRollover = this.admission.completionHeld
      ? directRolloverAtBoundary(this.journal.facts, this.admission.completionHeld)
      : undefined;
    if (boundaryRollover && (request.commandId !== boundaryRollover.commandId || request.operation.kind !== 'rollover'))
      return Promise.resolve({
        result: finish({
          kind: 'rejected',
          code: 'busy',
          message: 'The settled root owns its accepted rollover boundary.',
        }),
      });
    if (this.owner)
      return Promise.resolve({
        result: finish({ kind: 'rejected', code: 'busy', message: 'Another Session command owns history mutation.' }),
      });
    if (
      (request.operation.kind === 'configure' && !this.generation.runtime.configure) ||
      (request.operation.kind === 'rollover' && !this.generation.runtime.rollover) ||
      (request.operation.kind === 'compact' && !this.generation.runtime.compaction)
    )
      return Promise.resolve({
        result: finish({
          kind: 'rejected',
          code: 'unavailable',
          message: `${request.operation.kind} lacks its actual native runtime authority.`,
        }),
      });
    if (
      request.operation.kind === 'configure' &&
      (this.admission.active || this.admission.completionHeld || this.journal.queueState.active)
    )
      return Promise.resolve({
        result: finish({
          kind: 'rejected',
          code: 'busy',
          message: 'Stop the running turn before changing configuration.',
        }),
      });
    const owner = {
      commandId: request.commandId,
      kind: request.operation.kind,
      abort: new AbortController(),
      done: undefined as Promise<unknown> | undefined,
    };
    this.owner = owner;
    const work = async (): Promise<{ result: DirectCommandResult; started?: StartedConversationTurn }> => {
      try {
        if (request.operation.kind === 'rollover') {
          return await runConversationRollover({ ...request, operation: request.operation }, owner, {
            id: this.id,
            journal: this.journal,
            generation: this.generation,
            admission: this.admission,
            rotationBoundary: this.rotationBoundary,
            owns: () => this.owner === owner,
            blocked: () => this.rolloverBlocked(request.commandId),
            revision: this.revision,
            finish,
            install: this.installGeneration,
          });
        }
        if (request.operation.kind !== 'configure') {
          this.admission.active?.cancel();
          await settleForeground();
          if (this.admission.active) await this.admission.active.stop();
        }
        if (this.admission.closed || this.journal.failure || owner.abort.signal.aborted)
          return {
            result: finish({
              kind: 'rejected',
              code: 'cancelled',
              message: 'Session command was cancelled before mutation.',
            }),
          };
        const operation = request.operation;
        if (operation.kind === 'configure') {
          const expectedRevision = this.revision();
          let candidate: DirectPreparedConfiguration | undefined;
          let installed = false;
          try {
            candidate = await this.generation.runtime.configure!(operation.configuration, owner.abort.signal);
            if (
              this.admission.closed ||
              this.journal.failure ||
              owner.abort.signal.aborted ||
              this.owner !== owner ||
              this.revision() !== expectedRevision
            )
              return {
                result: finish({
                  kind: 'rejected',
                  code: owner.abort.signal.aborted || this.admission.closed ? 'cancelled' : 'stale',
                  message: 'Prepared configuration lost its Session reservation or revision.',
                }),
              };
            const prepared = this.generation.prepare(candidate);
            const { configurationFact } = prepared;
            const finished = planDirectCommandFinish(this.journal.commandReceipts, request.commandId, {
              kind: 'configured',
              configuration: candidate.configuration,
            });
            if (!this.journal.commit([configurationFact, finished])) throw new Error(this.journal.failure!.message);
            // Never discard a durably accepted generation, even if the app
            // violates its no-throw installation contract.
            installed = true;
            this.installGeneration(candidate, prepared);
            return {
              result: {
                kind: 'finished',
                replayed: false,
                receipt: structuredClone(
                  this.journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
                ),
              },
            };
          } finally {
            if (candidate && !installed) await candidate.dispose();
          }
        }
        if (operation.kind === 'compact') {
          const snapshot = this.snapshot();
          if (!snapshot.executionsSettled)
            return {
              result: finish({ kind: 'rejected', code: 'busy', message: 'Foreground cleanup has not settled.' }),
            };
          const state = this.journal.liveReplay();
          const turnId = this.admission.newTurnId();
          const configuration = directPreviewConfiguration(settings);
          if (
            !this.journal.commit([
              {
                type: 'turn_started',
                turnId,
                input: [],
                maintenance: { kind: 'compaction', commandId: request.commandId },
                ...(configuration ? { requestConfiguration: configuration } : {}),
              },
            ])
          )
            throw new Error(this.journal.failure!.message);
          const started = this.admission.start(
            { ...settings, input: [] },
            {
              turnId,
              accepted: true,
              compaction: true,
              facts: [],
              history: state.history,
              compactionState: state.compactionState,
            },
          );
          const cancel = () => started.turn.cancel();
          owner.abort.signal.addEventListener('abort', cancel, { once: true });
          if (owner.abort.signal.aborted) cancel();
          let terminal: TurnResult | undefined;
          try {
            // Same Session reader/acceptance path as a conversational root.
            // Budget waits are published and answered through the active turn answerBudget.
            for await (const event of started.turn.events) if (event.type === 'turn_ended') terminal = event.result;
          } finally {
            owner.abort.signal.removeEventListener('abort', cancel);
            if (this.admission.completionHeld === turnId)
              this.admission.releaseCompletion(this.admission.completionHeld!);
          }
          if (terminal?.kind === 'completed' && terminal.compaction?.kind === 'compacted')
            return { result: finish({ kind: 'compacted' }) };
          return {
            result: finish({
              kind: 'rejected',
              code:
                terminal?.kind === 'cancelled' || terminal?.kind === 'interrupted'
                  ? 'cancelled'
                  : terminal?.kind === 'completed'
                  ? 'ineligible'
                  : 'failed',
              message:
                terminal?.kind === 'failed'
                  ? terminal.error.message
                  : terminal?.kind === 'completed' && terminal.compaction?.kind === 'blocked'
                  ? `Compaction did not replace history: ${terminal.compaction.reason}.`
                  : 'Compaction ended without an accepted history replacement.',
            }),
          };
        }
        const snapshot = this.snapshot();
        if (operation.kind !== 'retry' && operation.kind !== 'rewind') throw new Error('Unsupported history command');
        const plan = planDirectHistoryCommand(snapshot, operation);
        if (plan.kind === 'rejected')
          return { result: finish({ kind: 'rejected', code: plan.code, message: plan.message }) };
        if (plan.expectedRevision !== this.revision() || this.owner !== owner)
          return {
            result: finish({
              kind: 'rejected',
              code: 'stale',
              message: 'Session history changed before command acceptance.',
            }),
          };
        if (plan.next.kind === 'rewound') {
          const outcome = { kind: 'rewound' as const, draft: plan.next.draft };
          if (
            !this.journal.commit([
              plan.fact,
              planDirectCommandFinish(this.journal.commandReceipts, request.commandId, outcome),
            ])
          )
            throw new Error(this.journal.failure!.message);
          this.generation.continuity?.state?.clear();
          return {
            result: {
              kind: 'finished',
              replayed: false,
              receipt: structuredClone(
                this.journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
              ),
            },
          };
        }
        const source = [...this.journal.facts].reverse().find((fact) => fact.type === 'turn_started');
        const through = plan.fact.history.at(-1);
        if (source?.type !== 'turn_started' || !through)
          return {
            result: finish({
              kind: 'rejected',
              code: 'ineligible',
              message: 'Retry has no retained accepted root context.',
            }),
          };
        const turnId = this.admission.newTurnId();
        const configuration = directPreviewConfiguration(settings);
        if (
          !this.journal.commit([
            plan.fact,
            {
              type: 'turn_started',
              turnId,
              input: [],
              retryContext: { sourceTurnId: source.turnId, throughItemId: through.id },
              ...(configuration ? { requestConfiguration: configuration } : {}),
            },
            planDirectCommandFinish(this.journal.commandReceipts, request.commandId, { kind: 'retried', turnId }),
          ])
        )
          throw new Error(this.journal.failure!.message);
        this.generation.continuity?.state?.clear();
        const started = this.admission.start(
          { ...settings, input: [] },
          { turnId, facts: [], accepted: true, history: plan.fact.history },
        );
        return {
          result: {
            kind: 'finished',
            replayed: false,
            receipt: structuredClone(
              this.journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
            ),
          },
          started,
        };
      } catch (error) {
        if (this.journal.failure) throw new Error(this.journal.failure.message);
        const accepted = this.journal.commandReceipts.find(
          (receipt) => receipt.request.commandId === request.commandId,
        );
        if (accepted?.outcome)
          return { result: { kind: 'finished', replayed: false, receipt: structuredClone(accepted) } };
        return {
          result: finish({
            kind: 'rejected',
            code: 'failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        };
      } finally {
        if (this.owner === owner) this.owner = null;
        const handoff = this.journal.facts.find(
          (fact) => fact.type === 'rollover_requested' && fact.commandId === request.commandId,
        );
        if (
          handoff?.type === 'rollover_requested' &&
          this.admission.completionHeld === handoff.turnId &&
          !this.admission.active
        )
          this.admission.releaseCompletion(this.admission.completionHeld!);
      }
    };
    const done = work();
    owner.done = done;
    return done;
  };
}
