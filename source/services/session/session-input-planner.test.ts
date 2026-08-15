import { expect, it, vi } from 'vitest';
import { ProviderContinuity } from '../provider-continuity.js';
import type { ProviderHistorySnapshot } from '../conversation/conversation-store.js';
import { getSerializedInputBytes } from '../large-uncached-input-guard.js';
import { combineHistoryAndDraftBytes, SessionInputPlanner } from './session-input-planner.js';

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

it('drops chaining and uses full history when the previous response still has unpaid tool debt', () => {
  const history = [
    { role: 'user', type: 'message', content: 'inspect' },
    { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'Stream failed' },
  ];
  const continuity = new ProviderContinuity();
  continuity.update('resp-with-open-tools');
  continuity.replaceOutstandingToolCallIds(['call-1']);

  const planner = new SessionInputPlanner({
    agentClient: { getProvider: () => 'openai', supportsConversationChaining: () => true } as any,
    toolTracker: { getReconciledHistory: () => history } as any,
    providerContinuity: continuity,
  });

  const plan = planner.build({ text: 'continue' }, { includeTurn: true, pendingModeNotice: null });

  expect(plan.inputSurgeKind).toBe('full_history');
  expect(Array.isArray(plan.streamInput)).toBe(true);
  expect(continuity.previousResponseId).toBe(null);
  expect(continuity.hasOutstandingToolDebt()).toBe(false);
  const items = plan.streamInput as Array<Record<string, unknown>>;
  expect(items.some((item) => item.type === 'function_call_output' || item.type === 'function_call')).toBe(true);
  expect(items[items.length - 1]).toMatchObject({ role: 'user' });
});

