import { it, expect } from 'vitest';
import { withTrace } from '@openai/agents';
import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';
import { OpenAIResponsesModelWithPromptCacheKey, OpenAIResponsesWSModelWithPromptCacheKey } from './openai.provider.js';
import { getProvider } from './registry.js';
import {
  consumeOpenAIRequestPrefixBinding,
  prepareOpenAIRequestPrefixBinding,
  runWithOpenAIRequestPrefixBindingScope,
} from './openai-request-prefix-binding.js';

const loggingService = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId() {
    return null;
  },
} as any;

it('OpenAI provider defaults to websocket and honors explicit HTTP transport', async () => {
  const provider = getProvider('openai');
  expect(provider?.createRunner).toBeTruthy();

  for (const [transport, expectedClass] of [
    [undefined, OpenAIResponsesWSModelWithPromptCacheKey],
    ['http', OpenAIResponsesModelWithPromptCacheKey],
  ] as const) {
    const runner = provider!.createRunner!({
      settingsService: {
        get(key: string) {
          if (key === 'agent.model') return 'gpt-4o';
          if (key === 'agent.transport') return transport;
          if (key === 'agent.retryAttempts') return 0;
          return undefined;
        },
      } as any,
      loggingService,
    });
    const model = await runner!.config.modelProvider!.getModel('gpt-4o');
    expect((model as any).wrappedModel instanceof expectedClass).toBe(true);
  }
});

it('forwards prompt_cache_key through the public providerData extraBody setting', async () => {
  const requestBodies: any[] = [];
  const model = new OpenAIResponsesModelWithPromptCacheKey(
    {
      responses: {
        create: async (requestData: any) => {
          requestBodies.push(requestData);
          return { id: 'resp-1', output: [], usage: {} };
        },
      },
    } as any,
    'gpt-5',
  );

  await withTrace('openai-provider-extra-body-test', () =>
    model.getResponse({
      input: 'hello',
      modelSettings: { providerData: { extraBody: { prompt_cache_key: 'session-1' } } },
      tools: [],
      handoffs: [],
    } as any),
  );

  expect(requestBodies).toHaveLength(1);
  expect(requestBodies[0]).toMatchObject({
    input: [{ role: 'user', content: 'hello' }],
    prompt_cache_key: 'session-1',
    stream: false,
  });
});

