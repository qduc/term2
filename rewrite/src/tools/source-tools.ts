/** Executable boundary over the final source definitions, not an old agent runtime. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeToolInput } from '../../../source/lib/tool-invoke.js';
import { isCancellationError, isHarnessInvariantError } from '../../../source/lib/harness-invariant-error.js';
import type { ToolApprovalPolicyRegistry } from '../../../source/services/approval/tool-approval-policy-registry.js';
import {
  NestedApprovalOwner,
  type NestedApprovalSnapshot,
} from '../../../source/services/approval/nested-approval-owner.js';
import { isDockerHostControlShellApproval } from '../../../source/services/approval/shell-sandbox-approval.js';
import type { SessionAccessState } from '../../../source/services/session/session-access-state.js';
import { shouldBypassToolApproval } from '../../../source/services/approval/shell-auto-approval-resolver.js';
import type { ISettingsService } from '../../../source/services/service-interfaces.js';
import { ASK_USER_NO_ANSWER_RESULT } from '../../../source/tools/agent/ask-user-constants.js';
import { coerceToText, isSuccessOutput } from '../../../source/tools/format-helpers.js';
import {
  bindRunCodeNestedApprovalOwner,
  getRunCodeExecutionResult,
} from '../../../source/tools/system/run-code/run-code.js';
import { isZodToolParameterSchema, type AnyToolDefinition } from '../../../source/tools/types.js';
import type { ToolSpec } from '../model/index.js';
import type { ApprovalRequirement, InteractionDecision, Tool, ToolContext, ToolRegistry, ToolResult } from './index.js';

const DIRECT_CONTEXT = Symbol('directToolContext');
type Invocation = { readonly signal: AbortSignal; readonly [DIRECT_CONTEXT]: ToolContext };

type SourceToolOptions = {
  readonly policies: ToolApprovalPolicyRegistry;
  readonly settings: ISettingsService;
  readonly sessionAccess: SessionAccessState;
  readonly sessionId: string;
  readonly withAnswer: <T>(answer: string, operation: () => Promise<T>) => Promise<T>;
};

/** Gate only scripted physical bodies. The source wrapper retains its raw return value. */
export async function executeSourceChild(
  input: { toolName: string; arguments: unknown; context: unknown; details: unknown },
  operation: () => Promise<unknown>,
): Promise<unknown> {
  const invocation = input.context as Partial<Invocation> | undefined;
  const context = invocation?.[DIRECT_CONTEXT];
  const callId = (input.details as { toolCall?: { callId?: string } } | undefined)?.toolCall?.callId;
  if (!context?.executeChild || !callId) throw new Error('Direct scripted execution capability is unavailable');
  invocation?.signal?.throwIfAborted();
  return context.executeChild({ toolName: input.toolName, input: input.arguments, sourceCallId: callId }, async () => {
    invocation?.signal?.throwIfAborted();
    return operation();
  });
}

/** Preserve provider presentation separately from canonical execution parsing. */
export function sourceToolSpec(definition: AnyToolDefinition): ToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.modelTool
      ? {}
      : isZodToolParameterSchema(definition.parameters)
      ? z.toJSONSchema(definition.parameters)
      : definition.parameters,
    ...(definition.modelTool ? { modelTool: definition.modelTool } : {}),
  };
}

function parseInput(definition: AnyToolDefinition, raw: unknown): unknown {
  const schema =
    definition.canonicalParameters ??
    (isZodToolParameterSchema(definition.parameters) ? definition.parameters : undefined);
  const parsed =
    typeof raw === 'string' && definition.parseModelArguments
      ? definition.parseModelArguments(raw)
      : (JSON.parse(normalizeToolInput(raw, schema, definition.argumentParsing ?? 'repair')) as unknown);
  return schema ? schema.parse(parsed) : parsed;
}

function invocationFor(context: ToolContext, sessionId: string): Invocation & { context: { sessionId: string } } {
  return { context: { sessionId }, signal: context.signal, [DIRECT_CONTEXT]: context };
}

function dockerApproval(name: string, input: unknown, options: SourceToolOptions): boolean {
  return isDockerHostControlShellApproval(name, input, options.sessionId, options.sessionAccess);
}

