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
import { resolveOutsideWorkspaceEdit } from '../../../services/approval/approval-descriptor.js';
import {
  isZodToolParameterSchema,
  type AnyToolDefinition,
  type FormatCommandMessage,
  type SchemaToolDefinition,
  type ToolRegistry,
} from '../../types.js';
import {
  createBaseMessage,
  getCallIdFromItem,
  getOutputText,
  isSuccessOutput,
  normalizeToolArguments,
} from '../../format-helpers.js';
import { renderCompactSignature, renderToolsHeader } from './tools-header.js';
import {
  RUN_CODE_EXECUTION_RESULT,
  type RunCodeExecution,
  type RunCodeAttachment,
  type RunCodeDiagnosticCode,
  createRunCodeExecution,
} from './run-code-execution.js';
import { formatFullOutputSavedNote, saveOutputArtifact } from '../../../utils/shell/shell-output.js';
import { emitRunCodeCompletionTelemetry } from './run-code-telemetry.js';
import {
  ACTION_SEMANTICS,
  bindPreparedAuthority,
  clipReason,
  createMediaReferenceStore,
  describeTool,
  getConversationSessionId,
  isActionTool,
  isDirectlyCallable,
  isParallelSafe,
  mergeAbortSignals,
  RUN_CODE_LIMITS,
  RUN_CODE_PROHIBITED_TOOLS,
  serializeResult,
  TOOL_NAME_DESCRIBE,
  TOOL_NAME_RUN_CODE,
  withAbortSignal,
  writeNestedCallRecord,
  createRunCodeRuntime,
  type RunCodeActionOutcome,
  type RunCodeActionReceipt,
  type RunCodeCallRecord,
} from './run-code-runtime.js';
import { validateScriptedReturn } from '../../scripted-return-contract.js';

const createBridgeRunId = (() => {
  let next = 0;
  return () => `run_code_bridge_legacy_${++next}`;
})();

const unknownToolMessage = (name: string, registry: ToolRegistry): string =>
  `Unknown tool "${name}". Available: ${registry.map((entry) => entry.name).join(', ')}`;

const fingerprint = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export { RUN_CODE_EXECUTION_RESULT, getRunCodeExecutionResult } from './run-code-execution.js';
export {
  RUN_CODE_LIMITS,
  RUN_CODE_PROHIBITED_TOOLS,
  TOOL_NAME_DESCRIBE,
  TOOL_NAME_RUN_CODE,
  isDirectlyCallable,
} from './run-code-runtime.js';
export type { RunCodeActionOutcome, RunCodeActionReceipt, RunCodeCallRecord } from './run-code-runtime-contract.js';

const DEFAULT_TIMEOUT_MS = 120_000;
/** Node `setTimeout` wraps delays above `2**31-1` to ~1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_OUTPUT_CHARS = 30_000;

/**
 * Script-shaped limits. They are deliberately not the workflow's: a workflow
 * spawns a handful of agents, while a script's whole point is looping over many
 * cheap tool calls.
 */

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
  description: z.string().describe('One short line describing what the script does, shown to the user.'),
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
  'a decision; denial is catchable. Some tools are structurally unavailable inside scripts; those remain direct tools.\n\n' +
  `Each script may admit at most ${RUN_CODE_LIMITS.maxCalls} tools.* calls. Track progress and split large work into chunks; catch individual ` +
  'failures or use Promise.allSettled so you can return partial results. When the call budget is exhausted, the error ' +
  'reports calls admitted and calls remaining: return the partial results and start another run_code call only for ' +
  'unattempted work. Do not repeat completed tool effects. Return only the fields, line ranges, or summaries you need: ' +
  'model-visible output is limited to 30,000 characters, ' +
  'and larger host results can fail before rendering. For independent reads, preserve successful siblings with ' +
  '`Promise.allSettled`, mapping rejections to `{error: r.reason.message}` before returning. ' +
  'If the final result says `Full output saved to`, read that exact path with `read_file` rather than repeating completed calls; ' +
  'for a large artifact, use line ranges or a focused `grep` projection. A scripted `read_file` result may itself have ' +
  '`truncated: true` and a `fullOutputPath`; follow that path or narrow the projection before returning it. ' +
  'Use `tools.describe` before guessing parameters or returned fields. If a patch is scripted, escape backticks and ' +
  '${...} inside a template literal, or use ordinary quoted strings with escaped newlines. ' +
  'Example: `const r = await Promise.allSettled([tools.read_file({path:"a.ts"}), tools.read_file({path:"b.ts"})]); ' +
  'return r.map(x => x.status === "fulfilled" ? {content:(typeof x.value === "string" ? x.value : x.value.content).slice(0,2000)} : {error:x.reason.message});`';

