import { describe, it, expect } from 'vitest';
import { AgentRuntime } from './agent-runtime.js';
// Verify barrel exports are importable (compile-time check)
import {
  createAgentRuntime,
  createAgentRuntimeFromSubagentRuntime,
  ExecutionBudget,
  createRootBudget,
} from './index.js';
import type {
  AgentConfig,
  AgentHandle,
  RunInput,
  RunResult,
  RunError,
  RunAttachment,
  RunOutputFormat,
  ArtifactReference,
  ModelPolicy,
  AgentPermissions,
  AgentLimits,
  ToolReference,
  CreateAgentRuntimeDeps,
  ChildAcquireRejection,
  ResolvedAgentDefinition,
  ResolvedAgentPermissions,
} from './index.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import type { ExecutorInput, ExecutorFn } from './agent-handle.js';

function logger(): ILoggingService {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
  };
}

function settings(values: Record<string, unknown> = {}): ISettingsService {
  const store: Record<string, unknown> = {
    'agent.provider': 'openai',
    'agent.model': 'gpt-4o',
    ...values,
  };
  return {
    get: <T>(key: string) => store[key] as T,
    set: () => {},
  };
}

/** Returns a mock executor that captures the ExecutorInput and returns a canned result. */
function mockExecutor(result: RunResult = { status: 'completed', output: 'ok' }) {
  let captured: ExecutorInput | undefined;
  const fn: ExecutorFn = async (input: ExecutorInput) => {
    captured = input;
    return result as any;
  };
  return { executor: fn, getCaptured: () => captured };
}

/** Returns a mock executor that captures the budget. */
function mockExecutorWithBudget(result: RunResult = { status: 'completed', output: 'ok' }) {
  let capturedBudget: any = undefined;
  const fn: ExecutorFn = async (input: ExecutorInput) => {
    capturedBudget = input.budget;
    return result as any;
  };
  return { executor: fn, getBudget: () => capturedBudget };
}

