import React from 'react';
import ConfirmPrompt from './ConfirmPrompt.js';
const LargeUncachedConfirmationPrompt = ({ usage, onConfirm, onDecline }) => {
    const promptTokens = usage?.prompt_tokens ?? 0;
    const cacheReadTokens = usage?.cache_read_tokens;
    return (React.createElement(ConfirmPrompt, { warning: cacheReadTokens != null
            ? `Large request — ${cacheReadTokens.toLocaleString()} uncached`
            : 'Large request — may miss prompt cache', question: `Send ${promptTokens.toLocaleString()} tokens anyway?`, confirmLabel: "Send", declineLabel: "Cancel", onConfirm: onConfirm, onDecline: onDecline, onCancel: onDecline }));
};
export default LargeUncachedConfirmationPrompt;
//# sourceMappingURL=LargeUncachedConfirmationPrompt.js.map