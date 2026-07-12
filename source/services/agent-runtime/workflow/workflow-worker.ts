/** JavaScript evaluated in a disposable worker thread. It deliberately exposes
 * only the context globals below; Node's worker globals never enter vm context. */
export const WORKFLOW_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
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
function agent(config) {
  return Object.freeze({ run(input) {
    const requestId = String(++sequence);
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      send('agent.run', { requestId, config, input });
    });
  }});
}
const sandbox = Object.create(null);
sandbox.agent = agent;
sandbox.console = Object.freeze({ log: (...values) => send('console.log', { values: values.filter(value => json(value)) }) });
const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
parentPort.on('message', (message) => {
  if (message.type === 'agent.result') { const resolve = pending.get(message.requestId); pending.delete(message.requestId); if (resolve) resolve(message.result); }
});
(async () => {
  try {
    const script = new vm.Script('(async () => { "use strict";\n' + workerData.code + '\n})()', { filename: 'workflow.js' });
    const output = await script.runInContext(context, { timeout: workerData.syncTimeoutMs });
    if (!json(output)) throw new Error('Workflow return value must be JSON-safe');
    send('workflow.complete', { output });
  } catch (err) {
    send('workflow.error', { error: error(err), syntax: err instanceof SyntaxError });
  }
})();
`;
