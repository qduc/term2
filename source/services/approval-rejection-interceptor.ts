import { markToolCallAsApprovalRejection } from '../utils/extract-command-messages.js';

type ToolInterceptor = (name: string, params: unknown, toolCallId?: string) => Promise<string | null>;

type InterceptorCapableClient = {
  addToolInterceptor: (interceptor: ToolInterceptor) => () => void;
};

type MaybeInterceptorCapableClient = {
  addToolInterceptor?: (interceptor: ToolInterceptor) => () => void;
};

type ApprovalRejectionInterceptorInput = {
  toolName: string;
  expectedCallId?: string;
  rejectionMessage: string;
};

const createInterceptor = ({ toolName, expectedCallId, rejectionMessage }: ApprovalRejectionInterceptorInput) => {
  return async (name: string, _params: unknown, toolCallId?: string): Promise<string | null> => {
    if (name === toolName && (!expectedCallId || toolCallId === expectedCallId)) {
      markToolCallAsApprovalRejection(toolCallId ?? expectedCallId);
      return rejectionMessage;
    }

    return null;
  };
};

export const installApprovalRejectionInterceptor = (
  agentClient: InterceptorCapableClient,
  input: ApprovalRejectionInterceptorInput,
): (() => void) => {
  return agentClient.addToolInterceptor(createInterceptor(input));
};

export const tryInstallApprovalRejectionInterceptor = (
  agentClient: MaybeInterceptorCapableClient,
  input: ApprovalRejectionInterceptorInput,
): (() => void) | null => {
  if (typeof agentClient.addToolInterceptor !== 'function') {
    return null;
  }

  return agentClient.addToolInterceptor(createInterceptor(input));
};
