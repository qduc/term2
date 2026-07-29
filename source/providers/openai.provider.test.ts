import { it, expect } from 'vitest';
import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';
import { OpenAIResponsesModelWithPromptCacheKey, OpenAIResponsesWSModelWithPromptCacheKey } from './openai.provider.js';
import { getProvider } from './registry.js';

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

it.sequential('OpenAIResponsesModelWithPromptCacheKey forwards prompt_cache_key from modelSettings', () => {
  const original = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = function () {
    return {
      requestData: {
        include: [],
        temperature: 0.4,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new OpenAIResponsesModelWithPromptCacheKey({} as any, 'gpt-4o');
    const built = (model as any)._buildResponsesCreateRequest(
      {
        modelSettings: {
          prompt_cache_key: 'conv_123',
        },
      },
      true,
    );

    expect(built.requestData.prompt_cache_key).toBe('conv_123');
    expect(built.requestData.temperature).toBe(0.4);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it.sequential('OpenAIResponsesWSModelWithPromptCacheKey forwards prompt_cache_key from modelSettings', () => {
  const original = (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest;
  (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = function () {
    return {
      requestData: {
        include: [],
        temperature: 0.4,
      },
      sdkRequestHeaders: {},
      signal: undefined,
    };
  };

  try {
    const model = new OpenAIResponsesWSModelWithPromptCacheKey({} as any, 'gpt-4o');
    const built = (model as any)._buildResponsesCreateRequest(
      {
        modelSettings: {
          prompt_cache_key: 'conv_456',
        },
      },
      true,
    );

    expect(built.requestData.prompt_cache_key).toBe('conv_456');
    expect(built.requestData.temperature).toBe(0.4);
  } finally {
    (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = original;
  }
});

it.sequential('OpenAI request capture records the exact post-builder HTTP and WebSocket request projection', () => {
  const captures: any[] = [];
  const capture = { record: (entry: any) => captures.push(entry) };
  const originalHttp = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
  const originalWs = (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest;
  const builder = function () {
    return { requestData: { input: [{ role: 'user', content: 'hello' }], previous_response_id: 'resp-1' } };
  };
  (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = builder;
  (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = builder;
  try {
    for (const ModelClass of [OpenAIResponsesModelWithPromptCacheKey, OpenAIResponsesWSModelWithPromptCacheKey]) {
      const model = new ModelClass({} as any, 'gpt-5', capture as any);
      (model as any)._buildResponsesCreateRequest({ modelSettings: { prompt_cache_key: 'cache-key' } }, true);
    }
    expect(captures).toEqual([
      expect.objectContaining({
        transport: 'http',
        requestData: {
          input: [{ role: 'user', content: 'hello' }],
          previous_response_id: 'resp-1',
          prompt_cache_key: 'cache-key',
        },
      }),
      expect.objectContaining({
        transport: 'websocket',
        requestData: {
          input: [{ role: 'user', content: 'hello' }],
          previous_response_id: 'resp-1',
          prompt_cache_key: 'cache-key',
        },
      }),
    ]);
  } finally {
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = originalHttp;
    (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = originalWs;
  }
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
