/** Scoped subagent presentation and the id-keyed replace both use. */
import type { WireEvent, WireSnapshot } from './direct-wire.js';

type Identified = { readonly id: string };
export function replace<T extends Identified>(items: readonly T[], next: T): readonly T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
}
/** A nested public event stays scoped to its agent; never fold it into root usage,
 * messages, terminal, or pending authority. M4's concrete path uses task_* events.
 * Only a nested error becomes a transcript notice: every other event (deltas, usage,
 * tool and turn markers) updates the agent's task, whose row and completion already
 * report progress, rather than adding one line per event to the conversation.
 */
export function nestedPresentation(state: WireSnapshot, event: Extract<WireEvent, { type: 'subagent' }>): WireSnapshot {
  const { agentId, role, event: child } = event.payload;
  const previous = state.tasks.find((task) => task.id === agentId);
  let task: WireSnapshot['tasks'][number] = previous ?? { id: agentId, agentId, role, status: 'running' };
  switch (child.type) {
    case 'text_delta':
      task = { ...task, text: (task.text ?? '') + child.payload.delta };
      break;
    case 'message':
      task = { ...task, text: child.payload.message.text };
      break;
    case 'tool_progress':
      task = { ...task, progress: (task.progress ?? '') + child.payload.chunk };
      break;
    case 'tool_finished':
      task = { ...task, progress: (task.progress ?? '') + child.payload.output };
      break;
  }
  return {
    ...state,
    tasks: replace(state.tasks, task),
    ...(child.type === 'error'
      ? {
          notices: [
            ...state.notices,
            { kind: 'subagent', message: `${role ?? 'Subagent'} (${agentId}): ${child.payload.error.message}` },
          ],
        }
      : {}),
  };
}

/** What the user reads for a provider-history edit; the reason names the operation that caused it. */
export function historyReplacedMessage(reason: string): string {
  switch (reason) {
    case 'compaction':
      return 'Conversation compacted: earlier messages were replaced by a summary.';
    case 'rewind':
      return 'Conversation rewound to the chosen point.';
    case 'retry_turn':
    case 'retry_tool':
      return 'Conversation history restored to retry.';
    default:
      return `Conversation history replaced (${reason}).`;
  }
}
