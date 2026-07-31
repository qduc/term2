import type { ConversationEvent } from './conversation-events.js';
import { ModelBehaviorError } from '@openai/agents';
import type { ApprovalRequiredTerminal, ConversationTerminal, LLMAdvisory } from '../../contracts/conversation.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import { extractUsage } from '../../utils/ai/token-usage.js';
import { extractCommandMessages } from '../../utils/streaming/extract-command-messages.js';
import { attachCachedArguments } from '../command-message-streaming.js';
import { createInvalidToolCallDiagnostic } from '../logging/logging-contract.js';
import { asRecord, getCallIdFromObject, getString, getToolInfoFromInterruption } from '../interruption-info.js';
import type { AgentStream } from '../agent-stream.js';
import type { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { ShellAutoApprovalResolver } from '../approval/shell-auto-approval-resolver.js';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';
import { parseToolCallArguments } from '../tool-call-arguments.js';
import { buildPersistedAssistantTurnItems } from './conversation-turn-items.js';
import { type GenerationToken } from '../generation-guard.js';
import { type CommandMessage } from '../../tools/types.js';
import { toolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import {
  isDockerHostControlShellApproval,
  isUnsandboxedShell,
  requiresHumanShellApproval,
} from '../approval/shell-sandbox-approval.js';
import type { DeniedReadMetadata, PostExecuteApprovalToken } from '../../contracts/conversation.js';
import type { SessionAccessState } from '../session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';

export type BuildResultOutcome =
  | { kind: 'response'; result: Extract<ConversationTerminal, { type: 'response' }> }
  | { kind: 'approval_required'; result: Extract<ConversationTerminal, { type: 'approval_required' }> }
  | {
      kind: 'auto_approve';
      advisory?: LLMAdvisory;
      callId: string | undefined;
      argumentsText: string;
    };

export interface ResultBuilderDeps {
  approvalFlow: ApprovalFlowCoordinator;
  shellAutoApproval: ShellAutoApprovalResolver;
  logger: ILoggingService;
  sessionId: string;
  /** Handle-owned root capability; omitted only by nested compatibility callers. */
  sessionAccess?: SessionAccessState;
  /** Explicit nested/test-only legacy approval state. */
  nestedCompatibility?: NestedToolCompatibilityState;
}

export interface ResultBuilderInput {
  result: AgentStream;
  finalOutputOverride?: string;
  reasoningOutputOverride?: string;
  emittedCommandIds?: Set<string>;
  usage?: NormalizedUsage;
  toolCallArgumentsById: Map<string, unknown>;
  turnItems?: PersistedAssistantTurnItem[];
  token?: GenerationToken;
  inputMode?: 'delta' | 'full_history';
  cumulativeUsage?: NormalizedUsage;
  cumulativeCommandMessages?: CommandMessage[];
  cumulativeTurnItems?: PersistedAssistantTurnItem[];
}

export function createApprovalRequiredTerminal(options: {
  agentName: string;
  toolName: string;
  argumentsText: string;
  rawInterruption?: unknown;
  callId?: string;
  llmAdvisory?: LLMAdvisory;
  deniedRead?: DeniedReadMetadata;
  dockerHostControl?: boolean;
  postExecute?: PostExecuteApprovalToken;
  usage?: NormalizedUsage;
}): ApprovalRequiredTerminal {
  return {
    type: 'approval_required',
    approval: {
      agentName: options.agentName,
      toolName: options.toolName,
      argumentsText: options.argumentsText,
      rawInterruption: options.rawInterruption,
      ...(options.callId ? { callId: options.callId } : {}),
      ...(options.llmAdvisory ? { llmAdvisory: options.llmAdvisory } : {}),
      ...(options.deniedRead ? { deniedRead: options.deniedRead } : {}),
      ...(options.dockerHostControl ? { dockerHostControl: true } : {}),
      ...(options.postExecute ? { postExecute: options.postExecute } : {}),
    },
    ...(options.usage ? { usage: options.usage } : {}),
  };
}

const resolveFinalText = (streamedText: string | undefined, completedText: string | undefined): string => {
  if (
    completedText !== undefined &&
    completedText !== '' &&
    !(streamedText !== undefined && completedText === 'Done.')
  ) {
    return completedText;
  }

  return streamedText ?? completedText ?? 'Done.';
};

export async function buildConversationResult(
  input: ResultBuilderInput,
  deps: ResultBuilderDeps,
): Promise<BuildResultOutcome> {
  const { result, finalOutputOverride, reasoningOutputOverride, emittedCommandIds, usage, toolCallArgumentsById } =
    input;
  const { approvalFlow, shellAutoApproval, logger, sessionId, sessionAccess, nestedCompatibility } = deps;

  if (result.interruptions && result.interruptions.length > 0) {
    const interruption = result.interruptions[0];
    const interruptionRecord = asRecord(interruption);
    const callId = getCallIdFromObject(interruption);
    const { toolName, argumentsText, rawArguments } = getToolInfoFromInterruption(interruption);

    const parseResult = parseToolCallArguments(rawArguments, {
      callId: callId ?? 'unknown-call-id',
      toolName,
      sessionId,
      traceId: logger.getCorrelationId() ?? 'trace-unknown',
    });

    if (parseResult.invalidJsonDiagnostic) {
      logger.error('Invalid tool call argument payload', {
        ...createInvalidToolCallDiagnostic(parseResult.invalidJsonDiagnostic),
        sessionId,
        messageId: callId ?? 'unknown-call-id',
      });
      throw new ModelBehaviorError(`Error parsing tool arguments for ${toolName}: arguments must be valid JSON.`);
    }

    // If a sandboxed denied-read retry is pending, force the human prompt (no LLM auto-approval)
    // and attach the denied-read metadata so the UI renders the 4-option prompt.
    const shellCommandForDeniedRead =
      toolName === 'shell' || toolName === 'bash'
        ? (parseResult.arguments as { command?: string } | null)?.command
        : undefined;
    const deniedReadInfo =
      typeof shellCommandForDeniedRead === 'string' && nestedCompatibility?.deniedReads.has(shellCommandForDeniedRead)
        ? nestedCompatibility.deniedReads.consume(shellCommandForDeniedRead)
        : null;
    const hasDeniedRead = deniedReadInfo !== null;
    // Re-stage so prepareContinuation can access the info when the user chooses
    // allow-once / allow-remember / unsandboxed-once for this command.
    if (deniedReadInfo && typeof shellCommandForDeniedRead === 'string') {
      nestedCompatibility?.deniedReads.stageForDescriptor(shellCommandForDeniedRead, deniedReadInfo);
    }

    const forceHumanApproval =
      requiresHumanShellApproval(toolName, parseResult.arguments, sessionId, sessionAccess, nestedCompatibility, {
        // Unsandboxed escapes may be evaluated by the LLM auto-approval path when
        // the sandbox is enabled and auto-approval is in advisory/auto mode.
        llmMayEvaluateUnsandboxed: shellAutoApproval.isUnsandboxedApprovalEligible(),
      }) || hasDeniedRead;
    // Resolved here rather than in the UI: it depends on this session's record of
    // sandbox Docker blocks, and the prompt has no session identity to consult.
    const dockerHostControl = isDockerHostControlShellApproval(
      toolName,
      parseResult.arguments,
      sessionId,
      sessionAccess,
      nestedCompatibility,
    );

    approvalFlow.recordPending({
      state: result.state,
      interruption,
      interruptions: result.interruptions,
      decisionsByCallId: new Map(),
      promptedCallId: callId,
      emittedCommandIds: emittedCommandIds ?? new Set(),
      toolCallArgumentsById: new Map(toolCallArgumentsById),
      owner: approvalFlow.resolveOwner(interruption),
      token: input.token,
      inputMode: input.inputMode,
      cumulativeUsage: input.cumulativeUsage ?? usage ?? extractUsage(result),
      cumulativeCommandMessages: input.cumulativeCommandMessages,
      cumulativeTurnItems: input.cumulativeTurnItems,
    });

    const agent = asRecord(interruptionRecord?.agent);
    const runContext = asRecord(asRecord(result.state)?._context);

    const registryDecision = await toolApprovalPolicyRegistry.evaluate({
      toolName,
      args: parseResult.arguments,
      context: runContext,
    });

    if (
      !forceHumanApproval &&
      !isUnsandboxedShell(toolName, parseResult.arguments) &&
      registryDecision.kind === 'auto_approve'
    ) {
      logger.debug('Tool auto-approved by original tool policy', {
        eventType: 'approval.auto_approved',
        category: 'approval',
        phase: 'approval',
        sessionId,
        callId,
        toolName,
      });

      return {
        kind: 'auto_approve',
        callId,
        argumentsText,
      };
    }

    let llmAdvisory: LLMAdvisory | undefined;
    if ((toolName === 'shell' || toolName === 'bash') && !forceHumanApproval) {
      llmAdvisory = await shellAutoApproval.resolveAdvisoryForInterruption({
        interruption,
        siblings: result.interruptions || [],
      });

      if (shellAutoApproval.shouldAutoApprove(llmAdvisory)) {
        logger.debug('Shell command auto-approved by LLM', {
          eventType: 'approval.auto_approved',
          category: 'approval',
          phase: 'approval',
          sessionId,
          callId,
          command: argumentsText,
          model: llmAdvisory!.model,
          reasoning: llmAdvisory!.reasoning,
        });

        return {
          kind: 'auto_approve',
          advisory: llmAdvisory!,
          callId,
          argumentsText,
        };
      }
    }

    return {
      kind: 'approval_required',
      result: createApprovalRequiredTerminal({
        agentName: getString(agent, 'name') ?? 'Agent',
        toolName: toolName ?? 'Unknown Tool',
        argumentsText,
        rawInterruption: interruption,
        callId: callId ? String(callId) : undefined,
        llmAdvisory,
        dockerHostControl,
        usage: usage ?? extractUsage(result),
        ...(deniedReadInfo
          ? {
              deniedRead: {
                deniedPath: deniedReadInfo.path,
                suggestedParent: deniedReadInfo.suggestedParent,
                sensitive: deniedReadInfo.sensitive,
                command: shellCommandForDeniedRead ?? '',
              } satisfies DeniedReadMetadata,
            }
          : {}),
      }),
    };
  }

  approvalFlow.clearPending();
  shellAutoApproval.clearCache();

  const items = result.newItems || result.history || [];
  const commandMessageItems = attachCachedArguments(items, toolCallArgumentsById);
  const allCommandMessages = extractCommandMessages(commandMessageItems);
  const derivedTurnItems = buildPersistedAssistantTurnItems(items);

  const commandMessages = emittedCommandIds
    ? allCommandMessages.filter((msg) => !emittedCommandIds.has(msg.id))
    : allCommandMessages;

  const visibleCommandMessages = commandMessages;
  // Note: Previously isApprovalRejection messages were filtered out here, which caused
  // denied shell tool executions to be invisible in the UI. They must be preserved so
  // the frontend can render the attempted command and the denial reason.

  return {
    kind: 'response',
    result: {
      type: 'response',
      commandMessages: visibleCommandMessages,
      finalText: resolveFinalText(finalOutputOverride, result.finalOutput),
      reasoningText: reasoningOutputOverride,
      usage: usage ?? extractUsage(result),
      turnItems: derivedTurnItems.length > 0 ? derivedTurnItems : input.turnItems,
    },
  };
}

export const toTerminalEvent = (result: ConversationTerminal): ConversationEvent => {
  if (result.type === 'approval_required') {
    return {
      type: 'approval_required',
      approval: {
        agentName: result.approval.agentName,
        toolName: result.approval.toolName,
        argumentsText: result.approval.argumentsText,
        ...(result.approval.callId ? { callId: result.approval.callId } : {}),
        ...(result.approval.llmAdvisory ? { llmAdvisory: result.approval.llmAdvisory } : {}),
        ...(result.approval.deniedRead ? { deniedRead: result.approval.deniedRead } : {}),
        ...(result.approval.dockerHostControl ? { dockerHostControl: true } : {}),
      },
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  return {
    type: 'final',
    finalText: result.finalText,
    ...(result.reasoningText ? { reasoningText: result.reasoningText } : {}),
    ...(result.commandMessages?.length ? { commandMessages: result.commandMessages } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.turnItems ? { turnItems: result.turnItems } : {}),
  };
};
