import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { z } from 'zod';
import { AgentClient } from './agent-client.js';
import { SettingsService } from '../services/settings/settings-service.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import { ToolApprovalPolicyRegistry } from '../services/approval/tool-approval-policy-registry.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import { ConversationService } from '../services/conversation/conversation-service.js';
import { createProviderRegistry, upsertProvider } from '../providers/registry.js';
import { CodexResponsesTransport, CodexResponsesWSModel } from '../providers/codex-responses-model.js';
import { RetryingModel } from '../providers/retrying-model.js';
import { recordWebSocketDispatch } from '../providers/websocket-request-dispatch.js';
import { WebSocketClosedEarlyError } from '../providers/websocket-close-evidence.js';
import { raceWebSocketAbort } from '../providers/websocket-abort-race.js';
import { AmbiguousModelOutcomeError } from '../services/retry/retry-errors.js';

type Step = 'tool' | 'close' | 'timeout' | 'frame-timeout' | 'ambiguous' | 'unsent' | 'success';

// Only the external transport is synthetic. Every timeout is constructed by
// the real adapter watchdog, and effects cross a real disposable filesystem.
async function harness(
  steps: Step[],
  limit = 2,
  cancelOnWait = false,
  inLoopLimit = limit,
  overheadMs = 0,
  approval = false,
) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-frame-recovery-'));
  const file = path.join(dir, 'effects.txt');
  const requests: any[] = [],
    failures: any[] = [],
    logs: any[] = [],
    events: any[] = [];
  const context = new SessionContextService();
  class Transport extends CodexResponsesTransport {
    override async fetchResponse(request: any, _stream: boolean, wire: any): Promise<AsyncIterable<any>> {
      const step = steps[Math.min(requests.length, steps.length - 1)];
      if (step === 'timeout' && requests.length > 0 && overheadMs > 0)
        await new Promise((resolve) => setTimeout(resolve, overheadMs));
      requests.push({
        input: structuredClone(request.input),
        previousResponseId: request.previousResponseId,
        wire: structuredClone(wire),
      });
      recordWebSocketDispatch(request, step === 'unsent' ? 'unsent' : 'flushed');
      return (async function* () {
        if (step === 'close') throw new WebSocketClosedEarlyError({ code: 1006, unsentCount: 0 });
        if (step === 'ambiguous') throw new AmbiguousModelOutcomeError('synthetic non-timeout ambiguity');
        if (step === 'timeout' || step === 'frame-timeout' || step === 'unsent') {
          if (step === 'frame-timeout')
            yield { type: 'response.created', response: { id: 'frame-seen', status: 'in_progress' } };
          if (cancelOnWait) queueMicrotask(() => service.abort());
          await raceWebSocketAbort(new Promise<never>(() => {}), request.signal);
          return;
        }
        const output =
          step === 'tool'
            ? [
                {
                  type: 'function_call',
                  id: 'fc_effect',
                  call_id: 'settled-effect',
                  name: 'fixture_effect',
                  arguments: '{"value":"once"}',
                  status: 'completed',
                },
              ]
            : [
                {
                  type: 'message',
                  id: 'msg_success',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'HEALTHY_TIMEOUT_RECOVERY', annotations: [] }],
                },
              ];
        if (step === 'tool') yield { type: 'response.output_item.done', output_index: 0, item: output[0] };
        yield {
          type: 'response.completed',
          response: {
            id: `resp_${requests.length}`,
            status: 'completed',
            output,
            usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
          },
        };
      })();
    }
  }
  const adapter = new CodexResponsesWSModel(
    {},
    'timeout-fixture-model',
    {
      getOrRefreshAccessToken: async () => 'synthetic-token',
      getAccountId: () => 'synthetic-account',
    },
    undefined,
    undefined,
    context,
    { firstFrameMs: 90_000, interFrameMs: 90_000 },
    undefined,
    new Transport(),
  );
  const observed = {
    async *stream(request: any) {
      try {
        yield* adapter.stream(request);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
    resetConversationState: adapter.resetConversationState.bind(adapter),
  };
  const logger: any = {
    debug(message: string, fields: any) {
      logs.push({ message, ...fields });
    },
    info() {},
    warn(message: string, fields: any) {
      logs.push({ message, ...fields });
    },
    error() {},
    setCorrelationId() {},
    clearCorrelationId() {},
    getCorrelationId: () => undefined,
  };
  const settings = new SettingsService({
    disableLogging: true,
    disableFilePersistence: true,
    cli: {
      shell: { autoApproveMode: 'off' } as any,
      agent: {
        modelSelection: { provider: 'timeout-fixture', model: 'timeout-fixture-model' },
        retryAttempts: limit,
        contextCompaction: { enabled: false },
        sessionRollover: { enabled: false },
        runBudget: { escalation: 'disabled' },
      } as any,
    },
  });
  const registry = createProviderRegistry();
  const definition: any = {
    id: 'timeout-fixture',
    label: 'Synthetic timeout boundary',
    fetchModels: async () => [],
    capabilities: { supportsConversationChaining: true },
    createStreamedModel: (_model: string, options: any) =>
      new RetryingModel(observed, { retryAttempts: options.retryAttempts, loggingService: logger }),
  };
  registry.upsertProvider(definition);
  // Baseline AgentClient uses the default registry: register this synthetic-only
  // ID in both scopes; never shadow a real provider or depend on registry repair.
  upsertProvider(definition);
  const ownership = new ToolOwnershipRegistry();
  const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
  approvalPolicyRegistry.register({
    toolName: 'fixture_effect',
    parameters: z.object({ value: z.string() }),
    needsApproval: () => approval,
  });
  const client = new AgentClient({
    approvalPolicyRegistry,
    selection: { provider: 'timeout-fixture', model: 'timeout-fixture-model' },
    retryAttempts: limit,
    agentOverride: {
      name: 'timeout fixture',
      model: 'timeout-fixture-model',
      instructions: 'Keep the original user request and all settled tool pairs.',
      modelSettings: { retry: { maxRetries: inLoopLimit } },
      tools: [
        {
          name: 'fixture_effect',
          description: 'Append to disposable fixture once',
          parameters: z.object({ value: z.string() }),
          needsApproval: () => approval,
          formatCommandMessage: () => [],
          execute: async ({ value }: any) => {
            fs.appendFileSync(file, `${value}\n`);
            return 'SETTLED_EFFECT_RESULT';
          },
        },
      ],
    } as any,
    toolOwnership: ownership,
    deps: { settings, logger, sessionContextService: context, providerRegistry: registry },
  });
  const service = new ConversationService({
    agentClient: client,
    toolOwnership: ownership,
    sessionId: 'zero-frame-integration',
    deps: { logger, settingsService: settings, sessionContextService: context },
  });
  async function settle(operation: Promise<unknown>) {
    let settled = false;
    const result = operation
      .then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      )
      .finally(() => {
        settled = true;
      });
    // Advance the real watchdog and recovery clock together, allowing actual
    // filesystem/runtime microtasks to complete between ticks.
    for (let tick = 0; tick < 2500 && !settled; tick++) {
      await yieldToIo();
      await vi.advanceTimersByTimeAsync(500);
    }
    if (!settled) {
      service.abort();
      throw new Error('Synthetic recovery did not settle within bounded fake clock');
    }
    return result;
  }
  const onEvent = (event: any) => {
    events.push(event);
  };
  return {
    requests,
    failures,
    logs,
    events,
    file,
    run: () => settle(service.sendMessage('ORIGINAL_USER_CONSTRAINT', { onEvent })),
    approve: () => settle(service.handleApprovalDecision('y', undefined, { onEvent })),
    async close() {
      service.dispose();
      await client.dispose();
      await adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
      vi.useRealTimers();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test('settled effect -> chained interruption -> retry1 90s zero-frame timeout -> retry2 healthy', async () => {
  const h = await harness(['tool', 'close', 'timeout', 'success']);
  try {
    const result = await h.run();
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.value)).toContain('HEALTHY_TIMEOUT_RECOVERY');
    expect(h.requests).toHaveLength(4);
    expect(fs.readFileSync(h.file, 'utf8')).toBe('once\n');
    const rebuilt = h.requests.at(-1);
    expect(rebuilt.previousResponseId).toBeFalsy();
    expect(JSON.stringify(rebuilt.input)).toContain('ORIGINAL_USER_CONSTRAINT');
    expect(JSON.stringify(rebuilt.input)).toContain('SETTLED_EFFECT_RESULT');
    expect(rebuilt.input.filter((item: any) => item.id === 'settled-effect')).toHaveLength(2);
    expect(h.failures[1]).toBeInstanceOf(AmbiguousModelOutcomeError);
    expect(h.failures[1].cause).toMatchObject({
      name: 'WebSocketReceiveTimeoutError',
      phase: 'first_frame',
      frameCount: 0,
      waitedMs: 90_000,
    });
    const admissions = h.logs.filter((row) => row.eventType === 'retry.recovery_admission');
    expect(admissions.map((row) => row.admitted)).toEqual([true, true]);
    console.log('TIMEOUT_SETTLED_EFFECT', JSON.stringify({ requests: h.requests.length, effectCount: 1, admissions }));
  } finally {
    await h.close();
  }
}, 30000);

for (const limit of [0, 1, 2, 5]) {
  test(`repeated zero-frame timeouts exhaust configured retry limit ${limit} without nested amplification`, async () => {
    const h = await harness(['timeout'], limit);
    try {
      const result = await h.run();
      expect(result.error).toBeInstanceOf(Error);
      expect(h.failures.at(-1)).toBeInstanceOf(AmbiguousModelOutcomeError);
      expect(h.requests).toHaveLength(limit + 1);
      expect(h.events.filter((row) => row.type === 'retry')).toHaveLength(limit);
      expect(fs.existsSync(h.file)).toBe(false);
      expect(
        h.failures.every(
          (error) =>
            error instanceof AmbiguousModelOutcomeError &&
            (error.cause as { frameCount?: number } | undefined)?.frameCount === 0,
        ),
      ).toBe(true);
      console.log(
        'TIMEOUT_LIMIT',
        JSON.stringify({
          limit,
          requests: h.requests.length,
          retries: h.events.filter((row) => row.type === 'retry').length,
        }),
      );
    } finally {
      await h.close();
    }
  }, 30000);
}

test('uncommitted close replay then timeout can use second configured replay', async () => {
  // Force the ordinary close to its existing session recovery owner.
  const h = await harness(['close', 'timeout', 'success'], 2, false, 0);
  try {
    const result = await h.run();
    expect(result.error).toBeUndefined();
    expect(h.requests).toHaveLength(3);
    expect(h.logs.filter((row) => row.eventType === 'retry.recovery_admission').map((row) => row.admitted)).toEqual([
      true,
      true,
    ]);
  } finally {
    await h.close();
  }
}, 30000);

for (const step of ['frame-timeout', 'ambiguous'] as const) {
  test(`${step} remains terminal without automatic replay`, async () => {
    const h = await harness([step, 'success']);
    try {
      const result = await h.run();
      expect(result.error).toBeInstanceOf(Error);
      expect(h.failures.at(-1)).toBeInstanceOf(AmbiguousModelOutcomeError);
      expect(h.requests).toHaveLength(1);
      expect(h.events.filter((row) => row.type === 'retry')).toHaveLength(0);
    } finally {
      await h.close();
    }
  }, 30000);
}

test('cancellation during first-frame wait remains terminal', async () => {
  const h = await harness(['timeout', 'success'], 2, true);
  try {
    await h.run();
    expect(h.requests).toHaveLength(1);
    expect(h.events.filter((row) => row.type === 'retry')).toHaveLength(0);
    expect(h.failures[0]?.name).toBe('AbortError');
  } finally {
    await h.close();
  }
}, 30000);

for (const step of ['close', 'unsent'] as const) {
  test(`${step} retains its ordinary recovery`, async () => {
    const h = await harness([step, 'success']);
    try {
      const result = await h.run();
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(result.value)).toContain('HEALTHY_TIMEOUT_RECOVERY');
      expect(h.requests).toHaveLength(2);
    } finally {
      await h.close();
    }
  }, 30000);
}

