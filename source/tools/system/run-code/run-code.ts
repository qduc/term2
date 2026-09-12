import type { ExecutionContext } from '../../../services/execution-context.js';
import { z } from 'zod';
import { relaxedNumber } from '../../utils.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { ToolInvocationContext } from '../../../services/agent-runtime/tool-invocation-context.js';
import type { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import type { NestedApprovalOwner } from '../../../services/approval/nested-approval-owner.js';
import {
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
import { renderToolsHeader } from './tools-header.js';
import { RUN_CODE_EXECUTION_RESULT, type RunCodeExecution } from './run-code-execution.js';
import { formatFullOutputSavedNote, saveOutputArtifact } from '../../../utils/shell/shell-output.js';
import {
  RUN_CODE_LIMITS,
  RUN_CODE_PROHIBITED_TOOLS,
  TOOL_NAME_RUN_CODE,
  createRunCodeRuntime,
  type RunCodeActionOutcome,
  type RunCodeActionReceipt,
  type RunCodeCallRecord,
} from './run-code-runtime.js';

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
      return runtimeTransportCall ? attachRunCodeExecution(runtimeRendered, runtimeResult.execution) : runtimeRendered;
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
