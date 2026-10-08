import { describe, expect, it } from 'vitest';
import type { DurableGoal } from '../../services/logging/conversation-log-events.js';
import { createGoalCheckToolDefinition, formatGoalCheckCommandMessage } from './goal-check.js';

const goal: DurableGoal = { id: 'g', outcome: 'Ship the feature', successCriteria: 'Tests pass', status: 'active' };

describe('goal_check tool', () => {
  it('never asks for approval and has no write path to the durable goal', async () => {
    let current: DurableGoal | undefined = goal;
    const tool = createGoalCheckToolDefinition({ getGoal: () => current });
    expect(tool.needsApproval({ status: 'achieved', evidence: 'x' }, undefined)).toBe(false);

    const result = await tool.execute(
      { status: 'achieved', evidence: 'shipped in v2', criteriaEvidence: 'vitest: 40 passed' },
      undefined,
      undefined,
    );
    expect(result).toContain('stays active until the user confirms with /goal achieved');
    expect(current).toBe(goal);
    expect(current.status).toBe('active');
    current = undefined;
  });

  it.each([
    ['blocked', 'Control returns to the user'],
    ['not_achieved', 'Continue working toward the outcome now'],
    ['deferred', 'The durable goal stays active and unchanged'],
  ] as const)('acknowledges %s with its stop consequence', async (status, expected) => {
    const tool = createGoalCheckToolDefinition({ getGoal: () => goal });
    expect(await tool.execute({ status, evidence: 'specific' }, undefined, undefined)).toContain(expected);
  });

  it('rejects an incomplete report or a report without an active goal as an error result', async () => {
    const tool = createGoalCheckToolDefinition({ getGoal: () => goal });
    expect(await tool.execute({ status: 'achieved', evidence: 'done' }, undefined, undefined)).toMatch(
      /^Error: goal_check was not recorded: criteriaEvidence is required/,
    );
    const noGoal = createGoalCheckToolDefinition({ getGoal: () => ({ ...goal, status: 'achieved' }) });
    expect(await noGoal.execute({ status: 'achieved', evidence: 'done' }, undefined, undefined)).toMatch(
      /^Error: goal_check was not recorded: there is no active durable goal/,
    );
  });

  it('renders the reported status and evidence visibly in the transcript', () => {
    const [message] = formatGoalCheckCommandMessage(
      {
        type: 'function_call_result',
        callId: 'c1',
        arguments: JSON.stringify({ status: 'blocked', evidence: 'Needs the npm token' }),
        output: 'Self-check recorded: blocked. Control returns to the user.',
      } as any,
      0,
      new Map(),
    );
    expect(message).toMatchObject({
      command: 'goal_check blocked: Needs the npm token',
      success: true,
      toolName: 'goal_check',
    });
  });
});
