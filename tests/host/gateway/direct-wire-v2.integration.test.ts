import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DirectAttachment } from '../../../src/host/in-process-direct-attachment.js';
import { directReplayView } from '../../../src/host/in-process-direct-replay.js';
import type { DirectConnection, DirectReplayConnection } from '../../../src/host/in-process-direct-types.js';
import type { GatewayAssertionClaims } from '../../../src/host/server-contracts.js';
import { ServerInteractions } from '../../../src/host/server-interactions.js';
import { directWireV2EventStream } from '../../../src/host/server-sse.js';
import { DirectServerTransport } from '../../../src/host/server-transport.js';
import { reduceWireEvent } from '../../../src/protocol/reducer.js';
import type { WireEvent, WireSnapshot } from '../../../src/protocol/wire.js';
import type { DirectSession, DirectSessionUpdate } from '../../../src/session/facade-types.js';
import type { Fact } from '../../../src/session/facts.js';
import type { ExecutionId } from '../../../src/tools/index.js';
import { initialDirectState, reduceDirectFact } from '../../../src/session/state.js';
// The browser's present(), loaded at the runtime boundary like the other web-client modules gateway tests read.
const { present } = await import(new URL('../../../web-client/lib/term2/present.ts', import.meta.url).href);

/**
 * The direct-wire-v2 stream over real HTTP: a scripted Session behind the real attachment, the real encoder and
 * the real Unix-socket transport. A client folds every frame with the shared fold, as the browser does, and
 * must end with the server's own snapshot. Built on the acceptance example in
 * docs/plans/web-client/web-transcript-single-source-spec.md, section 3 (without its steer, which needs a
 * real queue; the browser steer flow covers that).
 */

const SESSION = 'conv_direct_wire';
const AT = '2026-11-26T00:00:00.000Z';
/** Fixture facts use plain strings where production brands its ids. */
const fact = (value: unknown) => value as Fact;
const user = (id: string, text: string) => ({ type: 'user_message', id, content: [{ type: 'text', text }] } as const);

