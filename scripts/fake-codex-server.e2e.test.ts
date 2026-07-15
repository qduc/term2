import { afterEach, expect, it } from 'vitest';
import OpenAI from 'openai';
import { WebSocket as NodeWebSocket } from 'ws';
import { CodexResponsesWSModel } from '../source/providers/codex-responses-model.js';
import { RetryingModel } from '../source/providers/retrying-model.js';
import { startFakeCodexServer, type FakeCodexServer } from './fake-codex-server-lib.js';

let server: FakeCodexServer | undefined;
const originalWebSocket = globalThis.WebSocket;

afterEach(async () => {
  globalThis.WebSocket = originalWebSocket;
  await server?.close();
  server = undefined;
});

function createModel(baseUrl: string, receiveTimeoutMs = 500, withSessionContext = false): CodexResponsesWSModel {
  const client = new OpenAI({ apiKey: 'fake-token', baseURL: baseUrl, timeout: 2_000 });
  const tokenManager = {
    getOrRefreshAccessToken: async () => 'fake-token',
    getAccountId: () => 'fake-account',
  };
  const sessionContextService = withSessionContext
    ? {
        getContext: () => ({ sessionId: 'fake-session', providerHistoryKey: 'fake-history' }),
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
      }
    : undefined;
  return new CodexResponsesWSModel(
    client,
    'gpt-5.3-codex',
    tokenManager,
    undefined,
    undefined,
    sessionContextService as any,
    {
      firstFrameMs: receiveTimeoutMs,
      interFrameMs: receiveTimeoutMs,
    },
  );
}

function request(): any {
  return {
    input: [{ role: 'user', content: 'hello' }],
    modelSettings: {},
    tools: [],
    handoffs: [],
  };
}

it('performs history warmup without generating the user turn twice', async () => {
  server = await startFakeCodexServer({ scenario: 'success' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = createModel(server.baseUrl, 500, true);

  for await (const _event of model.getStreamedResponse(request())) {
    // Consume the complete turn.
  }

  const generatingRequests = server.receivedRequests.filter((frame) => frame.generate !== false);
  expect(generatingRequests).toHaveLength(1);
});

it('streams a completed Codex response over a real local websocket', async () => {
  server = await startFakeCodexServer({ scenario: 'success' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = createModel(server.baseUrl);

  const events: any[] = [];
  for await (const event of model.getStreamedResponse(request())) {
    events.push(event);
  }

  expect(events.at(-1)?.event?.type).toBe('response.completed');
  expect(events.at(-1)?.event?.response.output[0].content[0].text).toBe('Hello from fake Codex');
  expect(server.receivedRequests).toHaveLength(1);
  expect(server.receivedRequests[0]?.type).toBe('response.create');
});

it('times out when the server stalls before the first response frame', async () => {
  server = await startFakeCodexServer({ scenario: 'stall-before-first-frame' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = createModel(server.baseUrl, 25);

  const consume = async () => {
    for await (const _event of model.getStreamedResponse(request())) {
      // The fake server intentionally never responds.
    }
  };

  await expect(consume()).rejects.toThrow('WebSocket first frame timeout');
  expect(server.receivedRequests).toHaveLength(1);
});

it('times out after partial output when the server stalls mid-stream', async () => {
  server = await startFakeCodexServer({ scenario: 'stall-mid-stream' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = createModel(server.baseUrl, 25);
  const events: any[] = [];

  const consume = async () => {
    for await (const event of model.getStreamedResponse(request())) events.push(event);
  };

  await expect(consume()).rejects.toThrow('WebSocket idle timeout');
  expect(events.some((event) => event.event?.type === 'response.output_text.delta')).toBe(true);
  expect(server.receivedRequests).toHaveLength(1);
});

it('surfaces an abnormal close after partial output without replaying the turn', async () => {
  server = await startFakeCodexServer({ scenario: 'close-mid-stream' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = createModel(server.baseUrl);
  const events: any[] = [];

  const consume = async () => {
    for await (const event of model.getStreamedResponse(request())) events.push(event);
  };

  await expect(consume()).rejects.toThrow('before a terminal response event');
  expect(events.some((event) => event.event?.type === 'response.output_text.delta')).toBe(true);
  expect(server.receivedRequests).toHaveLength(1);
});

it('surfaces a provider error frame', async () => {
  server = await startFakeCodexServer({ scenario: 'provider-error' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = createModel(server.baseUrl);

  const consume = async () => {
    for await (const _event of model.getStreamedResponse(request())) {
      // The error frame terminates the stream.
    }
  };

  await expect(consume()).rejects.toThrow('Injected Codex server failure');
  expect(server.receivedRequests).toHaveLength(1);
});

it('retries when the websocket connection fails before the turn can be sent', async () => {
  server = await startFakeCodexServer({ scenario: 'success' });
  const baseUrl = server.baseUrl;
  await server.close();
  server = undefined;
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  let retries = 0;
  const model = new RetryingModel(createModel(baseUrl), {
    retryAttempts: 2,
    sleep: async () => {},
    random: () => 0.5,
    onRetry: () => retries++,
  });

  const consume = async () => {
    for await (const _event of model.getStreamedResponse(request())) {
      // No event can arrive because the connection is refused.
    }
  };

  await expect(consume()).rejects.toThrow();
  expect(retries).toBe(2);
});

it('does not replay an accepted but unacknowledged turn through the production retry wrapper', async () => {
  server = await startFakeCodexServer({ scenario: 'close-before-first-frame' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = new RetryingModel(createModel(server.baseUrl), {
    retryAttempts: 2,
    sleep: async () => {},
    random: () => 0.5,
  });

  const consume = async () => {
    for await (const _event of model.getStreamedResponse(request())) {
      // The accepted turn has an ambiguous outcome and must not be replayed.
    }
  };

  await expect(consume()).rejects.toThrow('before any response events were received');
  expect(server.receivedRequests).toHaveLength(1);
});

it('replays full history only after the server explicitly rejects the previous response id', async () => {
  server = await startFakeCodexServer({ scenario: 'previous-response-not-found' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = createModel(server.baseUrl);
  const chainedRequest = { ...request(), previousResponseId: 'resp_stale' };

  for await (const _event of model.getStreamedResponse(chainedRequest)) {
    // The explicit rejection is recovered by sending full history.
  }

  expect(server.receivedRequests).toHaveLength(2);
  expect(server.receivedRequests[0]?.previous_response_id).toBe('resp_stale');
  expect(server.receivedRequests[1]?.previous_response_id).toBeUndefined();
});

it('does not replay an accepted chained turn as full history', async () => {
  server = await startFakeCodexServer({ scenario: 'close-before-first-frame' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = createModel(server.baseUrl);
  const chainedRequest = { ...request(), previousResponseId: 'resp_previous' };

  const consume = async () => {
    for await (const _event of model.getStreamedResponse(chainedRequest)) {
      // The server accepts the chained turn and closes before acknowledging it.
    }
  };

  await expect(consume()).rejects.toThrow('before any response events were received');
  expect(server.receivedRequests).toHaveLength(1);
});

it('surfaces an abnormal close before the first response frame', async () => {
  server = await startFakeCodexServer({ scenario: 'close-before-first-frame' });
  globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  const model = createModel(server.baseUrl);

  const consume = async () => {
    for await (const _event of model.getStreamedResponse(request())) {
      // The fake server closes before yielding an event.
    }
  };

  await expect(consume()).rejects.toThrow('before any response events were received');
  expect(server.receivedRequests).toHaveLength(1);
});
