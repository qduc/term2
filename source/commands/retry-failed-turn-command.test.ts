import { expect, it, vi } from 'vitest';
import { createRetryFailedTurnSlashCommand } from './retry-failed-turn-command.js';

it('inserts a divider before starting the retry', async () => {
  const retryLastFailedTurn = vi.fn(async () => true);
  const addSystemMessage = vi.fn();
  const addDividerMessage = vi.fn();
  const command = createRetryFailedTurnSlashCommand({ retryLastFailedTurn, addSystemMessage, addDividerMessage });
  command.action?.();

  await vi.waitFor(() => expect(retryLastFailedTurn).toHaveBeenCalled());
  expect(addDividerMessage).toHaveBeenCalledTimes(1);
  // The divider is inserted synchronously before the retry launch so it reads
  // as "new attempt starts here" regardless of how the retry settles.
  expect(addDividerMessage.mock.invocationCallOrder[0]).toBeLessThan(retryLastFailedTurn.mock.invocationCallOrder[0]);
});

it('retries the last failed turn and reports success silently', async () => {
  const addSystemMessage = vi.fn();
  const addDividerMessage = vi.fn();
  const retryLastFailedTurn = vi.fn(async () => true);
  const command = createRetryFailedTurnSlashCommand({ retryLastFailedTurn, addSystemMessage, addDividerMessage });

  expect(command.action?.()).toBe(true);
  await vi.waitFor(() => expect(retryLastFailedTurn).toHaveBeenCalledOnce());
  expect(addSystemMessage).not.toHaveBeenCalled();
});

it('reports when the retry did not produce a new response', async () => {
  const addSystemMessage = vi.fn();
  const addDividerMessage = vi.fn();
  const retryLastFailedTurn = vi.fn(async () => false);
  const command = createRetryFailedTurnSlashCommand({ retryLastFailedTurn, addSystemMessage, addDividerMessage });

  command.action?.();
  await vi.waitFor(() => expect(addSystemMessage).toHaveBeenCalledWith('Retry did not produce a new response.'));
});