/** Section 3's facts, in order. `live` marks a transient; everything else is an accepted fact. */
const SCRIPT: ({ fact: Fact } | { live: Extract<DirectSessionUpdate, { type: 'transient' }>['event'] })[] = [
  { fact: fact({ type: 'turn_started', turnId: 'turn-1', input: [user('user-1', 'first prompt')] }) },
  { live: { type: 'reasoning_delta', delta: 'Plan' } },
  {
    fact: fact({
      type: 'item',
      turnId: 'turn-1',
      modelStep: 1,
      item: { type: 'reasoning', id: 'rs-1', summary: 'Plan: read the file.' },
    }),
  },
  { fact: fact({ type: 'text_delta', turnId: 'turn-1', modelStep: 1, delta: 'Let me ' }) },
  { fact: fact({ type: 'text_delta', turnId: 'turn-1', modelStep: 1, delta: 'look.' }) },
  // A client connecting here sees the draft "Let me look." in its opening snapshot.
  {
    fact: fact({
      type: 'item',
      turnId: 'turn-1',
      modelStep: 1,
      item: { type: 'assistant_message', id: 'asst-1', content: [{ type: 'text', text: 'Let me look.' }] },
    }),
  },
  {
    fact: fact({
      type: 'item',
      turnId: 'turn-1',
      modelStep: 1,
      executionId: 'exec-1',
      item: { type: 'tool_call', id: 'call-item-1', callId: 'call-1', toolName: 'shell', input: { command: 'ls' } },
    }),
  },
  {
    fact: fact({
      type: 'tool_started',
      turnId: 'turn-1',
      executionId: 'exec-1',
      callId: 'call-1',
      toolName: 'shell',
      input: { command: 'ls' },
    }),
  },
  { live: { type: 'tool_progress', executionId: 'exec-1' as ExecutionId, chunk: 'a.txt\n' } },
  {
    fact: fact({
      type: 'tool_finished',
      turnId: 'turn-1',
      executionId: 'exec-1',
      result: { output: 'a.txt\nb.txt', isError: false },
    }),
  },
  {
    fact: fact({
      type: 'usage',
      turnId: 'turn-1',
      modelStep: 1,
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 },
    }),
  },
  // Accepted but not shown: an empty accepted frame that still moves the client's checkpoint.
  {
    fact: fact({
      type: 'item',
      turnId: 'turn-1',
      display: false,
      item: { type: 'assistant_message', id: 'hidden-1', content: [{ type: 'text', text: 'internal' }] },
    }),
  },
  {
    fact: fact({
      type: 'item',
      turnId: 'turn-1',
      modelStep: 2,
      item: { type: 'assistant_message', id: 'asst-2', content: [{ type: 'text', text: 'Two files.' }] },
    }),
  },
  { fact: fact({ type: 'turn_ended', turnId: 'turn-1', outcome: 'completed' }) },
  { fact: fact({ type: 'turn_started', turnId: 'turn-2', input: [user('user-2', 'second prompt')] }) },
  {
    fact: fact({
      type: 'item',
      turnId: 'turn-2',
      modelStep: 1,
      executionId: 'exec-2',
      item: { type: 'tool_call', id: 'call-item-2', callId: 'call-2', toolName: 'shell', input: { command: 'false' } },
    }),
  },
  {
    fact: fact({
      type: 'tool_started',
      turnId: 'turn-2',
      executionId: 'exec-2',
      callId: 'call-2',
      toolName: 'shell',
      input: { command: 'false' },
    }),
  },
  {
    fact: fact({
      type: 'tool_finished',
      turnId: 'turn-2',
      executionId: 'exec-2',
      result: { output: 'exit 1', isError: true },
    }),
  },
  {
    fact: fact({
      type: 'turn_ended',
      turnId: 'turn-2',
      outcome: 'failed',
      error: { kind: 'rate_limit', message: '429 slow down', retryable: true },
    }),
  },
  // A result whose call this session never accepted: kept as unmatched evidence, never a tool card (rule 5).
  {
    fact: fact({
      type: 'tool_finished',
      turnId: 'turn-2',
      executionId: 'orphan-exec',
      result: { output: 'retained output', isError: false },
    }),
  },
];
const ACCEPTED = SCRIPT.filter((step) => 'fact' in step).length;

/** A Session that publishes the script on demand and replays what it has accepted, as Session.captureFrom does. */
function scriptedSession(script: typeof SCRIPT = SCRIPT) {
  let state = initialDirectState(
    SESSION,
    { root: '/workspace', access: 'read_write', target: 'local' },
    { provider: 'p', model: 'm' },
  );
  const accepted: Extract<DirectSessionUpdate, { type: 'fact' }>[] = [];
  const listeners = new Set<(update: DirectSessionUpdate) => void>();
  let position = 0;
  let next = 0;
  const session = {
    id: SESSION,
    captureFrom(_fromSeq: number, listener: (update: DirectSessionUpdate) => void) {
      listeners.add(listener);
      return {
        state,
        position,
        seq: accepted.length,
        replay: [...accepted],
        unsubscribe: () => listeners.delete(listener),
      };
    },
  } as unknown as DirectSession;
  /** Publishes the next `count` steps of the script. */
  const publish = (count: number) => {
    for (const step of script.slice(next, next + count)) {
      position += 1;
      let update: DirectSessionUpdate;
      if ('fact' in step) {
        const seq = accepted.length + 1;
        state = reduceDirectFact(state, step.fact, seq);
        update = { type: 'fact', position, seq, at: AT, fact: step.fact };
        accepted.push(update);
      } else update = { type: 'transient', position, event: step.live };
      for (const listener of listeners) listener(update);
    }
    next += count;
  };
  /** What a poisoned writer publishes: no accepted terminal, just Session state interrupted with its error. */
  const fault = (message: string) => {
    position += 1;
    state = {
      ...state,
      status: 'interrupted',
      runtimeError: { kind: 'provider', message, retryable: false }, // as session.ts sets it on a writer fault
    } as typeof state;
    for (const listener of listeners) listener({ type: 'state', position, state: state as never });
  };
  return { session, publish, fault, remaining: () => script.length - next };
}

