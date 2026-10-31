/**
 * The direct turn: one model call, one event stream, no persistence.
 *
 * `events` never throws and always ends with `turn_ended`, including when
 * `models.resolve` fails. The caller is the only consumer. Nothing is yielded
 * after `cancel()` except the terminal event, so a late chunk cannot be shown.
 *
 * At M1 a model tool call ends the turn `failed` and is not yielded as an item,
 * so no orphan call can reach a later request. `answer`, `steer` and tool events
 * arrive with M2 and M3.
 */

import type {
  Item,
  ModelError,
  ModelRef,
  ModelRegistry,
  ModelRequest,
  ReasoningEffort,
  ToolSpec,
  Usage,
} from '../model/index.js';
import type { TurnId } from './index.js';

export type TurnSpec = {
  readonly turnId: TurnId;
  readonly history: readonly Item[];
  readonly newItems: readonly Item[];
  readonly instructions: string;
  readonly model: ModelRef;
  readonly tools: readonly ToolSpec[];
  readonly reasoning?: ReasoningEffort;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
};

export type TurnResult =
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: ModelError };

export type TurnEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'reasoning_delta'; readonly delta: string }
  | { readonly type: 'item'; readonly item: Item }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'turn_ended'; readonly result: TurnResult };

export type TurnHandle = {
  readonly events: AsyncIterable<TurnEvent>;
  cancel(): void;
};

export function startTurn(spec: TurnSpec, models: ModelRegistry): TurnHandle {
  const controller = new AbortController();
  return { events: runTurn(spec, models, controller), cancel: () => controller.abort() };
}

async function* runTurn(
  spec: TurnSpec,
  models: ModelRegistry,
  controller: AbortController,
): AsyncGenerator<TurnEvent, void> {
  const { signal } = controller;
  let result: TurnResult = { kind: 'completed' };
  try {
    if (!signal.aborted) {
      for await (const event of models.resolve(spec.model).stream(toRequest(spec), signal)) {
        if (signal.aborted) break;
        if (event.type === 'item' && event.item.type === 'tool_call') {
          result = failed(`model called ${event.item.toolName}; tools are not available yet`);
          controller.abort();
          break;
        }
        if (event.type === 'text_delta') yield { type: 'text_delta', delta: event.delta };
        else if (event.type === 'reasoning_delta') yield { type: 'reasoning_delta', delta: event.delta };
        else if (event.type === 'item') yield { type: 'item', item: event.item };
        else if (event.type === 'usage') yield { type: 'usage', usage: event.usage };
      }
    }
    if (signal.aborted && result.kind === 'completed') result = { kind: 'cancelled' };
  } catch (error) {
    if (result.kind === 'completed') {
      result = signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', error: toModelError(error) };
    }
  }
  yield { type: 'turn_ended', result };
}

function toRequest(spec: TurnSpec): ModelRequest {
  return {
    model: spec.model,
    instructions: spec.instructions,
    input: [...spec.history, ...spec.newItems],
    tools: spec.tools,
    ...(spec.reasoning !== undefined ? { reasoning: spec.reasoning } : {}),
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.maxOutputTokens !== undefined ? { maxOutputTokens: spec.maxOutputTokens } : {}),
    ...(spec.providerOptions !== undefined ? { providerOptions: spec.providerOptions } : {}),
  };
}

function failed(message: string): TurnResult {
  return { kind: 'failed', error: { kind: 'provider', message, retryable: false } };
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