async function approvalFor(
  definition: AnyToolDefinition,
  input: unknown,
  context: ToolContext,
  options: SourceToolOptions,
): Promise<ApprovalRequirement> {
  const policy = await options.policies.evaluate({
    toolName: definition.name,
    args: input,
    context: invocationFor(context, options.sessionId),
  });
  if (policy.kind === 'error') return { kind: 'deny', reason: `Approval policy failed: ${policy.message}` };
  if (policy.kind === 'unknown')
    return { kind: 'deny', reason: `No approval policy registered for ${definition.name}` };
  if (policy.kind === 'interceptor_denied')
    return { kind: 'deny', reason: `Tool ${definition.name} was refused by an approval interceptor` };
  // ask_user is a question, not consent to execute. Its answer is requested by execute().
  if (
    definition.name === 'ask_user' ||
    policy.kind === 'auto_approve' ||
    shouldBypassToolApproval(definition.name, options.settings.get('shell.autoApproveMode'))
  )
    return { kind: 'none' };
  return {
    kind: 'ask',
    summary: dockerApproval(definition.name, input, options)
      ? `${definition.name}: Docker host control (this call only)`
      : `${definition.name} (this call only)`,
    detail: JSON.stringify(input),
  };
}

function approvalAnswer(decision: InteractionDecision, snapshot: NestedApprovalSnapshot): string {
  if (decision.kind !== 'allow') return 'n';
  if (snapshot.approval.deniedRead) return 'allow-once';
  return snapshot.approval.dockerHostControl ? 'docker-allow-once' : 'y';
}

function nestedInteraction(snapshot: NestedApprovalSnapshot) {
  return {
    kind: 'approval' as const,
    toolName: snapshot.toolName,
    input: snapshot.preparedArguments,
    sourceCallId: snapshot.nestedCallId,
    summary: snapshot.approval.dockerHostControl
      ? `${snapshot.toolName}: Docker host control (this call only)`
      : `${snapshot.toolName} (this call only)`,
    detail: snapshot.approval.argumentsText,
    presentation: {
      scope: 'once',
      workspaceRoot: snapshot.approval.workspaceRoot,
      ...(snapshot.approval.deniedRead ? { deniedRead: snapshot.approval.deniedRead } : {}),
      ...(snapshot.approval.outsideWorkspaceEdit
        ? { outsideWorkspaceEdit: snapshot.approval.outsideWorkspaceEdit }
        : {}),
      dockerHostControl: snapshot.approval.dockerHostControl === true,
    },
  };
}

/** Bind a fresh promise/grant helper to this invocation, never a source Session or loop. */
async function withNestedApprovals(
  definition: AnyToolDefinition,
  context: ToolContext,
  options: SourceToolOptions,
  owners: Set<NestedApprovalOwner>,
  execute: () => Promise<unknown>,
): Promise<unknown> {
  if (definition.name !== 'run_code') return execute();
  const owner = new NestedApprovalOwner(options.sessionId);
  owners.add(owner);
  bindRunCodeNestedApprovalOwner([definition], owner);
  let failure: unknown;
  const seen = new Set<string>();
  const unsubscribe = owner.subscribe((snapshot) => {
    if (!snapshot || seen.has(snapshot.requestId)) return;
    seen.add(snapshot.requestId);
    const answer = async () => {
      if (!context.interact) throw new Error('Direct tool interaction capability is unavailable');
      const decision = await context.interact(nestedInteraction(snapshot));
      await owner.decide(snapshot.requestId, {
        answer: approvalAnswer(decision, snapshot),
        ...(decision.kind === 'deny' && decision.reason ? { rejectionReason: decision.reason } : {}),
      });
    };
    void answer().catch((error: unknown) => {
      failure = error;
      void owner.decide(snapshot.requestId, { answer: 'n' });
    });
  });
  try {
    const result = await execute();
    if (failure !== undefined) throw failure;
    return result;
  } finally {
    unsubscribe();
    owner.close();
    owners.delete(owner);
  }
}

function displayFor(definition: AnyToolDefinition, input: unknown, result: unknown, callId: string): unknown {
  try {
    const messages = definition.formatCommandMessage(
      {
        type: 'function_call_output',
        toolName: definition.name,
        callId,
        arguments: input,
        output: resultText(result),
      },
      0,
      new Map([[callId, input]]),
    );
    return definition.approvalPresentation
      ? { messages, approvalPresentation: definition.approvalPresentation }
      : messages;
  } catch {
    // Presentation is passive; it cannot turn a completed effect into a retry.
    return undefined;
  }
}

