import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DefaultRetryClassifier } from '../retry/retry-classifier.js';
import { ApplicationRunLoop } from './application-run-loop.js';
import { wrapCodexStream } from '../../providers/codex-responses-model.js';
import { createStreamAccumulator, processStreamEvents } from '../stream-event-processor.js';
import { createConversationEventHandler } from '../../utils/conversation/conversation-event-handler.js';

/** Run a local fake Codex stream through the actual loop, stream processor and interactive delta consumer. */
async function exercise(first: 'initial' | 'late' | 'tool' | 'tool-success', retries = 1) {
  const requests: { anchor: unknown; input: unknown }[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'term2-retry-effects-'));
  const effectPath = join(dir, 'effects');
  await writeFile(effectPath, '');
  try {
    const model = {
      async *stream(request: any): AsyncGenerator<any> {
        requests.push({ anchor: request.previousResponseId, input: structuredClone(request.input) });
        if (requests.length === 1 && first === 'tool-success') {
          const call = { type: 'tool_call', id: 'pending-call', name: 'probe', arguments: '{}' };
          yield call;
          yield { type: 'completion', responseId: 'intermediate', output: [call] };
        } else if (requests.length === 1) {
          async function* frames() {
            if (first !== 'initial') yield { type: 'response.output_text.delta', delta: 'partial' };
            yield {
              type: 'response.error',
              error: { code: 'rate_limit_exceeded', message: 'rate limit please try again in 1ms' },
            };
          }
          for await (const event of wrapCodexStream(frames())) {
            if (event.type === 'response.output_text.delta') {
              if (first === 'late') yield { type: 'text_delta', text: event.delta };
              if (first === 'tool') yield { type: 'tool_call', id: 'pending-call', name: 'probe', arguments: '{}' };
            }
          }
        } else {
          yield { type: 'text_delta', text: 'final' };
          yield {
            type: 'completion',
            responseId: 'next',
            output: [{ type: 'message', content: [{ type: 'text', text: 'final' }] }],
          };
        }
      },
    };
    const loop = new ApplicationRunLoop({ resolveModel: () => model, waitBeforeModelRetry: async () => {} });
    const stream = loop.startStream(
      {
        name: 'fixture',
        model: 'fixture',
        instructions: '',
        modelSettings: { retry: { maxRetries: retries } },
        tools: [
          {
            name: 'probe',
            description: 'fixture',
            parameters: z.object({}),
            needsApproval: async () => false,
            execute: async () => {
              await appendFile(effectPath, 'effect\n');
              return 'done';
            },
          },
        ],
      } as any,
      'hello',
      { providerId: 'codex', supportsConversationChaining: true, previousResponseId: 'anchor' },
    );
    const state: any = {
      accumulatedText: '',
      accumulatedReasoningText: '',
      flushedTextLength: 0,
      flushedReasoningLength: 0,
      textWasFlushed: false,
      currentReasoningMessageId: null,
    };
    const handler = createConversationEventHandler(
      {
        state,
        botResponseUpdater: { push() {}, append() {}, flush() {}, cancel() {} },
        reasoningUpdater: { append() {}, flush() {}, cancel() {} },
        setMessages() {},
        appendMessages() {},
        pendingToolsRef: { current: new Map() },
        idGenerator: () => 'fixture',
        disableReasoningInterpolation: true,
      } as any,
      state,
    );
    const acc = createStreamAccumulator();
    const text: string[] = [];
    let error: unknown;
    const completed = stream.completed.catch((err) => {
      error = err;
    });
    try {
      for await (const event of processStreamEvents(
        stream,
        acc,
        { toolCallArgumentsById: new Map(), emittedInvalidToolCallPackets: new Set(), preserveExistingToolArgs: false },
        {
          logger: {
            warn() {},
            error() {},
            debug() {},
            info() {},
            getCorrelationId() {
              return 'fixture';
            },
          } as any,
          sessionId: 'fixture',
        },
      )) {
        if (event.type === 'text_delta') {
          text.push(event.delta);
          handler(event);
        }
      }
    } catch (err) {
      error = err;
    }
    await completed;
    const effects = (await readFile(effectPath, 'utf8')).split('\n').filter(Boolean).length;
    return { requests, effects, text, visible: state.accumulatedText, final: acc.finalOutput, error, stream };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('chained rate limit retry boundary', () => {
  it('retries a pre-output rate limit with the identical anchor and input', async () => {
    const result = await exercise('initial');
    expect(result.error).toBeUndefined();
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0]).toEqual(result.requests[1]);
    expect(result.requests[0]?.anchor).toBe('anchor');
    expect(result.visible).toBe('final');
  });
  it.each(['late', 'tool'] as const)('does not resend after %s model output', async (kind) => {
    const result = await exercise(kind);
    expect(result.requests).toHaveLength(1);
    expect(result.error).toMatchObject({ name: 'AmbiguousModelOutcomeError' });
    expect(result.effects).toBe(0);
    expect(result.visible).toBe(kind === 'late' ? 'partial' : '');
  });
  it('keeps a late buffered tool error ambiguous even when in-loop retry is disabled', async () => {
    const result = await exercise('tool', 0);
    expect(result.requests).toHaveLength(1);
    expect(result.error).toMatchObject({ name: 'AmbiguousModelOutcomeError' });
    expect(result.effects).toBe(0);
    const classifier = new DefaultRetryClassifier({} as any);
    expect(
      classifier.classify({
        error: result.error,
        stream: result.stream,
        retryCounts: {
          transientRetryCount: 0,
          serviceTierFallbackCount: 0,
          modelRetryCount: 0,
          transportDowngradeCount: 0,
        },
        maxTransientRetries: 2,
        maxModelRetries: 0,
      }),
    ).toEqual({ kind: 'unrecoverable' });
  });
  it('dispatches the same tool once when the provider actually completes its call', async () => {
    const result = await exercise('tool-success');
    expect(result.error).toBeUndefined();
    expect(result.effects).toBe(1);
    expect(result.requests).toHaveLength(2);
  });
});
