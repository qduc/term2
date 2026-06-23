import type { ILoggingService, ISessionContextService, ISettingsService } from '../service-interfaces.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../../tools/types.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';
import { collectTerminalResult } from '../session/terminal-result-collector.js';
import { getCallIdFromObject } from '../interruption-info.js';
import { normalizeUserTurn, type UserTurn } from '../../types/user-turn.js';
import type { SessionRuntime, SessionLogs, SessionApprovalQuery } from '../session/session-composition.js';
import type { SessionManager } from '../session/session-manager.js';
import type { AskUserAnswerSink, SubagentEventSinkHost } from '../conversation-agent-client.js';

export type SendMessageOptions = {
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: (event: ConversationEvent) => void;
  hallucinationRetryCount?: number;
  bypassInputSurgeGuard?: boolean;
  replayFromHistory?: boolean;
};

export type HandleApprovalDecisionOptions = {
  onTextChunk?: (fullText: string, chunk: string) => void;
  onReasoningChunk?: (fullText: string, chunk: string) => void;
  onCommandMessage?: (message: CommandMessage) => void;
  onEvent?: (event: ConversationEvent) => void;
  approvalAnswer?: string;
};

export type TurnFlow = Pick<SessionRuntime['turns'], 'start' | 'continueAfterApproval'>;

export class ConversationAdapter {
  #sessionId: string;
  #startedAt: string;
  #askUserAnswerSink: AskUserAnswerSink | null;
  #subagentEventSinkHost: SubagentEventSinkHost | null;
  #logger: ILoggingService;
  #settingsService?: ISettingsService;
  #sessionContextService: ISessionContextService;
  #userTurns: Pick<SessionManager, 'listUserTurns'>;
  #logs: SessionLogs;
  #approval: SessionApprovalQuery;
  #turnFlow: TurnFlow;

  constructor(deps: {
    sessionId: string;
    startedAt: string;
    askUserAnswerSink?: AskUserAnswerSink | null;
    subagentEventSinkHost?: SubagentEventSinkHost | null;
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
    userTurns: Pick<SessionManager, 'listUserTurns'>;
    logs: SessionLogs;
    approval: SessionApprovalQuery;
    turnFlow: TurnFlow;
  }) {
    this.#sessionId = deps.sessionId;
    this.#startedAt = deps.startedAt;
    this.#askUserAnswerSink = deps.askUserAnswerSink ?? null;
    this.#subagentEventSinkHost = deps.subagentEventSinkHost ?? null;
    this.#logger = deps.logger;
    this.#settingsService = deps.settingsService;
    this.#sessionContextService = deps.sessionContextService;
    this.#userTurns = deps.userTurns;
    this.#logs = deps.logs;
    this.#approval = deps.approval;
    this.#turnFlow = deps.turnFlow;
  }

  #getFirstUserMessagePreview(currentTurn?: string): string {
    const [firstTurn] = this.#userTurns.listUserTurns();
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
    {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      hallucinationRetryCount = 0,
      bypassInputSurgeGuard,
      replayFromHistory,
    }: SendMessageOptions = {},
  ): Promise<ConversationTerminal> {
    const turn = normalizeUserTurn(input);
    return this.#withTrafficContext(turn.text, async () => {
      const wrappedOnEvent = (event: ConversationEvent) => {
        this.#logs.dispatchEventToLog(event);
        onEvent?.(event);
      };
      this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
      let result: ConversationTerminal;
      try {
        const startOptions: any = { retries: { hallucinationRetryCount } };
        if (bypassInputSurgeGuard !== undefined) {
          startOptions.bypassInputSurgeGuard = bypassInputSurgeGuard;
        }
        if (replayFromHistory) {
          startOptions.replayFromHistory = true;
        }
        result = await collectTerminalResult(this.#turnFlow.start(input, startOptions), {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent: wrappedOnEvent,
          getRawInterruption: () => this.#approval.getPendingInterruption(),
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
    if (!this.#approval.getPending()) {
      return null;
    }

    if (answer === 'y' && approvalAnswer) {
      const pending = this.#approval.getPending();
      const callId = pending ? getCallIdFromObject(pending.interruption) : undefined;
      if (callId) {
        this.#askUserAnswerSink?.setAskUserAnswer(callId, approvalAnswer);
      }
    }

    this.#logs.log({
      type: 'approval_resolved',
      answer: answer === 'y' ? 'y' : 'n',
      ...(rejectionReason ? { rejectionReason } : {}),
    });
    return this.#withTrafficContext(undefined, async () => {
      const wrappedOnEvent = (event: ConversationEvent) => {
        this.#logs.dispatchEventToLog(event);
        onEvent?.(event);
      };
      this.#subagentEventSinkHost?.setSubagentEventSink(wrappedOnEvent);
      let result: ConversationTerminal | null;
      try {
        result = await collectTerminalResult(this.#turnFlow.continueAfterApproval({ answer, rejectionReason }), {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent: wrappedOnEvent,
          getRawInterruption: () => this.#approval.getPendingInterruption(),
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
