import { appendFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionContext } from '../../../services/execution-context.js';
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
import { normalizeToolParameters } from '../../../lib/tool-invoke.js';
import { isZodToolParameterSchema, type AnyToolDefinition, type ToolRegistry } from '../../types.js';
import { renderCompactSignature } from './tools-header.js';
import {
  getScriptedReturnContract,
  scriptedReturnContractJsonSchema,
  validateScriptedReturn,
} from '../../scripted-return-contract.js';
import { WORKFLOW_PROHIBITED_TOOLS } from '../../../services/agent-runtime/workflow/workflow-evaluator.js';
import { resolveWorkspacePath, resolveWorkspacePathPhysically } from '../../utils.js';
import { parseUpstreamApplyPatch } from '../../file/upstream-apply-patch.js';
import { saveOutputArtifact } from '../../../utils/shell/shell-output.js';
import { getRunCodeExecutionResult } from './run-code-execution.js';
import type { RunCodeActionOutcome, RunCodeActionReceipt, RunCodeCallRecord } from './run-code-runtime-contract.js';

export type { RunCodeActionOutcome, RunCodeActionReceipt, RunCodeCallRecord } from './run-code-runtime-contract.js';

export const TOOL_NAME_RUN_CODE = 'run_code';
export const TOOL_NAME_DESCRIBE = 'describe';

/** Limits governing one script invocation. */
export const RUN_CODE_LIMITS = {
  maxCalls: 200,
  maxConcurrency: 8,
  maxResultChars: 100_000,
  maxMediaBytes: 8 * 1024 * 1024,
  maxMediaTotalBytes: 32 * 1024 * 1024,
  maxMediaAttachments: 32,
  maxCodeBytes: 65_536,
  maxOutputBytes: 262_144,
  maxConsoleBytes: 262_144,
} as const;

/** Tools that are structurally unavailable from a script. */
export const RUN_CODE_PROHIBITED_TOOLS: ReadonlySet<string> = new Set([
  ...WORKFLOW_PROHIBITED_TOOLS,
  TOOL_NAME_RUN_CODE,
  'ask_mentor',
  'session_rollover',
  'shell',
  'bash',
  'enter_worktree',
  'exit_worktree',
]);

/** Static semantic adapters for action tools whose result contract is known. */
export const ACTION_SEMANTICS: Record<string, (raw: unknown) => { outcome: RunCodeActionOutcome; reason?: string }> = {
  configure_task_check_in: (raw) => {
    const parsed = parseActionPayload(raw);
    if (!isRecord(parsed) || typeof parsed.ok !== 'boolean')
      return { outcome: 'unknown', reason: 'unrecognized action result shape' };
    if (parsed.ok === true) return { outcome: 'applied' };
    return {
      outcome: 'not_applied',
      reason: typeof parsed.error === 'string' && parsed.error ? parsed.error : 'action reported ok:false',
    };
  },
  cancel_run: (raw) => {
    const parsed = parseActionPayload(raw);
    if (!isRecord(parsed) || typeof parsed.ok !== 'boolean')
      return { outcome: 'unknown', reason: 'unrecognized action result shape' };
    if (
      parsed.ok === true &&
      typeof parsed.runId === 'string' &&
      parsed.runId.length > 0 &&
      parsed.status === 'cancelling'
    ) {
      return { outcome: 'applied', reason: 'cancellation requested and accepted; settlement is reported separately' };
    }
    if (
      parsed.ok === false &&
      parsed.code === 'not_active' &&
      typeof parsed.target === 'string' &&
      parsed.target.length > 0
    ) {
      return { outcome: 'not_applied', reason: `not_active (target: ${parsed.target})` };
    }
    return { outcome: 'unknown', reason: 'unrecognized action result shape' };
  },
};

export const isActionTool = (name: string): boolean => ACTION_SEMANTICS[name] !== undefined;

