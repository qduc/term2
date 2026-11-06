/** Scoped subagent presentation and the id-keyed replace both use. */
import { formatToolCommand } from './json.js';
import type { WireEvent, WireSnapshot, WireTask } from './wire.js';

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
      if (child.payload.message.presentation?.withdrawn === true) break;
      task = { ...task, text: child.payload.message.text };
      break;
    case 'tool_progress':
      task = { ...task, progress: (task.progress ?? '') + child.payload.chunk };
      break;
    case 'tool_started': {
      // Legacy's registry counts each start by name; its panel shows the newest call's label.
      const { toolName, input } = child.payload.tool;
      const counts = task.toolCounts ?? [];
      const known = counts.some((entry) => entry.toolName === toolName);
      task = {
        ...task,
        lastToolName: toolName,
        lastTool: { label: formatToolCommand(toolName, input), state: 'running' },
        toolCounts: known
          ? counts.map((entry) => (entry.toolName === toolName ? { ...entry, count: entry.count + 1 } : entry))
          : [...counts, { toolName, count: 1 }],
      };
      break;
    }
    case 'tool_finished': {
      // The finished row is the call's command message; a call with none (an unknown tool) reads as done.
      const message = commandMessage(child.payload.display);
      const label = typeof message?.command === 'string' ? message.command : task.lastTool?.label ?? '';
      task = {
        ...task,
        progress: (task.progress ?? '') + child.payload.output,
        ...(label ? { lastTool: { label, state: failed(message, child.payload.isError) ? 'failed' : 'success' } } : {}),
      };
      break;
    }
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

/** A lifecycle change keeps a task's live tool tracking; a (re)start begins it afresh. */
export function withToolTracking(state: WireSnapshot, change: string, next: WireTask): WireTask {
  const previous = change === 'task_started' ? undefined : state.tasks.find((task) => task.id === next.id);
  const { lastTool, lastToolName, toolCounts } = previous ?? {};
  return {
    ...next,
    ...(lastTool ? { lastTool } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(toolCounts ? { toolCounts } : {}),
  };
}

/** As the tool row draws it: a message's own success, else the result's error flag; no message reads as done. */
function failed(message: Record<string, unknown> | undefined, isError: boolean): boolean {
  if (!message) return false;
  return typeof message['success'] === 'boolean' ? !message['success'] : isError;
}
function commandMessage(display: unknown): Record<string, unknown> | undefined {
  const record = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const messages = Array.isArray(display) ? display : record(display)?.['messages'];
  return Array.isArray(messages) ? record(messages[0]) : undefined;
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