it('uses self-contained full history for a partial parallel tool batch', () => {
  const continuity = new ProviderContinuity();
  continuity.update('resp-with-partial-parallel-batch');
  continuity.replaceOutstandingToolCallIds(['call-b']);
  const planner = new SessionInputPlanner({
    agentClient: { getProvider: () => 'openai', supportsConversationChaining: () => true } as any,
    toolTracker: {
      getReconciledHistory: () => [
        { role: 'user', type: 'message', content: 'run both' },
        { type: 'function_call', call_id: 'call-a', name: 'read_file', arguments: '{}' },
        { type: 'function_call', call_id: 'call-b', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-a', output: 'contents' },
      ],
    } as any,
    providerContinuity: continuity,
  });

  const plan = planner.build({ text: 'continue' }, { includeTurn: true, pendingModeNotice: null });

  expect(plan.inputSurgeKind).toBe('full_history');
  expect(plan.streamInput).toEqual([
    { role: 'user', type: 'message', content: 'run both' },
    { type: 'function_call', call_id: 'call-a', name: 'read_file', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-a', output: 'contents' },
    { role: 'user', type: 'message', content: 'continue' },
  ]);
  expect(continuity.previousResponseId).toBe(null);
});

it('combineHistoryAndDraftBytes matches JSON.stringify of history-plus-draft', () => {
  const history = [
    { role: 'user', type: 'message', content: 'prior' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
  ];
  const draft = { role: 'user', type: 'message', content: 'hello world' };
  const historyBytes = getSerializedInputBytes(history);
  const draftBytes = getSerializedInputBytes(draft);

  expect(combineHistoryAndDraftBytes(historyBytes, history.length, draftBytes)).toBe(
    getSerializedInputBytes([...history, draft]),
  );
  expect(combineHistoryAndDraftBytes(getSerializedInputBytes([]), 0, draftBytes)).toBe(
    getSerializedInputBytes([draft]),
  );
});

// previewLargeUncachedInput used to always build the outgoing history (reconcile
// + malformed-arg scan + optional full-history sanitize) before the guard could
// decide. That cost is linear in conversation length and was paid on every
// composer advisory even when session state made a warning impossible.
it('previewLargeUncachedInput does not build history when no warning is possible', () => {
  const getReconciledHistory = vi.fn(() => [
    { role: 'user', type: 'message', content: 'prior' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
  ]);
  const planner = new SessionInputPlanner({
    agentClient: { getProvider: () => 'openai', supportsConversationChaining: () => true } as any,
    toolTracker: { getReconciledHistory } as any,
    providerContinuity: new ProviderContinuity(),
    settingsService: {
      get: (key: string) => {
        if (key === 'agent.model') return 'gpt-5';
        if (key === 'agent.provider') return 'openai';
        if (key === 'agent.reasoningEffort') return 'medium';
        return undefined;
      },
    } as any,
  });

  planner.recordSuccess('prior', { kind: 'delta' });
  getReconciledHistory.mockClear();

  const decision = planner.previewLargeUncachedInput('hello', 1_000);

  expect(decision.action).toBe('allow');
  expect(getReconciledHistory).not.toHaveBeenCalled();
});

it('previewLargeUncachedInput builds history when a warning is possible', () => {
  const getReconciledHistory = vi.fn(() => [
    { role: 'user', type: 'message', content: 'prior' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
  ]);
  const planner = new SessionInputPlanner({
    agentClient: { getProvider: () => 'openai', supportsConversationChaining: () => true } as any,
    toolTracker: { getReconciledHistory } as any,
    providerContinuity: new ProviderContinuity(),
    settingsService: {
      get: (key: string) => {
        if (key === 'agent.model') return 'gpt-5';
        if (key === 'agent.provider') return 'openai';
        if (key === 'agent.reasoningEffort') return 'medium';
        return undefined;
      },
    } as any,
  });

  // Undo/rewind is a risk factor that does not depend on wall clock, so the
  // preview must still build the outgoing payload to size-check it.
  planner.markUndoOrRewind();
  getReconciledHistory.mockClear();

  const decision = planner.previewLargeUncachedInput('hello', 1_000);

  expect(getReconciledHistory).toHaveBeenCalled();
  // Chained delta is tiny, so risk alone still allows (below threshold).
  expect(decision.action).toBe('allow');
});

// Finalized messages never change while typing. Measure them once per history
// identity; later previews only re-size the draft.
it('previewLargeUncachedInput reuses cached finalized history size across draft changes', () => {
  const history = Array.from({ length: 40 }, (_, i) =>
    i % 2 === 0
      ? { role: 'user', type: 'message', content: `user-${i} ${'x'.repeat(200)}` }
      : {
          role: 'assistant',
          type: 'message',
          content: [{ type: 'output_text', text: `asst-${i} ${'y'.repeat(200)}` }],
        },
  );
  const getReconciledHistory = vi.fn(() => history);
  let historyIdentity = 'history:rev-1';
  // Force full-history sizing: no chaining support.
  const planner = new SessionInputPlanner({
    agentClient: { getProvider: () => 'openai', supportsConversationChaining: () => false } as any,
    toolTracker: { getReconciledHistory } as any,
    providerContinuity: new ProviderContinuity(),
    getHistoryIdentity: () => historyIdentity,
    settingsService: {
      get: (key: string) => {
        if (key === 'agent.model') return 'gpt-5';
        if (key === 'agent.provider') return 'openai';
        if (key === 'agent.reasoningEffort') return 'medium';
        return undefined;
      },
    } as any,
  });

  planner.markUndoOrRewind();
  getReconciledHistory.mockClear();

  const first = planner.previewLargeUncachedInput('draft one', 1_000);
  const second = planner.previewLargeUncachedInput('draft one with more text', 1_000);
  const third = planner.previewLargeUncachedInput('draft one with more text and still more', 1_000);

  expect(getReconciledHistory).toHaveBeenCalledTimes(1);
  expect(first.estimatedBytes).toBeGreaterThan(0);
  expect(second.estimatedBytes).toBeGreaterThan(first.estimatedBytes);
  expect(third.estimatedBytes).toBeGreaterThan(second.estimatedBytes);

  // Identity change (new finalized turn) must remeasure history.
  historyIdentity = 'history:rev-2';
  history.push({ role: 'user', type: 'message', content: 'committed' });
  planner.previewLargeUncachedInput('after commit', 1_000);
  expect(getReconciledHistory).toHaveBeenCalledTimes(2);
});

it('previewLargeUncachedInput full-history size matches build()+serialize', () => {
  const history = [
    { role: 'user', type: 'message', content: 'prior' },
    { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
  ];
  const planner = new SessionInputPlanner({
    agentClient: { getProvider: () => 'openai', supportsConversationChaining: () => false } as any,
    toolTracker: { getReconciledHistory: () => history } as any,
    providerContinuity: new ProviderContinuity(),
    getHistoryIdentity: () => 'history:1',
    settingsService: {
      get: (key: string) => {
        if (key === 'agent.model') return 'gpt-5';
        if (key === 'agent.provider') return 'openai';
        if (key === 'agent.reasoningEffort') return 'medium';
        return undefined;
      },
    } as any,
  });

  planner.markUndoOrRewind();
  const draft = 'size me carefully';
  const decision = planner.previewLargeUncachedInput(draft, 1_000);
  const { streamInput } = planner.build({ text: draft }, { includeTurn: true, pendingModeNotice: null });

  expect(decision.estimatedBytes).toBe(getSerializedInputBytes(streamInput));
});