it.sequential(
  'OpenAI lifecycle observations pair each HTTP and WebSocket public attempt with its builder and terminal response',
  async () => {
    const observations: any[] = [];
    const originalBuild = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
    const originalWsBuild = (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest;
    const originalUnary = (OpenAIResponsesModel.prototype as any).getResponse;
    const originalStream = (OpenAIResponsesModel.prototype as any).getStreamedResponse;
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function (request: any) {
      return { requestData: { input: request.input } };
    };
    (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = (
      OpenAIResponsesModel.prototype as any
    )._buildResponsesCreateRequest;
    (OpenAIResponsesModel.prototype as any).getResponse = async function (request: any) {
      this._buildResponsesCreateRequest(request, false);
      return { responseId: request.responseId };
    };
    (OpenAIResponsesModel.prototype as any).getStreamedResponse = async function* (request: any) {
      this._buildResponsesCreateRequest(request, true);
      yield { type: 'response_done', response: { id: request.responseId } };
    };

    try {
      for (const [ModelClass, transport] of [
        [OpenAIResponsesModelWithPromptCacheKey, 'http'],
        [OpenAIResponsesWSModelWithPromptCacheKey, 'websocket'],
      ] as const) {
        const model = new ModelClass({ baseURL: 'https://example.test/v1/' } as any, 'gpt-test', {
          record() {},
          observe: (entry: any) => observations.push(entry),
        });
        await (model as any).getResponse({ input: `${transport}-unary`, responseId: `${transport}-unary-id` });
        for await (const _event of (model as any).getStreamedResponse({
          input: `${transport}-stream`,
          responseId: `${transport}-stream-id`,
        })) {
          // Exhaust the normalized stream so the response_done observation is emitted.
        }
      }

      expect(observations).toHaveLength(8);
      for (let index = 0; index < observations.length; index += 2) {
        const [built, terminal] = observations.slice(index, index + 2);
        expect(built).toMatchObject({
          phase: 'request-built',
          provider: 'openai',
          model: 'gpt-test',
          endpoint: 'https://example.test/v1',
        });
        expect(terminal).toMatchObject({ phase: 'terminal', token: built.token, requestData: built.requestData });
        expect(terminal.responseId).toBe(`${built.requestData.input}-id`);
      }
    } finally {
      (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = originalBuild;
      (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = originalWsBuild;
      (OpenAIResponsesModel.prototype as any).getResponse = originalUnary;
      (OpenAIResponsesModel.prototype as any).getStreamedResponse = originalStream;
    }
  },
);

it.sequential(
  'OpenAI lifecycle state isolates concurrent request objects and cleans up failed or abandoned attempts',
  async () => {
    const observations: any[] = [];
    const originalBuild = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
    const originalUnary = (OpenAIResponsesModel.prototype as any).getResponse;
    const originalStream = (OpenAIResponsesModel.prototype as any).getStreamedResponse;
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function (request: any) {
      return { requestData: { input: request.input } };
    };
    (OpenAIResponsesModel.prototype as any).getResponse = async function (request: any) {
      this._buildResponsesCreateRequest(request, false);
      if (request.fail) throw new Error('ambiguous transport failure');
      await Promise.resolve();
      return { responseId: request.responseId };
    };
    (OpenAIResponsesModel.prototype as any).getStreamedResponse = async function* (request: any) {
      this._buildResponsesCreateRequest(request, true);
      yield { type: 'output_text_delta', delta: 'partial' };
    };

    try {
      const model = new OpenAIResponsesModelWithPromptCacheKey({} as any, 'gpt-test', {
        record() {},
        observe: (entry: any) => observations.push(entry),
      });
      await Promise.all([
        (model as any).getResponse({ input: 'first', responseId: 'resp-first' }),
        (model as any).getResponse({ input: 'second', responseId: 'resp-second' }),
      ]);
      const concurrent = observations.splice(0);
      expect(concurrent.map((entry) => [entry.phase, entry.requestData.input, entry.responseId])).toEqual([
        ['request-built', 'first', undefined],
        ['request-built', 'second', undefined],
        ['terminal', 'first', 'resp-first'],
        ['terminal', 'second', 'resp-second'],
      ]);
      expect(concurrent[0].token).toBe(concurrent[2].token);
      expect(concurrent[1].token).toBe(concurrent[3].token);
      expect(concurrent[0].token).not.toBe(concurrent[1].token);
      expect(concurrent[0]).toMatchObject({ model: 'gpt-test', endpoint: 'https://api.openai.com/v1' });

      await expect((model as any).getResponse({ input: 'failed', fail: true })).rejects.toThrow(
        'ambiguous transport failure',
      );
      const stream = (model as any).getStreamedResponse({ input: 'abandoned' });
      await stream.next();
      await stream.return();
      expect(observations.map((entry) => entry.phase)).toEqual([
        'request-built',
        'failed',
        'request-built',
        'abandoned',
      ]);
      expect(observations[1].responseId).toBeUndefined();
      expect(observations[3].responseId).toBeUndefined();
    } finally {
      (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = originalBuild;
      (OpenAIResponsesModel.prototype as any).getResponse = originalUnary;
      (OpenAIResponsesModel.prototype as any).getStreamedResponse = originalStream;
    }
  },
);

it.sequential(
  'OpenAI lifecycle normalizes unary responseId and preserves a terminal stream observation without an ID',
  async () => {
    const observations: any[] = [];
    const originalBuild = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
    const originalUnary = (OpenAIResponsesModel.prototype as any).getResponse;
    const originalStream = (OpenAIResponsesModel.prototype as any).getStreamedResponse;
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function (request: any) {
      return { requestData: { input: request.input } };
    };
    (OpenAIResponsesModel.prototype as any).getResponse = async function (request: any) {
      this._buildResponsesCreateRequest(request, false);
      // The public Agents SDK ModelResponse shape exposes responseId, not id.
      return { responseId: 'resp-unary' };
    };
    (OpenAIResponsesModel.prototype as any).getStreamedResponse = async function* (request: any) {
      this._buildResponsesCreateRequest(request, true);
      yield { type: 'response_done', response: {} };
    };

    try {
      const model = new OpenAIResponsesModelWithPromptCacheKey({} as any, 'gpt-test', {
        record() {},
        observe: (entry: any) => observations.push(entry),
      });
      await (model as any).getResponse({ input: 'unary' });
      for await (const _event of (model as any).getStreamedResponse({ input: 'stream-without-id' })) {
        // Exhaust the stream so its terminal observation is emitted.
      }

      expect(observations.map((entry) => [entry.phase, entry.requestData.input, entry.responseId])).toEqual([
        ['request-built', 'unary', undefined],
        ['terminal', 'unary', 'resp-unary'],
        ['request-built', 'stream-without-id', undefined],
        ['terminal', 'stream-without-id', undefined],
      ]);
    } finally {
      (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = originalBuild;
      (OpenAIResponsesModel.prototype as any).getResponse = originalUnary;
      (OpenAIResponsesModel.prototype as any).getStreamedResponse = originalStream;
    }
  },
);

it.sequential('OpenAI request capture and lifecycle observer failures cannot change a request', async () => {
  const originalBuild = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  const originalUnary = (OpenAIResponsesModel.prototype as any).getResponse;
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
    return { requestData: { input: 'unchanged' } };
  };
  (OpenAIResponsesModel.prototype as any).getResponse = async function (request: any) {
    this._buildResponsesCreateRequest(request, false);
    return { responseId: 'resp-ok' };
  };
  try {
    const model = new OpenAIResponsesModelWithPromptCacheKey({} as any, 'gpt-test', {
      record() {
        throw new Error('capture failure');
      },
      observe() {
        throw new Error('observer failure');
      },
    });
    await expect((model as any).getResponse({})).resolves.toEqual({ responseId: 'resp-ok' });
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = originalBuild;
    (OpenAIResponsesModel.prototype as any).getResponse = originalUnary;
  }
});

it.sequential(
  'OpenAI lifecycle binds an exact scoped snapshot prefix without leaking it across HTTP, WebSocket, or mismatch attempts',
  async () => {
    const observations: any[] = [];
    const originalHttpBuild = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
    const originalWsBuild = (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest;
    const originalUnary = (OpenAIResponsesModel.prototype as any).getResponse;
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function (request: any) {
      return { requestData: { input: request.input } };
    };
    (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = (
      OpenAIResponsesModel.prototype as any
    )._buildResponsesCreateRequest;
    (OpenAIResponsesModel.prototype as any).getResponse = async function (request: any) {
      this._buildResponsesCreateRequest(request, false);
      return { responseId: request.responseId };
    };
    try {
      for (const [ModelClass, transport] of [
        [OpenAIResponsesModelWithPromptCacheKey, 'http'],
        [OpenAIResponsesWSModelWithPromptCacheKey, 'websocket'],
      ] as const) {
        const model = new ModelClass({} as any, 'gpt-test', {
          record() {},
          observe: (entry: any) => observations.push(entry),
        });
        await runWithOpenAIRequestPrefixBindingScope(async () => {
          prepareOpenAIRequestPrefixBinding(
            { snapshotIdentity: `history:${transport}`, snapshotRevision: 7, lineage: 0 },
            [{ role: 'user', content: transport }],
          );
          await (model as any).getResponse({
            input: [{ role: 'user', content: transport }],
            responseId: `${transport}-id`,
          });
          prepareOpenAIRequestPrefixBinding({ snapshotIdentity: 'history:wrong', snapshotRevision: 8, lineage: 0 }, [
            { role: 'user', content: 'expected' },
          ]);
          await (model as any).getResponse({ input: [{ role: 'user', content: 'other' }], responseId: 'mismatch-id' });
        });
      }

      const terminals = observations.filter((entry) => entry.phase === 'terminal');
      expect(terminals.map((entry) => entry.prefixBinding)).toEqual([
        { snapshotIdentity: 'history:http', snapshotRevision: 7, lineage: 0 },
        undefined,
        { snapshotIdentity: 'history:websocket', snapshotRevision: 7, lineage: 0 },
        undefined,
      ]);
      expect(terminals.map((entry) => entry.responseId)).toEqual([
        'http-id',
        'mismatch-id',
        'websocket-id',
        'mismatch-id',
      ]);
    } finally {
      (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = originalHttpBuild;
      (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = originalWsBuild;
      (OpenAIResponsesModel.prototype as any).getResponse = originalUnary;
    }
  },
);

it.sequential('OpenAI lifecycle binds the pre-builder SDK message shape to the normalized request input', async () => {
  const observations: any[] = [];
  const originalUnary = (OpenAIResponsesModel.prototype as any).getResponse;
  (OpenAIResponsesModel.prototype as any).getResponse = async function (request: any) {
    this._buildResponsesCreateRequest(request, false);
    return { responseId: 'resp-normalized' };
  };
  try {
    const model = new OpenAIResponsesModelWithPromptCacheKey({} as any, 'gpt-test', {
      record() {},
      observe: (entry: any) => observations.push(entry),
    });
    const sdkInput = [{ type: 'message', role: 'user', content: 'hello' }];

    await runWithOpenAIRequestPrefixBindingScope(async () => {
      prepareOpenAIRequestPrefixBinding(
        { snapshotIdentity: 'history:normalized', snapshotRevision: 1, lineage: 0 },
        sdkInput,
      );
      await (model as any).getResponse({
        input: sdkInput,
        modelSettings: {},
        tools: [],
        handoffs: [],
      });
    });

    expect(observations).toMatchObject([
      {
        phase: 'request-built',
        requestData: { input: [{ role: 'user', content: 'hello' }] },
        prefixBinding: { snapshotIdentity: 'history:normalized', snapshotRevision: 1, lineage: 0 },
      },
      {
        phase: 'terminal',
        prefixBinding: { snapshotIdentity: 'history:normalized', snapshotRevision: 1, lineage: 0 },
      },
    ]);
  } finally {
    (OpenAIResponsesModel.prototype as any).getResponse = originalUnary;
  }
});

it('OpenAI prefix scopes isolate concurrent runs and fail closed for overlapping prepared invocations', async () => {
  const seen = await Promise.all(
    ['first', 'second'].map((name, revision) =>
      runWithOpenAIRequestPrefixBindingScope(async () => {
        prepareOpenAIRequestPrefixBinding(
          { snapshotIdentity: `history:${name}`, snapshotRevision: revision, lineage: revision },
          [name],
        );
        await Promise.resolve();
        return consumeOpenAIRequestPrefixBinding([name]);
      }),
    ),
  );
  expect(seen).toEqual([
    { snapshotIdentity: 'history:first', snapshotRevision: 0, lineage: 0 },
    { snapshotIdentity: 'history:second', snapshotRevision: 1, lineage: 1 },
  ]);

  await runWithOpenAIRequestPrefixBindingScope(async () => {
    prepareOpenAIRequestPrefixBinding({ snapshotIdentity: 'history:one', snapshotRevision: 1, lineage: 0 }, ['same']);
    prepareOpenAIRequestPrefixBinding({ snapshotIdentity: 'history:two', snapshotRevision: 2, lineage: 0 }, ['same']);
    expect(consumeOpenAIRequestPrefixBinding(['same'])).toBeUndefined();
    expect(consumeOpenAIRequestPrefixBinding(['same'])).toBeUndefined();
  });

  await runWithOpenAIRequestPrefixBindingScope(async () => {
    prepareOpenAIRequestPrefixBinding({ snapshotIdentity: 'history:first', snapshotRevision: 1, lineage: 0 }, [
      'first',
    ]);
    prepareOpenAIRequestPrefixBinding({ snapshotIdentity: 'history:second', snapshotRevision: 2, lineage: 0 }, [
      'second',
    ]);
    expect(consumeOpenAIRequestPrefixBinding(['first'])).toBeUndefined();
    expect(consumeOpenAIRequestPrefixBinding(['second'])).toBeUndefined();
  });

  await runWithOpenAIRequestPrefixBindingScope(async () => {
    prepareOpenAIRequestPrefixBinding({ snapshotIdentity: 'history:stale', snapshotRevision: 3, lineage: 0 }, [
      'expected',
    ]);
    expect(consumeOpenAIRequestPrefixBinding(['mismatch'])).toBeUndefined();
    expect(consumeOpenAIRequestPrefixBinding(['expected'])).toBeUndefined();
  });

  for (const input of [
    [{ role: 'assistant', content: 'hello' }],
    [{ role: 'user', content: 'changed' }],
    [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'later' },
    ],
    [{ type: 'function_call', name: 'other', arguments: '{}' }],
  ]) {
    await runWithOpenAIRequestPrefixBindingScope(async () => {
      prepareOpenAIRequestPrefixBinding({ snapshotIdentity: 'history:exact', snapshotRevision: 4, lineage: 0 }, [
        { type: 'message', role: 'user', content: 'hello' },
      ]);
      expect(consumeOpenAIRequestPrefixBinding(input)).toBeUndefined();
    });
  }
});

it.sequential(
  'OpenAI lifecycle retains a bound prefix when another invocation prepares the same input before a repeated build',
  async () => {
    const observations: any[] = [];
    const originalBuild = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
    const originalUnary = (OpenAIResponsesModel.prototype as any).getResponse;
    let releaseRepeatedBuild: (() => void) | undefined;
    const repeatedBuildHeld = new Promise<void>((resolve) => {
      releaseRepeatedBuild = resolve;
    });
    let firstBuildObserved: (() => void) | undefined;
    const firstBuildComplete = new Promise<void>((resolve) => {
      firstBuildObserved = resolve;
    });
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function (request: any) {
      return { requestData: { input: request.input } };
    };
    (OpenAIResponsesModel.prototype as any).getResponse = async function (request: any) {
      this._buildResponsesCreateRequest(request, false);
      firstBuildObserved!();
      await repeatedBuildHeld;
      this._buildResponsesCreateRequest(request, false); // SDK retry/request-object reuse
      return { responseId: 'resp-first' };
    };
    try {
      const model = new OpenAIResponsesModelWithPromptCacheKey({} as any, 'gpt-test', {
        record() {},
        observe: (entry: any) => observations.push(entry),
      });
      await runWithOpenAIRequestPrefixBindingScope(async () => {
        prepareOpenAIRequestPrefixBinding({ snapshotIdentity: 'history:first', snapshotRevision: 1, lineage: 0 }, [
          'first',
        ]);
        const first = (model as any).getResponse({ input: ['first'] });
        await firstBuildComplete;
        prepareOpenAIRequestPrefixBinding({ snapshotIdentity: 'history:later', snapshotRevision: 2, lineage: 0 }, [
          'first',
        ]);
        releaseRepeatedBuild!();
        await first;

        // The later invocation was not consumed by request A's repeated build.
        expect(consumeOpenAIRequestPrefixBinding(['first'])).toEqual({
          snapshotIdentity: 'history:later',
          snapshotRevision: 2,
          lineage: 0,
        });
      });

      expect(observations.map((entry) => entry.prefixBinding)).toEqual([
        { snapshotIdentity: 'history:first', snapshotRevision: 1, lineage: 0 },
        { snapshotIdentity: 'history:first', snapshotRevision: 1, lineage: 0 },
      ]);
      expect(observations.at(-1)).toMatchObject({ phase: 'terminal', responseId: 'resp-first' });
    } finally {
      (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = originalBuild;
      (OpenAIResponsesModel.prototype as any).getResponse = originalUnary;
    }
  },
);
