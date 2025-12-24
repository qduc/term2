import React, {FC} from 'react';
import {Box, Text} from 'ink';
import ApprovalPrompt from './ApprovalPrompt.js';
import InputBox from './InputBox.js';
import StatusBar from './StatusBar.js';
import type {SlashCommand} from './SlashCommandMenu.js';
import type {SettingsService} from '../services/settings-service.js';
import type {LoggingService} from '../services/logging-service.js';

type PendingApproval = {
    agentName: string;
    toolName: string;
    argumentsText: string;
    rawInterruption: any;
    isMaxTurnsPrompt?: boolean;
};

type Props = {
    pendingApproval: PendingApproval | null;
    waitingForApproval: boolean;
    waitingForRejectionReason: boolean;
    isProcessing: boolean;
    dotCount: number;
    onSubmit: (value: string) => Promise<void>;
    slashCommands: SlashCommand[];
    onHistoryUp: () => void;
    onHistoryDown: () => void;
    hasConversationHistory: boolean;
    settingsService: SettingsService;
    loggingService: LoggingService;
};

const BottomArea: FC<Props> = ({
    pendingApproval,
    waitingForApproval,
    waitingForRejectionReason,
    isProcessing,
    dotCount,
    onSubmit,
    slashCommands,
    onHistoryUp,
    onHistoryDown,
    hasConversationHistory,
    settingsService,
    loggingService,
}) => {
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
                <ApprovalPrompt approval={pendingApproval} />
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
