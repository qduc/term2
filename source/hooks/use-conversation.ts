import {useCallback, useState} from 'react';
import type {ConversationService} from '../services/conversation-service.js';
import {loggingService} from '../services/logging-service.js';

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
    };
    answer: string | null;
}

interface CommandMessage {
    id: string;
    sender: 'command';
    command: string;
    output: string;
    success?: boolean;
    failureReason?: string;
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
    const [pendingApprovalMessageId, setPendingApprovalMessageId] = useState<
        number | null
    >(null);
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [liveResponse, setLiveResponse] = useState<LiveResponse | null>(null);

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

                setMessages(prev => [
                    ...prev,
                    ...messagesToAdd,
                    approvalMessage,
                ]);
                setWaitingForApproval(true);
                setPendingApprovalMessageId(approvalMessage.id);
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

            // Event logging for debugging
            let lastEventType: string | null = null;
            let eventCount = 0;
            const logEvent = (eventType: string) => {
                if (eventType !== lastEventType) {
                    if (lastEventType !== null) {
                        loggingService.debug('Conversation event', {
                            event: lastEventType,
                            count: eventCount,
                        });
                    }
                    lastEventType = eventType;
                    eventCount = 1;
                } else {
                    eventCount++;
                }
            };
            const flushLog = () => {
                if (lastEventType !== null) {
                    loggingService.debug('Conversation event', {
                        event: lastEventType,
                        count: eventCount,
                    });
                    lastEventType = null;
                    eventCount = 0;
                }
            };

            try {
                const result = await conversationService.sendMessage(value, {
                    onTextChunk: (_fullText, chunk = '') => {
                        logEvent('onTextChunk');
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
                        logEvent('onReasoningChunk');
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
                        logEvent('onCommandMessage');
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
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                const botErrorMessage: BotMessage = {
                    id: Date.now(),
                    sender: 'bot',
                    text: `Error: ${errorMessage}`,
                };
                setMessages(prev => [...prev, botErrorMessage]);
            } finally {
                setLiveResponse(null);
                setIsProcessing(false);
            }
        },
        [conversationService, applyServiceResult],
    );

    const handleApprovalDecision = useCallback(
        async (answer: string) => {
            if (!waitingForApproval) {
                return;
            }

            setMessages(prev =>
                prev.map(msg =>
                    msg.sender === 'approval' &&
                    msg.id === pendingApprovalMessageId
                        ? {...msg, answer}
                        : msg,
                ),
            );

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

            try {
                const result = await conversationService.handleApprovalDecision(
                    answer,
                    {
                        onTextChunk: (_fullText, chunk = '') => {
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
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                const botErrorMessage: BotMessage = {
                    id: Date.now(),
                    sender: 'bot',
                    text: `Error: ${errorMessage}`,
                };
                setMessages(prev => [...prev, botErrorMessage]);
            } finally {
                setLiveResponse(null);
                setIsProcessing(false);
            }
        },
        [
            applyServiceResult,
            conversationService,
            pendingApprovalMessageId,
            waitingForApproval,
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
