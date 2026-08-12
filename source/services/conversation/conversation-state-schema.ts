import { z } from 'zod';

/**
 * Known tool-execution statuses. Logs written before `unknown` existed still
 * parse: the enum only adds a new value. Unknown future statuses fall through
 * via `.passthrough()` on the object and a soft status coerce below.
 */
const ToolExecutionStatusSchema = z.enum(['started', 'completed', 'failed', 'approval_required', 'aborted', 'unknown']);

/** Accept legacy statuses; map unrecognized strings to `aborted` rather than failing import. */
const MigratingToolExecutionStatusSchema = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  if (
    value === 'started' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'approval_required' ||
    value === 'aborted' ||
    value === 'unknown'
  ) {
    return value;
  }
  // Pre-unknown logs never wrote other values; treat exotic future/corrupt values as aborted.
  return 'aborted';
}, ToolExecutionStatusSchema);

export const SavedToolExecutionSchema = z
  .object({
    turnId: z.string(),
    callId: z.string(),
    toolName: z.string(),
    arguments: z.unknown().optional(),
    status: MigratingToolExecutionStatusSchema,
    output: z.unknown().optional(),
    failureReason: z.string().optional(),
    startedAt: z.string(),
    dispatchedAt: z.string().optional(),
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
