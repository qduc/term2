import React, {FC, useMemo, useCallback, useEffect} from 'react';
import {useInputActions} from './context/InputContext.js';

import {Box, useApp, useInput} from 'ink';
import {useConversation} from './hooks/use-conversation.js';
import Banner from './components/Banner.js';
import MessageList from './components/MessageList.js';
import LiveResponse from './components/LiveResponse.js';
import BottomArea from './components/BottomArea.js';
import {ErrorBoundary} from './components/ErrorBoundary.js';
import type {SlashCommand} from './components/SlashCommandMenu.js';
import type {ConversationService} from './services/conversation-service.js';
import type {SettingsService} from './services/settings-service.js';
import type {HistoryService} from './services/history-service.js';
import type {LoggingService} from './services/logging-service.js';
import {createSettingsCommand} from './utils/settings-command.js';
import {setTrimConfig} from './utils/output-trim.js';
import {getProvider} from './providers/index.js';

// Pure function to parse slash commands
type ParsedInput =
    | {type: 'slash-command'; commandName: string; args: string}
    | {type: 'message'; text: string};

function parseInput(value: string): ParsedInput {
    if (!value.startsWith('/')) {
        return {type: 'message', text: value};
    }

    const commandLine = value.slice(1); // Remove leading '/'
    const [commandName, ...argsParts] = commandLine.split(/\s+/);
    const args = argsParts.join(' ');

    return {type: 'slash-command', commandName, args};
}

interface AppProps {
    conversationService: ConversationService;
    settingsService: SettingsService;
    historyService: HistoryService;
    loggingService: LoggingService;
}

