import type { ConversationEvent, FinalResponseEvent } from './conversation-events.js';
import type { ConversationResult } from './conversation-session.js';
import type { CommandMessage } from '../tools/types.js';
import { type NormalizedUsage } from '../utils/token-usage.js';

const isEmptyUsage = (usage: NormalizedUsage | undefined): boolean => !usage || Object.keys(usage).length === 0;

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

  // Token usage is sourced from a single authoritative value: the Agents SDK
  // run-state accumulator, which is already cumulative for the entire run
  // (every model turn, including turns resumed after an approval - the
  // continuation reuses the same live RunState so its accumulator already
  // includes the pre-approval turns). It arrives on `final` /
  // `approval_required` events. We therefore do NOT re-sum per-turn
  // `usage_update` snapshots here; doing so double-counted on long,
  // multi-turn tasks. `usage_update` is tracked only as a live/fallback
  // value for display when a terminal usage figure is unavailable.
  let runUsage: NormalizedUsage | undefined;
  let latestStreamedUsage: NormalizedUsage | undefined;

  const resolvedUsage = (): NormalizedUsage | undefined => {
    const usage = !isEmptyUsage(runUsage) ? runUsage : latestStreamedUsage;
    return isEmptyUsage(usage) ? undefined : usage;
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
        onCommandMessage?.(event.message);
        break;
      }
      case 'approval_required': {
        const usage = event.usage ?? resolvedUsage();
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
        latestStreamedUsage = event.usage;
        break;
      }
      case 'final': {
        onFinalEvent?.(event);
        finalText = event.finalText;
        reasoningText = event.reasoningText ?? '';
        if (event.usage) {
          // Each `final` carries the run-cumulative usage as of that point.
          // A later `final` (e.g. after an auto-approved continuation)
          // supersedes an earlier one because the SDK accumulator keeps
          // growing on the same run state.
          runUsage = event.usage;
        }
        if (event.commandMessages?.length) {
          for (const msg of event.commandMessages) {
            commandMessages.push(msg);
          }
        }
        break;
      }
      case 'error': {
        const parts = [event.message || '(no message)', event.kind ? `kind=${event.kind}` : ''].filter(Boolean);
        const err = new Error(parts.join(' '));
        // Preserve the raw event so callers can inspect it without re-parsing the message.
        (err as any).eventKind = event.kind;
        (err as any).rawEvent = event;
        if (event.stack) {
          const stackLines = event.stack.split('\n');
          const firstFrameIndex = stackLines.findIndex((line) => line.trim().startsWith('at '));
          if (firstFrameIndex !== -1) {
            const frames = stackLines.slice(firstFrameIndex);
            err.stack = `${err.name}: ${err.message}\n${frames.join('\n')}`;
          } else {
            err.stack = event.stack;
          }
        }
        throw err;
      }
      default:
        break;
    }
  }

  const usage = resolvedUsage();
  return {
    type: 'response',
    commandMessages,
    finalText: finalText || 'Done.',
    ...(reasoningText ? { reasoningText } : {}),
    ...(usage ? { usage } : {}),
  };
}
