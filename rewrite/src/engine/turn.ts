/** Direct advancement; Session is the only writer and event-acceptance authority. */
import type { Item, ItemId } from '../model/index.js';
import type { NestedRunRequest, ToolRegistry } from '../tools/index.js';
import type { TurnDeps, TurnHandle, TurnResult, TurnSpec } from './direct-types.js';
import { TurnEvents, cancelled } from './turn-events.js';
import { TurnTools } from './turn-tools.js';
import { NativeBudgetExhausted, TurnBudgetControl } from './turn-budget.js';
import { TurnModel, toModelError } from './turn-model.js';

export type { TurnSpec, TurnResult, TurnEvent, TurnHandle } from './direct-types.js';

/** Lazy, single-consumer model/tool/model run with per-event durable acceptance. */
export function startTurn(spec: TurnSpec, deps: TurnDeps): TurnHandle {
  return createTurn(spec, deps, 'conversation');
}

/** Compaction-only invocation through the same physical request, budget and acceptance boundary.
 * No root assistant inference or tools are run; the accepted history replacement proves success. */
export function startCompaction(spec: TurnSpec, deps: TurnDeps): TurnHandle {
  return createTurn(spec, deps, 'compaction');
}

function createTurn(spec: TurnSpec, deps: TurnDeps, operation: 'conversation' | 'compaction'): TurnHandle {
  const controller = new AbortController();
  const channel = new TurnEvents();
  const budget = new TurnBudgetControl(spec, deps, channel, controller.signal);
  const tools = new TurnTools(spec, deps, controller.signal, channel, budget);
  const model = new TurnModel(spec, deps, controller.signal, channel, tools, budget);
  let settled = false;
  const cancel = (): void => {
    deps.onTurnBoundary?.({ turnId: spec.turnId, kind: 'cancelled' });
    if (!settled) model.clear();
    controller.abort();
    channel.cancel();
    tools.cancel();
    budget.cancel();
  };
  const events = (async function* () {
    const work = drive(
      spec,
      deps,
      controller,
      channel,
      tools,
      model,
      () => {
        settled = true;
      },
      operation,
    );
    try {
      yield* channel.events();
    } finally {
      cancel();
      // An early-returning consumer still owns physical cancellation and cleanup.
      await work;
    }
  })();
  return {
    events,
    accept: (token) => channel.accept(token),
    answer: (id, decision) => tools.answer(id, decision),
    answerBudget: (id, decision) => budget.answer(id, decision),
    steer: () => model.steer(),
    cancel,
  };
}

/**
 * A branch is the same driver with exact resolved authority and native limits.
 * Session allocates its identity, consumes/accepts its events into branch facts,
 * and owns background lifetime and durable interaction answers. No second log.
 */
export function startNestedTurn(
  request: NestedRunRequest,
  options: { readonly turnId: TurnSpec['turnId']; readonly deps: TurnDeps },
): TurnHandle {
  if (request.budget.kind === 'adopted') throw new Error('Direct branches require a native budget');
  for (const limit of [request.budget.maxModelCalls, request.budget.maxToolCalls]) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError('Native branch limits must be nonnegative integers');
  }
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
  )
    throw new RangeError('Native branch output token limit must be a positive integer');
  if (!options.deps.toolContext) throw new Error('A branch requires an authorized workspace and settings');
  const names = new Set(request.toolNames);
  if (
    names.size !== request.toolNames.length ||
    names.has('goal_check') ||
    names.has('propose_goal') ||
    names.has('session_rollover')
  )
    throw new Error('Invalid child authority: duplicate or root-only tool');
  const registry = options.deps.tools;
  const tools = request.toolNames.map((name) => {
    const tool = registry?.get(name);
    if (!tool) throw new Error(`Unknown child tool: ${name}`);
    return tool;
  });
  const scoped: ToolRegistry = {
    get: (name) => (names.has(name) ? registry?.get(name) : undefined),
    available: () => tools,
  };
  const prepare = options.deps.prepareRequest;
  return startTurn(
    {
      turnId: options.turnId,
      history: [],
      newItems: request.items,
      instructions: request.instructions,
      model: request.model,
      tools: tools.map((tool) => tool.spec),
      ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      limits: { maxModelCalls: request.budget.maxModelCalls, maxToolCalls: request.budget.maxToolCalls },
    },
    {
      ...options.deps,
      tools: scoped,
      // Root goal/memory preparation may not expand resolved child authority.
      ...(prepare
        ? {
            prepareRequest: async (input, context) => {
              const surface = await prepare(input, context);
              if (surface.request.tools.some((tool) => !names.has(tool.name)))
                throw new Error('Request preparation expanded child authority');
              const selected = surface.tools ?? scoped;
              return {
                request: surface.request,
                tools: {
                  get: (name: string) => (names.has(name) ? selected.get(name) : undefined),
                  available: (seed) => selected.available(seed).filter((tool) => names.has(tool.spec.name)),
                },
              };
            },
          }
        : {}),
    },
  );
}

