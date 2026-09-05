import { appendFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import type { ExecutionContext } from '../../../services/execution-context.js';
import { z } from 'zod';
import { relaxedNumber } from '../../utils.js';
import { normalizeToolParameters } from '../../../lib/tool-invoke.js';
import { SandboxedCodeHostImpl } from '../../../services/sandboxed-code-host/sandboxed-code-host.js';
import type {
  CapabilityHandler,
  CapabilityOutcome,
  JsonValue,
} from '../../../services/sandboxed-code-host/host-types.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { ToolInvocationContext } from '../../../services/agent-runtime/tool-invocation-context.js';
import type { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import type { NestedApprovalOwner } from '../../../services/approval/nested-approval-owner.js';
import { applyApprovalGrant } from '../../../services/approval/approval-grant-executor.js';
import {
  isZodToolParameterSchema,
  type AnyToolDefinition,
  type FormatCommandMessage,
  type SchemaToolDefinition,
  type ToolRegistry,
} from '../../types.js';
import { createBaseMessage, getCallIdFromItem, getOutputText, normalizeToolArguments } from '../../format-helpers.js';
import { WORKFLOW_PROHIBITED_TOOLS } from '../../../services/agent-runtime/workflow/workflow-evaluator.js';
import { renderToolsHeader } from './tools-header.js';
import { resolveWorkspacePath, resolveWorkspacePathPhysically } from '../../utils.js';
import { resolveOutsideWorkspaceEdit } from '../../../services/approval/approval-descriptor.js';
import { parseUpstreamApplyPatch } from '../../file/upstream-apply-patch.js';

export const TOOL_NAME_RUN_CODE = 'run_code';
export const TOOL_NAME_DESCRIBE = 'describe';

const DEFAULT_TIMEOUT_MS = 120_000;
/** Node `setTimeout` wraps delays above `2**31-1` to ~1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_OUTPUT_CHARS = 30_000;
let nextBridgeRunId = 0;

const createBridgeRunId = (): string => `run_code_bridge_${++nextBridgeRunId}`;

/**
 * Script-shaped limits. They are deliberately not the workflow's: a workflow
 * spawns a handful of agents, while a script's whole point is looping over many
 * cheap tool calls.
 */
export const RUN_CODE_LIMITS = {
  /** Total `tools.*` calls one script may make. */
  maxCalls: 200,
  /** Parallel-safe calls that may overlap; others take a serial lane of one. */
  maxConcurrency: 8,
  /** Per-result cap. A larger result is truncated with an explicit marker. */
  maxResultChars: 100_000,
  maxCodeBytes: 65_536,
  maxOutputBytes: 262_144,
  maxConsoleBytes: 262_144,
} as const;

/**
 * Tools a script may never call.
 *
 * `run_code` excludes itself because each run owns its own call budget, and
 * nesting would let one run spend many. The rest are the workflow's prohibited
 * set: `run_subagent` in particular spawns agents outside any run budget, so a
 * script could loop on it indefinitely. Shell tools are excluded because their
 * complete approval state also lives in the interactive batch coordinator.
 */
export const RUN_CODE_PROHIBITED_TOOLS: ReadonlySet<string> = new Set([
  ...WORKFLOW_PROHIBITED_TOOLS,
  TOOL_NAME_RUN_CODE,
  'ask_mentor',
  'session_rollover',
  // Shell approval also depends on coordinator-owned Docker/session state that
  // the raw policy registry cannot express for an out-of-band script call.
  'shell',
  'bash',
  'enter_worktree',
  'exit_worktree',
]);

export const runCodeParametersSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'JavaScript (not TypeScript) executed as the body of an async function. Top-level await is available. ' +
        'Return the value you want the model to receive. Use console.log only for debugging.',
    ),
  include_console: z
    .boolean()
    .optional()
    .describe('Include console.log debugging trace in the successful result. Defaults to false.'),
  // Non-positive is rejected because `setTimeout(fn, 0)` fires promptly; it
  // does not disable the timer. Values above 2**31-1 wrap to ~1 ms in Node.
  timeout_ms: relaxedNumber
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Wall-clock limit for the script. Defaults to ${DEFAULT_TIMEOUT_MS}.`),
  description: z.string().optional().describe('One short line describing what the script does, shown to the user.'),
});

export type RunCodeParams = z.infer<typeof runCodeParametersSchema>;

const RUN_CODE_DESCRIPTION =
  'Write a JavaScript program and execute it. Return the value you want the model to receive; that completion value is ' +
  'the result of the run. Most tools you already have are available inside the script as ' +
  "`tools.<tool_name>(params)`, returning a promise that resolves to that tool's normal result and rejecting when " +
  'the call fails, so you can try/catch it. Parameters are exactly the parameters documented for that tool; they are ' +
  'validated against the real schema before the tool runs. Prefer this over many separate tool calls when the work ' +
  'is a loop, a fan-out over many files, or a multi-step computation whose intermediate values you do not need to ' +
  'see. `console.log` is a debugging trace: it is suppressed on successful runs unless you set `include_console: true`, ' +
  'but it is included when the script fails or times out. The code runs in an isolated ' +
  'context with no filesystem, network, timers, require, or eval: `tools.*` is the only way out. Auto-approved tools ' +
  'run immediately. Tools that require user approval present the existing approval prompt and resume this script after ' +
  'a decision; denial is catchable. Some tools are structurally unavailable inside scripts; those remain direct tools.';

/** One `tools.*` call observed during a run, for the user-facing summary. */
export interface RunCodeCallRecord {
  tool: string;
  outcome:
    | 'ok'
    | 'error'
    | 'approval_required'
    | 'unknown_policy'
    | 'policy_error'
    | 'interceptor_denied'
    | 'unknown_tool'
    | 'invalid_params'
    | 'prohibited';
  durationMs: number;
  directlyCallable?: boolean;
}

export interface CreateRunCodeToolOptions {
  loggingService: ILoggingService;
  /**
   * Resolves the tools exposed to the script. Supplying it directly is a test
   * seam; in production {@link bindRunCodeRegistry} installs the wrapped
   * registry, so scripts go through the same policy layer as a direct call.
   */
  getToolRegistry?: () => ToolRegistry;
  /** Policy authority used for out-of-band script calls. */
  approvalPolicyRegistry: ToolApprovalPolicyRegistry;
  getCwd?: () => string;
  executionContext?: ExecutionContext;
  nestedApprovalOwner?: NestedApprovalOwner;
  sessionAccess?: import('../../../services/session/session-access-state.js').SessionAccessState;
  nestedCompatibility?: import('../../../services/session/nested-tool-compatibility-state.js').NestedToolCompatibilityState;
}

/**
 * Marks a definition as accepting the final, wrapped tool registry.
 *
 * `run_code` is built in `agent.ts` from raw definitions, but the policy layer
 * (plan-mode interceptors, approval wrapping, post-execute hooks) is added
 * afterwards in `agent-factory.ts`. Handing the script the raw array would let
 * it reach an implementation the harness had deliberately wrapped, so the
 * registry is injected after wrapping instead.
 */
const REGISTRY_BINDER = Symbol.for('term2.run_code.bindRegistry');

type RegistryBindable = { [REGISTRY_BINDER]?: (registry: ToolRegistry) => void };
const NESTED_OWNER_BINDER = Symbol.for('term2.run_code.bindNestedApprovalOwner');
type NestedOwnerBindable = { [NESTED_OWNER_BINDER]?: (owner: NestedApprovalOwner, graph: object) => void };

/** Installs the wrapped registry into any `run_code` definition in `tools`. */
export function bindRunCodeRegistry(tools: ToolRegistry): void {
  for (const tool of tools) {
    (tool as RegistryBindable)[REGISTRY_BINDER]?.(tools);
  }
}

export function bindRunCodeNestedApprovalOwner(tools: ToolRegistry, owner: NestedApprovalOwner): void {
  for (const tool of tools) {
    (tool as AnyToolDefinition as NestedOwnerBindable)[NESTED_OWNER_BINDER]?.(owner, tools);
  }
}

/**
 * Direct calls are the tools a script structurally cannot reach, including
 * `run_code` itself. Visibility does not depend on `canRequireApproval`.
 */
export function isDirectlyCallable(tool: Pick<AnyToolDefinition, 'name'>): boolean {
  return RUN_CODE_PROHIBITED_TOOLS.has(tool.name);
}

function unknownToolMessage(name: string, registry: ToolRegistry): string {
  return `Unknown tool "${name}". Available: ${registry.map((entry) => entry.name).join(', ')}`;
}

function describeTool(tool: AnyToolDefinition): JsonValue {
  let parameters: JsonValue;
  if (isZodToolParameterSchema(tool.parameters)) {
    try {
      parameters = z.toJSONSchema(tool.parameters, { io: 'input' }) as JsonValue;
    } catch {
      parameters = {};
    }
  } else {
    parameters = tool.parameters as JsonValue;
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters,
  } as JsonValue;
}

const summarizeCalls = (calls: readonly RunCodeCallRecord[]): string => {
  if (calls.length === 0) return 'no tool calls';
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
  const parts = [...counts.entries()].map(([tool, count]) => (count > 1 ? `${tool}×${count}` : tool));
  return `${calls.length} tool call${calls.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
};

const clip = (text: string): string => {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const marker = `\n[truncated: output exceeded ${MAX_OUTPUT_CHARS} characters]`;
  return `${text.slice(0, Math.max(0, MAX_OUTPUT_CHARS - marker.length))}${marker}`;
};

const FAILURE_PREFIXES = [
  'Error:',
  'Script failed',
  'Script timed out',
  'Script was cancelled',
  'Script exceeded its deadline',
];

/**
 * Truncation is a display concern, but a script may branch on the result, so
 * the marker has to be unmistakable rather than a silent cut.
 */
const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated: result exceeded ${limit} characters]`;

const serializeResult = (result: unknown, limit: number): JsonValue => {
  if (typeof result === 'string') return truncate(result, limit);
  try {
    const encoded = JSON.stringify(result);
    if (encoded === undefined) return null;
    return encoded.length <= limit ? (result as JsonValue) : truncate(encoded, limit);
  } catch {
    return truncate(String(result), limit);
  }
};

/** Renders one console.log's arguments the way a terminal would. */
const renderConsoleValues = (values: JsonValue[]): string =>
  values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ');

export const formatRunCodeCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
  const description = typeof args?.description === 'string' ? args.description : undefined;
  const code = typeof args?.code === 'string' ? args.code : '';
  const output = getOutputText(item) || 'No output';

  return [
    createBaseMessage(item, index, 0, false, {
      command: description ? `run_code — ${description}` : 'run_code',
      output,
      success: !FAILURE_PREFIXES.some((prefix) => output.startsWith(prefix)),
      toolName: TOOL_NAME_RUN_CODE,
      toolArgs: { ...args, code },
    }),
  ];
};

type NestedCallOutcome = 'success' | 'failure' | 'denied-by-approval';

function getConversationSessionId(context: unknown): string | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const runContext = (context as { context?: unknown }).context;
  if (!runContext || typeof runContext !== 'object') return undefined;
  const sessionId = (runContext as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function writeNestedCallRecord(tool: string, sessionId: string | undefined, outcome: NestedCallOutcome): void {
  const logPath = process.env.TERM2_NESTED_CALL_LOG;
  if (!logPath || !sessionId) return;
  try {
    appendFileSync(
      logPath,
      `${JSON.stringify({ tool, sessionId, timestamp: new Date().toISOString(), outcome })}\n`,
      'utf8',
    );
  } catch {
    // Experiment-only logging must never affect tool execution.
  }
}

interface PreparedCall {
  tool: AnyToolDefinition;
  params: unknown;
  originalParams: unknown;
  authorityRoot: string;
  authorityMeaning: string;
  parallelSafe: boolean;
  started: number;
}

export function createRunCodeToolDefinition(
  options: CreateRunCodeToolOptions,
): SchemaToolDefinition<typeof runCodeParametersSchema> {
  const { loggingService, getCwd = () => options.executionContext?.getCwd() || process.cwd() } = options;
  const approvalRegistry = options.approvalPolicyRegistry;

  // Set by bindRunCodeRegistry once the policy layer has wrapped every tool.
  let boundRegistry: ToolRegistry | undefined;
  let nestedApprovalOwner = options.nestedApprovalOwner;
  const exposedTools = (): ToolRegistry =>
    (options.getToolRegistry?.() ?? boundRegistry ?? []).filter((tool) => !RUN_CODE_PROHIBITED_TOOLS.has(tool.name));

  const definition: SchemaToolDefinition<typeof runCodeParametersSchema> = {
    name: TOOL_NAME_RUN_CODE,
    // Read late, after bindRunCodeRegistry, so the model is told which tools
    // the script can actually reach rather than a guess made before wrapping.
    get description() {
      const header = renderToolsHeader(exposedTools());
      return header ? `${RUN_CODE_DESCRIPTION}\n\n${header}` : RUN_CODE_DESCRIPTION;
    },
    parameters: runCodeParametersSchema,
    effect: 'mutating',
    needsApproval: () => false,
    execute: async (params, context) => {
      const { code, timeout_ms, description, include_console = false } = params;
      const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const callerSignal = (context as ToolInvocationContext | undefined)?.signal;
      const registry = exposedTools();
      const bridgeRunId = createBridgeRunId();
      const calls: RunCodeCallRecord[] = [];
      const output: string[] = [];
      const sessionId = getConversationSessionId(context);

      const record = (
        tool: string,
        outcome: RunCodeCallRecord['outcome'],
        started: number,
        directlyCallable?: boolean,
      ) => {
        calls.push({ tool, outcome, durationMs: Date.now() - started, directlyCallable });
        writeNestedCallRecord(
          tool,
          sessionId,
          outcome === 'ok' ? 'success' : outcome === 'approval_required' ? 'denied-by-approval' : 'failure',
        );
      };
      const failed = (message: string): CapabilityOutcome => ({
        kind: 'result',
        result: { ok: false, error: message } as JsonValue,
      });

      const tools: CapabilityHandler<PreparedCall> = {
        binding: {
          name: 'tools',
          kind: 'namespace',
          members: [...new Set([...registry.map((tool) => tool.name), TOOL_NAME_DESCRIBE])],
        },
        limits: {
          maxCalls: RUN_CODE_LIMITS.maxCalls,
          maxConcurrency: RUN_CODE_LIMITS.maxConcurrency,
          limitExceededMessage: `Tool call limit reached (${RUN_CODE_LIMITS.maxCalls} calls per script run).`,
        },
        // A budget-exhausted call is the script's problem, not a reason to
        // discard the work it has already printed.
        overBudget: () => failed(`Tool call limit reached (${RUN_CODE_LIMITS.maxCalls} calls per script run).`),
        prepare: async (payload) => {
          const started = Date.now();
          const name = typeof payload.member === 'string' ? payload.member : '';
          const tool = registry.find((candidate) => candidate.name === name);
          if (name === TOOL_NAME_DESCRIBE && typeof payload.params === 'string') {
            const described = registry.find((candidate) => candidate.name === payload.params);
            if (!described) return failed(unknownToolMessage(payload.params, registry));
            return {
              kind: 'result',
              result: { ok: true, result: describeTool(described) } as JsonValue,
            };
          }
          if (!tool) {
            record(name || '(unnamed)', 'unknown_tool', started);
            return failed(unknownToolMessage(name, registry));
          }

          let normalized: unknown;
          try {
            normalized = normalizeToolParameters(payload.params ?? {}, tool.parameters);
          } catch {
            normalized = payload.params ?? {};
          }
          if (isZodToolParameterSchema(tool.parameters)) {
            const parsed = tool.parameters.safeParse(normalized);
            if (!parsed.success) {
              record(name, 'invalid_params', started);
              const issues = parsed.error.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; ');
              return failed(`Invalid parameters for "${name}": ${issues}`);
            }
            normalized = parsed.data;
          }

          const authorityRoot = getCwd();
          const authority = await bindPreparedAuthority(name, normalized, authorityRoot, options.executionContext);
          if (authority.kind === 'denied') {
            record(name, 'approval_required', started, isDirectlyCallable(tool));
            return failed(authority.message);
          }
          return {
            tool,
            params: authority.params,
            originalParams: normalized,
            authorityRoot,
            authorityMeaning: fingerprint(authority),
            parallelSafe: await isParallelSafe(tool, normalized, context),
            started,
          };
        },
        // Mirrors the run loop: only a definition that declares itself
        // parallel-safe may overlap another call, because tools such as
        // enter_worktree mutate shared execution context.
        lane: (prepared) => (prepared.parallelSafe ? 'default' : 'serial'),
        invoke: async (prepared, callContext): Promise<CapabilityOutcome> => {
          const decision = await approvalRegistry.evaluate({
            toolName: prepared.tool.name,
            args: prepared.params,
            context,
          });
          if (decision.kind !== 'auto_approve') {
            if (decision.kind === 'prompt' && nestedApprovalOwner) {
              const nestedCallId = bridgeRunId + ':' + callContext.callId;
              const nestedContext = withAbortSignal(context, mergeAbortSignals(callerSignal, callContext.signal), {
                scripted: true,
              }) as ToolInvocationContext;
              tools.onWaiting?.(callContext);
              try {
                const resolution = await nestedApprovalOwner.request({
                  requestId: nestedCallId,
                  sessionId: sessionId ?? 'unknown',
                  graphIdentity: boundRegistry ?? registry,
                  outerRunId: bridgeRunId,
                  nestedCallId,
                  toolName: prepared.tool.name,
                  preparedArguments: prepared.params,
                  authorityContext: context,
                  approval: {
                    agentName: 'Nested run_code',
                    toolName: prepared.tool.name,
                    argumentsText: JSON.stringify(prepared.params),
                    rawInterruption: null,
                    callId: nestedCallId,
                    outsideWorkspaceEdit: resolveOutsideWorkspaceEdit(
                      prepared.tool.name,
                      prepared.params,
                      prepared.authorityRoot,
                    ),
                  },
                  signal: nestedContext.signal as AbortSignal,
                  revalidateAuthority: async () => {
                    const currentRoot = getCwd();
                    const authority = await bindPreparedAuthority(
                      prepared.tool.name,
                      prepared.originalParams,
                      currentRoot,
                      options.executionContext,
                    );
                    return (
                      authority.kind === 'bound' &&
                      currentRoot === prepared.authorityRoot &&
                      fingerprint(authority) === prepared.authorityMeaning
                    );
                  },
                  revalidate: async () => {
                    const latest = await approvalRegistry.evaluate({
                      toolName: prepared.tool.name,
                      args: prepared.params,
                      context,
                    });
                    return latest.kind;
                  },
                  grant: (nestedDecision) => {
                    if (callContext.signal.aborted) throw new Error('Tool execution was not approved.');
                    const applied = applyApprovalGrant(
                      {
                        sessionId: sessionId ?? 'unknown',
                        sessionAccess: options.sessionAccess,
                        nestedCompatibility: options.nestedCompatibility,
                        logger: loggingService,
                      },
                      {
                        answer: nestedDecision.answer,
                        toolName: prepared.tool.name,
                        rawArguments: prepared.params,
                        callId: nestedCallId,
                      },
                    );
                    if (!applied.isApproved) throw new Error('Tool execution was not approved.');
                  },
                  dispatch: async () =>
                    prepared.tool.execute(prepared.params, nestedContext, { toolCall: { callId: nestedCallId } }),
                });
                if (resolution.kind === 'approved') {
                  record(prepared.tool.name, 'ok', prepared.started);
                  return {
                    kind: 'result',
                    result: {
                      ok: true,
                      result: serializeResult(resolution.result, RUN_CODE_LIMITS.maxResultChars),
                    } as JsonValue,
                  };
                }
                if (resolution.kind === 'failed') {
                  record(prepared.tool.name, 'error', prepared.started);
                  return failed(
                    resolution.error instanceof Error ? resolution.error.message : String(resolution.error),
                  );
                }
                record(prepared.tool.name, 'approval_required', prepared.started, isDirectlyCallable(prepared.tool));
                return failed(resolution.message);
              } finally {
                tools.onResumed?.(callContext);
              }
            }
            const outcome =
              decision.kind === 'unknown'
                ? 'unknown_policy'
                : decision.kind === 'error'
                ? 'policy_error'
                : decision.kind === 'interceptor_denied'
                ? 'interceptor_denied'
                : 'approval_required';
            const directlyCallable = isDirectlyCallable(prepared.tool);
            record(prepared.tool.name, outcome, prepared.started, directlyCallable);
            return failed(
              decision.kind === 'unknown'
                ? `"${prepared.tool.name}" has no registered approval policy and is unavailable from inside a script.`
                : decision.kind === 'interceptor_denied'
                ? `"${prepared.tool.name}" was refused by an approval interceptor and is unavailable from inside a script.`
                : decision.kind === 'error'
                ? `"${prepared.tool.name}" approval policy failed and is unavailable from inside a script.`
                : `"${prepared.tool.name}" requires approval and is unavailable from inside a script.`,
            );
          }

          const started = Date.now();
          const callId = `${bridgeRunId}:${callContext.callId}`;
          try {
            // Marks the call as originating inside a script: the result goes to the
            // script, not into model context, so context-protection caps do not apply.
            const nestedContext = withAbortSignal(context, mergeAbortSignals(callerSignal, callContext.signal), {
              scripted: true,
            });
            const result = await prepared.tool.execute(prepared.params, nestedContext, { toolCall: { callId } });
            record(prepared.tool.name, 'ok', started);
            return {
              kind: 'result',
              result: { ok: true, result: serializeResult(result, RUN_CODE_LIMITS.maxResultChars) } as JsonValue,
            };
          } catch (error) {
            record(prepared.tool.name, 'error', started);
            return failed(error instanceof Error ? error.message : String(error));
          }
        },
      };

      loggingService.debug('run_code execution started', {
        cwd: getCwd(),
        timeout,
        exposedTools: registry.length,
        description,
      });

      const result = await new SandboxedCodeHostImpl().run({
        code,
        capabilities: { tools },
        limits: {
          timeoutMs: timeout,
          maxCodeBytes: RUN_CODE_LIMITS.maxCodeBytes,
          maxOutputBytes: RUN_CODE_LIMITS.maxOutputBytes,
          maxConsoleBytes: RUN_CODE_LIMITS.maxConsoleBytes,
        },
        subject: 'Script',
        allowVoidOutput: true,
        signal: callerSignal,
        onConsole: (values) => output.push(renderConsoleValues(values)),
      });

      loggingService.debug('run_code execution finished', {
        ok: result.ok,
        toolCalls: calls.length,
      });

      return renderResult(result, output, calls, include_console);
    },
    formatCommandMessage: formatRunCodeCommandMessage,
  };

  (definition as AnyToolDefinition as RegistryBindable)[REGISTRY_BINDER] = (registry) => {
    boundRegistry = registry;
  };
  (definition as AnyToolDefinition as NestedOwnerBindable)[NESTED_OWNER_BINDER] = (owner, graph) => {
    nestedApprovalOwner = owner;
    // The factory binds run_code before hiding non-direct definitions. Use the
    // complete bound graph as identity, not the later filtered model surface.
    owner.bindGraph(boundRegistry ?? graph);
  };

  return definition;
}

const PATH_TOOLS = new Set([
  'read_file',
  'create_file',
  'search_replace',
  'apply_patch',
  'grep',
  'glob',
  'read_code_outline',
  'code_context_search',
]);

type BoundAuthority = { kind: 'bound'; physicalRoot: string; params: unknown } | { kind: 'denied'; message: string };

type PathSemantics = 'referent' | 'unlink-source';

async function bindPreparedAuthority(
  toolName: string,
  params: unknown,
  cwd: string,
  executionContext?: ExecutionContext,
): Promise<BoundAuthority> {
  const isRemote = executionContext?.isRemote() ?? false;
  if (isRemote && PATH_TOOLS.has(toolName)) {
    return { kind: 'denied', message: 'Cannot establish remote physical path authority for a nested tool call.' };
  }
  try {
    const physicalRoot = isRemote ? cwd : await requirePhysicalPath(cwd, cwd);
    return { kind: 'bound', physicalRoot, params: await bindPreparedArguments(toolName, params, cwd) };
  } catch (error) {
    return {
      kind: 'denied',
      message: `Cannot establish physical path authority: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function requirePhysicalPath(value: string, cwd: string, semantics: PathSemantics = 'referent'): Promise<string> {
  const physicalPath = await resolveWorkspacePathPhysically(value, cwd);
  if (physicalPath === undefined) throw new Error(`Unresolved path: ${value}`);
  if (semantics === 'unlink-source') {
    // Move sources are both read and unlinked. Following a leaf symlink would
    // preserve the read but delete its referent; reject rather than change meaning.
    const lexicalPath = resolveWorkspacePath(value, cwd, { allowOutsideWorkspace: true });
    const stats = await lstat(lexicalPath);
    if (stats.isSymbolicLink()) throw new Error(`Symlink unlink source is unsupported: ${value}`);
  }
  return physicalPath;
}

