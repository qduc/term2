import { Worker } from 'node:worker_threads';
import type { AgentRuntime } from '../agent-runtime.js';
import type { AgentConfig, RunResult } from '../types.js';
import { createWorkflowSandbox } from './workflow-sandbox.js';
import {
  DEFAULT_WORKFLOW_LIMITS,
  isJsonValue,
  type JsonValue,
  type WorkflowAgentConfig,
  type WorkflowError,
  type WorkflowEvaluator,
  type WorkflowInput,
  type WorkflowLimits,
  type WorkflowResult,
  type WorkflowRunInput,
  type WorkflowRunSummary,
} from './workflow-types.js';

const WORKFLOW_READ_ONLY_TOOLS = new Set(['read_file', 'grep', 'glob', 'read_code_outline', 'code_context_search']);

export interface WorkflowEvaluatorDeps {
  runtime: Pick<AgentRuntime, 'agent'>;
  parentTools: readonly string[];
  limits?: Partial<WorkflowLimits>;
  /** Allows callers/tests to report captured workflow console output without exposing it to code. */
  onConsole?: (values: JsonValue[]) => void;
  workerFactory?: (code: string, syncTimeoutMs: number) => Worker;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkflowEvaluatorImpl implements WorkflowEvaluator {
  readonly #deps: WorkflowEvaluatorDeps;
  readonly #limits: WorkflowLimits;

  constructor(deps: WorkflowEvaluatorDeps) {
    this.#deps = deps;
    this.#limits = { ...DEFAULT_WORKFLOW_LIMITS, ...deps.limits };
  }

  async evaluate(input: WorkflowInput): Promise<WorkflowResult> {
    const runs: WorkflowRunSummary[] = [];
    if (typeof input.code !== 'string') return this.#failure('runtime_error', 'Workflow code must be a string', runs);
    if (Buffer.byteLength(input.code, 'utf8') > this.#limits.maxCodeBytes) {
      return this.#failure('code_too_large', 'Workflow code exceeds the configured size limit', runs);
    }

    let worker: Worker;
    try {
      worker =
        this.#deps.workerFactory?.(input.code, this.#limits.timeoutMs) ??
        createWorkflowSandbox(input.code, this.#limits.timeoutMs);
    } catch (error) {
      return this.#failure('sandbox_unavailable', `Workflow sandbox is unavailable: ${safeMessage(error)}`, runs);
    }

    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
      failFromParentAbort?.();
    };
    let failFromParentAbort: (() => void) | undefined;
    let admissions = 0;
    let active = 0;
    const waiting: Array<() => void> = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      active--;
      waiting.shift()?.();
    };
    const acquire = async (): Promise<void> => {
      if (active < this.#limits.maxConcurrency) {
        active++;
        return;
      }
      await new Promise<void>((resolve) =>
        waiting.push(() => {
          active++;
          resolve();
        }),
      );
    };

    const result = await new Promise<WorkflowResult>((resolve) => {
      const finish = (value: WorkflowResult) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (code: WorkflowError['code'], message: string) => finish(this.#failure(code, message, runs));
      const timeout = () => {
        controller.abort();
        fail('timeout', 'Workflow exceeded its configured timeout');
      };
      failFromParentAbort = () => fail('timeout', 'Workflow was cancelled by its parent');
      timer = setTimeout(timeout, this.#limits.timeoutMs);
      if (input.signal?.aborted) {
        onAbort();
      }
      input.signal?.addEventListener('abort', onAbort, { once: true });

      worker.on('message', async (message: any) => {
        if (settled) return;
        if (message?.type === 'console.log') {
          this.#deps.onConsole?.(message.values ?? []);
          return;
        }
        if (message?.type === 'workflow.complete') {
          if (!isJsonValue(message.output) || bytes(message.output) > this.#limits.maxOutputBytes) {
            fail('invalid_output', 'Workflow output must be JSON-safe and within the configured size limit');
          } else finish({ ok: true, output: message.output, runs });
          return;
        }
        if (message?.type === 'workflow.error') {
          const errorMessage = safeMessage(message.error?.message ?? 'Workflow failed');
          fail(
            message.syntax ? 'syntax_error' : /timed out/i.test(errorMessage) ? 'timeout' : 'runtime_error',
            errorMessage,
          );
          return;
        }
        if (message?.type === 'agent.run') {
          const request = this.#validateRequest(message.config, message.input);
          if ('error' in request) {
            if (request.error.code === 'approval_required') fail('approval_required', request.error.message);
            else
              worker.postMessage({
                type: 'agent.result',
                requestId: message.requestId,
                result: { ok: false, error: request.error },
              });
            return;
          }
          admissions++;
          if (admissions > this.#limits.maxRuns) {
            fail('limit_exceeded', 'Workflow exceeded its maximum number of agent runs');
            return;
          }
          await acquire();
          if (settled) {
            release();
            return;
          }
          const started = Date.now();
          try {
            const handle = this.#deps.runtime.agent(request.config);
            const child = await handle.run({
              ...request.input,
              context: request.input.context as Record<string, unknown> | undefined,
              signal: controller.signal,
            });
            const normalized = this.#normalizeRun(child);
            runs.push({
              name: request.config.name,
              ok: normalized.ok,
              durationMs: Date.now() - started,
              usage: normalized.usage,
              errorCode: normalized.errorCode,
            });
            worker.postMessage({ type: 'agent.result', requestId: message.requestId, result: normalized.result });
          } catch (error) {
            const messageText = safeMessage(error);
            runs.push({
              name: request.config.name,
              ok: false,
              durationMs: Date.now() - started,
              errorCode: 'agent_error',
            });
            worker.postMessage({
              type: 'agent.result',
              requestId: message.requestId,
              result: { ok: false, error: { code: 'agent_error', message: messageText } },
            });
          } finally {
            release();
          }
        }
      });
      worker.once('error', (error) => fail('sandbox_unavailable', `Workflow sandbox failed: ${safeMessage(error)}`));
      worker.once('exit', (code) => {
        if (!settled) fail('sandbox_unavailable', `Workflow sandbox exited unexpectedly (${code})`);
      });
    });

    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    await worker.terminate().catch(() => undefined);
    return result;
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
    for (const tool of requested) {
      if (!this.#deps.parentTools.includes(tool))
        return { error: { code: 'permission_denied', message: `Tool '${tool}' is not available to the parent agent` } };
      if (!WORKFLOW_READ_ONLY_TOOLS.has(tool))
        return {
          error: {
            code: 'approval_required',
            message: `Tool '${tool}' requires approval or is not permitted in workflows`,
          },
        };
    }
    if ((input as WorkflowRunInput).context !== undefined && !isJsonValue((input as WorkflowRunInput).context))
      return { error: { code: 'agent_error', message: 'Workflow run context must be JSON-safe' } };
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
      input: input as WorkflowRunInput,
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

  #failure(code: WorkflowError['code'], message: string, runs: WorkflowRunSummary[]): WorkflowResult {
    return { ok: false, error: { code, message }, runs };
  }
}
