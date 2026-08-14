import { expect, it } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';
import type { RunBudgetEvent, RunBudgetPolicy } from './run-budget.js';
import type { StreamedModelTurn } from '../../contracts/streamed-model-turn.js';
import type { ToolDefinition } from '../../tools/types.js';

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
  identicalToolCallThreshold: 3,
};

const loopingTool: ToolDefinition = {
  name: 'read_file',
  description: 'read',
  parameters: z.object({ path: z.string() }),
  needsApproval: () => false,
  execute: () => 'ok',
  formatCommandMessage: () => [],
};

const agent: ApplicationAgent = {
  name: 'budget-test',
  instructions: 'test',
  model: 'test',
  tools: [loopingTool],
};

it('pauses a main run at critical evidence until a finite extension resumes its same logical run', async () => {
  let calls = 0;
  const evidence: RunBudgetEvent[] = [];
  const model: StreamedModelTurn = {
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield { type: 'tool_call' as const, id: `call-${calls}`, name: 'read_file', arguments: '{"path":"a"}' };
        yield { type: 'completion' as const, responseId: `resp-${calls}`, output: [] };
        return;
      }
      yield {
        type: 'completion' as const,
        responseId: 'done',
        output: [{ type: 'message' as const, content: [{ type: 'text' as const, text: 'done' }] }],
      };
    },
  };
  const loop = new ApplicationRunLoop({ resolveModel: () => model });
  const stream = loop.startStream(agent, 'go', {
    maxTurns: 1,
    runBudget: { ...policy, turnBackstop: 1 },
    onRunBudgetEvent: (event) => evidence.push(event),
  });

  await stream.completed;

  // The tool result is retained, but neither another tool nor a second model
  // request may happen while the interaction has no human answer.
  expect(calls).toBe(1);
  expect(stream.interruptions).toEqual([
    expect.objectContaining({ type: 'run_budget_interaction', event: expect.objectContaining({ stage: 'critical' }) }),
  ]);
  expect(evidence).toContainEqual(expect.objectContaining({ type: 'budget_stage', stage: 'critical' }));

  expect(loop.grantRunBudgetExtension()).toEqual({ granted: true, extensionsGranted: 1 });
  stream.state!.approve?.(stream.interruptions![0]);
  const resumed = loop.continueRunStream(stream.state!);
  await resumed.completed;

  expect(calls).toBe(2);
  expect(resumed.finalOutput).toBe('done');
});

it('caps parent-granted extensions but leaves the human as the uncapped terminal judge', async () => {
  const loop = new ApplicationRunLoop({
    resolveModel: () => ({
      stream: async function* () {
        yield { type: 'completion' as const, responseId: 'done', output: [] };
      },
    }),
  });
  const stream = loop.startStream(agent, 'go', { runBudget: policy });

  expect(loop.grantRunBudgetExtension('parent')).toEqual({ granted: true, extensionsGranted: 1 });
  expect(loop.grantRunBudgetExtension('parent')).toEqual({ granted: true, extensionsGranted: 2 });
  expect(loop.grantRunBudgetExtension('parent')).toEqual({ granted: false, extensionsGranted: 2 });
  // The plan routes the third grant past the parent to the human, so the human
  // path must still be able to grant after the parent cap is spent.
  expect(loop.grantRunBudgetExtension('human')).toEqual({ granted: true, extensionsGranted: 3 });
  await stream.completed;
});

it('charges a finite extension when an unattended continuation answers the interaction', async () => {
  let calls = 0;
  const loop = new ApplicationRunLoop({
    resolveModel: () => ({
      stream: async function* () {
        calls += 1;
        yield { type: 'tool_call' as const, id: `call-${calls}`, name: 'read_file', arguments: '{"path":"a"}' };
        yield { type: 'completion' as const, responseId: `resp-${calls}`, output: [] };
      },
    }),
  });
  // maxParentExtensions is 2: an --auto-approve style resume may buy two more
  // envelopes and must then stop rather than run unbounded.
  let stream = loop.startStream(agent, 'go', { runBudget: { ...policy, turnBackstop: 1 } });
  await stream.completed;
  expect(calls).toBe(1);

  for (const expectedCalls of [2, 3]) {
    expect(stream.interruptions?.length).toBe(1);
    // No grantRunBudgetExtension() call: this is the bare approve() that the
    // continuation applier and non-interactive mode issue.
    stream.state!.approve?.(stream.interruptions![0]);
    stream = loop.continueRunStream(stream.state!);
    await stream.completed;
    expect(calls).toBe(expectedCalls);
  }

  expect(stream.interruptions?.length).toBe(1);
  stream.state!.approve?.(stream.interruptions![0]);
  const refused = loop.continueRunStream(stream.state!);
  await refused.completed;

  expect(calls).toBe(3);
});

it('settles a stopped budget interaction without dispatching another model request', async () => {
  let calls = 0;
  const loop = new ApplicationRunLoop({
    resolveModel: () => ({
      stream: async function* () {
        calls += 1;
        yield { type: 'tool_call' as const, id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' };
        yield { type: 'completion' as const, responseId: 'resp-1', output: [] };
      },
    }),
  });
  const stream = loop.startStream(agent, 'go', { runBudget: { ...policy, turnBackstop: 1 } });

  await stream.completed;
  expect(calls).toBe(1);

  stream.state!.reject?.(stream.interruptions![0]);
  const stopped = loop.continueRunStream(stream.state!);
  await stopped.completed;

  expect(calls).toBe(1);
});

it('contains a critical subagent budget with one final tool-free wrap-up call', async () => {
  let calls = 0;
  const requestedTools: Array<readonly unknown[]> = [];
  const model: StreamedModelTurn = {
    async *stream(request) {
      calls += 1;
      requestedTools.push(request.tools);
      yield {
        type: 'completion' as const,
        responseId: 'wrap',
        output: [{ type: 'message' as const, content: [{ type: 'text' as const, text: 'completed X; remains Y' }] }],
      };
    },
  };
  const loop = new ApplicationRunLoop({ resolveModel: () => model });
  const stream = loop.startStream(agent, 'go', {
    runBudget: { ...policy, turnBackstop: 0 },
    wrapUpOnCriticalRunBudget: true,
  });

  await stream.completed;

  expect(calls).toBe(1);
  expect(requestedTools).toEqual([[]]);
  expect(stream.finalOutput).toBe('completed X; remains Y');
});
