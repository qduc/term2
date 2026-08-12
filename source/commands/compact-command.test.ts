import { expect, it, vi } from 'vitest';
import { createCompactSlashCommand } from './compact-command.js';

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
