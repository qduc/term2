import {useCallback, useState} from 'react';
import type {ConversationService} from '../services/conversation-service.js';
import {loggingService} from '../services/logging-service.js';
import {isAbortLikeError} from '../utils/error-helpers.js';

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

interface ApprovalMessage {
    id: number;
    sender: 'approval';
    approval: {
        agentName: string;
        toolName: string;
        argumentsText: string;
        rawInterruption: any;
        isMaxTurnsPrompt?: boolean; // Special flag for max turns continuation
    };
    answer: string | null;
    rejectionReason?: string; // Optional reason provided when user rejects
}

interface CommandMessage {
    id: string;
    sender: 'command';
    command: string;
    output: string;
    success?: boolean;
    failureReason?: string;
    isApprovalRejection?: boolean;
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
    | ApprovalMessage
    | CommandMessage
    | SystemMessage
    | ReasoningMessage;

interface LiveResponse {
    id: number;
    sender: 'bot';
    text: string;
}

export const useConversation = ({
    conversationService,
}: {
    conversationService: ConversationService;
}) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [waitingForApproval, setWaitingForApproval] =
        useState<boolean>(false);
    const [waitingForRejectionReason, setWaitingForRejectionReason] =
        useState<boolean>(false);
    const [pendingApprovalMessageId, setPendingApprovalMessageId] = useState<
        number | null
    >(null);
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [liveResponse, setLiveResponse] = useState<LiveResponse | null>(null);

    // Helper to log events with deduplication
    const createEventLogger = () => {
        let lastEventType: string | null = null;
        let eventCount = 0;
        let eventSequence: string[] = [];

        const logDeduplicated = (eventType: string) => {
            if (eventType !== lastEventType) {
                if (lastEventType !== null) {
                    loggingService.debug('Conversation event sequence', {
                        event: lastEventType,
                        count: eventCount,
                        sequenceLength: eventSequence.length,
                        sequence: eventSequence,
                    });
                }
                lastEventType = eventType;
                eventCount = 1;
                if (!eventSequence.includes(eventType)) {
                    eventSequence.push(eventType);
                }
            } else {
                eventCount++;
            }
        };

        const flush = () => {
            if (lastEventType !== null) {
                loggingService.debug('Conversation event sequence final', {
                    event: lastEventType,
                    count: eventCount,
                    sequenceLength: eventSequence.length,
                    sequence: eventSequence,
                });
                lastEventType = null;
                eventCount = 0;
                eventSequence = [];
            }
        };

        return {logDeduplicated, flush};
    };

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

                const approvalMessage: ApprovalMessage = {
                    id: Date.now() + 2,
                    sender: 'approval',
                    approval: result.approval,
                    answer: null,
                };

                setPendingApprovalMessageId(approvalMessage.id);
                setMessages(prev => [
                    ...prev,
                    ...messagesToAdd,
                    approvalMessage,
                ]);
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
                // Reasoning is now streamed directly to messages, so we don't need to add it here

                const withCommands =
                    result.commandMessages.length > 0
                        ? [...prev, ...messagesToAdd, ...result.commandMessages]
                        : [...prev, ...messagesToAdd];

                if (shouldAddBotMessage && finalText) {
                    const botMessage: BotMessage = {
                        id: Date.now() + 1,
                        sender: 'bot',
                        text: finalText,
                    };
                    return [...withCommands, botMessage];
                }

