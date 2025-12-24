import {useCallback, useRef, useState} from 'react';
import type {ConversationService} from '../services/conversation-service.js';
import {isAbortLikeError} from '../utils/error-helpers.js';
import type {ConversationEvent} from '../services/conversation-events.js';
import type {ILoggingService} from '../services/service-interfaces.js';

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
    const approvedContextRef = useRef<{
        callId?: string;
        toolName?: string;
    } | null>(null);

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

    const annotateCommandMessage = useCallback((cmdMsg: CommandMessage): CommandMessage => {
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
    }, []);

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

                setMessages(prev => [...prev, ...messagesToAdd]);
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
                // Reasoning is now streamed directly to messages, so we don't need to add it here

                const withCommands =
                    result.commandMessages.length > 0
                        ? [
                              ...prev,
                              ...messagesToAdd,
                              ...result.commandMessages.map(annotateCommandMessage),
                          ]
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
            setPendingApproval(null);
        },
        [annotateCommandMessage],
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
            // const {logDeduplicated, flush: flushLog} = createEventLogger();

            const applyConversationEvent = (event: ConversationEvent) => {
                switch (event.type) {
                    case 'text_delta': {
                        // logDeduplicated('text_delta');
                        accumulatedText += event.delta;
                        setLiveResponse(prev =>
                            prev && prev.id === liveMessageId
                                ? {...prev, text: accumulatedText}
                                : {
                                        id: liveMessageId,
                                        sender: 'bot',
                                        text: accumulatedText,
                                  },
                        );
                        return;
                    }
                    case 'reasoning_delta': {
                        // logDeduplicated('reasoning_delta');
                        const fullReasoningText = event.fullText ?? '';
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
                        return;
                    }
                    case 'command_message': {
                        // logDeduplicated('command_message');
                        const cmdMsg = event.message as any;
                        const annotated = annotateCommandMessage(cmdMsg as CommandMessage);
                        const annotated = annotateCommandMessage(cmdMsg as CommandMessage);

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
                        setMessages(prev => [...prev, annotated]);
                        return;
                    }
                    default:
                        return;
                }
            };

            try {
                const result = await conversationService.sendMessage(value, {
                    onTextChunk: (_fullText, chunk = '') => {
                        applyConversationEvent({
                            type: 'text_delta',
                            delta: chunk,
                            fullText: _fullText,
                        });
                    },
                    onReasoningChunk: (fullReasoningText, chunk = '') => {
                        applyConversationEvent({
                            type: 'reasoning_delta',
                            delta: chunk,
                            fullText: fullReasoningText,
                        });
                    },
                    onCommandMessage: cmdMsg => {
                        applyConversationEvent({
                            type: 'command_message',
                            message: cmdMsg as any,
                        });
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

                let errorMessage =
                    error instanceof Error ? error.message : String(error);

                // Enhance error messages for common issues
                if (errorMessage.includes('OPENAI_API_KEY') ||
                    errorMessage.includes('401') && errorMessage.toLowerCase().includes('unauthorized')) {
                    errorMessage =
                        'OpenAI API key is not configured or invalid. Please set the OPENAI_API_KEY environment variable. ' +
                        'Get your API key from: https://platform.openai.com/api-keys';
                }

                // Check if this is a max turns exceeded error
                const isMaxTurnsError = errorMessage.includes('Max turns') && errorMessage.includes('exceeded');

                if (isMaxTurnsError) {
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
                    setMessages(prev => [...prev, botErrorMessage]);
                    // Reset approval state on error to allow user to continue
                    setWaitingForApproval(false);
                    setPendingApproval(null);
                }
            } finally {
                loggingService.debug('sendUserMessage finally block - resetting state');
                // flushLog();
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
            if (!waitingForApproval || !pendingApproval) {
                return;
            }

            // Check if this is a max turns exceeded prompt
            const isMaxTurnsPrompt = pendingApproval.isMaxTurnsPrompt;

            if (answer === 'y' && pendingApproval.toolName === 'search_replace') {
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

                // Track accumulated text so we can flush it before command messages
                let accumulatedText = '';
                let accumulatedReasoningText = '';
                let flushedReasoningLength = 0;
                let textWasFlushed = false;
                let currentReasoningMessageId: number | null = null;

                // const {logDeduplicated, flush: flushLog} = createEventLogger();

                const applyConversationEvent = (event: ConversationEvent) => {
                    switch (event.type) {
                        case 'text_delta': {
                            // logDeduplicated('text_delta');
                            accumulatedText += event.delta;
                            setLiveResponse(prev =>
                                prev && prev.id === liveMessageId
                                    ? {...prev, text: accumulatedText}
                                    : {
                                            id: liveMessageId,
                                            sender: 'bot',
                                            text: accumulatedText,
                                      },
                            );
                            return;
                        }
                        case 'reasoning_delta': {
                            // logDeduplicated('reasoning_delta');
                            const fullReasoningText = event.fullText ?? '';
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
                            return;
                        }
                        case 'command_message': {
                            // logDeduplicated('command_message');
                            const cmdMsg = event.message as any;
                            const annotated = annotateCommandMessage(cmdMsg as CommandMessage);

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
                                setMessages(prev => [...prev, ...messagesToAdd]);
                                setLiveResponse(null);
                            }

                            setMessages(prev => [...prev, annotated]);
                            return;
                        }
                        default:
                            return;
                    }
                };

                try {
                    // Send a continuation message to resume work
                    const continuationMessage = 'Please continue with your previous task.';
                    const result = await conversationService.sendMessage(continuationMessage, {
                        onTextChunk: (_fullText, chunk = '') => {
                            applyConversationEvent({
                                type: 'text_delta',
                                delta: chunk,
                                fullText: _fullText,
                            });
                        },
                        onReasoningChunk: (fullReasoningText, chunk = '') => {
                            applyConversationEvent({
                                type: 'reasoning_delta',
                                delta: chunk,
                                fullText: fullReasoningText,
                            });
                        },
                        onCommandMessage: cmdMsg => {
                            applyConversationEvent({
                                type: 'command_message',
                                message: cmdMsg as any,
                            });
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
                    setPendingApproval(null);
                } finally {
                    // flushLog();
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
            // const {logDeduplicated, flush: flushLog} = createEventLogger();

            const applyConversationEvent = (event: ConversationEvent) => {
                switch (event.type) {
                    case 'text_delta': {
                        // logDeduplicated('text_delta');
                        accumulatedText += event.delta;
                        setLiveResponse(prev =>
                            prev && prev.id === liveMessageId
                                ? {...prev, text: accumulatedText}
                                : {
                                        id: liveMessageId,
                                        sender: 'bot',
                                        text: accumulatedText,
                                  },
                        );
                        return;
                    }
                    case 'reasoning_delta': {
                        // logDeduplicated('reasoning_delta');
                        const fullReasoningText = event.fullText ?? '';
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
                        return;
                    }
                    case 'command_message': {
                        // logDeduplicated('command_message');
                        const cmdMsg = event.message as any;

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
                            setMessages(prev => [...prev, ...messagesToAdd]);
                            setLiveResponse(null);
                        }

                        setMessages(prev => [...prev, annotated]);
                        return;
                    }
                    default:
                        return;
                }
            };

            try {
                const result = await conversationService.handleApprovalDecision(
                    answer,
                    rejectionReason,
                    {
                        onTextChunk: (_fullText, chunk = '') => {
                            applyConversationEvent({
                                type: 'text_delta',
                                delta: chunk,
                                fullText: _fullText,
                            });
                        },
                        onReasoningChunk: (fullReasoningText, chunk = '') => {
                            applyConversationEvent({
                                type: 'reasoning_delta',
                                delta: chunk,
                                fullText: fullReasoningText,
                            });
                        },
                        onCommandMessage: cmdMsg => {
                            applyConversationEvent({
                                type: 'command_message',
                                message: cmdMsg as any,
                            });
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
                setPendingApproval(null);
            } finally {
                loggingService.debug('handleApprovalDecision finally block - resetting state');
                // flushLog();
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
    };
};
