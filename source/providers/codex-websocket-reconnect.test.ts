import { afterEach, expect, it, vi } from 'vitest';

const sockets: Array<{ socket: { readyState: number }; close(): void; sent: any[] }> = [];
vi.mock('openai/resources/responses/ws', () => ({
  ResponsesWS: class {
    socket = { readyState: 1 };
    sent: any[] = [];
    constructor() {
      sockets.push(this);
    }
    close() {
      this.socket.readyState = 3;
    }
    send(frame: any) {
      this.sent.push(frame);
    }
    async *stream() {
      yield {
        type: 'message',
        message: {
          type: 'response.completed',
          response: { id: `resp-${sockets.indexOf(this)}-${this.sent.length}`, output: [], usage: {} },
        },
      };
    }
  },
}));

const { CodexResponsesTransport, CodexResponsesWSModel } = await import('./codex-responses-model.js');
afterEach(() => {
  sockets.length = 0;
});

function model() {
  const transport = new CodexResponsesTransport({}, 'gpt-6.1-sol', true);
  return new CodexResponsesWSModel(
    {},
    'gpt-6.1-sol',
    {
      getOrRefreshAccessToken: async () => 'test-token',
      getAccountId: () => undefined,
      getInstallationId: () => 'test-installation',
    },
    undefined,
    undefined,
    {
      getContext: () => ({ sessionId: 'reconnect-test' }),
    } as any,
    transport,
  );
}
async function drain(stream: AsyncIterable<unknown>) {
  for await (const _event of stream) {
  }
}
const first = { type: 'message' as const, role: 'user' as const, content: [{ type: 'text' as const, text: 'first' }] };
const next = { type: 'message' as const, role: 'user' as const, content: [{ type: 'text' as const, text: 'next' }] };

it('replays complete history on a replaced socket before sending a stale response anchor', async () => {
  const instance = model();
  try {
    await drain(instance.stream({ input: [first], tools: [] }));
    sockets[0]!.close();
    await drain(instance.stream({ input: [first, next], tools: [] }));
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent).toHaveLength(1);
    expect(sockets[1]!.sent[0]).not.toHaveProperty('previous_response_id');
    expect(sockets[1]!.sent[0].input).toHaveLength(2);
  } finally {
    await instance.close();
  }
});

it('retains response chaining when the physical socket is reused', async () => {
  const instance = model();
  try {
    await drain(instance.stream({ input: [first], tools: [] }));
    await drain(instance.stream({ input: [first, next], tools: [] }));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent[1].previous_response_id).toBe('resp-0-1');
  } finally {
    await instance.close();
  }
});

it('leaves a caller delta unsent on reconnect so session recovery can supply full history', async () => {
  const instance = model();
  try {
    await drain(instance.stream({ input: [first], tools: [] }));
    sockets[0]!.close();
    await expect(
      drain(instance.stream({ input: [next], tools: [], previousResponseId: 'resp-0-1' })),
    ).rejects.toMatchObject({ code: 'previous_response_not_found' });
    expect(sockets[1]!.sent).toHaveLength(0);
    await drain(instance.stream({ input: [first, next], tools: [], disableChaining: true }));
    expect(sockets[1]!.sent[0]).not.toHaveProperty('previous_response_id');
    expect(sockets[1]!.sent[0].input).toHaveLength(2);
  } finally {
    await instance.close();
  }
});
