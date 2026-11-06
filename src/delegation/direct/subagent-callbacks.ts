/** Source delegation callbacks over admitted Session launch/task ports. No child
 * authority or lifecycle is created here; result/status presentation uses accepted
 * task snapshots and actual execution evidence supplied by the tool surface.
 */
import type { ResolvedAgentDefinition } from '../../engine/agent-runtime/resolved-agent.js';
import type { ResolvedSubagentLaunch } from '../runtime/subagent-bridge.js';
import type { AgentSpec } from '../../engine/agent-runtime/types.js';
import { SubagentPoolEntrySchema } from '../../config/settings/settings-schema.js';
import type {
  SubagentResult,
  SubagentRunHandle,
  SubagentRunStatus,
  SubagentCancelAcknowledgement,
  SubagentSteerAcknowledgement,
} from '../../tools/subagents/types.js';
import { buildDiffStat, truncateResultText } from '../subagents/execution-runner.js';
import type { ValidationCapture } from '../subagents/tool-policy.js';
import { buildTurnBudgetExhaustedFinalText, formatSubagentResult } from '../../tools/subagents/utils.js';
import type { Item } from '../../model/index.js';
import type { NestedRunResult, SubagentTaskState, ToolContext } from '../../tools/index.js';
import type { ISettingsService } from '../../shared/service-interfaces.js';

export type Launch = {
  role?: string;
  task?: string;
  agent_spec?: AgentSpec;
  name?: string;
  continue_run_id?: string;
  worktree?: string;
  authorizedWorktreePath?: string;
  mentorConsultation?: boolean;
  mentorModel?: { provider: string; model: string; reasoningEffort?: string };
  /** run_code's successful AgentSpec boundary definition; legacy launches it without resolving again. */
  resolvedDefinition?: ResolvedAgentDefinition;
};
export type ExecutionEvidence = {
  readonly filesChanged: readonly string[];
  readonly toolCounts: Map<string, number>;
  /** The child's turn budget, for legacy's budget-stop text. */
  readonly maxTurns?: number;
  readonly worktreePath?: string;
  /** A background child's diff and validation capture, as legacy's execution-runner keeps them. */
  readonly diffDeltas?: Map<string, { added: number; deleted: number }>;
  readonly validation?: ValidationCapture;
  /** The background result, settled once (its truncation saves one artifact). */
  settled?: Promise<SubagentResult>;
};
type DelegationCallbacks = {
  runSubagent(params: Launch): Promise<SubagentResult>;
  runSubagentAsync(params: Launch): Promise<SubagentRunHandle>;
  runResolvedSubagent(params: ResolvedSubagentLaunch): Promise<SubagentResult>;
  runResolvedSubagentAsync(params: ResolvedSubagentLaunch): Promise<SubagentRunHandle>;
  getSubagentResult(params: { runId: string }): Promise<SubagentResult>;
  getSubagentStatus(params: { runId?: string }): SubagentRunStatus | SubagentRunStatus[];
  cancelSubagentRun(params: { target: string }): SubagentCancelAcknowledgement;
  sendSubagentMessage(params: { target: string; message: string; reply_to?: string }): SubagentSteerAcknowledgement;
  createMentor(task: string): Promise<string>;
};

/** Bind the source callback shape to the current physical execution and Session
 * task controls. The parent owns scope lifetime, preparation and launch authority.
 */
