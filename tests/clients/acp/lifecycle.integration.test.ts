import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { createAcpAgent } from '../../../src/clients/acp/agent.js';
import { createAcpBackend } from '../../../src/clients/acp/session-backend.js';
import { createDirectInProcessHost } from '../../../src/host/in-process-direct.js';
import type { DirectConnection, DirectHost } from '../../../src/host/in-process-direct-types.js';
import type { WireCommand } from '../../../src/protocol/wire.js';
import { createDirectSessionStore } from '../../../src/session/store.js';
import type { DirectSessionState } from '../../../src/session/facade-types.js';
import type { ItemId, Model, ModelRequest } from '../../../src/model/index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ModelCall = {
  request: ModelRequest;
  signal: AbortSignal;
  finish: ReturnType<typeof deferred>;
  cleanup: ReturnType<typeof deferred>;
};

// Only the external model is scripted. Admission, queue ownership, cancellation,
// terminal persistence and replay run through the real filesystem Session/Host.
async function nativeLifecycle(
  body: (fixture: {
    workspace: string;
    calls: ModelCall[];
    connect(): Promise<{
      context: acp.ClientContext;
      updates: acp.UpdateSessionNotification[];
      cancellationEntered: Promise<void>;
      closeEntered: Promise<void>;
      cancelled: Promise<void>;
      disconnect(): Promise<void>;
    }>;
    observer(sessionId: string): Promise<DirectConnection>;
    snapshot(sessionId: string): Promise<DirectSessionState>;
  }) => Promise<void>,
  options: {
    beforeSend?: (command: WireCommand) => Promise<void>;
    holdCleanup?: boolean;
  } = {},
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'acp-lifecycle-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  const calls: ModelCall[] = [];
  const model: Model = {
    ref: { provider: 'fixture', model: 'controlled' },
    contextWindow: 100_000,
    async *stream(request, signal) {
      const call = { request, signal, finish: deferred(), cleanup: deferred() };
      calls.push(call);
      if (!options.holdCleanup) call.cleanup.resolve();
      try {
        await Promise.race([
          call.finish.promise,
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
        if (signal.aborted) return;
        yield {
          type: 'item',
          item: {
            type: 'assistant_message',
            id: `answer-${calls.length}` as ItemId,
            content: [{ type: 'text', text: 'Done' }],
          },
        };
        yield { type: 'done', stopReason: 'end_turn' };
      } finally {
        await call.cleanup.promise;
      }
    },
  };
  const grant = { root: workspace, access: 'read_write' as const, target: 'local' };
  const sessions = createDirectSessionStore({
    directory: path.join(directory, 'sessions'),
    resolveWorkspace: () => grant,
    createRuntime: () => ({
      appVersion: 'fixture',
      profile: { id: 'fixture', version: '1', digest: 'fixture' },
      request: { instructions: 'Fixture', tools: [] },
      deps: {
        models: { resolve: () => model, list: () => [model.ref] },
        tools: { get: () => undefined, available: () => [] },
        toolContext: { workspace: grant, settings: { get: () => undefined, watch: () => () => {} } },
      },
    }),
  });
  const principal = { userId: 'fixture', via: 'local' as const };
  const nativeHost = createDirectInProcessHost({
    sessions,
    defaultModel: model.ref,
    authorize: () => {},
    resolveWorkspace: () => grant,
  });
  const wrap = (connection: DirectConnection): DirectConnection => ({
    ...connection,
    async send(command) {
      await options.beforeSend?.(command);
      return await connection.send(command);
    },
  });
  const host: DirectHost = {
    ...nativeHost,
    createSession: async (...args) => wrap(await nativeHost.createSession(...args)),
    connect: (async (owner, sessionId) => wrap(await nativeHost.connect(owner, sessionId))) as DirectHost['connect'],
  };
  const disposals: Array<() => Promise<void>> = [];
  try {
    await body({
      workspace,
      calls,
      observer: (sessionId) => nativeHost.connect(principal, sessionId),
      async snapshot(sessionId) {
        const capture = (await sessions.open(sessionId)).capture(() => {});
        capture.unsubscribe();
        return capture.state;
      },
      async connect() {
        const logger = { error: () => {} };
        const backend = createAcpBackend({
          host,
          principal,
          logger,
          workspaces: {
            authorize: async () => ({ workspaceId: 'fixture', access: 'read_write' }),
            cwd: async () => workspace,
          },
        });
        const cancelled = deferred();
        const cancellationEntered = deferred();
        const closeEntered = deferred();
        const updates: acp.UpdateSessionNotification[] = [];
        const inbound = new TransformStream<Uint8Array, Uint8Array>();
        const outbound = new TransformStream<Uint8Array, Uint8Array>();
        const agent = createAcpAgent({
          backend: {
            ...backend,
            async cancelSession(sessionId) {
              cancellationEntered.resolve();
              await backend.cancelSession(sessionId);
              cancelled.resolve();
            },
            async closeSession(sessionId) {
              closeEntered.resolve();
              await backend.closeSession(sessionId);
            },
          },
          logger,
          version: 'fixture',
        }).connect(acp.ndJsonStream(outbound.writable, inbound.readable));
        const client = acp
          .client({ name: 'independent-lifecycle-verifier' })
          .onNotification(acp.methods.client.session.update, ({ params }) => {
            updates.push(params);
          })
          .connect(acp.ndJsonStream(inbound.writable, outbound.readable));
        let disconnected = false;
        const disconnect = async () => {
          if (disconnected) return;
          disconnected = true;
          client.close();
          agent.close();
          await backend.shutdown();
        };
        disposals.push(disconnect);
        await client.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          info: { name: 'independent-lifecycle-verifier', version: '1' },
        });
        return {
          context: client.agent,
          updates,
          cancellationEntered: cancellationEntered.promise,
          closeEntered: closeEntered.promise,
          cancelled: cancelled.promise,
          disconnect,
        };
      },
    });
  } finally {
    for (const call of calls) {
      call.cleanup.resolve();
      call.finish.resolve();
    }
    for (const dispose of disposals.reverse()) await dispose();
    await nativeHost.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

const prompt = (context: acp.ClientContext, sessionId: string, text = 'controlled turn') =>
  context.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });

