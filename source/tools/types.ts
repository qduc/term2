import type { ZodObject } from 'zod';
import type { ApprovalPresentationCapability } from './tool-capabilities.js';

export interface CommandMessage {
  id: string;
  sender: 'command';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
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

export type FormatCommandMessage = (
  item: import('./format-helpers.js').ToolResultItem,
  index: number,
  toolCallArgumentsById: Map<string, unknown>,
) => CommandMessage[];

/** Application-owned policy invoked before a tool result returns to the SDK. */
export interface PostExecutePolicyContext<Params = unknown> {
  /** Parameters normalized against this tool's schema. */
  params: Params;
  /** The result returned by the original tool execution. */
  result: unknown;
  /** SDK execution details, including `toolCall.callId` when the runner supplies it. */
  details: unknown;
  /** Re-runs the original execution with the same params, context, and SDK details. */
  executeAgain: () => Promise<unknown>;
}

export type PostExecutePolicy<Params = unknown> = (
  context: PostExecutePolicyContext<Params>,
) => Promise<unknown> | unknown;

/** Opt-in descriptor for the session-owned post-execute approval seam. */
export interface PostExecutePauseDescriptor<Params = unknown> {
  describe(params: Params): { toolName: string; argumentsText: string };
}

/** Construction-time capability. Root tools only in this slice; nested tools do not inherit it. */
export interface PostExecutePauseCapability {
  forTool<Params>(definition: ToolDefinition<Params>): PostExecutePolicy<Params> | undefined;
}

export interface ToolDefinition<Params = any> {
  name: string;
  description: string;
  parameters: ZodObject<any, any>;
  argumentParsing?: 'repair' | 'strict';
  approvalPresentation?: ApprovalPresentationCapability;
  needsApproval: (params: Params, context?: unknown) => Promise<boolean> | boolean;
  execute: (params: Params, context?: unknown, details?: unknown) => Promise<any> | any;
  postExecute?: PostExecutePolicy<Params>;
  /** Selectively opt this root definition into session-owned post-execute approval. */
  postExecutePause?: PostExecutePauseDescriptor<Params>;
  /**
   * Formats tool execution results into command messages for display.
   * @param item - The raw tool execution item from the conversation
   * @param index - The index of this item in the items array
   * @param toolCallArgumentsById - Map of call IDs to their arguments for fallback lookup
   * @returns Array of CommandMessage objects to display to the user
   */
  formatCommandMessage: FormatCommandMessage;
}