const parseActionPayload = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const MAX_RECEIPT_REASON_CHARS = 280;
export const clipReason = (reason: string): string =>
  reason.length <= MAX_RECEIPT_REASON_CHARS ? reason : `${reason.slice(0, MAX_RECEIPT_REASON_CHARS)}…`;

export function isDirectlyCallable(tool: Pick<AnyToolDefinition, 'name'>): boolean {
  return RUN_CODE_PROHIBITED_TOOLS.has(tool.name);
}

export function describeTool(tool: AnyToolDefinition): JsonValue {
  let parameters: JsonValue;
  const targetSchema = tool.canonicalParameters ?? tool.parameters;
  if (isZodToolParameterSchema(targetSchema)) {
    try {
      parameters = z.toJSONSchema(targetSchema, { io: 'input' }) as JsonValue;
    } catch {
      parameters = { unconvertible: true };
    }
  } else if (targetSchema && typeof targetSchema === 'object') {
    parameters = targetSchema as JsonValue;
  } else {
    parameters = { unconvertible: true };
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters,
    scriptedReturnContract: scriptedReturnContractJsonSchema(getScriptedReturnContract(tool)),
    ...(typeof tool.scriptedReturnShape === 'string' && tool.scriptedReturnShape
      ? { scriptedReturnShape: tool.scriptedReturnShape }
      : {}),
  } as JsonValue;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

type RunCodeContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: unknown; detail?: unknown }
  | { type: 'file'; file: unknown };

const isMediaContentPart = (value: unknown): value is RunCodeContentPart =>
  isRecord(value) && ((value.type === 'image' && 'image' in value) || (value.type === 'file' && 'file' in value));

const mediaBytes = (value: RunCodeContentPart): number => {
  const payload = value.type === 'image' ? value.image : value.type === 'file' ? value.file : undefined;
  if (isRecord(payload) && typeof payload.data === 'string') {
    try {
      return Buffer.from(payload.data, 'base64').byteLength;
    } catch {
      return Buffer.byteLength(payload.data, 'utf8');
    }
  }
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const MEDIA_REFERENCE_KEY = '__term2_run_code_media_reference__';
type MediaReference = { [MEDIA_REFERENCE_KEY]: string };
const isMediaReference = (value: unknown): value is MediaReference =>
  isRecord(value) && typeof value[MEDIA_REFERENCE_KEY] === 'string' && Object.keys(value).length === 1;

export function createMediaReferenceStore() {
  const attachments = new Map<string, RunCodeContentPart>();
  const byValue = new WeakMap<object, string | null>();
  let totalBytes = 0;
  const capture = (value: unknown): unknown => {
    if (isMediaContentPart(value)) {
      const existing = byValue.get(value);
      if (existing !== undefined) return existing ? { [MEDIA_REFERENCE_KEY]: existing } : '[media content omitted]';
      const size = mediaBytes(value);
      if (
        !Number.isFinite(size) ||
        size > RUN_CODE_LIMITS.maxMediaBytes ||
        attachments.size >= RUN_CODE_LIMITS.maxMediaAttachments ||
        totalBytes + size > RUN_CODE_LIMITS.maxMediaTotalBytes
      ) {
        byValue.set(value, null);
        return `[media content omitted: attachment exceeds the ${RUN_CODE_LIMITS.maxMediaBytes}-byte per-image or ${RUN_CODE_LIMITS.maxMediaTotalBytes}-byte per-run limit]`;
      }
      const token = `run_code_media_${randomUUID()}`;
      byValue.set(value, token);
      attachments.set(token, value);
      totalBytes += size;
      return { [MEDIA_REFERENCE_KEY]: token } satisfies MediaReference;
    }
    if (Array.isArray(value)) return value.map(capture);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, capture(entry)]));
    return value;
  };
  const resolve = (value: unknown): unknown => {
    if (isMediaReference(value)) return attachments.get(value[MEDIA_REFERENCE_KEY]) ?? value;
    if (Array.isArray(value)) return value.map(resolve);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
    return value;
  };
  return { capture, resolve };
}

