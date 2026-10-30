import type { Item, ItemId, ToolCallId } from '../model/index.js';
import type { ToolContext, ToolResult } from '../tools/index.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  CreateEngine,
  EngineDeps,
  EngineEvent,
  TurnCheckpoint,
  TurnInput,
  TurnRun,
} from './index.js';

type PendingCall = TurnCheckpoint['pendingCalls'][number];

let nextId = 0;
const itemId = (): ItemId => `item_${Date.now().toString(36)}_e${(nextId++).toString(36)}` as ItemId;

/**
 * The turn loop: call the model, run the tool calls it asks for, repeat.
 *
 * Every step boundary emits a `checkpoint`. A tool that needs approval ends
 * the run as `suspended`; `resume` picks up from that checkpoint with the
 * decisions. Nothing here calls into a UI or writes storage.
 */
export const createEngine: CreateEngine = (deps) => ({
  start: (input) =>
    run(deps, { turnId: input.turnId, input, produced: [], pendingCalls: [], modelCalls: 0 }, new Map()),
  resume: (checkpoint, decisions) => run(deps, checkpoint, decisions),
});

function run(deps: EngineDeps, from: TurnCheckpoint, decisions: ReadonlyMap<ToolCallId, ApprovalDecision>): TurnRun {
  const controller = new AbortController();
  return {
    turnId: from.turnId,
    events: loop(deps, from, decisions, controller.signal),
    cancel: () => controller.abort(),
  };
}

async function* loop(
  deps: EngineDeps,
  from: TurnCheckpoint,
  decisions: ReadonlyMap<ToolCallId, ApprovalDecision>,
  signal: AbortSignal,
): AsyncGenerator<EngineEvent> {
  const { input } = from;
  const produced: Item[] = [...from.produced];
  let pending: PendingCall[] = [...from.pendingCalls];
  let modelCalls = from.modelCalls;
  let continuation = from.continuation;
  const checkpoint = (): TurnCheckpoint => ({
    turnId: input.turnId,
    input,
    produced: [...produced],
    pendingCalls: [...pending],
    modelCalls,
    ...(continuation === undefined ? {} : { continuation }),
  });

  while (true) {
    if (signal.aborted) return yield { type: 'turn_ended', outcome: { kind: 'cancelled' } };

    if (pending.length > 0) {
      const ask = await askFor(deps, input, pending, decisions, signal);
      if (signal.aborted) return yield { type: 'turn_ended', outcome: { kind: 'cancelled' } };
      if (ask.length > 0) {
        return yield { type: 'turn_ended', outcome: { kind: 'suspended', approvals: ask, checkpoint: checkpoint() } };
      }
      for (const call of [...pending]) {
        yield { type: 'tool_started', callId: call.callId, toolName: call.toolName, input: call.input };
        // Progress is buffered until the tool returns; live streaming needs a channel, not a generator.
        const progress: EngineEvent[] = [];
        const result = await executeCall(deps, input, call, decisions.get(call.callId), signal, (chunk) => {
          progress.push({ type: 'tool_progress', callId: call.callId, chunk });
        });
        if (signal.aborted) return yield { type: 'turn_ended', outcome: { kind: 'cancelled' } };
        yield* progress;
        yield { type: 'tool_finished', callId: call.callId, result };
        const item: Item = {
          type: 'tool_result',
          id: itemId(),
          callId: call.callId,
          output: result.output,
          isError: result.isError,
          ...(result.providerOutput ? { providerOutput: result.providerOutput } : {}),
        };
        produced.push(item);
        pending = pending.filter((candidate) => candidate.callId !== call.callId);
        yield { type: 'item', item };
        yield { type: 'checkpoint', checkpoint: checkpoint() };
      }
    }

    if (modelCalls >= input.budget.maxModelCalls) {
      return yield { type: 'turn_ended', outcome: { kind: 'budget_exhausted' } };
    }

    const model = deps.models.resolve(input.model);
    const tools = input.toolNames.flatMap((name) => {
      const tool = deps.tools.get(name);
      return tool ? [tool.spec] : [];
    });
    modelCalls += 1;
    try {
      for await (const event of model.stream(
        {
          model: input.model,
          instructions: input.instructions,
          input: [...input.history, ...input.newItems, ...produced],
          tools,
          ...(input.reasoning ? { reasoning: input.reasoning } : {}),
          ...(continuation === undefined ? {} : { continuation }),
        },
        signal,
      )) {
        switch (event.type) {
          case 'item':
            produced.push(event.item);
            if (event.item.type === 'tool_call') {
              pending.push({ callId: event.item.callId, toolName: event.item.toolName, input: event.item.input });
            }
            yield { type: 'item', item: event.item };
            break;
          case 'done':
            continuation = event.continuation;
            break;
          default:
            yield event;
        }
      }
    } catch (error) {
      if (signal.aborted) return yield { type: 'turn_ended', outcome: { kind: 'cancelled' } };
      const message = error instanceof Error ? error.message : String(error);
      return yield {
        type: 'turn_ended',
        outcome: { kind: 'failed', error: { kind: 'provider', message, retryable: false } },
      };
    }

    if (pending.length === 0) return yield { type: 'turn_ended', outcome: { kind: 'completed' } };
    yield { type: 'checkpoint', checkpoint: checkpoint() };
  }
}

function toolContext(deps: EngineDeps, input: TurnInput): Omit<ToolContext, 'signal' | 'progress'> {
  return { workspace: input.workspace, settings: deps.settings };
}

async function askFor(
  deps: EngineDeps,
  input: TurnInput,
  pending: readonly PendingCall[],
  decisions: ReadonlyMap<ToolCallId, ApprovalDecision>,
  signal: AbortSignal,
): Promise<ApprovalRequest[]> {
  const ctx = { ...toolContext(deps, input), signal, progress: () => {} };
  const requests: ApprovalRequest[] = [];
  for (const call of pending) {
    if (decisions.has(call.callId)) continue;
    const tool = deps.tools.get(call.toolName);
    if (!tool) continue;
    let requirement;
    try {
      requirement = await tool.approval(tool.parse(call.input), ctx);
    } catch {
      continue;
    }
    if (requirement.kind === 'ask') requests.push({ callId: call.callId, toolName: call.toolName, requirement });
  }
  return requests;
}

async function executeCall(
  deps: EngineDeps,
  input: TurnInput,
  call: PendingCall,
  decision: ApprovalDecision | undefined,
  signal: AbortSignal,
  progress: (chunk: string) => void,
): Promise<ToolResult> {
  const tool = deps.tools.get(call.toolName);
  if (!tool) return { output: `unknown tool "${call.toolName}"`, isError: true };
  if (decision?.kind === 'reject') {
    return { output: `the user rejected this call${decision.reason ? `: ${decision.reason}` : ''}`, isError: true };
  }
  const ctx: ToolContext = { ...toolContext(deps, input), signal, progress };
  try {
    const parsed = tool.parse(call.input);
    const requirement = await tool.approval(parsed, ctx);
    if (signal.aborted) return { output: 'Operation aborted', isError: true };
    if (requirement.kind === 'deny') return { output: `denied: ${requirement.reason}`, isError: true };
    return await tool.execute(parsed, ctx);
  } catch (error) {
    return { output: error instanceof Error ? error.message : String(error), isError: true };
  }
}
