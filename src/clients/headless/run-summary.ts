/** Run-level cost evidence for one headless run: the `run_summary` --json record.
 * Computed only from accepted wire events the run already receives; it never asks
 * the session for anything and never prices or estimates on its own.
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
type ToolEntry = { readonly turnId: string; readonly result: WireToolResult };
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

/** Total input as agent-core recorded it: prompt_tokens excludes cache writes, includes cache reads. */
function inputOf(record: ModelRequestCost): number | null {
  const usage = record.usage;
  if (usage?.prompt_tokens === undefined) return null;
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

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
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

function stringField(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** One accumulator per headless run. `observe` sees every event of the run's session, including
 * those that arrive between the run's turns (background subagent spend); `build` keeps only the
 * request trees rooted in a turn this run drove.
 */
export function createRunSummary() {
  const runTurns: string[] = [];
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
        tools.set(event.payload.executionId, { turnId, result: event.payload });
        break;
      case 'compaction_completed':
      case 'compaction_failed':
        for (const request of event.payload.requests) compactionRequests.add(request.requestId);
        break;
      default:
        break;
    }
  };

  return {
    observe(event: WireEvent, targetTurnId: string | null): void {
      if (targetTurnId !== null && !runTurns.includes(targetTurnId)) runTurns.push(targetTurnId);
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
          const branchTurn = payload.turnId ?? payload.event.turnId ?? undefined;
          if (branchTurn !== undefined && !agents.has(branchTurn))
            agents.set(branchTurn, {
              agentId: payload.agentId,
              ...(payload.role !== undefined ? { role: payload.role } : {}),
              ...((payload.rootTurnId ?? payload.parentTurnId) !== undefined
                ? { rootTurnId: payload.rootTurnId ?? payload.parentTurnId }
                : {}),
            });
          observeTurnEvent(payload.event, branchTurn);
          break;
        }
        default:
          observeTurnEvent(event, event.turnId);
          break;
      }
    },

    build(context: { readonly sessionId: string; readonly outcome: string }) {
      const inRun = (turnId: string | undefined): boolean => turnId !== undefined && runTurns.includes(turnId);
      const entries = [...costs.values()].filter((entry) => inRun(entry.rootTurnId) || inRun(entry.turnId));
      const agentOf = (turnId: string): string => (inRun(turnId) ? 'root' : agents.get(turnId)?.agentId ?? turnId);

      const totals = emptyTotals();
      for (const entry of entries) addTokens(totals, entry);

      const rootModel = entries.filter(
        (entry) => agentOf(entry.turnId) === 'root' && !compactionRequests.has(entry.record.requestId),
      );
      const rootInputs = rootModel.map((entry) => inputOf(entry.record));
      const afterFirst = emptyTotals();
      for (const entry of rootModel.slice(1)) addTokens(afterFirst, entry);
      const knownInputs = rootInputs.filter((value): value is number => value !== null);

      // Tool results of the run, in the order they settled.
      const runTools = [...tools.values()].filter(
        (tool) => inRun(tool.turnId) || inRun(agents.get(tool.turnId)?.rootTurnId),
      );
      const byName: Record<string, number> = {};
      let errors = 0;
      let invalidInput = 0;
      let unknownTool = 0;
      let repeatedReads = 0;
      let repeatedShellCommands = 0;
      const readPaths = new Set<string>();
      const commands = new Set<string>();
      const agentToolCalls = new Map<string, number>();
      for (const { turnId, result } of runTools) {
        const name = result.toolName ?? 'unknown';
        byName[name] = (byName[name] ?? 0) + 1;
        agentToolCalls.set(agentOf(turnId), (agentToolCalls.get(agentOf(turnId)) ?? 0) + 1);
        if (result.isError) {
          errors += 1;
          if (INVALID_INPUT_PREFIXES.some((prefix) => result.output.startsWith(prefix))) invalidInput += 1;
          else if (result.output.startsWith(UNKNOWN_TOOL_PREFIX)) unknownTool += 1;
        }
        if (name === 'read_file') {
          const raw = stringField(result.input, 'path');
          if (raw !== undefined) {
            const key = path.normalize(raw.trim());
            if (readPaths.has(key)) repeatedReads += 1;
            if (!result.isError) readPaths.add(key);
          }
        }
        if (name === 'shell') {
          const command = stringField(result.input, 'command');
          if (command !== undefined) {
            if (commands.has(command)) repeatedShellCommands += 1;
            commands.add(command);
          }
        }
      }

      // Per agent: root first, then subagents in first-request order.
      const groups = new Map<string, CostEntry[]>([['root', []]]);
      for (const entry of entries) {
        const key = agentOf(entry.turnId);
        groups.set(key, [...(groups.get(key) ?? []), entry]);
      }
      const agentRows = [...groups.entries()].map(([agentId, group]) => {
        const turn = group[0]?.turnId;
        const known = turn !== undefined ? agents.get(turn) : undefined;
        const task = roles.get(agentId);
        const role = agentId === 'root' ? null : task?.role ?? known?.role ?? null;
        const models = [
          ...new Map(group.map(({ record }) => [`${record.provider}\u0000${record.model}`, record])).values(),
        ].map(({ provider, model }) => ({ provider, model }));
        const tokens = emptyTotals();
        for (const entry of group) addTokens(tokens, entry);
        return {
          agent: agentId,
          role,
          ...(task?.mode !== undefined ? { mode: task.mode } : {}),
          models,
          requests: group.length,
          cost: costOf(group.map(({ record }) => record)),
          tokens,
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
        requests: {
          total: entries.length,
          completed: entries.filter(({ record }) => record.outcome === 'completed').length,
          failed: entries.filter(({ record }) => record.outcome === 'failed').length,
          cancelled: entries.filter(({ record }) => record.outcome === 'cancelled').length,
          compaction: entries.filter(({ record }) => compactionRequests.has(record.requestId)).length,
        },
        tokens: totals,
        cacheHitRatio: {
          overall: ratio(totals.cacheRead, totals.input),
          rootAfterFirst: ratio(afterFirst.cacheRead, afterFirst.input),
        },
        contextGrowth: {
          rootRequests: rootInputs.length,
          first: rootInputs[0] ?? null,
          last: rootInputs.at(-1) ?? null,
          max: knownInputs.length > 0 ? Math.max(...knownInputs) : null,
          ...(rootInputs.length <= CONTEXT_GROWTH_LIST_LIMIT ? { inputTokens: rootInputs } : {}),
        },
        agents: agentRows,
        tools: {
          calls: runTools.length,
          byName,
          errors,
          rejections: { invalidInput, unknownTool },
          repeatedReads,
          repeatedShellCommands,
        },
      };
    },
  };
}
