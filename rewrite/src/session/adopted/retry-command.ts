/** Retry submission command: rewinds the last user turn or tool output and relaunches it. */
import crypto from 'node:crypto';
import { rewindRemovedUserCount } from '../../../../source/services/conversation/conversation-replay.js';
import { ConversationStore } from '../../../../source/services/conversation/conversation-store.js';
import type { UserTurn } from '../../../../source/types/user-turn.js';
import type { TurnInput } from '../../engine/index.js';
import type { Admission, SessionFact } from '../index.js';
import { loadCanonicalRetryTarget } from './conversation-log.js';
import type {
  AdoptedAdmissionReceipt,
  AdoptedCommandDeps,
  AdoptedRetryResult,
  AdoptedRetryTarget,
} from './submission.js';

/** Starts a turn that is already recorded as started, as the foreground's `launch` does. */
type LaunchTurn = (
  receipt: { turnId: TurnInput['turnId']; input: UserTurn; userMessageRef?: AdoptedAdmissionReceipt['userMessageRef'] },
  token: number,
  signal: AbortSignal,
  retryOrigin: boolean,
) => Promise<Admission>;

export function createRetryCommand(deps: AdoptedCommandDeps, launch: LaunchTurn) {
  const { context, runtime, turn, commit, poison } = deps;
  return {
    retry(target: AdoptedRetryTarget): Promise<AdoptedRetryResult> {
      try {
        context.assertHealthy();
      } catch (error) {
        return Promise.reject(error);
      }
      if (target !== 'turn' && target !== 'tool') return Promise.reject(new Error('Invalid retry target'));
      if (turn.closing || context.state().status === 'closed')
        return Promise.resolve({ kind: 'rejected', reason: 'closed' });
      if (turn.interrupting || turn.settingMutation || turn.compacting)
        return Promise.reject(new Error('Session mutation is in progress'));
      if (turn.poisoned !== undefined) return Promise.reject(turn.poisoned);
      if (!context.state().retryEligibility[target]) return Promise.resolve({ kind: 'ineligible', target });
      const hasToolResult = () => {
        const preview = new ConversationStore();
        for (const item of runtime.record.getHistory()) preview.addImportedItem(item);
        return preview.peekLastToolOutput() !== null;
      };
      if (target === 'tool' && !hasToolResult()) return Promise.resolve({ kind: 'ineligible', target });
      const signal = turn.stop();
      return turn.queue(async (): Promise<AdoptedRetryResult> => {
        context.assertHealthy();
        if (turn.poisoned !== undefined) throw turn.poisoned;
        await turn.settle(signal);
        signal.throwIfAborted();
        runtime.pendingInteraction.clear();
        if (turn.closing) return { kind: 'rejected', reason: 'closed' };
        if (!context.state().retryEligibility[target]) return { kind: 'ineligible', target };
        if (target === 'tool' && !hasToolResult()) return { kind: 'ineligible', target };
        const original = loadCanonicalRetryTarget(context.id, context.root);
        if (target === 'turn' && !original) return { kind: 'ineligible', target };
        if (target === 'tool' && !runtime.state.peekLastToolOutput()) {
          throw poison(new Error('Canonical retry eligibility disagrees with source state'));
        }
        const before = structuredClone(runtime.record.getHistory());
        const rewound =
          target === 'turn' ? runtime.state.retryLastUserTurn({ logUndo: false }) : runtime.state.retryLastToolOutput();
        if (!rewound) {
          throw poison(new Error('Canonical retry eligibility disagrees with source state'));
        }
        const turnId = crypto.randomUUID() as TurnInput['turnId'];
        const token = runtime.generationGuard.capture();
        const snapshot = runtime.state.getCurrentSnapshot();
        try {
          rewindRemovedUserCount(before, snapshot.history);
        } catch (error) {
          throw poison(error);
        }
        const fact: SessionFact =
          target === 'turn'
            ? { type: 'user_turn_retried', version: 1, userMessageRef: original!.userMessageRef, snapshot }
            : { type: 'tool_output_rewound', version: 1, snapshot };
        await commit([fact, { type: 'session_turn_started', version: 1, turnId, clientRequestId: null }]);
        if (signal.aborted || turn.closing || !runtime.generationGuard.isCurrent(token)) {
          await commit([{ type: 'session_turn_ended', version: 1, turnId, outcome: 'cancelled' }]);
          throw new Error('Retry became stale');
        }
        const retainedUser = target === 'tool' ? loadCanonicalRetryTarget(context.id, context.root) : original;
        const admitted = await launch(
          {
            turnId,
            input: retainedUser?.submittedTurn ?? { text: '' },
            ...(retainedUser ? { userMessageRef: retainedUser.userMessageRef } : {}),
          },
          token,
          signal,
          true,
        );
        if (admitted.kind !== 'started') throw new Error('Retry did not start');
        return admitted;
      });
    },
  };
}