function resultText(result: unknown): string {
  return result instanceof String ? String(result) : coerceToText(result);
}

function providerOutput(result: unknown): ToolResult['providerOutput'] {
  if (!Array.isArray(result) || result.length === 0) return undefined;
  return result.every((part: unknown) => {
    if (!part || typeof part !== 'object') return false;
    const item = part as Record<string, unknown>;
    return item.type === 'text'
      ? typeof item.text === 'string'
      : item.type === 'image'
      ? 'image' in item
      : item.type === 'file' && 'file' in item;
  })
    ? result
    : undefined;
}

async function questionAnswer(definition: AnyToolDefinition, input: unknown, context: ToolContext): Promise<string> {
  if (definition.name !== 'ask_user') return '';
  if (!context.interact) throw new Error('Direct question interaction capability is unavailable');
  const decision = await context.interact({
    kind: 'question',
    toolName: definition.name,
    input,
    summary: 'Answer the model’s questions',
    detail: JSON.stringify(input),
    presentation: { questions: (input as { questions: unknown }).questions },
  });
  return decision.kind === 'answer' ? decision.answer : ASK_USER_NO_ANSWER_RESULT;
}

function adaptTool(definition: AnyToolDefinition, options: SourceToolOptions, owners: Set<NestedApprovalOwner>): Tool {
  return {
    spec: sourceToolSpec(definition),
    parallelSafe:
      typeof definition.parallelSafe === 'function'
        ? (input, context) =>
            (definition.parallelSafe as (p: unknown, c: unknown) => boolean | Promise<boolean>)(
              input,
              invocationFor(context, options.sessionId),
            )
        : definition.parallelSafe,
    parse: (raw) => parseInput(definition, raw),
    approval: (input, context) => approvalFor(definition, input, context, options),
    async execute(input, context) {
      context.signal.throwIfAborted();
      const answer = await questionAnswer(definition, input, context);
      context.signal.throwIfAborted();
      // A direct allow means one execution only, including the separate Docker capability.
      if (dockerApproval(definition.name, input, options)) {
        const command = (input as { command: string }).command;
        options.sessionAccess.grantDocker(command, context.workspace.root, 'once');
      }
      const callId = `direct:${randomUUID()}`;
      const invocation = invocationFor(context, options.sessionId);
      let result: unknown;
      try {
        result = await withNestedApprovals(definition, context, options, owners, () =>
          options.withAnswer(answer, async () => definition.execute(input, invocation, { toolCall: { callId } })),
        );
      } catch (error) {
        if (context.signal.aborted || isCancellationError(error) || isHarnessInvariantError(error)) throw error;
        return {
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          display: displayFor(definition, input, error, callId),
        };
      }
      const execution = getRunCodeExecutionResult(result);
      const output = resultText(result);
      const media = providerOutput(result);
      const explicitError =
        result && typeof result === 'object' && 'isError' in result && typeof result.isError === 'boolean'
          ? result.isError
          : undefined;
      return {
        output,
        isError: explicitError ?? (execution ? execution.script.status === 'failed' : !isSuccessOutput(output)),
        ...(media ? { providerOutput: media } : {}),
        display: displayFor(definition, input, result, callId),
      };
    },
  };
}

/** Adapt only the directly offered definitions. run_code already retains the complete wrapped graph. */
export function createSourceToolRegistry(
  definitions: readonly AnyToolDefinition[],
  options: SourceToolOptions,
): ToolRegistry & { dispose(): void } {
  const owners = new Set<NestedApprovalOwner>();
  const tools = new Map<string, Tool>();
  for (const definition of definitions) {
    if (tools.has(definition.name)) throw new Error(`Duplicate offered tool: ${definition.name}`);
    tools.set(definition.name, adaptTool(definition, options, owners));
  }
  return {
    get: (name) => tools.get(name),
    available: () => [...tools.values()],
    dispose() {
      for (const owner of owners) owner.close();
      owners.clear();
    },
  };
}
