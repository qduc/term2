import { describe, expect, it } from 'vitest';
import type { DurableGoal } from '../../services/logging/conversation-log-events.js';
import { createProposeGoalToolDefinition, type ProposeGoalDeps } from './propose-goal.js';

const activeGoal: DurableGoal = {
  id: 'goal-1',
  outcome: 'Ship the feature',
  status: 'active',
};

const createDeps = (overrides: Partial<ProposeGoalDeps> = {}) => {
  const appended: DurableGoal[] = [];
  const deps: ProposeGoalDeps = {
    getGoal: () => undefined,
    hasPriorProposal: () => false,
    appendGoal: (goal) => appended.push(goal),
    ...overrides,
  };
  return { deps, appended };
};

describe('propose_goal tool', () => {
  it('prompts for approval when the session has no goal and no prior proposal', async () => {
    const { deps } = createDeps();
    const tool = createProposeGoalToolDefinition(deps);
    expect(tool.needsApproval({ outcome: 'Ship the feature' }, undefined)).toBe(true);
  });

  it('does not prompt when a durable goal is already set', async () => {
    const { deps } = createDeps({ getGoal: () => activeGoal });
    const tool = createProposeGoalToolDefinition(deps);
    expect(tool.needsApproval({ outcome: 'Another goal' }, undefined)).toBe(false);
  });

  it('does not prompt when a proposal was already made this session', async () => {
    const { deps } = createDeps({ hasPriorProposal: () => true });
    const tool = createProposeGoalToolDefinition(deps);
    expect(tool.needsApproval({ outcome: 'Ship the feature' }, undefined)).toBe(false);
  });

  it('appends the proposed goal on execution so the user approval persists it', async () => {
    const { deps, appended } = createDeps();
    const tool = createProposeGoalToolDefinition(deps);
    const result = await tool.execute(
      { outcome: 'Ship the feature', successCriteria: 'All tests pass' },
      undefined,
      undefined,
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      outcome: 'Ship the feature',
      successCriteria: 'All tests pass',
      status: 'active',
    });
    expect(appended[0].id).toBeTruthy();
    expect(String(result)).toContain('Ship the feature');
  });

  it('refuses without appending when a durable goal is already set', async () => {
    const { deps, appended } = createDeps({ getGoal: () => activeGoal });
    const tool = createProposeGoalToolDefinition(deps);
    const result = await tool.execute({ outcome: 'Another goal' }, undefined, undefined);
    expect(appended).toHaveLength(0);
    expect(String(result)).toContain('already set');
  });

  it('refuses without appending when a proposal was already made this session', async () => {
    const { deps, appended } = createDeps({ hasPriorProposal: () => true });
    const tool = createProposeGoalToolDefinition(deps);
    const result = await tool.execute({ outcome: 'Ship the feature' }, undefined, undefined);
    expect(appended).toHaveLength(0);
    expect(String(result)).toContain('already');
  });

  it('rejects an outcome longer than the durable-goal bound', async () => {
    const { deps, appended } = createDeps();
    const tool = createProposeGoalToolDefinition(deps);
    const result = await tool.execute({ outcome: 'x'.repeat(2001) }, undefined, undefined);
    expect(appended).toHaveLength(0);
    expect(String(result)).toContain('Error');
  });

  it('describes the discussion-to-implementation timing contract', () => {
    const { deps } = createDeps();
    const tool = createProposeGoalToolDefinition(deps);
    expect(tool.description).toMatch(/transition/i);
    expect(tool.description).toMatch(/once/i);
  });
});