type Frame = {
  event: string;
  id?: string;
  data: { kind: string; seq?: number | null; events: WireEvent[]; interactions?: unknown };
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Serves one connection's direct-wire-v2 stream over a Unix socket and reads its frames as they arrive. */
async function serve(connection: DirectConnection | DirectReplayConnection) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'direct-wire-v2-'));
  const socketPath = path.join(directory, 'gateway.sock');
  const result = directWireV2EventStream(connection, new ServerInteractions());
  if (!result) throw new Error('direct-wire-v2 is unavailable for this connection');
  const transport = new DirectServerTransport({
    socketPath,
    authentication: { verify: () => ({ sub: 'owner', purpose: 'events_connect' } as GatewayAssertionClaims) },
    handler: async () => result,
  });
  await transport.start();
  const frames: Frame[] = [];
  const waiting: { count: number; resolve: () => void }[] = [];
  let buffer = '';
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get({ socketPath, path: '/', headers: { 'x-term2-assertion': 'fixture' } }, resolve);
    request.on('error', reject);
    cleanup.push(async () => void request.destroy());
  });
  response.setEncoding('utf8');
  response.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) =>
        block
          .split('\n')
          .find((line) => line.startsWith(`${name}: `))
          ?.slice(name.length + 2);
      const data = field('data');
      if (data) frames.push({ event: field('event')!, id: field('id'), data: JSON.parse(data) });
    }
    for (const waiter of waiting.filter((entry) => frames.length >= entry.count)) waiter.resolve();
  });
  cleanup.push(async () => {
    await transport.stop();
    await rm(directory, { recursive: true, force: true });
  });
  /** Resolves when `count` frames have arrived; the timer only bounds the wait. */
  const until = async (count: number) => {
    if (frames.length < count) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => waiting.push({ count, resolve })),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`expected ${count} frames, got ${frames.length}`)), 5_000);
        }),
      ]).finally(() => clearTimeout(deadline));
    }
    return frames.slice(0, count);
  };
  return { response, until };
}

