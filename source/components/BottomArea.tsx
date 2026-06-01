import React, { FC, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import ApprovalPrompt from './ApprovalPrompt.js';
import InputBox from './InputBox.js';
import StatusBar from './StatusBar.js';
import HandoffConfirmationPrompt from './HandoffConfirmationPrompt.js';
import LargeUncachedConfirmationPrompt from './LargeUncachedConfirmationPrompt.js';
import type { HandoffState } from '../app.js';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings-service.js';
import type { LoggingService } from '../services/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import type { SSHInfo } from '../hooks/use-shell-mode.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import type { CodexRateLimitInfo } from '../services/conversation-events.js';
import type { PendingApproval } from '../contracts/conversation.js';
import type { UserTurn } from '../types/user-turn.js';
import type { UndoItem } from '../hooks/use-undo-selection.js';

export type BottomAreaProps = {
  pendingApproval: PendingApproval | null;
  waitingForApproval: boolean;
  waitingForRejectionReason: boolean;
  isProcessing: boolean;
  isShellMode?: boolean;
  lastUsage?: NormalizedUsage | null;
  lastCodexRateLimit?: CodexRateLimitInfo | null;
  onSubmit: (value: UserTurn) => Promise<void>;
  slashCommands: SlashCommand[];
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  onApprove: () => void;
  onReject: () => void;
  sshInfo?: SSHInfo;
  undoMenuRef?: React.MutableRefObject<{ open: (items: UndoItem[]) => void } | null>;
  onUndoSelect?: (item: UndoItem) => void;
  onSettingChange?: (key: string, value: any) => void;
  onSystemMessage?: (text: string) => void;
  handoffState?: HandoffState | null;
  onHandoffConfirm?: () => void;
  onHandoffDecline?: () => void;
  onHandoffCancel?: () => void;
  largeUncachedWarning?: import('../services/large-uncached-input-guard.js').LargeUncachedInputDecision | null;
  pendingLargeUncachedTurn?: UserTurn | null;
  pendingLargeUncachedTokens?: number;
  onLargeUncachedApprove?: () => void;
  onLargeUncachedDecline?: () => void;
  onSlashTabComplete?: (command: SlashCommand) => boolean;
};

const BottomArea: FC<BottomAreaProps> = ({
  pendingApproval,
  waitingForApproval,
  waitingForRejectionReason,
  isProcessing,
  isShellMode = false,
  onSubmit,
  slashCommands,
  settingsService,
  loggingService,
  historyService,
  onApprove,
  onReject,
  sshInfo,
  lastUsage,
  lastCodexRateLimit,
  undoMenuRef,
  onUndoSelect,
  onSettingChange,
  onSystemMessage,
  handoffState,
  onHandoffConfirm,
  onHandoffDecline,
  onHandoffCancel,
  largeUncachedWarning,
  pendingLargeUncachedTurn,
  pendingLargeUncachedTokens = 0,
  onLargeUncachedApprove,
  onLargeUncachedDecline,
  onSlashTabComplete,
}) => {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    if (!isProcessing) {
      setDotCount(1);
      return;
    }

    const interval = setInterval(() => {
      setDotCount((prev) => (prev === 3 ? 1 : prev + 1));
    }, 800);

    return () => clearInterval(interval);
  }, [isProcessing]);

  const showHandoffConfirm = handoffState?.stage === 'confirm_model';
  const showLargeUncachedPrompt = Boolean(pendingLargeUncachedTurn);
  const showApprovalPrompt =
    !showHandoffConfirm &&
    !showLargeUncachedPrompt &&
    waitingForApproval &&
    !isProcessing &&
    !waitingForRejectionReason &&
    pendingApproval;
  const showInput =
    !showHandoffConfirm &&
    !showLargeUncachedPrompt &&
    ((!isProcessing && !waitingForApproval) || waitingForRejectionReason);

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" marginTop={1}>
        {showHandoffConfirm ? (
          <HandoffConfirmationPrompt
            onConfirm={onHandoffConfirm || (() => {})}
            onDecline={onHandoffDecline || (() => {})}
            onCancel={onHandoffCancel || (() => {})}
          />
        ) : showLargeUncachedPrompt ? (
          <LargeUncachedConfirmationPrompt
            usage={lastUsage}
            onConfirm={onLargeUncachedApprove || (() => {})}
            onDecline={onLargeUncachedDecline || (() => {})}
          />
        ) : showApprovalPrompt ? (
          <ApprovalPrompt approval={pendingApproval} onApprove={onApprove} onReject={onReject} />
        ) : isProcessing ? (
          <Text color="#64748b">processing{'.'.repeat(dotCount)}</Text>
        ) : showInput ? (
          <InputBox
            onSubmit={onSubmit}
            slashCommands={slashCommands}
            waitingForRejectionReason={waitingForRejectionReason}
            isShellMode={isShellMode}
            settingsService={settingsService}
            loggingService={loggingService}
            historyService={historyService}
            undoMenuRef={undoMenuRef}
            onUndoSelect={onUndoSelect}
            onSettingChange={onSettingChange}
            onSystemMessage={onSystemMessage}
            onSlashTabComplete={onSlashTabComplete}
            promptLabel={
              handoffState?.stage === 'entering_message'
                ? 'Handoff message (enter to use default message): '
                : undefined
            }
            allowEmptySubmit={handoffState?.stage === 'entering_message'}
          />
        ) : null}
      </Box>

      <StatusBar
        settingsService={settingsService}
        isShellMode={isShellMode}
        sshInfo={sshInfo}
        lastUsage={lastUsage}
        lastCodexRateLimit={lastCodexRateLimit}
        largeUncachedWarning={largeUncachedWarning}
        hasPendingConfirmation={pendingLargeUncachedTurn !== null && pendingLargeUncachedTokens > 0}
        pendingLargeUncachedTokens={pendingLargeUncachedTokens}
      />
    </Box>
  );
};

export default BottomArea;
