import React, {FC, useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import ApprovalPrompt from './ApprovalPrompt.js';
import InputBox from './InputBox.js';
import StatusBar from './StatusBar.js';
import type {SlashCommand} from './SlashCommandMenu.js';
import type {SettingsService} from '../services/settings-service.js';
import type {LoggingService} from '../services/logging-service.js';

export type PendingApproval = {
    agentName: string;
    toolName: string;
    argumentsText: string;
    rawInterruption: any;
    callId?: string;
    isMaxTurnsPrompt?: boolean;
};

export type BottomAreaProps = {
    pendingApproval: PendingApproval | null;
    waitingForApproval: boolean;
    waitingForRejectionReason: boolean;
    isProcessing: boolean;
    onSubmit: (value: string) => Promise<void>;
    slashCommands: SlashCommand[];
    onHistoryUp: () => void;
    onHistoryDown: () => void;
    hasConversationHistory: boolean;
    settingsService: SettingsService;
    loggingService: LoggingService;
    onApprove: () => void;
    onReject: () => void;
};

const BottomArea: FC<BottomAreaProps> = ({
    pendingApproval,
    waitingForApproval,
    waitingForRejectionReason,
    isProcessing,
    onSubmit,
    slashCommands,
    onHistoryUp,
    onHistoryDown,
    hasConversationHistory,
    settingsService,
    loggingService,
    onApprove,
    onReject,
}) => {
    const [dotCount, setDotCount] = useState(1);

    useEffect(() => {
        if (!isProcessing) {
            setDotCount(1);
            return;
        }

        const interval = setInterval(() => {
            setDotCount(prev => (prev === 3 ? 1 : prev + 1));
        }, 500);

        return () => clearInterval(interval);
    }, [isProcessing]);

    const showApprovalPrompt =
        waitingForApproval &&
        !isProcessing &&
        !waitingForRejectionReason &&
        pendingApproval;
    const showInput =
        (!isProcessing && !waitingForApproval) || waitingForRejectionReason;

    return (
        <Box flexDirection="column">
            {showApprovalPrompt ? (
                <ApprovalPrompt
                    approval={pendingApproval}
                    onApprove={onApprove}
                    onReject={onReject}
                />
            ) : showInput ? (
                <InputBox
                    onSubmit={onSubmit}
                    slashCommands={slashCommands}
                    onHistoryUp={onHistoryUp}
                    onHistoryDown={onHistoryDown}
                    hasConversationHistory={hasConversationHistory}
                    waitingForRejectionReason={waitingForRejectionReason}
                    settingsService={settingsService}
                    loggingService={loggingService}
                />
            ) : null}

            {isProcessing && (
                <Text color="gray" dimColor>
                    processing{'.'.repeat(dotCount)}
                </Text>
            )}

            <StatusBar settingsService={settingsService} />
        </Box>
    );
};

export default BottomArea;
