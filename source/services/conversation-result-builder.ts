import type { ConversationEvent } from './conversation-events.js';
import type { ConversationTerminal, LLMAdvisory } from '../contracts/conversation.js';
import type { ILoggingService } from './service-interfaces.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import { extractUsage } from '../utils/token-usage.js';
import { extractCommandMessages } from '../utils/extract-command-messages.js';
import { asRecord, getCallIdFromObject, getString, getToolInfoFromInterruption } from './interruption-info.js';
import type { AgentStream } from './agent-stream.js';
import type { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import type { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';

export type ConversationResult = ConversationTerminal;

export type BuildResultOutcome =
  | { kind: 'response'; result: Extract<ConversationResult, { type: 'response' }> }
  | { kind: 'approval_required'; result: Extract<ConversationResult, { type: 'approval_required' }> }
  | {
      kind: 'auto_approve';
      advisory: LLMAdvisory;
      callId: string | undefined;
      argumentsText: string;
    };

export interface ResultBuilderDeps {
  approvalFlow: ApprovalFlowCoordinator;
  shellAutoApproval: ShellAutoApprovalResolver;
  logger: ILoggingService;
  sessionId: string;
}

export interface ResultBuilderInput {
  result: AgentStream;
  finalOutputOverride?: string;
  reasoningOutputOverride?: string;
  emittedCommandIds?: Set<string>;
  usage?: NormalizedUsage;
  toolCallArgumentsById: Map<string, unknown>;
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

const hasPendingNestedAgentToolRun = (state: unknown, logger?: ILoggingService): boolean => {
  if (state == null) {
    return false;
  }
  const stateRecord = state as Record<string, unknown>;
  if (!('_pendingAgentToolRuns' in stateRecord)) {
    logger?.warn(
      'SDK field _pendingAgentToolRuns is absent from agent state — the SDK may have renamed or restructured this field. Nested subagent detection will default to false. Update the integration if the SDK was upgraded.',
    );
    return false;
  }
  const pendingAgentToolRuns = stateRecord._pendingAgentToolRuns;
  return pendingAgentToolRuns instanceof Map && pendingAgentToolRuns.size > 0;
};

export async function buildConversationResult(
  input: ResultBuilderInput,
  deps: ResultBuilderDeps,
): Promise<BuildResultOutcome> {
  const { result, finalOutputOverride, reasoningOutputOverride, emittedCommandIds, usage, toolCallArgumentsById } =
    input;
  const { approvalFlow, shellAutoApproval, logger, sessionId } = deps;

  if (result.interruptions && result.interruptions.length > 0) {
    const interruption = result.interruptions[0];
    const interruptionRecord = asRecord(interruption);

    approvalFlow.recordPending({
      state: result.state,
      interruption,
      emittedCommandIds: emittedCommandIds ?? new Set(),
      toolCallArgumentsById: new Map(toolCallArgumentsById),
      nestedSubagent: hasPendingNestedAgentToolRun(result.state, logger),
    });

    const agent = asRecord(interruptionRecord?.agent);
    const callId = getCallIdFromObject(interruption);
    const { toolName, argumentsText } = getToolInfoFromInterruption(interruption);

    let llmAdvisory: LLMAdvisory | undefined;
    if (toolName === 'shell' || toolName === 'bash') {
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
      result: {
        type: 'approval_required',
        approval: {
          agentName: getString(agent, 'name') ?? 'Agent',
          toolName: toolName ?? 'Unknown Tool',
          argumentsText,
          rawInterruption: interruption,
          ...(callId ? { callId: String(callId) } : {}),
          llmAdvisory,
        },
        usage: usage ?? extractUsage(result),
      },
    };
  }

  approvalFlow.clearPending();
  shellAutoApproval.clearCache();

  const allCommandMessages = extractCommandMessages(result.newItems || result.history || []);

  const commandMessages = emittedCommandIds
    ? allCommandMessages.filter((msg) => !emittedCommandIds.has(msg.id))
    : allCommandMessages;

  const visibleCommandMessages = commandMessages.filter((msg) => !msg.isApprovalRejection);

  return {
    kind: 'response',
    result: {
      type: 'response',
      commandMessages: visibleCommandMessages,
      finalText: resolveFinalText(finalOutputOverride, result.finalOutput),
      reasoningText: reasoningOutputOverride,
      usage: usage ?? extractUsage(result),
    },
  };
}

export const toTerminalEvent = (result: ConversationResult): ConversationEvent => {
  if (result.type === 'approval_required') {
    return {
      type: 'approval_required',
      approval: {
        agentName: result.approval.agentName,
        toolName: result.approval.toolName,
        argumentsText: result.approval.argumentsText,
        ...(result.approval.callId ? { callId: result.approval.callId } : {}),
        ...(result.approval.llmAdvisory ? { llmAdvisory: result.approval.llmAdvisory } : {}),
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
  };
};
