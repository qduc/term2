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
  runId: string | (() => string | null);
  describe: (params: Params) => { toolName: string; argumentsText: string };
}): PostExecutePolicy<Params> {
  return async ({ params, result, details, executeAgain }) => {
    const runId = typeof options.runId === 'function' ? options.runId() : options.runId;
    // A policy accidentally invoked outside an owned foreground run must not
    // manufacture an unresumable gate.
    if (!runId) return result;
    const toolCallId = getCallIdFromObject(asRecord(details)?.toolCall);
    if (!toolCallId) {
      throw new Error('Post-execute approval requires an SDK tool call ID');
    }
    const descriptor = options.describe(params);
    const decision = await options.pending.register({
      runId,
      toolCallId,
      toolName: descriptor.toolName,
      argumentsText: descriptor.argumentsText,
    });
    return decision === 'approve' ? executeAgain() : result;
  };
}
