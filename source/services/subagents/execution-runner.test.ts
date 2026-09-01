import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stream = vi.hoisted(() => ({ events: [] as any[] }));

vi.mock('../session/session-composition.js', () => ({
  createSessionRuntime: () => ({
    turns: {
      start: async function* () {
        yield* stream.events;
      },
    },
    state: {
      exportState: () => ({ history: [] }),
      importState: () => {},
    },
    dispose: () => {},
  }),
}));

import { ExecutionSubagentRunner } from './execution-runner.js';
import {
  createMockLogger,
  createMockSettings,
  createSessionContextService,
} from './test-helpers/subagent-manager-fixtures.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';

const committedEvents = (events: any[]) =>
  events.filter((e) => e.type !== 'subagent_streaming_text' && e.type !== 'subagent_streaming_tool');

const definition = {
  role: 'explorer',
  name: 'explorer',
  instructions: 'Inspect the workspace.',
  canRead: true,
  canWrite: false,
  canSearchWeb: false,
  canRunShell: false,
  maxTurns: 5,
  model: 'test-model',
  provider: 'test-provider',
  reasoningEffort: 'default',
};

const makeRunner = (events: any[]) => {
  stream.events = events;
  const received: any[] = [];
  const clients: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const runner = new ExecutionSubagentRunner({
    logger: createMockLogger(),
    settings: createMockSettings(),
    sessionContextService: createSessionContextService(),
    createClient: () => {
      const client = { dispose: vi.fn() };
      clients.push(client);
      return client as any;
    },
    toolFactory: {
      buildToolDefinitions: () => [],
      buildAgentTools: () => [],
    } as any,
    onEvent: (event) => {
      received.push(event);
    },
    toolOwnership: new ToolOwnershipRegistry(),
  });
  return { runner, received, clients };
};

beforeEach(() => {
  stream.events = [];
});

