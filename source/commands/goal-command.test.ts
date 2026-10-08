import { it, expect, vi } from 'vitest';
import { createGoalSlashCommand } from './goal-command.js';
import { createDurableGoal } from '../services/conversation/durable-goal.js';

it('confirms the persisted goal before a React state update becomes visible', () => {
  const getGoal = vi.fn(() => undefined);
  const setGoal = vi.fn();
  const addSystemMessage = vi.fn();
  const command = createGoalSlashCommand({ getGoal, setGoal, addSystemMessage });
  command.action('set Ship the feature --criteria Tests pass');
  expect(setGoal).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'Ship the feature' }));
  expect(addSystemMessage).toHaveBeenLastCalledWith('Goal (active): Ship the feature\nSuccess criteria: Tests pass');
});

it('confirms terminal transitions before the updated state becomes visible', () => {
  const goal = createDurableGoal('Ship the feature');
  const addSystemMessage = vi.fn();
  const command = createGoalSlashCommand({ getGoal: () => goal, setGoal: vi.fn(), addSystemMessage });
  command.action('achieved');
  expect(addSystemMessage).toHaveBeenLastCalledWith('Goal (achieved): Ship the feature');
  command.action('abandon');
  expect(addSystemMessage).toHaveBeenLastCalledWith('Goal (abandoned): Ship the feature');
});

it('shows no-goal state, sets/replaces, and makes explicit terminal transitions', () => {
  let goal: ReturnType<typeof createDurableGoal> | undefined;
  const messages: string[] = [];
  const command = createGoalSlashCommand({
    getGoal: () => goal,
    setGoal: (next) => {
      goal = next;
    },
    addSystemMessage: (message) => messages.push(message),
  });
  command.action('show');
  expect(messages.pop()).toContain('No durable goal is set');
  command.action('set Ship the feature --criteria Tests pass');
  expect(goal).toMatchObject({ outcome: 'Ship the feature', successCriteria: 'Tests pass', status: 'active' });
  command.action('achieved');
  expect(goal?.status).toBe('achieved');
  command.action('set New objective');
  expect(goal).toMatchObject({ outcome: 'New objective', status: 'active' });
  command.action('abandon');
  expect(goal?.status).toBe('abandoned');
  expect(messages.at(-1)).toContain('Goal (abandoned)');
});

it('does not replace in-memory goal when durable append fails', () => {
  const existing = createDurableGoal('Existing');
  const setGoal = vi.fn(() => {
    throw new Error('fsync failed');
  });
  const addSystemMessage = vi.fn();
  createGoalSlashCommand({ getGoal: () => existing, setGoal, addSystemMessage }).action('set Replacement');
  expect(setGoal).toHaveBeenCalledOnce();
  expect(addSystemMessage).toHaveBeenCalledWith('Goal update failed: fsync failed');
});
