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

const committedEvents = (events: any[]) => events.filter((e) => e.type !== 'subagent_streaming_text');

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
  const runner = new ExecutionSubagentRunner({
    logger: createMockLogger(),
    settings: createMockSettings(),
    sessionContextService: createSessionContextService(),
    createClient: () => ({} as any),
    toolFactory: {
      buildToolDefinitions: () => [],
      buildAgentTools: () => [],
    } as any,
    onEvent: (event) => received.push(event),
    toolOwnership: new ToolOwnershipRegistry(),
  });
  return { runner, received };
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

  it('saves the complete final result when its display preview is truncated', async () => {
    const fullText = `${'a'.repeat(40_000)}FULL-RESULT-SENTINEL${'b'.repeat(100)}`;
    const { runner } = makeRunner([{ type: 'final', finalText: fullText }]);

    const result = await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(result.finalTextTruncated).toBe(true);
    expect(result.finalTextArtifactPath).toBeTruthy();
    expect(result.finalText).not.toContain('FULL-RESULT-SENTINEL');
    expect(result.finalText).toContain('Full subagent result saved to');
    expect(fs.readFileSync(result.finalTextArtifactPath!, 'utf8')).toBe(fullText);
  });

  it('keeps results slightly larger than the previous 4,000-character limit intact', async () => {
    const fullText = 'a'.repeat(4_001);
    const { runner } = makeRunner([{ type: 'final', finalText: fullText }]);

    const result = await runner.run('run-1', { role: 'explorer', task: 'inspect' }, definition);

    expect(result.finalText).toBe(fullText);
    expect(result.finalTextTruncated).toBeUndefined();
    expect(result.finalTextArtifactPath).toBeUndefined();
  });
});
