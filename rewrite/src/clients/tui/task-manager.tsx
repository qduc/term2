import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TaskView } from './state.js';
import { useTerminalSize } from './terminal.js';

/** Conservative terminal-cell width used before Ink performs physical layout. */
export const terminalTextWidth = (value: string): number =>
  Array.from(value).reduce((columns, point) => columns + (point.codePointAt(0)! > 0x7f ? 2 : 1), 0);

export const truncateTerminalText = (value: string, maxColumns: number): string => {
  if (terminalTextWidth(value) <= maxColumns) return value;
  const ellipsis = '…';
  const ellipsisWidth = terminalTextWidth(ellipsis);
  if (maxColumns <= ellipsisWidth) return ellipsis;
  let rendered = '';
  for (const point of value) {
    if (terminalTextWidth(rendered) + terminalTextWidth(point) + ellipsisWidth > maxColumns) break;
    rendered += point;
  }
  return `${rendered}${ellipsis}`;
};

/** Inspect a wire task and send only explicitly selected task-ID-scoped operations. */
export function TaskManager({
  tasks,
  onClose,
  onAction,
}: {
  readonly tasks: readonly TaskView[];
  readonly onClose: () => void;
  readonly onAction: (id: string, action: 'cancel' | 'check_in' | 'foreground' | 'background') => Promise<void>;
}): React.ReactElement {
  const { columns } = useTerminalSize();
  const live = tasks
    .filter((item) => ['running', 'awaiting_interaction', 'cancelling'].includes(item.status))
    .sort((a, b) => Number(b.wire?.mode === 'foreground') - Number(a.wire?.mode === 'foreground'));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [transferredId, setTransferredId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const selected = Math.max(
    0,
    live.findIndex((item) => item.id === selectedId),
  );
  const task = live[selected];
  const actions = ['Check in', 'Move to foreground', 'Move to background', 'Cancel task'];
  const send = async (which: number) => {
    if (!task || pending.current) return;
    const operation = (['check_in', 'foreground', 'background', 'cancel'] as const)[which];
    pending.current = true;
    setBusy(true);
    setNotice(null);
    setTransferredId(null);
    try {
      await onAction(task.id, operation);
      if (operation === 'background') setTransferredId(task.id);
      setNotice(`Requested ${actions[which].toLowerCase()}; watch task status for the result.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  useInput((input, key) => {
    if (busy) return;
    if (key.escape || (key.ctrl && input === 'g') || input === '\x07') {
      onClose();
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (live.length) setSelectedId(live[(selected + (key.upArrow ? live.length - 1 : 1)) % live.length]!.id);
      setDetails(false);
      setArmedId(null);
      setNotice(null);
      setTransferredId(null);
      return;
    }
    if (!task) return;
    if (!key.ctrl && !key.meta && input === 'b' && task.wire?.mode === 'foreground') {
      setSelectedId(task.id);
      setArmedId(task.id);
      setNotice(null);
      return;
    }
    if (key.return) {
      if (armedId === task.id) {
        setArmedId(null);
        void send(2);
      } else setDetails(true);
      return;
    }
    const number = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    if (details && number >= 0 && number < actions.length) void send(number);
  });
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Manage background tasks</Text>
      {live.map((item, index) => {
        const kind = item.wire?.kind === 'shell' ? 'Shell' : item.role ?? 'Task';
        const prefix = `${index === selected ? '❯' : ' '} [${kind}${
          item.wire?.mode === 'foreground' ? ' · foreground' : ''
        }] `;
        const suffix = ` · ${item.status.replaceAll('_', ' ')}`;
        const label = (item.wire?.input ?? item.label).replace(/\s+/g, ' ').trim();
        const budget = Math.max(1, columns - 4 - terminalTextWidth(prefix) - terminalTextWidth(suffix));
        return (
          <Text key={item.id}>
            {prefix}
            {truncateTerminalText(label, budget)}
            {suffix}
          </Text>
        );
      })}
      {details && task ? (
        <Box flexDirection="column">
          <Text>
            ID: {task.id}
            {task.agentId ? ` · Agent: ${task.agentId}` : ''}
            {task.turnId ? ` · Turn: ${task.turnId}` : ''}
          </Text>
          {task.wire?.kind || task.wire?.mode ? (
            <Text>{[task.wire.kind, task.wire.mode].filter(Boolean).join(' · ')}</Text>
          ) : null}
          {task.detail ? <Text>{task.detail}</Text> : null}
          {task.wire?.progress ? <Text>Progress: {task.wire.progress}</Text> : null}
          {task.wire?.result ? (
            <Text>
              Result: {task.wire.result.kind}
              {task.wire.result.output ? `\n${task.wire.result.output}` : ''}
              {task.wire.result.error ? `\n${task.wire.result.error.message}` : ''}
              {task.wire.result.reason ? `\n${task.wire.result.reason}` : ''}
            </Text>
          ) : null}
          <Text>Operations depend on the host's task-control capability.</Text>
          {actions.map((label, index) => (
            <Text key={label}>
              {index + 1}. {label}
            </Text>
          ))}
        </Box>
      ) : null}
      {!live.length ? <Text>No background tasks.</Text> : null}
      {armedId === task?.id && task ? (
        <Text>Press Enter to put this {task.wire?.kind ?? 'task'} in the background</Text>
      ) : null}
      {transferredId && tasks.some((item) => item.id === transferredId && item.wire?.mode === 'background') ? (
        <Text>Moved to background</Text>
      ) : notice ? (
        <Text>{notice}</Text>
      ) : null}
      <Text>↑/↓ select · Enter details/confirm · b background · 1–4 operation in details · Esc close</Text>
    </Box>
  );
}