describe('ExecutionSubagentRunner text-turn peek events', () => {
  it('caps streamed text and emits separate turns before a tool and at finalization', async () => {
    const { runner, received } = makeRunner([
      { type: 'text_delta', delta: 'a'.repeat(201) },
      { type: 'tool_started', toolCallId: 'call-1', toolName: 'grep', arguments: {} },
      { type: 'text_delta', delta: 'After the tool.' },
      { type: 'final', finalText: 'Done.' },
    ]);

    await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(committedEvents(received)).toEqual([
      {
        type: 'subagent_text_turn',
        agentId: 'run-1',
        role: 'explorer',
        text: 'a'.repeat(200),
      },
      expect.objectContaining({ type: 'subagent_tool_started', toolName: 'grep' }),
      {
        type: 'subagent_text_turn',
        agentId: 'run-1',
        role: 'explorer',
        text: 'After the tool.',
      },
    ]);
  });

  it('discards partial text when a model retry starts a fresh turn', async () => {
    const { runner, received } = makeRunner([
      { type: 'text_delta', delta: 'Discard this partial response.' },
      { type: 'retry', toolName: 'model', attempt: 1, maxRetries: 2, errorMessage: 'retrying' },
      { type: 'text_delta', delta: 'Keep this retry response.' },
      { type: 'final', finalText: 'Done.' },
    ]);

    await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(committedEvents(received)).toContainEqual({
      type: 'retry',
      agentId: 'run-1',
      toolName: 'model',
      attempt: 1,
      maxRetries: 2,
      errorMessage: 'retrying',
    });
    expect(committedEvents(received)).toContainEqual({
      type: 'subagent_text_turn',
      agentId: 'run-1',
      role: 'explorer',
      text: 'Keep this retry response.',
    });
    const committed = committedEvents(received);
    expect(committed).not.toContainEqual(expect.objectContaining({ text: 'Discard this partial response.' }));
  });

  it('does not expose partial text when the stream errors', async () => {
    const { runner, received } = makeRunner([
      { type: 'text_delta', delta: 'Do not expose this partial response.' },
      { type: 'error', message: 'provider failed' },
    ]);

    await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(committedEvents(received)).not.toContainEqual(expect.objectContaining({ type: 'subagent_text_turn' }));
  });

  it('emits bounded tool-argument progress without forwarding argument content', async () => {
    const { runner, received } = makeRunner([
      { type: 'tool_call_streaming_delta', toolName: 'apply_patch', argumentCharCount: 1 },
      { type: 'tool_call_streaming_delta', toolName: 'apply_patch', argumentCharCount: 500 },
      { type: 'tool_call_streaming_delta', toolName: 'apply_patch', argumentCharCount: 1_025 },
      { type: 'tool_call_streaming_delta', toolName: 'apply_patch', argumentCharCount: 2_049 },
      { type: 'final', finalText: 'Done.' },
    ]);

    await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(received.filter((event) => event.type === 'subagent_streaming_tool')).toEqual([
      { type: 'subagent_streaming_tool', agentId: 'run-1', toolName: 'apply_patch', argumentCharCount: 1 },
      { type: 'subagent_streaming_tool', agentId: 'run-1', toolName: 'apply_patch', argumentCharCount: 1_025 },
      { type: 'subagent_streaming_tool', agentId: 'run-1', toolName: 'apply_patch', argumentCharCount: 2_049 },
    ]);
    expect(JSON.stringify(received)).not.toContain('operations');
  });

  it('settles a turn-budget stop as interrupted with partial work, not completed', async () => {
    const warn = vi.fn();
    stream.events = [
      { type: 'tool_started', toolCallId: 'call-1', toolName: 'grep', arguments: {} },
      { type: 'text_delta', delta: 'Found candidate files under source/.' },
      { type: 'error', message: 'Max turns (5) exceeded' },
    ];
    const received: any[] = [];
    const runner = new ExecutionSubagentRunner({
      logger: { ...createMockLogger(), warn },
      settings: createMockSettings(),
      sessionContextService: createSessionContextService(),
      createClient: () => ({ dispose: vi.fn() } as any),
      toolFactory: {
        buildToolDefinitions: () => [],
        buildAgentTools: () => [],
      } as any,
      onEvent: (event) => {
        received.push(event);
      },
      toolOwnership: new ToolOwnershipRegistry(),
    });

    // Simulate tool bookkeeping that the real tool path would have recorded.
    const result = await runner.run('run-budget', { role: 'explorer', task: 'inspect' }, definition);

    expect(result.status).toBe('interrupted');
    expect(result.terminalCause).toBe('budget_exhausted');
    expect(result.error).toBeUndefined();
    expect(result.finalText).toContain('Turn budget exhausted (5)');
    expect(result.finalText).toContain('Found candidate files under source/.');
    expect(result.finalText).toContain('budget stop, not a task failure');
    expect(warn).toHaveBeenCalledWith(
      'Subagent turn budget exhausted',
      expect.objectContaining({ agentId: 'run-budget', role: 'explorer', maxTurns: 5 }),
    );
  });

  it('saves the complete final result when its display preview is truncated', async () => {
    const fullText = `${'a'.repeat(40_000)}FULL-RESULT-SENTINEL${'b'.repeat(100)}`;
    const { runner } = makeRunner([{ type: 'final', finalText: fullText }]);

    const result = await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    try {
      expect(result.finalTextTruncated).toBe(true);
      expect(result.finalTextArtifactPath).toBeTruthy();
      expect(result.finalText).not.toContain('FULL-RESULT-SENTINEL');
      expect(result.finalText).toContain('Full subagent result saved to');
      expect(fs.readFileSync(result.finalTextArtifactPath!, 'utf8')).toBe(fullText);
    } finally {
      if (result.finalTextArtifactPath && fs.existsSync(result.finalTextArtifactPath)) {
        fs.unlinkSync(result.finalTextArtifactPath);
      }
    }
  });

  it('keeps results slightly larger than the previous 4,000-character limit intact', async () => {
    const fullText = 'a'.repeat(4_001);
    const { runner } = makeRunner([{ type: 'final', finalText: fullText }]);

    const result = await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(result.finalText).toBe(fullText);
    expect(result.finalTextTruncated).toBeUndefined();
    expect(result.finalTextArtifactPath).toBeUndefined();
  });

  it('disposes its transient client after transferring session state', async () => {
    const { runner, clients } = makeRunner([{ type: 'final', finalText: 'Done.' }]);

    await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(clients[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('forwards usage updates with the owning subagent id', async () => {
    const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
    const { runner, received } = makeRunner([
      { type: 'usage_update', usage },
      { type: 'final', finalText: 'Done.', usage },
    ]);

    await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(received).toContainEqual({ type: 'usage_update', agentId: 'run-1', usage });
  });

  it('forwards final usage when the stream has no separate usage update', async () => {
    const usage = { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 };
    const { runner, received } = makeRunner([{ type: 'final', finalText: 'Done.', usage }]);

    await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(received).toContainEqual({ type: 'usage_update', agentId: 'run-1', usage });
  });
});
