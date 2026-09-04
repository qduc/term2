import type { Worker } from 'node:worker_threads';
import type { AgentRuntime } from '../agent-runtime.js';
import type { AgentConfig, RunResult } from '../types.js';
import { SandboxedCodeHostImpl } from '../../sandboxed-code-host/sandboxed-code-host.js';
import type { CapabilityHandler, CapabilityOutcome } from '../../sandboxed-code-host/host-types.js';
import {
  DEFAULT_WORKFLOW_LIMITS,
  isJsonValue,
  type JsonValue,
  type WorkflowAgentConfig,
  type WorkflowEvaluator,
  type WorkflowInput,
  type WorkflowLimits,
  type WorkflowResult,
  type WorkflowRunInput,
  type WorkflowRunSummary,
} from './workflow-types.js';

// Models differ in how they inspect a workspace: GPT-family models generally
// use shell, while others use dedicated file/search tools. These interfaces
// represent the same delegated read capability; shell mutation is still
// blocked by the child runtime's command-level tool policy.
const WORKFLOW_READ_INTERFACES = new Set([
  'shell',
  'read_file',
  'grep',
  'glob',
  'read_code_outline',
  'code_context_search',
]);
const WORKFLOW_EDITOR_TOOLS = new Set(['apply_patch', 'search_replace', 'create_file']);
const WORKFLOW_WEB_TOOLS = new Set(['web_search', 'web_fetch']);
export const WORKFLOW_PROHIBITED_TOOLS = new Set(['ask_user', 'run_subagent', 'run_agent_workflow']);

export interface WorkflowEvaluatorDeps {
  runtime: Pick<AgentRuntime, 'agent'>;
  parentTools: readonly string[];
  limits?: Partial<WorkflowLimits>;
  /** Allows callers/tests to report captured workflow console output without exposing it to code. */
  onConsole?: (values: JsonValue[]) => void;
  workerFactory?: (code: string, syncTimeoutMs: number) => Worker;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value);
}

