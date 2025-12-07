import React, {FC, useState, useMemo, useCallback, useEffect} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {useConversation} from './hooks/use-conversation.js';
import {useSlashCommands} from './hooks/use-slash-commands.js';
import {useInputHistory} from './hooks/use-input-history.js';
import {usePathCompletion} from './hooks/use-path-completion.js';
import MessageList from './components/MessageList.js';
import InputBox from './components/InputBox.js';
import LiveResponse from './components/LiveResponse.js';
import type {SlashCommand} from './components/SlashCommandMenu.js';
import type {ConversationService} from './services/conversation-service.js';
import {settingsService} from './services/settings-service.js';
import {createSettingsCommand} from './utils/settings-command.js';
import {setTrimConfig} from './utils/output-trim.js';

interface AppProps {
    conversationService: ConversationService;
}

const App: FC<AppProps> = ({conversationService}) => {
    const {exit} = useApp();
    const [input, setInput] = useState<string>('');
    const {
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
    } = useConversation({conversationService});

    const {navigateUp, navigateDown, addToHistory} = useInputHistory();

    const [dotCount, setDotCount] = useState(1);

    useEffect(() => {
        if (!isProcessing) return;

        const interval = setInterval(() => {
            setDotCount(prev => (prev === 3 ? 1 : prev + 1));
        }, 500);

        return () => clearInterval(interval);
    }, [isProcessing]);

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

            if (key === 'agent.provider') {
                // Provider changes require the agent to be recreated, which happens
                // via the conversation service's setProvider method
                const setProvider = (conversationService as any).setProvider;
                if (typeof setProvider === 'function') {
                    setProvider.call(conversationService, value);
                }
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
        [setModel, setReasoningEffort, conversationService],
    );

    // Define slash commands
    const slashCommands: SlashCommand[] = useMemo(() => {
        const settingsCommand = createSettingsCommand({
            settingsService,
            addSystemMessage,
            applyRuntimeSetting,
        });

        return [
            {
                name: 'clear',
                description: 'Start a new conversation',
                action: () => {
                    clearConversation();
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
                    setModel(args);
                    addSystemMessage(`Set model to ${args}`);
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
        setModel,
        setInput,
    ]);

    const handleSlashMenuClose = useCallback(() => {
        // Don't clear input here - let the caller decide if input should be cleared
    }, []);

    const {
        isOpen: slashMenuOpen,
        filter: slashMenuFilter,
        selectedIndex: slashMenuSelectedIndex,
        open: openSlashMenu,
        close: closeSlashMenu,
        updateFilter: updateSlashFilter,
        moveUp: slashMenuUp,
        moveDown: slashMenuDown,
        executeSelected: executeSlashCommand,
    } = useSlashCommands({
        commands: slashCommands,
        onClose: handleSlashMenuClose,
        setText: setInput,
    });

    const {
        isOpen: pathMenuOpen,
        filteredEntries: pathMenuItems,
        selectedIndex: pathMenuSelectedIndex,
        query: pathMenuQuery,
        loading: pathMenuLoading,
        error: pathMenuError,
        triggerIndex: pathMenuTriggerIndex,
        open: openPathMenu,
        close: closePathMenu,
        updateQuery: updatePathMenuQuery,
        moveUp: pathMenuUp,
        moveDown: pathMenuDown,
        getSelectedItem,
    } = usePathCompletion();

    // Handle Ctrl+C to exit immediately
    useInput((_input: string, key) => {
        if (key.ctrl && _input === 'c') {
            exit();
        }
    });

    // Handle Esc to stop processing
    useInput((_input: string, key) => {
        if (key.escape && (isProcessing || waitingForApproval)) {
            stopProcessing();
            addSystemMessage('Stopped');
        }
    });

    // Handle y/n key presses for approval prompts
    useInput(async (inputKey: string) => {
        if (!waitingForApproval || isProcessing) return;

        const answer = inputKey.toLowerCase();
        if (answer === 'y' || answer === 'n') {
            await handleApprovalDecision(answer);
        }
    });

    const handleSubmit = async (value: string): Promise<void> => {
        if (!value.trim()) return;
        // If waiting for approval, ignore text input (handled by useInput)
        if (waitingForApproval) return;

        // Add to history and reset navigation
        addToHistory(value);
        setInput('');
        await sendUserMessage(value);
    };

    const handleHistoryUp = useCallback(() => {
        const historyValue = navigateUp(input);
        if (historyValue !== null) {
            setInput(historyValue);
        }
    }, [navigateUp, input]);

    const handleHistoryDown = useCallback(() => {
        const historyValue = navigateDown();
        if (historyValue !== null) {
            setInput(historyValue);
        }
    }, [navigateDown]);

    return (
        <Box flexDirection="column" flexGrow={1}>
            {/* Main content area grows to fill available vertical space */}
            <Box flexDirection="column" flexGrow={1}>
                <MessageList messages={messages} />

                {liveResponse && <LiveResponse text={liveResponse.text} />}
            </Box>

            {/* Fixed bottom area for input / status */}
            <Box flexDirection="column">
                {!isProcessing && !waitingForApproval && (
                    <InputBox
                        value={input}
                        onChange={setInput}
                        onSubmit={handleSubmit}
                        slashCommands={slashCommands}
                        slashMenuOpen={slashMenuOpen}
                        slashMenuSelectedIndex={slashMenuSelectedIndex}
                        slashMenuFilter={slashMenuFilter}
                        onSlashMenuOpen={openSlashMenu}
                        onSlashMenuClose={closeSlashMenu}
                        onSlashMenuUp={slashMenuUp}
                        onSlashMenuDown={slashMenuDown}
                        onSlashMenuSelect={executeSlashCommand}
                        onSlashMenuFilterChange={updateSlashFilter}
                        onHistoryUp={handleHistoryUp}
                        onHistoryDown={handleHistoryDown}
                        pathMenuOpen={pathMenuOpen}
                        pathMenuItems={pathMenuItems}
                        pathMenuSelectedIndex={pathMenuSelectedIndex}
                        pathMenuQuery={pathMenuQuery}
                        pathMenuLoading={pathMenuLoading}
                        pathMenuError={pathMenuError}
                        pathMenuTriggerIndex={pathMenuTriggerIndex}
                        onPathMenuOpen={openPathMenu}
                        onPathMenuClose={closePathMenu}
                        onPathMenuFilterChange={updatePathMenuQuery}
                        onPathMenuUp={pathMenuUp}
                        onPathMenuDown={pathMenuDown}
                        getPathMenuSelection={getSelectedItem}
                    />
                )}

                {isProcessing && (
                    <Text color="gray" dimColor>
                        processing{'.'.repeat(dotCount)}
                    </Text>
                )}
            </Box>
        </Box>
    );
};

export default App;
