#!/usr/bin/env node
// Behaviour parity harness: run the same scripted scenario against a term2 CLI build and compare
// what can be observed from outside against a golden recorded from the current architecture.
//
//   node rewrite/parity/run.mjs record [--cli dist/cli.js] [scenario-id...]   write goldens
//   node rewrite/parity/run.mjs check  [--cli <path>]      [scenario-id...]   compare to goldens
//
// Observables, all architecture-neutral:
//   exitCode, stdout, stderr   what the user sees (paths, ids, timings and ANSI normalized away)
//   requests                   what the model sees: every provider request, message by message,
//                              with each tool's schema reduced to a hash so a changed description
//                              or parameter still shows up as a difference
//   files                      what the run did to the workspace
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const scenariosDir = path.join(here, 'scenarios');
const goldensDir = path.join(here, 'goldens');
const RUN_TIMEOUT_MS = 60_000;

// ---------- Fake provider: OpenAI-compatible chat completions, scripted per request ----------

function framesFor(response, n, substitute) {
  const id = `chatcmpl-${n}`;
  if (response.toolCalls) {
    const calls = response.toolCalls.map((call, index) => ({
      index,
      id: `call_${n}_${index}`,
      type: 'function',
      function: { name: call.name, arguments: substitute(JSON.stringify(call.arguments ?? {})) },
    }));
    return [
      { id, choices: [{ delta: { role: 'assistant', tool_calls: calls } }] },
      { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
  }
  return [
    { id, choices: [{ delta: { role: 'assistant', content: substitute(response.text ?? 'done') } }] },
    {
      id,
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  ];
}

async function startProvider(script, substitute) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        // recorded below as unparseable
      }
      requests.push(parsed ?? { unparseable: true, path: req.url });
      const n = requests.length;
      const response = script[n - 1] ?? { text: 'done' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          ...framesFor(response, n, substitute).map((frame) => `data: ${JSON.stringify(frame)}\n`),
          'data: [DONE]',
          '',
        ].join('\n'),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------- One isolated run ----------

function settingsDirectory(home, env) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Logs', 'term2-nodejs');
  return path.join(env.XDG_STATE_HOME, 'term2-nodejs');
}

function spawnCli(cli, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: signal ? `signal:${signal}` : code, stdout, stderr });
    });
  });
}

async function runScenario(cli, scenario) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-parity-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  for (const [name, content] of Object.entries(scenario.seed ?? {})) {
    fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    fs.writeFileSync(path.join(workspace, name), content);
  }
  const substitute = (text) => text.replaceAll('{{WORKSPACE}}', workspace);
  const provider = await startProvider(scenario.provider ?? [], substitute);
  const env = {
    PATH: process.env.PATH,
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
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  const settingsDir = settingsDirectory(home, env);
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify(
      deepMerge(
        {
          agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
          providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: provider.baseUrl, apiKey: 'test-key' }],
          sandbox: { enabled: false },
        },
        scenario.settings ?? {},
      ),
    ),
  );

  try {
    const runs = [];
    for (const run of scenario.runs) {
      const before = provider.requests.length;
      // {{LAST_CONVERSATION}} = the id of the most recently saved conversation, for --resume runs.
      const last = latestConversation(env.TERM2_CONVERSATIONS_DIR);
      const args = run.args.map((arg) => substitute(arg).replaceAll('{{LAST_CONVERSATION}}', last ?? '<none>'));
      const result = await spawnCli(cli, args, env, workspace);
      runs.push({ ...result, requests: provider.requests.slice(before) });
    }
    const normalize = normalizer({ root, home, workspace, baseUrl: provider.baseUrl });
    return {
      scenario: scenario.id,
      runs: runs.map((run) => ({
        exitCode: run.exitCode,
        stdout: normalize.text(run.stdout),
        stderr: normalize.text(run.stderr),
        requests: run.requests.map((request) => normalize.request(request)),
      })),
      files: readTree(workspace),
    };
  } finally {
    await provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function latestConversation(dir) {
  if (!fs.existsSync(dir)) return null;
  const newest = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return newest ? newest.name.slice(0, -'.jsonl'.length) : null;
}

function readTree(dir, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, readTree(path.join(dir, entry.name), rel));
    else files[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
  }
  return files;
}

