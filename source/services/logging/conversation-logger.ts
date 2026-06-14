import type { ILoggingService } from '../service-interfaces.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { AssistantTurnState, LogEvent } from './conversation-log-events.js';
import { TurnItemAccumulator } from '../session/turn-item-accumulator.js';
import type {
  PersistedAssistantTurn,
  PersistedAssistantTurnItem,
} from '../conversation/conversation-persistence-types.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import type { AssistantTurnJournal } from './assistant-turn-journal.js';

export class ConversationLogger {
  private logSink: ((event: LogEvent) => void) | null = null;
  private turnAccumulator: TurnItemAccumulator;
  private logger: ILoggingService;
  private getAssistantTurnState: () => AssistantTurnState;
  private getCurrentTurnId?: () => string;
  private getToolLedger?: () => SavedToolExecution[];
  private getJournal?: () => AssistantTurnJournal | undefined;

  constructor(opts: {
    turnAccumulator: TurnItemAccumulator;
    logger: ILoggingService;
    getAssistantTurnState: () => AssistantTurnState;
    getCurrentTurnId?: () => string;
    getToolLedger?: () => SavedToolExecution[];
    getJournal?: () => AssistantTurnJournal | undefined;
  }) {
    this.turnAccumulator = opts.turnAccumulator;
    this.logger = opts.logger;
    this.getAssistantTurnState = opts.getAssistantTurnState;
    this.getCurrentTurnId = opts.getCurrentTurnId;
    this.getToolLedger = opts.getToolLedger;
    this.getJournal = opts.getJournal;
  }

  setLogSink(sink: ((event: LogEvent) => void) | null): void {
    this.logSink = sink;
  }

  hasSink(): boolean {
    return this.logSink !== null;
  }

  log(event: LogEvent): void {
    if (!this.logSink) return;
    try {
      this.logSink(this.#withTurnId(event));
    } catch (err: any) {
      this.logger.warn('Conversation log sink threw', {
        eventType: 'conversation_log.sink_failed',
        category: 'persistence',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  dispatchEventToLog(event: ConversationEvent): void {
    if (!this.logSink) return;
    const journal = this.getJournal?.();
    switch (event.type) {
      case 'usage_update':
        this.turnAccumulator.setDisplayUsage(event.usage);
        return;
      case 'text_delta':
        if (this.turnAccumulator.hasReasoningBuffer()) {
          this.turnAccumulator.flushReasoningItem();
        }
        this.turnAccumulator.appendTextDelta(event.delta);
        journal?.recordTextDelta(event.delta);
        return;
      case 'reasoning_delta':
        if (this.turnAccumulator.hasTextBuffer()) {
          this.turnAccumulator.flushAssistantTextItem();
        }
        this.turnAccumulator.appendReasoningDelta(event.delta);
        journal?.recordReasoningDelta(event.delta);
        return;
      case 'tool_started':
        this.turnAccumulator.recordToolCallItem(event.toolCallId, event.toolName, event.arguments);
        this.log({
          type: 'tool_started',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
        });
        return;
      case 'command_message':
        this.log({ type: 'command_message', message: event.message });
        if (
          event.message.callId &&
          event.message.toolName &&
          (event.message.status === 'completed' || event.message.status === 'failed')
        ) {
          this.turnAccumulator.recordToolResultItem(
            event.message.callId,
            event.message.toolName,
            event.message.status === 'failed' ? 'failed' : 'completed',
            event.message.output,
          );
        }
        return;
      case 'approval_required':
        this.log({
          type: 'approval_required',
          approval: {
            toolName: event.approval.toolName,
            argumentsText: event.approval.argumentsText,
            agentName: event.approval.agentName,
            ...('callId' in event.approval && event.approval.callId ? { callId: event.approval.callId as string } : {}),
          },
        });
        return;
      case 'subagent_started':
        this.log({
          type: 'subagent_started',
          agentId: event.agentId,
          role: event.role,
          task: event.task,
        });
        return;
      case 'subagent_tool_started':
        this.log({
          type: 'subagent_tool_started',
          agentId: event.agentId,
          role: event.role,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
        });
        return;
      case 'subagent_completed':
        this.log({ type: 'subagent_completed', result: event.result });
        return;
      case 'error':
        this.turnAccumulator.flushReasoningItem();
        this.turnAccumulator.flushAssistantTextItem();
        if (this.turnAccumulator.getTurnItems().length > 0) {
          const turnState = this.getAssistantTurnState();
          this.log({
            type: 'assistant_turn',
            turn: { items: [...this.turnAccumulator.getTurnItems()] },
            ...(this.turnAccumulator.getDisplayUsage() ? { displayUsage: this.turnAccumulator.getDisplayUsage() } : {}),
            state: {
              ...turnState,
              previousResponseId: null,
            },
          });
          this.turnAccumulator.resetPersistedTurnState();
        }
        this.log({
          type: 'error',
          message: event.message,
          ...(event.kind ? { kind: event.kind } : {}),
          ...(event.stack ? { stack: event.stack } : {}),
        });
        return;
      case 'final': {
        const turnState = this.getAssistantTurnState();
        const toolLedger = this.getToolLedger?.();
        this.turnAccumulator.flushReasoningItem();
        this.turnAccumulator.flushAssistantTextItem();

        const turnItemsToLog: PersistedAssistantTurnItem[] = event.turnItems
          ? [...event.turnItems]
          : [...this.turnAccumulator.getTurnItems()];
        if (event.finalText && !turnItemsToLog.some((item) => item.type === 'assistant_text')) {
          turnItemsToLog.push({
            type: 'assistant_text',
            text: event.finalText,
          });
        }

        if (toolLedger) {
          for (const item of turnItemsToLog) {
            if (item.type === 'tool_result') {
              const exists = toolLedger.some((t) => t.callId === item.callId);
              if (!exists) {
                this.logger.warn(`Invariant violation: tool_result callId ${item.callId} not found in toolLedger`);
              }
            }
          }
        }

        const turn: PersistedAssistantTurn = {
          items: turnItemsToLog,
        };

        this.log({
          type: 'assistant_turn',
          turn,
          ...(event.usage ? { usage: event.usage } : {}),
          ...(this.turnAccumulator.getDisplayUsage() ? { displayUsage: this.turnAccumulator.getDisplayUsage() } : {}),
          state: turnState,
        });

        this.turnAccumulator.resetPersistedTurnState();
        return;
      }
      default:
        return;
    }
  }

  #withTurnId(event: LogEvent): LogEvent {
    const turnId = this.getCurrentTurnId?.();
    if (!turnId) {
      return event;
    }

    switch (event.type) {
      case 'tool_started':
      case 'tool_result':
      case 'approval_required':
      case 'approval_resolved':
      case 'assistant_turn':
        return { ...event, turnId };
      default:
        return event;
    }
  }
}
