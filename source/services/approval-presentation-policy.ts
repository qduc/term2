import type { ApprovalDescriptor } from '../contracts/conversation.js';
import { getApprovalPresentationCapability, type ApprovalPresentationCapability } from '../tools/tool-capabilities.js';
import type { CommandMessage } from '../tools/types.js';

export type ApprovedCommandMessage = CommandMessage & {
  hadApproval?: boolean;
};

export interface ApprovedToolContext {
  callId?: string;
  toolName?: string;
}

type CapabilityResolver = (toolName?: string) => ApprovalPresentationCapability;

const defaultCapabilityResolver: CapabilityResolver = (toolName) => getApprovalPresentationCapability(toolName);

export const filterPendingCommandMessagesForApproval = <TMessage extends { sender?: string }>(
  messages: TMessage[],
  approval: Pick<ApprovalDescriptor, 'callId' | 'toolName'> | null | undefined,
  getCapability: CapabilityResolver = defaultCapabilityResolver,
): TMessage[] => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages ?? [];
  }

  const callId = approval?.callId ? String(approval.callId) : undefined;
  const toolName = approval?.toolName;

  if (!callId && !toolName) {
    return messages;
  }

  return messages.filter((msg) => {
    const commandMsg = msg as unknown as CommandMessage;
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

export const annotateApprovedCommandMessage = (
  commandMessage: ApprovedCommandMessage,
  approvedContext: ApprovedToolContext | null,
  getCapability: CapabilityResolver = defaultCapabilityResolver,
): ApprovedCommandMessage => {
  if (!approvedContext) {
    return commandMessage;
  }

  const capability = getCapability(commandMessage.toolName);
  if (!capability.annotateCommandMessage) {
    return commandMessage;
  }

  const matchesCallId =
    approvedContext.callId && commandMessage.callId && approvedContext.callId === commandMessage.callId;
  const matchesToolName =
    !approvedContext.callId && approvedContext.toolName && approvedContext.toolName === commandMessage.toolName;

  if (!matchesCallId && !matchesToolName) {
    return commandMessage;
  }

  return { ...commandMessage, hadApproval: true };
};