const containsMediaContent = (value: unknown, ancestors = new Set<object>()): boolean => {
  if (isMediaContentPart(value)) return true;
  if (!isRecord(value) && !Array.isArray(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const found = Array.isArray(value)
    ? value.some((entry) => containsMediaContent(entry, ancestors))
    : Object.values(value).some((entry) => containsMediaContent(entry, ancestors));
  ancestors.delete(value);
  return found;
};

const truncate = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  let prefix = text.slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}\n[truncated: result exceeded ${limit} characters]`;
};

export const serializeResult = async (
  result: unknown,
  limit: number,
  toolName: string,
  callsCompleted: number,
): Promise<{ ok: true; result: JsonValue } | { ok: false; error: string }> => {
  const execution = getRunCodeExecutionResult(result);
  if (execution && result instanceof String) result = String(result);
  if (typeof result === 'string') return { ok: true, result: truncate(result, limit) };
  try {
    const encoded = JSON.stringify(result);
    if (encoded === undefined) return { ok: true, result: null };
    if (encoded.length <= limit) return { ok: true, result: result as JsonValue };
    if (containsMediaContent(result))
      return { ok: true, result: `[truncated: media result exceeded ${limit} characters; media content omitted]` };
    let retrieval = '';
    try {
      const artifactPath = await saveOutputArtifact(encoded, { filenamePrefix: 'tool-overflow' });
      retrieval = `Full output saved to: ${artifactPath}. `;
    } catch {
      retrieval = 'Full output could not be saved; the omitted result is unavailable. ';
    }
    const callUnit = callsCompleted === 1 ? 'call' : 'calls';
    return {
      ok: false,
      error: `Tool "${toolName}" result exceeded ${limit} characters and could not be delivered to script. ${retrieval}${callsCompleted} nested tool ${callUnit} completed — inspect state before retrying; tool effects have already completed.`,
    };
  } catch {
    return { ok: true, result: truncate(String(result), limit) };
  }
};

export function getConversationSessionId(context: unknown): string | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const runContext = (context as { context?: unknown }).context;
  if (!runContext || typeof runContext !== 'object') return undefined;
  const sessionId = (runContext as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

export function writeNestedCallRecord(
  tool: string,
  sessionId: string | undefined,
  outcome: 'success' | 'failure' | 'denied-by-approval',
): void {
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

export async function bindPreparedAuthority(
  toolName: string,
  params: unknown,
  cwd: string,
  executionContext?: ExecutionContext,
): Promise<BoundAuthority> {
  const isRemote = executionContext?.isRemote() ?? false;
  if (isRemote && PATH_TOOLS.has(toolName))
    return { kind: 'denied', message: 'Cannot establish remote physical path authority for a nested tool call.' };
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
  if (toolName === 'apply_patch' && typeof record.patch === 'string')
    return { ...record, patch: await bindPatchPaths(record.patch, bindPath) };
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

export function withAbortSignal(context: unknown, signal: AbortSignal, extra: Record<string, unknown> = {}): unknown {
  return context && typeof context === 'object'
    ? { ...(context as Record<string, unknown>), signal, ...extra }
    : { signal, ...extra };
}

export function mergeAbortSignals(callerSignal: AbortSignal | undefined, hostSignal: AbortSignal): AbortSignal {
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

export async function isParallelSafe(tool: AnyToolDefinition, params: unknown, context: unknown): Promise<boolean> {
  const declared = tool.parallelSafe;
  if (declared === undefined || declared === false) return false;
  if (declared === true) return true;
  try {
    return (await (declared as (p: unknown, c?: unknown) => boolean | Promise<boolean>)(params, context)) === true;
  } catch {
    return false;
  }
}
import {
  createRunCodeExecution,
  type RunCodeAttachment,
  type RunCodeDiagnosticCode,
  type RunCodeExecution,
} from './run-code-execution.js';
import { emitRunCodeCompletionTelemetry } from './run-code-telemetry.js';

const createBridgeRunId = (() => {
  let next = 0;
  return () => `run_code_bridge_${++next}`;
})();

export interface RunCodeRuntimeOptions {
  registry: ToolRegistry;
  /** Identity of the complete wrapped graph used by approval revalidation. */
  graphIdentity?: object;
  loggingService: ILoggingService;
  approvalPolicyRegistry: ToolApprovalPolicyRegistry;
  getCwd: () => string;
  executionContext?: ExecutionContext;
  nestedApprovalOwner?: NestedApprovalOwner;
  sessionAccess?: import('../../../services/session/session-access-state.js').SessionAccessState;
  nestedCompatibility?: import('../../../services/session/nested-tool-compatibility-state.js').NestedToolCompatibilityState;
}

export interface RunCodeRuntimeInput {
  code: string;
  timeout: number;
  description: string;
  context?: unknown;
  signal?: AbortSignal;
}

export interface RunCodeRuntimeResult {
  execution: RunCodeExecution;
  /** Raw console projection retained for terminal presentation. */
  output: readonly string[];
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

/**
 * Product-specific runtime for one final wrapped registry snapshot.
 *
 * The host remains deliberately product-neutral. This module owns the other
 * half of the seam: discovery of scriptable members, nested admission and
 * approval, call/action ledgers, attachment references, normalization, and
 * completion telemetry. Consequently a caller cannot accidentally execute
 * only half of the lifecycle (for example, admit calls without finalizing
 * receipts) by assembling the pieces itself.
 */
export function createRunCodeRuntime(options: RunCodeRuntimeOptions) {
  // Snapshot and filter once. Discovery and dispatch therefore cannot drift
  // if a caller mutates its registry while an invocation is in flight.
  const registry = options.registry.filter((tool) => !RUN_CODE_PROHIBITED_TOOLS.has(tool.name));

  const discovery = (): ToolRegistry => registry;

  const execute = async (input: RunCodeRuntimeInput): Promise<RunCodeRuntimeResult> => {
    const { loggingService } = options;
    const approvalRegistry = options.approvalPolicyRegistry;
    // The owner is session-scoped while the registry is rebuilt with an agent.
    // Reassert the complete wrapped graph at the execution seam so an owner
    // attached after construction observes the same graph as this invocation.
    if (options.nestedApprovalOwner && options.graphIdentity) {
      options.nestedApprovalOwner.bindGraph(options.graphIdentity);
    }
    const callerSignal = (input.context as ToolInvocationContext | undefined)?.signal ?? input.signal;
    const bridgeRunId = createBridgeRunId();
    const startedAt = Date.now();
    const calls: RunCodeCallRecord[] = [];
    const receipts: RunCodeActionReceipt[] = [];
    const pendingReceiptByCallId = new Map<string, number>();
    const abortedCallIds = new Set<string>();
    let rejectedSeq = 0;
    const output: string[] = [];
    const consoleValues: JsonValue[][] = [];
    const sessionId = getConversationSessionId(input.context);
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
      if (outcome !== 'describe') {
        writeNestedCallRecord(
          tool,
          sessionId,
          outcome === 'ok' ? 'success' : outcome === 'approval_required' ? 'denied-by-approval' : 'failure',
        );
      }
    };
    const failed = (message: string): CapabilityOutcome => ({
      kind: 'result',
      result: { ok: false, error: message } as JsonValue,
    });
    const recordReceipt = (callId: string, tool: string, outcome: RunCodeActionOutcome, reason?: string): void => {
      if (abortedCallIds.has(callId)) return;
      const pendingIndex = pendingReceiptByCallId.get(callId);
      const value = { callId, tool, outcome, ...(reason ? { reason: clipReason(reason) } : {}) };
      if (pendingIndex !== undefined) {
        receipts[pendingIndex] = value;
        pendingReceiptByCallId.delete(callId);
      } else receipts.push(value);
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
      overBudget: ({ usedCalls, maxCalls }, rejected) => {
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
          )} remaining). Return the partial results you collected and start another run_code call only for unattempted work; Do not repeat completed tool effects.`,
        );
      },
      onAdmitted: (prepared, context) => {
        if (!isActionTool(prepared.tool.name)) return;
        const callId = `${bridgeRunId}:${context.callId}`;
        pendingReceiptByCallId.set(callId, receipts.length);
        receipts.push({ callId, tool: prepared.tool.name, outcome: 'unknown' });
      },
      onAborted: (prepared, context, reason) => {
        const callId = `${bridgeRunId}:${context.callId}`;
        abortedCallIds.add(callId);
        record(prepared.tool.name, 'unknown', prepared.started, undefined, callId);
        if (isActionTool(prepared.tool.name)) recordReceipt(callId, prepared.tool.name, 'unknown', reason);
      },
      prepare: async (payload) => {
        const started = Date.now();
        const name = typeof payload.member === 'string' ? payload.member : '';
        const tool = registry.find((candidate) => candidate.name === name);
        if (name === TOOL_NAME_DESCRIBE && typeof payload.params === 'string') {
          const described = registry.find((candidate) => candidate.name === payload.params);
          if (!described)
            return failed(
              `Unknown tool "${payload.params}". Available: ${registry.map((entry) => entry.name).join(', ')}`,
            );
          record(name, 'describe', started);
          return { kind: 'result', result: { ok: true, result: describeTool(described) } as JsonValue };
        }
        if (!tool) {
          record(name || '(unnamed)', 'unknown_tool', started, undefined, undefined, 'unknown_tool');
          if (isActionTool(name)) {
            rejectedSeq += 1;
            recordReceipt(`${bridgeRunId}:rejected-${rejectedSeq}`, name, 'failed', `Unknown tool "${name}"`);
          }
          return failed(`Unknown tool "${name}". Available: ${registry.map((entry) => entry.name).join(', ')}`);
        }
        const targetSchema = tool.canonicalParameters ?? tool.parameters;
        let normalized: unknown = payload.params ?? {};
        try {
          normalized = normalizeToolParameters(normalized, targetSchema);
        } catch {
          normalized = payload.params ?? {};
        }
        if (isZodToolParameterSchema(targetSchema)) {
          const parsed = targetSchema.safeParse(normalized);
          if (!parsed.success) {
            record(name, 'invalid_params', started, undefined, undefined, 'invalid_nested_input');
            const issues =
              parsed.error?.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') ??
              'invalid parameters';
            if (isActionTool(name)) {
              rejectedSeq += 1;
              recordReceipt(`${bridgeRunId}:rejected-${rejectedSeq}`, name, 'failed', `Invalid parameters: ${issues}`);
            }
            return failed(`Invalid parameters for "${name}": ${issues}\nSignature: ${renderCompactSignature(tool)}`);
          }
          normalized = parsed.data;
        }
        const authorityRoot = options.getCwd();
        const authority = await bindPreparedAuthority(name, normalized, authorityRoot, options.executionContext);
        if (authority.kind === 'denied') {
          record(name, 'approval_required', started, isDirectlyCallable(tool));
          if (isActionTool(name)) {
            rejectedSeq += 1;
            recordReceipt(`${bridgeRunId}:rejected-${rejectedSeq}`, name, 'not_applied', authority.message);
          }
          return failed(authority.message);
        }
        return {
          tool,
          params: authority.params,
          originalParams: normalized,
          authorityRoot,
          authorityMeaning: JSON.stringify(authority),
          parallelSafe: await isParallelSafe(tool, normalized, input.context),
          started,
        } satisfies PreparedCall;
      },
      lane: (prepared) => (prepared.parallelSafe ? 'default' : 'serial'),
      invoke: async (prepared, callContext): Promise<CapabilityOutcome> => {
        const callId = `${bridgeRunId}:${callContext.callId}`;
        const decision = await approvalRegistry.evaluate({
          toolName: prepared.tool.name,
          args: prepared.params,
          context: input.context,
        });
        if (decision.kind !== 'auto_approve') {
          if (decision.kind === 'prompt' && options.nestedApprovalOwner) {
            const nestedContext = withAbortSignal(input.context, mergeAbortSignals(callerSignal, callContext.signal), {
              scripted: true,
            }) as ToolInvocationContext;
            tools.onWaiting?.(callContext);
            try {
              const resolution = await options.nestedApprovalOwner.request({
                requestId: callId,
                sessionId: sessionId ?? 'unknown',
                graphIdentity: options.graphIdentity ?? options.registry,
                outerRunId: bridgeRunId,
                nestedCallId: callId,
                toolName: prepared.tool.name,
                preparedArguments: prepared.params,
                authorityContext: input.context,
                approval: {
                  agentName: 'Nested run_code',
                  toolName: prepared.tool.name,
                  argumentsText: JSON.stringify(prepared.params),
                  rawInterruption: null,
                  callId,
                  outsideWorkspaceEdit: resolveOutsideWorkspaceEdit(
                    prepared.tool.name,
                    prepared.params,
                    prepared.authorityRoot,
                  ),
                },
                signal: nestedContext.signal as AbortSignal,
                revalidateAuthority: async () => {
                  const currentRoot = options.getCwd();
                  const authority = await bindPreparedAuthority(
                    prepared.tool.name,
                    prepared.originalParams,
                    currentRoot,
                    options.executionContext,
                  );
                  return (
                    authority.kind === 'bound' &&
                    currentRoot === prepared.authorityRoot &&
                    JSON.stringify(authority) === prepared.authorityMeaning
                  );
                },
                revalidate: async () =>
                  (
                    await approvalRegistry.evaluate({
                      toolName: prepared.tool.name,
                      args: prepared.params,
                      context: input.context,
                    })
                  ).kind,
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
                      callId,
                    },
                  );
                  if (!applied.isApproved) throw new Error('Tool execution was not approved.');
                },
                dispatch: async () => prepared.tool.execute(prepared.params, nestedContext, { toolCall: { callId } }),
              });
              if (resolution.kind === 'approved') return settleResolved(prepared, resolution.result, callId);
              const message = 'message' in resolution ? resolution.message : String(resolution.error);
              record(
                prepared.tool.name,
                'approval_required',
                prepared.started,
                isDirectlyCallable(prepared.tool),
                callId,
              );
              if (isActionTool(prepared.tool.name)) recordReceipt(callId, prepared.tool.name, 'not_applied', message);
              return failed(message);
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
          record(prepared.tool.name, outcome, prepared.started, isDirectlyCallable(prepared.tool), callId);
          const message =
            decision.kind === 'unknown'
              ? `"${prepared.tool.name}" has no registered approval policy and is unavailable from inside a script.`
              : decision.kind === 'interceptor_denied'
              ? `"${prepared.tool.name}" was refused by an approval interceptor and is unavailable from inside a script.`
              : decision.kind === 'error'
              ? `"${prepared.tool.name}" approval policy failed and is unavailable from inside a script.`
              : `"${prepared.tool.name}" requires approval and is unavailable from inside a script.`;
          if (isActionTool(prepared.tool.name)) recordReceipt(callId, prepared.tool.name, 'not_applied', message);
          return failed(message);
        }
        try {
          return settleResolved(
            prepared,
            await prepared.tool.execute(
              prepared.params,
              withAbortSignal(input.context, mergeAbortSignals(callerSignal, callContext.signal), { scripted: true }),
              { toolCall: { callId } },
            ),
            callId,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          record(prepared.tool.name, 'error', prepared.started, undefined, callId, 'nested_tool_failure');
          if (isActionTool(prepared.tool.name)) recordReceipt(callId, prepared.tool.name, 'failed', message);
          return failed(message);
        }
      },
    };

    const settleResolved = async (prepared: PreparedCall, raw: unknown, callId: string): Promise<CapabilityOutcome> => {
      try {
        if (isActionTool(prepared.tool.name)) {
          const semantic = ACTION_SEMANTICS[prepared.tool.name](raw);
          recordReceipt(callId, prepared.tool.name, semantic.outcome, semantic.reason);
        }
        const serialized = await serializeResult(
          mediaReferences.capture(raw),
          RUN_CODE_LIMITS.maxResultChars,
          prepared.tool.name,
          calls.filter((call) => call.outcome !== 'describe').length + 1,
        );
        if (!serialized.ok) {
          record(prepared.tool.name, 'error', prepared.started, undefined, callId, 'invalid_nested_output');
          return { kind: 'result', result: serialized as JsonValue };
        }
        const contract = validateScriptedReturn(prepared.tool, serialized.result);
        if (!contract.ok) {
          record(prepared.tool.name, 'error', prepared.started, undefined, callId, 'invalid_tool_output');
          return {
            kind: 'fail',
            code: 'invalid_output',
            detail: 'invalid_tool_output',
            message: `Tool "${prepared.tool.name}" returned a value that violates its scripted output contract: ${contract.message}`,
          };
        }
        record(prepared.tool.name, 'ok', prepared.started, undefined, callId);
        return { kind: 'result', result: { ok: true, result: contract.value } as JsonValue };
      } catch (error) {
        record(prepared.tool.name, 'error', prepared.started, undefined, callId, 'nested_tool_failure');
        const message = error instanceof Error ? error.message : String(error);
        if (isActionTool(prepared.tool.name)) recordReceipt(callId, prepared.tool.name, 'failed', message);
        return failed(message);
      }
    };

    loggingService.debug('run_code execution started', {
      cwd: options.getCwd(),
      timeout: input.timeout,
      exposedTools: registry.length,
      description: input.description,
    });
    const result = await new SandboxedCodeHostImpl().run({
      code: input.code,
      capabilities: { tools },
      limits: {
        timeoutMs: input.timeout,
        maxCodeBytes: RUN_CODE_LIMITS.maxCodeBytes,
        maxOutputBytes: RUN_CODE_LIMITS.maxOutputBytes,
        maxConsoleBytes: RUN_CODE_LIMITS.maxConsoleBytes,
      },
      subject: 'Script',
      allowVoidOutput: true,
      signal: callerSignal,
      onConsole: (values) => {
        consoleValues.push(values);
        output.push(values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '));
      },
    });
    for (const [callId, index] of pendingReceiptByCallId) {
      receipts[index] = {
        ...receipts[index],
        outcome: 'unknown',
        reason: 'did not settle before the script run ended',
      };
      pendingReceiptByCallId.delete(callId);
    }
    const resolvedResult =
      result.ok && !result.voidOutput
        ? { ...result, output: mediaReferences.resolve(result.output) as JsonValue }
        : result;
    const attachments: RunCodeAttachment[] = [];
    const execution = createRunCodeExecution(resolvedResult, calls, receipts, consoleValues, attachments);
    emitRunCodeCompletionTelemetry(loggingService, {
      code: input.code,
      execution,
      durationMs: Date.now() - startedAt,
      timeoutMs: input.timeout,
      sessionId,
      runId: bridgeRunId,
      calls,
      receipts,
    });
    loggingService.debug('run_code execution finished', {
      ok: result.ok,
      toolCalls: calls.filter((call) => call.outcome !== 'describe').length,
      schemaLookups: calls.filter((call) => call.outcome === 'describe').length,
    });
    return { execution, output };
  };

  return { discovery, execute };
}
