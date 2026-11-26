import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
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
// agent-wire-v2 is still served (frozen) for the external consumer: frames are checked with the shared parser.
const { parseEventEnvelope } = await browserModule('types');
// The browser presents the shared fold's snapshot (which is what the projection holds) with present().
const { present } = await browserModule('present');
const live = { phase: 'live', error: null };
const describeItems = (items: readonly Record<string, unknown>[]) =>
  items.map(({ kind, id, text, modelStep }) => ({ kind, id, text, ...(modelStep === undefined ? {} : { modelStep }) }));

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
    const envelopes = frames.map((frame) =>
      parseEventEnvelope(
        JSON.parse(
          frame
            .split('\n')
            .find((line) => line.startsWith('data: '))!
            .slice(6),
        ),
        'session-1',
      ),
    );
    expect(envelopes.map((envelope: { kind: string; seq?: number }) => [envelope.kind, envelope.seq])).toEqual([
      ['accepted', 3],
      ['accepted', 9],
      ['live', undefined],
    ]);
  } finally {
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function largeTextEvents(count: number, size: number) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let seq = 1; seq <= count; seq++)
        yield {
          sessionId: 'session-1',
          seq,
          occurredAt: '2026-11-07T00:00:00.000Z',
          turnId: 'turn-1',
          type: 'text_delta',
          payload: { messageId: 'message-1', modelStep: 1, delta: 'x'.repeat(size) },
        } as WireEvent;
    },
  };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

