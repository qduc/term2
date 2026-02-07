import {useCallback, useRef, useState} from 'react';
import type {ConversationService} from '../services/conversation-service.js';
import {isAbortLikeError} from '../utils/error-helpers.js';
import type {ILoggingService} from '../services/service-interfaces.js';
import {createStreamingUpdateCoordinator} from '../utils/streaming-updater.js';
import {appendMessagesCapped} from '../utils/message-buffer.js';
import {
    createStreamingState,
    enhanceApiKeyError,
    isMaxTurnsError,
} from '../utils/conversation-utils.js';
import {createConversationEventHandler} from '../utils/conversation-event-handler.js';
import type {NormalizedUsage} from '../utils/token-usage.js';

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

interface PendingApproval {
    agentName: string;
    toolName: string;
    argumentsText: string;
    rawInterruption: any;
    callId?: string;
    isMaxTurnsPrompt?: boolean; // Special flag for max turns continuation
}

interface CommandMessage {
    id: string;
    sender: 'command';
    status: 'pending' | 'running' | 'completed' | 'failed';
    command: string;
    output: string;
    success?: boolean;
    failureReason?: string;
    isApprovalRejection?: boolean;
    callId?: string;
    toolName?: string;
    toolArgs?: any;
    hadApproval?: boolean;
}

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

type Message =
    | UserMessage
    | BotMessage
    | CommandMessage
    | SystemMessage
    | ReasoningMessage;

interface LiveResponse {
    id: number;
    sender: 'bot';
    text: string;
}

const LIVE_RESPONSE_THROTTLE_MS = 150;
const REASONING_RESPONSE_THROTTLE_MS = 200;
const MAX_MESSAGE_COUNT = 300;

export const filterPendingCommandMessagesForApproval = (
    messages: any[],
    approval: {callId?: string; toolName?: string} | null | undefined,
): any[] => {
    if (!Array.isArray(messages) || messages.length === 0) {
        return messages ?? [];
    }

    const callId = approval?.callId ? String(approval.callId) : undefined;
    const toolName = approval?.toolName;

    if (!callId && !toolName) {
        return messages;
    }

    return messages.filter(msg => {
        if (!msg || msg.sender !== 'command') {
            return true;
        }

        if (msg.status !== 'pending' && msg.status !== 'running') {
            return true;
        }

        const matchesCallId =
            callId && msg.callId && String(msg.callId) === callId;
        const matchesToolName =
            !callId && toolName && msg.toolName === toolName;

        return !(matchesCallId || matchesToolName);
    });
};