export function createDirectDelegationCallbacks(
  settings: ISettingsService,
  ports: {
    readonly current: () => ToolContext;
    readonly run: (params: Launch) => Promise<SubagentResult>;
    readonly start: (params: Launch) => Promise<SubagentRunHandle>;
  },
  executionEvidence: ReadonlyMap<string, ExecutionEvidence>,
): DelegationCallbacks {
  const { current, run, start } = ports;
  const controls = () => {
    const context = current();
    if (!context.subagents) throw new Error('Session subagent controls are unavailable');
    return context.subagents;
  };
  const resolved = (params: ResolvedSubagentLaunch): Launch => {
    const value = params.resolvedDefinition;
    if (!('ok' in value) || !value.ok)
      throw new Error('Native script delegation requires a successful host AgentSpec boundary');
    return {
      agent_spec: value.spec,
      resolvedDefinition: value.definition,
      worktree: params.worktree ?? value.worktree,
      authorizedWorktreePath: params.authorizedWorktreePath ?? value.authorizedWorktreePath,
      name: params.name,
      continue_run_id: params.continue_run_id,
    };
  };
  const callbacks: DelegationCallbacks = {
    runSubagent: (params) => run(params),
    runSubagentAsync: start,
    runResolvedSubagent: (params) => run(resolved(params)),
    runResolvedSubagentAsync: (params) => start(resolved(params)),
    async createMentor(task) {
      const configured = SubagentPoolEntrySchema.array().parse(settings.get('agent.mentorPool'));
      // Same bounded sampling contract as the source mentor: a configured
      // pool defines consultations, otherwise mentorSamples repeats one model.
      const count = Math.max(1, Math.min(8, Math.floor(settings.get('agent.mentorSamples') ?? 1)));
      const models = configured.length ? configured.slice(0, 8) : Array.from({ length: count }, () => undefined);
      const results = await Promise.all(
        models.map((mentorModel) => run({ role: 'mentor', task, mentorModel, mentorConsultation: true })),
      );
      for (const result of results)
        if (result.status !== 'completed') throw new Error(result.error ?? `Mentor consultation ${result.status}`);
      return results.length === 1
        ? results[0]!.finalText
        : results.map((result, index) => `### Mentor ${index + 1}\n\n${result.finalText}`).join('\n\n');
    },
    getSubagentStatus(params) {
      const tasks = controls();
      return params.runId
        ? projectStatus(tasks.get(params.runId), params.runId, executionEvidence)
        : tasks.list().map((task) => projectStatus(task, task.taskId, executionEvidence));
    },
    async getSubagentResult({ runId }) {
      const context = current();
      const task = await controls().wait(runId, context.signal);
      if (!task) throw new Error(`Unknown subagent run: ${runId}`);
      if (!task.result) throw new Error(`Subagent run has no accepted terminal result: ${runId}`);
      const settled = executionEvidence.get(task.taskId)?.settled;
      if (settled) return settled;
      const result = task.result.value as NestedRunResult | undefined;
      if (result?.outcome && Array.isArray(result.items))
        return projectResult(
          { ...result, runId: task.taskId },
          task.role ?? 'agent',
          executionEvidence.get(task.taskId),
        );
      return projectResult(
        {
          runId: task.taskId,
          items: [],
          outcome:
            task.result.kind === 'failed'
              ? { kind: 'failed', error: task.result.error }
              : { kind: task.result.kind === 'cancelled' ? 'cancelled' : 'interrupted' },
        },
        task.role ?? 'agent',
        executionEvidence.get(task.taskId),
      );
    },
    cancelSubagentRun({ target }) {
      const tasks = controls();
      const task = tasks.get(target);
      if (!task) return { ok: false, code: 'not_active', target };
      const decision = tasks.cancel(task.taskId);
      return decision.ok
        ? { ok: true, runId: task.taskId, status: 'cancelling' }
        : { ok: false, code: 'not_active', target };
    },
    sendSubagentMessage({ target, message, reply_to }) {
      return controls().message(target, message, reply_to);
    },
  };
  return callbacks;
}

