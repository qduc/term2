import React, { FC } from 'react';
import ConfirmPrompt from './ConfirmPrompt.js';

interface StandardModeConfirmationPromptProps {
  onConfirm: () => void;
  onDecline: () => void;
  onCancel: () => void;
}

const StandardModeConfirmationPrompt: FC<StandardModeConfirmationPromptProps> = (props) => (
  <ConfirmPrompt question="Switch to Bare mode?" {...props} />
);

export default StandardModeConfirmationPrompt;