describe('AgentRuntime', () => {
  // ── Compile-time barrel export verification ────────────────

  it('barrel exports are importable (compile-time type check)', () => {
    // This test primarily serves as a compile-time import verification.
    // If this file compiles, all barrel exports are reachable.
    // The runtime assertions guard against regressions that would
    // make exports undefined at runtime.
    expect(typeof createAgentRuntime).toBe('function');
    expect(typeof createAgentRuntimeFromSubagentRuntime).toBe('function');
    expect(typeof ExecutionBudget).toBe('function');
    expect(typeof createRootBudget).toBe('function');
    expect(typeof AgentRuntime).toBe('function');
  });

  it('creates an AgentHandle via agent()', () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'You are helpful.' });
    expect(handle).toBeDefined();
    expect(handle.name).toBe('agent');
  });

  it('AgentHandle has readonly properties reflecting resolution', () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'You are helpful.',
      name: 'test-agent',
      model: { provider: 'openai', model: 'gpt-4o-mini' },
      permissions: { tools: ['read_file'] },
      limits: { maxTurns: 5 },
    });

    expect(handle.name).toBe('test-agent');
    expect(handle.model).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    // Public permissions shape: tools list
    expect(handle.permissions.tools).toContain('read_file');
    expect(handle.permissions.filesystem).toBeDefined();
    expect(handle.limits.maxTurns).toBe(5);
  });

  it('AgentHandle.run() delegates to executor with resolved instructions', async () => {
    const { executor, getCaptured } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'You are helpful.' });
    const result = await handle.run({ task: 'do work' });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('ok');
    expect(getCaptured()).toBeDefined();
    expect(getCaptured()!.input.task).toBe('do work');
    expect(getCaptured()!.instructions).toContain('You are helpful.');
  });

  it('AgentHandle.run() composes instructions with explicit separate sections', async () => {
    const { executor, getCaptured } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'You are helpful.' });
    await handle.run({ task: 'do work', context: { project: 'my-app', version: 2 } });

    const instructions = getCaptured()!.instructions;
    expect(instructions).toContain('## Task');
    expect(instructions).toContain('do work');
    expect(instructions).toContain('## Instructions');
    expect(instructions).toContain('You are helpful.');
    expect(instructions).toContain('## Context');
    expect(instructions).toContain('"project"');
    expect(instructions).toContain('"my-app"');
    // Sections are separated by ---
    expect(instructions).toContain('---');
  });

  it('AgentHandle.run() serializes context deterministically with stable keys', async () => {
    const { executor, getCaptured } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    // Create keys in non-alphabetical order; serialization should sort them
    await handle.run({ task: 'test', context: { zebra: 1, alpha: 2 } });

    const instructions = getCaptured()!.instructions;
    const alphaIndex = instructions.indexOf('"alpha"');
    const zebraIndex = instructions.indexOf('"zebra"');
    expect(alphaIndex).toBeLessThan(zebraIndex);
  });

  it('AgentHandle.run() fails on circular context references', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const ctx: Record<string, unknown> = {};
    ctx.self = ctx;
    const result = await handle.run({ task: 'test', context: ctx });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('agent_error');
    expect(result.error?.message).toContain('circular references');
  });

  it('AgentHandle.run() rejects context with functions', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({ task: 'test', context: { fn: () => {} } });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('agent_error');
    expect(result.error?.message).toContain('functions');
  });

  it('AgentHandle.run() rejects context with symbols', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({ task: 'test', context: { sym: Symbol('test') } });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('agent_error');
    expect(result.error?.message).toContain('symbols');
  });

  it('AgentHandle.run() rejects context with bigints', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({ task: 'test', context: { big: BigInt(42) } });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('agent_error');
    expect(result.error?.message).toContain('bigints');
  });

  it('AgentHandle.run() supports structured output with output contract in instructions', async () => {
    const { executor, getCaptured } = mockExecutor({
      status: 'completed',
      output: '{"name":"test"}',
    });
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'You are helpful.' });
    const result = await handle.run({
      task: 'test',
      output: { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ name: 'test' });
    // Output contract is included in instructions
    expect(getCaptured()!.instructions).toContain('## Output Format');
    expect(getCaptured()!.instructions).toContain('```json');
    expect(getCaptured()!.instructions).toContain('"name"');
  });

  it('AgentHandle.run() parses structured output as typed value', async () => {
    const { executor } = mockExecutor({
      status: 'completed',
      output: '{"name":"Alice"}',
    });
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run<{ name: string }>({
      task: 'test',
      output: { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ name: 'Alice' });
  });

  it('AgentHandle.run() rejects invalid structured output (not JSON)', async () => {
    const { executor } = mockExecutor({
      status: 'completed',
      output: 'not json',
    });
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({
      task: 'test',
      output: { schema: { type: 'object' } },
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('invalid_output');
  });

  it('AgentHandle.run() rejects structured output with unsupported schema keywords', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({
      task: 'test',
      output: { schema: { type: 'string', pattern: '^test' } },
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('invalid_schema');
    expect(result.error?.message).toContain('pattern');
  });

  it('AgentHandle.run() validates and serializes attachments', async () => {
    const { executor, getCaptured } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({
      task: 'test',
      attachments: [{ name: 'readme.md', content: '# Hello', mimeType: 'text/markdown' }],
    });

    expect(result.status).toBe('completed');
    expect(getCaptured()!.instructions).toContain('## Attachments');
    expect(getCaptured()!.instructions).toContain('### Attachment 1: readme.md (text/markdown)');
    expect(getCaptured()!.instructions).toContain('# Hello');
  });

  it('AgentHandle.run() rejects binary attachment MIME types', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({
      task: 'test',
      attachments: [{ name: 'photo.png', content: '...', mimeType: 'image/png' }],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('invalid_attachment');
    expect(result.error?.message).toContain('image/png');
  });

  it('AgentHandle.run() rejects attachment with path separators in name', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({
      task: 'test',
      attachments: [{ name: '../etc/passwd', content: '...' }],
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('invalid_attachment');
    expect(result.error?.message).toContain('path separator');
  });

  it('nested agent permissions are attenuated by parent', () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
      parent: {
        permissions: { tools: ['read_file'] },
        limits: { maxTurns: 10 },
        modelPolicy: { provider: 'openai', model: 'gpt-4o' },
      },
    });

    const handle = runtime.agent({
      instructions: 'child',
      tools: ['read_file', 'search_replace'],
      permissions: { tools: ['read_file', 'search_replace'] },
      limits: { maxTurns: 100 },
    });

    // Child can read but cannot write (attenuated by parent)
    expect(handle.permissions.tools).toContain('read_file');
    // search_replace not in resolved tools because parent denied write
    expect(handle.permissions.tools).not.toContain('search_replace');
  });

  it('nested agent limits are clamped by parent', () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
      parent: {
        limits: { maxTurns: 10 },
      },
    });

    const handle = runtime.agent({
      instructions: 'child',
      limits: { maxTurns: 100 },
    });

    expect(handle.limits.maxTurns).toBe(10); // clamped
  });

  it('nested relative model policy resolves against parent', () => {
    const s = settings({
      'agent.efficientModel': 'gpt-4o-mini',
      'agent.provider': 'openai',
    });
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: s,
      logger: logger(),
      executor,
      parent: {
        modelPolicy: { provider: 'openai', model: 'gpt-4o' },
      },
    });

    const handle = runtime.agent({
      instructions: 'child',
      model: { tier: 'lower' },
    });

    expect(handle.model).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('refuses execution when there are resolution errors (unknown tool)', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      tools: ['read_file', 'nonexistent_tool'],
      permissions: { tools: ['read_file', 'nonexistent_tool'] },
    });

    const result = await handle.run({ task: 'test' });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('unknown_tool');
  });

  it('accepts valid filesystem scopes and resolves them', () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      permissions: {
        tools: ['read_file'],
        filesystem: { read: ['src/**'] },
      },
    });

    // Valid scopes should not cause errors
    expect(handle.permissions.filesystem).toBeDefined();
  });

  it('refuses execution for unsupported permission scopes (allowedModels)', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      permissions: {
        agents: { allowedModels: [{ provider: 'openai', model: 'gpt-4o' }] },
      },
    });

    const result = await handle.run({ task: 'test' });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('unsupported_permission_scope');
  });

  it('public RunResult uses ArtifactReference[] not strings', async () => {
    const { executor } = mockExecutor({
      status: 'completed',
      output: 'final answer',
      artifacts: [{ path: 'src/file.ts' }, { url: 'https://example.com/out.html' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({ task: 'test' });

    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts![0]).toHaveProperty('path', 'src/file.ts');
    expect(result.artifacts![1]).toHaveProperty('url', 'https://example.com/out.html');
  });

  it('public RunResult does not expose internal fields', async () => {
    const { executor } = mockExecutor({
      status: 'completed',
      output: 'final answer',
      artifacts: [{ path: 'src/file.ts' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({ task: 'test' });

    // Should NOT have internal fields
    expect((result as any).finalText).toBeUndefined();
    expect((result as any).nestedRunResult).toBeUndefined();
    expect((result as any).toolsUsed).toBeUndefined();
    expect((result as any).filesChanged).toBeUndefined();
    expect((result as any).transcript).toBeUndefined();
  });

  it('RunResult supports typed error for failed runs', async () => {
    const { executor } = mockExecutor({
      status: 'failed',
      output: '',
      error: { code: 'provider_error', message: 'API error' },
    });

    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({ task: 'test' });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('provider_error');
    expect(result.error?.message).toBe('API error');
  });

  it('RunResult supports cancelled status', async () => {
    const { executor } = mockExecutor({
      status: 'cancelled',
      output: '',
      error: { code: 'cancelled', message: 'Aborted.' },
    });

    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    const result = await handle.run({ task: 'test' });

    expect(result.status).toBe('cancelled');
    expect(result.error?.code).toBe('cancelled');
  });

  it('limits include expanded fields with conservative defaults', () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });

    expect(handle.limits.maxTurns).toBe(20);
    expect(handle.limits.maxTokens).toBeUndefined();
    expect(handle.limits.timeoutMs).toBeUndefined();
  });

  it('explicit limits propagate correctly', () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      limits: {
        maxTurns: 5,
        timeoutMs: 30_000,
        maxDepth: 3,
        maxConcurrency: 2,
      },
    });

    expect(handle.limits.maxTurns).toBe(5);
    expect(handle.limits.timeoutMs).toBe(30_000);
    expect(handle.limits.maxDepth).toBe(3);
    expect(handle.limits.maxConcurrency).toBe(2);
  });

  it('maxCost produces fatal limit_validation_error before any execution', async () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      limits: { maxCost: 5 },
    });

    const result = await handle.run({ task: 'test' });
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('limit_validation_error');
    expect(result.error?.message).toContain('maxCost');
  });

  it('AgentHandle.run() creates and passes a root ExecutionBudget', async () => {
    const { executor, getBudget } = mockExecutorWithBudget();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      limits: { maxChildren: 3, maxDepth: 2, maxConcurrency: 2, maxTokens: 50000 },
    });

    await handle.run({ task: 'test' });
    const budget = getBudget();
    expect(budget).toBeDefined();
    expect(budget.maxChildren).toBe(3);
    expect(budget.maxDepth).toBe(2);
    expect(budget.maxConcurrency).toBe(2);
    expect(budget.maxTokens).toBe(50000);
    expect(budget.currentDepth).toBe(0);
  });

  it('AgentHandle.run() creates budget with no limits when none specified', async () => {
    const { executor, getBudget } = mockExecutorWithBudget();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({ instructions: 'test' });
    await handle.run({ task: 'test' });
    const budget = getBudget();
    expect(budget).toBeDefined();
    expect(budget.maxChildren).toBeUndefined();
    expect(budget.maxTokens).toBeUndefined();
  });

  it('child limits are clamped to parent on every field', () => {
    const { executor } = mockExecutor();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
      parent: {
        limits: {
          maxTurns: 10,
          maxTokens: 50_000,
          timeoutMs: 30_000,
          maxChildren: 3,
          maxDepth: 2,
          maxConcurrency: 2,
        },
      },
    });

    const handle = runtime.agent({
      instructions: 'child',
      limits: {
        maxTurns: 100,
        maxTokens: 200_000,
        timeoutMs: 120_000,
        maxChildren: 10,
        maxDepth: 5,
        maxConcurrency: 5,
      },
    });

    expect(handle.limits.maxTurns).toBe(10);
    expect(handle.limits.maxTokens).toBe(50_000);
    expect(handle.limits.timeoutMs).toBe(30_000);
    expect(handle.limits.maxChildren).toBe(3);
    expect(handle.limits.maxDepth).toBe(2);
    expect(handle.limits.maxConcurrency).toBe(2);
  });

  // ── Root vs child budget semantics ─────────────────────────

  it('root run with maxChildren 0 succeeds (root does not consume a child slot)', async () => {
    const { executor, getBudget } = mockExecutorWithBudget();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      limits: { maxChildren: 0 },
    });

    const result = await handle.run({ task: 'test' });
    expect(result.status).toBe('completed');
    expect(getBudget()!.maxChildren).toBe(0);
    expect(getBudget()!.childCount).toBe(0);
  });

  it('root run with maxConcurrency 0 succeeds', async () => {
    const { executor, getBudget } = mockExecutorWithBudget();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      limits: { maxConcurrency: 0 },
    });

    const result = await handle.run({ task: 'test' });
    expect(result.status).toBe('completed');
  });

  it('root run with maxDepth 0 succeeds (root depth is 0)', async () => {
    const { executor, getBudget } = mockExecutorWithBudget();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      limits: { maxDepth: 0 },
    });

    const result = await handle.run({ task: 'test' });
    expect(result.status).toBe('completed');
    expect(getBudget()!.maxDepth).toBe(0);
    expect(getBudget()!.currentDepth).toBe(0);
  });

  it('root run passes budget to executor for child tracking', async () => {
    const { executor, getBudget } = mockExecutorWithBudget();
    const runtime = new AgentRuntime({
      settings: settings(),
      logger: logger(),
      executor,
    });

    const handle = runtime.agent({
      instructions: 'test',
      limits: { maxChildren: 5, maxDepth: 3, maxConcurrency: 2 },
    });

    await handle.run({ task: 'test' });
    const budget = getBudget();
    expect(budget!.maxChildren).toBe(5);
    expect(budget!.maxDepth).toBe(3);
    expect(budget!.maxConcurrency).toBe(2);
    // Root does not consume a child slot
    expect(budget!.childCount).toBe(0);
  });
});