it('detaches a live reader that stops reading only after the drain timeout', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slow-v2-'));
  const socketPath = path.join(directory, 'gateway.sock');
  let released = false;
  const connection = {
    sessionId: 'session-1',
    snapshot: null,
    events: largeTextEvents(100, 256 * 1024),
    close() {
      released = true;
    },
  } as unknown as DirectConnection;
  const interactions = new ServerInteractions();
  const transport = new DirectServerTransport({
    socketPath,
    authentication: { verify: () => ({ sub: 'owner', purpose: 'events_connect' } as GatewayAssertionClaims) },
    handler: async () => agentWireV2EventStream(connection, (event) => encodeAgentWireV2(event, interactions)),
  });
  let request: http.ClientRequest | undefined;
  try {
    await transport.start();
    // Only the drain deadline is faked; socket I/O stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    request = http.get({ socketPath, path: '/', headers: { 'x-term2-assertion': 'transport-fixture' } }, (response) => {
      response.pause();
      response.on('error', () => {});
    });
    request.on('error', () => {});
    // Let the 25 MB burst fill the socket until the stream is waiting for drain.
    for (let turn = 0; turn < 5_000 && vi.getTimerCount() === 0; turn++) await nextTurn();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(9_000);
    for (let turn = 0; turn < 20; turn++) await nextTurn();
    expect(released).toBe(false);
    vi.advanceTimersByTime(2_000);
    for (let turn = 0; turn < 200 && !released; turn++) await nextTurn();
    expect(released).toBe(true);
  } finally {
    vi.useRealTimers();
    request?.destroy();
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps a resumed live stream through a burst while the reader briefly stops reading', async () => {
  // Regression: a full socket buffer during a burst disconnected the reader, and the web app
  // showed "Connection interrupted" mid-run. Every resumed (?after=) web stream takes this path.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'burst-v2-'));
  const socketPath = path.join(directory, 'gateway.sock');
  let released = false;
  const connection = {
    sessionId: 'session-1',
    snapshot: null,
    replay: { fromSeq: 0, toSeq: 0 },
    events: largeTextEvents(12, 64 * 1024),
    close() {
      released = true;
    },
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
          response.pause();
          setTimeout(() => response.resume(), 300);
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolve(body));
          response.on('error', reject);
        },
      );
      request.on('error', reject);
    });
    const ids = raw
      .split('\n\n')
      .flatMap((frame) => frame.split('\n').filter((line) => line.startsWith('id: ')))
      .map((line) => Number(line.slice(4)));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(released).toBe(true);
  } finally {
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('carries native orchestrator question lifecycle through HTTP SSE and the pinned browser parser', async () => {
  const { DirectTaskQuestions } = await import('../../../src/session/task-questions.js');
  const { taskFactEvents } = await import('../../../src/protocol/tasks.js');
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
      for (const event of taskFactEvents(
        fact,
        state as unknown as Parameters<typeof taskFactEvents>[1],
        events.length + 1,
      ))
        events.push({ ...event, occurredAt: new Date(fact.at).toISOString() });
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
    expect(closed).toBe(true);
  } finally {
    request?.destroy();
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps steered queued messages at their chronological position in the presented turn', async () => {
  const { DirectProjection } = await import('../../../src/protocol/projection.js');
  const { initialDirectState } = await import('../../../src/session/state.js');
  const { createDirectQueueState, planDirectQueue, submitDirectQueue } = await import('../../../src/session/queue.js');

  const at = '2026-11-25T00:00:00.000Z';
  const projection = new DirectProjection(
    initialDirectState(
      'session-1',
      { root: '/tmp', target: 'local', access: 'read' },
      { provider: 'openai', model: 'gpt-5' },
    ),
    0,
  );
  const events: WireEvent[] = [];
  let seq = 0;
  const emit = (
    fact: Parameters<typeof projection.update>[0] extends infer U
      ? U extends { type: 'fact'; fact: infer F }
        ? F
        : never
      : never,
  ) => {
    seq += 1;
    events.push(...projection.update({ type: 'fact', position: seq, seq, at, fact }));
  };

  let msgN = 0;
  let turnN = 0;
  const env = {
    newMessageId: () => `msg-${++msgN}`,
    newTurnId: () => `turn-${++turnN}` as import('../../../src/engine/index.js').TurnId,
    now: () => at,
    dispatchHeld: false,
  };
  let queue = createDirectQueueState();
  const initial = submitDirectQueue(
    queue,
    { clientRequestId: 'req-1', content: [{ type: 'text', text: 'first prompt' }], delivery: 'follow_up' },
    env,
  );
  queue = initial.state;
  for (const fact of initial.facts) emit(fact);
  emit({
    type: 'turn_started',
    turnId: 'turn-1' as import('../../../src/engine/index.js').TurnId,
    input: initial.effect?.kind === 'start' ? initial.effect.input : [],
  });
  emit({
    type: 'item',
    turnId: 'turn-1' as import('../../../src/engine/index.js').TurnId,
    modelStep: 1,
    item: {
      type: 'assistant_message',
      id: 'asst-1' as import('../../../src/model/index.js').ItemId,
      content: [{ type: 'text', text: 'working on it' }],
    },
  });

  const steered = submitDirectQueue(
    queue,
    { clientRequestId: 'req-2', content: [{ type: 'text', text: 'also check this' }], delivery: 'steer' },
    { ...env, dispatchHeld: true },
    'turn-1' as import('../../../src/engine/index.js').TurnId,
  );
  queue = steered.state;
  for (const fact of steered.facts) emit(fact);

  const boundary = planDirectQueue(
    queue,
    { kind: 'boundary', turnId: 'turn-1' as import('../../../src/engine/index.js').TurnId },
    env,
  );
  queue = boundary.state;
  for (const fact of boundary.facts) emit(fact);

  emit({
    type: 'item',
    turnId: 'turn-1' as import('../../../src/engine/index.js').TurnId,
    modelStep: 2,
    item: {
      type: 'assistant_message',
      id: 'asst-2' as import('../../../src/model/index.js').ItemId,
      content: [{ type: 'text', text: 'checked it' }],
    },
  });
  emit({
    type: 'turn_ended',
    turnId: 'turn-1' as import('../../../src/engine/index.js').TurnId,
    outcome: 'completed',
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'steer-v2-'));
  const socketPath = path.join(directory, 'gateway.sock');
  const interactions = new ServerInteractions();
  const connection = {
    sessionId: 'session-1',
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    close() {},
  } as unknown as DirectConnection;
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
    let raw = '';
    for await (const chunk of response) raw += chunk.toString();
    const received = raw
      .split('\n\n')
      .filter((frame) => frame.split('\n').some((line) => line.startsWith('id:')))
      .map((frame) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '))!;
        return parseEventEnvelope(JSON.parse(data.slice(6)), 'session-1');
      });

    // The steer waits in the queue on the wire, then lands in the turn.
    const queued = received.some(
      (envelope: { changes: { type: string; payload: { entries?: { text?: string }[] } }[] }) =>
        envelope.changes.some(
          (change) =>
            change.type === 'queue_changed' &&
            change.payload.entries?.some((entry) => entry.text === 'also check this'),
        ),
    );
    expect(queued).toBe(true);

    const view = present('session-1', JSON.parse(JSON.stringify(projection.snapshot)), new Map(), live);
    expect(view.session?.queue).toEqual([]);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.userText).toBe('first prompt');
    expect(view.turns[0]?.userMessageId).toBe('msg-1');
    expect(describeItems(view.turns[0]?.items ?? [])).toEqual([
      { kind: 'text', id: 'asst-1', text: 'working on it', modelStep: 1 },
      { kind: 'user', id: 'msg-2', text: 'also check this' },
      { kind: 'text', id: 'asst-2', text: 'checked it', modelStep: 2 },
    ]);
  } finally {
    request?.destroy();
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it('preserves provider error messages on a failed turn, on the v2 wire and in the presented turn', async () => {
  const { DirectProjection } = await import('../../../src/protocol/projection.js');
  const { initialDirectState } = await import('../../../src/session/state.js');
  const { createDirectQueueState, submitDirectQueue } = await import('../../../src/session/queue.js');

  const at = '2026-11-25T01:16:42.000Z';
  const projection = new DirectProjection(
    initialDirectState(
      'session-1',
      { root: '/tmp', target: 'local', access: 'read' },
      { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' },
    ),
    0,
  );
  const events: WireEvent[] = [];
  let seq = 0;
  const emit = (
    fact: Parameters<typeof projection.update>[0] extends infer U
      ? U extends { type: 'fact'; fact: infer F }
        ? F
        : never
      : never,
  ) => {
    seq += 1;
    events.push(...projection.update({ type: 'fact', position: seq, seq, at, fact }));
  };

  let msgN = 0;
  let turnN = 0;
  const env = {
    newMessageId: () => `msg-${++msgN}`,
    newTurnId: () => `turn-${++turnN}` as import('../../../src/engine/index.js').TurnId,
    now: () => at,
    dispatchHeld: false,
  };
  const initial = submitDirectQueue(
    createDirectQueueState(),
    { clientRequestId: 'req-1', content: [{ type: 'text', text: 'Are we ready to release?' }], delivery: 'follow_up' },
    env,
  );
  for (const fact of initial.facts) emit(fact);
  emit({
    type: 'turn_started',
    turnId: 'turn-1' as import('../../../src/engine/index.js').TurnId,
    input: initial.effect?.kind === 'start' ? initial.effect.input : [],
  });
  emit({
    type: 'turn_ended',
    turnId: 'turn-1' as import('../../../src/engine/index.js').TurnId,
    outcome: 'failed',
    error: {
      kind: 'invalid_request',
      message: '400 Request path cannot be relayed',
      retryable: false,
    },
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'failed-turn-v2-'));
  const socketPath = path.join(directory, 'gateway.sock');
  const interactions = new ServerInteractions();
  const connection = {
    sessionId: 'session-1',
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    close() {},
  } as unknown as DirectConnection;
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
    let raw = '';
    for await (const chunk of response) raw += chunk.toString();
    const received = raw
      .split('\n\n')
      .filter((frame) => frame.split('\n').some((line) => line.startsWith('id:')))
      .map((frame) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '))!;
        return parseEventEnvelope(JSON.parse(data.slice(6)), 'session-1');
      });

    // The v2 wire carries the provider's words on the failed turn.
    expect(JSON.stringify(received)).toContain('400 Request path cannot be relayed');

    const view = present('session-1', JSON.parse(JSON.stringify(projection.snapshot)), new Map(), live);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.status).toBe('failed');
    expect(view.turns[0]?.error).toBe('runtime_error');
    expect(view.turns[0]?.errorMessage).toBe('400 Request path cannot be relayed');
  } finally {
    request?.destroy();
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
