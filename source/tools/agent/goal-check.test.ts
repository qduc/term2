import { describe, expect, it } from 'vitest';
import type { DurableGoal } from '../../services/logging/conversation-log-events.js';
import { createGoalCheckToolDefinition, formatGoalCheckCommandMessage, GOAL_CHANGED_PROBLEM } from './goal-check.js';

const goal: DurableGoal = { id: 'g', outcome: 'Ship the feature', successCriteria: 'Tests pass', status: 'active' };
/** The details the root run loop passes for a call whose request was shown `shown`. */
const shownTo = (shown: DurableGoal | undefined) => ({ toolCall: { callId: 'c' }, request: { goal: shown } });

describe('goal_check tool', () => {
  it('never asks for approval and has no write path of its own to the durable goal', async () => {
    let current: DurableGoal | undefined = goal;
    const tool = createGoalCheckToolDefinition({ getGoal: () => current });
    expect(tool.needsApproval({ status: 'achieved', evidence: 'x' }, undefined)).toBe(false);

    const result = await tool.execute(
      { status: 'achieved', evidence: 'shipped in v2', criteriaEvidence: 'vitest: 40 passed' },
      undefined,
      shownTo(goal),
    );
    // The stop seam closes the goal; executing the check writes nothing.
    expect(result).toContain('The durable goal is marked achieved when you end the turn now');
    expect(current).toBe(goal);
    expect(current.status).toBe('active');
    current = undefined;
  });

  it('names the goal its request was shown in the recorded result', async () => {
    const other: DurableGoal = { ...goal, id: 'g2' };
    let current: DurableGoal = goal;
    const tool = createGoalCheckToolDefinition({ getGoal: () => current });
    const args = { status: 'blocked', evidence: 'needs token' } as const;
    expect(await tool.execute(args, undefined, shownTo(goal))).toMatch(/^Self-check recorded: \[goal g\] blocked\./);
    current = other;
    expect(await tool.execute(args, undefined, shownTo(other))).toMatch(/^Self-check recorded: \[goal g2\] blocked\./);
  });

  it.each([
    ['a different goal than the session holds now', { ...goal, id: 'g-old' }],
    ['no goal at all', undefined],
  ])('refuses to record when its request was shown %s', async (_case, shown) => {
    const tool = createGoalCheckToolDefinition({ getGoal: () => goal });
    const result = await tool.execute(
      { status: 'achieved', evidence: 'shipped', criteriaEvidence: 'vitest: 40 passed' },
      undefined,
      shownTo(shown),
    );
    expect(result).toBe(`Error: goal_check was not recorded: ${GOAL_CHANGED_PROBLEM}.`);
    expect(result).not.toContain('Self-check recorded');
  });

  it('refuses to record without a request snapshot (a caller outside the root run loop)', async () => {
    const tool = createGoalCheckToolDefinition({ getGoal: () => goal });
    for (const details of [undefined, { toolCall: { callId: 'c' } }]) {
      expect(await tool.execute({ status: 'blocked', evidence: 'needs token' }, undefined, details)).toBe(
        `Error: goal_check was not recorded: ${GOAL_CHANGED_PROBLEM}.`,
      );
    }
  });

  it('records against an unchanged goal whose status changed after the request (same id)', async () => {
    const tool = createGoalCheckToolDefinition({ getGoal: () => ({ ...goal }) });
    expect(await tool.execute({ status: 'blocked', evidence: 'needs token' }, undefined, shownTo(goal))).toMatch(
      /^Self-check recorded: \[goal g\] blocked\./,
    );
  });

  it('tells the model that achieved closes the goal, so it must verify against the criteria first', () => {
    const tool = createGoalCheckToolDefinition({ getGoal: () => goal });
    expect(tool.description).toContain('Reporting achieved closes the goal');
    expect(tool.description).toContain('verify the outcome and every success criterion against concrete evidence');
    expect(tool.description).not.toContain('only the user can');
  });

  it.each([
    ['blocked', 'Control returns to the user'],
    ['not_achieved', 'Continue working toward the outcome now'],
    ['deferred', 'The durable goal stays active and unchanged'],
  ] as const)('acknowledges %s with its stop consequence', async (status, expected) => {
    const tool = createGoalCheckToolDefinition({ getGoal: () => goal });
    expect(await tool.execute({ status, evidence: 'specific' }, undefined, shownTo(goal))).toContain(expected);
  });

  it('rejects an incomplete report or a report without an active goal as an error result', async () => {
    const tool = createGoalCheckToolDefinition({ getGoal: () => goal });
    expect(await tool.execute({ status: 'achieved', evidence: 'done' }, undefined, shownTo(goal))).toMatch(
      /^Error: goal_check was not recorded: criteriaEvidence is required/,
    );
    const noGoal = createGoalCheckToolDefinition({ getGoal: () => ({ ...goal, status: 'achieved' }) });
    expect(await noGoal.execute({ status: 'achieved', evidence: 'done' }, undefined, shownTo(goal))).toMatch(
      /^Error: goal_check was not recorded: there is no active durable goal/,
    );
  });

  it('renders the reported status and evidence visibly in the transcript', () => {
    const [message] = formatGoalCheckCommandMessage(
      {
        type: 'function_call_result',
        callId: 'c1',
        arguments: JSON.stringify({ status: 'blocked', evidence: 'Needs the npm token' }),
        output: 'Self-check recorded: [goal g1] blocked. Control returns to the user.',
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
