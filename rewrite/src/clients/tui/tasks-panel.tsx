/**
 * Port of legacy source/components/layout/BackgroundTasksPanel.tsx: the live task rows under the prompt, with
 * the `Tasks · N active · ^G manage` header. Only data access changed: rows come from the snapshot's tasks
 * (a foreground task is legacy's foreground transfer candidate, drawn with `↑`).
 */
import React, { useEffect, useRef, useState, type FC } from 'react';
import { Box, Text } from 'ink';
import type { TaskView, TuiState } from './state.js';
import { TaskManager, taskActivity, terminalTextWidth, truncateTerminalText } from './task-manager.js';
import type { TuiConnection } from './integration.js';
import { controlTask } from './commands.js';
import { useTerminalSize } from './terminal.js';
import { useTheme } from './presentation/components/theme.js';
import { useSkin } from './presentation/skins/SkinContext.js';

const NARROW_LABEL_LIMIT = 24;
const MEDIUM_LABEL_LIMIT = 36;
const WIDE_LABEL_LIMIT = 60;
const NAME_LIMIT = 24;
const MEDIUM_COLUMNS = 72;
const WIDE_COLUMNS = 104;
const MIN_IDENTITY_COLUMNS = 6;
/** Legacy background-task-clock.ts BACKGROUND_TASKS_PANEL_GRACE_MS. */
const GRACE_MS = 5_000;

const truncate = truncateTerminalText;

type PanelStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
type PanelTask = {
  readonly kind: 'shell' | 'subagent';
  readonly role: string;
  /** The shell command or the subagent's task text. */
  readonly text: string;
  readonly name?: string;
  readonly status: PanelStatus;
  readonly error?: string;
  readonly startedAt?: number;
  /** Legacy's control-task activity phase; a foreground transfer candidate has none (plain `Running`). */
  readonly phase?: string;
};
type Row = { readonly key: string; readonly placement: 'foreground' | 'background'; readonly task: PanelTask };

/** Legacy formatPhase's base word, from the snapshot status (no activity stream: a live task is `Active`). */
const backgroundPhase = (view: TaskView): string => {
  const activity = taskActivity(view, Date.now());
  // Provider is the common wait; only exceptional reasons (approval, answer) get the parenthetical.
  if (activity.phase === 'waiting')
    return activity.reason && activity.reason !== 'provider' ? `Waiting (${activity.reason})` : 'Waiting';
  return activity.phase === 'cancelling' ? 'Cancelling' : 'Active';
};

/** The data-access half of the port: legacy's live task row, from a snapshot task. */
function panelRow(view: TaskView): Row {
  const wire = view.wire;
  const kind = wire?.kind === 'shell' ? 'shell' : 'subagent';
  const settled = wire?.result?.kind ?? (view.status === 'completed' ? 'completed' : undefined);
  const status: PanelStatus =
    settled ??
    (view.status === 'failed' || view.status === 'cancelled' || view.status === 'interrupted'
      ? view.status
      : 'running');
  return {
    key: `${kind}:${view.id}`,
    placement: wire?.mode === 'background' ? 'background' : 'foreground',
    task: {
      kind,
      role: wire?.role ?? view.role ?? '',
      text: (kind === 'shell' ? wire?.label : wire?.input ?? wire?.label) ?? view.label,
      ...(wire?.name ? { name: wire.name } : {}),
      status,
      ...(wire?.result?.error?.message ? { error: wire.result.error.message } : {}),
      ...(wire?.startedAt !== undefined ? { startedAt: wire.startedAt } : {}),
      ...(wire?.mode === 'background' ? { phase: backgroundPhase(view) } : {}),
    },
  };
}

// Multi-line prompts are common for subagent tasks; only the first line is a label.
const firstLine = (value: string): string =>
  value
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? '';

const formatRole = (role: string): string => {
  if (!role) return 'Agent';
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
};

const formatTaskLabel = (task: PanelTask): string => {
  if (task.kind === 'shell') return firstLine(task.text).replaceAll(/\s+/g, ' ');
  const normalized = firstLine(task.text).replaceAll(/\s+/g, ' ');
  const label = normalized || `${formatRole(task.role)} background task`;
  return task.name ? `${truncate(task.name, NAME_LIMIT)} ${label}` : label;
};

/** Compact clock for space-constrained panel rows (`45s`, `1:05`). */
const formatClock = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
};

const formatTerminalStatus = (task: PanelTask): string => {
  switch (task.status) {
    case 'completed':
      return '✓ Done';
    case 'failed':
      return task.error ? `✗ Failed (${task.error})` : '✗ Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return '✗ Interrupted (budget)';
    default:
      return 'Running';
  }
};

