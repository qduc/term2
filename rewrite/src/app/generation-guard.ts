/** Per-request generation limits wrapped around every model the direct application resolves. */
import { GenerationGuard, GenerationStreamDeadlines } from '../engine/agent-runtime/generation-guard.js';
import type { Model, ModelEvent, ModelRegistry, ModelRequest } from '../model/index.js';
import type { ProfileSelection } from './tool-contract.js';

/**
 * The old run loop's per-request limits: a stalled stream and oversized text end
 * the turn as a failure, with the same settings and messages. Above the provider,
 * so a trip is not retried. Text passes `observeText` before it can be shown.
 */
export function withGenerationGuard(models: ModelRegistry, { settings }: ProfileSelection): ModelRegistry {
  const stream = async function* (
    model: Model,
    request: ModelRequest,
    signal: AbortSignal,
    onDispatched?: () => void,
  ): AsyncIterable<ModelEvent> {
    const maxCharacters = settings.get('agent.maxStreamOutputChars');
    const guard = new GenerationGuard({
      maxOutputCharacters: maxCharacters,
      maxTextCharacters: maxCharacters,
      maxReasoningCharacters: maxCharacters,
      requestDeadlineMs: settings.get('agent.maxModelRequestDurationMs'),
      maxStreamIdleMs: settings.get('agent.maxModelStreamIdleMs'),
    });
    const stop = new AbortController();
    const deadlines = new GenerationStreamDeadlines(
      { totalMs: guard.requestDeadlineMs, idleMs: guard.maxStreamIdleMs },
      () => stop.abort(),
      () => guard.progress,
    );
    const events = model.stream(request, AbortSignal.any([signal, stop.signal]), onDispatched)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await deadlines.wait(events.next());
        if (next.done) return;
        deadlines.recordActivity();
        if (next.value.type === 'text_delta') guard.observeText(next.value.delta);
        if (next.value.type === 'reasoning_delta') guard.observeReasoning(next.value.delta);
        yield next.value;
      }
    } finally {
      deadlines.dispose();
      stop.abort();
      void events.return?.()?.catch(() => undefined);
    }
  };
  return {
    list: () => models.list(),
    resolve(ref) {
      const model = models.resolve(ref);
      return { ...model, stream: (request, signal, onDispatched) => stream(model, request, signal, onDispatched) };
    },
  };
}
