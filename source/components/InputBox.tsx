import React, {FC, useEffect, useState, useRef, useCallback} from 'react';
import {Box, Text, useInput} from 'ink';
import {MultilineInput} from 'ink-prompt';
import {useInputContext} from '../context/InputContext.js';
import {useSlashCommands} from '../hooks/use-slash-commands.js';
import {usePathCompletion} from '../hooks/use-path-completion.js';
import {useSettingsCompletion} from '../hooks/use-settings-completion.js';
import {
    useModelSelection,
    MODEL_TRIGGER,
    MODEL_CMD_TRIGGER,
    MENTOR_TRIGGER,
} from '../hooks/use-model-selection.js';
import {PopupManager} from './Input/PopupManager.js';
import type {SlashCommand} from './SlashCommandMenu.js';
import type {SettingsService} from '../services/settings-service.js';
import type {LoggingService} from '../services/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import { useInputHistory } from '../hooks/use-input-history.js';

// Constants
const STOP_CHAR_REGEX = /[\s,;:()[\]{}<>]/;
const TERMINAL_PADDING = 3;
const SETTINGS_TRIGGER = '/settings ';

type Props = {
    onSubmit: (v: string) => void;
    slashCommands: SlashCommand[];
    hasConversationHistory?: boolean;
    waitingForRejectionReason?: boolean;
    settingsService: SettingsService;
    loggingService: LoggingService;
    historyService: HistoryService;
};

