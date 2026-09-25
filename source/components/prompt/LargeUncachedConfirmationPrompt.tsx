import React, { FC } from 'react';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import ConfirmPrompt from './ConfirmPrompt.js';

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
