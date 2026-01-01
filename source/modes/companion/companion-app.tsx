import React, {useEffect, useState, useCallback} from 'react';
import {Box, Text, useInput, useApp} from 'ink';
import {PTYWrapper} from './pty-wrapper.js';
import {ContextBuffer, type CommandEntry} from './context-buffer.js';
import {ModeManager} from './mode-manager.js';
import {EventDetector, type DetectedEvent} from './event-detector.js';
import {Summarizer} from './summarizer.js';
import {StatusBar} from './components/status-bar.js';
import {CompanionSession} from './companion-session.js';
import {parseCompanionInput, CommandOutputBuffer} from './input-parser.js';
import type {ISettingsService, ILoggingService} from '../../services/service-interfaces.js';

export interface CompanionAppProps {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
}

/**
 * Main companion mode application.
 * Wraps user's shell in a PTY and provides AI assistance.
 */
export const CompanionApp: React.FC<CompanionAppProps> = ({
    settingsService,
    loggingService,
}) => {
    const {exit} = useApp();

    // Core services
    const [ptyWrapper] = useState(
        () => new PTYWrapper({logger: loggingService}),
    );
    const [contextBuffer] = useState(
        () =>
            new ContextBuffer({
                maxSize: settingsService.get<number>('companion.maxContextBufferSize') || 1048576,
                maxCommands: settingsService.get<number>('companion.maxCommandIndexSize') || 10,
            }),
    );
    const [modeManager] = useState(() => new ModeManager());
    const [eventDetector] = useState(
        () =>
            new EventDetector({
                errorCascadeThreshold: settingsService.get<number>('companion.errorCascadeThreshold') || 3,
                retryLoopThreshold: settingsService.get<number>('companion.retryLoopThreshold') || 2,
                pauseHintDelayMs: settingsService.get<number>('companion.pauseHintDelayMs') || 30000,
            }),
    );
    const [summarizer] = useState(
        () =>
            new Summarizer({
                settings: settingsService,
                logger: loggingService,
            }),
    );
    const [companionSession] = useState(
        () =>
            new CompanionSession({
                contextBuffer,
                summarizer,
                settings: settingsService,
                logger: loggingService,
            }),
    );
    const [commandOutputBuffer] = useState(() => new CommandOutputBuffer());

    // UI state
    const [currentMode, setCurrentMode] = useState(modeManager.mode);
    const [hint, setHint] = useState<string | undefined>();
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [aiResponse, setAiResponse] = useState<string>('');

    // Input buffer for detecting ?? and !auto
    const [inputLine, setInputLine] = useState('');

    // Handle ?? query
    const handleQuery = useCallback(async (query: string) => {
        setIsProcessing(true);
        setAiResponse('');
        setHint(undefined);

        try {
            for await (const event of companionSession.handleWatchQuery(query)) {
                if (event.type === 'text' && event.content) {
                    setAiResponse(prev => prev + event.content);
                } else if (event.type === 'error') {
                    loggingService.error('Query failed', {error: event.content});
                }
            }
        } finally {
            setIsProcessing(false);
        }
    }, [companionSession, loggingService]);

    // Handle !auto task
    const handleAutoTask = useCallback(async (task: string) => {
        setIsProcessing(true);
        setAiResponse('');
        setHint(undefined);
        modeManager.enterAutoMode();

        try {
            for await (const event of companionSession.handleAutoTask(task)) {
                if (event.type === 'text' && event.content) {
                    setAiResponse(prev => prev + event.content);
                } else if (event.type === 'tool_call' && event.tool) {
                    loggingService.info('Tool call', {tool: event.tool, args: event.args});
                } else if (event.type === 'error') {
                    loggingService.error('Auto task failed', {error: event.content});
                }
            }
        } finally {
            setIsProcessing(false);
            modeManager.enterWatchMode();
        }
    }, [companionSession, modeManager, loggingService]);

    // Setup PTY and event handlers
    useEffect(() => {
        // Mode change handler
        modeManager.on('modeChange', (mode) => {
            setCurrentMode(mode);
            loggingService.info('Mode changed', {mode});
        });

        // Event detector hint handler
        eventDetector.on('hint', (event: DetectedEvent) => {
            if (settingsService.get<boolean>('companion.showHints') !== false) {
                setHint(event.message);
            }
        });

        // PTY output handler
        ptyWrapper.on('output', (data: string) => {
            // Pass through to stdout
            process.stdout.write(data);

            // Process output for command boundary detection
            const completed = commandOutputBuffer.processData(data);
            if (completed) {
                const entry: CommandEntry = {
                    command: completed.command,
                    output: completed.output,
                    exitCode: 0, // We'll need to track this differently
                    timestamp: Date.now(),
                    outputLines: completed.output.split('\n').length,
                };
                contextBuffer.addEntry(entry);

                // Check for patterns
                const event = eventDetector.processCommand(entry);
                if (event && settingsService.get<boolean>('companion.showHints') !== false) {
                    setHint(event.message);
                }
            }

            // Mark activity
            eventDetector.markActivity();
        });

        // PTY exit handler
        ptyWrapper.on('exit', (exitCode: number) => {
            loggingService.info('PTY exited', {exitCode});
            exit();
        });

        // PTY error handler
        ptyWrapper.on('error', (err: Error) => {
            loggingService.error('PTY error', {error: err.message});
            setError(err.message);
        });

        // Start PTY
        ptyWrapper.start();

        // Setup terminal resize handling
        const handleResize = () => {
            if (process.stdout.columns && process.stdout.rows) {
                // Reserve bottom rows for status bar
                const statusBarHeight = 2;
                ptyWrapper.resize(
                    process.stdout.columns,
                    process.stdout.rows - statusBarHeight,
                );
            }
        };

        process.stdout.on('resize', handleResize);
        handleResize();

        return () => {
            process.stdout.off('resize', handleResize);
            ptyWrapper.stop();
        };
    }, [
        ptyWrapper,
        contextBuffer,
        commandOutputBuffer,
        modeManager,
        eventDetector,
        settingsService,
        loggingService,
        exit,
    ]);

    // Handle keyboard input
    useInput((input, key) => {
        // Ctrl+C to exit or abort
        if (key.ctrl && input === 'c') {
            if (isProcessing) {
                companionSession.abort();
                setIsProcessing(false);
            } else {
                ptyWrapper.stop();
                exit();
            }
            return;
        }

        // Clear hint on any input
        if (hint) {
            setHint(undefined);
        }

        // Track input line for ?? and !auto detection
        if (input === '\r' || input === '\n') {
            const parsed = parseCompanionInput(inputLine);

            if (parsed.type === 'query') {
                // ?? query detected - handle with AI
                handleQuery(parsed.content);
                setInputLine('');
                return;
            }

            if (parsed.type === 'auto') {
                // !auto command detected - handle with AI
                handleAutoTask(parsed.content);
                setInputLine('');
                return;
            }

            // Normal command - track for context
            if (inputLine.trim()) {
                commandOutputBuffer.startCommand(inputLine.trim());
            }

            setInputLine('');
        } else if (key.backspace || key.delete) {
            setInputLine(prev => prev.slice(0, -1));
        } else {
            setInputLine(prev => prev + input);
        }

        // Pass input to PTY (except for ?? and !auto)
        if (!inputLine.startsWith('??') && !inputLine.startsWith('!auto')) {
            ptyWrapper.write(input);
        }
    });

    if (error) {
        return (
            <Box flexDirection="column">
                <Text color="red">Error: {error}</Text>
                <Text color="gray">Press Ctrl+C to exit</Text>
            </Box>
        );
    }

    // The main rendering is handled by PTY direct output to stdout
    // We only render the status bar and AI response via Ink
    return (
        <Box
            flexDirection="column"
            position="absolute"
            marginTop={process.stdout.rows ? process.stdout.rows - 4 : 20}
        >
            {aiResponse && (
                <Box borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={1}>
                    <Text color="cyan">{aiResponse}</Text>
                </Box>
            )}
            <StatusBar
                mode={currentMode}
                hint={hint}
                isProcessing={isProcessing}
            />
        </Box>
    );
};
