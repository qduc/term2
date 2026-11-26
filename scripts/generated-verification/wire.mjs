import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { DirectProjection } from '../../src/protocol/projection.ts';
import { initialDirectState, reduceDirectFact } from '../../src/session/state.ts';
import { EventEmitter } from 'node:events';
import { DirectEventQueue, directBatch } from '../../src/host/in-process-direct-queue.ts';
import { directWireV2EventStream } from '../../src/host/server-sse.ts';
import { ServerInteractions } from '../../src/host/server-interactions.ts';

/*
 * Reload equals live, where two producers of the same state still exist.
 *
 * wire.frames-round-trip: a generated session is projected by the real DirectProjection, framed as
 * direct-wire-v2 exactly as the gateway frames it, sent through JSON, and folded by the browser's copy of the
 * fold (web-client/lib/term2/generated/wire-fold.js). After every frame the browser's state must equal the
 * server's snapshot, seq included. It catches framing and batching mistakes, JSON-shape loss, and any state
 * the server holds outside the shared fold.
 *
 * wire.snapshot-is-fold: the server's resynchronisation (snapshotDirectState, the second producer of a
 * snapshot, which the TUI relies on too) does not change accepted state that the fold already produced. At every
 * cut, a projection that folded updates 1..k is synchronized with the Session state built from the same facts;
 * the accepted part of its snapshot must not move. Fields that only rebuild from Session state are really
 * checked; fields carried over from the previous snapshot compare with themselves.
 *
 * Bounds: at most 30 commands per case, no model, network or filesystem.
 */

const bundle = fileURLToPath(new URL('../../web-client/lib/term2/generated/wire-fold.js', import.meta.url));
let browserFold;
async function loadBrowserFold() {
  if (!existsSync(bundle)) throw new Error('Missing the browser fold bundle: run `node scripts/build-web-fold.mjs`.');
  browserFold ??= await import(bundle);
  return browserFold;
}

const SESSION = 'conv_property';
const WORKSPACE = { root: '/property-workspace', access: 'read_write', target: 'local' };
const MODEL = { provider: 'property', model: 'property-model' };

const text = fc.string({ minLength: 1, maxLength: 12 });
const command = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('prompt'), text }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('delta'), text }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('message'), text }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('reasoning'), text }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('reasoning_live'), text }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('tool'), text }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('tool_start') }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('tool_finish'), text, isError: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('tool_progress'), text }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('usage'),
      input: fc.integer({ min: 0, max: 5000 }),
      output: fc.integer({ min: 0, max: 5000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('end'), outcome: fc.constantFrom('completed', 'failed', 'cancelled') }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('silent'), text }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('branch') }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('branch_child'),
      child: fc.constantFrom('delta', 'message', 'tool', 'tool_start', 'tool_finish', 'usage', 'end'),
      text,
    }),
  },
);
export const sessionCommands = fc.array(command, { minLength: 1, maxLength: 30, size: 'max' });

/**
 * Turns generated commands into the Session updates a real session would publish, in order: accepted facts
 * with increasing seq and live transients. A command that needs something first gets it first (a turn for a
 * delta, a start for a tool that finishes, a branch for a child event), so most commands produce facts and
 * every script is one a session could produce.
 */
