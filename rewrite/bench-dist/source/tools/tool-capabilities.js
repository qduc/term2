const DEFAULT_APPROVAL_PRESENTATION_CAPABILITY = {
    annotateCommandMessage: false,
    hidePendingDuringPrompt: true,
};
const TOOL_CAPABILITIES = {
    search_replace: {
        annotateCommandMessage: true,
        hidePendingDuringPrompt: true,
    },
};
export const getApprovalPresentationCapability = (toolName) => {
    if (!toolName) {
        return DEFAULT_APPROVAL_PRESENTATION_CAPABILITY;
    }
    return TOOL_CAPABILITIES[toolName] ?? DEFAULT_APPROVAL_PRESENTATION_CAPABILITY;
};
//# sourceMappingURL=tool-capabilities.js.map