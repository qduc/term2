import { useCallback, useRef, useState } from 'react';
import type { ConversationService } from '../services/conversation-service.js';
import { isAbortLikeError } from '../utils/error-helpers.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { createStreamingUpdateCoordinator } from '../utils/streaming-updater.js';
import { appendMessagesCapped } from '../utils/message-buffer.js';
import { enhanceApiKeyError, isMaxTurnsError } from '../utils/conversation-utils.js';
import { createStreamingSession } from '../utils/streaming-session-factory.js';
import type { CommandMessage as BaseCommandMessage } from '../tools/types.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import type { ConversationTerminal, PendingApproval, ReasoningEffortSetting } from '../contracts/conversation.js';
import {
  annotateApprovedCommandMessage,
  filterPendingCommandMessagesForApproval,
  type ApprovedToolContext,
} from '../services/approval-presentation-policy.js';

interface UserMessage {
  id: number;
  sender: 'user';
  text: string;
}

interface BotMessage {
  id: number;
  sender: 'bot';
  text: string;
  reasoningText?: string;
}

type CommandMessage = BaseCommandMessage & {
  hadApproval?: boolean;
};

interface SystemMessage {
  id: number;
  sender: 'system';
  text: string;
}

interface ReasoningMessage {
  id: number;
  sender: 'reasoning';
  text: string;
}

type Message = UserMessage | BotMessage | CommandMessage | SystemMessage | ReasoningMessage;

interface LiveResponse {
  id: number;
  sender: 'bot';
  text: string;
}

const LIVE_RESPONSE_THROTTLE_MS = 150;
const REASONING_RESPONSE_THROTTLE_MS = 200;
const MAX_MESSAGE_COUNT = 300;