export const useConversation = ({
    conversationService,
    loggingService,
}: {
    conversationService: ConversationService;
    loggingService: ILoggingService;
}) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [waitingForApproval, setWaitingForApproval] =
        useState<boolean>(false);
    const [waitingForRejectionReason, setWaitingForRejectionReason] =
        useState<boolean>(false);
    const [pendingApproval, setPendingApproval] =
        useState<PendingApproval | null>(null);
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [liveResponse, setLiveResponse] = useState<LiveResponse | null>(null);
    const [lastUsage, setLastUsage] = useState<NormalizedUsage | null>(null);
    const approvedContextRef = useRef<{
        callId?: string;
        toolName?: string;
    } | null>(null);
    const createLiveResponseUpdater = useCallback(
        (liveMessageId: number) =>
            createStreamingUpdateCoordinator((text: string) => {
                setLiveResponse(prev =>
                    prev && prev.id === liveMessageId
                        ? {...prev, text}
                        : {
                              id: liveMessageId,
                              sender: 'bot',
                              text,
                          },
                );
            }, LIVE_RESPONSE_THROTTLE_MS),
        [],
    );

    const trimMessages = useCallback(
        (list: Message[]) => appendMessagesCapped(list, [], MAX_MESSAGE_COUNT),
        [],
    );

    const appendMessages = useCallback(
        (additions: Message[]) => {
            if (!additions.length) return;
            setMessages(prev => trimMessages([...prev, ...additions]));
        },
        [trimMessages],
    );

    // Helper to log events with deduplication
    // const createEventLogger = () => {
    //     let lastEventType: string | null = null;
    //     let eventCount = 0;
    //     let eventSequence: string[] = [];
    //
    //     const logDeduplicated = (eventType: string) => {
    //         if (eventType !== lastEventType) {
    //             if (lastEventType !== null) {
    //                 loggingService.debug('Conversation event sequence', {
    //                     event: lastEventType,
    //                     count: eventCount,
    //                     sequenceLength: eventSequence.length,
    //                     sequence: eventSequence,
    //                 });
    //             }
    //             lastEventType = eventType;
    //             eventCount = 1;
    //             if (!eventSequence.includes(eventType)) {
    //                 eventSequence.push(eventType);
    //             }
    //         } else {
    //             eventCount++;
    //         }
    //     };
    //
    //     const flush = () => {
    //         if (lastEventType !== null) {
    //             loggingService.debug('Conversation event sequence final', {
    //                 event: lastEventType,
    //                 count: eventCount,
    //                 sequenceLength: eventSequence.length,
    //                 sequence: eventSequence,
    //             });
    //             lastEventType = null;
    //             eventCount = 0;
    //             eventSequence = [];
    //         }
    //     };
    //
    //     return {logDeduplicated, flush};
    // };

    const annotateCommandMessage = useCallback(
        (cmdMsg: CommandMessage): CommandMessage => {
            const approvalContext = approvedContextRef.current;
            if (!approvalContext || cmdMsg.toolName !== 'search_replace') {
                return cmdMsg;
            }

            const matchesCallId =
                approvalContext.callId &&
                cmdMsg.callId &&
                approvalContext.callId === cmdMsg.callId;
            const matchesToolName =
                !approvalContext.callId &&
                approvalContext.toolName &&
                approvalContext.toolName === cmdMsg.toolName;

            if (!matchesCallId && !matchesToolName) {
                return cmdMsg;
            }

            if (matchesToolName && !approvalContext.callId) {
                approvedContextRef.current = null;
            }

            return {...cmdMsg, hadApproval: true};
        },
        [],
    );

    const applyServiceResult = useCallback(
        (
            result: any,
            remainingText?: string,
            remainingReasoningText?: string,
            textWasFlushed?: boolean,
        ) => {
            if (!result) {
                return;
            }

            if (result.type === 'approval_required') {
                // Flush reasoning and text separately before showing approval prompt
                const messagesToAdd: Message[] = [];

                if (remainingReasoningText?.trim() && !textWasFlushed) {
                    // Ensure reasoning is captured if not already streamed (edge case)
                    // But with new logic, it should be in messages.
                    // We'll leave this empty or remove it as reasoning is handled via stream
                }

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
                setMessages(prev =>
                    trimMessages(
                        filterPendingCommandMessagesForApproval(
                            prev as any,
                            result.approval,
                        ) as any,
                    ),
                );
                setPendingApproval(result.approval);
                // Set waiting state AFTER adding approval message to ensure proper render order
                setWaitingForApproval(true);
                return;
            }

            // If text was already flushed before command messages, don't add it again
            // Only add final text if there's new text after the commands
            const shouldAddBotMessage =
                !textWasFlushed || remainingText?.trim();
            const finalText = remainingText?.trim()
                ? remainingText
                : result.finalText;

            setMessages(prev => {
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

            const liveMessageId = Date.now();
            setLiveResponse({
                id: liveMessageId,
                sender: 'bot',
                text: '',
            });
            const liveResponseUpdater =
                createLiveResponseUpdater(liveMessageId);

            // Create streaming state object for this message send
            const streamingState = createStreamingState();

            const reasoningUpdater = createStreamingUpdateCoordinator(
                (newReasoningText: string) => {
                    setMessages(prev => {
                        if (streamingState.currentReasoningMessageId !== null) {
                            const index = prev.findIndex(
                                msg => msg.id === streamingState.currentReasoningMessageId,
                            );
                            if (index === -1) return prev;
                            const current = prev[index];
                            if (current.sender !== 'reasoning') {
                                return prev;
                            }
                            const next = prev.slice();
                            next[index] = {...current, text: newReasoningText};
                            return trimMessages(next as Message[]);
                        }

                        const newId = Date.now();
                        streamingState.currentReasoningMessageId = newId;
                        return trimMessages([
                            ...prev,
                            {
                                id: newId,
                                sender: 'reasoning',
                                text: newReasoningText,
                            },
                        ]);
                    });
                },
                REASONING_RESPONSE_THROTTLE_MS,
            );

            // Create event handler using extracted factory
            const baseEventHandler = createConversationEventHandler(
                {
                    liveResponseUpdater,
                    reasoningUpdater,
                    appendMessages,
                    setMessages,
                    setLiveResponse,
                    trimMessages,
                    annotateCommandMessage,
                },
                streamingState,
            );

            const applyConversationEvent = (event: any) => {
                if (event.type === 'final') {
                    if (event.usage) {
                        loggingService.debug(
                            'UI received final usage (sendUserMessage)',
                            {usage: event.usage},
                        );
                        setLastUsage(event.usage);
                    } else {
                        loggingService.debug(
                            'UI final event has no usage (sendUserMessage)',
                        );
                    }
                }
                baseEventHandler(event);
            };

            try {
                const result = await conversationService.sendMessage(value, {
                    onEvent: applyConversationEvent,
                });

                applyServiceResult(
                    result,
                    streamingState.accumulatedText,
                    streamingState.accumulatedReasoningText,
                    streamingState.textWasFlushed,
                );
            } catch (error) {
                loggingService.error('Error in sendUserMessage', {
                    error:
                        error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                });

                // Don't show error messages for user-initiated aborts
                if (isAbortLikeError(error)) {
                    loggingService.debug(
                        'Suppressing abort error in sendUserMessage',
                    );
                    // The finally block will handle cleanup
                    return;
                }

                const rawErrorMessage =
                    error instanceof Error ? error.message : String(error);
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
                loggingService.debug(
                    'sendUserMessage finally block - resetting state',
                );
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

            if (
                answer === 'y' &&
                pendingApproval.toolName === 'search_replace'
            ) {
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

                const liveMessageId = Date.now();
                setLiveResponse({
                    id: liveMessageId,
                    sender: 'bot',
                    text: '',
                });
                const liveResponseUpdater =
                    createLiveResponseUpdater(liveMessageId);

                // Create streaming state object for max turns continuation
                const streamingState = createStreamingState();

                const reasoningUpdater = createStreamingUpdateCoordinator(
                    (newReasoningText: string) => {
                        setMessages(prev => {
                            if (streamingState.currentReasoningMessageId !== null) {
                                const index = prev.findIndex(
                                    msg => msg.id === streamingState.currentReasoningMessageId,
                                );
                                if (index === -1) return prev;
                                const current = prev[index];
                                if (current.sender !== 'reasoning') {
                                    return prev;
                                }
                                const next = prev.slice();
                                next[index] = {
                                    ...current,
                                    text: newReasoningText,
                                };
                                return trimMessages(next as Message[]);
                            }

                            const newId = Date.now();
                            streamingState.currentReasoningMessageId = newId;
                            return trimMessages([
                                ...prev,
                                {
                                    id: newId,
                                    sender: 'reasoning',
                                    text: newReasoningText,
                                },
                            ]);
                        });
                    },
                    REASONING_RESPONSE_THROTTLE_MS,
                );

                // Create event handler using extracted factory
                const baseEventHandler = createConversationEventHandler(
                    {
                        liveResponseUpdater,
                        reasoningUpdater,
                        appendMessages,
                        setMessages,
                        setLiveResponse,
                        trimMessages,
                        annotateCommandMessage,
                    },
                    streamingState,
                );

                const applyConversationEvent = (event: any) => {
                    if (event.type === 'final') {
                        if (event.usage) {
                            loggingService.debug(
                                'UI received final usage (maxTurnsContinuation)',
                                {usage: event.usage},
                            );
                            setLastUsage(event.usage);
                        } else {
                            loggingService.debug(
                                'UI final event has no usage (maxTurnsContinuation)',
                            );
                        }
                    }
                    baseEventHandler(event);
                };

                try {
                    // Send a continuation message to resume work
                    const continuationMessage =
                        'Please continue with your previous task.';
                    const result = await conversationService.sendMessage(
                        continuationMessage,
                        {
                            onEvent: applyConversationEvent,
                        },
                    );

                    applyServiceResult(
                        result,
                        streamingState.accumulatedText,
                        streamingState.accumulatedReasoningText,
                        streamingState.textWasFlushed,
                    );
                } catch (error) {
                    loggingService.error(
                        'Error in continuation after max turns',
                        {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                            stack:
                                error instanceof Error
                                    ? error.stack
                                    : undefined,
                        },
                    );

                    // Don't show error messages for user-initiated aborts
                    if (isAbortLikeError(error)) {
                        loggingService.debug(
                            'Suppressing abort error in max turns continuation',
                        );
                        // The finally block will handle cleanup
                        return;
                    }

                    const errorMessage =
                        error instanceof Error ? error.message : String(error);
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
            const liveMessageId = Date.now();
            setLiveResponse({
                id: liveMessageId,
                sender: 'bot',
                text: '',
            });
            const liveResponseUpdater =
                createLiveResponseUpdater(liveMessageId);

            // Create streaming state object for this approval decision
            const streamingState = createStreamingState();

            const reasoningUpdater = createStreamingUpdateCoordinator(
                (newReasoningText: string) => {
                    setMessages(prev => {
                        if (streamingState.currentReasoningMessageId !== null) {
                            const index = prev.findIndex(
                                msg => msg.id === streamingState.currentReasoningMessageId,
                            );
                            if (index === -1) return prev;
                            const current = prev[index];
                            if (current.sender !== 'reasoning') {
                                return prev;
                            }
                            const next = prev.slice();
                            next[index] = {...current, text: newReasoningText};
                            return trimMessages(next as Message[]);
                        }

                        const newId = Date.now();
                        streamingState.currentReasoningMessageId = newId;
                        return trimMessages([
                            ...prev,
                            {
                                id: newId,
                                sender: 'reasoning',
                                text: newReasoningText,
                            },
                        ]);
                    });
                },
                REASONING_RESPONSE_THROTTLE_MS,
            );

            // Create event handler using extracted factory
            const baseEventHandler = createConversationEventHandler(
                {
                    liveResponseUpdater,
                    reasoningUpdater,
                    appendMessages,
                    setMessages,
                    setLiveResponse,
                    trimMessages,
                    annotateCommandMessage,
                },
                streamingState,
            );

            const applyConversationEvent = (event: any) => {
                if (event.type === 'final') {
                    if (event.usage) {
                        loggingService.debug(
                            'UI received final usage (approvalDecision)',
                            {usage: event.usage},
                        );
                        setLastUsage(event.usage);
                    } else {
                        loggingService.debug(
                            'UI final event has no usage (approvalDecision)',
                        );
                    }
                }
                baseEventHandler(event);
            };

            try {
                const result = await conversationService.handleApprovalDecision(
                    answer,
                    rejectionReason,
                    {
                        onEvent: applyConversationEvent,
                    },
                );
                applyServiceResult(
                    result,
                    streamingState.accumulatedText,
                    streamingState.accumulatedReasoningText,
                    streamingState.textWasFlushed,
                );
            } catch (error) {
                loggingService.error('Error in handleApprovalDecision', {
                    error:
                        error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                });

                // Don't show error messages for user-initiated aborts
                if (isAbortLikeError(error)) {
                    loggingService.debug(
                        'Suppressing abort error in handleApprovalDecision',
                    );
                    // The finally block will handle cleanup
                    return;
                }

                const errorMessage =
                    error instanceof Error ? error.message : String(error);
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
                loggingService.debug(
                    'handleApprovalDecision finally block - resetting state',
                );
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
        setPendingApproval(null);
        approvedContextRef.current = null;
        setIsProcessing(false);
        setLiveResponse(null);
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
        (effort: any) => {
            (conversationService as any).setReasoningEffort?.(effort);
        },
        [conversationService],
    );

    const setTemperature = useCallback(
        (temperature: any) => {
            (conversationService as any).setTemperature?.(temperature);
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
        (
            command: string,
            output: string,
            exitCode: number | null,
            timedOut: boolean,
        ) => {
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
