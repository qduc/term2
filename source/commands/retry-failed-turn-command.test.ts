import { expect, it, vi } from 'vitest';
import { createRetryFailedTurnSlashCommand } from './retry-failed-turn-command.js';

it('does not insert a divider into the turn being replaced', async () => {
  const retryLastFailedTurn = vi.fn(async () => true);
  const addSystemMessage = vi.fn();
  const addDividerMessage = vi.fn();
  const command = createRetryFailedTurnSlashCommand({ retryLastFailedTurn, addSystemMessage, addDividerMessage });
  command.action?.();

  await vi.waitFor(() => expect(retryLastFailedTurn).toHaveBeenCalled());
  expect(addDividerMessage).not.toHaveBeenCalled();
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
