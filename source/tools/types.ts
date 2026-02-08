import type { ZodObject } from 'zod';

export interface CommandMessage {
  id: string;
  sender: 'command';
  status: 'pending' | 'running' | 'completed' | 'failed';
  command: string;
  output: string;
  success?: boolean;
  failureReason?: string;
  isApprovalRejection?: boolean;
  toolName?: string;
  toolArgs?: any;
  callId?: string;
}

export interface ToolDefinition<Params = any> {
  name: string;
  description: string;
  parameters: ZodObject<any, any>;
  needsApproval: (params: Params, context?: unknown) => Promise<boolean> | boolean;
  execute: (params: Params, context?: unknown) => Promise<any> | any;
  /**
   * Formats tool execution results into command messages for display.
   * @param item - The raw tool execution item from the conversation
   * @param index - The index of this item in the items array
   * @param toolCallArgumentsById - Map of call IDs to their arguments for fallback lookup
   * @returns Array of CommandMessage objects to display to the user
   */
  formatCommandMessage: (item: any, index: number, toolCallArgumentsById: Map<string, unknown>) => CommandMessage[];
}
