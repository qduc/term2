import { expect, it, vi } from 'vitest';
import { createRunAgentWorkflowToolDefinition } from './run-agent-workflow.js';

it('runs two concurrent child agents and returns both results in one tool response', async () => {
  let active = 0;
  let maximum = 0;
  const run = vi.fn(async (input: { task: string }) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { status: 'completed', output: `${input.task} result` };
  });
  const tool = createRunAgentWorkflowToolDefinition({
    runtime: { agent: () => ({ run }) } as any,
    parentTools: ['read_file'],
    limits: { maxConcurrency: 2, timeoutMs: 1_000 },
  });

  expect(Object.keys((tool.parameters as any).shape)).toEqual(['code']);
  const response = await tool.execute({
    code: "return await Promise.all(['security', 'tests'].map((task) => agent({ instructions: 'review', tools: ['read_file'] }).run({ task })));",
  });
  const result = JSON.parse(response);

  expect(maximum).toBe(2);
  expect(run).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    ok: true,
    output: [
      { ok: true, output: 'security result' },
      { ok: true, output: 'tests result' },
    ],
  });
});
