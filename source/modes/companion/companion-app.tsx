import React, {useEffect, useState} from 'react';
import {Box, Text, useInput, useApp} from 'ink';
import {PTYWrapper} from './pty-wrapper.js';
import {ContextBuffer, type CommandEntry} from './context-buffer.js';
import {ModeManager} from './mode-manager.js';
import {EventDetector, type DetectedEvent} from './event-detector.js';
import {Summarizer} from './summarizer.js';
import {StatusBar} from './components/status-bar.js';
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
    // Summarizer will be used in Phase 2 for context building
    const [_summarizer] = useState(
        () =>
            new Summarizer({
                settings: settingsService,
                logger: loggingService,
            }),
    );

    // UI state
    const [currentMode, setCurrentMode] = useState(modeManager.mode);
    const [hint, setHint] = useState<string | undefined>();
    const [isProcessing] = useState(false); // Will be used when AI processing is implemented
    const [error, setError] = useState<string | undefined>();

    // Command parsing state
    const [currentCommand, setCurrentCommand] = useState('');
    const [currentOutput, setCurrentOutput] = useState('');

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

            // Accumulate output for context
            setCurrentOutput(prev => prev + data);

            // Mark activity
            eventDetector.markActivity();
        });

        // PTY exit handler
        ptyWrapper.on('exit', (exitCode: number) => {
            loggingService.info('PTY exited', {exitCode});

            // Store completed command
            if (currentCommand) {
                const entry: CommandEntry = {
                    command: currentCommand,
                    output: currentOutput,
                    exitCode,
                    timestamp: Date.now(),
                    outputLines: currentOutput.split('\n').length,
                };
                contextBuffer.addEntry(entry);

                // Check for patterns
                const event = eventDetector.processCommand(entry);
                if (event && settingsService.get<boolean>('companion.showHints') !== false) {
                    setHint(event.message);
                }

                setCurrentCommand('');
                setCurrentOutput('');
            }
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
        modeManager,
        eventDetector,
        settingsService,
        loggingService,
        currentCommand,
        currentOutput,
    ]);

    // Handle keyboard input
    useInput((input, key) => {
        // Ctrl+C to exit
        if (key.ctrl && input === 'c') {
            ptyWrapper.stop();
            exit();
            return;
        }

        // Clear hint on any input
        if (hint) {
            setHint(undefined);
        }

        // Pass input to PTY
        ptyWrapper.write(input);
    });

    // Query and auto command handlers will be implemented in later phases
    // For now, we just pass all input to PTY

    if (error) {
        return (
            <Box flexDirection="column">
                <Text color="red">Error: {error}</Text>
                <Text color="gray">Press Ctrl+C to exit</Text>
            </Box>
        );
    }

    // The main rendering is handled by PTY direct output to stdout
    // We only render the status bar via Ink
    return (
        <Box
            flexDirection="column"
            position="absolute"
            marginTop={process.stdout.rows ? process.stdout.rows - 2 : 22}
        >
            <StatusBar
                mode={currentMode}
                hint={hint}
                isProcessing={isProcessing}
            />
        </Box>
    );
};
