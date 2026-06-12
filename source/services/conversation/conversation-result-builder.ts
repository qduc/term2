import type { ConversationEvent } from './conversation-events.js';
import { ModelBehaviorError } from '@openai/agents';
import type { ConversationTerminal, LLMAdvisory } from '../../contracts/conversation.js';
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
import { resolveToolOwner } from '../approval/tool-owner.js';

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
  turnItems?: PersistedAssistantTurnItem[];
  token?: GenerationToken;
  inputMode?: 'delta' | 'full_history';
  cumulativeUsage?: NormalizedUsage;
  cumulativeCommandMessages?: CommandMessage[];
  cumulativeTurnItems?: PersistedAssistantTurnItem[];
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
  const { approvalFlow, shellAutoApproval, logger, sessionId } = deps;

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

    approvalFlow.recordPending({
      state: result.state,
      interruption,
      emittedCommandIds: emittedCommandIds ?? new Set(),
      toolCallArgumentsById: new Map(toolCallArgumentsById),
      owner: resolveToolOwner(result.state, interruption, logger),
      token: input.token,
      inputMode: input.inputMode,
      cumulativeUsage: input.cumulativeUsage,
      cumulativeCommandMessages: input.cumulativeCommandMessages,
      cumulativeTurnItems: input.cumulativeTurnItems,
    });

    const agent = asRecord(interruptionRecord?.agent);

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

  const items = result.newItems || result.history || [];
  attachCachedArguments(items, toolCallArgumentsById);
  const allCommandMessages = extractCommandMessages(items);
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
    ...(result.turnItems ? { turnItems: result.turnItems } : {}),
  };
};
