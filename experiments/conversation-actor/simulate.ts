/** Requested executable simulation deliverable; no Vitest or production runtime. */
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  Conversation,
  ProviderFailure,
  type Call,
  type Event,
  type Item,
  type ModelReply,
  type ModelRequest,
  type ToolOutcome,
} from './actor.js';

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Gates deliberately ignore abort: late results exercise logical revocation. */
export class Simulation {
  models: { request: ModelRequest; signal: AbortSignal; gate: ReturnType<typeof gate<ModelReply>> }[] = [];
  tools: { call: Call; id: string; signal: AbortSignal; gate: ReturnType<typeof gate<ToolOutcome>> }[] = [];
  actor = new Conversation({
    model: (request, signal) => {
      const pending = { request, signal, gate: gate<ModelReply>() };
      this.models.push(pending);
      return pending.gate.promise;
    },
    tool: (call, id, signal) => {
      const pending = { call, id, signal, gate: gate<ToolOutcome>() };
      this.tools.push(pending);
      return pending.gate.promise;
    },
  });
  trace() {
    return this.actor.snapshot().events;
  }
  events(type: string) {
    return this.trace().filter((event) => event.type === type);
  }
  state(id: string) {
    return this.actor.snapshot().submissions.find((item) => item.id === id)?.status;
  }
  token() {
    return this.actor.snapshot().turn!.token!;
  }
  submit(id = 'a', steer = false) {
    this.actor.send({ type: 'submit', id, text: id, steer });
  }
  async reply(index: number, calls: Call[] = [], responseId = `r${index}`) {
    assert.ok(this.models[index], `model ${index} was dispatched`);
    this.models[index].gate.resolve({ text: calls.length ? 'tools' : 'done', calls, responseId });
    await this.flush();
  }
  async known(index: number, value = 'ok') {
    assert.ok(this.tools[index], `tool ${index} was dispatched`);
    this.tools[index].gate.resolve({ kind: 'known', value });
    await this.flush();
  }
  async flush() {
    await setImmediate();
  }
  verify() {
    const snapshot = this.actor.snapshot();
    const consumed = this.events('consumed').map((event) => event.detail.id);
    const settled = this.events('settled').map((event) => event.detail.id);
    assert.equal(new Set(consumed).size, consumed.length, 'each submission consumed at most once');
    assert.equal(new Set(settled).size, settled.length, 'each submission settled at most once');
    for (const item of snapshot.submissions) {
      if (['completed', 'cancelled', 'failed', 'retracted'].includes(item.status)) {
        assert.ok(settled.includes(item.id), `terminal submission ${item.id} has a settlement`);
      }
    }
    assert.deepEqual(
      snapshot.events.map((event) => event.seq),
      snapshot.events.map((_, index) => index + 1),
    );
    for (const { request } of this.models) {
      const debt = new Set<string>();
      for (const item of request.history) {
        if (item.role === 'assistant') {
          assert.equal(debt.size, 0, 'previous response tool debt paid before next assistant');
          for (const call of item.calls) {
            assert.ok(!debt.has(call.id), 'call IDs are unique within a response');
            debt.add(call.id);
          }
        } else if (item.role === 'tool') {
          assert.ok(debt.delete(item.id), 'tool result has exactly one preceding call');
        } else if (item.role === 'user') {
          assert.equal(debt.size, 0, 'user message does not split unfinished tool batch');
        }
      }
      assert.equal(debt.size, 0, 'each model request has self-contained tool history');
    }
  }
}

