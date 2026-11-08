// Count the modules one user message passes through on the production path,
// from the headless client's submit to the provider's HTTP request, and fail
// when that path grows past the recorded budget.
//
// The real entry runs in this process as `term2 "hello"` against a local
// fake OpenAI-compatible provider, so the path measured is the one a shipped
// headless message takes. The provider call is the first fetch to that server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHook, executionAsyncId } from 'node:async_hooks';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const budget = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/complexity-budget.json'), 'utf8')).messagePath;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-hops-')));
const home = path.join(root, 'home');
const workspace = path.join(root, 'workspace');
for (const dir of [home, workspace, path.join(root, 'runtime'), path.join(root, 'tmp')])
  fs.mkdirSync(dir, { recursive: true });

// One streamed chat-completions answer for every POST.
const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-hops',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })}\n\n`;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"object":"list","data":[]}');
    return;
  }
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', content: 'done' }));
    res.write(chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

const stateDir = path.join(home, '.local', 'state', 'term2-nodejs');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, 'settings.json'),
  JSON.stringify({
    agent: { retryAttempts: 0, modelSelection: { provider: 'mockprov', model: 'fixture' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
    sandbox: { enabled: false },
  }),
);
Object.assign(process.env, {
  LANG: 'C.UTF-8',
  TZ: 'UTC',
  TERM: 'dumb',
  NO_COLOR: '1',
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_STATE_HOME: path.join(home, '.local', 'state'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_RUNTIME_DIR: path.join(root, 'runtime'),
  TMPDIR: path.join(root, 'tmp'),
  TERM2_CONFIG_DIR: path.join(home, '.term2'),
  TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
  TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
  DISABLE_LOGGING: '1',
});
process.chdir(workspace);

// Async stack traces stop at detached launches, so follow the async resource
// chain from the provider call back to the entry and join each creation stack.
Error.stackTraceLimit = 200;
const created = new Map<number, { trigger: number; stack: string }>();
const hook = createHook({
  init(id, _type, trigger) {
    created.set(id, { trigger, stack: new Error().stack ?? '' });
  },
});
let stack: string | undefined;
const causalStack = () => {
  const stacks = [new Error('provider call').stack ?? ''];
  for (let id = executionAsyncId(), seen = 0; created.has(id) && seen < 10000; seen++) {
    const entry = created.get(id)!;
    stacks.push(entry.stack);
    id = entry.trigger;
  }
  return stacks
    .reverse()
    .map((frames) => frames.split('\n').reverse().join('\n'))
    .join('\n');
};
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(baseUrl) && init?.method === 'POST') stack ??= causalStack();
  return realFetch(input, init);
}) as typeof fetch;

// The entry ends with process.exit; keep this process alive to report, and
// exit with the real one so the entry's open handles cannot hold it.
const realExit = process.exit.bind(process);
process.on('uncaughtExceptionMonitor', () => setImmediate(() => realExit(1)));
const exited = new Promise<number>((resolve) => {
  process.exit = ((code?: number) => resolve(Number(code ?? 0))) as typeof process.exit;
});
const output: string[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array) => (output.push(String(chunk)), true)) as typeof write;
process.argv = [process.execPath, path.join(repo, 'src/app/cli.ts'), 'hello'];

let code: number;
hook.enable();
try {
  await import(pathToFileURL(path.join(repo, 'src/app/cli.ts')).href);
  code = await exited;
} finally {
  hook.disable();
  process.stdout.write = write;
  server.closeAllConnections();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
assert.equal(code, 0, `cli exited ${code}: ${output.join('')}`);
assert.ok(stack, 'provider was never called');

// Read the joined stacks outermost caller first. `at async` frames re-list the
// awaiting callers that the async-resource chain already covers, so skip them.
const sequence: string[] = [];
for (const line of stack.split('\n')) {
  if (line.trim().startsWith('at async ')) continue;
  const match = /\(?((?:file:\/\/)?\/[^():]+\.m?tsx?):\d+:\d+\)?$/.exec(line.trim());
  if (!match) continue;
  const file = path.relative(repo, match[1]!.replace(/^file:\/\//, ''));
  if (file.startsWith('..') || file.includes('node_modules') || file.startsWith('bench/')) continue;
  if (sequence.at(-1) !== file) sequence.push(file);
}
// The message path starts where the client hands the message to the host, as a
// user message does in every mode; startup work before it is not message path.
const START = 'src/clients/headless/direct.ts';
assert.ok(sequence.includes(START), `the provider call was not caused by ${START}`);
// Fold the sequence into the chain of files still active at the provider call:
// returning to a file already on the chain pops back to it, so finished setup
// work and re-entered loops count once. Each file on the chain is one hop.
const files: string[] = [];
for (const file of sequence.slice(sequence.indexOf(START))) {
  const index = files.indexOf(file);
  if (index >= 0) files.length = index + 1;
  else files.push(file);
}
const distinct = [...new Set(files)];
const layerOf = (file: string) =>
  file.startsWith('packages/agent-harness-core/src/engine/') ? 'engine' : /^src\/([^/]+)\//.exec(file)?.[1] ?? 'other';
const layers = files.map(layerOf).filter((layer, index, all) => layer !== all[index - 1]);

console.log(
  `message path: ${files.length} hops through ${distinct.length} files; ` +
    `${sequence.length} file transitions before folding`,
);
console.log(`layers: ${layers.join(' -> ')}`);
for (const file of files) console.log(`  ${file}`);
assert.ok(files.length > 0, 'stack trace named no repository files');
// The path must be the production direct one (the bench-only bridge files are deleted).
for (const required of ['src/host/in-process-direct.ts', 'src/session/session.ts', 'src/app/generation-guard.ts'])
  assert.ok(
    distinct.includes(required),
    `message path no longer goes through ${required}; hops must measure the production direct path`,
  );
assert.ok(
  files.length <= budget.maxHops,
  `message path grew to ${files.length} hops (budget ${budget.maxHops}); simplify the path or justify raising the budget`,
);
assert.ok(
  distinct.length <= budget.maxFiles,
  `message path touches ${distinct.length} files (budget ${budget.maxFiles})`,
);
if (files.length < budget.maxHops || distinct.length < budget.maxFiles)
  console.log(
    `path is under budget: lower messagePath to { maxHops: ${files.length}, maxFiles: ${distinct.length} } in scripts/complexity-budget.json`,
  );
console.log('PASS message path within budget');
realExit(0);
