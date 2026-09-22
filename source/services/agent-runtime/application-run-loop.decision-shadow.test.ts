import { describe, expect, it, vi } from 'vitest';
import type { StreamedModelTurn } from '../../contracts/streamed-model-turn.js';
import type { DecisionShadowObserver } from '../decision-shadow/decision-shadow-observer.js';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';

const baseAgent: ApplicationAgent = { name: 'root', instructions: 'help', model: 'model-a', tools: [] };

describe('ApplicationRunLoop decision-shadow observations', () => {
  it('isolates observer exceptions from successful runtime behavior', async () => {
    const observer: DecisionShadowObserver = {
      observeTerminalFailure: () => {
        throw new Error('observer failed');
      },
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield {
            type: 'completion',
            responseId: 'resp',
            output: [{ type: 'message', content: [{ type: 'text', text: 'unchanged' }] }],
          };
        },
      }),
      decisionShadowObserver: observer,
    });

    const stream = loop.startStream(baseAgent, 'hello', { providerId: 'openrouter' });
    await expect(stream.completed).resolves.toBeDefined();
    expect(stream.finalOutput).toBe('unchanged');
  });

  it('reports terminal failure evidence separately from classifier comparison labels', async () => {
    const observer: DecisionShadowObserver = {
      observeTerminalFailure: vi.fn(),
    };
    const failure = Object.assign(new Error('rate limited'), {
      status: 429,
      code: 'rate_limit',
      retryAfterMs: 1500,
    });
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield (() => {
            throw failure;
          })();
        },
      }),
      decisionShadowObserver: observer,
    });
    const stream = loop.startStream(baseAgent, 'hello', { providerId: 'openrouter' });
    await expect(stream.completed).rejects.toThrow('rate limited');

    const terminal = vi.mocked(observer.observeTerminalFailure).mock.calls[0]![0];
    expect(terminal.evidence).toMatchObject({ status: 429, code: 'rate_limit', message: 'rate limited' });
    expect(terminal.evidence).not.toHaveProperty('retryable');
    expect(terminal.evidence).not.toHaveProperty('errorKind');
    expect(terminal.comparison).toMatchObject({ errorKind: 'rate_limit', retryable: true });
  });

  it('does no optional failure classification when disabled and contains hostile evidence when enabled', async () => {
    let statusReads = 0;
    const hostile = new Error('original provider failure');
    Object.defineProperty(hostile, 'status', {
      get: () => {
        statusReads++;
        throw new Error('hostile status getter');
      },
    });
    const model: StreamedModelTurn = {
      async *stream() {
        yield (() => {
          throw hostile;
        })();
      },
    };

    const disabled = new ApplicationRunLoop({ resolveModel: () => model });
    await expect(disabled.startStream(baseAgent, 'hello').completed).rejects.toBe(hostile);
    expect(statusReads).toBe(0);

    const observer: DecisionShadowObserver = {
      observeTerminalFailure: vi.fn(),
    };
    const enabled = new ApplicationRunLoop({ resolveModel: () => model, decisionShadowObserver: observer });
    await expect(enabled.startStream(baseAgent, 'hello').completed).rejects.toBe(hostile);
    expect(statusReads).toBe(1);
    expect(observer.observeTerminalFailure).not.toHaveBeenCalled();
  });
});
