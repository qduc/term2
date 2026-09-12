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
let closeRequested = false;
let admissionClosed = false;
let settlementScheduled = false;
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
function emitSettledIfReady() {
  if (!closeRequested || inflight.size !== 0 || finished || settlementScheduled) return;
  settlementScheduled = true;
  queueMicrotask(() => {
    settlementScheduled = false;
    if (!closeRequested || inflight.size !== 0 || finished) return;
    const unhandled = getUnhandled();
    finishSend('workflow.settled', { unhandled });
  });
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
    if (admissionClosed) return;
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
  const nestedStates = new Map();
  function trackedPromise(promise, state) {
    // Keep the worker alive for unawaited calls without letting Node report an
    // unhandled rejection. Script-supplied rejection handlers are tracked
    // separately so an unobserved nested failure remains diagnosable.
    promise.catch(() => {});
    const tracked = {
      then(onFulfilled, onRejected) {
        if (typeof onRejected === 'function') state.observed = true;
        return trackedPromise(promise.then(onFulfilled, onRejected), state);
      },
      catch(onRejected) {
        if (typeof onRejected === 'function') state.observed = true;
        return trackedPromise(promise.catch(onRejected), state);
      },
      finally(onFinally) {
        return trackedPromise(promise.finally(onFinally), state);
      },
    };
    return tracked;
  }
  // Structured clone can carry host-realm objects such as Date, Map, and Error.
  // Capability arguments must not use that wider transport: normalize them in
  // this realm first, so the bridge only ever sees JSON-created plain data.
  function serializeTransport(value) {
    let encoded;
    try {
      encoded = JSON.stringify(value);
    } catch (_) {
      throw new TypeError('Capability arguments must be JSON-serializable');
    }
    if (encoded === undefined) return null;
    try {
      return JSON.parse(encoded);
    } catch (_) {
      throw new TypeError('Capability arguments must be JSON-serializable');
    }
  }
  function call(name, payload) {
    const requestId = String(++sequence);
    const state = { observed: false, rejected: false, message: '' };
    nestedStates.set(requestId, state);
    const promise = new Promise((resolve) => {
      pending.set(requestId, { resolve, state });
      bridge(name + '.run', Object.assign({ requestId }, serializeTransport(payload)));
    });
    return { promise: trackedPromise(promise, state), state };
  }
  function factoryBinding(name) {
    return (config) => Object.freeze({ run(input) { return call(name, { config, input }).promise; } });
  }
  function namespaceBinding(name, members) {
    const namespace = Object.create(null);
    for (const member of members) {
      const callable = (params) => {
        const callState = call(name, { member, params });
        return callState.promise.then((response) => {
          // Namespace members speak an { ok, result | error } envelope so a refused or
          // failed call is catchable inside the script instead of a silent value.
          if (!response || typeof response !== 'object') return response;
          // Naming the tool here is what lets a model tell which call of a fan-out
          // failed: the underlying message often does not (e.g. 'rg: regex parse error').
          if (response.ok === false) {
            callState.state.rejected = true;
            callState.state.message = 'tools.' + member + ' failed: ' + String(response.error);
            throw new Error(callState.state.message);
          }
          return response.result;
        });
      };
      // Assignment gives the magic __proto__ member setter prototype-mutating
      // semantics. Define an own data property for every member instead.
      Object.defineProperty(namespace, member, {
        value: callable,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    // Unknown members explain themselves instead of surfacing as
    // 'tools.x is not a function', which names neither the problem nor the fix.
    const guarded = new Proxy(namespace, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'string') {
           const unknown = new Error('Unknown tool "' + prop + '". Available: ' + members.join(', '));
           unknown.code = 'unknown_tool';
           throw unknown;
        }
        return undefined;
      },
    });
    return Object.freeze(guarded);
  }
  for (const capability of capabilityDefinitions) {
    // Assignment gives the magic global __proto__ name prototype-mutating
    // semantics. Define an own data property for every capability name.
    Object.defineProperty(globalThis, capability.name, {
      value: capability.kind === 'namespace' ? namespaceBinding(capability.name, capability.members) : factoryBinding(capability.name),
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  // A transport guard only: the host independently validates console data and
  // applies the cumulative budget before forwarding it to observers.
  globalThis.console = Object.freeze({ log: (...values) => {
    if (!values.every(value => json(value))) return;
    try {
      bridge('console.log', { values: serializeTransport(values) });
    } catch (_) {}
  } });
  return {
    resolve(requestId, result) {
      const entry = pending.get(requestId);
      pending.delete(requestId);
      if (!entry) return;
      const encoded = JSON.stringify(result);
      entry.resolve(encoded === undefined ? null : JSON.parse(encoded));
    },
    getUnhandled() {
      return Array.from(nestedStates).filter(([, state]) => state.rejected && !state.observed).map(([requestId, state]) => ({
        requestId,
        message: state.message || 'nested call failed',
      }));
    },
  };
}
const responseHandlers = vm.runInContext('(' + installContextBindings.toString() + ')()', context);
const resolveResponse = responseHandlers.resolve;
const getUnhandled = responseHandlers.getUnhandled;
function firstScriptFrame(stack) {
  var stackLines = stack ? String(stack).split('\n') : [];
  for (var i = 0; i < stackLines.length; i++) {
    var match = /^(?:at )?workflow\.js:(\d+)(?::(\d+))?$/.exec(stackLines[i].trim());
    if (match) return match;
  }
  return null;
}
function scriptLineDetail(code, frame) {
  if (!frame) return null;
  var userLine = Number(frame[1]) - 1;
  var sourceLines = String(code).split('\n');
  if (!(userLine >= 1 && userLine <= sourceLines.length)) return null;
  var excerpt = sourceLines[userLine - 1].trim();
  if (excerpt.length > 140) excerpt = excerpt.slice(0, 140) + '...';
  return 'Line ' + userLine + (frame[2] ? ':' + frame[2] : '') + ': ' + excerpt;
}
function syntaxErrorDetail(code, err) {
  var located = scriptLineDetail(code, firstScriptFrame(err && err.stack));
  var detail = located
    ? '\n\n' + located
    : '\n\nThe error was reported at the end of the script: a block, string, or template literal is likely unterminated.';
  return detail + '\n\nScripts run as plain JavaScript in this sandbox: no TypeScript annotations, no Node imports, and no dynamic import(); patch or file text you embed must be an escaped string inside the script, and an unescaped backtick or template substitution breaks the whole script.';
}
function runtimeErrorDetail(code, err) {
  var located = scriptLineDetail(code, firstScriptFrame(err && err.stack));
  return located ? '\n\nAt script ' + located : '';
}

if (typeof resolveResponse !== 'function' || typeof getUnhandled !== 'function') throw new Error('Failed to install sandbox bindings');
parentPort.on('message', (message) => {
  if (typeof message.type === 'string' && message.type.endsWith('.result')) {
    resultsConsumed++;
    inflight.delete(String(message.requestId));
    resolveResponse(message.requestId, message.result);
    emitBusy();
    scheduleIdle();
    emitSettledIfReady();
    return;
  }
  if (message.type === 'workflow.close') {
    closeRequested = true;
    emitSettledIfReady();
  }
});
(async () => {
  try {
    const script = new vm.Script('(async () => { "use strict";\n' + workerData.code + '\n})()', { filename: 'workflow.js' });
    const output = await script.runInContext(context, { timeout: workerData.syncTimeoutMs });
    if (output === undefined && workerData.allowVoidOutput) {
      admissionClosed = true;
      send('workflow.body-complete', { output: null, voidOutput: true });
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
    admissionClosed = true;
    send('workflow.body-complete', { output: serialized.value });
  } catch (err) {
    // Compile errors are raised by the host-realm 'new vm.Script(...)' above, so
    // 'err instanceof SyntaxError' is meaningful only here. A SyntaxError thrown
    // *inside* the script comes from the vm realm and deliberately fails this
    // host instanceof check: runtime errors must never receive compile guidance.
    var reported = error(err);
    if (err instanceof SyntaxError) {
      reported.message = reported.message + syntaxErrorDetail(workerData.code, err);
    } else if (reported.message.indexOf('A dynamic import callback was not specified') === 0) {
      reported.message =
        reported.message + '\n\ndynamic import() is unavailable inside the sandbox: scripts run as plain JavaScript.';
    } else {
      var at = runtimeErrorDetail(workerData.code, err);
      if (at) reported.message = reported.message + at;
    }
    admissionClosed = true;
     send('workflow.body-error', {
       error: reported,
       syntax: err instanceof SyntaxError,
       ...(err && err.code === 'unknown_tool' ? { detail: 'unknown_tool' } : {}),
     });
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