async function terminal(updates: acp.UpdateSessionNotification[], from = 0, reason = 'cancelled') {
  await expect
    .poll(
      () =>
        updates
          .slice(from)
          .some(
            ({ update }) =>
              update.sessionUpdate === 'state_update' && update.state === 'idle' && update.stopReason === reason,
          ),
      { timeout: 5_000 },
    )
    .toBe(true);
}

describe('independent ACP lifecycle verification over native Session and SDK', () => {
  it('retains a cancellation that arrives before submit admission returns', async () => {
    const admissionEntered = deferred();
    const admit = deferred();
    try {
      await nativeLifecycle(
        async ({ connect, workspace, calls, snapshot }) => {
          const client = await connect();
          const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
          const submitting = prompt(client.context, sessionId);
          await admissionEntered.promise;
          await client.context.notify(acp.methods.agent.session.cancel, { sessionId });
          // Wait until cancellation reached the real backend, then let admission
          // settle so cancellation can obtain the newly admitted turn identity.
          await client.cancellationEntered;
          admit.resolve();
          await submitting;
          await client.cancelled;
          await terminal(client.updates);
          expect(calls.every((call) => call.signal.aborted)).toBe(true);
          expect((await snapshot(sessionId)).terminal?.outcome).toBe('cancelled');
        },
        {
          async beforeSend(command) {
            if (command.type === 'submit') {
              admissionEntered.resolve();
              await admit.promise;
            }
          },
        },
      );
    } finally {
      admit.resolve();
    }
  }, 15_000);

  it('close during pending admission cancels that admitted turn before detaching', async () => {
    const admissionEntered = deferred();
    const admit = deferred();
    try {
      await nativeLifecycle(
        async ({ connect, workspace, calls, snapshot }) => {
          const client = await connect();
          const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
          const submitting = prompt(client.context, sessionId);
          await admissionEntered.promise;
          const closing = client.context.request(acp.methods.agent.session.close, { sessionId });
          await client.closeEntered;
          admit.resolve();
          await submitting;
          await expect
            .poll(async () => (await snapshot(sessionId)).terminal?.outcome, { timeout: 2_000 })
            .toBe('cancelled');
          await closing;
          expect(calls.every((call) => call.signal.aborted)).toBe(true);
          await expect(prompt(client.context, sessionId)).rejects.toMatchObject({ code: -32001 });
        },
        {
          async beforeSend(command) {
            if (command.type === 'submit') {
              admissionEntered.resolve();
              await admit.promise;
            }
          },
        },
      );
    } finally {
      admit.resolve();
    }
  }, 15_000);

  it('does not report idle or finish close until actual cancellation cleanup ends', async () => {
    await nativeLifecycle(
      async ({ connect, workspace, calls, snapshot }) => {
        const client = await connect();
        const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
        await prompt(client.context, sessionId);
        await expect.poll(() => calls.length).toBe(1);
        const from = client.updates.length;
        let closed = false;
        const closing = client.context.request(acp.methods.agent.session.close, { sessionId }).then(() => {
          closed = true;
        });
        await expect.poll(() => calls[0]!.signal.aborted).toBe(true);
        expect(closed).toBe(false);
        expect((await snapshot(sessionId)).terminal).toBeNull();
        expect(
          client.updates
            .slice(from)
            .some(({ update }) => update.sessionUpdate === 'state_update' && update.state === 'idle'),
        ).toBe(false);
        calls[0]!.cleanup.resolve();
        await closing;
        expect((await snapshot(sessionId)).terminal?.outcome).toBe('cancelled');
        await expect(prompt(client.context, sessionId)).rejects.toMatchObject({ code: -32001 });
      },
      { holdCleanup: true },
    );
  }, 15_000);

  it('rejects local/shared busy prompts and retains another client queued work on cancel', async () => {
    await nativeLifecycle(async ({ connect, workspace, calls, observer, snapshot }) => {
      const first = await connect();
      const second = await connect();
      const { sessionId } = await first.context.request(acp.methods.agent.session.new, { cwd: workspace });
      await second.context.request(acp.methods.agent.session.resume, { sessionId, cwd: workspace });
      await prompt(first.context, sessionId);
      await expect.poll(() => calls.length).toBe(1);
      await expect(prompt(first.context, sessionId, 'local concurrent')).rejects.toMatchObject({ code: -32000 });
      await expect(prompt(second.context, sessionId, 'shared concurrent')).rejects.toMatchObject({ code: -32000 });
      const external = await observer(sessionId);
      try {
        const queued = await external.send({
          type: 'submit',
          requestId: 'other-client-queued',
          text: 'retained follow-up',
          delivery: 'follow_up',
          origin: { kind: 'api' },
        });
        expect(queued).toMatchObject({ ok: true, kind: 'admitted', admission: { kind: 'queued' } });
        await first.context.notify(acp.methods.agent.session.cancel, { sessionId });
        await first.cancelled;
        await terminal(first.updates);
        const state = await snapshot(sessionId);
        const record = state.queue.records.find((record) => record.request.clientRequestId === 'other-client-queued');
        expect(record?.stage).toBe('queued');
        expect(state.queue.pending).toContain(record!.messageId);
        expect(state.queue.records).toHaveLength(2);
        await external.send({ type: 'queue_resume' });
        await expect.poll(() => calls.length).toBe(2);
        calls[1]!.finish.resolve();
        await expect.poll(async () => (await snapshot(sessionId)).terminal?.outcome).toBe('completed');
      } finally {
        external.close();
      }
    });
  }, 15_000);

  it('a delayed expected-turn cancel cannot cancel a replacement turn', async () => {
    const cancelEntered = deferred();
    const deliverCancel = deferred();
    try {
      await nativeLifecycle(
        async ({ connect, workspace, calls, observer, snapshot }) => {
          const client = await connect();
          const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
          await prompt(client.context, sessionId);
          await expect.poll(() => calls.length).toBe(1);
          await client.context.notify(acp.methods.agent.session.cancel, { sessionId });
          await cancelEntered.promise;
          calls[0]!.finish.resolve();
          await terminal(client.updates, 0, 'end_turn');
          const external = await observer(sessionId);
          try {
            expect(
              await external.send({
                type: 'submit',
                requestId: 'replacement',
                text: 'new turn',
                delivery: 'reject_if_busy',
              }),
            ).toMatchObject({ ok: true, admission: { kind: 'started' } });
            await expect.poll(() => calls.length).toBe(2);
            const replacement = (await snapshot(sessionId)).activeTurnId;
            deliverCancel.resolve();
            await client.cancelled;
            expect(calls[1]!.signal.aborted).toBe(false);
            expect((await snapshot(sessionId)).activeTurnId).toBe(replacement);
            calls[1]!.finish.resolve();
          } finally {
            external.close();
          }
        },
        {
          async beforeSend(command) {
            if (command.type === 'cancel') {
              cancelEntered.resolve();
              await deliverCancel.promise;
            }
          },
        },
      );
    } finally {
      deliverCancel.resolve();
    }
  }, 15_000);

  it('disconnect detaches the client and leaves shared native work running', async () => {
    await nativeLifecycle(async ({ connect, workspace, calls, observer, snapshot }) => {
      const client = await connect();
      const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
      await prompt(client.context, sessionId);
      await expect.poll(() => calls.length).toBe(1);
      const external = await observer(sessionId);
      try {
        await client.disconnect();
        expect(calls[0]!.signal.aborted).toBe(false);
        expect((await snapshot(sessionId)).status).toBe('running');
        calls[0]!.finish.resolve();
        await expect.poll(async () => (await snapshot(sessionId)).terminal?.outcome).toBe('completed');
        const resumed = await connect();
        await resumed.context.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd: workspace,
          replayFrom: { type: 'start' },
        });
        expect(resumed.updates.some(({ update }) => update.sessionUpdate === 'agent_message')).toBe(true);
        expect(resumed.updates.at(-1)?.update).toMatchObject({ state: 'idle' });
      } finally {
        external.close();
      }
    });
  }, 15_000);
});