                return withCommands;
            });
            setWaitingForApproval(false);
            setPendingApprovalMessageId(null);
        },
        [],
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
            setMessages(prev => [...prev, userMessage]);
            setIsProcessing(true);

            const liveMessageId = Date.now();
            setLiveResponse({
                id: liveMessageId,
                sender: 'bot',
                text: '',
            });

            // Track accumulated text so we can flush it before command messages
            let accumulatedText = '';
            let accumulatedReasoningText = '';
            let flushedReasoningLength = 0; // Track how much reasoning has been flushed
            let textWasFlushed = false;
            let currentReasoningMessageId: number | null = null; // Track current reasoning message ID

            // Create event logger with deduplication for this message send
            const {logDeduplicated, flush: flushLog} = createEventLogger();

            try {
                const result = await conversationService.sendMessage(value, {
                    onTextChunk: (_fullText, chunk = '') => {
                        logDeduplicated('onTextChunk');
                        accumulatedText += chunk;
                        setLiveResponse(prev =>
                            prev && prev.id === liveMessageId
                                ? {...prev, text: accumulatedText}
                                : {
                                        id: liveMessageId,
                                        sender: 'bot',
                                        text: accumulatedText,
                                  },
                        );
                    },
                    onReasoningChunk: fullReasoningText => {
                        logDeduplicated('onReasoningChunk');
                        // Only show reasoning text after what was already flushed
                        const newReasoningText = fullReasoningText.slice(
                            flushedReasoningLength,
                        );
                        accumulatedReasoningText = newReasoningText;

                        if (!newReasoningText.trim()) return;

                        setMessages(prev => {
                            // If we already have a reasoning message for this turn, update it by ID
                            if (currentReasoningMessageId !== null) {
                                return prev.map(msg =>
                                    msg.id === currentReasoningMessageId
                                        ? {...msg, text: newReasoningText}
                                        : msg,
                                );
                            }

                            // First chunk - create new reasoning message and store its ID
                            const newId = Date.now();
                            currentReasoningMessageId = newId;
                            return [
                                ...prev,
                                {
                                    id: newId,
                                    sender: 'reasoning',
                                    text: newReasoningText,
                                },
                            ];
                        });
                    },
                    onCommandMessage: cmdMsg => {
                        logDeduplicated('onCommandMessage');
                        // Before adding command message, flush reasoning and text separately
                        // This preserves the order: reasoning -> command -> response text
                        const messagesToAdd: Message[] = [];

                        if (accumulatedReasoningText.trim()) {
                            // Reasoning is already in messages via stream updates.
                            // We just need to track what we've "flushed" (sealed) so next reasoning chunks start fresh.
                            flushedReasoningLength +=
                                accumulatedReasoningText.length;
                            accumulatedReasoningText = '';
                            currentReasoningMessageId = null; // Reset for potential post-command reasoning
                        }

                        if (accumulatedText.trim()) {
                            const textMessage: BotMessage = {
                                id: Date.now() + 1,
                                sender: 'bot',
                                text: accumulatedText,
                            };
                            messagesToAdd.push(textMessage);
                            accumulatedText = '';
                            textWasFlushed = true;
                        }

                        if (messagesToAdd.length > 0) {
                            setMessages(prev => [...prev, ...messagesToAdd]);
                            // Clear live response since we've committed the text
                            setLiveResponse(null);
                        }

                        // Add command messages in real-time as they execute
                        setMessages(prev => [...prev, cmdMsg]);
                    },
                });

                applyServiceResult(
                    result,
                    accumulatedText,
                    accumulatedReasoningText,
                    textWasFlushed,
                );
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

                const errorMessage =
                    error instanceof Error ? error.message : String(error);

                // Check if this is a max turns exceeded error
                const isMaxTurnsError = errorMessage.includes('Max turns') && errorMessage.includes('exceeded');

                if (isMaxTurnsError) {
                    // Create an approval prompt for max turns continuation
                    const approvalMessage: ApprovalMessage = {
                        id: Date.now(),
                        sender: 'approval',
                        approval: {
                            agentName: 'System',
                            toolName: 'max_turns_exceeded',
                            argumentsText: errorMessage,
                            rawInterruption: null,
                            isMaxTurnsPrompt: true,
                        },
                        answer: null,
                    };
                    setPendingApprovalMessageId(approvalMessage.id);
                    setMessages(prev => [...prev, approvalMessage]);
                    setWaitingForApproval(true);
                } else {
                    // For other errors, just show the error message
                    const botErrorMessage: BotMessage = {
                        id: Date.now(),
                        sender: 'bot',
                        text: `Error: ${errorMessage}`,
                    };
                    setMessages(prev => [...prev, botErrorMessage]);
                    // Reset approval state on error to allow user to continue
                    setWaitingForApproval(false);
                    setPendingApprovalMessageId(null);
                }
            } finally {
                loggingService.debug('sendUserMessage finally block - resetting state');
                flushLog();
                setLiveResponse(null);
                setIsProcessing(false);
                // Don't reset waitingForApproval here - it's set by applyServiceResult
                // and should only be cleared by handleApprovalDecision or stopProcessing
            }
        },
        [conversationService, applyServiceResult],
    );

    const handleApprovalDecision = useCallback(
        async (answer: string, rejectionReason?: string) => {
            if (!waitingForApproval) {
                return;
            }

            // Check if this is a max turns exceeded prompt
            const approvalMessage = messages.find(
                msg => msg.sender === 'approval' && msg.id === pendingApprovalMessageId
            ) as ApprovalMessage | undefined;
            const isMaxTurnsPrompt = approvalMessage?.approval?.isMaxTurnsPrompt;

            setMessages(prev =>
                prev.map(msg =>
                    msg.sender === 'approval' &&
                    msg.id === pendingApprovalMessageId
                        ? {...msg, answer, rejectionReason}
                        : msg,
                ),
            );

            // Handle "n" answer for max turns - return to input
            if (isMaxTurnsPrompt && answer === 'n') {
                setWaitingForApproval(false);
                setPendingApprovalMessageId(null);
                setIsProcessing(false);
                return;
            }

            // Handle "y" answer for max turns - continue execution automatically
            if (isMaxTurnsPrompt && answer === 'y') {
                setWaitingForApproval(false);
                setPendingApprovalMessageId(null);
                setIsProcessing(true);

                const liveMessageId = Date.now();
                setLiveResponse({
                    id: liveMessageId,
                    sender: 'bot',
                    text: '',
                });

                // Track accumulated text so we can flush it before command messages
                let accumulatedText = '';
                let accumulatedReasoningText = '';
                let flushedReasoningLength = 0;
                let textWasFlushed = false;
                let currentReasoningMessageId: number | null = null;

                const {logDeduplicated, flush: flushLog} = createEventLogger();

                try {
                    // Send a continuation message to resume work
                    const continuationMessage = 'Please continue with your previous task.';
                    const result = await conversationService.sendMessage(continuationMessage, {
                        onTextChunk: (_fullText, chunk = '') => {
                            logDeduplicated('onTextChunk');
                            accumulatedText += chunk;
                            setLiveResponse(prev =>
                                prev && prev.id === liveMessageId
                                    ? {...prev, text: accumulatedText}
                                    : {
                                            id: liveMessageId,
                                            sender: 'bot',
                                            text: accumulatedText,
                                      },
                            );
                        },
                        onReasoningChunk: fullReasoningText => {
                            logDeduplicated('onReasoningChunk');
                            const newReasoningText = fullReasoningText.slice(
                                flushedReasoningLength,
                            );
                            accumulatedReasoningText = newReasoningText;

                            if (!newReasoningText.trim()) return;

                            setMessages(prev => {
                                if (currentReasoningMessageId !== null) {
                                    return prev.map(msg =>
                                        msg.id === currentReasoningMessageId
                                            ? {...msg, text: newReasoningText}
                                            : msg,
                                    );
                                }

                                const newId = Date.now();
                                currentReasoningMessageId = newId;
                                return [
                                    ...prev,
                                    {
                                        id: newId,
                                        sender: 'reasoning',
                                        text: newReasoningText,
                                    },
                                ];
                            });
                        },
                        onCommandMessage: cmdMsg => {
                            logDeduplicated('onCommandMessage');
                            const messagesToAdd: Message[] = [];

                            if (accumulatedReasoningText.trim()) {
                                flushedReasoningLength +=
                                    accumulatedReasoningText.length;
                                accumulatedReasoningText = '';
                                currentReasoningMessageId = null;
                            }

                            if (accumulatedText.trim()) {
                                const textMessage: BotMessage = {
                                    id: Date.now() + 1,
                                    sender: 'bot',
                                    text: accumulatedText,
                                };
                                messagesToAdd.push(textMessage);
                                accumulatedText = '';
                                textWasFlushed = true;
                            }

                            if (messagesToAdd.length > 0) {
                                setMessages(prev => [
                                    ...prev,
                                    ...messagesToAdd,
                                ]);
                                setLiveResponse(null);
                            }

                            setMessages(prev => [...prev, cmdMsg]);
                        },
                    });

                    applyServiceResult(
                        result,
                        accumulatedText,
                        accumulatedReasoningText,
                        textWasFlushed,
                    );
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

                    const errorMessage =
                        error instanceof Error ? error.message : String(error);
                    const botErrorMessage: BotMessage = {
                        id: Date.now(),
                        sender: 'bot',
                        text: `Error: ${errorMessage}`,
                    };
                    setMessages(prev => [...prev, botErrorMessage]);
                    setWaitingForApproval(false);
                    setPendingApprovalMessageId(null);
                } finally {
                    flushLog();
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

            // Track accumulated text so we can flush it before command messages
            let accumulatedText = '';
            let accumulatedReasoningText = '';
            let flushedReasoningLength = 0; // Track how much reasoning has been flushed
            let textWasFlushed = false;
            let currentReasoningMessageId: number | null = null; // Track current reasoning message ID

            // Create event logger with deduplication for this approval decision
            const {logDeduplicated, flush: flushLog} = createEventLogger();

            try {
                const result = await conversationService.handleApprovalDecision(
                    answer,
                    rejectionReason,
                    {
                        onTextChunk: (_fullText, chunk = '') => {
                            logDeduplicated('onTextChunk');
                            accumulatedText += chunk;
                            setLiveResponse(prev =>
                                prev && prev.id === liveMessageId
                                    ? {...prev, text: accumulatedText}
                                    : {
                                            id: liveMessageId,
                                            sender: 'bot',
                                            text: accumulatedText,
                                      },
                            );
                        },
                        onReasoningChunk: fullReasoningText => {
                            logDeduplicated('onReasoningChunk');
                            // Only show reasoning text after what was already flushed
                            const newReasoningText = fullReasoningText.slice(
                                flushedReasoningLength,
                            );
                            accumulatedReasoningText = newReasoningText;

                            if (!newReasoningText.trim()) return;

                            setMessages(prev => {
                                // If we already have a reasoning message for this turn, update it by ID
                                if (currentReasoningMessageId !== null) {
                                    return prev.map(msg =>
                                        msg.id === currentReasoningMessageId
                                            ? {...msg, text: newReasoningText}
                                            : msg,
                                    );
                                }

                                // First chunk - create new reasoning message and store its ID
                                const newId = Date.now();
                                currentReasoningMessageId = newId;
                                return [
                                    ...prev,
                                    {
                                        id: newId,
                                        sender: 'reasoning',
                                        text: newReasoningText,
                                    },
                                ];
                            });
                        },
                        onCommandMessage: cmdMsg => {
                            logDeduplicated('onCommandMessage');
                            // Before adding command message, flush reasoning and text separately
                            // This preserves the order: reasoning -> command -> response text
                            const messagesToAdd: Message[] = [];

                            if (accumulatedReasoningText.trim()) {
                                // Reasoning is already in messages via stream updates
                                flushedReasoningLength +=
                                    accumulatedReasoningText.length;
                                accumulatedReasoningText = '';
                                currentReasoningMessageId = null; // Reset for potential post-command reasoning
                            }

                            if (accumulatedText.trim()) {
                                const textMessage: BotMessage = {
                                    id: Date.now() + 1,
                                    sender: 'bot',
                                    text: accumulatedText,
                                };
                                messagesToAdd.push(textMessage);
                                accumulatedText = '';
                                textWasFlushed = true;
                            }

                            if (messagesToAdd.length > 0) {
                                setMessages(prev => [
                                    ...prev,
                                    ...messagesToAdd,
                                ]);
                                // Clear live response since we've committed the text
                                setLiveResponse(null);
                            }

                            // Add command messages in real-time as they execute
                            setMessages(prev => [...prev, cmdMsg]);
                        },
                    },
                );
                applyServiceResult(
                    result,
                    accumulatedText,
                    accumulatedReasoningText,
                    textWasFlushed,
                );
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

                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                const botErrorMessage: BotMessage = {
                    id: Date.now(),
                    sender: 'bot',
                    text: `Error: ${errorMessage}`,
                };
                setMessages(prev => [...prev, botErrorMessage]);
                // Reset approval state on error to allow user to continue
                setWaitingForApproval(false);
                setPendingApprovalMessageId(null);
            } finally {
                loggingService.debug('handleApprovalDecision finally block - resetting state');
                flushLog();
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
            pendingApprovalMessageId,
            waitingForApproval,
            messages,
        ],
    );

    const clearConversation = useCallback(() => {
        conversationService.reset();
        setMessages([]);
        setWaitingForApproval(false);
        setPendingApprovalMessageId(null);
        setIsProcessing(false);
        setLiveResponse(null);
    }, [conversationService]);

    const stopProcessing = useCallback(() => {
        conversationService.abort();
        setWaitingForApproval(false);
        setWaitingForRejectionReason(false);
        setPendingApprovalMessageId(null);
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

    const addSystemMessage = useCallback((text: string) => {
        setMessages(prev => [
            ...prev,
            {
                id: Date.now(),
                sender: 'system',
                text,
            },
        ]);
    }, []);

    return {
        messages,
        liveResponse,
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
        addSystemMessage,
    };
};
