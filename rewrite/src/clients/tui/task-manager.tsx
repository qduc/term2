import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TaskView } from './state.js';

/** Inspect a wire task and send only explicitly selected task-ID-scoped operations. */
export function TaskManager({ tasks, onClose, onAction }: {
  readonly tasks: readonly TaskView[];
  readonly onClose: () => void;
  readonly onAction: (id: string, action: 'cancel' | 'check_in' | 'foreground') => Promise<void>;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [action, setAction] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const task = tasks.find(item => item.id === taskId);
  const actions = ['Check in', 'Move to foreground', 'Cancel task'];
  const send = async (which: number) => {
    if (!task || pending.current) return;
    const operation = (['check_in', 'foreground', 'cancel'] as const)[which];
    pending.current = true; setBusy(true); setNotice(null);
    try { await onAction(task.id, operation); setNotice(`Requested ${actions[which].toLowerCase()}; watch task status for the result.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  };
  useInput((input, key) => {
    if (busy) return;
    if (key.escape) { if (taskId) { setTaskId(null); setSelected(0); setNotice(null); } else onClose(); return; }
    if (key.upArrow) { if (taskId) setAction(value => Math.max(0, value - 1)); else setSelected(value => Math.max(0, value - 1)); return; }
    if (key.downArrow) { if (taskId) setAction(value => Math.min(actions.length - 1, value + 1)); else setSelected(value => Math.min(Math.max(0, tasks.length - 1), value + 1)); return; }
    const number = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    if (!key.return && number < 0) return;
    const index = number < 0 ? (taskId ? action : selected) : number;
    if (taskId) {
      if (!task) setNotice('Task is no longer available.');
      else if (index < actions.length) void send(index);
    } else if (tasks[index]) { setTaskId(tasks[index].id); setAction(0); setNotice(null); }
  });
  return <Box flexDirection="column" borderStyle="round" paddingX={1}>
    <Text bold>{task ? `${task.label} · ${task.status}` : 'Background tasks'}</Text>
    {task ? <Box flexDirection="column">
      <Text>Task: {task.id}{task.agentId ? ` · Agent: ${task.agentId}` : ''}{task.turnId ? ` · Turn: ${task.turnId}` : ''}</Text>
      {task.detail ? <Text>{task.detail}</Text> : null}
    </Box> : null}
    {taskId && !task ? <Text>Task is no longer available.</Text> : null}
    {!taskId && !tasks.length ? <Text>No background tasks.</Text> : null}
    {(taskId ? actions : tasks.map(item => `${item.label} · ${item.status}`)).map((label, index) =>
      <Text key={index}>{index === (taskId ? action : selected) ? '❯' : ' '} {index + 1}. {label}</Text>)}
    {notice ? <Text>{notice}</Text> : null}
    <Text>↑/↓ select · Enter choose · Esc back</Text>
  </Box>;
}
