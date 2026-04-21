import type { ConversationEvent, FinalResponseEvent } from './conversation-events.js';
import type { ConversationResult } from './conversation-session.js';
import type { CommandMessage } from '../tools/types.js';
import type { NormalizedUsage } from '../utils/token-usage.js';

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
  let usage: NormalizedUsage | undefined;

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
        onCommandMessage?.(event.message);
        break;
      }
      case 'approval_required': {
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
        };
      }
      case 'final': {
        onFinalEvent?.(event);
        finalText = event.finalText;
        reasoningText = event.reasoningText ?? '';
        usage = event.usage;
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
    ...(usage ? { usage } : {}),
  };
}