async function drive(
  spec: TurnSpec,
  deps: TurnDeps,
  controller: AbortController,
  events: TurnEvents,
  tools: TurnTools,
  model: TurnModel,
  settled: () => void,
  operation: 'conversation' | 'compaction',
): Promise<void> {
  const { signal } = controller;
  let result: TurnResult = { kind: 'completed' };
  const history = [...spec.history, ...spec.newItems];
  let reminderOrdinal = 0;
  try {
    if (operation === 'compaction') result = { kind: 'completed', compaction: await model.compact(history) };
    while (operation === 'conversation' && !signal.aborted && !tools.stopped) {
      const calls = await model.run(history);
      if (calls.length > 0) {
        await tools.run(calls, history);
        if (tools.exhausted) throw new NativeBudgetExhausted('Native child tool-call budget exhausted');
        if (tools.stopped) break;
        // A goal_check receipt is a tool result, not the model's final answer.
        // Let the model consume it before applying normal-stop policy, as for other tools.
        continue;
      }
      const decision = await deps.normalStop?.({ turnId: spec.turnId, signal });
      if (signal.aborted) throw cancelled();
      if (!decision || decision.action === 'stop') {
        if (decision?.terminalCause)
          result = {
            kind: 'interrupted',
            terminalCause: decision.terminalCause,
            ...(decision.notice !== undefined ? { notice: decision.notice } : {}),
          };
        else if (decision?.notice !== undefined) result = { kind: 'completed', notice: decision.notice };
        break;
      }
      if (!decision.reminder) throw new Error('Normal-stop continuation requires a reminder');
      const item: Item = {
        type: 'summary',
        id: `${spec.turnId}:normal-stop:${++reminderOrdinal}` as ItemId,
        // Legacy admits every harness stop reminder as a user message with this prefix.
        text: `[Mode Notice] ${decision.reminder}`,
        replaces: [],
      };
      await events.publish({ type: 'item', item });
      history.push(item);
    }
    if (signal.aborted) result = { kind: 'cancelled' };
  } catch (error) {
    result = signal.aborted
      ? { kind: 'cancelled' }
      : error instanceof NativeBudgetExhausted
      ? { kind: 'interrupted', terminalCause: 'budget_exhausted', notice: error.message }
      : { kind: 'failed', error: toModelError(error) };
    model.clear();
    controller.abort();
    events.cancel();
  } finally {
    if (signal.aborted || result.kind !== 'completed') model.clear();
    // Release before cleanup: a tool may own a still-gated child it must join.
    deps.onTurnBoundary?.({ turnId: spec.turnId, kind: 'ended' });
    // Session cannot go idle while root/scripted descendants still have bodies.
    tools.cancel();
    await tools.cleanup();
    settled();
    events.finish(result);
  }
}