export const useConversation = ({
  conversationService,
  loggingService,
}: {
  conversationService: ConversationService;
  loggingService: ILoggingService;
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [waitingForApproval, setWaitingForApproval] = useState<boolean>(false);
  const [waitingForRejectionReason, setWaitingForRejectionReason] = useState<boolean>(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [liveResponse, setLiveResponse] = useState<LiveResponse | null>(null);
  const [lastUsage, setLastUsage] = useState<NormalizedUsage | null>(null);
  const approvedContextRef = useRef<ApprovedToolContext | null>(null);
  const createLiveResponseUpdater = useCallback(
    (liveMessageId: number) =>
      createStreamingUpdateCoordinator((text: string) => {
        setLiveResponse((prev) =>
          prev && prev.id === liveMessageId
            ? { ...prev, text }
            : {
                id: liveMessageId,
                sender: 'bot',
                text,
              },
        );
      }, LIVE_RESPONSE_THROTTLE_MS),
    [],
  );

  const trimMessages = useCallback((list: Message[]) => appendMessagesCapped(list, [], MAX_MESSAGE_COUNT), []);

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

  const applyServiceResult = useCallback(
    (result: ConversationTerminal | null, remainingText?: string, textWasFlushed?: boolean) => {
      if (!result) {
        return;
      }

      if (result.type === 'approval_required') {
        // Flush reasoning and text separately before showing approval prompt
        const messagesToAdd: Message[] = [];

        if (remainingText?.trim() && !textWasFlushed) {
          const textMessage: BotMessage = {
            id: Date.now() + 1,
            sender: 'bot',
            text: remainingText,
          };
          messagesToAdd.push(textMessage);
        }

        appendMessages(messagesToAdd);

        // If a tool call requires approval, we show it in the approval prompt.
        // Don't also show the transient pending/running command message.
        setMessages((prev) => trimMessages(filterPendingCommandMessagesForApproval(prev, result.approval)));
        setPendingApproval(result.approval);
        // Set waiting state AFTER adding approval message to ensure proper render order
        setWaitingForApproval(true);
        return;
      }

      // If text was already flushed before command messages, don't add it again
      // Only add final text if there's new text after the commands
      const shouldAddBotMessage = !textWasFlushed || remainingText?.trim();
      const finalText = remainingText?.trim() ? remainingText : result.finalText;

      setMessages((prev) => {
        const messagesToAdd: Message[] = [];
        const annotatedCommands = result.commandMessages.map(annotateCommandMessage);

        let next = [...prev, ...messagesToAdd, ...annotatedCommands];

        if (shouldAddBotMessage && finalText) {
          const botMessage: BotMessage = {
            id: Date.now() + 1,
            sender: 'bot',
            text: finalText,
          };
          next = [...next, botMessage];
        }

        return trimMessages(next);
      });
      setWaitingForApproval(false);
      setPendingApproval(null);
      if (result.usage) {
        setLastUsage(result.usage);
      }
    },
    [annotateCommandMessage, appendMessages, trimMessages],
  );

  const sendUserMessage = useCallback(
    async (value: string) => {
      if (!value.trim()) {
        return;
      }

      const userMessage: UserMessage = {
        id: Date.now(),
        sender: 'user',
        text: value,
      };
      appendMessages([userMessage]);
      setIsProcessing(true);

      const { liveResponseUpdater, reasoningUpdater, streamingState, applyConversationEvent } =
        createStreamingSession<Message>(
          {
            appendMessages,
            setMessages,
            setLiveResponse,
            trimMessages,
            annotateCommandMessage,
            loggingService,
            setLastUsage,
            createLiveResponseUpdater,
            reasoningThrottleMs: REASONING_RESPONSE_THROTTLE_MS,
          },
          'sendUserMessage',
        );

      try {
        const result = await conversationService.sendMessage(value, {
          onEvent: applyConversationEvent,
        });

        applyServiceResult(result, streamingState.accumulatedText, streamingState.textWasFlushed);
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
            id: Date.now(),
            sender: 'bot',
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
        liveResponseUpdater.cancel();
        setLiveResponse(null);
        setIsProcessing(false);
        // Don't reset waitingForApproval here - it's set by applyServiceResult
        // and should only be cleared by handleApprovalDecision or stopProcessing
      }
    },
    [conversationService, applyServiceResult, appendMessages, trimMessages, loggingService, createLiveResponseUpdater],
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

        const { liveResponseUpdater, reasoningUpdater, streamingState, applyConversationEvent } =
          createStreamingSession<Message>(
            {
              appendMessages,
              setMessages,
              setLiveResponse,
              trimMessages,
              annotateCommandMessage,
              loggingService,
              setLastUsage,
              createLiveResponseUpdater,
              reasoningThrottleMs: REASONING_RESPONSE_THROTTLE_MS,
            },
            'maxTurnsContinuation',
          );

        try {
          // Send a continuation message to resume work
          const continuationMessage = 'Please continue with your previous task.';
          const result = await conversationService.sendMessage(continuationMessage, {
            onEvent: applyConversationEvent,
          });

          applyServiceResult(result, streamingState.accumulatedText, streamingState.textWasFlushed);
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
            id: Date.now(),
            sender: 'bot',
            text: `Error: ${errorMessage}`,
          };
          appendMessages([botErrorMessage]);
          setWaitingForApproval(false);
          setPendingApproval(null);
        } finally {
          // flushLog();
          reasoningUpdater.flush();
          liveResponseUpdater.cancel();
          setLiveResponse(null);
          setIsProcessing(false);
        }
        return;
      }

      setIsProcessing(true);
      const { liveResponseUpdater, reasoningUpdater, streamingState, applyConversationEvent } =
        createStreamingSession<Message>(
          {
            appendMessages,
            setMessages,
            setLiveResponse,
            trimMessages,
            annotateCommandMessage,
            loggingService,
            setLastUsage,
            createLiveResponseUpdater,
            reasoningThrottleMs: REASONING_RESPONSE_THROTTLE_MS,
          },
          'approvalDecision',
        );

      try {
        const result = await conversationService.handleApprovalDecision(answer, rejectionReason, {
          onEvent: applyConversationEvent,
        });
        applyServiceResult(result, streamingState.accumulatedText, streamingState.textWasFlushed);
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
          id: Date.now(),
          sender: 'bot',
          text: `Error: ${errorMessage}`,
        };
        appendMessages([botErrorMessage]);
        // Reset approval state on error to allow user to continue
        setWaitingForApproval(false);
        setPendingApproval(null);
      } finally {
        loggingService.debug('handleApprovalDecision finally block - resetting state');
        // flushLog();
        reasoningUpdater.flush();
        liveResponseUpdater.cancel();
        setLiveResponse(null);
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
      createLiveResponseUpdater,
    ],
  );

  const clearConversation = useCallback(() => {
    conversationService.reset();
    setMessages([]);
    setWaitingForApproval(false);
    setWaitingForRejectionReason(false);
    setPendingApproval(null);
    approvedContextRef.current = null;
    setIsProcessing(false);
    setLiveResponse(null);
    setLastUsage(null);
  }, [conversationService]);

  const stopProcessing = useCallback(() => {
    conversationService.abort();
    setWaitingForApproval(false);
    setWaitingForRejectionReason(false);
    setPendingApproval(null);
    approvedContextRef.current = null;
    setIsProcessing(false);
    setLiveResponse(null);
  }, [conversationService]);

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
          id: Date.now(),
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
          id: String(Date.now()),
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

  return {
    messages,
    liveResponse,
    lastUsage,
    pendingApproval,
    waitingForApproval,
    waitingForRejectionReason,
    setWaitingForRejectionReason,
    isProcessing,
    sendUserMessage,
    handleApprovalDecision,
    clearConversation,
    stopProcessing,
    setModel,
    setReasoningEffort,
    setTemperature,
    addSystemMessage,
    addShellMessage,
  };
};
