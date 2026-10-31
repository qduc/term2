/** Manual context compaction submission command: runs shared M0 compaction and records durable M1 state/accounting. */
import crypto from 'node:crypto';
import type { ConversationEvent } from '../../../../source/services/conversation/conversation-events.js';
import type { ModelRequestCost } from '../../../../source/services/cost/model-cost.js';
import type {
  ContextCompactionRecordedEvent,
  StateSnapshot,
} from '../../../../source/services/logging/conversation-log-events.js';
import {
  runManualCompaction,
  type ConversationCompactionOutcome,
} from '../../../../source/services/session/manual-compaction.js';
import type { NormalizedUsage } from '../../../../source/utils/ai/token-usage.js';
import type { AdoptedCommandDeps } from './submission.js';

export function createCompactCommand(
  deps: AdoptedCommandDeps,
  options: {
    isSubmissionPending: () => boolean;
    reserveNetworkForCompaction?: () => (() => void) | null;
    emitSourceEvent?: (update: { turnId: string; generation: number; event: ConversationEvent }) => void;
  },
) {
  const { context, runtime, turn, commit, poison } = deps;
  let inFlight: Promise<ConversationCompactionOutcome> | undefined;

  const isBusy = (): boolean => {
    const state = context.state();
    return (
      options.isSubmissionPending() ||
      state.status === 'running' ||
      state.status === 'awaiting_interaction' ||
      state.activeTurnId !== null ||
      state.pendingInteraction !== null ||
      state.queue.length > 0 ||
      !runtime.appState.statusMachine.is('idle') ||
      runtime.pendingInteraction.getSnapshot() !== null ||
      runtime.approvalState.getPending() !== null ||
      runtime.postExecutePending.snapshot().entries.length > 0 ||
      runtime.nestedApprovalOwner.getSnapshot() !== null ||
      runtime.backgroundSubagentApprovals.getSnapshot().pendingCount > 0
    );
  };

  const refuseBusy = (): Promise<ConversationCompactionOutcome> =>
    runManualCompaction({
      holdForegroundQueue: () => false,
      attachCompactionAbort: () => {},
      detachCompactionAbort: () => {},
      releaseForegroundQueue: () => {},
      compactContext: runtime.compactContext,
      getEventSink: () => undefined,
      logger: runtime.logger,
      getProvider: () => context.state().model.provider,
      getSessionId: () => context.id,
    });

  return {
    compact(): Promise<ConversationCompactionOutcome> {
      try {
        context.assertHealthy();
      } catch (error) {
        return Promise.reject(error);
      }
      if (turn.poisoned !== undefined) return Promise.reject(turn.poisoned);
      if (turn.closing || context.state().status === 'closed')
        return Promise.reject(new Error('Session handle is closed'));
      if (turn.interrupting || turn.settingMutation)
        return Promise.reject(new Error('Session mutation is in progress'));
      if (inFlight) return inFlight;
      if (isBusy()) return refuseBusy();

      const releaseNetwork = options.reserveNetworkForCompaction ? options.reserveNetworkForCompaction() : () => {};
      if (!releaseNetwork) return refuseBusy();

      let releaseSettings: (() => void) | undefined;
      try {
        releaseSettings = context.reserveSettings();
      } catch (error) {
        releaseNetwork();
        return Promise.reject(error);
      }
      turn.compacting = true;

      const operation = turn.queue(async (): Promise<ConversationCompactionOutcome> => {
        await turn.completion;
        context.assertHealthy();
        if (turn.poisoned !== undefined) throw turn.poisoned;
        if (turn.closing || context.state().status === 'closed') throw new Error('Session handle is closed');

        const operationId = crypto.randomUUID();
        const token = runtime.generationGuard.capture();
        const model = { ...context.state().model };
        const emitSource = (event: ConversationEvent) => {
          try {
            const result: unknown = options.emitSourceEvent?.({
              turnId: operationId,
              generation: token,
              event,
            });
            if (
              result != null &&
              (typeof result === 'object' || typeof result === 'function') &&
              typeof (result as { then?: unknown }).then === 'function'
            ) {
              void Promise.resolve(result).catch(() => {});
            }
          } catch {
            /* Observer failures do not alter compaction. */
          }
        };

        const bufferedEvents: ConversationEvent[] = [];
        let observedStrategy: 'local' | 'native' = model.provider === 'codex' ? 'native' : 'local';
        let sawAccountingObservation = false;
        let observedUsage: { inputTokens: number; outputTokens: number } | undefined;
        const observedCosts: ModelRequestCost[] = [];
        const seenRequestIds = new Set<string>();
        let rawOutcome: Awaited<ReturnType<typeof runtime.compactContext>> | undefined;
        let capturedSnapshot: StateSnapshot | undefined;

        const abortListeners = new Map<AbortController, { signal: AbortSignal; listener: () => void }>();
        const attachCompactionAbort = (abort: AbortController) => {
          const signal = turn.cancellation.signal;
          const listener = () => abort.abort();
          if (
            signal.aborted ||
            turn.closing ||
            turn.poisoned !== undefined ||
            !runtime.generationGuard.isCurrent(token)
          ) {
            abort.abort();
            return;
          }
          signal.addEventListener('abort', listener, { once: true });
          abortListeners.set(abort, { signal, listener });
        };
        const detachCompactionAbort = (abort: AbortController) => {
          const entry = abortListeners.get(abort);
          if (entry) {
            entry.signal.removeEventListener('abort', entry.listener);
            abortListeners.delete(abort);
          }
        };

        const buildAccountingFields = (): {
          usage?: NormalizedUsage;
          costRecords?: ModelRequestCost[];
        } => {
          let usage: NormalizedUsage | undefined;
          const costRecords: ModelRequestCost[] = [];
          if (sawAccountingObservation) {
            if (observedUsage !== undefined) {
              usage = {
                prompt_tokens: observedUsage.inputTokens,
                completion_tokens: observedUsage.outputTokens,
                total_tokens: observedUsage.inputTokens + observedUsage.outputTokens,
              };
            }
            for (const record of observedCosts) costRecords.push(structuredClone(record));
          } else if (rawOutcome) {
            if (
              'usage' in rawOutcome &&
              rawOutcome.usage &&
              (rawOutcome.usage.inputTokens > 0 || rawOutcome.usage.outputTokens > 0)
            ) {
              usage = {
                prompt_tokens: rawOutcome.usage.inputTokens,
                completion_tokens: rawOutcome.usage.outputTokens,
                total_tokens: rawOutcome.usage.inputTokens + rawOutcome.usage.outputTokens,
              };
            }
            if ('costRecords' in rawOutcome && Array.isArray(rawOutcome.costRecords)) {
              const seen = new Set<string>();
              for (const record of rawOutcome.costRecords) {
                if (record.requestId && seen.has(record.requestId)) continue;
                if (record.requestId) seen.add(record.requestId);
                costRecords.push(structuredClone(record));
              }
            }
          }
          return {
            ...(usage ? { usage } : {}),
            ...(costRecords.length > 0 ? { costRecords } : {}),
          };
        };

        let outcome: ConversationCompactionOutcome;
        try {
          outcome = await runManualCompaction({
            holdForegroundQueue: () => {
              if (turn.closing || turn.poisoned !== undefined || context.state().status === 'closed') return false;
              if (
                !runtime.generationGuard.isCurrent(token) ||
                turn.active !== undefined ||
                turn.activePostExecuteRunId !== undefined ||
                isBusy()
              ) {
                return false;
              }
              return true;
            },
            attachCompactionAbort,
            detachCompactionAbort,
            releaseForegroundQueue: () => {},
            compactContext: async (compactOptions) => {
              const raw = await runtime.compactContext({
                ...compactOptions,
                onStrategy(strategy) {
                  observedStrategy = strategy;
                },
                onAccounting(observation) {
                  sawAccountingObservation = true;
                  if (observation.usage !== undefined) {
                    observedUsage ??= { inputTokens: 0, outputTokens: 0 };
                    observedUsage.inputTokens += observation.usage.inputTokens;
                    observedUsage.outputTokens += observation.usage.outputTokens;
                  }
                  if (observation.costRecords) {
                    for (const record of observation.costRecords) {
                      if (record.requestId && seenRequestIds.has(record.requestId)) continue;
                      if (record.requestId) seenRequestIds.add(record.requestId);
                      observedCosts.push(structuredClone(record));
                    }
                  }
                },
              });
              rawOutcome = raw;
              if (raw.kind === 'compacted') {
                if (sawAccountingObservation) {
                  raw.costRecords = observedCosts.map((record) => structuredClone(record));
                }
                capturedSnapshot = runtime.state.getCurrentSnapshot();
              }
              return raw;
            },
            getEventSink: () => (event) => {
              if (event.type === 'context_compaction_started') {
                emitSource(event);
              } else {
                bufferedEvents.push(event);
              }
            },
            logger: runtime.logger,
            getProvider: () => model.provider,
            getSessionId: () => context.id,
          });
        } catch (error) {
          const accounting = buildAccountingFields();
          if (accounting.usage !== undefined || accounting.costRecords !== undefined) {
            try {
              await commit([
                {
                  type: 'context_compaction_recorded',
                  version: 1,
                  operationId,
                  provider: model.provider,
                  model: model.model,
                  strategy: observedStrategy,
                  result: { kind: 'not_compacted' },
                  ...accounting,
                },
              ]);
              context.assertHealthy();
              if (turn.poisoned !== undefined) throw turn.poisoned;
            } catch (commitError) {
              poison(commitError ?? new Error('Context compaction persistence failed'));
              turn.cancelRun();
              throw turn.poisoned;
            }
          }
          for (const event of bufferedEvents) emitSource(event);
          throw error;
        }

        const accounting = buildAccountingFields();
        if (outcome.kind === 'compacted') {
          if (!capturedSnapshot) {
            poison(new Error('Compacted outcome missing state snapshot'));
            turn.cancelRun();
            throw turn.poisoned;
          }
          const fact: ContextCompactionRecordedEvent = {
            type: 'context_compaction_recorded',
            version: 1,
            operationId,
            provider: model.provider,
            model: model.model,
            strategy: observedStrategy,
            result: { kind: 'compacted', snapshot: capturedSnapshot },
            ...accounting,
          };
          try {
            await commit([fact]);
            context.assertHealthy();
            if (turn.poisoned !== undefined) throw turn.poisoned;
          } catch (commitError) {
            poison(commitError ?? new Error('Context compaction persistence failed'));
            turn.cancelRun();
            throw turn.poisoned;
          }
        } else if (accounting.usage !== undefined || accounting.costRecords !== undefined) {
          const fact: ContextCompactionRecordedEvent = {
            type: 'context_compaction_recorded',
            version: 1,
            operationId,
            provider: model.provider,
            model: model.model,
            strategy: observedStrategy,
            result: { kind: 'not_compacted' },
            ...accounting,
          };
          try {
            await commit([fact]);
            context.assertHealthy();
            if (turn.poisoned !== undefined) throw turn.poisoned;
          } catch (commitError) {
            poison(commitError ?? new Error('Context compaction persistence failed'));
            turn.cancelRun();
            throw turn.poisoned;
          }
        }

        for (const event of bufferedEvents) emitSource(event);
        return outcome;
      });

      const promise = operation.finally(() => {
        turn.compacting = false;
        releaseSettings?.();
        releaseNetwork();
        if (inFlight === promise) inFlight = undefined;
      });
      inFlight = promise;
      return promise;
    },
  };
}
