import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createResource } from '../../web-client/lib/term2/data/resource.ts';

/*
 * web.resource-latest-wins: the web client's one data primitive (web-client/lib/term2/data/resource.ts) under random
 * loads, refreshes, local writes and responses that resolve or fail in any order. Invariants after every step:
 *   - the data shown came from the request started last, or from a set/update made after it started;
 *   - a response for another key is never installed;
 *   - loading and refreshing are false once the request started last has settled, and true while it runs;
 *   - loaded is true only when data for the current key was installed.
 *
 * Bounds: at most 30 steps per case; no React or network.
 */

const KEYS = ['a', 'b'];
const step = fc.oneof(
  fc.record({ kind: fc.constant('load'), key: fc.constantFrom(...KEYS) }),
  fc.record({ kind: fc.constant('refresh'), key: fc.constantFrom(...KEYS) }),
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

  for (const action of steps) {
    switch (action.kind) {
      case 'load':
      case 'refresh': {
        const call = action.kind === 'load' ? resource.load(action.key) : resource.refresh(action.key);
        if (action.kind === 'refresh') call.catch(() => undefined);
        const id = started;
        if (lastStarted?.key !== action.key) allowed = new Set(['initial']);
        lastStarted = { id, key: action.key, flag: action.kind === 'load' ? 'loading' : 'refreshing' };
        lastSettled = false;
        // Data on screen until this request answers: whatever was allowed for this key.
        allowed.add(`response:${id}`);
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
        if (action.ok) request.resolve(`response:${request.id}`);
        else request.reject(new Error(`failed ${request.id}`));
        await flush();
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
