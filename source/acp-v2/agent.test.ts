import { describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import {
  createAcpV2Agent,
  type AcpV2PromptExecution,
  type AcpV2PromptOutcome,
  type AcpV2SessionBackend,
} from './agent.js';

const initialize = (agent: acp.AgentApp, run: (context: acp.ClientContext) => Promise<void>) =>
  acp.client({ name: 'term2-acp-test' }).connectWith(agent, async (context) => {
    await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      info: { name: 'term2-acp-test', version: '1.0.0' },
    });
    await run(context);
  });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const connectOverNdJson = async (
  agent: acp.AgentApp,
  client: acp.ClientApp,
  run: (context: acp.ClientContext) => Promise<void>,
): Promise<void> => {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentConnection = agent.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
  try {
    await client.connectWith(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable), run);
  } finally {
    agentConnection.close();
    await agentConnection.closed;
  }
};

const createBackend = (): AcpV2SessionBackend => ({
  createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
  listSessions: vi.fn(async () => ({ sessions: [] })),
  resumeSession: vi.fn(async () => ({})),
  closeSession: vi.fn(async () => {}),
  preparePrompt: vi.fn(async () => ({
    run: async () => ({ stopReason: 'end_turn' }),
  })),
  cancelSession: vi.fn(async () => {}),
});

const createAgent = (backend: AcpV2SessionBackend, logger = { error: vi.fn() }) =>
  createAcpV2Agent({ backend, logger, version: '0.25.0' });

