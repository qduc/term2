/** History submission commands: undo, rewind, and listing the rewind targets. */
import type { AdoptedCommandDeps, HistoryMutation, HistoryMutationResult } from './submission.js';

export function createHistoryCommands(deps: AdoptedCommandDeps) {
  const { context, runtime, turn, commit, poison } = deps;
  const historyOperations = new Map<string, Promise<HistoryMutationResult>>();
  return {
    listRewindTargets() {
      if (turn.closing) return Promise.reject(new Error('Session handle is closed'));
      return turn.serial.then(() => {
        if (turn.closing) throw new Error('Session handle is closed');
        return structuredClone(runtime.state.listRewindTargets());
      });
    },
    history(command: HistoryMutation): Promise<HistoryMutationResult> {
      try {
        context.assertHealthy();
      } catch (error) {
        return Promise.reject(error);
      }
      if (turn.poisoned !== undefined) return Promise.reject(turn.poisoned);
      if (turn.closing || context.state().status === 'closed')
        return Promise.reject(new Error('Session handle is closed'));
      if (turn.interrupting || turn.compacting) return Promise.reject(new Error('User interrupt is in progress'));
      const owned = structuredClone(command);
      if (!owned || typeof owned !== 'object' || !['undo_last', 'undo_count', 'rewind'].includes(owned.kind))
        return Promise.reject(new Error('Invalid history command'));
      const key = JSON.stringify(
        owned.kind === 'undo_count'
          ? [owned.kind, owned.count]
          : owned.kind === 'rewind'
          ? [owned.kind, owned.targetId]
          : [owned.kind],
      );
      const existing = historyOperations.get(key);
      if (existing) return existing;
      const operation = turn.queue(async (): Promise<HistoryMutationResult> => {
        context.assertHealthy();
        if (turn.closing) throw new Error('Session handle is closed');
        if (turn.poisoned !== undefined) throw turn.poisoned;
        const reservation = runtime.state.reserveHistoryMutation(owned);
        if (reservation.kind !== 'reserved') return reservation;
        // Close the old callback gate before awaiting any physical settlement.
        const { signal, token } = turn.stop({ captureToken: true });
        await turn.settle(signal);
        if (turn.closing || signal.aborted || !runtime.generationGuard.isCurrent(token)) return { kind: 'stale' };
        let restored: ReturnType<typeof reservation.apply>;
        try {
          restored = reservation.apply();
        } catch (error) {
          throw poison(error ?? new Error('History mutation failed'));
        }
        if (!restored) return { kind: 'stale' };
        const committedGeneration = runtime.generationGuard.capture();
        await commit([]);
        context.assertHealthy();
        if (turn.poisoned !== undefined) throw turn.poisoned;
        if (turn.closing || signal.aborted || !runtime.generationGuard.isCurrent(committedGeneration))
          return { kind: 'stale' };
        return {
          kind: 'applied',
          restored: { text: restored.text, ...(restored.images ? { images: restored.images } : {}) },
        };
      });
      historyOperations.set(key, operation);
      void operation
        .finally(() => {
          if (historyOperations.get(key) === operation) historyOperations.delete(key);
        })
        .catch(() => {});
      return operation;
    },
  };
}
