import type {
  ConversationEvent,
  ConversationEventSink,
  FinalResponseEvent,
} from '../conversation/conversation-events.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';
import type { CommandMessage } from '../../tools/types.js';
import { type NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { ModelRequestCost } from '../cost/model-cost.js';
import type { PersistedAssistantTurnItem } from '../conversation/conversation-persistence-types.js';
import { AmbiguousModelOutcomeError } from '../retry/retry-errors.js';

const isEmptyUsage = (usage: NormalizedUsage | undefined): boolean => !usage || Object.keys(usage).length === 0;

/**
 * The collector observed a stream end before the run loop emitted a terminal
 * event. It is still unsafe to replay, but its provenance lets cancellation
 * handling distinguish this local exhaustion from a provider-origin ambiguity.
 */
export class TerminalResultCollectorExhaustionError extends AmbiguousModelOutcomeError {}

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
    onEvent?: ConversationEventSink;
    getRawInterruption?: () => unknown;
    onFinalEvent?: (event: FinalResponseEvent) => void;
  } = {},
): Promise<ConversationTerminal> {
  let finalText = '';
  let hasFinalEvent = false;
  let reasoningText = '';
  const commandMessages: CommandMessage[] = [];
  const turnItems: PersistedAssistantTurnItem[] = [];
  let currentReasoningBuffer = '';
  let currentTextBuffer = '';

  const flushBuffers = () => {
    if (currentReasoningBuffer) {
      turnItems.push({ type: 'reasoning', text: currentReasoningBuffer });
      currentReasoningBuffer = '';
    }
    if (currentTextBuffer) {
      turnItems.push({ type: 'assistant_text', text: currentTextBuffer });
      currentTextBuffer = '';
    }
  };

  // Token usage is sourced from a single authoritative value: the application
  // run-state accumulator, which is already cumulative for the entire run
  // (every model turn, including turns resumed after an approval - the
  // continuation reuses the same live run state so its accumulator already
  // includes the pre-approval turns). It arrives on `final` /
  // `approval_required` events. We therefore do NOT re-sum per-turn
  // `usage_update` snapshots here; doing so double-counted on long,
  // multi-turn tasks. `usage_update` is tracked only as a live/fallback
  // value for display when a terminal usage figure is unavailable.
  let runUsage: NormalizedUsage | undefined;
  let latestStreamedUsage: NormalizedUsage | undefined;

  // Cost records are cumulative for the run on the same terms as `runUsage`:
  // each terminal event carries every record so far, so the latest one
  // supersedes rather than appends. Without copying them onto the returned
  // terminal the session cost accumulator — and so the status bar — never sees
  // a single record.
  let runCostRecords: ModelRequestCost[] | undefined;

  const resolvedUsage = (): NormalizedUsage | undefined => {
    const usage = !isEmptyUsage(runUsage) ? runUsage : latestStreamedUsage;
    return isEmptyUsage(usage) ? undefined : usage;
  };

  for await (const event of events) {
    await onEvent?.(event);

    switch (event.type) {
      case 'text_delta': {
        const full = event.fullText ?? '';
        onTextChunk?.(full, event.delta);
        if (currentReasoningBuffer) {
          flushBuffers();
        }
        currentTextBuffer += event.delta;
        break;
      }
      case 'reasoning_delta': {
        const full = event.fullText ?? '';
        onReasoningChunk?.(full, event.delta);
        if (currentTextBuffer) {
          flushBuffers();
        }
        currentReasoningBuffer += event.delta;
        break;
      }
      case 'command_message': {
        onCommandMessage?.(event.message);
        break;
      }
      case 'approval_required': {
        const usage = event.usage ?? resolvedUsage();
        const costRecords = event.costRecords?.length ? event.costRecords : runCostRecords;
        return {
          type: 'approval_required',
          approval: {
            agentName: event.approval.agentName,
            toolName: event.approval.toolName,
            argumentsText: event.approval.argumentsText,
            rawInterruption: getRawInterruption?.(),
            callId: event.approval.callId,
            llmAdvisory: event.approval.llmAdvisory,
            postExecute: event.approval.postExecute,
            runBudgetEvent: event.approval.runBudgetEvent,
          },
          ...(usage ? { usage } : {}),
          ...(costRecords?.length ? { costRecords } : {}),
        };
      }
      case 'usage_update': {
        latestStreamedUsage = event.usage;
        break;
      }
      case 'final': {
        onFinalEvent?.(event);
        hasFinalEvent = true;
        finalText = event.finalText;
        reasoningText = event.reasoningText ?? '';
        if (event.usage) {
          // Each `final` carries the run-cumulative usage as of that point.
          // A later `final` (e.g. after an auto-approved continuation)
          // supersedes an earlier one because the run-state accumulator keeps
          // growing on the same run state.
          runUsage = event.usage;
        }
        if (event.costRecords?.length) {
          runCostRecords = event.costRecords;
        }
        if (event.commandMessages?.length) {
          for (const msg of event.commandMessages) {
            commandMessages.push(msg);
          }
        }
        if (event.turnItems) {
          turnItems.length = 0;
          turnItems.push(...event.turnItems);
          currentReasoningBuffer = '';
          currentTextBuffer = '';
        } else {
          flushBuffers();
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

  if (!hasFinalEvent) {
    throw new TerminalResultCollectorExhaustionError(
      'Conversation event stream ended without an authoritative terminal event',
    );
  }

  const usage = resolvedUsage();
  flushBuffers();
  return {
    type: 'response',
    commandMessages,
    finalText,
    ...(reasoningText ? { reasoningText } : {}),
    ...(usage ? { usage } : {}),
    ...(runCostRecords?.length ? { costRecords: runCostRecords } : {}),
    turnItems,
  };
}