const App: FC<AppProps> = ({
    conversationService,
    settingsService,
    historyService,
    loggingService,
}) => {
    const {exit} = useApp();
    const { setInput} = useInputActions();
    const {
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
        addSystemMessage,
        setTemperature,
    } = useConversation({conversationService, loggingService});
    useEffect(() => {
        conversationService.setRetryCallback(() =>
            addSystemMessage('Retrying due to upstream error...'),
        );
    }, [conversationService, addSystemMessage]);

    const applyRuntimeSetting = useCallback(
        (key: string, value: any) => {
            if (key === 'agent.model') {
                setModel(String(value));
                return;
            }

            if (key === 'agent.reasoningEffort') {
                setReasoningEffort(value);
                return;
            }

            if (key === 'agent.temperature') {
                // Settings command parses numbers already; coerce just in case.
                if (value == null) {
                    setTemperature(undefined);
                    return;
                }
                const numeric =
                    typeof value === 'number' ? value : Number(value);
                setTemperature(Number.isFinite(numeric) ? numeric : undefined);
                return;
            }

            if (key === 'agent.provider') {
                // Provider changes require the agent to be recreated, which happens
                // via the conversation service's setProvider method
                const setProviderFn = (conversationService as any).setProvider;
                if (typeof setProviderFn === 'function') {
                    setProviderFn.call(conversationService, value);
                }
                return;
            }

            if (key === 'agent.mentorModel' || key === 'agent.mentorReasoningEffort') {
            // Re-initialize the current model to refresh tools (in case mentor availability or config changes)
                const currentModel = settingsService.get<string>('agent.model');
                setModel(currentModel);
                return;
            }

            if (key === 'app.mentorMode') {
                // Re-initialize the agent to use the new mode's prompt
                const currentModel = settingsService.get<string>('agent.model');
                setModel(currentModel);
                return;
            }

            if (key === 'app.editMode') {
                // Edit mode doesn't affect the agent, just the approval flow
                // No need to re-initialize
                return;
            }

            if (key === 'app.liteMode') {
                // Re-initialize the agent to use the new mode's prompt and tools
                const currentModel = settingsService.get<string>('agent.model');
                setModel(currentModel);
                return;
            }

            if (key === 'shell.maxOutputLines') {
                setTrimConfig({maxLines: Number(value)});
                return;
            }

            if (key === 'shell.maxOutputChars') {
                setTrimConfig({maxCharacters: Number(value)});
            }
        },
        [setModel, setReasoningEffort, setTemperature, conversationService],
    );

    // Define slash commands
    const slashCommands: SlashCommand[] = useMemo(() => {
        const settingsCommand = createSettingsCommand({
            settingsService,
            addSystemMessage,
            applyRuntimeSetting,
            setInput,
        });

        return [
            {
                name: 'clear',
                description: 'Start a new conversation',
                action: () => {
                    clearConversation();
                    addSystemMessage(
                        'Welcome to term²! Type a message to start chatting.',
                    );
                },
            },
            {
                name: 'quit',
                description: 'Exit the application',
                action: () => {
                    exit();
                },
            },
            {
                name: 'model',
                description: 'Change the AI model (e.g. /model gpt-4)',
                expectsArgs: true,
                action: (args?: string) => {
                    if (!args) {
                        setInput('/model ');
                        return false;
                    }

                    // Parse model and provider from args
                    // Format: "model-id --provider=providerid" or just "model-id"
                    const providerMatch = args.match(/--provider=(\w+)/);
                    const modelId = args
                        .replace(/\s*--provider=\w+\s*/, '')
                        .trim();

                    // Validate provider if specified
                    if (providerMatch) {
                        const provider = providerMatch[1];
                        if (!getProvider(provider)) {
                            addSystemMessage(
                                `Error: Unknown provider '${provider}'`,
                            );
                            return false;
                        }
                    }

                    // Update settings and runtime
                    settingsService.set('agent.model', modelId);
                    applyRuntimeSetting('agent.model', modelId);

                    let providerMsg = '';
                    if (providerMatch) {
                        const provider = providerMatch[1];
                        settingsService.set('agent.provider', provider);
                        applyRuntimeSetting('agent.provider', provider);
                        providerMsg = ` (${provider})`;
                    }

                    addSystemMessage(`Set model to ${modelId}${providerMsg}`);

                    return true;
                },
            },
            {
                name: 'mentor',
                description: 'Toggle mentor mode (collaborative mode with mentor model)',
                action: () => {
                    const currentValue = settingsService.get<boolean>('app.mentorMode');
                    const newValue = !currentValue;

                    // Mentor mode is mutually exclusive with lite mode
                    if (newValue) {
                        const liteMode = settingsService.get<boolean>('app.liteMode');
                        if (liteMode) {
                            settingsService.set('app.liteMode', false);
                            applyRuntimeSetting('app.liteMode', false);
                        }
                    }

                    settingsService.set('app.mentorMode', newValue);
                    applyRuntimeSetting('app.mentorMode', newValue);

                    addSystemMessage(
                        `Mentor mode ${newValue ? 'enabled' : 'disabled'}${newValue ? ' - using simplified mentor prompt and ask_mentor tool' : ''}`
                    );

                    return true;
                },
            },
            {
                name: 'lite',
                description: 'Toggle lite mode (minimal context for general terminal assistance)',
                action: () => {
                    const hasHistory = messages.filter(msg => msg.sender !== 'system').length > 0;

                    if (hasHistory) {
                        addSystemMessage(
                            'Cannot switch modes mid-session (tool/context mismatch). Use `/clear` first, then `/lite`.'
                        );
                        return true;
                    }

                    const currentValue = settingsService.get<boolean>('app.liteMode');
                    const newValue = !currentValue;

                    // Lite mode is mutually exclusive with edit/mentor modes
                    if (newValue) {
                        const editMode = settingsService.get<boolean>('app.editMode');
                        const mentorMode = settingsService.get<boolean>('app.mentorMode');

                        if (editMode) {
                            settingsService.set('app.editMode', false);
                            applyRuntimeSetting('app.editMode', false);
                        }
                        if (mentorMode) {
                            settingsService.set('app.mentorMode', false);
                            applyRuntimeSetting('app.mentorMode', false);
                        }
                    }

                    settingsService.set('app.liteMode', newValue);
                    applyRuntimeSetting('app.liteMode', newValue);

                    addSystemMessage(
                        `Lite mode ${newValue ? 'enabled - using minimal prompt, no codebase context' : 'disabled'}`
                    );
                    return true;
                },
            },
            settingsCommand,
        ];
    }, [
        addSystemMessage,
        applyRuntimeSetting,
        clearConversation,
        exit,
        messages,
        setModel,
        setInput,
        settingsService,
    ]);

    const toggleEditMode = useCallback(() => {
        const currentValue = settingsService.get<boolean>('app.editMode');
        const newValue = !currentValue;

        // Edit mode is mutually exclusive with lite mode
        if (newValue) {
            const liteMode = settingsService.get<boolean>('app.liteMode');
            if (liteMode) {
                settingsService.set('app.liteMode', false);
                applyRuntimeSetting('app.liteMode', false);
            }
        }

        settingsService.set('app.editMode', newValue);
        applyRuntimeSetting('app.editMode', newValue);

        addSystemMessage(
            `Edit mode ${newValue ? 'enabled' : 'disabled'}${newValue ? ' - auto-approving file patches within workspace' : ''}`
        );
    }, [settingsService, applyRuntimeSetting, addSystemMessage]);

    // Handle Ctrl+C to exit immediately
    useInput((_input: string, key) => {
        if (key.ctrl && _input === 'c') {
            exit();
        }
    });

    // Handle Esc to stop processing or cancel rejection reason
    useInput((_input: string, key) => {
        if (key.escape && waitingForRejectionReason) {
            // Cancel rejection reason input and return to approval prompt
            setWaitingForRejectionReason(false);
            setInput('');
            return;
        }

        if (key.escape && (isProcessing || waitingForApproval)) {
            stopProcessing();
            addSystemMessage('Stopped');
            setWaitingForRejectionReason(false);
        }
    });

    // Handle y/n key presses for approval prompts - MOVED TO ApprovalPrompt component

    const handleApprove = useCallback(async () => {
        await handleApprovalDecision('y');
    }, [handleApprovalDecision]);

    const handleReject = useCallback(() => {
        setWaitingForRejectionReason(true);
    }, [setWaitingForRejectionReason]);

    // Toggle edit mode with Shift+Tab for quick approval profile switching
    useInput((input: string, key) => {
        const isShiftTab = (key.shift && key.tab) || input === '\u001b[Z';
        if (!isShiftTab) return;

        toggleEditMode();
    });

    const handleSubmit = async (value: string): Promise<void> => {
        if (!value.trim()) return;

        // If waiting for rejection reason, handle it
        if (waitingForRejectionReason) {
            setWaitingForRejectionReason(false);
            setInput('');
            await handleApprovalDecision('n', value);
            return;
        }

        // If waiting for approval, ignore text input (handled by useInput)
        if (waitingForApproval) return;

        // Parse the input to determine what to do
        const parsed = parseInput(value);

        switch (parsed.type) {
            case 'slash-command': {
                // Find matching command
                const command = slashCommands.find(
                    cmd => cmd.name === parsed.commandName,
                );
                if (command) {
                    // Execute the command
                    const shouldClearInput = command.action(
                        parsed.args || undefined,
                    );

                    // Clear input unless command returned false
                    if (shouldClearInput !== false) {
                        setInput('');
                    }
                    return;
                }
                // Command not found, fall through to send as message
                break;
            }

            case 'message':
                // Regular message, send to AI agent
                historyService.addMessage(value);
                setInput('');
                await sendUserMessage(value);
                return;
        }

        // Fallback: unknown slash command, send as message
        setInput('');
        await sendUserMessage(value);
    };

    return (
        <ErrorBoundary loggingService={loggingService}>
            <Box flexDirection="column" flexGrow={1} paddingX={2}>
                <Banner settingsService={settingsService} />
                {/* Main content area grows to fill available vertical space */}
                <Box flexDirection="column" flexGrow={1}>
                    <MessageList messages={messages} />

                    {liveResponse && liveResponse.text && <LiveResponse text={liveResponse.text} />}
                </Box>

                {/* Fixed bottom area for input / status */}
                <BottomArea
                    pendingApproval={pendingApproval}
                    waitingForApproval={waitingForApproval}
                    waitingForRejectionReason={waitingForRejectionReason}
                    isProcessing={isProcessing}
                    onSubmit={handleSubmit}
                    slashCommands={slashCommands}
                    hasConversationHistory={
                        messages.filter(msg => msg.sender !== 'system').length >
                        0
                    }
                    settingsService={settingsService}
                    loggingService={loggingService}
                    historyService={historyService}
                    onApprove={handleApprove}
                    onReject={handleReject}
                />
            </Box>
        </ErrorBoundary>
    );
};

export default App;
