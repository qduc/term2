import React from 'react';
import ConfirmPrompt from './ConfirmPrompt.js';
const ModeSwitchConfirmationPrompt = ({ modeLabel, targetValue = true, onConfirm, onDecline, onCancel = onDecline, }) => {
    const actionText = targetValue ? `switch to ${modeLabel} mode` : `disable ${modeLabel} mode`;
    return (React.createElement(ConfirmPrompt, { warning: `${targetValue ? `Switching to ${modeLabel} mode` : `Disabling ${modeLabel} mode`} requires clearing the current session.`, question: `Clear session and ${actionText}?`, 
        // Default to 'No' so pressing Enter doesn't accidentally clear the session.
        defaultIndex: 1, onConfirm: onConfirm, onDecline: onDecline, onCancel: onCancel }));
};
export default ModeSwitchConfirmationPrompt;
//# sourceMappingURL=ModeSwitchConfirmationPrompt.js.map