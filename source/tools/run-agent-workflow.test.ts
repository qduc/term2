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
  const result = JSON.parse(response as string);

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

it('enforces the maxRuns guard at the run_agent_workflow tool boundary', async () => {
  const run = vi.fn(async () => ({ status: 'completed', output: 'first result' }));
  const tool = createRunAgentWorkflowToolDefinition({
    runtime: { agent: () => ({ run }) } as any,
    parentTools: [],
    limits: { maxRuns: 1 },
  });

  const response = await tool.execute({
    code: "const child = agent({ instructions: 'review' }); await child.run({ task: 'first' }); return child.run({ task: 'second' });",
  });

  expect(JSON.parse(response as string)).toMatchObject({
    ok: false,
    error: { code: 'limit_exceeded' },
  });
  expect(run).toHaveBeenCalledTimes(1);
});

it('documents the complete workflow contract while retaining code-only parameters', () => {
  const tool = createRunAgentWorkflowToolDefinition({ runtime: {} as any, parentTools: [] });
  expect(Object.keys((tool.parameters as any).shape)).toEqual(['code']);
  expect(tool.description).toContain("model? ('lower', 'default', or 'higher')");
  expect(tool.description).toContain('Promise.all()');
  expect(tool.description).toContain('web_search and web_fetch require the exact matching parent capability');
  expect(tool.description).toContain('Interactive approvals');
  expect(tool.description).toContain('runId');
});