const InputBox: FC<Props> = ({
    onSubmit,
    slashCommands,
    settingsService,
    loggingService,
    hasConversationHistory = false,
    waitingForRejectionReason = false,
    historyService,
}) => {
    const {
        input: value,
        setInput: onChange,
        mode,
        setMode,
        cursorOffset,
        setCursorOffset,
    } = useInputContext();

    const [escHintVisible, setEscHintVisible] = useState(false);
    const escTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const escPressedRef = useRef(false);
    const [cursorOverride, setCursorOverride] = useState<number | null>(null);
    const [terminalWidth, setTerminalWidth] = useState(0);

    // Hooks
    const slash = useSlashCommands({
        commands: slashCommands,
        onClose: () => {
            // Focus returns to text mode automatically via hook
        },
    });

    const path = usePathCompletion({loggingService});
    const settings = useSettingsCompletion(settingsService);
    const models = useModelSelection(
        {
            loggingService,
            settingsService,
        },
        hasConversationHistory,
    );

    const {navigateUp, navigateDown} = useInputHistory(historyService);

    // Set terminal width
    useEffect(() => {
        const calculateTerminalWidth = () =>
            Math.max(0, (process.stdout.columns ?? 0) - TERMINAL_PADDING);
        setTerminalWidth(calculateTerminalWidth());
        let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
        const handleResize = () => {
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
            }
            resizeTimeout = setTimeout(() => {
                resizeTimeout = null;
                setTerminalWidth(calculateTerminalWidth());
            }, 120);
        };
        process.stdout.on('resize', handleResize);
        return () => {
            process.stdout.off('resize', handleResize);
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
            }
        };
    }, []);

    // Cleanup timeout
    useEffect(() => {
        return () => {
            if (escTimeoutRef.current) clearTimeout(escTimeoutRef.current);
        };
    }, []);

    useEffect(() => {
        if (cursorOverride !== null && cursorOverride === cursorOffset) {
            setCursorOverride(null);
        }
    }, [cursorOverride, cursorOffset]);

    // Trigger Detection
    useEffect(() => {
        if (escPressedRef.current) {
            escPressedRef.current = false;
            return;
        }

        // Allow trigger detection in all modes to enable menu transitions

        // Priority 0: Model selection for agent.model
        if (
            value.startsWith(MODEL_TRIGGER) &&
            cursorOffset >= MODEL_TRIGGER.length
        ) {
            models.open(MODEL_TRIGGER.length);
            return;
        }

        if (
            value.startsWith(MODEL_CMD_TRIGGER) &&
            cursorOffset >= MODEL_CMD_TRIGGER.length
        ) {
            models.open(MODEL_CMD_TRIGGER.length);
            return;
        }

        if (
            value.startsWith(MENTOR_TRIGGER) &&
            cursorOffset >= MENTOR_TRIGGER.length
        ) {
            models.open(MENTOR_TRIGGER.length);
            return;
        }

        if (mode === 'model_selection') {
            models.close();
        }

        // Priority 1: Settings
        if (
            value.startsWith(SETTINGS_TRIGGER) &&
            cursorOffset >= SETTINGS_TRIGGER.length
        ) {
            settings.open(SETTINGS_TRIGGER.length);
            return;
        }

        // If no settings match, close settings menu if it was open
        if (mode === 'settings_completion') {
            settings.close();
        }

        // Priority 2: Slash (only if at start)
        if (
            value.startsWith('/') &&
            !value.slice(1).includes(' ') &&
            cursorOffset > 0
        ) {
            // Only trigger if we haven't typed a space yet (simple command)
            // Or if we are just starting.
            // Existing logic: "value.startsWith('/')" -> open slash menu.
            // But if we have "/cmd arg", usually slash menu closes.
            // rely on SlashCommandMenu logic?
            // "Case 2: Command with arguments" in useSlashCommands handles "model gpt-4" matching "model".
            // So we should keep it open.
            slash.open();
            return;
        }

        // If no slash match, close slash menu if it was open
        if (mode === 'slash_commands') {
            slash.close();
        }

        // Priority 3: Path
        // We need to find the trigger '@' or similar backward from cursor
        const pathTrigger = findPathTrigger(
            value,
            cursorOffset,
            STOP_CHAR_REGEX,
        );
        if (pathTrigger) {
            path.open(pathTrigger.start);
            return;
        }

        // If no path match, close path menu if it was open
        if (mode === 'path_completion') {
            path.close();
        }
    }, [value, cursorOffset, mode, slash, path, settings, models]);

    // Handle inputs based on mode
    // ESC handling
    useInput((_input, key) => {
        if (key.escape) {
            // Prevent trigger detection right after ESC
            escPressedRef.current = true;

            if (mode !== 'text') {
                // Close menu
                setMode('text');
                return;
            }

            // In text mode: double ESC to clear
            if (escHintVisible) {
                if (escTimeoutRef.current) {
                    clearTimeout(escTimeoutRef.current);
                    escTimeoutRef.current = null;
                }
                setEscHintVisible(false);
                onChange('');
            } else {
                setEscHintVisible(true);
                escTimeoutRef.current = setTimeout(() => {
                    setEscHintVisible(false);
                    escTimeoutRef.current = null;
                }, 2000);
            }
        }
    });

    // Mode specific Input handling (Enter, Tab)
    // We can use a single useInput for navigation/selection if we verify mode
    useInput((_input, key) => {
        if (mode === 'text') return; // Handled by standard input or history

        if (mode === 'slash_commands') {
            // Enter is handled by handleSubmit -> executeSlashCommand usually?
            // But existing code: "onSlashMenuSelect" called by "handleSubmit".
            // We can handle Tab here?
        }

        if (mode === 'path_completion') {
            if (key.tab && !key.shift) {
                insertSelectedPath(false);
            }
        }

        if (mode === 'settings_completion') {
            if (key.tab && !key.shift) {
                insertSelectedSetting();
            }
        }

        if (mode === 'model_selection') {
            if (key.tab && !key.shift && models.canSwitchProvider) {
                models.toggleProvider();
            }
        }
    });

    const [, setInputKey] = useState(0);

    const handleBoundaryArrow = useCallback(
        (direction: 'up' | 'down' | 'left' | 'right') => {
            if (mode === 'slash_commands') {
                if (direction === 'up') slash.moveUp();
                if (direction === 'down') slash.moveDown();
            } else if (mode === 'settings_completion') {
                if (direction === 'up') settings.moveUp();
                if (direction === 'down') settings.moveDown();
            } else if (mode === 'path_completion') {
                if (direction === 'up') path.moveUp();
                if (direction === 'down') path.moveDown();
            } else if (mode === 'model_selection') {
                if (direction === 'up') models.moveUp();
                if (direction === 'down') models.moveDown();
            } else {
                // History
                if (direction === 'up') {
                    const historyValue = navigateUp(value);
                    if (historyValue !== null) {
                        onChange(historyValue);
                        setInputKey(prev => prev + 1);
                    }
                } else if (direction === 'down') {
                    const historyValue = navigateDown();
                    if (historyValue !== null) {
                        onChange(historyValue);
                        setInputKey(prev => prev + 1);
                    }
                }
            }
        },
        [mode, slash, settings, path, models, navigateUp, navigateDown, value, onChange],
    );

    const insertSelectedPath = useCallback(
        (appendTrailingSpace: boolean): boolean => {
            const selection = path.getSelectedItem();
            // triggerIndex from context
            const triggerIdx = path.triggerIndex;

            if (!selection || triggerIdx === null) return false;

            const safeCursor = Math.min(cursorOffset, value.length);
            const before = value.slice(0, triggerIdx);
            const after = value.slice(safeCursor);
            const displayPath =
                selection.type === 'directory'
                    ? `${selection.path}/`
                    : selection.path;
            const suffix = appendTrailingSpace ? ' ' : '';
            const nextValue = `${before}${displayPath}${suffix}${after}`;
            onChange(nextValue);
            const nextCursor =
                before.length + displayPath.length + suffix.length;
            setCursorOverride(nextCursor);
            path.close();
            return true;
        },
        [path, cursorOffset, value, onChange],
    );

    const insertSelectedSetting = useCallback((): boolean => {
        const selection = settings.getSelectedItem();
        if (!selection) return false;

        if (!value.startsWith(SETTINGS_TRIGGER)) return false;

        const newValue = SETTINGS_TRIGGER + selection.key + ' ';
        onChange(newValue);
        setCursorOverride(newValue.length);
        settings.close();
        return true;
    }, [settings, value, onChange]);

    const insertSelectedModel = useCallback(
        (submitAfterInsert: boolean): boolean => {
            const selection = models.getSelectedItem();
            const triggerIdx = models.triggerIndex;

            if (!selection || triggerIdx === null) return false;

            const before = value.slice(0, triggerIdx);

            // For mentor model, we DO NOT append the provider flag because settings-command
            // treats it as a generic string setting and doesn't support --provider parsing for it yet.
            // Also, we implicitly enforce 'same provider' for now.
            const isMentor = value.startsWith(MENTOR_TRIGGER);

            // Use the current provider state instead of selection.provider to avoid stale data
            // when user presses Enter immediately after toggling providers
            const currentProvider = models.provider || 'openai';

            let insertion = selection.id;
            if (!isMentor) {
                insertion += ` --provider=${currentProvider}`;
            }

            const nextValue = `${before}${insertion}${
                submitAfterInsert ? '' : ' '
            }`;
            onChange(nextValue);
            setCursorOverride(nextValue.length);
            models.close();

            if (submitAfterInsert) {
                onSubmit(nextValue);
            }

            return true;
        },
        [models, value, onChange, onSubmit],
    );

    const handleWrapperSubmit = useCallback(
        (submittedValue: string) => {
            if (mode === 'path_completion') {
                if (insertSelectedPath(true)) return;
            }
            if (mode === 'settings_completion') {
                // Check if complete
                const parts = submittedValue
                    .slice(SETTINGS_TRIGGER.length)
                    .trim()
                    .split(/\s+/);
                if (parts.length >= 2) {
                    onSubmit(submittedValue);
                    return;
                }
                if (insertSelectedSetting()) return;
            }
            if (mode === 'model_selection') {
                if (insertSelectedModel(true)) return;
            }
            if (mode === 'slash_commands') {
                slash.executeSelected();
                setInputKey(prev => prev + 1);
                return;
            }

            onSubmit(submittedValue);
        },
        [
            mode,
            onSubmit,
            insertSelectedPath,
            insertSelectedSetting,
            insertSelectedModel,
            slash,
        ],
    );

    return (
        <Box flexDirection="column">
            <PopupManager
                slash={{
                    isOpen: slash.isOpen,
                    commands: slash.filteredCommands,
                    selectedIndex: slash.selectedIndex,
                    filter: slash.filter,
                }}
                path={{
                    isOpen: path.isOpen,
                    items: path.filteredEntries,
                    selectedIndex: path.selectedIndex,
                    query: path.query,
                    loading: path.loading,
                    error: path.error,
                }}
                models={{
                    isOpen: models.isOpen,
                    items: models.filteredModels,
                    selectedIndex: models.selectedIndex,
                    query: models.query,
                    loading: models.loading,
                    error: models.error,
                    provider: models.provider,
                    scrollOffset: models.scrollOffset,
                    canSwitchProvider: models.canSwitchProvider,
                }}
                settings={{
                    isOpen: settings.isOpen,
                    items: settings.filteredEntries,
                    selectedIndex: settings.selectedIndex,
                }}
                settingsService={settingsService}
            />
            <Box>
                {waitingForRejectionReason ? (
                    <Text color="yellow">Why? </Text>
                ) : (
                    <Text color="blue">❯ </Text>
                )}
                <MultilineInput
                    value={value}
                    width={terminalWidth}
                    onChange={onChange}
                    onSubmit={handleWrapperSubmit}
                    onCursorChange={setCursorOffset}
                    cursorOverride={cursorOverride ?? undefined}
                    onBoundaryArrow={handleBoundaryArrow}
                />
            </Box>
            {escHintVisible && (
                <Text color="gray" dimColor>
                    Press ESC again to clear input
                </Text>
            )}
            {waitingForRejectionReason && (
                <Text color="gray" dimColor>
                    (or ESC to cancel)
                </Text>
            )}
        </Box>
    );
};

export default React.memo(InputBox);

const whitespaceRegex = /\s/;

const findPathTrigger = (
    text: string,
    cursor: number,
    stopChars: RegExp,
): {start: number; query: string} | null => {
    if (cursor <= 0 || cursor > text.length) {
        return null;
    }

    for (let index = cursor - 1; index >= 0; index -= 1) {
        const char = text[index];
        if (char === '@') {
            const query = text.slice(index + 1, cursor);
            if (whitespaceRegex.test(query)) {
                return null;
            }
            return {start: index, query};
        }
        if (stopChars.test(char)) {
            break;
        }
    }

    return null;
};