const isTerminal = (task: PanelTask): boolean => task.status !== 'running';

const formatFirstLine = (
  task: PanelTask,
  placement: Row['placement'],
  columns: number,
  now: number,
): { badge: string; identity: string; phase: string } => {
  const isNarrow = columns < MEDIUM_COLUMNS;
  const isWide = columns >= WIDE_COLUMNS;
  const badge = `[${task.kind === 'shell' ? 'Shell' : formatRole(task.role)}${placement === 'foreground' ? ' ↑' : ''}]`;
  const rawPhase = isTerminal(task)
    ? formatTerminalStatus(task)
    : `${task.phase ?? 'Running'} · ${formatClock(now - (task.startedAt ?? now))}`;
  const fixedColumns = 2 + terminalTextWidth(badge) + 1 + 3;
  const phase = truncate(rawPhase, Math.max(1, columns - fixedColumns - MIN_IDENTITY_COLUMNS));
  // "• " + badge + " " + identity + " · " + phase. Reserve every mandatory cell except identity.
  const physicalBudget = Math.max(1, columns - fixedColumns - terminalTextWidth(phase));
  const classBudget = isNarrow ? NARROW_LABEL_LIMIT : isWide ? WIDE_LABEL_LIMIT : MEDIUM_LABEL_LIMIT;
  return { badge, identity: truncate(formatTaskLabel(task), Math.min(physicalBudget, classBudget)), phase };
};

type PanelProps = {
  readonly state: TuiState;
  readonly connection: TuiConnection;
  /** The session's ^G manager state; legacy BottomArea draws the manager straight under this panel. */
  readonly manager: readonly [boolean, (open: boolean) => void];
  /** The blank row before the composer; under an approval prompt the prompt's own bottom row stands in. */
  readonly gap: boolean;
};

export const TasksPanel: FC<PanelProps> = ({ state, connection, manager: [manage, setManage], gap }) => (
  <>
    <TaskRows state={state} gap={gap && !manage} />
    {manage ? (
      <>
        <TaskManager
          tasks={state.tasks}
          onClose={() => setManage(false)}
          onAction={(id, action) => controlTask(connection, id, action)}
        />
        {/* Legacy keeps its disabled input surface mounted: one empty row where the composer was. */}
        <Text> </Text>
      </>
    ) : null}
  </>
);

/** Legacy leaves a blank row between the panel and the composer; the open manager sits flush under it. */
const TaskRows: FC<{ readonly state: TuiState; readonly gap: boolean }> = ({ state, gap }) => {
  const theme = useTheme();
  const { TaskPanel, taskPanelGutter } = useSkin();
  const columns = useTerminalSize().columns - taskPanelGutter;
  // The ticker only re-renders; read the clock each render so a panel mounted long ago never sees a stale time.
  const [, setTick] = useState(0);
  const now = Date.now();
  // Legacy's foreground rows are live transfer candidates (always running): a settled foreground task leaves
  // at once; only background rows linger for the grace period.
  const rows = state.tasks.map(panelRow).filter((row) => row.placement === 'background' || !isTerminal(row.task));
  // Each settled row lingers briefly, long enough to read its outcome, then drops off on its own.
  const settledAt = useRef(new Map<string, number>()).current;
  const liveKeys = new Set(rows.map((row) => row.key));
  for (const key of settledAt.keys()) if (!liveKeys.has(key)) settledAt.delete(key);
  const visible = rows.filter((row) => {
    if (!isTerminal(row.task)) {
      settledAt.delete(row.key);
      return true;
    }
    const since = settledAt.get(row.key) ?? now;
    settledAt.set(row.key, since);
    return now - since < GRACE_MS;
  });
  useEffect(() => {
    if (!visible.length) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [visible.length]);
  if (visible.length === 0) return null;
  const activeCount = visible.filter((row) => !isTerminal(row.task)).length;
  return (
    <Box flexDirection="column" marginBottom={gap ? 1 : 0}>
      <TaskPanel header={`Tasks · ${activeCount} active · ^G manage`}>
        {visible.map(({ key, placement, task }) => {
          const row = formatFirstLine(task, placement, columns, now);
          return (
            <Box key={key} flexDirection="column">
              <Text>
                <Text color={theme.textSubtle}>• </Text>
                <Text color={theme.accentAlt}>{row.badge}</Text> <Text>{row.identity}</Text> · <Text>{row.phase}</Text>
              </Text>
            </Box>
          );
        })}
      </TaskPanel>
    </Box>
  );
};