/** Project accepted outcomes and execution evidence, never requested calls or invented usage/diffs. */
export function projectResult(result: NestedRunResult, role: string, evidence?: ExecutionEvidence): SubagentResult {
  const runId = result.runId ?? (result.outcome.kind === 'background' ? result.outcome.runId : undefined);
  if (!runId) throw new Error('Session did not return an accepted subagent run ID');
  // Native distinct-name receipts are not counts. Keep only actual adapter
  // execution entries; missing telemetry must not become a fabricated count.
  const acceptedNames = result.toolsUsed === undefined ? undefined : new Set(result.toolsUsed);
  const tools = [...(evidence?.toolCounts ?? [])].filter(([name]) => !acceptedNames || acceptedNames.has(name));
  // Only runAsync returns an admission handle. Foreground and settled task
  // retrieval must never present a background receipt as a terminal result.
  if (result.outcome.kind === 'background')
    throw new Error('Expected a subagent result, received background admission');
  const status = result.outcome.kind === 'budget_exhausted' ? 'interrupted' : result.outcome.kind;
  // Legacy extractFinalText: the child's last assistant text.
  const lastText =
    result.items
      .filter((item): item is Extract<Item, { type: 'assistant_message' }> => item.type === 'assistant_message')
      .map((item) =>
        item.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
      )
      .filter((text) => text.length > 0)
      .at(-1) ?? '';
  const toolCalls = tools.reduce((total, [, count]) => total + count, 0);
  // Legacy nested-runner: a budget stop reports its partial text under the budget header, and a failure after
  // tool work is contained with the partial findings.
  const finalText =
    result.outcome.kind === 'budget_exhausted'
      ? buildTurnBudgetExhaustedFinalText({ maxTurns: evidence?.maxTurns, partialText: lastText })
      : result.outcome.kind === 'failed' && toolCalls > 0
      ? lastText
        ? `${lastText}\n\n[Subagent stopped due to error: ${result.outcome.error.message}]`
        : `[Subagent stopped due to error after ${toolCalls} tool action(s): ${result.outcome.error.message}]`
      : lastText;
  return {
    agentId: runId,
    role,
    status,
    finalText,
    ...(evidence?.worktreePath ? { worktreePath: evidence.worktreePath } : {}),
    filesChanged: [...new Set(evidence?.filesChanged ?? [])],
    toolsUsed: tools.map(([toolName, count]) => ({ toolName, count })),
    ...(result.outcome.kind === 'failed' ? { error: result.outcome.error.message } : {}),
    ...(result.outcome.kind === 'budget_exhausted' ? { terminalCause: 'budget_exhausted' as const } : {}),
    ...(result.outcome.kind === 'interrupted' && result.outcome.terminalCause !== undefined
      ? { terminalCause: result.outcome.terminalCause }
      : {}),
  };
}

/** Legacy execution-runner's background result: diff stat and validation evidence, the 40k final-text
 * cap, and no final text on an error. */
async function projectBackgroundResult(
  result: NestedRunResult,
  role: string,
  evidence: ExecutionEvidence,
): Promise<SubagentResult> {
  const projected = projectResult(result, role, evidence);
  const diffStat = buildDiffStat([...evidence.filesChanged], evidence.diffDeltas ?? new Map());
  const validation = evidence.validation?.value;
  return {
    ...projected,
    ...(projected.status === 'failed' ? { finalText: '' } : await truncateResultText(projected.finalText)),
    ...(diffStat.length > 0 ? { diffStat } : {}),
    ...(validation ? { validation } : {}),
  };
}

/** The completion notice's result text, legacy's formatSubagentResult over the settled background result. */
export function backgroundReport(role: string, evidence: ExecutionEvidence) {
  return async (result: NestedRunResult): Promise<string> =>
    formatSubagentResult(await (evidence.settled = projectBackgroundResult(result, role, evidence)));
}

/** Status is a Session snapshot, never a second tool-owned lifecycle projection. */
function projectStatus(
  task: SubagentTaskState | undefined,
  target: string,
  evidence: ReadonlyMap<string, ExecutionEvidence>,
): SubagentRunStatus {
  return {
    runId: task?.taskId ?? target,
    ...(task?.name ? { name: task.name } : {}),
    role: task?.role ?? 'agent',
    status: task?.status ?? 'not_found',
    // Source requires strings; unknown original input stays blank, never relabelled.
    task: task?.input ?? '',
    taskPreview: task?.input ?? '',
    startedAt: task?.startedAt ?? 0,
    elapsedMs: task ? Math.max(0, (task.completedAt ?? Date.now()) - task.startedAt) : 0,
    toolCounts: Object.fromEntries(evidence.get(task?.taskId ?? target)?.toolCounts ?? []),
    ...(task?.model ? { model: { provider: task.model.provider, id: task.model.model } } : {}),
    ...(task ? { lastActivityAt: task.lastActivityAt } : {}),
  };
}
