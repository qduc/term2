import React, { FC } from 'react';
import ConfirmPrompt from './ConfirmPrompt.js';

export interface ModeSwitchConfirmationPromptProps {
  modeLabel: string;
  targetValue?: boolean;
  onConfirm: () => void;
  onDecline: () => void;
  onCancel?: () => void;
}

const ModeSwitchConfirmationPrompt: FC<ModeSwitchConfirmationPromptProps> = ({
  modeLabel,
  targetValue = true,
  onConfirm,
  onDecline,
  onCancel = onDecline,
}) => {
  const actionText = targetValue ? `switch to ${modeLabel} mode` : `disable ${modeLabel} mode`;
  return (
    <ConfirmPrompt
      warning={`${
        targetValue ? `Switching to ${modeLabel} mode` : `Disabling ${modeLabel} mode`
      } requires clearing the current session.`}
      question={`Clear session and ${actionText}?`}
      // Default to 'No' so pressing Enter doesn't accidentally clear the session.
      defaultIndex={1}
      onConfirm={onConfirm}
      onDecline={onDecline}
      onCancel={onCancel}
    />
  );
};

export default ModeSwitchConfirmationPrompt;
