import { expect, it, vi } from 'vitest';
import { createRetryFailedTurnSlashCommand } from './retry-failed-turn-command.js';

it('retries the last failed turn and reports success silently', async () => {
  const addSystemMessage = vi.fn();
  const retryLastFailedTurn = vi.fn(async () => true);
  const command = createRetryFailedTurnSlashCommand({ retryLastFailedTurn, addSystemMessage });

  expect(command.action()).toBe(true);
  await vi.waitFor(() => expect(retryLastFailedTurn).toHaveBeenCalledOnce());
  expect(addSystemMessage).not.toHaveBeenCalled();
});

it('reports when the retry did not produce a new response', async () => {
  const addSystemMessage = vi.fn();
  const retryLastFailedTurn = vi.fn(async () => false);
  const command = createRetryFailedTurnSlashCommand({ retryLastFailedTurn, addSystemMessage });

  command.action();
  await vi.waitFor(() => expect(addSystemMessage).toHaveBeenCalledWith('Retry did not produce a new response.'));
});
