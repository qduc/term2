import { it, expect, vi } from 'vitest';
import { createRetryToolSlashCommand } from './retry-tool-command.js';

it('retries the last tool call', async () => {
  const retryLastToolOutput = vi.fn(async () => true);
  const addSystemMessage = vi.fn();

  createRetryToolSlashCommand({ retryLastToolOutput, addSystemMessage }).action?.();
  await vi.waitFor(() => expect(retryLastToolOutput).toHaveBeenCalled());

  expect(addSystemMessage).not.toHaveBeenCalled();
});

it('reports when there is no tool call to retry', async () => {
  const retryLastToolOutput = vi.fn(async () => false);
  const addSystemMessage = vi.fn();

  createRetryToolSlashCommand({ retryLastToolOutput, addSystemMessage }).action?.();
  await vi.waitFor(() => expect(addSystemMessage).toHaveBeenCalledWith('No tool call to retry.'));
});
