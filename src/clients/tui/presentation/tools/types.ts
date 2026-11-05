/** Legacy's command message: the shape the ported tool-row renderers consume. */
export interface CommandMessage {
  id: string;
  sender: 'command';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown';
  command: string;
  output: string;
  success?: boolean;
  failureReason?: string;
  isApprovalRejection?: boolean;
  autoApprovedByLlm?: boolean;
  toolName?: string;
  toolArgs?: unknown;
  callId?: string;
}
