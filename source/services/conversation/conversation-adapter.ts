import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../../tools/types.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';
import { collectTerminalResult } from '../session/terminal-result-collector.js';
import { getCallIdFromObject } from '../interruption-info.js';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';
import type { ConversationLogger } from '../logging/conversation-logger.js';
import type { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import type { AskUserAnswerSink, SubagentEventSinkHost } from '../conversation-agent-client.js';
import type { ConversationStore } from './conversation-store.js';

export type SendMessageOptions = {
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: (event: ConversationEvent) => void;
  hallucinationRetryCount?: number;
};

export type HandleApprovalDecisionOptions = {
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: (event: ConversationEvent) => void;
  approvalAnswer?: string;
};

export class ConversationAdapter {
  #sessionId: string;
  #startedAt: string;
  #askUserAnswerSink: AskUserAnswerSink | null;
  #subagentEventSinkHost: SubagentEventSinkHost | null;
  #logger: ILoggingService;
  #settingsService?: ISettingsService;
  #sessionContextService: ISessionContextService;
  #conversationStore: ConversationStore;
  #conversationLogger: ConversationLogger;
  #approvalFlow: ApprovalFlowCoordinator;
  #run: (
    input: string | UserTurn,
    options?: { retries?: { hallucinationRetryCount?: number } },
  ) => AsyncIterable<ConversationEvent>;
  #continueAfterApproval: (options: { answer: string; rejectionReason?: string }) => AsyncIterable<ConversationEvent>;

  constructor(deps: {
    sessionId: string;
    startedAt: string;
    askUserAnswerSink?: AskUserAnswerSink | null;
    subagentEventSinkHost?: SubagentEventSinkHost | null;
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
    conversationStore: ConversationStore;
    conversationLogger: ConversationLogger;
    approvalFlow: ApprovalFlowCoordinator;
    run: (
      input: string | UserTurn,
      options?: { retries?: { hallucinationRetryCount?: number } },
    ) => AsyncIterable<ConversationEvent>;
    continueAfterApproval: (options: { answer: string; rejectionReason?: string }) => AsyncIterable<ConversationEvent>;
  }) {
    this.#sessionId = deps.sessionId;
    this.#startedAt = deps.startedAt;
    this.#askUserAnswerSink = deps.askUserAnswerSink ?? null;
    this.#subagentEventSinkHost = deps.subagentEventSinkHost ?? null;
    this.#logger = deps.logger;
    this.#settingsService = deps.settingsService;
    this.#sessionContextService = deps.sessionContextService;
    this.#conversationStore = deps.conversationStore;
    this.#conversationLogger = deps.conversationLogger;
    this.#approvalFlow = deps.approvalFlow;
    this.#run = deps.run;
    this.#continueAfterApproval = deps.continueAfterApproval;
  }

  #getFirstUserMessagePreview(currentTurn?: string): string {
    const [firstTurn] = this.#conversationStore.listUserTurns();
    return firstTurn?.text ?? currentTurn ?? '';
  }

  #getTrafficMode(): string {
    if (!this.#settingsService) return 'standard';
    if (this.#settingsService.get<boolean>('app.orchestratorMode')) return 'orchestrator';
    if (this.#settingsService.get<boolean>('app.liteMode')) return 'lite';
    if (this.#settingsService.get<boolean>('app.planMode')) return 'plan';
    if (this.#settingsService.get<boolean>('app.mentorMode')) return 'mentor';
    return 'standard';
  }

  #withTrafficContext<T>(currentTurn: string | undefined, fn: () => T): T {
    const mode = this.#getTrafficMode();
    return this.#sessionContextService.runWithContext(
      {
        sessionId: this.#sessionId,
        sessionStartedAt: this.#startedAt,
        firstUserMessagePreview: this.#getFirstUserMessagePreview(currentTurn),
        mode,
        traceId: this.#logger.getCorrelationId(),
      },
      fn,
    );
  }

  async sendMessage(
    input: string | UserTurn,
    { onTextChunk, onReasoningChunk, onCommandMessage, onEvent, hallucinationRetryCount = 0 }: SendMessageOptions = {},
  ): Promise<ConversationTerminal> {
    const turn = normalizeUserTurn(input);
    return this.#withTrafficContext(turn.text, async () => {
      const wrappedOnEvent = (event: ConversationEvent) => {
        this.#conversationLogger.dispatchEventToLog(event);
        onEvent?.(event);
      };
      this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
      let result: ConversationTerminal;
      try {
        result = await collectTerminalResult(this.#run(input, { retries: { hallucinationRetryCount } }), {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent: wrappedOnEvent,
          getRawInterruption: () => this.#approvalFlow.getPendingInterruption(),
          onFinalEvent: (event) => {
            this.#logger.debug('sendMessage received final event', {
              sessionId: this.#sessionId,
              hasUsage: Boolean(event.usage),
              usage: event.usage,
            });
          },
        });
      } finally {
        this.#subagentEventSinkHost?.setSubagentEventSink(null);
      }

      if (result.type === 'response') {
        this.#logger.debug('sendMessage returning response', {
          sessionId: this.#sessionId,
          hasUsage: Boolean(result.usage),
          usage: result.usage,
        });
      }

      return result;
    });
  }

  async handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    { onTextChunk, onReasoningChunk, onCommandMessage, onEvent, approvalAnswer }: HandleApprovalDecisionOptions = {},
  ): Promise<ConversationTerminal | null> {
    if (!this.#approvalFlow.getPending()) {
      return null;
    }

    if (answer === 'y' && approvalAnswer) {
      const pending = this.#approvalFlow.getPending();
      const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
      if (callId) {
        this.#askUserAnswerSink?.setAskUserAnswer(callId, approvalAnswer);
      }
    }

    this.#conversationLogger.log({
      type: 'approval_resolved',
      answer: answer === 'y' ? 'y' : 'n',
      ...(rejectionReason ? { rejectionReason } : {}),
    });
    return this.#withTrafficContext(undefined, async () => {
      const wrappedOnEvent = (event: ConversationEvent) => {
        this.#conversationLogger.dispatchEventToLog(event);
        onEvent?.(event);
      };
      this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
      let result: ConversationTerminal | null;
      try {
        result = await collectTerminalResult(this.#continueAfterApproval({ answer, rejectionReason }), {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent: wrappedOnEvent,
          getRawInterruption: () => this.#approvalFlow.getPendingInterruption(),
          onFinalEvent: (event) => {
            this.#logger.debug('handleApprovalDecision received final event', {
              sessionId: this.#sessionId,
              hasUsage: Boolean(event.usage),
              usage: event.usage,
            });
          },
        });
      } finally {
        this.#subagentEventSinkHost?.setSubagentEventSink(null);
      }

      if (result && result.type === 'response') {
        this.#logger.debug('handleApprovalDecision returning response', {
          sessionId: this.#sessionId,
          hasUsage: Boolean(result.usage),
          usage: result.usage,
        });
      }

      return result;
    });
  }
}
