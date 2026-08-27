import { expect, it, vi } from 'vitest';
import { createCompactSlashCommand } from './compact-command.js';

it('announces compaction immediately while the work is still running', async () => {
  const addSystemMessage = vi.fn();
  let resolveCompact!: (value: string) => void;
  const compactContext = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveCompact = resolve;
      }),
  );
  const command = createCompactSlashCommand({ compactContext, addSystemMessage });

  expect(command.action()).toBe(true);
  expect(addSystemMessage).toHaveBeenCalledWith('Compacting context...');
  expect(compactContext).toHaveBeenCalledOnce();

  resolveCompact('Context compacted locally.');
  await vi.waitFor(() => expect(addSystemMessage).toHaveBeenCalledWith('Context compacted locally.'));
});

it('runs manual compaction and reports its result', async () => {
  const addSystemMessage = vi.fn();
  const compactContext = vi.fn(async () => 'Context compacted locally.');
  const command = createCompactSlashCommand({ compactContext, addSystemMessage });

  expect(command.action()).toBe(true);
  await vi.waitFor(() => expect(addSystemMessage).toHaveBeenCalledWith('Context compacted locally.'));
  expect(compactContext).toHaveBeenCalledOnce();
});

it('reports manual compaction failures without submitting a chat turn', async () => {
  const addSystemMessage = vi.fn();
  const command = createCompactSlashCommand({
    compactContext: async () => {
      throw new Error('summary rejected');
    },
    addSystemMessage,
  });

  command.action();
  await vi.waitFor(() => expect(addSystemMessage).toHaveBeenCalledWith('Context compaction failed: summary rejected'));
});