function deepMerge(base, extra) {
  if (Array.isArray(extra) || typeof extra !== 'object' || extra === null) return extra;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = typeof base?.[key] === 'object' && !Array.isArray(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

// ---------- Normalization: remove what legitimately differs between two runs ----------

function normalizer({ root, home, workspace, baseUrl }) {
  const replacements = [
    [workspace, '<WORKSPACE>'],
    [home, '<HOME>'],
    [root, '<ROOT>'],
    [baseUrl, '<PROVIDER>'],
    // The system prompt names the host OS; goldens must not depend on the recording machine.
    [`${os.type()} ${os.release()} (${process.platform})`, '<OS>'],
  ];
  const text = (value) => {
    let out = stripVTControlCharacters(String(value));
    for (const [from, to] of replacements) out = out.replaceAll(from, to);
    return (
      out
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
        // Background subagent run IDs are random adjective-noun-number codenames.
        .replace(/(runId["']?:\s*["']?)[a-z]+-[a-z]+-\d+/g, '$1<RUN_ID>')
        .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<TIMESTAMP>')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>')
        .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, '<DURATION>')
        .replace(/\bpid[ =:]\d+\b/gi, 'pid <PID>')
    );
  };
  const content = (value) =>
    typeof value === 'string' ? text(value) : Array.isArray(value) ? value.map((part) => deepText(part)) : value;
  const deepText = (value) => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(deepText);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepText(v)]));
    return value;
  };
  const request = (body) => {
    if (body.unparseable) return { unparseable: true, path: body.path };
    return {
      model: body.model,
      stream: body.stream,
      messages: (body.messages ?? []).map((message) => ({
        role: message.role,
        ...(message.content !== undefined ? { content: content(message.content) } : {}),
        ...(message.tool_calls
          ? {
              tool_calls: message.tool_calls.map((call) => ({
                id: call.id,
                name: call.function?.name,
                arguments: text(call.function?.arguments ?? ''),
              })),
            }
          : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      })),
      tools: (body.tools ?? []).map((tool) => ({
        name: tool.function?.name ?? tool.name,
        schema: crypto.createHash('sha256').update(JSON.stringify(tool)).digest('hex').slice(0, 16),
      })),
      // Every other request field, so a new or changed parameter is visible.
      other: deepText(
        Object.fromEntries(
          Object.entries(body).filter(([key]) => !['model', 'stream', 'messages', 'tools'].includes(key)),
        ),
      ),
    };
  };
  return { text, request };
}

// ---------- Compare ----------

function differences(expected, actual, at = '$', out = []) {
  if (out.length >= 20) return out;
  if (typeof expected !== typeof actual || Array.isArray(expected) !== Array.isArray(actual)) {
    out.push(
      `${at}: expected ${JSON.stringify(expected)?.slice(0, 200)}, got ${JSON.stringify(actual)?.slice(0, 200)}`,
    );
  } else if (expected && typeof expected === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys)
      differences(expected[key], actual[key], Array.isArray(expected) ? `${at}[${key}]` : `${at}.${key}`, out);
  } else if (typeof expected === 'string' && expected !== actual) {
    // Show where long strings (prompts, output) first diverge, not just their heads.
    let index = 0;
    while (expected[index] === actual[index]) index += 1;
    const window = (value) => JSON.stringify(value.slice(Math.max(0, index - 60), index + 80));
    out.push(
      `${at} differs at character ${index}:\n    expected …${window(expected)}…\n    got      …${window(actual)}…`,
    );
  } else if (expected !== actual) {
    out.push(
      `${at}: expected ${JSON.stringify(expected)?.slice(0, 200)}, got ${JSON.stringify(actual)?.slice(0, 200)}`,
    );
  }
  return out;
}

// ---------- Main ----------

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode !== 'record' && mode !== 'check') {
    console.error('usage: run.mjs record|check [--cli <path>] [scenario-id...]');
    process.exit(2);
  }
  const cliIndex = rest.indexOf('--cli');
  const cli = path.resolve(cliIndex >= 0 ? rest[cliIndex + 1] : path.join(repo, 'dist', 'cli.js'));
  const ids = rest.filter((_, index) => cliIndex < 0 || (index !== cliIndex && index !== cliIndex + 1));
  const scenarios = fs
    .readdirSync(scenariosDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(scenariosDir, name), 'utf8')))
    .filter((scenario) => ids.length === 0 || ids.includes(scenario.id));
  if (!fs.existsSync(cli)) throw new Error(`no CLI at ${cli}; build it first`);
  fs.mkdirSync(goldensDir, { recursive: true });

  let failed = 0;
  for (const scenario of scenarios) {
    const observed = await runScenario(cli, scenario);
    const goldenPath = path.join(goldensDir, `${scenario.id}.json`);
    if (mode === 'record') {
      fs.writeFileSync(goldenPath, JSON.stringify(observed, null, 2) + '\n');
      console.log(`recorded ${scenario.id}`);
      continue;
    }
    if (!fs.existsSync(goldenPath)) {
      failed += 1;
      console.log(`FAIL ${scenario.id}: no golden; record it from the current architecture first`);
      continue;
    }
    const diff = differences(JSON.parse(fs.readFileSync(goldenPath, 'utf8')), observed);
    if (diff.length === 0) console.log(`ok   ${scenario.id}`);
    else {
      failed += 1;
      console.log(`FAIL ${scenario.id}\n  ${diff.join('\n  ')}`);
    }
  }
  if (mode === 'check') {
    console.log(`\n${scenarios.length - failed}/${scenarios.length} scenarios match their goldens`);
    process.exit(failed === 0 ? 0 : 1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
