/** Pinned task lifecycle and parent identity from accepted task evidence only. */
import type { WireEvent, WireTaskOwner } from '../protocol/wire.js';
import { missing, text, type CanonicalEventCandidate, type CanonicalEventContext } from './server-event-values.js';

/** Use the accepted change kind, never a running snapshot, as lifecycle evidence. Numeric task
 * time is not an envelope timestamp: encodeCanonicalEvent keeps the original FactLine occurredAt.
 */
export function taskCandidate(
  event: Extract<WireEvent, { type: 'task_changed' }>,
  context: CanonicalEventContext,
): CanonicalEventCandidate | null {
  const { change, task } = event.payload;
  if (task.kind === 'shell') return null;
  if (task.kind !== 'subagent') return missing('canonical task lifecycle requires its accepted task kind');
  switch (change) {
    case 'task_question_opened':
    case 'task_question_closed':
      // Native orchestrator pauses are not user interactions or terminal lifecycle events.
      return null;
    case 'task_backgrounded':
    case 'task_stop_requested':
      // The frozen vocabulary has no equivalent. Neither change means started or physically done.
      return null;
    case 'task_started':
      // The current wire has no original input field. Never substitute a label or result text.
      return missing('canonical task start requires its accepted original input projection');
    case 'task_finished': {
      const identity = taskIdentity(task.id, context, undefined, task);
      const result = task.result;
      if (!result) return missing('canonical task settlement requires its accepted result');
      if (result.kind === 'interrupted') {
        if (result.output === undefined) return missing('canonical task interruption requires actual final output');
        return {
          type: 'subagent_interrupted',
          payload: { ...identity, finalText: text(result.output, 16_384) },
        };
      }
      // Distinct tool names are not pinned per-tool counts, and missing output is not blank success.
      return missing('canonical task completion requires actual final output and accepted tool-use counts');
    }
  }
}
/** Accept only the task's original parent identity. A nested branch's outer turnId is its child,
 * and a task interaction closure's outer turnId is already its parent; neither can be copied blindly.
 */
export function taskIdentity(taskId: string, context: CanonicalEventContext, role?: string, owner?: WireTaskOwner) {
  const task = owner ?? context.task;
  if (!task || task.id !== taskId || !task.turnId)
    return missing('canonical nested events require their accepted parent task identity');
  const acceptedRole = role ?? task.role;
  if (!acceptedRole) return missing('canonical nested events require their accepted role');
  return { turnId: task.turnId, agentId: text(task.id, 256), role: text(acceptedRole, 256) };
}
