/**
 * Legacy's settled background rows (conversation-orchestrator appendBackgroundNotifications): when queued
 * completion notices are handed to the model, one `background_subagent_notification` row (and one
 * `background_shell_notification` row) goes above the reply they start. Next delivers those notices as a
 * silent turn, so the rows are drawn from the delivery and the snapshot's tasks, placed before that turn.
 */
import type { JsonValue, WireSnapshot, WireTask } from '../../protocol/wire.js';
import type { ToolView } from './state.js';

type Timeline = NonNullable<WireSnapshot['timeline']>;

/** Same row, same object: memoised transcript consumers compare tool rows by identity. */
const rows = new Map<string, { readonly key: string; readonly view: ToolView }>();
const notificationRow = (turnId: string, toolName: string, args: Record<string, JsonValue>): ToolView => {
  const id = `notice:${turnId}:${toolName}`;
  const key = JSON.stringify(args);
  const known = rows.get(id);
  if (known?.key === key) return known.view;
  const view: ToolView = {
    turnId,
    id,
    name: toolName,
    status: 'completed',
    input: args,
    display: [{ command: toolName, output: '', success: true, toolName, toolArgs: args }],
  };
  rows.set(id, { key, view });
  return view;
};

const failure = (task: WireTask): Record<string, string> =>
  task.result?.error?.message ? { error: task.result.error.message } : {};

/** The delivered turns' notification rows, and the timeline with each placed before its turn. */
export function noticeRows(
  snapshot: WireSnapshot,
  timeline: WireSnapshot['timeline'],
): { readonly tools: readonly ToolView[]; readonly timeline: WireSnapshot['timeline'] } {
  const deliveries = snapshot.notifications?.deliveries ?? [];
  if (!deliveries.length) return { tools: [], timeline };
  const turnOf = new Map<string, string | undefined>([
    ...snapshot.messages.map((message) => [`message:${message.id}`, message.turnId] as const),
    ...snapshot.tools.map((tool) => [`tool:${tool.executionId}`, tool.turnId] as const),
  ]);
  const tools: ToolView[] = [];
  let entries: Timeline = timeline ?? [];
  for (const delivery of deliveries) {
    const ids = new Set(delivery.notificationIds);
    const finished = (snapshot.notifications?.notices ?? [])
      .filter((notice) => ids.has(notice.id) && notice.kind === 'completion')
      .flatMap((notice) => notice.taskIds)
      .map((id) => snapshot.tasks.find((task) => task.id === id))
      .filter((task): task is WireTask => Boolean(task?.result));
    const runs = finished
      .filter((task) => task.kind !== 'shell')
      .map(
        (task): Record<string, JsonValue> => ({
          ...(task.name ? { name: task.name } : {}),
          role: task.role ?? 'agent',
          status: task.result!.kind,
          ...failure(task),
        }),
      );
    const jobs = finished
      .filter((task) => task.kind === 'shell')
      .map(
        (task): Record<string, JsonValue> => ({
          jobId: task.id,
          command: task.label ?? '',
          status: task.result!.kind,
          ...failure(task),
        }),
      );
    const placedRows = [
      ...(runs.length ? [notificationRow(delivery.turnId, 'background_subagent_notification', { runs })] : []),
      ...(jobs.length ? [notificationRow(delivery.turnId, 'background_shell_notification', { jobs })] : []),
    ];
    if (!placedRows.length) continue;
    tools.push(...placedRows);
    if (!timeline) continue;
    const at = entries.findIndex((entry) => turnOf.get(`${entry.kind}:${entry.id}`) === delivery.turnId);
    const placed = placedRows.map((row) => ({ kind: 'tool' as const, id: row.id }));
    entries = at < 0 ? [...entries, ...placed] : [...entries.slice(0, at), ...placed, ...entries.slice(at)];
  }
  return { tools, timeline: timeline ? entries : timeline };
}
