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
let sequence = 0;
const pending = new Map();
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
function call(name, payload) {
  const requestId = String(++sequence);
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    send(name + '.run', Object.assign({ requestId }, payload));
  });
}
function factoryBinding(name) {
  return (config) => Object.freeze({ run(input) { return call(name, { config, input }); } });
}
function namespaceBinding(name, members) {
  const namespace = Object.create(null);
  for (const member of members) namespace[member] = (params) => call(name, { member, params });
  return Object.freeze(namespace);
}
const sandbox = Object.create(null);
for (const capability of capabilities) {
  sandbox[capability.name] = capability.kind === 'namespace'
    ? namespaceBinding(capability.name, capability.members)
    : factoryBinding(capability.name);
}
// A transport guard only: the host independently validates console data and
// applies the cumulative budget before forwarding it to observers.
sandbox.console = Object.freeze({ log: (...values) => {
  if (!values.every(value => json(value))) return;
  try {
    if (workerData.maxConsoleBytes !== undefined && Buffer.byteLength(JSON.stringify(values), 'utf8') > workerData.maxConsoleBytes) return;
    send('console.log', { values });
  } catch (_) {}
} });
const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
parentPort.on('message', (message) => {
  if (typeof message.type === 'string' && message.type.endsWith('.result')) {
    const resolve = pending.get(message.requestId);
    pending.delete(message.requestId);
    if (resolve) resolve(message.result);
  }
});
(async () => {
  try {
    const script = new vm.Script('(async () => { "use strict";\n' + workerData.code + '\n})()', { filename: 'workflow.js' });
    const output = await script.runInContext(context, { timeout: workerData.syncTimeoutMs });
    if (!json(output)) throw new Error((workerData.subject || 'Script') + ' return value must be JSON-safe');
    send('workflow.complete', { output });
  } catch (err) {
    send('workflow.error', { error: error(err), syntax: err instanceof SyntaxError });
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
