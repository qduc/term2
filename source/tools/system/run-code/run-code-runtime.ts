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
import { validateScriptedReturn } from '../../scripted-return-contract.js';
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
  RUN_CODE_PROHIBITED_TOOLS,
  serializeResult,
  withAbortSignal,
  writeNestedCallRecord,
  type RunCodeActionOutcome,
  type RunCodeActionReceipt,
  type RunCodeCallRecord,
  RUN_CODE_LIMITS,
  TOOL_NAME_DESCRIBE,
} from './run-code.js';
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
