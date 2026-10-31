import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApplicationRunLoop } from './application-run-loop.js';
import { RetryingModel } from '../../providers/retrying-model.js';
import { wrapCodexStream } from '../../providers/codex-responses-model.js';
import { RetryRecoveryBudget, RetryRecoveryBudgetExhaustedError } from '../retry/retry-recovery-budget.js';
import { DefaultRetryClassifier } from '../retry/retry-classifier.js';

/** Fake time and provider frames, with physical requests recorded in a disposable file. */
async function exercise(options: {
  delays: number[];
  providerRetries?: number;
  budget?: boolean;
  maxMs?: number;
  maxAttempts?: number;
  loopExtraMs?: number;
  preparationExtraMs?: number;
  chained?: boolean;
  abort?: boolean;
}) {
  const dir = await mkdtemp(join(tmpdir(), 'term2-retry-budget-'));
  const path = join(dir, 'requests');
  await writeFile(path, '');
  try {
    let now = 0;
    let dispatches = 0;
    const waits: { owner: string; ms: number }[] = [];
    const budget =
      options.budget === false
        ? undefined
        : new RetryRecoveryBudget({
            now: () => now,
            ...(options.maxMs !== undefined ? { maxRecoveryTimeMs: options.maxMs } : {}),
            ...(options.maxAttempts !== undefined ? { maxPhysicalAttempts: options.maxAttempts } : {}),
          });
    const raw = {
      async *stream(request: any): AsyncGenerator<any> {
        dispatches++;
        await appendFile(
          path,
          `${JSON.stringify({
            at: now,
            anchor: request.previousResponseId,
            attempts: budget?.physicalAttempts,
            deadlineExceeded: budget?.deadlineExceeded,
          })}\n`,
        );
        if (dispatches <= options.delays.length) {
          const delay = options.delays[dispatches - 1];
          async function* frames() {
            yield {
              type: 'response.error',
              error: { code: 'rate_limit_exceeded', message: `rate limit please try again in ${delay}ms` },
            };
          }
          for await (const frame of wrapCodexStream(frames())) yield frame;
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
    const controller = new AbortController();
    const model = new RetryingModel(raw as any, {
      retryAttempts: options.providerRetries ?? 0,
      sleep: async (ms) => {
        waits.push({ owner: 'provider', ms });
        now += ms;
      },
    });
    const loop = new ApplicationRunLoop({
      resolveModel: () => model,
      waitBeforeModelRetry: async (ms) => {
        waits.push({ owner: 'loop', ms });
        if (options.abort) {
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        now += ms + (options.loopExtraMs ?? 0);
      },
    });
    const stream = loop.startStream(
      { name: 'fixture', model: 'fixture', instructions: '', modelSettings: { retry: { maxRetries: 2 } }, tools: [] },
      'hello',
      {
        providerId: 'codex',
        supportsConversationChaining: options.chained !== false,
        ...(options.chained === false ? {} : { previousResponseId: 'anchor' }),
        requestPreparation: {
          prepare: () => {},
          run: async (operation) => {
            if (dispatches > 0) now += options.preparationExtraMs ?? 0;
            return operation();
          },
        },
        recoveryBudget: budget,
        signal: controller.signal,
      },
    );
    let error: unknown;
    const completed = stream.completed.catch((err) => {
      error = err;
    });
    try {
      for await (const _event of stream) {
        /* drain */
      }
    } catch (err) {
      error = err;
    }
    await completed;
    const requests = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { requests, waits, error, stream, budget };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('same-chain retry shares the recovery envelope', () => {
  it('refuses the 60s wait when only 30s remain after a provider retry', async () => {
    const r = await exercise({ delays: [60_000, 60_000], providerRetries: 2 });
    expect(r.requests.map((x) => x.at)).toEqual([0, 60_000]);
    expect(r.requests.map((x) => x.anchor)).toEqual(['anchor', 'anchor']);
    expect(r.waits).toEqual([{ owner: 'provider', ms: 60_000 }]);
    expect(r.error).toBeInstanceOf(RetryRecoveryBudgetExhaustedError);
    expect(
      new DefaultRetryClassifier({} as any).classify({
        error: r.error,
        stream: r.stream,
        retryCounts: {
          transientRetryCount: 0,
          serviceTierFallbackCount: 0,
          modelRetryCount: 0,
          transportDowngradeCount: 0,
        },
        maxTransientRetries: 2,
      }),
    ).toEqual({ kind: 'unrecoverable' });
  });
  it('claims and dispatches an admitted anchored retry', async () => {
    const r = await exercise({ delays: [10_000] });
    expect(r.error).toBeUndefined();
    expect(r.requests).toMatchObject([
      { at: 0, anchor: 'anchor', attempts: 0 },
      { at: 10_000, anchor: 'anchor', attempts: 1, deadlineExceeded: false },
    ]);
    expect(r.waits).toEqual([{ owner: 'loop', ms: 10_000 }]);
  });
  it('claims each repeated loop dispatch and stops when claims run out', async () => {
    const admitted = await exercise({ delays: [100, 100] });
    expect(admitted.error).toBeUndefined();
    expect(admitted.requests.map((x) => x.attempts)).toEqual([0, 1, 2]);
    const exhausted = await exercise({ delays: [100, 100], maxAttempts: 1 });
    expect(exhausted.requests.map((x) => x.attempts)).toEqual([0, 1]);
    expect(exhausted.waits).toEqual([{ owner: 'loop', ms: 100 }]);
    expect(exhausted.error).toBeInstanceOf(RetryRecoveryBudgetExhaustedError);
  });
  it('does not wait when the delay reaches the deadline or dispatch claims are exhausted', async () => {
    for (const options of [
      { delays: [1000], maxMs: 1000 },
      { delays: [100], maxAttempts: 0 },
    ]) {
      const r = await exercise(options);
      expect(r.requests).toHaveLength(1);
      expect(r.waits).toEqual([]);
      expect(r.error).toBeInstanceOf(RetryRecoveryBudgetExhaustedError);
    }
  });
  it('does not dispatch if a wait overshoots the deadline', async () => {
    const r = await exercise({ delays: [500], maxMs: 1000, loopExtraMs: 500 });
    expect(r.requests).toHaveLength(1);
    expect(r.waits).toEqual([{ owner: 'loop', ms: 500 }]);
    expect(r.error).toBeInstanceOf(RetryRecoveryBudgetExhaustedError);
  });
  it('checks the deadline again after asynchronous request preparation', async () => {
    const r = await exercise({ delays: [500], maxMs: 1000, preparationExtraMs: 500 });
    expect(r.requests).toHaveLength(1);
    expect(r.error).toBeInstanceOf(RetryRecoveryBudgetExhaustedError);
  });
  it('does not apply the new admission to existing unchained loop recovery', async () => {
    const r = await exercise({ delays: [100], maxAttempts: 0, chained: false });
    expect(r.error).toBeUndefined();
    expect(r.requests).toHaveLength(2);
    expect(r.requests.map((x) => x.attempts)).toEqual([0, 0]);
  });
  it('preserves abort and budget-less retry', async () => {
    const aborted = await exercise({ delays: [100], abort: true });
    expect(aborted.requests).toHaveLength(1);
    expect(aborted.error).toMatchObject({ name: 'AbortError' });
    const unbudgeted = await exercise({ delays: [100], budget: false });
    expect(unbudgeted.error).toBeUndefined();
    expect(unbudgeted.requests).toHaveLength(2);
    expect(unbudgeted.requests.map((x) => x.anchor)).toEqual(['anchor', 'anchor']);
  });
});
