import type { CapabilityBinding } from './host-types.js';

/**
 * The worker template. It is fixed source: the only thing a caller injects is
 * the capability *name* list below, serialized as JSON. No handler body is ever
 * generated, which is what keeps the sandbox auditable now that the source is
 * built rather than written.
 *
 * The context exposes only the bound capabilities and `console`; Node's worker
 * globals never enter the vm context.
 */
const WORKER_TEMPLATE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const capabilities = __CAPABILITIES__;
function send(type, payload) { parentPort.postMessage({ type, ...payload }); }
function error(error) { return { name: error && error.name || 'Error', message: error && error.message || String(error) }; }
function json(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  const valid = values.every(v => json(v, ancestors));
  ancestors.delete(value);
  return valid;
}
function jsonPathProperty(path, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? path + '.' + key : path + '[' + JSON.stringify(key) + ']';
}
function jsonFailure(path, reason) {
  return { ok: false, path, reason };
}
function serializeJson(value, path = '$', ancestors = new Set(), propertyKey = '', skipToJSON = false) {
  if (value === undefined) return jsonFailure(path, 'undefined');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : jsonFailure(path, 'a non-finite number');
  if (typeof value === 'function') return jsonFailure(path, 'a function');
  if (typeof value === 'symbol') return jsonFailure(path, 'a symbol');
  if (typeof value === 'bigint') return jsonFailure(path, 'a BigInt');
  if (typeof value !== 'object') return jsonFailure(path, 'an unsupported value');

  if (!skipToJSON) {
    let toJSON;
    try {
      toJSON = value.toJSON;
    } catch (_) {
      return jsonFailure(path, 'a property that threw when read');
    }
    if (typeof toJSON === 'function') {
      let replacement;
      try {
        replacement = Reflect.apply(toJSON, value, [propertyKey]);
      } catch (_) {
        return jsonFailure(path, 'a toJSON method that threw when called');
      }
      if (replacement === undefined)
        return path === '$' && propertyKey === '' ? jsonFailure(path, 'undefined') : { ok: true, value: undefined };
      return serializeJson(replacement, path, ancestors, propertyKey, true);
    }
  }

  if (ancestors.has(value)) return jsonFailure(path, 'a cycle');

  ancestors.add(value);
  let isArray;
  try {
    isArray = Array.isArray(value);
  } catch (_) {
    ancestors.delete(value);
    return jsonFailure(path, 'a property that threw when read');
  }
  if (isArray) {
    let length;
    try {
      length = value.length;
    } catch (_) {
      ancestors.delete(value);
      return jsonFailure(path, 'a property that threw when read');
    }
    const output = new Array(length);
    for (let index = 0; index < length; index++) {
      let item;
      try {
        item = value[index];
      } catch (_) {
        ancestors.delete(value);
        return jsonFailure(path + '[' + index + ']', 'a property that threw when read');
      }
      if (item === undefined) {
        output[index] = null;
        continue;
      }
      const serialized = serializeJson(item, path + '[' + index + ']', ancestors, String(index));
      if (!serialized.ok) {
        ancestors.delete(value);
        return serialized;
      }
      output[index] = serialized.value === undefined ? null : serialized.value;
    }
    ancestors.delete(value);
    return { ok: true, value: output };
  }

  const output = {};
  let keys;
  try {
    keys = Object.keys(value);
  } catch (_) {
    ancestors.delete(value);
    return jsonFailure(path, 'a property that threw when read');
  }
  for (const key of keys) {
    let item;
    try {
      item = value[key];
    } catch (_) {
      ancestors.delete(value);
      return jsonFailure(jsonPathProperty(path, key), 'a property that threw when read');
    }
    if (item === undefined) continue;
    const serialized = serializeJson(item, jsonPathProperty(path, key), ancestors, key);
    if (!serialized.ok) {
      ancestors.delete(value);
      return serialized;
    }
    if (serialized.value === undefined) continue;
    Object.defineProperty(output, key, {
      value: serialized.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  ancestors.delete(value);
  return { ok: true, value: output };
}
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const inflight = new Set();
let resultsConsumed = 0;
let finished = false;
let lastWasIdle = false;
let idleScheduled = false;
function emitBusy() {
  if (!lastWasIdle) return;
  lastWasIdle = false;
  send('workflow.busy', { resultsConsumed });
}
function emitIdle() {
  if (finished) return;
  lastWasIdle = true;
  send('workflow.idle', { pending: Array.from(inflight), resultsConsumed });
}
function scheduleIdle() {
  if (finished || idleScheduled) return;
  idleScheduled = true;
  setImmediate(() => {
    idleScheduled = false;
    emitIdle();
  });
}
function finishSend(type, payload) {
  emitBusy();
  finished = true;
  send(type, payload);
}
// This is the only host-realm callable made available during context setup.
// Its prototype is severed, it returns no host value, and it is deleted from
// the global object before user code runs. The context-created wrappers retain
// it only as a private transport capability.
const bridge = (type, payload) => {
  if (type === 'console.log') {
    try {
      const values = payload && payload.values;
      if (!Array.isArray(values) || !values.every(value => json(value))) return;
      if (workerData.maxConsoleBytes !== undefined && Buffer.byteLength(JSON.stringify(values), 'utf8') > workerData.maxConsoleBytes) return;
      emitBusy();
      parentPort.postMessage({ type, values });
    } catch (_) {}
    return;
  }
  if (typeof type === 'string' && type.endsWith('.run')) {
    emitBusy();
    if (payload && payload.requestId !== undefined) inflight.add(String(payload.requestId));
    parentPort.postMessage({ type, ...(payload || {}) });
    scheduleIdle();
    return;
  }
  parentPort.postMessage({ type, ...(payload || {}) });
};
Object.setPrototypeOf(bridge, null);
context.__bridge = bridge;
context.__capabilities = JSON.stringify(capabilities);
function installContextBindings() {
  const bridge = globalThis.__bridge;
  const capabilityDefinitions = JSON.parse(globalThis.__capabilities);
  function json(value, ancestors = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || ancestors.has(value)) return false;
    ancestors.add(value);
    const values = Array.isArray(value) ? value : Object.values(value);
    const valid = values.every(v => json(v, ancestors));
    ancestors.delete(value);
    return valid;
  }
  delete globalThis.__bridge;
  delete globalThis.__capabilities;
  let sequence = 0;
  const pending = new Map();
  function call(name, payload) {
    const requestId = String(++sequence);
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      bridge(name + '.run', Object.assign({ requestId }, payload));
    });
  }
  function factoryBinding(name) {
    return (config) => Object.freeze({ run(input) { return call(name, { config, input }); } });
  }
  function namespaceBinding(name, members) {
    const namespace = Object.create(null);
    for (const member of members) namespace[member] = (params) => call(name, { member, params }).then((response) => {
      // Namespace members speak an { ok, result | error } envelope so a refused or
      // failed call is catchable inside the script instead of a silent value.
      if (!response || typeof response !== 'object') return response;
      if (response.ok === false) throw new Error(String(response.error));
      return response.result;
    });
    return Object.freeze(namespace);
  }
  for (const capability of capabilityDefinitions) {
    globalThis[capability.name] = capability.kind === 'namespace'
      ? namespaceBinding(capability.name, capability.members)
      : factoryBinding(capability.name);
  }
  // A transport guard only: the host independently validates console data and
  // applies the cumulative budget before forwarding it to observers.
  globalThis.console = Object.freeze({ log: (...values) => {
    if (!values.every(value => json(value))) return;
    bridge('console.log', { values });
  } });
  return (requestId, result) => {
    const resolve = pending.get(requestId);
    pending.delete(requestId);
    if (!resolve) return;
    const encoded = JSON.stringify(result);
    resolve(encoded === undefined ? null : JSON.parse(encoded));
  };
}
const resolveResponse = vm.runInContext('(' + installContextBindings.toString() + ')()', context);
if (typeof resolveResponse !== 'function') throw new Error('Failed to install sandbox bindings');
parentPort.on('message', (message) => {
  if (typeof message.type === 'string' && message.type.endsWith('.result')) {
    resultsConsumed++;
    inflight.delete(String(message.requestId));
    resolveResponse(message.requestId, message.result);
    emitBusy();
    scheduleIdle();
  }
});
(async () => {
  try {
    const script = new vm.Script('(async () => { "use strict";\n' + workerData.code + '\n})()', { filename: 'workflow.js' });
    const output = await script.runInContext(context, { timeout: workerData.syncTimeoutMs });
    if (output === undefined && workerData.allowVoidOutput) {
      finishSend('workflow.complete', { output: null, voidOutput: true });
      return;
    }
    const serialized = serializeJson(output);
    if (!serialized.ok)
      throw new Error(
        (workerData.subject || 'Script') +
          ' return value is not JSON-safe: ' +
          serialized.path +
          ' is ' +
          serialized.reason +
          '.\n' +
          resultsConsumed +
          ' nested tool calls already completed — inspect state before retrying.',
      );
    finishSend('workflow.complete', { output: serialized.value });
  } catch (err) {
    finishSend('workflow.error', { error: error(err), syntax: err instanceof SyntaxError });
  }
})();
`;

/**
 * Builds the worker source for a set of capabilities.
 *
 * Only names reach the template, and they go through `JSON.stringify`, so a
 * capability name can never become executable source.
 */
export function buildWorkerSource(bindings: readonly CapabilityBinding[]): string {
  return WORKER_TEMPLATE.replace('__CAPABILITIES__', () => JSON.stringify(bindings));
}
