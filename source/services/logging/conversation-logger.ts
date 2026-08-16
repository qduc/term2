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
  private journal: AssistantTurnJournal;

  constructor(opts: {
    turnAccumulator: TurnItemAccumulator;
    logger: ILoggingService;
    getAssistantTurnState: () => AssistantTurnState;
    getCurrentTurnId?: () => string;
    getToolLedger?: () => SavedToolExecution[];
    journal: AssistantTurnJournal;
  }) {
    this.turnAccumulator = opts.turnAccumulator;
    this.logger = opts.logger;
    this.getAssistantTurnState = opts.getAssistantTurnState;
    this.getCurrentTurnId = opts.getCurrentTurnId;
    this.getToolLedger = opts.getToolLedger;
    this.journal = opts.journal;
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
    switch (event.type) {
      case 'usage_update':
        this.turnAccumulator.setDisplayUsage(event.usage);
        return;
      case 'text_delta':
        if (this.turnAccumulator.hasReasoningBuffer()) {
          this.turnAccumulator.flushReasoningItem();
        }
        this.turnAccumulator.appendTextDelta(event.delta);
        this.journal.recordTextDelta(event.delta);
        return;
      case 'reasoning_delta':
        if (this.turnAccumulator.hasTextBuffer()) {
          this.turnAccumulator.flushAssistantTextItem();
        }
        this.turnAccumulator.appendReasoningDelta(event.delta);
        this.journal.recordReasoningDelta(event.delta);
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
          ...(event.parentTool !== undefined ? { parentTool: event.parentTool } : {}),
          async: event.async,
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
        this.log({
          type: 'subagent_completed',
          result: event.result,
          ...(event.result.costRecords && event.result.costRecords.length > 0
            ? { costRecords: event.result.costRecords }
            : {}),
        });
        return;
      case 'subagent_interrupted':
        this.log({
          type: 'subagent_interrupted',
          agentId: event.agentId,
          role: event.role,
          finalText: event.finalText,
        });
        return;
      case 'subagent_transferred':
        this.log({
          type: 'subagent_transferred',
          agentId: event.agentId,
          runId: event.runId,
          role: event.role,
        });
        return;
      case 'subagent_question':
        this.log({
          type: 'subagent_question',
          messageId: event.messageId,
          runId: event.runId,
          ...(event.name !== undefined ? { name: event.name } : {}),
          role: event.role,
          question: event.question,
        });
        return;
      case 'background_shell_started':
        this.log({ type: 'background_shell_started', jobId: event.jobId, command: event.command });
        return;
      case 'background_shell_completed':
        this.log({
          type: 'background_shell_completed',
          jobId: event.jobId,
          command: event.command,
          status: event.status,
          output: event.output,
          ...(event.error ? { error: event.error } : {}),
        });
        return;
      case 'background_shell_output':
        this.log({
          type: 'background_shell_output',
          jobId: event.jobId,
          command: event.command,
          watchId: event.watchId,
          seq: event.seq,
          matchedLines: event.matchedLines,
          ...(event.coalescedCount !== undefined ? { coalescedCount: event.coalescedCount } : {}),
          ...(event.seqRange !== undefined ? { seqRange: event.seqRange } : {}),
          ...(event.droppedBytes !== undefined ? { droppedBytes: event.droppedBytes } : {}),
        });
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
          ...(event.costRecords && event.costRecords.length > 0 ? { costRecords: event.costRecords } : {}),
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
      case 'openai_root_selector_parity':
      case 'openai_root_checkpoint_lifecycle':
      case 'assistant_turn':
        return { ...event, turnId };
      default:
        return event;
    }
  }
}
