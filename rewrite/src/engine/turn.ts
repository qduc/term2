/**
 * Direct turn advancement. Session is the sole consumer and accepts each event
 * after committing it. Models and tools are injected leaves; no persistence or
 * legacy driver lives here. A terminal is emitted only after physical cleanup.
 */
import type { Item, ItemId, ModelError, ModelRequest, StopReason } from '../model/index.js';
import type { TurnDeps, TurnHandle, TurnResult, TurnSpec } from './direct-types.js';
import { TurnEvents, cancelled } from './turn-events.js';
import { TurnTools, type RootCall } from './turn-tools.js';

export type { TurnSpec, TurnResult, TurnEvent, TurnHandle } from './direct-types.js';

/** Lazy, single-consumer model/tool/model run with per-event durable acceptance. */
export function startTurn(spec: TurnSpec, deps: TurnDeps): TurnHandle {
  const controller = new AbortController();
  const channel = new TurnEvents();
  const tools = new TurnTools(spec, deps, controller.signal, channel);
  const cancel = (): void => {
    controller.abort();
    channel.cancel();
    tools.cancel();
  };
  const events = (async function* () {
    const work = drive(spec, deps, controller, channel, tools);
    try {
      yield* channel.events();
    } finally {
      cancel();
      // A consumer that closes early still owns cancellation and physical cleanup.
      await work;
    }
  })();
  return {
    events,
    accept: (token) => channel.accept(token),
    answer: (id, decision) => tools.answer(id, decision),
    cancel,
  };
}

async function drive(
  spec: TurnSpec,
  deps: TurnDeps,
  controller: AbortController,
  events: TurnEvents,
  tools: TurnTools,
): Promise<void> {
  const { signal } = controller;
  let result: TurnResult = { kind: 'completed' };
  const history = [...spec.history, ...spec.newItems];
  try {
    let modelStep = 0;
    while (!signal.aborted && !tools.stopped) {
      const calls = await modelStepRun(spec, deps, signal, events, tools, history, ++modelStep);
      if (calls.length === 0) break;
      await tools.run(calls, history);
    }
    if (signal.aborted) result = { kind: 'cancelled' };
  } catch (error) {
    result = signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', error: toModelError(error) };
    controller.abort();
    events.cancel();
  } finally {
    // All root and scripted operations must have settled before Session can go idle.
    tools.cancel();
    await tools.cleanup();
    events.finish(result);
  }
}

async function modelStepRun(
  spec: TurnSpec,
  deps: TurnDeps,
  signal: AbortSignal,
  events: TurnEvents,
  tools: TurnTools,
  history: Item[],
  modelStep: number,
): Promise<RootCall[]> {
  const calls: RootCall[] = [];
  const stepItems: Item[] = [];
  let text = '';
  let textPosition = 0;
  let stop: StopReason | undefined;
  for await (const event of deps.models.resolve(spec.model).stream(toRequest(spec, history), signal)) {
    if (signal.aborted) throw cancelled();
    switch (event.type) {
      case 'text_delta':
        await events.publish({ type: 'text_delta', delta: event.delta, modelStep });
        if (!text) textPosition = stepItems.length;
        text += event.delta;
        break;
      case 'reasoning_delta':
        await events.publish({ type: 'reasoning_delta', delta: event.delta });
        break;
      case 'item': {
        const call = event.item.type === 'tool_call' ? tools.root(event.item) : undefined;
        await events.publish({
          type: 'item',
          item: event.item,
          modelStep,
          ...(call ? { executionId: call.executionId } : {}),
        });
        stepItems.push(event.item);
        if (event.item.type === 'assistant_message') text = '';
        if (call) {
          calls.push(call);
          await events.publish({
            type: 'tool_called',
            executionId: call.executionId,
            callId: call.item.callId,
            toolName: call.item.toolName,
            input: call.item.input,
          });
        }
        break;
      }
      case 'usage':
        await events.publish({ type: 'usage', usage: event.usage, modelStep });
        break;
      case 'done':
        stop = event.stopReason;
        break;
      case 'retrying':
        // Provider-owned transport retry; no engine replay of tools or model steps.
        break;
    }
  }
  if (signal.aborted) throw cancelled();
  if (stop === undefined) throw new Error('Model stream ended before the response completed.');
  if (calls.length > 0 && (stop === 'max_tokens' || stop === 'refusal')) {
    throw new Error(`Model response ended with ${stop}; tool calls were not executed.`);
  }
  if (text) {
    stepItems.splice(textPosition, 0, {
      type: 'assistant_message',
      id: `${spec.turnId}-model-${modelStep}-partial` as ItemId,
      content: [{ type: 'text', text }],
    });
  }
  history.push(...stepItems);
  return calls;
}

function toRequest(spec: TurnSpec, history: readonly Item[]): ModelRequest {
  return {
    model: spec.model,
    instructions: spec.instructions,
    input: [...history],
    tools: spec.tools,
    ...(spec.reasoning !== undefined ? { reasoning: spec.reasoning } : {}),
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.maxOutputTokens !== undefined ? { maxOutputTokens: spec.maxOutputTokens } : {}),
    ...(spec.providerOptions !== undefined ? { providerOptions: spec.providerOptions } : {}),
  };
}

/** Spelled out because `message` is not enumerable on an Error. */
function toModelError(error: unknown): ModelError {
  const { kind, message, retryable, retryAfterMs } = (error ?? {}) as Partial<ModelError>;
  if (typeof kind === 'string' && typeof message === 'string') {
    return {
      kind,
      message,
      retryable: retryable === true,
      ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    };
  }
  return { kind: 'provider', message: error instanceof Error ? error.message : String(error), retryable: false };
}
