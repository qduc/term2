import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createResource } from '../../web-client/lib/term2/data/resource.ts';
import { createSettingsWriter } from '../../web-client/lib/term2/data/settings-writer.ts';

/*
 * web.resource-latest-wins: the web client's one data primitive (web-client/lib/term2/data/resource.ts) under random
 * loads, refreshes, local writes and responses that resolve or fail in any order. Invariants after every step:
 *   - the data shown came from the request started last, or from a set/update made after it started;
 *   - a response for another key is never installed;
 *   - loading and refreshing are false once the request started last has settled, and true while it runs;
 *   - loaded is true only when data for the current key was installed;
 *   - load() resolves to its data only when no newer request started before it settled, else null (and null on
 *     failure); loadOrFail() and refresh() reject exactly when their own request failed and otherwise resolve to
 *     what they fetched;
 *   - ensure(key) starts a request unless that key is already loaded or loading, and then starts exactly one;
 *   - error holds the described failure of the request started last once it has failed, and is null otherwise (a
 *     local write does not change it).
 *
 * Bounds: at most 30 steps per case; no React or network.
 */

const KEYS = ['a', 'b'];
const step = fc.oneof(
  fc.record({ kind: fc.constant('load'), key: fc.constantFrom(...KEYS) }),
  fc.record({ kind: fc.constant('refresh'), key: fc.constantFrom(...KEYS) }),
  fc.record({ kind: fc.constant('loadOrFail'), key: fc.constantFrom(...KEYS) }),
  fc.record({ kind: fc.constant('ensure'), key: fc.constantFrom(...KEYS) }),
  fc.record({ kind: fc.constant('set') }),
  fc.record({ kind: fc.constant('update') }),
  { arbitrary: fc.record({ kind: fc.constant('settle'), index: fc.nat(7), ok: fc.boolean() }), weight: 4 },
);
const script = fc.array(step, { minLength: 1, maxLength: 30, size: 'max' });

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function run(steps) {
  const pending = []; // { id, key, resolve, reject }
  let started = 0;
  const resource = createResource({
    initial: 'initial',
    fetch: (key) =>
      new Promise((resolve, reject) => {
        const id = ++started;
        pending.push({ id, key, resolve, reject });
      }),
    describeError: (error) => `described:${error.message}`,
  });
  let lastStarted = null; // { id, key, flag }
  let lastSettled = false;
  let lastFailed = false;
  // Where the shown data may have come from: a response id, a local value, or nothing yet for this key.
  let allowed = new Set(['initial']);
  let localWrites = 0;
  // Each request's caller: what it called, and what its promise did (filled in when it settles).
  const calls = new Map(); // id -> { kind, outcome }
  const track = (id, kind, promise) => {
    const call = { kind, outcome: undefined };
    calls.set(id, call);
    if (!promise) return;
    promise.then(
      (value) => (call.outcome = { resolved: value }),
      () => (call.outcome = { rejected: true }),
    );
  };
  const begin = (key, flag) => {
    const id = started;
    if (lastStarted?.key !== key) allowed = new Set(['initial']);
    lastStarted = { id, key, flag };
    lastSettled = false;
    lastFailed = false;
    // Data on screen until this request answers: whatever was allowed for this key.
    allowed.add(`response:${id}`);
  };

  for (const action of steps) {
    switch (action.kind) {
      case 'load':
      case 'loadOrFail':
      case 'refresh': {
        const promise = resource[action.kind](action.key);
        track(started, action.kind, promise);
        begin(action.key, action.kind === 'refresh' ? 'refreshing' : 'loading');
        break;
      }
      case 'ensure': {
        const before = resource.get();
        const covered = before.key === action.key && (before.loaded || before.loading);
        const count = started;
        resource.ensure(action.key);
        assert.equal(
          started - count,
          covered ? 0 : 1,
          covered ? 'ensure fetched a loaded or loading key' : 'ensure did not fetch',
        );
        if (!covered) {
          track(started, 'ensure');
          begin(action.key, 'loading');
        }
        break;
      }
      case 'set':
      case 'update': {
        const value = `local:${++localWrites}`;
        if (action.kind === 'set') resource.set(value);
        else resource.update(() => value);
        // A local write replaces what is shown; the request started last may still answer over it.
        allowed = new Set([value, ...(lastStarted && !lastSettled ? [`response:${lastStarted.id}`] : [])]);
        break;
      }
      case 'settle': {
        if (pending.length === 0) break;
        const [request] = pending.splice(action.index % pending.length, 1);
        const replaced = started > request.id;
        if (action.ok) request.resolve(`response:${request.id}`);
        else request.reject(new Error(`failed ${request.id}`));
        await flush();
        const call = calls.get(request.id);
        if (call?.kind === 'load')
          assert.deepEqual(
            call.outcome,
            { resolved: action.ok && !replaced ? `response:${request.id}` : null },
            'load() resolved to the wrong value',
          );
        if (call?.kind === 'loadOrFail' || call?.kind === 'refresh')
          assert.deepEqual(
            call.outcome,
            action.ok ? { resolved: `response:${request.id}` } : { rejected: true },
            `${call.kind}() did not report its own outcome`,
          );
        if (lastStarted && request.id === lastStarted.id) {
          lastSettled = true;
          lastFailed = !action.ok;
          if (action.ok) allowed = new Set([`response:${request.id}`]);
        }
        break;
      }
    }
    await flush();
    const state = resource.get();
    // Only the request started last, or a later local write, decides what is shown.
    assert.ok(allowed.has(state.data), `shown ${state.data}, allowed ${[...allowed].join(', ')}`);
    if (state.data.startsWith('response:')) {
      const id = Number(state.data.slice('response:'.length));
      assert.equal(state.key, lastStarted?.key, 'a response for another key was installed');
      assert.ok(id <= started);
    }
    if (lastStarted) {
      assert.equal(state.key, lastStarted.key);
      const running = !lastSettled;
      assert.equal(
        state.loading,
        running && lastStarted.flag === 'loading',
        'loading does not follow the last request',
      );
      assert.equal(
        state.refreshing,
        running && lastStarted.flag === 'refreshing',
        'refreshing does not follow the last request',
      );
    }
    if (state.loaded) assert.notEqual(state.data, 'initial', 'loaded without data for this key');
    assert.equal(
      state.error,
      lastStarted && lastSettled && lastFailed ? `described:failed ${lastStarted.id}` : null,
      'error does not describe the failure of the request started last',
    );
  }
}