describe('createAcpV2Agent', () => {
  it('serves initialization over the SDK newline-delimited JSON transport', async () => {
    const agent = createAgent(createBackend());
    const client = acp.client({ name: 'term2-acp-test' });

    await connectOverNdJson(agent, client, async (context) => {
      await expect(
        context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          info: { name: 'term2-acp-test', version: '1.0.0' },
        }),
      ).resolves.toMatchObject({
        protocolVersion: 2,
        info: { name: 'term2', version: '0.25.0' },
      });
    });
  });

  it('negotiates v2 and advertises only the baseline session surface', async () => {
    const backend = createBackend();
    const agent = createAgent(backend);
    const client = acp.client({ name: 'term2-acp-test' });

    await client.connectWith(agent, async (context) => {
      const result = await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'term2-acp-test', version: '1.0.0' },
      });

      expect(result).toEqual({
        protocolVersion: 2,
        info: { name: 'term2', title: 'term2', version: '0.25.0' },
        capabilities: { session: {} },
      });
    });
  });

  it('delegates baseline session lifecycle requests over the newline-delimited JSON transport', async () => {
    const backend = createBackend();
    const agent = createAgent(backend);
    const client = acp.client({ name: 'term2-acp-test' });

    await connectOverNdJson(agent, client, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'term2-acp-test', version: '1.0.0' },
      });
      await expect(context.request(acp.methods.agent.session.new, { cwd: '/workspace' })).resolves.toEqual({
        sessionId: 'session-1',
      });
      await expect(context.request(acp.methods.agent.session.list, { cwd: '/workspace' })).resolves.toEqual({
        sessions: [],
      });
      await expect(
        context.request(acp.methods.agent.session.resume, {
          sessionId: 'session-1',
          cwd: '/workspace',
          replayFrom: { type: 'start' },
        }),
      ).resolves.toEqual({});
      await expect(context.request(acp.methods.agent.session.close, { sessionId: 'session-1' })).resolves.toEqual({});

      expect(backend.createSession).toHaveBeenCalledWith({ cwd: '/workspace' });
      expect(backend.listSessions).toHaveBeenCalledWith({ cwd: '/workspace' });
      expect(backend.resumeSession).toHaveBeenCalledWith(
        { sessionId: 'session-1', cwd: '/workspace', replayFrom: { type: 'start' } },
        expect.any(Function),
      );
      expect(backend.closeSession).toHaveBeenCalledWith('session-1');
    });
  });

  it('resumes a session without inventing a replay cursor', async () => {
    const backend = createBackend();
    const agent = createAgent(backend);

    await initialize(agent, async (context) => {
      await expect(
        context.request(acp.methods.agent.session.resume, {
          sessionId: 'session-1',
          cwd: '/workspace',
        }),
      ).resolves.toEqual({});
      expect(backend.resumeSession).toHaveBeenCalledWith(
        { sessionId: 'session-1', cwd: '/workspace' },
        expect.any(Function),
      );
    });
  });

  it('rejects unadvertised session extensions before creating a session', async () => {
    const backend = createBackend();
    const agent = createAgent(backend);

    await initialize(agent, async (context) => {
      await expect(
        context.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          additionalDirectories: ['/shared'],
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        context.request(acp.methods.agent.session.new, {
          cwd: '/workspace',
          mcpServers: [{ type: 'stdio', name: 'test', command: '/bin/test', args: [], env: [] }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(backend.createSession).not.toHaveBeenCalled();
    });
  });

  it('acknowledges prompts before completion and reports ordered state updates', async () => {
    let finish!: (value: { stopReason: acp.StopReason }) => void;
    const completion = new Promise<{ stopReason: acp.StopReason }>((resolve) => {
      finish = resolve;
    });
    const execution: AcpV2PromptExecution = {
      run: async (emit) => {
        await emit({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'assistant-1',
          content: { type: 'text', text: 'hello' },
        });
        return await completion;
      },
    };
    const backend = createBackend();
    backend.preparePrompt = vi.fn(async () => execution);
    const updates: acp.UpdateSessionNotification[] = [];
    const client = acp
      .client({ name: 'term2-acp-test' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const agent = createAgent(backend);

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'term2-acp-test', version: '1.0.0' },
      });

      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: 'session-1',
          prompt: [{ type: 'text', text: 'hi' }],
        }),
      ).resolves.toEqual({});

      expect(updates).toEqual([
        {
          sessionId: 'session-1',
          update: { sessionUpdate: 'state_update', state: 'running' },
        },
      ]);

      finish({ stopReason: 'end_turn' });
      await vi.waitFor(() => expect(updates).toHaveLength(3));
      expect(updates).toEqual([
        {
          sessionId: 'session-1',
          update: { sessionUpdate: 'state_update', state: 'running' },
        },
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'assistant-1',
            content: { type: 'text', text: 'hello' },
          },
        },
        {
          sessionId: 'session-1',
          update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
        },
      ]);
    });
  });

  it('reserves a session while prompt preparation is pending', async () => {
    const preparation = deferred<AcpV2PromptExecution>();
    const backend = createBackend();
    backend.preparePrompt = vi.fn(async () => await preparation.promise);
    const updates: acp.UpdateSessionNotification[] = [];
    const client = acp
      .client({ name: 'term2-acp-test' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const agent = createAgent(backend);

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'term2-acp-test', version: '1.0.0' },
      });

      const firstPrompt = context.request(acp.methods.agent.session.prompt, {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'first' }],
      });
      await vi.waitFor(() => expect(backend.preparePrompt).toHaveBeenCalledTimes(1));

      const duplicatePrompt = expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: 'session-1',
          prompt: [{ type: 'text', text: 'second' }],
        }),
      ).rejects.toMatchObject({ code: -32000 });
      await context.notify(acp.methods.agent.session.cancel, { sessionId: 'session-1' });

      preparation.resolve({ run: async () => ({ stopReason: 'end_turn' }) });
      await expect(firstPrompt).resolves.toEqual({});
      await duplicatePrompt;
      await vi.waitFor(() =>
        expect(updates.at(-1)).toEqual({
          sessionId: 'session-1',
          update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' },
        }),
      );
      expect(backend.preparePrompt).toHaveBeenCalledTimes(1);
      expect(backend.cancelSession).toHaveBeenCalledWith('session-1');
    });
  });

  it('forwards session cancellation and terminates active work as cancelled', async () => {
    const backend = createBackend();
    const execution: AcpV2PromptExecution = {
      run: async (_emit, signal) =>
        await new Promise<AcpV2PromptOutcome>((resolve) => {
          signal.addEventListener('abort', () => resolve({ stopReason: 'cancelled' as const }), { once: true });
        }),
    };
    backend.preparePrompt = vi.fn(async () => execution);
    const updates: acp.UpdateSessionNotification[] = [];
    const client = acp
      .client({ name: 'term2-acp-test' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const agent = createAgent(backend);

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'term2-acp-test', version: '1.0.0' },
      });
      await context.request(acp.methods.agent.session.prompt, {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'hi' }],
      });
      await context.notify(acp.methods.agent.session.cancel, { sessionId: 'session-1' });

      await vi.waitFor(() =>
        expect(updates.at(-1)).toEqual({
          sessionId: 'session-1',
          update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' },
        }),
      );
      expect(backend.cancelSession).toHaveBeenCalledWith('session-1');
    });
  });

  it('logs a backend prompt failure before reporting the terminal error state', async () => {
    const backend = createBackend();
    backend.preparePrompt = vi.fn(async () => ({
      run: async () => {
        throw new Error('backend exploded');
      },
    }));
    const logger = { error: vi.fn() };
    const updates: acp.UpdateSessionNotification[] = [];
    const client = acp
      .client({ name: 'term2-acp-test' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const agent = createAgent(backend, logger);

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'term2-acp-test', version: '1.0.0' },
      });
      await context.request(acp.methods.agent.session.prompt, {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'hi' }],
      });

      await vi.waitFor(() =>
        expect(updates.at(-1)).toEqual({
          sessionId: 'session-1',
          update: { sessionUpdate: 'state_update', state: 'idle', stopReason: '_term2_error' },
        }),
      );
      expect(logger.error).toHaveBeenCalledWith('ACP prompt execution failed', {
        eventType: 'acp.prompt.failed',
        sessionId: 'session-1',
        errorMessage: 'backend exploded',
      });
    });
  });

  it('waits for active work to settle before closing its backend session', async () => {
    const order: string[] = [];
    const backend = createBackend();
    const execution: AcpV2PromptExecution = {
      run: async (_emit, signal) => {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        return { stopReason: 'cancelled' };
      },
    };
    backend.preparePrompt = vi.fn(async () => execution);
    backend.closeSession = vi.fn(async () => {
      order.push('backend-close');
    });
    const client = acp
      .client({ name: 'term2-acp-test' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === 'state_update' && params.update.state === 'idle') {
          order.push('idle');
        }
      });
    const agent = createAgent(backend);

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'term2-acp-test', version: '1.0.0' },
      });
      await context.request(acp.methods.agent.session.prompt, {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'hi' }],
      });
      await context.request(acp.methods.agent.session.close, { sessionId: 'session-1' });

      expect(order).toEqual(['idle', 'backend-close']);
    });
  });

  it('settles active work and closes the session when backend cancellation fails', async () => {
    const preparation = deferred<AcpV2PromptExecution>();
    const order: string[] = [];
    const backend = createBackend();
    backend.preparePrompt = vi.fn(async () => await preparation.promise);
    backend.cancelSession = vi.fn(async () => {
      throw new Error('cancel failed');
    });
    backend.closeSession = vi.fn(async () => {
      order.push('backend-close');
    });
    const client = acp
      .client({ name: 'term2-acp-test' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === 'state_update' && params.update.state === 'idle') {
          order.push('idle');
        }
      });
    const agent = createAgent(backend);

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'term2-acp-test', version: '1.0.0' },
      });

      const prompt = context.request(acp.methods.agent.session.prompt, {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'hi' }],
      });
      await vi.waitFor(() => expect(backend.preparePrompt).toHaveBeenCalledTimes(1));
      const close = expect(
        context.request(acp.methods.agent.session.close, { sessionId: 'session-1' }),
      ).rejects.toMatchObject({ code: -32603 });

      preparation.resolve({ run: async () => ({ stopReason: 'end_turn' }) });
      await expect(prompt).resolves.toEqual({});
      await close;
      expect(order).toEqual(['idle', 'backend-close']);
    });
  });

  it('carries prompt updates and cancellation over the newline-delimited JSON transport', async () => {
    const backend = createBackend();
    const execution: AcpV2PromptExecution = {
      run: async (_emit, signal) => {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        return { stopReason: 'cancelled' };
      },
    };
    backend.preparePrompt = vi.fn(async () => execution);
    const updates: acp.UpdateSessionNotification[] = [];
    const client = acp
      .client({ name: 'term2-acp-test' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const agent = createAgent(backend);

    await connectOverNdJson(agent, client, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'term2-acp-test', version: '1.0.0' },
      });
      await context.request(acp.methods.agent.session.prompt, {
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'hi' }],
      });
      await vi.waitFor(() =>
        expect(updates.at(-1)).toEqual({
          sessionId: 'session-1',
          update: { sessionUpdate: 'state_update', state: 'running' },
        }),
      );
      await context.notify(acp.methods.agent.session.cancel, { sessionId: 'session-1' });
      await vi.waitFor(() =>
        expect(updates.at(-1)).toEqual({
          sessionId: 'session-1',
          update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' },
        }),
      );
      await expect(context.request(acp.methods.agent.session.close, { sessionId: 'session-1' })).resolves.toEqual({});
    });

    expect(backend.cancelSession).toHaveBeenCalledWith('session-1');
    expect(backend.closeSession).toHaveBeenCalledWith('session-1');
  });
});
