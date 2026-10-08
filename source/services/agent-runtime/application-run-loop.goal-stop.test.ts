import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, MaxTurnsExceededError, type ApplicationAgent } from './application-run-loop.js';
import type { RunBudgetPolicy } from './run-budget.js';
import type { StreamedModelTurn, StreamedModelTurnRequest } from '../../contracts/streamed-model-turn.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { DurableGoal } from '../logging/conversation-log-events.js';
import { createGoalCheckToolDefinition } from '../../tools/agent/goal-check.js';
import {
  GOAL_CHECK_UNRESOLVED_CAUSE,
  GOAL_STOP_REMINDER_PREFIX,
  createGoalStopPolicy,
} from '../conversation/durable-goal-stop-check.js';

/**
 * The active-goal stop guard through the run loop's public boundary, with the
 * real `goal_check` tool and stop policy and a scripted model.
 */

type Step =
  | { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> }
  | ((request: StreamedModelTurnRequest) => Promise<never> | never);

function scriptedModel(steps: Step[]) {
  const requests: StreamedModelTurnRequest[] = [];
  const model: StreamedModelTurn = {
    async *stream(request) {
      requests.push(request);
      const step = steps[requests.length - 1] ?? { text: 'script exhausted' };
      if (typeof step === 'function') {
        await step(request);
        return;
      }
      yield {
        type: 'completion',
        responseId: `response-${requests.length}`,
        output: [
          ...(step.text ? [{ type: 'message' as const, content: [{ type: 'text' as const, text: step.text }] }] : []),
          ...(step.calls ?? []).map((call, index) => ({
            type: 'tool_call' as const,
            id: `call-${requests.length}-${index}`,
            name: call.name,
            arguments: JSON.stringify(call.args),
          })),
        ],
      };
    },
  };
  return { model, requests };
}

const work = { name: 'read_file', args: { path: 'src/feature.ts' } };
const goalCheck = (status: string, evidence = `${status} evidence`, extra: Record<string, unknown> = {}) => ({
  name: 'goal_check',
  args: { status, evidence, ...extra },
});

const readFile: ToolDefinition = {
  name: 'read_file',
  description: 'read',
  parameters: z.object({ path: z.string() }),
  needsApproval: () => false,
  execute: () => 'file contents',
  formatCommandMessage: () => [],
};
const danger: ToolDefinition = {
  name: 'danger',
  description: 'Requires approval',
  parameters: z.object({}),
  needsApproval: () => true,
  execute: () => 'approved result',
  formatCommandMessage: () => [],
};

function setup(steps: Step[], initialGoal: DurableGoal | null = activeGoal(), extraTools: ToolDefinition[] = []) {
  const goalState: { current: DurableGoal | undefined } = { current: initialGoal ?? undefined };
  const getGoal = () => goalState.current;
  const scripted = scriptedModel(steps);
  const logDiagnostic = vi.fn();
  const loop = new ApplicationRunLoop({ resolveModel: () => scripted.model, logDiagnostic });
  const agent: ApplicationAgent = {
    name: 'root',
    instructions: 'test',
    model: 'test-model',
    tools: [readFile, createGoalCheckToolDefinition({ getGoal }), ...extraTools],
  };
  const onNormalStop = createGoalStopPolicy(getGoal);
  return { ...scripted, loop, agent, goalState, onNormalStop, logDiagnostic };
}

function activeGoal(overrides: Partial<DurableGoal> = {}): DurableGoal {
  return { id: 'goal-1', outcome: 'Ship the feature', status: 'active', ...overrides };
}

const reminderCount = (requests: StreamedModelTurnRequest[]) =>
  (JSON.stringify(requests.at(-1)?.input ?? []).match(new RegExp(GOAL_STOP_REMINDER_PREFIX, 'g')) ?? []).length;
const userInput = (content: string) => [{ type: 'message', role: 'user', content }];

