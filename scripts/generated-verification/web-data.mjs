import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createResource } from '../../web-client/lib/term2/data/resource.ts';

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
 *   - ensure(key) starts a request unless that key is already loaded or loading, and then starts exactly one.
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
  });
  let lastStarted = null; // { id, key, flag }
  let lastSettled = false;
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
  }
}

export const webDataProperties = [
  { name: 'web.resource-latest-wins', property: fc.asyncProperty(script, (steps) => run(steps)) },
];