/** What the browser's store does: install the opening snapshot, fold every event, hold accepted checkpoints. */
function fold(frames: readonly Frame[]): WireSnapshot {
  let state: WireSnapshot | null = null;
  for (const { data } of frames) {
    for (const event of data.events)
      state =
        state === null || event.type === 'snapshot'
          ? (event as Extract<WireEvent, { type: 'snapshot' }>).payload.snapshot
          : reduceWireEvent(state, event);
    if (data.kind === 'accepted') state = { ...state!, seq: data.seq! };
  }
  return state!;
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

it('a client that connects mid-turn folds the opening snapshot and every later frame into the server snapshot', async () => {
  const { session, publish, remaining } = scriptedSession();
  // Four steps in, turn 1 is streaming its first reply as a draft.
  publish(4);
  const attachment = new DirectAttachment(session);
  cleanup.push(async () => attachment.close());
  const view = attachment.connect();
  // Published after this connection's queue exists but before its stream reads the cut: it is both queued and
  // in the opening snapshot, and must reach the client once (applied twice, the draft would read "look.look.").
  publish(1);
  const connection: DirectConnection = {
    sessionId: SESSION,
    get snapshot() {
      return view.snapshot;
    },
    events: view.events,
    batches: () => view.events.batches(),
    cut: view.cut,
    send: async () => ({ ok: false, code: 'closed', message: 'not used' }),
    close: () => view.events.close(),
  };
  const { response, until } = await serve(connection);
  expect(response.headers['x-term2-event-format']).toBe('direct-wire-v2');
  expect(response.headers['x-term2-event-mode']).toBe('snapshot-live');

  const [opening] = await until(1);
  expect(opening!.event).toBe('snapshot');
  expect(opening!.id).toBe('4');
  const draft = opening!.data.events.at(-1) as Extract<WireEvent, { type: 'snapshot' }>;
  expect(draft.payload.snapshot.messages.filter((message) => message.draft).map((message) => message.text)).toEqual([
    'Let me look.',
  ]);

  const rest = remaining();
  publish(rest);
  const frames = await until(1 + rest);
  // One frame per publication after the cut, in order; nothing from before the cut is sent twice.
  expect(frames.slice(1).map((frame) => frame.event)).toEqual(
    SCRIPT.slice(5).map((step) => ('fact' in step ? 'accepted' : 'live')),
  );
  expect(frames.filter((frame) => frame.event === 'accepted').map((frame) => Number(frame.id))).toEqual(
    Array.from({ length: ACCEPTED - 4 }, (_, index) => index + 5),
  );
  // The hidden message is an empty accepted frame that still carries its seq.
  expect(frames.find((frame) => frame.data.kind === 'accepted' && frame.data.events.length === 0)?.id).toBe('10');

  const client = fold(frames);
  expect(json(client)).toEqual(json(view.snapshot));
  expect(client.seq).toBe(ACCEPTED);
  // Section 3's expectations that the snapshot carries today.
  const turn1 = client.messages.filter((message) => message.turnId === 'turn-1');
  expect(turn1.map((message) => [message.role, message.text])).toEqual([
    ['user', 'first prompt'],
    ['assistant', 'Let me look.'],
    ['assistant', 'Two files.'],
  ]);
  expect(client.tools.map((tool) => [tool.executionId, tool.status, tool.output, tool.isError])).toEqual([
    ['exec-1', 'completed', 'a.txt\nb.txt', false],
    ['exec-2', 'completed', 'exit 1', true],
  ]);
  // Reasoning keeps its place after a reload: rs-1 was said right after the opening prompt.
  expect(client.reasoningBlocks).toEqual([
    {
      messageId: 'rs-1',
      turnId: 'turn-1',
      modelStep: 1,
      text: 'Plan: read the file.',
      after: { kind: 'message', id: 'user-1' },
    },
  ]);
  // Live reasoning ended with its summary; per-reply usage is the turn's last report, and turn 2 reported none.
  expect(client.liveReasoning).toBeUndefined();
  expect(client.turnUsage).toEqual([
    { turnId: 'turn-1', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 } },
  ]);
  // Section 3's expected view, as the browser presents the folded snapshot (without the steer).
  const presented = present(SESSION, client, new Map(), { phase: 'live', error: null });
  const describe = (item: { kind: string; id?: string; executionId?: string }) =>
    `${item.kind} ${item.kind === 'tool' ? item.executionId : item.id}`;
  expect(presented.turns.map((turn: { turnId: string }) => turn.turnId)).toEqual(['turn-1', 'turn-2']);
  const [first, second] = presented.turns;
  expect(first.userText).toBe('first prompt');
  expect(first.items.map(describe)).toEqual(['reasoning rs-1', 'text asst-1', 'tool exec-1', 'text asst-2']);
  expect(first.commands).toMatchObject([{ callId: 'exec-1', status: 'completed', output: 'a.txt\nb.txt' }]);
  expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  expect(first.status).toBe('completed');
  expect(second.userText).toBe('second prompt');
  expect(second.items.map(describe)).toEqual(['tool exec-2']);
  expect(client.unmatchedToolResults?.map((result) => result.executionId)).toEqual(['orphan-exec']);
  expect(second.commands.map((command: { callId: string }) => command.callId)).toEqual(['exec-2']);
  expect(second.commands).toMatchObject([{ callId: 'exec-2', status: 'failed', error: 'exit 1' }]);
  expect(second).toMatchObject({ status: 'failed', error: 'rate_limit', errorMessage: '429 slow down' });
  expect(second.usage).toBeUndefined();
  expect(client.turnResults?.map((result) => [result.turnId, result.outcome, result.error?.message])).toEqual([
    ['turn-1', 'completed', undefined],
    ['turn-2', 'failed', '429 slow down'],
  ]);
});