describe('active-goal stop guard through ApplicationRunLoop', () => {
  it('completion: a valid achieved check ends the turn without changing durable goal status', async () => {
    const t = setup([{ calls: [work] }, { calls: [goalCheck('achieved')] }, { text: 'Shipped; evidence above.' }]);
    const goalBefore = t.goalState.current;

    const stream = t.loop.startStream(t.agent, userInput('ship it'), { onNormalStop: t.onNormalStop });
    await stream.completed;

    expect(t.requests).toHaveLength(3);
    expect(reminderCount(t.requests)).toBe(0);
    expect(stream.terminalCause).toBeUndefined();
    expect(stream.finalOutput).toBe('Shipped; evidence above.');
    // A self-check never writes goal state: the same active record remains.
    expect(t.goalState.current).toBe(goalBefore);
    expect(t.goalState.current?.status).toBe('active');
    expect(JSON.stringify(stream.history)).toContain('stays active until the user confirms with /goal achieved');
  });

  it('continuation: a stop without a check is re-prompted and the same run keeps working', async () => {
    const t = setup([
      { text: 'I think that is it.' },
      { calls: [work] },
      { calls: [goalCheck('achieved')] },
      { text: 'Done.' },
    ]);

    const stream = t.loop.startStream(t.agent, userInput('ship it'), { onNormalStop: t.onNormalStop });
    await stream.completed;

    expect(t.requests).toHaveLength(4);
    expect(JSON.stringify(t.requests[1]!.input)).toContain(`${GOAL_STOP_REMINDER_PREFIX} (1 of 2)`);
    expect(stream.terminalCause).toBeUndefined();
    expect(t.logDiagnostic).toHaveBeenCalledWith(
      'Normal stop policy decided',
      expect.objectContaining({ action: 'continue', guard: 'goal_stop_check', reason: 'missing_check' }),
      expect.objectContaining({ eventType: 'run_loop.normal_stop_policy' }),
    );
  });

  it('continuation: not_achieved keeps working through the ordinary tool loop, and an idle stop is re-prompted', async () => {
    const t = setup([
      { calls: [goalCheck('not_achieved', 'tests still failing')] },
      { text: 'I will stop here.' },
      { calls: [work] },
      { calls: [goalCheck('achieved')] },
      { text: 'Done.' },
    ]);

    const stream = t.loop.startStream(t.agent, userInput('ship it'), { onNormalStop: t.onNormalStop });
    await stream.completed;

    expect(t.requests).toHaveLength(5);
    expect(JSON.stringify(t.requests[1]!.input)).toContain('Continue working toward the outcome now');
    expect(JSON.stringify(t.requests[2]!.input)).toContain('reported not_achieved (tests still failing)');
    expect(stream.terminalCause).toBeUndefined();
  });

  it('missing checks: an incomplete achieved claim is not accepted as achievement', async () => {
    const t = setup(
      [
        { calls: [goalCheck('achieved', 'looks done')] },
        { text: 'Done.' },
        { calls: [goalCheck('achieved', 'shipped', { criteriaEvidence: 'vitest: 12 passed' })] },
        { text: 'Done, with criteria evidence.' },
      ],
      activeGoal({ successCriteria: 'Focused tests pass' }),
    );

    const stream = t.loop.startStream(t.agent, userInput('ship it'), { onNormalStop: t.onNormalStop });
    await stream.completed;

    expect(t.requests).toHaveLength(4);
    expect(JSON.stringify(t.requests[1]!.input)).toContain('Error: goal_check was not recorded');
    expect(JSON.stringify(t.requests[2]!.input)).toContain('the latest goal_check was incomplete');
    expect(t.goalState.current?.status).toBe('active');
  });

  it('loop guard: repeated stops without a valid check return control visibly at the limit', async () => {
    const t = setup([{ text: 'done' }, { text: 'done' }, { text: 'done' }, { text: 'never sent' }]);

    const stream = t.loop.startStream(t.agent, userInput('ship it'), { onNormalStop: t.onNormalStop });
    await stream.completed;

    // One original request plus exactly two reminders; the third idle stop ends the run.
    expect(t.requests).toHaveLength(3);
    expect(reminderCount(t.requests)).toBe(2);
    expect(stream.terminalCause).toBe(GOAL_CHECK_UNRESOLVED_CAUSE);
    expect(t.logDiagnostic).toHaveBeenLastCalledWith(
      'Normal stop policy decided',
      expect.objectContaining({ action: 'stop', reason: 'unresolved', remindersWithoutWork: 2, limit: 2 }),
      expect.anything(),
    );
    expect(t.goalState.current?.status).toBe('active');
  });

  it('loop guard: an idle not_achieved/stop exchange is bounded too', async () => {
    const t = setup([
      { calls: [goalCheck('not_achieved')] },
      { text: 'stopping' },
      { calls: [goalCheck('not_achieved')] },
      { text: 'stopping' },
      { calls: [goalCheck('not_achieved')] },
      { text: 'stopping' },
      { text: 'never sent' },
    ]);

    const stream = t.loop.startStream(t.agent, userInput('ship it'), { onNormalStop: t.onNormalStop });
    await stream.completed;

    expect(t.requests).toHaveLength(6);
    expect(stream.terminalCause).toBe(GOAL_CHECK_UNRESOLVED_CAUSE);
  });

  it('blocker: a blocked check returns control after the final reply without a reminder', async () => {
    const t = setup([
      { calls: [work] },
      { calls: [goalCheck('blocked', 'Publishing needs an npm token that only the user has.')] },
      { text: 'I am blocked: please provide the npm token.' },
    ]);

    const stream = t.loop.startStream(t.agent, userInput('ship it'), { onNormalStop: t.onNormalStop });
    await stream.completed;

    expect(t.requests).toHaveLength(3);
    expect(reminderCount(t.requests)).toBe(0);
    expect(stream.terminalCause).toBeUndefined();
    expect(stream.finalOutput).toBe('I am blocked: please provide the npm token.');
    const checkResult = stream.history.find(
      (item: any) => item.type === 'function_call_result' && item.name === 'goal_check',
    ) as any;
    expect(checkResult.output).toContain('Control returns to the user');
  });

  it('cancellation: Ctrl+C during a guard continuation ends the turn without another request', async () => {
    const controller = new AbortController();
    const t = setup([
      { text: 'done' },
      () => {
        controller.abort();
        throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
      },
      { text: 'never sent' },
    ]);

    const stream = t.loop.startStream(t.agent, userInput('ship it'), {
      onNormalStop: t.onNormalStop,
      signal: controller.signal,
    });
    await expect(stream.completed).rejects.toMatchObject({ name: 'AbortError' });

    expect(t.requests).toHaveLength(2);
    expect(stream.cancelled).toBe(true);
  });

  it.each([
    ['cancellation', Object.assign(new Error('Operation aborted'), { name: 'AbortError' })],
    ['a provider error', new Error('upstream 500')],
  ])('%s ends the run without consulting the stop guard', async (_case, failure) => {
    const controller = new AbortController();
    const onNormalStop = vi.fn(createGoalStopPolicy(() => activeGoal()));
    const t = setup([
      () => {
        if (failure.name === 'AbortError') controller.abort();
        throw failure;
      },
    ]);

    const stream = t.loop.startStream(t.agent, userInput('ship it'), { onNormalStop, signal: controller.signal });
    await expect(stream.completed).rejects.toBe(failure);
    expect(onNormalStop).not.toHaveBeenCalled();
    expect(t.requests).toHaveLength(1);
  });

  it.each([
    ['an explicit pause', 'Pause the goal work for now and wait for me.'],
    ['an unrelated question', 'Unrelated: what time zone is Hanoi in?'],
  ])('user direction: %s is answered with a deferred check, leaving the goal active', async (_case, message) => {
    const t = setup([{ calls: [goalCheck('deferred', 'The user asked me to do something else.')] }, { text: 'OK.' }]);

    const stream = t.loop.startStream(t.agent, userInput(message), { onNormalStop: t.onNormalStop });
    await stream.completed;

    expect(t.requests).toHaveLength(2);
    expect(reminderCount(t.requests)).toBe(0);
    expect(stream.terminalCause).toBeUndefined();
    expect(t.goalState.current?.status).toBe('active');
  });

  it('user direction: a steer that arrives after a check invalidates it, so the newer instruction is answered', async () => {
    const t = setup([]);
    const steps: Step[] = [
      { calls: [goalCheck('achieved')] },
      { text: 'All done.' },
      { calls: [goalCheck('deferred', 'User paused goal work.')] },
      { text: 'Paused.' },
    ];
    const scripted = scriptedModel(steps);
    const originalStream = scripted.model.stream.bind(scripted.model);
    scripted.model.stream = (request) => {
      // The user types "pause" while the first response is streaming.
      if (scripted.requests.length === 0) {
        void loop.steer([{ type: 'message', role: 'user', content: 'pause the goal work, I will review first' }]);
      }
      return originalStream(request);
    };
    // Read lazily by the wrapper above, once the first request is in flight.
    const loop = new ApplicationRunLoop({ resolveModel: () => scripted.model });

    const stream = loop.startStream(t.agent, userInput('ship it'), { onNormalStop: t.onNormalStop });
    await stream.completed;

    expect(scripted.requests).toHaveLength(4);
    expect(JSON.stringify(scripted.requests[1]!.input)).toContain('pause the goal work');
    expect(JSON.stringify(scripted.requests[2]!.input)).toContain(`${GOAL_STOP_REMINDER_PREFIX} (1 of 2)`);
    expect(stream.terminalCause).toBeUndefined();
  });

  it('approval boundary: a pending approval pauses the turn without a goal check', async () => {
    const t = setup(
      [{ calls: [{ name: 'danger', args: {} }] }, { calls: [goalCheck('achieved')] }, { text: 'Done.' }],
      activeGoal(),
      [danger],
    );
    const onNormalStop = vi.fn(t.onNormalStop);

    const first = t.loop.startStream(t.agent, userInput('do the dangerous thing'), { onNormalStop });
    await first.completed;
    expect(first.interruptions).toHaveLength(1);
    expect(onNormalStop).not.toHaveBeenCalled();

    const handle = first.state as any;
    handle.approve?.(first.interruptions![0]);
    const resumed = t.loop.continueRunStream(handle, { onNormalStop });
    await resumed.completed;

    expect(t.requests).toHaveLength(3);
    expect(reminderCount(t.requests)).toBe(0);
    expect(onNormalStop).toHaveBeenCalledTimes(1);
  });

  it('budget controls: a guard continuation still counts against the legacy turn ceiling', async () => {
    const t = setup([{ text: 'done' }, { text: 'never sent' }]);

    const stream = t.loop.startStream(t.agent, userInput('ship it'), { onNormalStop: t.onNormalStop, maxTurns: 1 });
    await expect(stream.completed).rejects.toBeInstanceOf(MaxTurnsExceededError);
    expect(t.requests).toHaveLength(1);
  });

  it('budget controls: a staged run budget pauses for the human before the reminder request is sent', async () => {
    const policy: RunBudgetPolicy = {
      maxUsdMicros: 5_000_000,
      maxUnpricedTokens: 500_000,
      maxActiveTimeMs: 3_600_000,
      warningHeadroomUsdMicros: 1_000_000,
      warningHeadroomUnpricedTokens: 100_000,
      warningHeadroomActiveTimeMs: 900_000,
      softHeadroomUsdMicros: 250_000,
      softHeadroomUnpricedTokens: 25_000,
      softHeadroomActiveTimeMs: 300_000,
      turnBackstop: 2,
      extensionPercent: 50,
      maxParentExtensions: 2,
      escalation: 'contain',
      identicalToolCallThreshold: 3,
    };
    const t = setup([{ calls: [work] }, { text: 'done' }, { text: 'never sent' }]);

    const stream = t.loop.startStream(t.agent, userInput('ship it'), {
      onNormalStop: t.onNormalStop,
      runBudget: policy,
    });
    await stream.completed;

    expect(t.requests).toHaveLength(2);
    expect(stream.interruptions).toEqual([expect.objectContaining({ type: 'run_budget_interaction' })]);
  });

  it('scope: no check is required without an active goal or without the goal_check tool', async () => {
    const noGoal = setup([{ text: 'done' }], null);
    await noGoal.loop.startStream(noGoal.agent, userInput('hi'), { onNormalStop: noGoal.onNormalStop }).completed;
    expect(noGoal.requests).toHaveLength(1);

    const achieved = setup([{ text: 'done' }], activeGoal({ status: 'achieved' }));
    await achieved.loop.startStream(achieved.agent, userInput('hi'), { onNormalStop: achieved.onNormalStop }).completed;
    expect(achieved.requests).toHaveLength(1);

    const subagentLike = setup([{ text: 'done' }]);
    const withoutTool = { ...subagentLike.agent, tools: [readFile] };
    await subagentLike.loop.startStream(withoutTool, userInput('hi'), { onNormalStop: subagentLike.onNormalStop })
      .completed;
    expect(subagentLike.requests).toHaveLength(1);
  });
});
