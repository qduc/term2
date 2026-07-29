import { expect, it } from 'vitest';
import { ProviderContinuity } from '../provider-continuity.js';
import type { ProviderHistorySnapshot } from '../conversation/conversation-store.js';
import { SessionInputPlanner } from './session-input-planner.js';

it('carries the authoritative immutable history snapshot alongside the unchanged input plan', () => {
  const snapshot: ProviderHistorySnapshot = Object.freeze({
    revision: 3,
    identity: 'history:3',
    history: Object.freeze([{ role: 'user', type: 'message', content: 'hello' }]) as any,
  });
  const planner = new SessionInputPlanner({
    agentClient: { getProvider: () => 'openai', supportsConversationChaining: () => true } as any,
    toolTracker: { getReconciledHistory: () => snapshot.history } as any,
    providerContinuity: new ProviderContinuity(),
    getProviderHistorySnapshot: () => snapshot,
  });

  const plan = planner.build({ text: 'hello' }, { includeTurn: false, pendingModeNotice: null });

  expect(plan.providerHistorySnapshot).toBe(snapshot);
  expect(plan.streamInput).toBe('hello');
  expect(plan.inputSurgeKind).toBe('delta');
});
