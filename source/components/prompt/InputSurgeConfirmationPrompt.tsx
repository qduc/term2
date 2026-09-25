import React, { FC } from 'react';
import ConfirmPrompt from './ConfirmPrompt.js';

export interface InputSurgeConfirmationPromptProps {
  reason: string;
  onConfirm: () => void;
  onDecline: () => void;
}

const InputSurgeConfirmationPrompt: FC<InputSurgeConfirmationPromptProps> = ({ reason, onConfirm, onDecline }) => (
  <ConfirmPrompt
    warning={`Input Surge Warning: ${reason}`}
    question="Send request anyway?"
    confirmLabel="Send anyway"
    declineLabel="Cancel"
    onConfirm={onConfirm}
    onDecline={onDecline}
    onCancel={onDecline}
  />
);

export default InputSurgeConfirmationPrompt;
