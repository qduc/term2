/** Run-level cost evidence for one headless run: the `run_summary` --json record.
 * Computed only from accepted wire events the run already receives; it never asks
 * the session for anything and never prices or estimates on its own. Callers must
 * keep it from affecting the run (see `output.ts`): it is measurement only.
 */
import path from 'node:path';
import type { ModelRequestCost } from '../../shared/cost/model-cost.js';
import { summarizeCost } from '../../shared/cost/model-cost.js';
import type { WireEvent, WireToolResult, WireUsage } from '../../protocol/wire.js';

/** A full per-request list stays readable on one line up to this many root requests; past it only the shape. */
const CONTEXT_GROWTH_LIST_LIMIT = 64;
/** Model-facing results the host writes when it refuses a call before running it.
 * Prefixes of `runToolInputDiagnostics` (tools/tool-invoke.ts) and agent-core's unknown-tool result. */
const INVALID_INPUT_PREFIXES = ['Tool input did not match schema for ', 'Tool input was invalid for this tool.'];
const UNKNOWN_TOOL_PREFIX = 'Unknown tool: ';

type CostEntry = {
  readonly turnId: string;
  readonly rootTurnId: string;
  readonly record: ModelRequestCost;
  /** Provider-reported reasoning for this request; undefined when not reported. */
  readonly reasoningTokens: number | undefined;
};
/** Only what the summary needs from a settled tool result; the output itself is not retained. */
type ToolEntry = {
  readonly turnId: string;
  readonly name: string;
  readonly isError: boolean;
  readonly rejection?: 'invalidInput' | 'unknownTool';
  /** read_file: normalized path and requested line range. */
  readonly read?: { readonly path: string; readonly range: string };
  /** shell: trimmed command string. */
  readonly command?: string;
};
type Agent = { readonly agentId: string; readonly role?: string; readonly rootTurnId?: string };

type TokenTotals = {
  input: number;
  fresh: number;
  cacheRead: number;
  cacheWrite: number | null;
  output: number;
  reasoning: number | null;
  requestsWithUsage: number;
  requestsWithReasoning: number;
};

function emptyTotals(): TokenTotals {
  return {
    input: 0,
    fresh: 0,
    cacheRead: 0,
    cacheWrite: null,
    output: 0,
    reasoning: null,
    requestsWithUsage: 0,
    requestsWithReasoning: 0,
  };
}

/** With no usage reported at all, every token dimension is unknown, not zero. */
function publicTotals(totals: TokenTotals) {
  const known = totals.requestsWithUsage > 0;
  return {
    input: known ? totals.input : null,
    fresh: known ? totals.fresh : null,
    cacheRead: known ? totals.cacheRead : null,
    cacheWrite: totals.cacheWrite,
    output: known ? totals.output : null,
    reasoning: totals.reasoning,
    requestsWithUsage: totals.requestsWithUsage,
    requestsWithReasoning: totals.requestsWithReasoning,
  };
}

/** Total input as agent-core recorded it: prompt_tokens excludes cache writes, includes cache reads. */
function inputOf(record: ModelRequestCost): number | null {
  const usage = record.usage;
  if (typeof usage?.prompt_tokens !== 'number') return null;
  return usage.prompt_tokens + (usage.cache_creation_tokens ?? 0);
}

function addTokens(totals: TokenTotals, entry: CostEntry): void {
  const usage = entry.record.usage;
  const input = inputOf(entry.record);
  if (usage === undefined || input === null) return;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_creation_tokens;
  totals.requestsWithUsage += 1;
  totals.input += input;
  totals.cacheRead += cacheRead;
  if (cacheWrite !== undefined) totals.cacheWrite = (totals.cacheWrite ?? 0) + cacheWrite;
  totals.fresh += input - cacheRead - (cacheWrite ?? 0);
  totals.output += usage.completion_tokens ?? 0;
  if (entry.reasoningTokens !== undefined) {
    totals.reasoning = (totals.reasoning ?? 0) + entry.reasoningTokens;
    totals.requestsWithReasoning += 1;
  }
}

function ratio(cacheRead: number, input: number): number | null {
  return input > 0 ? Number((cacheRead / input).toFixed(4)) : null;
}

function costOf(records: readonly ModelRequestCost[]) {
  const summary = summarizeCost(records);
  const known = summary.pricedRequests > 0;
  return {
    usd: known ? summary.knownUsdMicros / 1_000_000 : null,
    usdMicros: known ? summary.knownUsdMicros : null,
    state: summary.state,
    pricedRequests: summary.pricedRequests,
    unpricedRequests: summary.unpricedRequests,
  };
}

function field(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return (input as Record<string, unknown>)[key];
}

