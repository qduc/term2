import { asRecord, getCallIdFromObject } from '../interruption-info.js';
import type { PostExecutePolicy } from '../../tools/types.js';
import type { PostExecutePendingRegistry } from './post-execute-pending-registry.js';

/**
 * Turns the application-owned tool seam into a fail-closed gate. It intentionally
 * does not know about SDK streams: holding this promise leaves the already-live
 * SDK execution waiting at the tool boundary; an approval re-executes exactly
 * once through the supplied non-recursive callback.
 */
export function createPostExecutePausePolicy<Params>(options: {
  pending: PostExecutePendingRegistry;
  /** A live run is created after tools are assembled, so production wiring may resolve lazily. */
  runId: string | null | (() => string | null);
  describe: (
    params: Params,
    result: unknown,
    details: unknown,
  ) => {
    toolName: string;
    argumentsText: string;
    deniedRead?: import('../../contracts/conversation.js').DeniedReadMetadata;
  } | null;
  resolve?: (
    context: Parameters<PostExecutePolicy<Params>>[0],
    decision: import('../../contracts/conversation.js').PostExecuteDecision,
  ) => Promise<unknown> | unknown;
}): PostExecutePolicy<Params> {
  return async (context) => {
    const { params, result, details, executeAgain } = context;
    const runId = typeof options.runId === 'function' ? options.runId() : options.runId;
    const descriptor = options.describe(params, result, details);
    if (!descriptor) return result;
    // A policy accidentally invoked outside an owned foreground run must not
    // manufacture an unresumable gate. Let a custom resolver discard any
    // call-scoped state using the same fail-closed rejection path as disposal.
    if (!runId) return options.resolve ? options.resolve(context, 'reject') : result;
    const toolCallId = getCallIdFromObject(asRecord(details)?.toolCall);
    if (!toolCallId) {
      throw new Error('Post-execute approval requires an SDK tool call ID');
    }
    const decision = await options.pending.register({
      runId,
      toolCallId,
      toolName: descriptor.toolName,
      argumentsText: descriptor.argumentsText,
      deniedRead: descriptor.deniedRead,
    });
    return options.resolve ? options.resolve(context, decision) : decision === 'approve' ? executeAgain() : result;
  };
}