it('a reconnect with a cursor gets the accepted tail, then the replay snapshot, and ends at the same state', async () => {
  const { session, publish } = scriptedSession();
  publish(SCRIPT.length);
  const view = directReplayView(session, 6);
  const connection: DirectReplayConnection = {
    sessionId: SESSION,
    snapshot: null,
    replay: view.replay,
    events: view.events,
    batches: () => view.events.batches(),
    send: async () => ({ ok: false, code: 'closed', message: 'not used' }),
    close: () => view.events.close(),
  };
  const { response, until } = await serve(connection);
  expect(response.headers['x-term2-event-mode']).toBe('replay-live');
  expect(response.headers['x-term2-replay-from']).toBe('6');
  const frames = await until(ACCEPTED - 6 + 1);
  expect(frames.slice(0, -1).map((frame) => [frame.event, frame.id])).toEqual(
    Array.from({ length: ACCEPTED - 6 }, (_, index) => ['accepted', String(index + 7)]),
  );
  const last = frames.at(-1)!;
  expect(last.event).toBe('snapshot');
  expect(last.id).toBe(String(ACCEPTED));

  // A client that held the state at seq 6 (from a first connection) folds the tail and the snapshot.
  const first = scriptedSession();
  first.publish(
    SCRIPT.findIndex((_, index) => SCRIPT.slice(0, index + 1).filter((step) => 'fact' in step).length === 6) + 1,
  );
  const held = new DirectAttachment(first.session);
  cleanup.push(async () => held.close());
  const atSix = held.connect().snapshot;
  expect(atSix.seq).toBe(6);
  const client = fold([
    {
      event: 'snapshot',
      data: {
        kind: 'snapshot',
        events: [
          {
            sessionId: SESSION,
            seq: null,
            occurredAt: null,
            turnId: null,
            type: 'snapshot',
            payload: { snapshot: atSix },
          } as WireEvent,
        ],
      },
    },
    ...frames,
  ]);
  const lastSnapshot = (last.data.events.at(-1) as Extract<WireEvent, { type: 'snapshot' }>).payload.snapshot;
  expect(json(client)).toEqual(json(lastSnapshot));
});

/** Spec section 3's second example: a background subagent, which the running-tasks panel shows. */
const SUBAGENT_SCRIPT: typeof SCRIPT = [
  { fact: fact({ type: 'turn_started', turnId: 'turn-1', input: [user('user-1', 'delegate it')] }) },
  {
    fact: fact({
      type: 'task_started',
      mode: 'background',
      task: {
        taskId: 'task-1',
        sessionId: SESSION,
        kind: 'subagent',
        label: 'look around',
        role: 'explorer',
        parentTurnId: 'turn-1',
        startedAt: 1,
      },
    }),
  },
  {
    fact: fact({
      type: 'branch_started',
      branchId: 'branch-1',
      taskId: 'task-1',
      turnId: 'child-1',
      parentTurnId: 'turn-1',
      rootTurnId: 'turn-1',
      input: [user('child-user-1', 'look around')],
    }),
  },
  {
    fact: fact({
      type: 'branch_event',
      branchId: 'branch-1',
      fact: {
        type: 'item',
        turnId: 'child-1',
        modelStep: 1,
        executionId: 'child-exec-1',
        item: {
          type: 'tool_call',
          id: 'child-call-item',
          callId: 'child-call',
          toolName: 'shell',
          input: { command: 'ls' },
        },
      },
    }),
  },
  {
    fact: fact({
      type: 'branch_event',
      branchId: 'branch-1',
      fact: {
        type: 'tool_started',
        turnId: 'child-1',
        executionId: 'child-exec-1',
        callId: 'child-call',
        toolName: 'shell',
        input: { command: 'ls' },
      },
    }),
  },
  {
    fact: fact({
      type: 'branch_event',
      branchId: 'branch-1',
      fact: {
        type: 'tool_finished',
        turnId: 'child-1',
        executionId: 'child-exec-1',
        result: { output: 'a.txt', isError: false },
      },
    }),
  },
  {
    fact: fact({
      type: 'branch_event',
      branchId: 'branch-1',
      fact: {
        type: 'usage',
        turnId: 'child-1',
        modelStep: 1,
        usage: { inputTokens: 40, outputTokens: 7, cachedInputTokens: 0 },
      },
    }),
  },
  {
    fact: fact({
      type: 'branch_event',
      branchId: 'branch-1',
      fact: {
        type: 'item',
        turnId: 'child-1',
        modelStep: 2,
        item: { type: 'assistant_message', id: 'child-asst', content: [{ type: 'text', text: 'Found a.txt.' }] },
      },
    }),
  },
  {
    fact: fact({
      type: 'branch_event',
      branchId: 'branch-1',
      fact: { type: 'turn_ended', turnId: 'child-1', outcome: 'completed' },
    }),
  },
];