async function bindPreparedArguments(toolName: string, params: unknown, cwd: string): Promise<unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params) || !PATH_TOOLS.has(toolName)) return params;
  const record = params as Record<string, unknown>;
  const bindPath = async (value: unknown, semantics: PathSemantics = 'referent'): Promise<unknown> =>
    typeof value === 'string' ? requirePhysicalPath(value, cwd, semantics) : value;
  if (toolName === 'apply_patch' && typeof record.patch === 'string') {
    return { ...record, patch: await bindPatchPaths(record.patch, bindPath) };
  }
  return 'path' in record ? { ...record, path: await bindPath(record.path) } : params;
}

async function bindPatchPaths(
  patch: string,
  bindPath: (value: unknown, semantics: PathSemantics) => Promise<unknown>,
): Promise<string> {
  let parsed;
  try {
    parsed = parseUpstreamApplyPatch(patch);
  } catch {
    return patch;
  }

  const targets = parsed.operations.flatMap((operation) => {
    const moveTo = 'moveTo' in operation ? operation.moveTo : undefined;
    const semantics: PathSemantics = operation.type === 'delete_file' || moveTo ? 'unlink-source' : 'referent';
    return [{ path: operation.path, semantics }, ...(moveTo ? [{ path: moveTo, semantics: 'referent' as const }] : [])];
  });
  let targetIndex = 0;
  const lines = patch.replace(/\r\n?/g, '\n').split('\n');
  const prefixes = ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: '];
  for (let index = 0; index < lines.length; index += 1) {
    const prefix = prefixes.find((candidate) => lines[index].startsWith(candidate));
    if (!prefix) continue;
    const target = targets[targetIndex++];
    const bound = await bindPath(target.path, target.semantics);
    lines[index] = prefix + String(bound);
  }
  return lines.join('\n');
}

