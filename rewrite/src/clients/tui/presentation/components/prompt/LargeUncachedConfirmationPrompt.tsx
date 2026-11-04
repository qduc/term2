import React, { FC } from 'react';
import ConfirmPrompt from './ConfirmPrompt.js';

/** Legacy NormalizedUsage's fields this prompt reads (the last request's usage). */
type NormalizedUsage = { readonly prompt_tokens?: number; readonly cache_read_tokens?: number };

interface LargeUncachedConfirmationPromptProps {
  usage: NormalizedUsage | null | undefined;
  onConfirm: () => void;
  onDecline: () => void;
}

const LargeUncachedConfirmationPrompt: FC<LargeUncachedConfirmationPromptProps> = ({ usage, onConfirm, onDecline }) => {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_tokens;
  return (
    <ConfirmPrompt
      warning={
        cacheReadTokens != null
          ? `Large request — ${cacheReadTokens.toLocaleString()} uncached`
          : 'Large request — may miss prompt cache'
      }
      question={`Send ${promptTokens.toLocaleString()} tokens anyway?`}
      confirmLabel="Send"
      declineLabel="Cancel"
      onConfirm={onConfirm}
      onDecline={onDecline}
      onCancel={onDecline}
    />
  );
};

export default LargeUncachedConfirmationPrompt;
