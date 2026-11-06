export interface ApprovalPresentationCapability {
  annotateCommandMessage: boolean;
  hidePendingDuringPrompt: boolean;
}

const DEFAULT_APPROVAL_PRESENTATION_CAPABILITY: ApprovalPresentationCapability = {
  annotateCommandMessage: false,
  hidePendingDuringPrompt: true,
};

const TOOL_CAPABILITIES: Record<string, ApprovalPresentationCapability> = {
  search_replace: {
    annotateCommandMessage: true,
    hidePendingDuringPrompt: true,
  },
};

export const getApprovalPresentationCapability = (toolName?: string): ApprovalPresentationCapability => {
  if (!toolName) {
    return DEFAULT_APPROVAL_PRESENTATION_CAPABILITY;
  }

  return TOOL_CAPABILITIES[toolName] ?? DEFAULT_APPROVAL_PRESENTATION_CAPABILITY;
};