export function sessionUpdates(commands) {
  const updates = [];
  let seq = 0;
  let position = 0;
  let turnCount = 0;
  let turn = null; // { id, step, drafting, tools: [{ executionId, callId, toolName, started, finished }] }
  const branches = [];
  const fact = (value) =>
    updates.push({
      type: 'fact',
      position: ++position,
      seq: ++seq,
      at: `2026-11-26T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
      fact: value,
    });
  const transient = (event) => updates.push({ type: 'transient', position: ++position, event });
  const item = (turnId, value, extra = {}) => fact({ type: 'item', turnId, item: value, ...extra });
  const usage = (input, output) => ({ inputTokens: input, outputTokens: output, cachedInputTokens: 0 });

  // A turn script shared by the root and by branches: the same commands, emitted through `emit`.
  const step = (state, kind, c, emit, idPrefix) => {
    const nextTool = state.tools.find((tool) => !tool.started) ?? state.tools.find((tool) => !tool.finished);
    switch (kind) {
      case 'delta':
        emit({ type: 'text_delta', turnId: state.id, delta: c.text, modelStep: state.step });
        state.drafting = true;
        return;
      case 'message': {
        emit({
          type: 'item',
          turnId: state.id,
          modelStep: state.step,
          item: {
            type: 'assistant_message',
            id: `${idPrefix}-asst-${state.step}`,
            content: [{ type: 'text', text: c.text }],
          },
        });
        state.drafting = false;
        state.step += 1;
        return;
      }
      case 'tool': {
        const n = state.tools.length + 1;
        const tool = {
          executionId: `${idPrefix}-exec-${n}`,
          callId: `${idPrefix}-call-${n}`,
          toolName: 'shell',
          started: false,
          finished: false,
        };
        state.tools.push(tool);
        emit({
          type: 'item',
          turnId: state.id,
          executionId: tool.executionId,
          modelStep: state.step,
          item: {
            type: 'tool_call',
            id: `${idPrefix}-call-item-${n}`,
            callId: tool.callId,
            toolName: 'shell',
            input: { command: c.text },
          },
        });
        return;
      }
      case 'tool_start':
        if (!nextTool || nextTool.started) return;
        nextTool.started = true;
        emit({
          type: 'tool_started',
          turnId: state.id,
          executionId: nextTool.executionId,
          callId: nextTool.callId,
          toolName: nextTool.toolName,
          input: { command: 'x' },
        });
        return;
      case 'tool_finish':
        if (!nextTool || nextTool.finished) return;
        if (!nextTool.started) step(state, 'tool_start', c, emit, idPrefix);
        nextTool.finished = true;
        emit({
          type: 'tool_finished',
          turnId: state.id,
          executionId: nextTool.executionId,
          result: { output: c.text, isError: Boolean(c.isError) },
        });
        return;
      case 'usage':
        emit({ type: 'usage', turnId: state.id, modelStep: state.step, usage: usage(c.input ?? 7, c.output ?? 3) });
        return;
      case 'end':
        emit({
          type: 'turn_ended',
          turnId: state.id,
          outcome: c.outcome ?? 'completed',
          ...(c.outcome === 'failed'
            ? { error: { kind: 'provider', message: 'scripted failure', retryable: false } }
            : {}),
        });
        state.ended = true;
        return;
    }
  };

  const startTurn = (prompt) => {
    turnCount += 1;
    turn = { id: `turn-${turnCount}`, step: 1, drafting: false, tools: [], ended: false };
    fact({
      type: 'turn_started',
      turnId: turn.id,
      input: [{ type: 'user_message', id: `user-${turnCount}`, content: [{ type: 'text', text: prompt }] }],
    });
  };
  const ensureTurn = () => {
    if (!turn || turn.ended) startTurn('continue');
  };
  const startBranch = () => {
    ensureTurn();
    const n = branches.length + 1;
    const branch = {
      branchId: `branch-${n}`,
      taskId: `task-${n}`,
      id: `branch-turn-${n}`,
      step: 1,
      drafting: false,
      tools: [],
      ended: false,
    };
    branches.push(branch);
    // A subagent is a task first: Session accepts the task, then its branch.
    fact({
      type: 'task_started',
      mode: 'background',
      task: {
        taskId: branch.taskId,
        sessionId: SESSION,
        kind: 'subagent',
        label: 'subtask',
        role: 'worker',
        parentTurnId: turn.id,
        startedAt: n,
      },
    });
    fact({
      type: 'branch_started',
      branchId: branch.branchId,
      taskId: branch.taskId,
      turnId: branch.id,
      parentTurnId: turn.id,
      rootTurnId: turn.id,
      input: [{ type: 'user_message', id: `branch-input-${n}`, content: [{ type: 'text', text: 'subtask' }] }],
    });
    return branch;
  };

  for (const c of commands) {
    if (c.kind === 'prompt') {
      if (turn && !turn.ended) step(turn, 'end', { outcome: 'completed' }, fact, turn.id);
      startTurn(c.text);
      continue;
    }
    if (c.kind === 'branch') {
      startBranch();
      continue;
    }
    if (c.kind === 'branch_child') {
      const branch = branches.filter((entry) => !entry.ended).at(-1) ?? startBranch();
      const child =
        c.child === 'end' ? { outcome: 'completed' } : c.child === 'usage' ? { input: c.text.length, output: 1 } : c;
      step(
        branch,
        c.child,
        child,
        (value) => fact({ type: 'branch_event', branchId: branch.branchId, fact: value }),
        branch.branchId,
      );
      if (branch.ended)
        fact({
          type: 'task_finished',
          taskId: branch.taskId,
          at: seq,
          result: { kind: 'completed', value: 'subtask done' },
        });
      continue;
    }
    ensureTurn();
    switch (c.kind) {
      case 'reasoning':
        item(
          turn.id,
          { type: 'reasoning', id: `reasoning-${turn.id}-${turn.step}`, summary: c.text },
          { modelStep: turn.step },
        );
        break;
      case 'reasoning_live':
        transient({ type: 'reasoning_delta', delta: c.text });
        break;
      case 'tool_progress': {
        const running = turn.tools.find((tool) => tool.started && !tool.finished);
        if (running) transient({ type: 'tool_progress', executionId: running.executionId, chunk: c.text });
        else step(turn, 'tool', c, fact, turn.id);
        break;
      }
      case 'silent':
        // Accepted but never shown: advances seq and projects to no event (an empty accepted frame).
        item(
          turn.id,
          { type: 'assistant_message', id: `hidden-${seq + 1}`, content: [{ type: 'text', text: c.text }] },
          { display: false },
        );
        break;
      default:
        step(turn, c.kind, c, fact, turn.id);
    }
  }
  return updates;
}

/**
 * What a fresh connection receives: the gateway's own direct-wire-v2 stream (server-sse.ts) is run against an
 * in-memory connection and response, and its SSE text is parsed back into frames. Each frame is paired with
 * the server's snapshot at that point: frame 0 is the opening snapshot, frame n follows update n.
 */
export async function streamFrames(updates) {
  const projection = DirectProjection.forReplay(initialDirectState(SESSION, WORKSPACE, MODEL));
  const queue = new DirectEventQueue(() => undefined);
  let ordinal = 0;
  const connection = {
    sessionId: SESSION,
    get snapshot() {
      return projection.snapshot;
    },
    events: queue,
    batches: () => queue.batches(),
    cut: () => ({ snapshot: projection.snapshot, ordinal }),
    send: async () => ({ ok: false, code: 'closed', message: 'not used' }),
    close: () => queue.close(),
  };
  const result = directWireV2EventStream(connection, new ServerInteractions());
  assert.ok(result?.stream, 'direct-wire-v2 stream is unavailable for a batching connection');
  let text = '';
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      text += chunk;
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    },
  });
  const request = Object.assign(new EventEmitter(), { aborted: false });
  // start() reads the opening cut synchronously, before any update below is published.
  const done = result.stream.start(response, request);
  const snapshots = [projection.snapshot];
  // Let the stream write each frame before the next publication, as a live connection would.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  for (const update of updates) {
    queue.push(directBatch(update, projection.update(update), ++ordinal));
    snapshots.push(projection.snapshot);
    await settle();
  }
  // Closing drops unread frames (a disconnect), so it waits until every frame above was written.
  queue.close();
  await done;
  const frames = text
    .split('\n\n')
    .filter((block) => block.includes('data: '))
    .map((block) => {
      const field = (name) =>
        block
          .split('\n')
          .find((line) => line.startsWith(`${name}: `))
          ?.slice(name.length + 2);
      return { event: field('event'), id: field('id'), data: JSON.parse(field('data')) };
    });
  assert.equal(frames.length, snapshots.length, 'one frame per publication, plus the opening snapshot');
  return frames.map((frame, index) => ({ ...frame, snapshot: snapshots[index] }));
}

/** What the browser's store does with one frame: fold its events, then hold the accepted checkpoint. */
export function foldFrame(reduceWireEvent, state, frame) {
  let next = state;
  for (const event of frame.events) next = next === null ? event.payload.snapshot : reduceWireEvent(next, event);
  if (frame.kind === 'accepted') next = { ...next, seq: frame.seq };
  return next;
}

/**
 * A snapshot without what live (seq null) events write, read off the fold's cases: thinking, reasoning and its
 * identity (reasoning_started/delta), live reasoning, retry and its notice (retrying), the memory notice
 * (automatic_memory_notice), reviewingApprovals (approval_review), Codex quotas (codex_quota), lastError (error),
 * tool progress (tool_progress) and task progress (task_progress). A failure on any other field is a defect in
 * snapshotDirectState or the fold, not a reason to grow this list.
 */
const LIVE_NOTICE_KINDS = new Set(['retrying', 'automatic_memory']);
export function acceptedPart(snapshot) {
  const {
    thinking: _thinking,
    reasoning: _reasoning,
    reasoningIdentity: _reasoningIdentity,
    liveReasoning: _liveReasoning,
    retry: _retry,
    reviewingApprovals: _reviewingApprovals,
    codexQuota: _codexQuota,
    codexFiveHourQuota: _codexFiveHourQuota,
    lastError: _lastError,
    ...accepted
  } = JSON.parse(JSON.stringify(snapshot));
  return {
    ...accepted,
    notices: accepted.notices.filter((notice) => !LIVE_NOTICE_KINDS.has(notice.kind)),
    tools: accepted.tools.map(({ progress: _progress, ...tool }) => tool),
    tasks: accepted.tasks.map(
      ({ progress: _progress, lastActivityAt: _at, lastObservation: _observation, text: _text, ...task }) => task,
    ),
  };
}

/** The Session state the same accepted facts build, as Session would hand it to a state publication. */
function sessionStateAfter(updates) {
  let state = initialDirectState(SESSION, WORKSPACE, MODEL);
  for (const update of updates) if (update.type === 'fact') state = reduceDirectFact(state, update.fact, update.seq);
  return state;
}

/** JSON is what crosses the wire; compare the server's snapshot as the browser would receive it. */
const asSent = (value) => JSON.parse(JSON.stringify(value));

export const wireProperties = [
  {
    name: 'wire.frames-round-trip',
    property: fc.asyncProperty(sessionCommands, async (commands) => {
      const { reduceWireEvent } = await loadBrowserFold();
      let state = null;
      for (const [index, { event, id, data: frame, snapshot }] of (
        await streamFrames(sessionUpdates(commands))
      ).entries()) {
        assert.equal(frame.format, 'direct-wire-v2');
        assert.equal(event, frame.kind, 'the SSE event name is the frame kind');
        assert.equal(
          id,
          frame.kind === 'live' || frame.seq === null ? undefined : String(frame.seq),
          'SSE id is the cut',
        );
        state = foldFrame(reduceWireEvent, state, frame);
        assert.deepEqual(
          asSent(state),
          asSent(snapshot),
          `browser fold differs from the server after frame ${index} (${frame.kind})`,
        );
      }
    }),
  },
  {
    name: 'wire.snapshot-is-fold',
    property: fc.property(sessionCommands, (commands) => {
      const updates = sessionUpdates(commands);
      for (let cut = 1; cut <= updates.length; cut += 1) {
        const projection = DirectProjection.forReplay(initialDirectState(SESSION, WORKSPACE, MODEL));
        for (const update of updates.slice(0, cut)) projection.update(update);
        const folded = acceptedPart(projection.snapshot);
        projection.synchronize(sessionStateAfter(updates.slice(0, cut)));
        assert.deepEqual(
          acceptedPart(projection.snapshot),
          folded,
          `synchronizing at cut ${cut} changed accepted state`,
        );
      }
    }),
  },
];
