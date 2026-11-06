import React, { FC } from 'react';
import ConfirmPrompt from './ConfirmPrompt.js';

interface HandoffConfirmationPromptProps {
  onConfirm: () => void;
  onDecline: () => void;
  onCancel: () => void;
}

const HandoffConfirmationPrompt: FC<HandoffConfirmationPromptProps> = (props) => (
  <ConfirmPrompt question="Change model?" {...props} />
);

export default HandoffConfirmationPrompt;