/*
 * web.settings-writes-in-order: the settings write queue (web-client/lib/term2/data/settings-writer.ts) under writes,
 * re-reads that install a new revision, and answers (ok, conflict, failure) in order. Invariants:
 *   - at most one write call is unanswered at any time;
 *   - each call's expectedRevision is the revision the store held when the call was made;
 *   - a successful write's projection is installed and its caller resolves to it;
 *   - a conflict's projection is installed and its caller rejects;
 *   - a failed write leaves the store alone and the next write still runs;
 *   - a write with nothing loaded rejects without a call.
 */
const writerStep = fc.oneof(
  fc.record({ kind: fc.constant('write') }),
  fc.record({ kind: fc.constant('reread') }),
  fc.record({ kind: fc.constant('load') }),
  {
    arbitrary: fc.record({ kind: fc.constant('settle'), outcome: fc.constantFrom('ok', 'conflict', 'fail') }),
    weight: 3,
  },
);
const writerScript = fc.array(writerStep, { minLength: 1, maxLength: 30, size: 'max' });

const projection = (revision) => ({ revision, settings: {} });

async function runWriter(steps) {
  const settings = createResource({ initial: null, fetch: async () => projection('r0') });
  let revisions = 0;
  const calls = []; // { expectedRevision, resolve, reject, answered }
  const problems = [];
  const writer = createSettingsWriter({
    settings,
    // Checked here and asserted after the step: a throw inside the executor would only reject that one write.
    write: (input) =>
      new Promise((resolve, reject) => {
        if (!calls.every((call) => call.answered))
          problems.push('a settings write started while another was unanswered');
        if (input.expectedRevision !== settings.get().data?.revision)
          problems.push('a write did not use the revision held when it was made');
        // The change carries its caller's record, so each answer is checked against that caller's promise.
        calls.push({
          expectedRevision: input.expectedRevision,
          resolve,
          reject,
          answered: false,
          record: input.changes[0].value,
        });
      }),
    conflictProjection: (error) => error.projection ?? null,
  });
  const outcomes = []; // per writer() call: { outcome } once settled
  for (const action of steps) {
    switch (action.kind) {
      case 'load':
        settings.set(projection(`r${++revisions}`));
        break;
      case 'reread':
        if (settings.get().data) settings.set(projection(`r${++revisions}`));
        break;
      case 'write': {
        const loaded = Boolean(settings.get().data);
        const before = calls.length;
        const record = { outcome: undefined, loaded };
        outcomes.push(record);
        writer([{ key: 'k', value: record }]).then(
          (value) => (record.outcome = { resolved: value }),
          (error) => (record.outcome = { rejected: error }),
        );
        await flush();
        if (!loaded && calls.length === before && calls.every((call) => call.answered)) {
          // Nothing loaded and nothing ahead of it: it rejects without a call.
          assert.ok(record.outcome && 'rejected' in record.outcome, 'a write with nothing loaded did not reject');
        }
        break;
      }
      case 'settle': {
        const call = calls.find((item) => !item.answered);
        if (!call) break;
        call.answered = true;
        const storeBefore = settings.get().data;
        if (action.outcome === 'ok') {
          const next = projection(`r${++revisions}`);
          call.resolve({ projection: next });
          await flush();
          assert.equal(settings.get().data, next, 'a successful write did not install its projection');
          assert.equal(call.record.outcome?.resolved, next, "a successful write's caller did not get its projection");
        } else if (action.outcome === 'conflict') {
          const server = projection(`r${++revisions}`);
          const error = Object.assign(new Error('conflict'), { projection: server });
          call.reject(error);
          await flush();
          assert.equal(settings.get().data, server, "a conflict did not install the server's projection");
          assert.ok(call.record.outcome && 'rejected' in call.record.outcome, "a conflict's caller did not reject");
        } else {
          call.reject(new Error('failed'));
          await flush();
          assert.equal(settings.get().data, storeBefore, 'a failed write changed the store');
          assert.ok(call.record.outcome && 'rejected' in call.record.outcome, "a failed write's caller did not reject");
        }
        break;
      }
    }
    await flush();
    assert.deepEqual(problems, [], problems[0]);
  }
  // Every caller got its own write's outcome: ok resolves to a projection, conflict and failure reject.
  for (const record of outcomes)
    if (record.outcome && 'resolved' in record.outcome)
      assert.ok(record.outcome.resolved?.revision, 'a write resolved to nothing');
}

export const webDataProperties = [
  { name: 'web.resource-latest-wins', property: fc.asyncProperty(script, (steps) => run(steps)) },
  { name: 'web.settings-writes-in-order', property: fc.asyncProperty(writerScript, (steps) => runWriter(steps)) },
];
