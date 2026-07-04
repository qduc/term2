import { z } from 'zod';

const ToolExecutionStatusSchema = z.enum(['started', 'completed', 'failed', 'approval_required', 'aborted']);

export const SavedToolExecutionSchema = z
  .object({
    turnId: z.string(),
    callId: z.string(),
    toolName: z.string(),
    arguments: z.unknown().optional(),
    status: ToolExecutionStatusSchema,
    output: z.unknown().optional(),
    failureReason: z.string().optional(),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    historyItems: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const ImportedConversationStateSchema = z
  .object({
    history: z.array(z.unknown()),
    previousResponseId: z.string().nullable(),
    toolLedger: z.array(SavedToolExecutionSchema).optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export type ImportedConversationState = z.infer<typeof ImportedConversationStateSchema>;