test('zero-frame receive credit does not waive unrelated recovery overhead', async () => {
  const h = await harness(['close', 'timeout', 'success'], 2, false, 0, 90_000);
  try {
    await h.run();
    expect(h.requests).toHaveLength(2);
    const admissions = h.logs.filter((row) => row.eventType === 'retry.recovery_admission');
    expect(admissions.map((row) => row.admitted)).toEqual([true, false]);
    expect(admissions[1].deadlineExceeded).toBe(true);
  } finally {
    await h.close();
  }
}, 30000);

for (const interruptedFirst of [false, true]) {
  test(`approval-resume continuation preserves settled effect through timeout (prior close: ${interruptedFirst})`, async () => {
    const steps: Step[] = interruptedFirst ? ['tool', 'close', 'timeout', 'success'] : ['tool', 'timeout', 'success'];
    const h = await harness(steps, 2, false, 2, 0, true);
    try {
      const pending = await h.run();
      expect(pending.error).toBeUndefined();
      expect(h.requests).toHaveLength(1);
      expect(fs.existsSync(h.file)).toBe(false);
      const result = await h.approve();
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(result.value)).toContain('HEALTHY_TIMEOUT_RECOVERY');
      expect(h.requests).toHaveLength(steps.length);
      expect(fs.readFileSync(h.file, 'utf8')).toBe('once\n');
      const rebuilt = h.requests.at(-1);
      expect(rebuilt.previousResponseId).toBeFalsy();
      expect(JSON.stringify(rebuilt.input)).toContain('ORIGINAL_USER_CONSTRAINT');
      expect(JSON.stringify(rebuilt.input)).toContain('SETTLED_EFFECT_RESULT');
      expect(rebuilt.input.filter((item: any) => item.id === 'settled-effect')).toHaveLength(2);
      const admissions = h.logs.filter((row) => row.eventType === 'retry.recovery_admission');
      expect(admissions.map((row) => [row.source, row.admitted])).toEqual(
        interruptedFirst
          ? [
              ['continuation', true],
              ['initial', true],
            ]
          : [['continuation', true]],
      );
      expect(admissions.at(-1).zeroFrameWaitCreditMs).toBe(interruptedFirst ? 90_000 : 0);
      console.log(
        'TIMEOUT_APPROVAL_CONTINUATION',
        JSON.stringify({ requests: h.requests.length, effectCount: 1, admissions }),
      );
    } finally {
      await h.close();
    }
  }, 30000);
}

for (const step of ['frame-timeout', 'ambiguous'] as const) {
  test(`settled tool does not make ${step} replayable`, async () => {
    const h = await harness(['tool', step, 'success']);
    try {
      const result = await h.run();
      expect(result.error).toBeInstanceOf(Error);
      expect(h.requests).toHaveLength(2);
      expect(fs.readFileSync(h.file, 'utf8')).toBe('once\n');
      expect(h.events.filter((row) => row.type === 'retry')).toHaveLength(0);
      expect(h.failures.at(-1)).toBeInstanceOf(AmbiguousModelOutcomeError);
    } finally {
      await h.close();
    }
  }, 30000);
}

test('budget refusal reports the effective configured timeout cap', async () => {
  const h = await harness(['close', 'timeout', 'success'], 5, false, 0, 90_000);
  try {
    await h.run();
    expect(h.requests).toHaveLength(2);
    expect(h.events.find((row) => row.type === 'retry_exhausted')).toMatchObject({ maxAttempts: 5 });
  } finally {
    await h.close();
  }
}, 30000);
