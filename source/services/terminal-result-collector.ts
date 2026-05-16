import type { ConversationEvent, FinalResponseEvent } from './conversation-events.js';
import type { ConversationResult } from './conversation-session.js';
import type { CommandMessage } from '../tools/types.js';
import { addTokenUsage, mergeUsage, type NormalizedUsage } from '../utils/token-usage.js';

const USAGE_FIELDS: Array<keyof NormalizedUsage> = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'prompt_ms',
  'completion_ms',
];

const isEmptyUsage = (usage: NormalizedUsage | undefined): boolean => !usage || Object.keys(usage).length === 0;

const sameUsage = (left: NormalizedUsage | undefined, right: NormalizedUsage | undefined): boolean => {
  if (isEmptyUsage(left) && isEmptyUsage(right)) return true;
  if (!left || !right) return false;
  return USAGE_FIELDS.every((field) => left[field] === right[field]);
};

export async function collectTerminalResult(
  events: AsyncIterable<ConversationEvent>,
  {
    onTextChunk,
    onReasoningChunk,
    onCommandMessage,
    onEvent,
    getRawInterruption,
    onFinalEvent,
  }: {
    onTextChunk?: (fullText: string, chunk: string) => void;
    onReasoningChunk?: (fullText: string, chunk: string) => void;
    onCommandMessage?: (message: CommandMessage) => void;
    onEvent?: (event: ConversationEvent) => void;
    getRawInterruption?: () => unknown;
    onFinalEvent?: (event: FinalResponseEvent) => void;
  } = {},
): Promise<ConversationResult> {
  let finalText = '';
  let reasoningText = '';
  const commandMessages: CommandMessage[] = [];
  let completedUsage: NormalizedUsage | undefined;
  let currentTurnUsage: NormalizedUsage | undefined;

  const totalUsage = (): NormalizedUsage | undefined => {
    const combined = addTokenUsage(completedUsage, currentTurnUsage);
    return isEmptyUsage(combined) ? undefined : combined;
  };

  const rollCurrentTurnUsageIntoCompleted = () => {
    if (!currentTurnUsage) {
      return;
    }

    completedUsage = addTokenUsage(completedUsage, currentTurnUsage);
    currentTurnUsage = undefined;
  };

  for await (const event of events) {
    onEvent?.(event);

    switch (event.type) {
      case 'text_delta': {
        const full = event.fullText ?? '';
        onTextChunk?.(full, event.delta);
        break;
      }
      case 'reasoning_delta': {
        const full = event.fullText ?? '';
        onReasoningChunk?.(full, event.delta);
        break;
      }
      case 'command_message': {
        rollCurrentTurnUsageIntoCompleted();
        onCommandMessage?.(event.message);
        break;
      }
      case 'approval_required': {
        const usage = event.usage ?? totalUsage();
        return {
          type: 'approval_required',
          approval: {
            agentName: event.approval.agentName,
            toolName: event.approval.toolName,
            argumentsText: event.approval.argumentsText,
            rawInterruption: getRawInterruption?.(),
            callId: event.approval.callId,
            llmAdvisory: event.approval.llmAdvisory,
          },
          ...(usage ? { usage } : {}),
        };
      }
      case 'usage_update': {
        currentTurnUsage = mergeUsage(event.usage, currentTurnUsage) ?? event.usage;
        break;
      }
      case 'tool_started': {
        rollCurrentTurnUsageIntoCompleted();
        break;
      }
      case 'final': {
        onFinalEvent?.(event);
        finalText = event.finalText;
        reasoningText = event.reasoningText ?? '';
        if (event.usage) {
          const combinedUsage = totalUsage();
          if (sameUsage(event.usage, combinedUsage)) {
            completedUsage = undefined;
            currentTurnUsage = event.usage;
          } else {
            currentTurnUsage = mergeUsage(event.usage, currentTurnUsage) ?? event.usage;
          }
        }
        if (event.commandMessages?.length) {
          for (const msg of event.commandMessages) {
            commandMessages.push(msg);
          }
        }
        break;
      }
      case 'error': {
        // Preserve existing semantics: ignore here and let upstream behavior decide.
        break;
      }
      default:
        break;
    }
  }

  return {
    type: 'response',
    commandMessages,
    finalText: finalText || 'Done.',
    ...(reasoningText ? { reasoningText } : {}),
    ...(totalUsage() ? { usage: totalUsage() } : {}),
  };
}
