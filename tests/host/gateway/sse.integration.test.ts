import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DirectServerTransport } from '../../../src/host/server-transport.js';
import { agentWireV2EventStream } from '../../../src/host/server-sse.js';
import type { DirectConnection } from '../../../src/host/in-process-direct-types.js';
import type { GatewayAssertionClaims } from '../../../src/host/server-contracts.js';
import { ServerInteractions } from '../../../src/host/server-interactions.js';
import { encodeAgentWireV2 } from '../../../src/host/server-wire-v2.js';
import type { WireEvent } from '../../../src/protocol/wire.js';
import type { DirectTaskId } from '../../../src/session/background-types.js';
const browserModule = (name: string) =>
  import(new URL(`../../../web-client/lib/term2/${name}.ts`, import.meta.url).href);
const { parseEventEnvelope } = await browserModule('types');
const { applyTerm2Event, emptyTerm2SessionView } = await browserModule('event-adapter');

it('establishes an idle v2 stream before any event and closes its attachment on browser disconnect', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'idle-v2-'));
  const socketPath = path.join(directory, 'gateway.sock');
  let release!: () => void;
  let closed = false;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connection = {
    sessionId: 'session-1',
    snapshot: null,
    events: {
      [Symbol.asyncIterator]: () => ({
        async next() {
          await stopped;
          return { done: true, value: undefined };
        },
      }),
    },
    close() {
      closed = true;
      release();
    },
  } as unknown as DirectConnection;
  const transport = new DirectServerTransport({
    socketPath,
    // Authentication is covered by serve.integration; isolate the idle transport handshake.
    authentication: { verify: () => ({ sub: 'owner', purpose: 'events_connect' } as GatewayAssertionClaims) },
    handler: async () => agentWireV2EventStream(connection, () => null),
  });
  let request: http.ClientRequest | undefined;
  try {
    await transport.start();
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request = http.get({ socketPath, path: '/', headers: { 'x-term2-assertion': 'transport-fixture' } }, resolve);
      request.on('error', reject);
      request.setTimeout(1500, () => {
        request?.destroy(new Error('idle SSE handshake was not flushed'));
      });
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-term2-event-format']).toBe('agent-wire-v2');
    expect(response.headers['x-term2-event-mode']).toBe('live');
    response.destroy();
    await stopped;
    expect(closed).toBe(true);
  } finally {
    request?.destroy();
    await transport.stop();
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps real sparse tail boundaries ahead of cursorless live observations over HTTP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tail-v2-'));
  const socketPath = path.join(directory, 'gateway.sock');
  const at = '2026-11-07T00:00:00.000Z';
  const events: WireEvent[] = [
    {
      sessionId: 'session-1',
      seq: 3,
      occurredAt: at,
      turnId: 'turn-1',
      type: 'turn_started',
      payload: {
        foreground: true,
        input: [
          {
            id: 'real-user-id',
            role: 'user',
            text: 'accepted input',
            content: [{ type: 'text', text: 'accepted input' }],
            turnId: 'turn-1',
          },
        ],
      },
    },
    {
      sessionId: 'session-1',
      seq: 9,
      occurredAt: at,
      turnId: 'turn-1',
      type: 'turn_ended',
      payload: { outcome: 'completed', finalText: 'accepted text' },
    },
    {
      sessionId: 'session-1',
      seq: null,
      turnId: 'turn-2',
      type: 'reasoning_delta',
      payload: { delta: 'live', messageId: 'message-2', modelStep: 1 },
    },
  ];
  const connection = {
    sessionId: 'session-1',
    snapshot: null,
    replay: { fromSeq: 1, toSeq: 9 },
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    close() {},
  };
  const interactions = new ServerInteractions();
  const transport = new DirectServerTransport({
    socketPath,
    authentication: { verify: () => ({ sub: 'owner', purpose: 'events_connect' } as GatewayAssertionClaims) },
    handler: async () => agentWireV2EventStream(connection as never, (event) => encodeAgentWireV2(event, interactions)),
  });
  try {
    await transport.start();
    const raw = await new Promise<string>((resolve, reject) => {
      const request = http.get(
        { socketPath, path: '/', headers: { 'x-term2-assertion': 'transport-fixture' } },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolve(body));
          response.on('error', reject);
        },
      );
      request.on('error', reject);
    });
    const frames = raw
      .trim()
      .split('\n\n')
      .filter((frame) => frame.startsWith('event:'));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toContain('event: accepted\nid: 3\n');
    expect(frames[1]).toContain('event: accepted\nid: 9\n');
    expect(frames[2]).toContain('event: live\ndata:');
    expect(frames[2]).not.toMatch(/^id:/m);
    expect(raw).not.toContain('event: snapshot');
    let view = emptyTerm2SessionView('session-1');
    for (const frame of frames) {
      const value = JSON.parse(
        frame
          .split('\n')
          .find((line) => line.startsWith('data: '))!
          .slice(6),
      );
      view = applyTerm2Event(view, parseEventEnvelope(value, 'session-1'));
    }
    expect(view.lastAppliedSequence).toBe(9);
    expect(view.turns).toMatchObject([
      { turnId: 'turn-1', userText: 'accepted input', text: 'accepted text', status: 'completed' },
    ]);
    expect(view.nativeState?.messages).toMatchObject([{ message: { id: 'real-user-id', turnId: 'turn-1' } }]);
  } finally {
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('disconnects a backpressured live reader and releases the native attachment', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slow-v2-'));
  const socketPath = path.join(directory, 'gateway.sock');
  let release!: () => void;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connection = {
    sessionId: 'session-1',
    snapshot: null,
    events: {
      async *[Symbol.asyncIterator]() {
        for (let seq = 1; seq <= 100; seq++)
          yield {
            sessionId: 'session-1',
            seq,
            occurredAt: '2026-11-07T00:00:00.000Z',
            turnId: 'turn-1',
            type: 'text_delta',
            payload: { messageId: 'message-1', modelStep: 1, delta: 'x'.repeat(256 * 1024) },
          } as WireEvent;
      },
    },
    close() {
      release();
    },
  } as unknown as DirectConnection;
  const interactions = new ServerInteractions();
  const transport = new DirectServerTransport({
    socketPath,
    authentication: { verify: () => ({ sub: 'owner', purpose: 'events_connect' } as GatewayAssertionClaims) },
    handler: async () => agentWireV2EventStream(connection, (event) => encodeAgentWireV2(event, interactions)),
  });
  let request: http.ClientRequest | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await transport.start();
    request = http.get({ socketPath, path: '/', headers: { 'x-term2-assertion': 'transport-fixture' } }, (response) => {
      response.pause();
      response.on('error', () => {});
    });
    request.on('error', () => {});
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('backpressure did not release attachment')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    request?.destroy();
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('carries native orchestrator question lifecycle through HTTP SSE and the pinned browser parser', async () => {
  const { DirectTaskQuestions } = await import('../../../src/session/task-questions.js');
  const { taskFactEvent } = await import('../../../src/protocol/tasks.js');
  const { directQuestionNotice } = await import('../../../src/session/notifications.js');
  const taskId = 'child' as DirectTaskId;
  const task = {
    id: taskId,
    turnId: 'parent',
    status: 'running' as const,
    mode: 'background' as const,
    lastObservation: { kind: 'question_asked', at: 2 },
    lastToolName: 'ask_orchestrator',
    lastTool: { label: 'ask_orchestrator question', state: 'running' },
    toolCounts: [{ toolName: 'ask_orchestrator', count: 1 }],
  };
  const state = { sessionId: 'session-1', tasks: [task], pendingInteractions: [] };
  const events: WireEvent[] = [];
  const questions = new DirectTaskQuestions(
    (fact) => {
      if (fact.type !== 'task_question_opened' && fact.type !== 'task_question_closed')
        throw new Error('Unexpected non-question fact');
      events.push({
        ...taskFactEvent(fact, state as unknown as Parameters<typeof taskFactEvent>[1], events.length + 1),
        occurredAt: new Date(fact.at).toISOString(),
      });
    },
    () => 2,
  );
  const answer = questions.ask(taskId, 'Which approach?');
  const pending = questions.pending(taskId)!;
  expect(questions.answer(taskId, 'worker', 'Use the simple approach.', pending.messageId).ok).toBe(true);
  await expect(answer).resolves.toBe('Use the simple approach.');
  const notice = directQuestionNotice(
    { taskId, role: 'explorer', name: 'worker' } as Parameters<typeof directQuestionNotice>[0],
    pending,
  );
  events.push({
    sessionId: 'session-1',
    seq: 3,
    occurredAt: new Date(2).toISOString(),
    turnId: null,
    type: 'background_notice_enqueued',
    payload: { notice },
  });
  let closed = false;
  const connection = {
    sessionId: 'session-1',
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    close() {
      closed = true;
    },
  } as unknown as DirectConnection;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'question-v2-'));
  const socketPath = path.join(directory, 'gateway.sock');
  const interactions = new ServerInteractions();
  const transport = new DirectServerTransport({
    socketPath,
    authentication: { verify: () => ({ sub: 'owner', purpose: 'events_connect' } as GatewayAssertionClaims) },
    handler: async () => agentWireV2EventStream(connection, (event) => encodeAgentWireV2(event, interactions)),
  });
  let request: http.ClientRequest | undefined;
  try {
    await transport.start();
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request = http.get({ socketPath, path: '/', headers: { 'x-term2-assertion': 'transport-fixture' } }, resolve);
      request.on('error', reject);
    });
    let frames = '';
    for await (const chunk of response) frames += chunk.toString();
    const received = frames
      .split('\n\n')
      .filter((frame) => frame.split('\n').some((line) => line.startsWith('id:')))
      .map((frame) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '))!;
        return parseEventEnvelope(JSON.parse(data.slice(6)), 'session-1');
      });
    expect(received.slice(0, 2).map((event) => event.changes[0].payload.change)).toEqual([
      'task_question_opened',
      'task_question_closed',
    ]);
    expect(received[2].changes[0].type).toBe('background_notice_enqueued');
    expect(received[0].changes[0].payload.task.pendingQuestion).toEqual(pending);
    expect(received[0].changes[0].payload.task.status).toBe('awaiting_interaction');
    expect(received[1].changes[0].payload.task).not.toHaveProperty('pendingQuestion');
    expect(received[1].changes[0].payload.task.status).toBe('running');
    expect(received.map((event) => event.seq)).toEqual([1, 2, 3]);
    const opened = applyTerm2Event(emptyTerm2SessionView('session-1'), received[0]);
    expect(opened.nativeState?.tasks).toMatchObject([
      { ...task, status: 'awaiting_interaction', pendingQuestion: pending },
    ]);
    const settled = applyTerm2Event(opened, received[1]);
    expect(settled.nativeState?.tasks).toHaveLength(1);
    expect(settled.nativeState?.tasks?.[0]).not.toHaveProperty('pendingQuestion');
    expect(settled.nativeState?.tasks?.[0].status).toBe('running');
    expect(settled.nativeState?.tasks?.[0]).toMatchObject(task);
    expect(settled.lastAppliedSequence).toBe(2);
    const notified = applyTerm2Event(settled, received[2]);
    expect(notified.nativeState?.notifications?.notices).toEqual([notice]);
    expect(notified.lastAppliedSequence).toBe(3);
    expect(closed).toBe(true);
  } finally {
    request?.destroy();
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