function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function withAbortSignal(context: unknown, signal: AbortSignal, extra: Record<string, unknown> = {}): unknown {
  return context && typeof context === 'object'
    ? { ...(context as Record<string, unknown>), signal, ...extra }
    : { signal, ...extra };
}

function mergeAbortSignals(callerSignal: AbortSignal | undefined, hostSignal: AbortSignal): AbortSignal {
  if (!callerSignal || callerSignal === hostSignal) return callerSignal ?? hostSignal;

  const controller = new AbortController();
  const abort = () => {
    callerSignal.removeEventListener('abort', abort);
    hostSignal.removeEventListener('abort', abort);
    controller.abort();
  };

  if (callerSignal.aborted || hostSignal.aborted) {
    controller.abort();
    return controller.signal;
  }
  callerSignal.addEventListener('abort', abort, { once: true });
  hostSignal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

async function isParallelSafe(tool: AnyToolDefinition, params: unknown, context: unknown): Promise<boolean> {
  const declared = tool.parallelSafe;
  if (declared === undefined || declared === false) return false;
  if (declared === true) return true;
  try {
    return (await (declared as (p: unknown, c?: unknown) => boolean | Promise<boolean>)(params, context)) === true;
  } catch {
    return false;
  }
}

function renderResult(
  result: { ok: boolean; output?: JsonValue; voidOutput?: boolean; error?: { code: string; message: string } },
  output: readonly string[],
  calls: readonly RunCodeCallRecord[],
  includeConsole: boolean,
): string {
  const sections: string[] = [];
  if (!result.ok && result.error) {
    sections.push(
      result.error.code === 'timeout'
        ? `Script timed out. ${result.error.message}`
        : result.error.code === 'deadline'
        ? `Script exceeded its deadline. ${result.error.message}`
        : result.error.code === 'cancelled'
        ? `Script was cancelled. ${result.error.message}`
        : `Script failed: ${result.error.message}`,
    );
  } else if (result.voidOutput === true) {
    sections.push('Script returned no result. Return a value from the script to send it to the model.');
  } else {
    const rendered = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    sections.push(`Result:\n${rendered}`);
  }

  const printed = output.join('\n').trim();
  if (printed && (!result.ok || includeConsole)) sections.push(`Console trace (debug):\n${printed}`);

  const refused = calls.filter((call) => call.outcome === 'approval_required');
  const directlyRefused = refused.filter((call) => call.directlyCallable === true);
  const indirectlyRefused = refused.filter((call) => call.directlyCallable === false);
  if (directlyRefused.length > 0 || indirectlyRefused.length > 0) {
    const names = [...new Set([...directlyRefused, ...indirectlyRefused].map((call) => call.tool))].join(', ');
    sections.push(`Refused (needs user approval and could not be completed from inside this script): ${names}`);
  }
  const policyFailures = calls.filter(
    (call) => call.outcome === 'policy_error' || call.outcome === 'interceptor_denied',
  );
  if (policyFailures.length > 0) {
    const names = [...new Set(policyFailures.map((call) => call.tool))].join(', ');
    sections.push(`Unavailable (approval policy refused or failed; no user approval was requested): ${names}`);
  }
  const unknownPolicy = calls.filter((call) => call.outcome === 'unknown_policy');
  const directlyUnknown = unknownPolicy.filter((call) => call.directlyCallable === true);
  const indirectlyUnknown = unknownPolicy.filter((call) => call.directlyCallable === false);
  if (directlyUnknown.length > 0 || indirectlyUnknown.length > 0) {
    const names = [...new Set([...directlyUnknown, ...indirectlyUnknown].map((call) => call.tool))].join(', ');
    sections.push(`Unavailable (no registered approval policy): ${names}`);
  }
  sections.push(`[${summarizeCalls(calls)}]`);

  return clip(sections.join('\n\n'));
}