it("a background subagent's branch is the same by fold and by snapshot, with the panel's steps", async () => {
  const { session, publish } = scriptedSession(SUBAGENT_SCRIPT);
  const attachment = new DirectAttachment(session);
  cleanup.push(async () => attachment.close());
  const view = attachment.connect();
  const connection: DirectConnection = {
    sessionId: SESSION,
    get snapshot() {
      return view.snapshot;
    },
    events: view.events,
    batches: () => view.events.batches(),
    cut: view.cut,
    send: async () => ({ ok: false, code: 'closed', message: 'not used' }),
    close: () => view.events.close(),
  };
  const { until } = await serve(connection);
  await until(1);
  // Up to the tool's finish: the branch has run a tool but reported no usage, which is unknown, not zero.
  publish(6);
  const beforeUsage = fold(await until(7));
  expect(beforeUsage.branches).toHaveLength(1);
  expect(beforeUsage.branches![0]).toMatchObject({
    branchId: 'branch-1',
    taskId: 'task-1',
    turnId: 'child-1',
    acceptedSeq: 6,
    usage: null,
    terminal: null,
  });
  publish(SUBAGENT_SCRIPT.length - 6);
  const frames = await until(1 + SUBAGENT_SCRIPT.length);
  const client = fold(frames);
  expect(json(client)).toEqual(json(view.snapshot));
  const [branch] = client.branches!;
  expect(branch).toMatchObject({ acceptedSeq: 9, usage: { inputTokens: 40, outputTokens: 7, cachedInputTokens: 0 } });
  expect(branch!.messages.map((message) => [message.role, message.text])).toEqual([
    ['user', 'look around'],
    ['assistant', 'Found a.txt.'],
  ]);
  expect(branch!.tools.map((tool) => [tool.executionId, tool.status, tool.output])).toEqual([
    ['child-exec-1', 'completed', 'a.txt'],
  ]);
  expect(branch!.terminal).toMatchObject({ turnId: 'child-1', outcome: 'completed' });
  // Branch events never reach the root transcript.
  expect(client.messages.map((message) => message.id)).toEqual(['user-1']);

  // The running-tasks panel's steps for that task, presented the same way from the fold.
  const presented = present(SESSION, client, new Map(), { phase: 'live', error: null });
  const task = presented.session.tasks.find((entry: { id: string }) => entry.id === 'task-1');
  expect(task.branchTurns).toHaveLength(1);
  expect(task.branchTurns[0]).toMatchObject({
    turnId: 'child-1',
    userText: 'look around',
    status: 'completed',
    commands: [{ callId: 'child-exec-1', status: 'completed', output: 'a.txt' }],
  });
  expect(presented.turns.map((turn: { turnId: string }) => turn.turnId)).toEqual(['turn-1']);
});

it('a runtime fault mid-turn reaches the page as the failure of the turn it interrupted', async () => {
  const { session, publish, fault } = scriptedSession();
  publish(5); // turn 1 is streaming its first reply
  const attachment = new DirectAttachment(session);
  cleanup.push(async () => attachment.close());
  const view = attachment.connect();
  const connection: DirectConnection = {
    sessionId: SESSION,
    get snapshot() {
      return view.snapshot;
    },
    events: view.events,
    batches: () => view.events.batches(),
    cut: view.cut,
    send: async () => ({ ok: false, code: 'closed', message: 'not used' }),
    close: () => view.events.close(),
  };
  const { until } = await serve(connection);
  await until(1);
  fault('log writer failed');
  const frames = await until(2);
  expect(frames[1]!.event).toBe('snapshot');
  const client = fold(frames);
  expect(client.status).toBe('interrupted');
  const presented = present(SESSION, client, new Map(), { phase: 'live', error: null });
  expect(presented.turns.at(-1)).toMatchObject({
    turnId: 'turn-1',
    status: 'failed',
    error: 'provider_error',
    errorMessage: 'log writer failed',
    interruptedByFault: true,
  });
});