function toolEntry(turnId: string, result: WireToolResult): ToolEntry {
  const name = typeof result.toolName === 'string' ? result.toolName : 'unknown';
  const isError = result.isError === true;
  const output = typeof result.output === 'string' ? result.output : '';
  const rejection = !isError
    ? undefined
    : INVALID_INPUT_PREFIXES.some((prefix) => output.startsWith(prefix))
    ? ('invalidInput' as const)
    : output.startsWith(UNKNOWN_TOOL_PREFIX)
    ? ('unknownTool' as const)
    : undefined;
  const rawPath = name === 'read_file' ? field(result.input, 'path') : undefined;
  const command = name === 'shell' ? field(result.input, 'command') : undefined;
  return {
    turnId,
    name,
    isError,
    ...(rejection !== undefined ? { rejection } : {}),
    ...(typeof rawPath === 'string'
      ? {
          read: {
            path: path.normalize(rawPath.trim()),
            range: `${String(field(result.input, 'start_line') ?? '')}-${String(
              field(result.input, 'end_line') ?? '',
            )}`,
          },
        }
      : {}),
    ...(typeof command === 'string' ? { command: command.trim() } : {}),
  };
}

/** One accumulator per headless run. `observe` sees every event of the run's session, including
 * those that arrive between the run's turns (background subagent spend); `build` keeps only the
 * request trees rooted in a turn this run drove. Retained state is per request and per settled
 * tool call, never tool output.
 */
