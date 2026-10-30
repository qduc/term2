import React from 'react';
import ConfirmPrompt from './ConfirmPrompt.js';
const InputSurgeConfirmationPrompt = ({ reason, onConfirm, onDecline }) => (React.createElement(ConfirmPrompt, { warning: `Input Surge Warning: ${reason}`, question: "Send request anyway?", confirmLabel: "Send anyway", declineLabel: "Cancel", onConfirm: onConfirm, onDecline: onDecline, onCancel: onDecline }));
export default InputSurgeConfirmationPrompt;
//# sourceMappingURL=InputSurgeConfirmationPrompt.js.map