function isOutputTransport(value: unknown): boolean {
  if (!isJsonObject(value) || !isJsonObject(value.schema)) return false;
  return value.name === undefined || typeof value.name === 'string';
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PreparedRun {
  config: AgentConfig;
  input: WorkflowRunInput;
  requestedName?: string;
}

/**
 * The `agent` capability of the shared sandboxed code host: it validates a run
 * request against the parent's capabilities, spawns the child agent, and keeps
 * the admission-ordered run log the tool reports.
 */
export class WorkflowEvaluatorImpl implements WorkflowEvaluator {
  readonly #deps: WorkflowEvaluatorDeps;
  readonly #limits: WorkflowLimits;

  constructor(deps: WorkflowEvaluatorDeps) {
    this.#deps = deps;
    this.#limits = { ...DEFAULT_WORKFLOW_LIMITS, ...deps.limits };
  }

  async evaluate(input: WorkflowInput): Promise<WorkflowResult> {
    const runs: WorkflowRunSummary[] = [];
    const agent: CapabilityHandler<PreparedRun> = {
      binding: { name: 'agent', kind: 'factory' },
      limits: {
        maxCalls: this.#limits.maxRuns,
        maxConcurrency: this.#limits.maxConcurrency,
        onLimitExceeded: 'fail-run',
        limitExceededMessage: 'Workflow exceeded its maximum number of agent runs',
      },
      prepare: (payload) => {
        const request = this.#validateRequest(payload.config, payload.input);
        if ('error' in request) {
          if (request.error.code === 'approval_required')
            return { kind: 'fail', code: 'approval_required', message: request.error.message };
          return { kind: 'result', result: { ok: false, error: request.error } as JsonValue };
        }
        return { ...request, requestedName: request.config.name };
      },
      onAdmitted: (prepared, { callId }) => {
        runs[callId - 1] = {
          runId: callId,
          requestedName: prepared.requestedName,
          name: prepared.requestedName,
          ok: false,
          durationMs: 0,
          errorCode: 'cancelled',
        };
      },
      invoke: async (prepared, { callId, signal }): Promise<CapabilityOutcome> => {
        const started = Date.now();
        try {
          const handle = this.#deps.runtime.agent(prepared.config);
          const child = await handle.run({ ...prepared.input, signal });
          const normalized = this.#normalizeRun(child);
          const resolved = handle as Partial<typeof handle>;
          runs[callId - 1] = {
            runId: callId,
            requestedName: prepared.requestedName,
            name: resolved.name ?? prepared.requestedName,
            ...(resolved.model ? { provider: resolved.model.provider, model: resolved.model.model } : {}),
            ok: normalized.ok,
            durationMs: Date.now() - started,
            usage: normalized.usage,
            errorCode: normalized.errorCode,
          };
          return { kind: 'result', result: normalized.result };
        } catch (error) {
          const messageText = safeMessage(error);
          runs[callId - 1] = {
            runId: callId,
            requestedName: prepared.requestedName,
            name: prepared.requestedName,
            ok: false,
            durationMs: Date.now() - started,
            errorCode: 'agent_error',
          };
          return {
            kind: 'result',
            result: { ok: false, error: { code: 'agent_error', message: messageText } } as JsonValue,
          };
        }
      },
    };

    const result = await new SandboxedCodeHostImpl().run({
      code: input.code,
      capabilities: { agent },
      limits: {
        timeoutMs: this.#limits.timeoutMs,
        maxCodeBytes: this.#limits.maxCodeBytes,
        maxOutputBytes: this.#limits.maxOutputBytes,
        maxConsoleBytes: this.#limits.maxConsoleBytes,
      },
      subject: 'Workflow',
      signal: input.signal,
      onConsole: this.#deps.onConsole,
      workerFactory: this.#deps.workerFactory,
    });

    return result.ok ? { ok: true, output: result.output, runs } : { ok: false, error: result.error, runs };
  }

  #validateRequest(
    config: unknown,
    input: unknown,
  ): { config: AgentConfig; input: WorkflowRunInput } | { error: { code: string; message: string } } {
    if (
      !config ||
      typeof config !== 'object' ||
      typeof (config as WorkflowAgentConfig).instructions !== 'string' ||
      ((config as WorkflowAgentConfig).name !== undefined &&
        typeof (config as WorkflowAgentConfig).name !== 'string') ||
      ((config as WorkflowAgentConfig).model !== undefined &&
        !['lower', 'default', 'higher'].includes((config as WorkflowAgentConfig).model as string)) ||
      !(input && typeof input === 'object') ||
      typeof (input as WorkflowRunInput).task !== 'string'
    )
      return { error: { code: 'agent_error', message: 'Invalid workflow agent configuration or run input' } };
    const raw = config as WorkflowAgentConfig;
    const requested = raw.tools ?? [];
    if (!Array.isArray(requested) || requested.some((tool) => typeof tool !== 'string'))
      return { error: { code: 'agent_error', message: 'Workflow tools must be strings' } };
    const parentCanReadWorkspace = this.#deps.parentTools.some((tool) => WORKFLOW_READ_INTERFACES.has(tool));
    const parentCanWriteWorkspace = this.#deps.parentTools.some((tool) => WORKFLOW_EDITOR_TOOLS.has(tool));
    for (const tool of requested) {
      if (WORKFLOW_READ_INTERFACES.has(tool)) {
        if (!parentCanReadWorkspace)
          return {
            error: { code: 'permission_denied', message: `Tool '${tool}' requires parent workspace read access` },
          };
        continue;
      }
      if (WORKFLOW_EDITOR_TOOLS.has(tool)) {
        if (!parentCanWriteWorkspace)
          return {
            error: { code: 'permission_denied', message: `Tool '${tool}' requires parent workspace write access` },
          };
        continue;
      }
      if (WORKFLOW_WEB_TOOLS.has(tool)) {
        if (!this.#deps.parentTools.includes(tool))
          return {
            error: { code: 'permission_denied', message: `Tool '${tool}' is not available to the parent agent` },
          };
        continue;
      }
      if (WORKFLOW_PROHIBITED_TOOLS.has(tool))
        return { error: { code: 'approval_required', message: `Tool '${tool}' is not permitted in workflows` } };
      return {
        error: {
          code: 'approval_required',
          message: `Tool '${tool}' requires approval or is not permitted in workflows`,
        },
      };
    }
    const runInput = input as Record<string, unknown>;
    if (runInput.context !== undefined && !isJsonObject(runInput.context))
      return { error: { code: 'agent_error', message: 'Workflow run context must be a JSON-safe object' } };
    if (runInput.output !== undefined && !isOutputTransport(runInput.output))
      return { error: { code: 'agent_error', message: 'Workflow output format must be JSON-safe transport data' } };
    return {
      config: {
        name: raw.name,
        instructions: raw.instructions,
        // Workflow runtimes are rooted at the existing subagent bridge rather
        // than at the interactive agent, so relative policies have no runtime
        // parent. Resolve the public relative tiers to the configured tiers.
        model: raw.model === 'lower' ? 'efficient' : raw.model === 'higher' ? 'capable' : undefined,
        tools: requested,
        permissions: { tools: requested },
      },
      input: {
        task: runInput.task as string,
        ...(runInput.context === undefined ? {} : { context: runInput.context as Record<string, JsonValue> }),
        ...(runInput.output === undefined ? {} : { output: runInput.output as WorkflowRunInput['output'] }),
      },
    };
  }

  #normalizeRun(run: RunResult<any>) {
    if (run.status === 'completed' && isJsonValue(run.output)) {
      const result: any = { ok: true, output: run.output };
      if (run.usage !== undefined) result.usage = run.usage;
      return { ok: true, usage: run.usage, result, errorCode: undefined };
    }
    const code = run.error?.code ?? (run.status === 'cancelled' ? 'cancelled' : 'invalid_output');
    const result: any = {
      ok: false,
      error: { code, message: run.error?.message ?? 'Agent returned non-JSON-safe output' },
    };
    if (run.usage !== undefined) result.usage = run.usage;
    return { ok: false, usage: run.usage, errorCode: code, result };
  }
}