export function createRunSummary() {
  const runTurns = new Set<string>();
  const costs = new Map<string, CostEntry>();
  /** The accepted usage of each turn's in-flight request; its cost record follows it in the same turn. */
  const pendingUsage = new Map<string, WireUsage>();
  const compactionRequests = new Set<string>();
  const tools = new Map<string, ToolEntry>();
  const agents = new Map<string, Agent>();
  const roles = new Map<string, { role?: string; model?: { provider: string; model: string }; mode?: string }>();

  const observeTurnEvent = (event: WireEvent, turnId: string | null | undefined): void => {
    if (turnId === null || turnId === undefined) return;
    switch (event.type) {
      case 'usage':
        pendingUsage.set(turnId, event.payload.usage);
        break;
      case 'tool_finished':
        tools.set(event.payload.executionId, toolEntry(turnId, event.payload));
        break;
      case 'compaction_completed':
      case 'compaction_failed':
        for (const request of event.payload.requests ?? []) compactionRequests.add(request.requestId);
        break;
      default:
        break;
    }
  };

  return {
    observe(event: WireEvent, targetTurnId: string | null): void {
      if (targetTurnId !== null) runTurns.add(targetTurnId);
      switch (event.type) {
        case 'request_cost_recorded': {
          const { turnId, rootTurnId, record } = event.payload;
          const usage = pendingUsage.get(turnId);
          pendingUsage.delete(turnId);
          // Join only when the accepted usage is the one this record was computed from.
          const matches = usage !== undefined && record.usage?.completion_tokens === usage.outputTokens;
          costs.set(record.requestId, {
            turnId,
            rootTurnId,
            record,
            reasoningTokens: matches ? usage.reasoningTokens : undefined,
          });
          break;
        }
        case 'task_changed': {
          const task = event.payload.task;
          if (task.kind === 'subagent')
            roles.set(task.id, {
              ...(task.role !== undefined ? { role: task.role } : {}),
              ...(task.model !== undefined ? { model: task.model } : {}),
              ...(task.mode !== undefined ? { mode: task.mode } : {}),
            });
          break;
        }
        case 'subagent': {
          const payload = event.payload;
          const branchTurn = payload.turnId ?? payload.event?.turnId ?? undefined;
          if (branchTurn !== undefined && !agents.has(branchTurn))
            agents.set(branchTurn, {
              agentId: payload.agentId,
              ...(payload.role !== undefined ? { role: payload.role } : {}),
              ...((payload.rootTurnId ?? payload.parentTurnId) !== undefined
                ? { rootTurnId: payload.rootTurnId ?? payload.parentTurnId }
                : {}),
            });
          if (payload.event !== undefined) observeTurnEvent(payload.event, branchTurn);
          break;
        }
        default:
          observeTurnEvent(event, event.turnId);
          break;
      }
    },

    build(context: { readonly sessionId: string; readonly outcome: string }) {
      const inRun = (turnId: string | undefined): boolean => turnId !== undefined && runTurns.has(turnId);
      const agentOf = (turnId: string): string => (inRun(turnId) ? 'root' : agents.get(turnId)?.agentId ?? turnId);

      const entries: CostEntry[] = [];
      const totals = emptyTotals();
      const afterFirst = emptyTotals();
      const rootInputs: (number | null)[] = [];
      let maxInput: number | null = null;
      const requests = { total: 0, completed: 0, failed: 0, cancelled: 0, compaction: 0 };
      // Per agent: root first, then subagents in first-request order. Appended in place.
      const groups = new Map<string, CostEntry[]>([['root', []]]);
      for (const entry of costs.values()) {
        if (!inRun(entry.rootTurnId) && !inRun(entry.turnId)) continue;
        entries.push(entry);
        addTokens(totals, entry);
        requests.total += 1;
        if (entry.record.outcome === 'completed') requests.completed += 1;
        else if (entry.record.outcome === 'failed') requests.failed += 1;
        else if (entry.record.outcome === 'cancelled') requests.cancelled += 1;
        const compaction = compactionRequests.has(entry.record.requestId);
        if (compaction) requests.compaction += 1;
        const agent = agentOf(entry.turnId);
        let group = groups.get(agent);
        if (group === undefined) groups.set(agent, (group = []));
        group.push(entry);
        if (agent !== 'root' || compaction) continue;
        const input = inputOf(entry.record);
        if (rootInputs.length > 0) addTokens(afterFirst, entry);
        if (rootInputs.length < CONTEXT_GROWTH_LIST_LIMIT + 1) rootInputs.push(input);
        if (input !== null && (maxInput === null || input > maxInput)) maxInput = input;
      }
      let rootRequests = 0;
      let lastInput: number | null = null;
      for (const entry of groups.get('root') ?? []) {
        if (compactionRequests.has(entry.record.requestId)) continue;
        rootRequests += 1;
        lastInput = inputOf(entry.record);
      }

      // Tool results of the run, in the order they settled.
      const byName: Record<string, number> = {};
      let calls = 0;
      let errors = 0;
      let invalidInput = 0;
      let unknownTool = 0;
      let sameRange = 0;
      let otherRange = 0;
      let repeatedShellCommands = 0;
      /** Normalized path -> ranges already read successfully. */
      const readPaths = new Map<string, Set<string>>();
      const commands = new Set<string>();
      const agentToolCalls = new Map<string, number>();
      for (const tool of tools.values()) {
        if (!inRun(tool.turnId) && !inRun(agents.get(tool.turnId)?.rootTurnId)) continue;
        calls += 1;
        byName[tool.name] = (byName[tool.name] ?? 0) + 1;
        const agent = agentOf(tool.turnId);
        agentToolCalls.set(agent, (agentToolCalls.get(agent) ?? 0) + 1);
        if (tool.isError) errors += 1;
        if (tool.rejection === 'invalidInput') invalidInput += 1;
        if (tool.rejection === 'unknownTool') unknownTool += 1;
        if (tool.read !== undefined) {
          const ranges = readPaths.get(tool.read.path);
          if (ranges?.has(tool.read.range)) sameRange += 1;
          else if (ranges !== undefined) otherRange += 1;
          if (!tool.isError) {
            if (ranges === undefined) readPaths.set(tool.read.path, new Set([tool.read.range]));
            else ranges.add(tool.read.range);
          }
        }
        if (tool.command !== undefined) {
          if (commands.has(tool.command)) repeatedShellCommands += 1;
          commands.add(tool.command);
        }
      }

      const agentRows = [...groups.entries()].map(([agentId, group]) => {
        const turn = group[0]?.turnId;
        const known = turn !== undefined ? agents.get(turn) : undefined;
        const task = roles.get(agentId);
        const role = agentId === 'root' ? null : task?.role ?? known?.role ?? null;
        const models = new Map<string, { provider: string; model: string }>();
        const tokens = emptyTotals();
        for (const entry of group) {
          const { provider, model } = entry.record;
          models.set(`${provider}\u0000${model}`, { provider, model });
          addTokens(tokens, entry);
        }
        return {
          agent: agentId,
          role,
          ...(task?.mode !== undefined ? { mode: task.mode } : {}),
          models: [...models.values()],
          requests: group.length,
          cost: costOf(group.map(({ record }) => record)),
          tokens: publicTotals(tokens),
          toolCalls: agentToolCalls.get(agentId) ?? 0,
        };
      });

      return {
        type: 'run_summary' as const,
        version: 1 as const,
        sessionId: context.sessionId,
        outcome: context.outcome,
        turnIds: [...runTurns],
        cost: costOf(entries.map(({ record }) => record)),
        requests,
        tokens: publicTotals(totals),
        cacheHitRatio: {
          overall: ratio(totals.cacheRead, totals.input),
          rootAfterFirst: ratio(afterFirst.cacheRead, afterFirst.input),
        },
        contextGrowth: {
          rootRequests,
          first: rootInputs[0] ?? null,
          last: lastInput,
          max: maxInput,
          ...(rootRequests <= CONTEXT_GROWTH_LIST_LIMIT ? { inputTokens: rootInputs } : {}),
        },
        agents: agentRows,
        tools: {
          calls,
          byName,
          errors,
          rejections: { invalidInput, unknownTool },
          repeatedReads: { sameRange, otherRange },
          repeatedShellCommands,
        },
      };
    },
  };
}
