import React from 'react';
import {Box, Text} from 'ink';
import type {CompanionMode} from '../mode-manager.js';

export interface StatusBarProps {
    mode: CompanionMode;
    hint?: string;
    isProcessing?: boolean;
}

/**
 * Status bar component for companion mode.
 * Shows current mode, help hints, and processing status.
 */
export const StatusBar: React.FC<StatusBarProps> = ({
    mode,
    hint,
    isProcessing = false,
}) => {
    const modeIcon = mode === 'watch' ? '👁' : '🤖';
    const modeLabel = mode === 'watch' ? 'Watch' : 'Auto';

    return (
        <Box
            flexDirection="row"
            justifyContent="space-between"
            paddingX={1}
            borderStyle="single"
            borderColor="gray"
        >
            <Box>
                <Text color="cyan">
                    [{modeLabel}] {modeIcon}
                </Text>
                {isProcessing && (
                    <Text color="yellow"> ⏳ Processing...</Text>
                )}
            </Box>

            <Box>
                <Text color="gray">?? for help</Text>
                {mode === 'watch' && (
                    <Text color="gray"> │ !auto to delegate</Text>
                )}
            </Box>

            {hint && (
                <Box>
                    <Text color="yellow">💡 {hint}</Text>
                </Box>
            )}
        </Box>
    );
};