const call = (id: string, extra: Partial<Call> = {}): Call => ({ id, name: 'fake-effect', ...extra });
const users = (history: Item[]) => history.filter((item) => item.role === 'user').map((item) => item.id);
export const scenarios: Record<string, (s: Simulation) => Promise<void>> = {
  async 'mutable-background-port'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('job', { background: 'conversation' })]);
    await s.reply(1);
    delete s.tools[0].call.background;
    await s.known(0);
    assert.equal(s.actor.snapshot().jobs.length, 0, 'adapter mutation cannot strand job');
    assert.equal(s.events('job-completed').length, 1);
  },
  async 'mutable-foreground-port'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('effect')]);
    s.tools[0].call.background = 'conversation';
    await s.known(0);
    assert.equal(s.models.length, 2, 'adapter mutation cannot strand foreground turn');
    await s.reply(1);
    assert.equal(s.state('a'), 'completed');
  },
  async 'approval-cancel-order-matrix'(s) {
    for (const cancelFirst of [true, false]) {
      const id = cancelFirst ? 'cancel-first' : 'approve-first';
      const modelIndex = s.models.length;
      const toolCount = s.tools.length;
      s.submit(id);
      await s.flush();
      await s.reply(modelIndex, [call(id, { approval: true })]);
      const approve = { type: 'approve' as const, token: s.token(), allow: true };
      const cancel = { type: 'cancel' as const, turn: s.actor.snapshot().turn!.id };
      for (const command of cancelFirst ? [cancel, approve] : [approve, cancel]) s.actor.send(command);
      await s.flush();
      assert.equal(s.state(id), 'cancelled');
      assert.equal(s.tools.length, toolCount + (cancelFirst ? 0 : 1));
      if (!cancelFirst) await s.known(toolCount, 'late side effect');
      assert.equal(s.actor.snapshot().turn, undefined);
    }
  },
  async 'background-rollover-order-matrix'(s) {
    for (const finishFirst of [true, false]) {
      const modelIndex = s.models.length;
      const toolIndex = s.tools.length;
      const session = s.actor.snapshot().session;
      s.submit(`session-${session}`);
      await s.flush();
      await s.reply(modelIndex, [call(`job-${session}`, { background: 'conversation' })]);
      await s.reply(modelIndex + 1);
      if (finishFirst) await s.known(toolIndex);
      s.actor.send({ type: 'rollover' });
      if (!finishFirst) await s.known(toolIndex);
      const completion = s.events('job-completed').at(-1)!;
      assert.equal(completion.session, finishFirst ? session : session + 1);
      assert.equal(s.actor.snapshot().history.length, finishFirst ? 0 : 1);
    }
  },
  async 'fatal-provider-failure'(s) {
    s.submit();
    s.submit('b');
    await s.flush();
    s.models[0].gate.reject(new ProviderFailure('fatal', 'invalid credentials'));
    await s.flush();
    assert.equal(s.state('a'), 'failed');
    assert.equal(s.state('b'), 'consumed');
    assert.equal(s.events('retry-needed').length, 0);
    await s.reply(1);
  },
  async 'ordinary-multiple-tools'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('one'), call('two', { approval: true })]);
    assert.equal(s.tools.length, 1);
    await s.known(0);
    const token = s.token();
    assert.equal(s.actor.snapshot().turn?.phase, 'approval');
    s.actor.send({ type: 'approve', token, allow: true });
    await s.flush();
    assert.equal(s.models.length, 1, 'approval resumes tools without restarting model');
    await s.known(1);
    await s.reply(1);
    assert.equal(s.state('a'), 'completed');
    assert.deepEqual(
      s.models[1].request.history.filter((item) => item.role === 'tool').map((item) => item.id),
      ['one', 'two'],
    );
  },
  async 'cancel-during-approval'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('one', { approval: true })]);
    const token = s.token();
    s.actor.send({ type: 'cancel', turn: s.actor.snapshot().turn!.id });
    s.actor.send({ type: 'approve', token, allow: true });
    await s.flush();
    assert.equal(s.tools.length, 0);
    assert.equal(s.state('a'), 'cancelled');
    assert.equal(s.actor.snapshot().turn, undefined);
    assert.equal(s.events('stale').length, 1);
  },
  async 'steer-during-provider-retry'(s) {
    s.submit();
    await s.flush();
    s.models[0].gate.reject(new ProviderFailure('transient', 'offline'));
    await s.flush();
    const token = s.token();
    s.submit('b', true);
    s.actor.send({ type: 'retry', token });
    await s.flush();
    assert.deepEqual(users(s.models[1].request.history), ['a', 'b']);
    s.models[1].gate.reject(new ProviderFailure('transient', 'again'));
    await s.flush();
    s.actor.send({ type: 'retry', token: s.token() });
    await s.flush();
    assert.deepEqual(users(s.models[2].request.history), ['a', 'b']);
    s.actor.send({ type: 'retry', token });
    await s.reply(2);
    assert.equal(s.events('consumed').filter((event) => event.detail.id === 'b').length, 1);
    assert.equal(s.state('b'), 'completed');
  },
  async 'steer-at-next-boundary'(s) {
    s.submit();
    await s.flush();
    s.submit('b', true);
    await s.reply(0, [call('one')]);
    await s.known(0);
    assert.deepEqual(users(s.models[1].request.history), ['a', 'b']);
    await s.reply(1);
    assert.equal(s.state('b'), 'completed');
  },
  async 'steer-before-finish'(s) {
    s.submit();
    await s.flush();
    s.submit('b', true);
    await s.reply(0);
    assert.equal(s.events('steer-returned').length, 1);
    assert.equal(s.events('turn-started').length, 2);
    assert.deepEqual(users(s.models[1].request.history), ['a', 'b']);
    await s.reply(1);
    assert.equal(s.state('b'), 'completed');
  },
  async 'late-provider-response'(s) {
    s.submit();
    await s.flush();
    const oldTurn = s.actor.snapshot().turn!.id;
    s.actor.send({ type: 'cancel', turn: oldTurn });
    s.submit('b');
    await s.flush();
    const before = s.actor.snapshot().history;
    await s.reply(0, [call('zombie')]);
    assert.deepEqual(s.actor.snapshot().history, before);
    assert.equal(s.tools.length, 0);
    assert.equal(s.models[0].signal.aborted, true);
    s.actor.send({ type: 'cancel', turn: oldTurn });
    assert.equal(s.state('b'), 'consumed');
    await s.reply(1);
  },
  async 'retract-and-edit-queued'(s) {
    s.submit();
    await s.flush();
    s.submit('b');
    s.submit('c');
    s.actor.send({ type: 'edit', id: 'c', text: 'edited c' });
    s.actor.send({ type: 'retract', id: 'b' });
    s.submit('d', true);
    s.actor.send({ type: 'retract', id: 'd' });
    await s.reply(0);
    assert.deepEqual(users(s.models[1].request.history), ['a', 'c']);
    assert.ok(s.models[1].request.history.some((item) => item.role === 'user' && item.text === 'edited c'));
    await s.reply(1);
    assert.equal(s.state('b'), 'retracted');
    assert.equal(s.state('d'), 'retracted');
  },
  async 'background-after-turn'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('job', { background: 'conversation' })]);
    await s.reply(1);
    assert.equal(s.state('a'), 'completed');
    await s.known(0, 'background result');
    assert.equal(s.events('job-completed').length, 1);
    assert.ok(
      s.actor.snapshot().history.some((item) => item.role === 'notification' && item.text === 'background result'),
    );
    s.submit('b');
    await s.flush();
    assert.ok(s.models[2].request.history.some((item) => item.role === 'notification'));
    await s.reply(2);
  },
  async 'background-after-rollover'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('survive', { background: 'conversation' }), call('detach', { background: 'session' })]);
    s.actor.send({ type: 'rollover' });
    await s.flush();
    assert.equal(s.actor.snapshot().session, 2);
    assert.equal(s.tools[0].signal.aborted, false);
    assert.equal(s.tools[1].signal.aborted, true);
    await s.known(1, 'old session result');
    await s.known(0, 'successor result');
    assert.equal(s.events('job-completed').length, 1);
    assert.equal(s.events('job-completed')[0].session, 2);
    assert.equal(s.events('job-completed')[0].detail.origin, 1);
    assert.deepEqual(s.actor.snapshot().history, [
      { role: 'notification', id: s.tools[0].id, text: 'successor result' },
    ]);
    await s.reply(1, [call('stale')]);
    assert.equal(s.tools.length, 2);
  },
  async 'unknown-tool-outcome'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('write'), call('read')]);
    s.tools[0].gate.reject(new Error('connection lost after effect'));
    await s.flush();
    assert.equal(s.actor.snapshot().turn?.phase, 'unknown');
    const token = s.token();
    s.actor.send({ type: 'retry', token });
    await s.flush();
    assert.equal(s.tools.length, 1);
    assert.equal(s.models.length, 1);
    s.actor.send({ type: 'reconcile', token, outcome: 'effect verified externally' });
    await s.flush();
    assert.equal(s.tools.length, 2);
    assert.equal(s.tools[1].call.id, 'read');
    s.actor.send({ type: 'reconcile', token, outcome: 'duplicate' });
    await s.known(1);
    await s.reply(1);
    assert.equal(s.tools.filter((item) => item.call.id === 'write').length, 1);
    assert.equal(s.models[1].request.previousResponseId, undefined);
  },
  async 'invalid-provider-chain'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('write')]);
    await s.known(0);
    assert.equal(s.models[1].request.previousResponseId, 'r0');
    s.models[1].gate.reject(new ProviderFailure('invalid-chain', 'anchor disappeared'));
    await s.flush();
    s.submit('b', true);
    s.actor.send({ type: 'retry', token: s.token() });
    await s.flush();
    const request = s.models[2].request;
    assert.equal(request.previousResponseId, undefined);
    assert.deepEqual(users(request.history), ['a', 'b']);
    assert.ok(request.history.some((item) => item.role === 'tool' && item.id === 'write' && item.outcome === 'ok'));
    assert.equal(s.tools.length, 1, 'completed effect is not replayed');
    await s.reply(2);
  },
  async 'cancel-during-tools'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('one'), call('two')]);
    s.actor.send({ type: 'cancel', turn: s.actor.snapshot().turn!.id });
    s.submit('b');
    await s.flush();
    await s.known(0, 'too late');
    const outcomes = s.models[1].request.history.filter((item) => item.role === 'tool').map((item) => item.outcome);
    assert.deepEqual(outcomes, ['unknown', 'not-executed']);
    assert.equal(s.models[1].request.previousResponseId, undefined);
    assert.equal(s.tools.length, 1);
    await s.reply(1);
  },
  async 'concurrent-arrivals'(s) {
    s.submit();
    await s.flush();
    await Promise.all(['b', 'c', 'd'].map((id) => Promise.resolve().then(() => s.submit(id))));
    s.submit('b'); // duplicate submission must not execute twice
    for (let index = 0; index < 4; index++) await s.reply(index);
    assert.deepEqual(
      s.events('consumed').map((event) => event.detail.id),
      ['a', 'b', 'c', 'd'],
    );
    assert.deepEqual(
      s.events('settled').map((event) => event.detail.id),
      ['a', 'b', 'c', 'd'],
    );
    assert.equal(s.events('rejected').length, 1);
  },
  async 'observer-isolation'(s) {
    const seen: Event[] = [];
    s.actor.observe((event) => {
      event.detail.corrupted = true;
      throw new Error('consumer failure');
    });
    const unsubscribe = s.actor.observe((event) => {
      seen.push(event);
      if (event.type === 'accepted' && event.detail.id === 'a') s.submit('b');
    });
    s.submit();
    await s.flush();
    await s.reply(0);
    await s.reply(1);
    unsubscribe();
    assert.equal(s.state('a'), 'completed');
    assert.equal(s.state('b'), 'completed');
    assert.ok(seen.length > 0);
    assert.ok(s.trace().every((event) => !event.detail.corrupted));
    const snapshot = s.actor.snapshot();
    snapshot.history.length = 0;
    assert.ok(s.actor.snapshot().history.length > 0);
  },
  async 'approval-denial-and-repeat-call'(s) {
    s.submit();
    await s.flush();
    await s.reply(0, [call('one', { approval: true }), call('two')]);
    s.actor.send({ type: 'approve', token: s.token(), allow: false });
    await s.flush();
    assert.equal(s.tools.length, 1);
    assert.equal(s.tools[0].call.id, 'two');
    await s.known(0);
    await s.reply(1, [call('two')]);
    assert.equal(s.state('a'), 'failed');
    assert.equal(s.tools.length, 1);
  },
};

export async function run(name: string) {
  const scenario = scenarios[name];
  assert.ok(scenario, `unknown scenario ${name}; use --list`);
  const simulation = new Simulation();
  await scenario(simulation);
  simulation.verify();
  return simulation.trace();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2];
  if (name === '--list') console.log(Object.keys(scenarios).join('\n'));
  else {
    const names = name && name !== '--all' ? [name] : Object.keys(scenarios);
    for (const scenario of names) {
      const trace = await run(scenario);
      console.log(JSON.stringify({ scenario, result: 'PASS', events: trace.length }));
      if (process.argv.includes('--trace')) console.log(JSON.stringify(trace, null, 2));
    }
  }
}
