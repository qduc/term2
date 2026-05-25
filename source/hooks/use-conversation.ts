import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationService } from '../services/conversation-service.js';
import { isAbortLikeError } from '../utils/error-helpers.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { appendMessagesCapped } from '../utils/message-buffer.js';
import { createMessageId } from './message-id.js';
import { enhanceApiKeyError, isMaxTurnsError } from '../utils/conversation-utils.js';
import { createStreamingSession } from '../utils/streaming-session-factory.js';
import type { CommandMessage as BaseCommandMessage } from '../tools/types.js';
import type { NormalizedUsage, UsageAccumulator } from '../utils/token-usage.js';
import type { CodexRateLimitInfo } from '../services/conversation-events.js';
import type { ConversationTerminal, PendingApproval, ReasoningEffortSetting } from '../contracts/conversation.js';
import { useSetting } from './use-setting.js';
import type { SettingsService } from '../services/settings-service.js';
import {
  annotateApprovedCommandMessage,
  filterPendingCommandMessagesForApproval,
  type ApprovedToolContext,
} from '../services/approval-presentation-policy.js';
import { formatUserTurnForDisplay, hasUserTurnContent, normalizeUserTurn, type UserTurn } from '../types/user-turn.js';

export interface UserMessage {
  id: string;
  sender: 'user';
  text: string;
}

export interface BotMessage {
  id: string;
  sender: 'bot';
  text: string;
  status?: 'streaming' | 'finalized';
  reasoningText?: string;
}

export type CommandMessage = BaseCommandMessage & {
  hadApproval?: boolean;
};

export interface SystemMessage {
  id: string;
  sender: 'system';
  text: string;
}

export interface ReasoningMessage {
  id: string;
  sender: 'reasoning';
  text: string;
}

export interface SubagentActivityMessage {
  id: string;
  sender: 'subagent';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  agentId: string;
  role: string;
  task: string;
  tools: string[];
}

export type Message =
  | UserMessage
  | BotMessage
  | CommandMessage
  | SystemMessage
  | ReasoningMessage
  | SubagentActivityMessage;

const REASONING_RESPONSE_THROTTLE_MS = 200;
const MAX_MESSAGE_COUNT = 300;

const dummySettingsService = {
  get: () => 'openai',
  onChange: () => () => {},
} as any;