export type RunCodeExecutionResult =
  | (string & { readonly [RUN_CODE_EXECUTION_RESULT]: RunCodeExecution })
  | (Array<RunCodeContentPart> & { readonly [RUN_CODE_EXECUTION_RESULT]: RunCodeExecution });

function attachRunCodeExecution(
  value: string | readonly RunCodeContentPart[],
  execution: RunCodeExecution,
): RunCodeExecutionResult {
  if (Array.isArray(value)) {
    const result = [...value] as RunCodeExecutionResult;
    Object.defineProperty(result, RUN_CODE_EXECUTION_RESULT, { value: execution });
    return result;
  }
  const result = new String(value) as RunCodeExecutionResult;
  Object.defineProperty(result, RUN_CODE_EXECUTION_RESULT, { value: execution });
  return result;
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

const summarizeCalls = (calls: readonly RunCodeCallRecord[]): string => {
  const describeCalls = calls.filter((call) => call.outcome === 'describe');
  const executionCalls = calls.filter((call) => call.outcome !== 'describe');
  let callSummary: string;
  if (executionCalls.length === 0) {
    callSummary = 'no tool calls';
  } else {
    const counts = new Map<string, number>();
    for (const call of executionCalls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
    const parts = [...counts.entries()].map(([tool, count]) => (count > 1 ? `${tool}×${count}` : tool));
    callSummary = `${executionCalls.length} tool call${executionCalls.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
  }
  if (describeCalls.length > 0) {
    return `${callSummary}; ${describeCalls.length} schema lookup${describeCalls.length === 1 ? '' : 's'}`;
  }
  return callSummary;
};

const clip = async (
  text: string,
  protectedAction?: { prefix: string; full: string; compact: string },
): Promise<string> => {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let retrieval: string;
  try {
    retrieval = formatFullOutputSavedNote(await saveOutputArtifact(text, { filenamePrefix: 'run-code' }));
  } catch {
    // Effects have already settled. A disk failure must not invite their replay.
    retrieval =
      'Full output could not be saved; the omitted text is unavailable. Do not repeat completed tool effects.';
  }
  const marker = `\n[truncated: output exceeded ${MAX_OUTPUT_CHARS} characters]\n${retrieval}`;
  // Preserve the lifecycle heading as well as host evidence. Script-authored
  // output may consume the entire budget; it must not hide action outcomes.
  const available = MAX_OUTPUT_CHARS - marker.length;
  const action = protectedAction
    ? `\n\n${protectedAction.full.length + 2 <= available - 64 ? protectedAction.full : protectedAction.compact}`
    : '';
  let prefix = (protectedAction?.prefix ?? text).slice(0, Math.max(0, available - action.length));
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}${action}`;
};

/** Compatibility-only reader for old persisted messages. New executions carry
 * a typed marker and never use rendered text for their success bit. */
const legacyRunCodeSuccess = (output: string): boolean => {
  if (/^(?:Error:|Script failed|Script timed out|Script was cancelled|Script exceeded its deadline)/.test(output)) {
    return false;
  }
  if (output.startsWith('Result:')) {
    const valueBlock = output.slice('Result:'.length).trimStart().split('\n\n')[0];
    return isSuccessOutput(valueBlock);
  }
  return true;
};

type RunCodeContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: unknown; detail?: unknown }
  | { type: 'file'; file: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isMediaContentPart = (value: unknown): value is RunCodeContentPart =>
  isRecord(value) && ((value.type === 'image' && 'image' in value) || (value.type === 'file' && 'file' in value));

const isContentPartArray = (value: unknown): value is Array<Record<string, unknown>> =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((part) => isRecord(part) && (part.type === 'text' || isMediaContentPart(part)));

/** Look through script wrappers without mistaking ordinary arrays for media. */
function containsMediaContent(value: unknown, ancestors = new Set<object>()): boolean {
  if (isMediaContentPart(value)) return true;
  if (!isRecord(value) && !Array.isArray(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const found = Array.isArray(value)
    ? value.some((entry) => containsMediaContent(entry, ancestors))
    : Object.values(value).some((entry) => containsMediaContent(entry, ancestors));
  ancestors.delete(value);
  return found;
}

/** Replace embedded media with a text marker while retaining the real parts. */
function stripMediaContent(value: unknown, media: RunCodeContentPart[]): unknown {
  if (isMediaContentPart(value)) {
    media.push(value);
    return value.type === 'image' ? '[image content attached]' : '[file content attached]';
  }
  if (Array.isArray(value)) return value.map((entry) => stripMediaContent(entry, media));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stripMediaContent(entry, media)]));
  }
  return value;
}

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
  const semantic = (item as import('../../format-helpers.js').ToolResultItem).runCodeExecution;

  return [
    createBaseMessage(item, index, 0, false, {
      command: description ? `run_code — ${description}` : 'run_code',
      output,
      success: semantic ? semantic.success : legacyRunCodeSuccess(output),
      toolName: TOOL_NAME_RUN_CODE,
      toolArgs: { ...args, code },
    }),
  ];
};

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
  const createRuntime = (registry: ToolRegistry) =>
    createRunCodeRuntime({
      registry,
      graphIdentity: boundRegistry ?? registry,
      loggingService,
      approvalPolicyRegistry: approvalRegistry,
      getCwd,
      executionContext: options.executionContext,
      nestedApprovalOwner,
      sessionAccess: options.sessionAccess,
      nestedCompatibility: options.nestedCompatibility,
    });

  const definition: SchemaToolDefinition<typeof runCodeParametersSchema> = {
    name: TOOL_NAME_RUN_CODE,
    // Read late, after bindRunCodeRegistry, so the model is told which tools
    // the script can actually reach rather than a guess made before wrapping.
    get description() {
      const header = renderToolsHeader(createRuntime(exposedTools()).discovery());
      return header ? `${RUN_CODE_DESCRIPTION}\n\n${header}` : RUN_CODE_DESCRIPTION;
    },
    parameters: runCodeParametersSchema,
    effect: 'mutating',
    needsApproval: () => false,
    execute: async (params, context, details) => {
      const { code, timeout_ms, description, include_console = false } = params;
      const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const callerSignal = (context as ToolInvocationContext | undefined)?.signal;
      const registry = exposedTools();
      // The runtime is the single owner of the nested-call lifecycle. The
      // definition remains responsible for model parameters and presentation;
      // in particular, it must not expose a partially wrapped registry.
      {
        const runtime = createRuntime(registry);
        const runtimeResult = await runtime.execute({
          code,
          timeout,
          description,
          context,
          signal: callerSignal,
        });
        const runtimeRendered = await renderResult(runtimeResult.execution, runtimeResult.output, include_console);
        const runtimeTransportCall =
          details && typeof details === 'object' && 'toolCall' in details && typeof details.toolCall === 'object';
        return runtimeTransportCall
          ? attachRunCodeExecution(runtimeRendered, runtimeResult.execution)
          : runtimeRendered;
      }

      /*
       * The pre-M6 inline lifecycle is intentionally unreachable. Keep this
       * compatibility text out of execution while the runtime remains the
       * sole owner of admission and settlement.
       */
      if (Reflect.get(globalThis, '__term2_legacy_run_code_path__') === true) {
        const bridgeRunId = createBridgeRunId();
        const startedAt = Date.now();
        const calls: RunCodeCallRecord[] = [];
        // Host-private action receipt ledger. Script code has no write path
        // here: every entry is recorded by prepare/admit/invoke settlement, so
        // a script cannot catch, relabel, or contradict an observed outcome.
        const receipts: RunCodeActionReceipt[] = [];
        const pendingReceiptByCallId = new Map<string, number>();
        const abortedCallIds = new Set<string>();
        let rejectedSeq = 0;
        const output: string[] = [];
        const consoleValues: JsonValue[][] = [];
        const sessionId = getConversationSessionId(context);
        const mediaReferences = createMediaReferenceStore();

        const record = (
          tool: string,
          outcome: RunCodeCallRecord['outcome'],
          started: number,
          directlyCallable?: boolean,
          callId?: string,
          diagnostic?: RunCodeDiagnosticCode,
        ) => {
          calls.push({
            tool,
            outcome,
            durationMs: Date.now() - started,
            directlyCallable,
            ...(callId ? { callId } : {}),
            ...(diagnostic ? { diagnostic } : {}),
          });
          if (outcome === 'describe') return;
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
        const recordReceipt = (
          callId: string,
          toolName: string,
          outcome: RunCodeActionOutcome,
          reason?: string,
        ): void => {
          if (abortedCallIds.has(callId)) return;
          const pendingIndex = pendingReceiptByCallId.get(callId);
          if (pendingIndex !== undefined) {
            receipts[pendingIndex] = {
              callId,
              tool: toolName,
              outcome,
              ...(reason ? { reason: clipReason(reason) } : {}),
            };
            pendingReceiptByCallId.delete(callId);
            return;
          }
          receipts.push({
            callId,
            tool: toolName,
            outcome,
            ...(reason ? { reason: clipReason(reason) } : {}),
          });
        };

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
          overBudget: ({ usedCalls, maxCalls }, rejected) => {
            // The host supplies the exact prepared call that was rejected.
            // Preparation is async and concurrent, so a local FIFO would be
            // unable to attribute a budget rejection safely.
            record(rejected.tool.name, 'unknown', rejected.started, undefined, undefined, 'call_budget');
            if (isActionTool(rejected.tool.name)) {
              rejectedSeq += 1;
              recordReceipt(
                `${bridgeRunId}:rejected-${rejectedSeq}`,
                rejected.tool.name,
                'unknown',
                'call budget exhausted before dispatch',
              );
            }
            return failed(
              `Tool call limit reached (${maxCalls} calls per script run; ${usedCalls} calls admitted, ${Math.max(
                0,
                maxCalls - usedCalls,
              )} remaining). ` +
                'Return the partial results you collected and start another run_code call only for unattempted work; ' +
                'Do not repeat completed tool effects.',
            );
          },
          onAdmitted: (prepared, callContext) => {
            if (!isActionTool(prepared.tool.name)) return;
            const callId = `${bridgeRunId}:${callContext.callId}`;
            pendingReceiptByCallId.set(callId, receipts.length);
            receipts.push({ callId, tool: prepared.tool.name, outcome: 'unknown' });
          },
          onAborted: (prepared, callContext, reason) => {
            const callId = `${bridgeRunId}:${callContext.callId}`;
            abortedCallIds.add(callId);
            record(prepared.tool.name, 'unknown', prepared.started, undefined, callId);
            if (isActionTool(prepared.tool.name)) {
              recordReceipt(callId, prepared.tool.name, 'unknown', reason);
            }
          },
          prepare: async (payload) => {
            const started = Date.now();
            const name = typeof payload.member === 'string' ? payload.member : '';
            const tool = registry.find((candidate) => candidate.name === name);
            if (name === TOOL_NAME_DESCRIBE && typeof payload.params === 'string') {
              const described = registry.find((candidate) => candidate.name === payload.params);
              if (!described) return failed(unknownToolMessage(payload.params, registry));
              record(name, 'describe', started);
              return {
                kind: 'result',
                result: { ok: true, result: describeTool(described) } as JsonValue,
              };
            }
            if (!tool) {
              record(name || '(unnamed)', 'unknown_tool', started, undefined, undefined, 'unknown_tool');
              if (isActionTool(name)) {
                rejectedSeq += 1;
                recordReceipt(
                  `${bridgeRunId}:rejected-${rejectedSeq}`,
                  name,
                  'failed',
                  unknownToolMessage(name, registry),
                );
              }
              return failed(unknownToolMessage(name, registry));
            }

            const targetSchema = tool.canonicalParameters ?? tool.parameters;
            let normalized: unknown;
            try {
              normalized = normalizeToolParameters(payload.params ?? {}, targetSchema);
            } catch {
              normalized = payload.params ?? {};
            }
            if (isZodToolParameterSchema(targetSchema)) {
              const parsed = targetSchema.safeParse(normalized);
              if (!parsed.success) {
                record(name, 'invalid_params', started, undefined, undefined, 'invalid_nested_input');
                const issues = parsed.error.issues
                  .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                  .join('; ');
                if (isActionTool(name)) {
                  rejectedSeq += 1;
                  recordReceipt(
                    `${bridgeRunId}:rejected-${rejectedSeq}`,
                    name,
                    'failed',
                    `Invalid parameters: ${issues}`,
                  );
                }
                return failed(
                  `Invalid parameters for "${name}": ${issues}\nSignature: ${renderCompactSignature(tool)}`,
                );
              }
              normalized = parsed.data;
            }

            const authorityRoot = getCwd();
            const authority = await bindPreparedAuthority(name, normalized, authorityRoot, options.executionContext);
            if (authority.kind === 'denied') {
              record(name, 'approval_required', started, isDirectlyCallable(tool));
              if (isActionTool(name)) {
                rejectedSeq += 1;
                recordReceipt(`${bridgeRunId}:rejected-${rejectedSeq}`, name, 'not_applied', authority.message);
              }
              return failed(authority.message);
            }
            const prepared: PreparedCall = {
              tool,
              params: authority.params,
              originalParams: normalized,
              authorityRoot,
              authorityMeaning: fingerprint(authority),
              parallelSafe: await isParallelSafe(tool, normalized, context),
              started,
            };
            return prepared;
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
                    if (isActionTool(prepared.tool.name)) {
                      const semantic = ACTION_SEMANTICS[prepared.tool.name](resolution.result);
                      recordReceipt(
                        `${bridgeRunId}:${callContext.callId}`,
                        prepared.tool.name,
                        semantic.outcome,
                        semantic.reason,
                      );
                    }
                    const serialized = await serializeResult(
                      mediaReferences.capture(resolution.result),
                      RUN_CODE_LIMITS.maxResultChars,
                      prepared.tool.name,
                      calls.filter((c) => c.outcome !== 'describe').length + 1,
                    );
                    if (!serialized.ok) {
                      record(
                        prepared.tool.name,
                        'error',
                        prepared.started,
                        undefined,
                        `${bridgeRunId}:${callContext.callId}`,
                        'invalid_nested_output',
                      );
                      return { kind: 'result', result: serialized as JsonValue };
                    }
                    const contract = validateScriptedReturn(prepared.tool, serialized.result);
                    if (!contract.ok) {
                      record(
                        prepared.tool.name,
                        'error',
                        prepared.started,
                        undefined,
                        `${bridgeRunId}:${callContext.callId}`,
                        'invalid_tool_output',
                      );
                      return {
                        kind: 'fail',
                        code: 'invalid_output',
                        detail: 'invalid_tool_output',
                        message: `Tool "${prepared.tool.name}" returned a value that violates its scripted output contract: ${contract.message}`,
                      };
                    }
                    record(
                      prepared.tool.name,
                      serialized.ok ? 'ok' : 'error',
                      prepared.started,
                      undefined,
                      `${bridgeRunId}:${callContext.callId}`,
                      serialized.ok ? undefined : 'invalid_nested_output',
                    );
                    return { kind: 'result', result: { ok: true, result: contract.value } as JsonValue };
                  }
                  if (resolution.kind === 'failed') {
                    record(
                      prepared.tool.name,
                      'error',
                      prepared.started,
                      undefined,
                      `${bridgeRunId}:${callContext.callId}`,
                      'nested_tool_failure',
                    );
                    const message =
                      resolution.error instanceof Error ? resolution.error.message : String(resolution.error);
                    if (isActionTool(prepared.tool.name)) {
                      recordReceipt(`${bridgeRunId}:${callContext.callId}`, prepared.tool.name, 'failed', message);
                    }
                    return failed(message);
                  }
                  record(
                    prepared.tool.name,
                    'approval_required',
                    prepared.started,
                    isDirectlyCallable(prepared.tool),
                    `${bridgeRunId}:${callContext.callId}`,
                  );
                  if (isActionTool(prepared.tool.name)) {
                    recordReceipt(
                      `${bridgeRunId}:${callContext.callId}`,
                      prepared.tool.name,
                      'not_applied',
                      resolution.message,
                    );
                  }
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
              record(
                prepared.tool.name,
                outcome,
                prepared.started,
                directlyCallable,
                `${bridgeRunId}:${callContext.callId}`,
              );
              if (isActionTool(prepared.tool.name)) {
                const denialReason =
                  decision.kind === 'unknown'
                    ? 'no registered approval policy'
                    : decision.kind === 'interceptor_denied'
                    ? 'refused by an approval interceptor'
                    : decision.kind === 'error'
                    ? 'approval policy failed'
                    : 'requires approval and is unavailable from inside a script';
                recordReceipt(`${bridgeRunId}:${callContext.callId}`, prepared.tool.name, 'not_applied', denialReason);
              }
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
              if (isActionTool(prepared.tool.name)) {
                const semantic = ACTION_SEMANTICS[prepared.tool.name](result);
                recordReceipt(callId, prepared.tool.name, semantic.outcome, semantic.reason);
              }
              const serialized = await serializeResult(
                mediaReferences.capture(result),
                RUN_CODE_LIMITS.maxResultChars,
                prepared.tool.name,
                calls.filter((c) => c.outcome !== 'describe').length + 1,
              );
              if (!serialized.ok) {
                record(prepared.tool.name, 'error', started, undefined, callId, 'invalid_nested_output');
                return { kind: 'result', result: serialized as JsonValue };
              }
              const contract = validateScriptedReturn(prepared.tool, serialized.result);
              if (!contract.ok) {
                record(prepared.tool.name, 'error', started, undefined, callId, 'invalid_tool_output');
                return {
                  kind: 'fail',
                  code: 'invalid_output',
                  detail: 'invalid_tool_output',
                  message: `Tool "${prepared.tool.name}" returned a value that violates its scripted output contract: ${contract.message}`,
                };
              }
              record(
                prepared.tool.name,
                serialized.ok ? 'ok' : 'error',
                started,
                undefined,
                callId,
                serialized.ok ? undefined : 'invalid_nested_output',
              );
              return { kind: 'result', result: { ok: true, result: contract.value } as JsonValue };
            } catch (error) {
              record(prepared.tool.name, 'error', started, undefined, callId, 'nested_tool_failure');
              const message = error instanceof Error ? error.message : String(error);
              if (isActionTool(prepared.tool.name)) {
                recordReceipt(callId, prepared.tool.name, 'failed', message);
              }
              return failed(message);
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
          onConsole: (values) => {
            consoleValues.push(values);
            output.push(renderConsoleValues(values));
          },
        });

        const describeCalls = calls.filter((call) => call.outcome === 'describe');
        const executionCalls = calls.filter((call) => call.outcome !== 'describe');
        loggingService.debug('run_code execution finished', {
          ok: result.ok,
          toolCalls: executionCalls.length,
          schemaLookups: describeCalls.length,
        });

        // Calls admitted but never settled (timeout, deadline, cancellation,
        // worker exit) keep their pending `unknown` outcome with an honest
        // reason rather than vanishing from the ledger.
        for (const [callId, index] of pendingReceiptByCallId) {
          receipts[index] = {
            ...receipts[index],
            outcome: 'unknown',
            reason: 'did not settle before the script run ended',
          };
          pendingReceiptByCallId.delete(callId);
        }

        const oldSuccessfulResult = result as Extract<
          import('../../../services/sandboxed-code-host/host-types.js').HostResult,
          { ok: true }
        >;
        const resolvedResult =
          result.ok && !oldSuccessfulResult.voidOutput
            ? { ...oldSuccessfulResult, output: mediaReferences.resolve(oldSuccessfulResult.output) as JsonValue }
            : result;
        const attachments: RunCodeAttachment[] = [];
        const execution = createRunCodeExecution(resolvedResult, calls, receipts, consoleValues, attachments);
        // Emitted before rendering: a script whose result cannot be rendered has
        // still produced an outcome worth counting.
        emitRunCodeCompletionTelemetry(loggingService, {
          code,
          execution,
          durationMs: Date.now() - startedAt,
          timeoutMs: timeout,
          sessionId,
          runId: bridgeRunId,
          calls,
          receipts,
        });
        const rendered = await renderResult(execution, output, include_console);
        const transportCall =
          details &&
          typeof details === 'object' &&
          'toolCall' in (details as object) &&
          typeof (details as { toolCall?: unknown }).toolCall === 'object';
        return transportCall ? attachRunCodeExecution(rendered, execution) : rendered;
      }
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

const formatActionOutcome = (outcome: RunCodeActionOutcome): string =>
  outcome === 'not_applied' ? 'not applied' : outcome;

/**
 * Host-rendered action section. Present only when at least one covered action
 * call was observed; an empty ledger renders nothing and certifies nothing.
 * Counts are over observed receipts only — never an inferred expected action.
 */
const renderActionReceipts = (receipts: readonly RunCodeActionReceipt[], includeDetails = true): string | null => {
  if (receipts.length === 0) return null;
  const lines = receipts.map((receipt) =>
    receipt.reason
      ? `- ${receipt.tool} [${receipt.callId}]: ${formatActionOutcome(receipt.outcome)} — ${receipt.reason}`
      : `- ${receipt.tool} [${receipt.callId}]: ${formatActionOutcome(receipt.outcome)}`,
  );
  const counts = (outcome: RunCodeActionOutcome): number => receipts.filter((r) => r.outcome === outcome).length;
  const parts = [
    `${counts('applied')} applied`,
    `${counts('not_applied')} not applied`,
    `${counts('failed')} failed`,
    `${counts('unknown')} unknown`,
  ];
  const unit = receipts.length === 1 ? 'call' : 'calls';
  return [
    'Action outcomes (host-observed):',
    ...(includeDetails
      ? lines
      : [`${receipts.length} receipt details omitted from this display; full-output availability is reported above.`]),
    `Action summary: ${parts.join(', ')} across ${receipts.length} observed action ${unit}. ` +
      'Host-observed tool outcomes are authoritative over conflicting script claims; ' +
      'they describe tool behavior, not user-request or task outcomes.',
  ].join('\n');
};

function renderResult(
  execution: RunCodeExecution,
  output: readonly string[],
  includeConsole: boolean,
): Promise<string | readonly RunCodeContentPart[]> {
  const sections: string[] = [];
  const media = execution.attachments as RunCodeContentPart[];
  const calls = execution.calls;
  const receipts = execution.actions;
  if (execution.script.status === 'failed') {
    const { code, message } = execution.script.diagnostic;
    sections.push(
      code === 'timeout'
        ? `Script timed out. ${message}`
        : code === 'deadline'
        ? `Script exceeded its deadline. ${message}`
        : code === 'cancellation'
        ? `Script was cancelled. ${message}`
        : `Script failed: ${message}`,
    );
  } else if (execution.script.voidOutput) {
    sections.push('Script returned no result. Return a value from the script to send it to the model.');
  } else {
    const value = execution.script.value;
    const stripped = containsMediaContent(value) ? stripMediaContent(value, media) : value;
    // A top-level content-part array already has a useful text projection;
    // wrappers (Promise.all, object fields, etc.) retain their shape in JSON,
    // with media replaced by markers so base64 never leaks into text.
    const rendered =
      media.length > 0 && isContentPartArray(value)
        ? value
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
        : typeof stripped === 'string'
        ? stripped
        : JSON.stringify(stripped);
    sections.push(`Result:\n${rendered}`);
  }

  const printed = output.join('\n').trim();
  if (printed && (execution.script.status === 'failed' || includeConsole))
    sections.push(`Console trace (debug):\n${printed}`);

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
  const actionSection = renderActionReceipts(receipts);
  if (actionSection) sections.push(actionSection);
  const unknownPolicy = calls.filter((call) => call.outcome === 'unknown_policy');
  const directlyUnknown = unknownPolicy.filter((call) => call.directlyCallable === true);
  const indirectlyUnknown = unknownPolicy.filter((call) => call.directlyCallable === false);
  if (directlyUnknown.length > 0 || indirectlyUnknown.length > 0) {
    const names = [...new Set([...directlyUnknown, ...indirectlyUnknown].map((call) => call.tool))].join(', ');
    sections.push(`Unavailable (no registered approval policy): ${names}`);
  }
  sections.push(`[${summarizeCalls(calls)}]`);

  const clipped = clip(
    sections.join('\n\n'),
    actionSection
      ? {
          prefix: sections.filter((section) => section !== actionSection).join('\n\n'),
          full: actionSection,
          compact: renderActionReceipts(receipts, false)!,
        }
      : undefined,
  );
  if (media.length > 0) {
    return clipped.then((text) => [{ type: 'text', text }, ...media]);
  }
  return clipped;
}
