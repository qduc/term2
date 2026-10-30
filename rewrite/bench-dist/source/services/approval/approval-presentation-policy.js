import { getApprovalPresentationCapability, } from '../../tools/tool-capabilities.js';
const defaultCapabilityResolver = (toolName) => getApprovalPresentationCapability(toolName);
export const filterPendingCommandMessagesForApproval = (messages, approval, getCapability = defaultCapabilityResolver) => {
    if (!Array.isArray(messages) || messages.length === 0) {
        return messages ?? [];
    }
    const callId = approval?.callId ? String(approval.callId) : undefined;
    const toolName = approval?.toolName;
    if (!callId && !toolName) {
        return messages;
    }
    return messages.filter((msg) => {
        const commandMsg = msg;
        if (!commandMsg || commandMsg.sender !== 'command') {
            return true;
        }
        if (commandMsg.status !== 'pending' && commandMsg.status !== 'running') {
            return true;
        }
        const capability = getCapability(commandMsg.toolName);
        if (!capability.hidePendingDuringPrompt) {
            return true;
        }
        const matchesCallId = callId && commandMsg.callId && String(commandMsg.callId) === callId;
        const matchesToolName = !callId && toolName && commandMsg.toolName === toolName;
        return !(matchesCallId || matchesToolName);
    });
};
export const annotateApprovedCommandMessage = (commandMessage, approvedContext, getCapability = defaultCapabilityResolver) => {
    if (!approvedContext) {
        return commandMessage;
    }
    const capability = getCapability(commandMessage.toolName);
    if (!capability.annotateCommandMessage) {
        return commandMessage;
    }
    const matchesCallId = approvedContext.callId && commandMessage.callId && approvedContext.callId === commandMessage.callId;
    const matchesToolName = !approvedContext.callId && approvedContext.toolName && approvedContext.toolName === commandMessage.toolName;
    if (!matchesCallId && !matchesToolName) {
        return commandMessage;
    }
    return { ...commandMessage, hadApproval: true };
};
//# sourceMappingURL=approval-presentation-policy.js.map