export const useConversation = ({
  conversationService,
  loggingService,
  usageAccumulator,
  subagentUsageAccumulator,
  initialMessages = [],
  sessionId,
  onClear,
  settingsService,
}: {
  conversationService: ConversationService;
  loggingService: ILoggingService;
  usageAccumulator?: UsageAccumulator;
  subagentUsageAccumulator?: UsageAccumulator;
  initialMessages?: Message[];
  sessionId?: string;
  onClear?: () => void | Promise<void>;
  settingsService?: SettingsService;
}) => {
  const [messages, setMessages] = useState<Message[]>(() =>
    appendMessagesCapped([], initialMessages, MAX_MESSAGE_COUNT),
  );
  const [waitingForApproval, setWaitingForApproval] = useState<boolean>(false);
  const [waitingForRejectionReason, setWaitingForRejectionReason] = useState<boolean>(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [lastUsage, setLastUsage] = useState<NormalizedUsage | null>(null);
  const [lastCodexRateLimit, setLastCodexRateLimit] = useState<CodexRateLimitInfo | null>(null);
  const setCodexRateLimit = setLastCodexRateLimit;
  const approvedContextRef = useRef<ApprovedToolContext | null>(null);
  const trimMessages = useCallback((list: Message[]) => appendMessagesCapped(list, [], MAX_MESSAGE_COUNT), []);

  const provider = useSetting<string>(settingsService || dummySettingsService, 'agent.provider') ?? 'openai';

  useEffect(() => {
    setLastCodexRateLimit(null);
  }, [provider]);

  const appendMessages = useCallback(
    (additions: Message[]) => {
      if (!additions.length) return;
      setMessages((prev) => trimMessages([...prev, ...additions]));
    },
    [trimMessages],
  );

  const annotateCommandMessage = useCallback((cmdMsg: CommandMessage): CommandMessage => {
    const approvedMessage = annotateApprovedCommandMessage(cmdMsg, approvedContextRef.current);
    const matchedByToolName =
      approvedMessage !== cmdMsg &&
      !approvedContextRef.current?.callId &&
      Boolean(approvedContextRef.current?.toolName) &&
      approvedContextRef.current?.toolName === cmdMsg.toolName;

    if (matchedByToolName) {
      approvedContextRef.current = null;
    }

    return approvedMessage;
  }, []);

  const createOnEventWithSubagentTracking = useCallback(
    (baseOnEvent: (event: any) => void) => {
      return (event: any) => {
        baseOnEvent(event);
        if (subagentUsageAccumulator && event?.type === 'subagent_completed' && event?.result?.usage) {
          subagentUsageAccumulator.add(event.result.usage);
        }
      };
    },
    [subagentUsageAccumulator],
  );

  const applyServiceResult = useCallback(
    (result: ConversationTerminal | null, textWasFlushed: boolean, latestStreamedUsage?: NormalizedUsage | null) => {
      if (!result) {
        return;
      }

      if (result.type === 'approval_required') {
        if (result.usage) {
          // result.usage here is the run-cumulative usage *so far* for a run
          // that is still in progress (paused for approval). The terminal
          // `response` result will carry the full run-cumulative usage once
          // the run completes, so accumulating here would double-count the
          // pre-approval turns. Only update the live footer.
          setLastUsage(latestStreamedUsage ?? result.usage);
        }
        // Don't also show the transient pending/running command message.
        setMessages((prev) => trimMessages(filterPendingCommandMessagesForApproval(prev, result.approval)));
        setPendingApproval({
          ...result.approval,
          llmAdvisory: (result.approval as any).llmAdvisory,
        });
        // Set waiting state AFTER adding approval message to ensure proper render order
        setWaitingForApproval(true);
        return;
      }

      const finalText = result.finalText;

      setMessages((prev) => {
        const annotatedCommands = result.commandMessages.map(annotateCommandMessage);
        // Remove stale running/pending messages that are about to be replaced
        // by completed ones (e.g. after a denied tool where a "running" message
        // was shown during streaming but the final result never cleaned it up).
        const completedCallIds = new Set(annotatedCommands.filter((m) => m.callId).map((m) => m.callId));
        const cleaned =
          completedCallIds.size > 0
            ? prev.filter((msg) => {
                if (msg.sender !== 'command') return true;
                const cmd = msg as CommandMessage;
                if (cmd.status !== 'running' && cmd.status !== 'pending') return true;
                return !cmd.callId || !completedCallIds.has(cmd.callId);
              })
            : prev;
        let next = [...cleaned, ...annotatedCommands];

        // Append finalText only when streaming never pushed it via text_delta/final events.
        // Providers that skip streaming (synchronous or non-interactive) may return text
        // solely in result.finalText without emitting any text_delta events.
        if (finalText?.trim() && !textWasFlushed) {
          const botMessage: Message = {
            id: createMessageId(),
            sender: 'bot',
            status: 'finalized',
            text: finalText,
          };
          next = [...next, botMessage];
        }

        return trimMessages(next);
      });
      setWaitingForApproval(false);
      setPendingApproval(null);
      if (result.usage) {
        usageAccumulator?.add(result.usage);
        setLastUsage(latestStreamedUsage ?? result.usage);
      }
    },
    [annotateCommandMessage, trimMessages, usageAccumulator],
  );

  const sendUserMessage = useCallback(
    async (input: string | UserTurn) => {
      const turn = normalizeUserTurn(input);
      if (!hasUserTurnContent(turn)) {
        return;
      }

      const userMessage: UserMessage = {
        id: createMessageId(),
        sender: 'user',
        text: formatUserTurnForDisplay(turn),
      };
      appendMessages([userMessage]);
      setIsProcessing(true);

      const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
        createStreamingSession<Message>(
          {
            appendMessages,
            setMessages,
            trimMessages,
            annotateCommandMessage,
            loggingService,
            setLastUsage,
            setCodexRateLimit,
            reasoningThrottleMs: REASONING_RESPONSE_THROTTLE_MS,
          },
          'sendUserMessage',
        );

      try {
        const result = await conversationService.sendMessage(turn, {
          onEvent: createOnEventWithSubagentTracking(applyConversationEvent),
        });

        applyConversationEvent({ type: 'final', finalText: '' } as any);
        applyServiceResult(result, streamingState.textWasFlushed, streamingState.latestUsage);
      } catch (error) {
        loggingService.error('Error in sendUserMessage', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Don't show error messages for user-initiated aborts
        if (isAbortLikeError(error)) {
          loggingService.debug('Suppressing abort error in sendUserMessage');
          // The finally block will handle cleanup
          return;
        }

        const rawErrorMessage = error instanceof Error ? error.message : String(error);
        const errorMessage = enhanceApiKeyError(rawErrorMessage);

        if (isMaxTurnsError(errorMessage)) {
          // Create an approval prompt for max turns continuation
          setPendingApproval({
            agentName: 'System',
            toolName: 'max_turns_exceeded',
            argumentsText: errorMessage,
            rawInterruption: null,
            isMaxTurnsPrompt: true,
          });
          setWaitingForApproval(true);
        } else {
          // For other errors, just show the error message
          const botErrorMessage: BotMessage = {
            id: createMessageId(),
            sender: 'bot',
            status: 'finalized',
            text: `Error: ${errorMessage}`,
          };
          appendMessages([botErrorMessage]);
          // Reset approval state on error to allow user to continue
          setWaitingForApproval(false);
          setPendingApproval(null);
        }
      } finally {
        loggingService.debug('sendUserMessage finally block - resetting state');
        // flushLog();
        reasoningUpdater.flush();
        botResponseUpdater.cancel();
        setIsProcessing(false);
        // Don't reset waitingForApproval here - it's set by applyServiceResult
        // and should only be cleared by handleApprovalDecision or stopProcessing
      }
    },
    [
      conversationService,
      applyServiceResult,
      appendMessages,
      trimMessages,
      loggingService,
      createOnEventWithSubagentTracking,
    ],
  );

  const handleApprovalDecision = useCallback(
    async (answer: string, rejectionReason?: string) => {
      if (!waitingForApproval || !pendingApproval) {
        return;
      }

      // Check if this is a max turns exceeded prompt
      const isMaxTurnsPrompt = pendingApproval.isMaxTurnsPrompt;

      if (answer === 'y') {
        approvedContextRef.current = {
          callId: pendingApproval.callId,
          toolName: pendingApproval.toolName,
        };
      }

      setPendingApproval(null);
      setWaitingForApproval(false);

      // Handle "n" answer for max turns - return to input
      if (isMaxTurnsPrompt && answer === 'n') {
        setIsProcessing(false);
        return;
      }

      // Handle "y" answer for max turns - continue execution automatically
      if (isMaxTurnsPrompt && answer === 'y') {
        setIsProcessing(true);

        const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
          createStreamingSession<Message>(
            {
              appendMessages,
              setMessages,
              trimMessages,
              annotateCommandMessage,
              loggingService,
              setLastUsage,
              setCodexRateLimit,
              reasoningThrottleMs: REASONING_RESPONSE_THROTTLE_MS,
            },
            'maxTurnsContinuation',
          );

        try {
          // Send a continuation message to resume work
          const continuationMessage = 'Please continue with your previous task.';
          const result = await conversationService.sendMessage(continuationMessage, {
            onEvent: createOnEventWithSubagentTracking(applyConversationEvent),
          });

          applyConversationEvent({ type: 'final', finalText: '' } as any);
          applyServiceResult(result, streamingState.textWasFlushed, streamingState.latestUsage);
        } catch (error) {
          loggingService.error('Error in continuation after max turns', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });

          // Don't show error messages for user-initiated aborts
          if (isAbortLikeError(error)) {
            loggingService.debug('Suppressing abort error in max turns continuation');
            // The finally block will handle cleanup
            return;
          }

          const errorMessage = error instanceof Error ? error.message : String(error);
          const botErrorMessage: BotMessage = {
            id: createMessageId(),
            sender: 'bot',
            status: 'finalized',
            text: `Error: ${errorMessage}`,
          };
          appendMessages([botErrorMessage]);
          setWaitingForApproval(false);
          setPendingApproval(null);
        } finally {
          // flushLog();
          reasoningUpdater.flush();
          botResponseUpdater.cancel();
          setIsProcessing(false);
        }
        return;
      }

      setIsProcessing(true);
      const { botResponseUpdater, reasoningUpdater, applyConversationEvent, streamingState } =
        createStreamingSession<Message>(
          {
            appendMessages,
            setMessages,
            trimMessages,
            annotateCommandMessage,
            loggingService,
            setLastUsage,
            setCodexRateLimit,
            reasoningThrottleMs: REASONING_RESPONSE_THROTTLE_MS,
          },
          'approvalDecision',
        );

      try {
        const result = await conversationService.handleApprovalDecision(answer, rejectionReason, {
          onEvent: createOnEventWithSubagentTracking(applyConversationEvent),
        });
        applyConversationEvent({ type: 'final', finalText: '' } as any);
        applyServiceResult(result, streamingState.textWasFlushed, streamingState.latestUsage);
      } catch (error) {
        loggingService.error('Error in handleApprovalDecision', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Don't show error messages for user-initiated aborts
        if (isAbortLikeError(error)) {
          loggingService.debug('Suppressing abort error in handleApprovalDecision');
          // The finally block will handle cleanup
          return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        const botErrorMessage: BotMessage = {
          id: createMessageId(),
          sender: 'bot',
          status: 'finalized',
          text: `Error: ${errorMessage}`,
        };
        appendMessages([botErrorMessage]);
        // Reset approval state on error to allow user to continue
        setWaitingForApproval(false);
        setPendingApproval(null);
      } finally {
        loggingService.debug('handleApprovalDecision finally block - resetting state');
        reasoningUpdater.flush();
        botResponseUpdater.cancel();
        setIsProcessing(false);
        // Don't reset approval state here - if the result is another approval_required,
        // applyServiceResult will set waitingForApproval=true, but this finally block
        // would immediately clear it, causing the input box to reappear
      }
    },
    [
      applyServiceResult,
      conversationService,
      waitingForApproval,
      pendingApproval,
      appendMessages,
      trimMessages,
      loggingService,
      createOnEventWithSubagentTracking,
    ],
  );

  const clearConversation = useCallback(async () => {
    if (onClear) {
      await onClear();
    } else {
      conversationService.resetWithNewId(conversationService.sessionId);
    }
    setMessages([]);
    setWaitingForApproval(false);
    setWaitingForRejectionReason(false);
    setPendingApproval(null);
    approvedContextRef.current = null;
    setIsProcessing(false);
    setLastUsage(null);
    setLastCodexRateLimit(null);
    usageAccumulator?.reset();
    subagentUsageAccumulator?.reset();
  }, [conversationService, usageAccumulator, subagentUsageAccumulator, onClear]);

  const stopProcessing = useCallback(() => {
    conversationService.abort();
    setWaitingForApproval(false);
    setWaitingForRejectionReason(false);
    setPendingApproval(null);
    approvedContextRef.current = null;
    setIsProcessing(false);
  }, [conversationService]);

  const undoLastUserMessage = useCallback(() => {
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) {
      return null;
    }

    const lastUserMessage = messages[lastUserIndex];
    const uiText = lastUserMessage.sender === 'user' ? lastUserMessage.text : '';
    conversationService.abort();
    const removed = conversationService.undoLastUserTurn();
    const restored = removed?.text ?? uiText;
    setMessages((prev) => prev.slice(0, lastUserIndex));
    setWaitingForApproval(false);
    setWaitingForRejectionReason(false);
    setPendingApproval(null);
    approvedContextRef.current = null;
    setIsProcessing(false);

    if (removed && removed.imageCount > 0) {
      appendMessages([
        {
          id: createMessageId(),
          sender: 'system',
          text: `Note: ${removed.imageCount} attached image${
            removed.imageCount === 1 ? '' : 's'
          } could not be restored to the input.`,
        },
      ]);
    }

    return restored;
  }, [messages, conversationService, appendMessages]);

  const getUserMessages = useCallback((): { uiIndex: number; text: string }[] => {
    const result: { uiIndex: number; text: string }[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].sender === 'user') {
        result.push({ uiIndex: i, text: (messages[i] as UserMessage).text });
      }
    }
    return result;
  }, [messages]);

  const undoToUserMessage = useCallback(
    (uiIndex: number): string | null => {
      // Count how many user messages are at or after this index
      let undoCount = 0;
      for (let i = uiIndex; i < messages.length; i++) {
        if (messages[i].sender === 'user') {
          undoCount++;
        }
      }

      if (undoCount === 0) return null;

      const selectedMessage = messages[uiIndex] as UserMessage;
      const uiText = selectedMessage?.text ?? '';

      conversationService.abort();
      const removed = conversationService.undoNUserTurns(undoCount);
      const restored = removed?.text ?? uiText;

      setMessages((prev) => prev.slice(0, uiIndex));
      setWaitingForApproval(false);
      setWaitingForRejectionReason(false);
      setPendingApproval(null);
      approvedContextRef.current = null;
      setIsProcessing(false);

      if (removed && removed.imageCount > 0) {
        appendMessages([
          {
            id: createMessageId(),
            sender: 'system',
            text: `Note: ${removed.imageCount} attached image${
              removed.imageCount === 1 ? '' : 's'
            } could not be restored to the input.`,
          },
        ]);
      }

      return restored;
    },
    [messages, conversationService, appendMessages],
  );

  const setModel = useCallback(
    (model: string) => {
      conversationService.setModel(model);
    },
    [conversationService],
  );

  const setReasoningEffort = useCallback(
    (effort: ReasoningEffortSetting) => {
      conversationService.setReasoningEffort(effort);
    },
    [conversationService],
  );

  const setTemperature = useCallback(
    (temperature?: number) => {
      conversationService.setTemperature(temperature);
    },
    [conversationService],
  );

  const addSystemMessage = useCallback(
    (text: string) => {
      appendMessages([
        {
          id: createMessageId(),
          sender: 'system',
          text,
        },
      ]);
    },
    [appendMessages],
  );

  const addShellMessage = useCallback(
    (command: string, output: string, exitCode: number | null, timedOut: boolean) => {
      const success = !timedOut && exitCode === 0;
      const failureReason = timedOut
        ? 'timeout'
        : exitCode == null
        ? 'error'
        : exitCode !== 0
        ? `exit ${exitCode}`
        : undefined;

      appendMessages([
        {
          id: createMessageId(),
          sender: 'command',
          status: success ? 'completed' : 'failed',
          command,
          output,
          success,
          failureReason,
          toolName: 'shell',
        },
      ]);
    },
    [appendMessages],
  );

  const getSubagentUsage = useCallback(() => subagentUsageAccumulator?.get() ?? null, [subagentUsageAccumulator]);

  return {
    messages,
    sessionId: sessionId ?? conversationService.sessionId,
    lastUsage,
    lastCodexRateLimit,
    pendingApproval,
    waitingForApproval,
    waitingForRejectionReason,
    setWaitingForRejectionReason,
    isProcessing,
    sendUserMessage,
    handleApprovalDecision,
    clearConversation,
    stopProcessing,
    undoLastUserMessage,
    getUserMessages,
    undoToUserMessage,
    setModel,
    setReasoningEffort,
    setTemperature,
    addSystemMessage,
    addShellMessage,
    getSubagentUsage,
  };
};
