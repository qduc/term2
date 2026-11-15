#!/usr/bin/env node
// Fixed prefix report: what every model request carries before any conversation content.
//
//   node scripts/token-prefix-report.mjs [--cli dist/cli.js] [--json] [--list] [--dump <dir>] [scenario-id...]
//
// Each scenario launches the built CLI in an isolated HOME against a scripted OpenAI-compatible
// chat-completions double (the conventions of parity/run.mjs), captures one request body and
// breaks it down: system prompt, each tool definition, and the first-turn messages that are not
// the system prompt. No network and no keys. Token figures are chars/4, an estimate, not a
// tokenizer count. This is a reporting tool: it asserts nothing and belongs to no gate.
//
// The interactive TUI selects the Bare profile for every model id, as headless runs do. The
// model-family base prompts (gpt.md, anthropic.md, kimi.md, simple_v4.md) are selected only by
// profiles whose identity is `model-family-base`: plan, pair, mentor and orchestrator, which
// isDroppedProfile() refuses (#149). Those launches are kept as expected refusals, so the report
// notices when one becomes reachable again and needs a real scenario.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_TIMEOUT_MS = 90_000;
const PROMPT = 'say hi';
/** Marks the delegated task so a child's first request can be told from the root's. */
const CHILD_TASK = 'PREFIX_REPORT_CHILD_TASK: reply with the single word done.';

const DEFAULT_MODEL = 'mock-alpha';
// Model ids chosen to select each model-family branch: selectPromptProfile for a root that uses a
// model-family prompt, selectSubagentBasePromptFile for subagents, and model-keyed tool selection.
const FAMILY_MODELS = { gpt: 'gpt-5.5', codex: 'gpt-5.3-codex', anthropic: 'claude-sonnet-4-5', kimi: 'kimi-k2' };

const headless = (id, description, model, args = []) => ({
  id,
  description,
  kind: 'headless',
  model,
  args,
  target: 'root',
});

const tui = (id, description, model, args = []) => ({ id, description, kind: 'tui', model, args, target: 'root' });

const subagent = (role, family) => ({
  id: `subagent-${role}${family ? `-${family}` : ''}`,
  description: `Subagent role "${role}"${
    family ? `, ${family}-style model id` : ''
  }, launched by a scripted run_subagent call from a headless root`,
  kind: 'headless',
  model: family ? FAMILY_MODELS[family] : DEFAULT_MODEL,
  args: ['--auto-approve'],
  target: 'child',
  rootScript: [{ name: 'run_subagent', arguments: { execution: 'background', role, task: CHILD_TASK } }],
});

/** A launch the CLI is expected to refuse; the report records the refusal instead of a size. */
const refused = (profile) => ({
  ...headless(`profile-${profile}`, `Headless root asked for the dropped ${profile} profile`, FAMILY_MODELS.gpt, [
    '--profile',
    profile,
  ]),
  expectRefusal: true,
});

const SCENARIOS = [
  headless('headless-root', 'Headless root, default profile (bare)', DEFAULT_MODEL),
  headless('headless-root-goal', 'Headless root with a durable goal (--goal)', DEFAULT_MODEL, [
    '--goal',
    'Report the fixed prefix size.',
  ]),
  ...Object.entries(FAMILY_MODELS).map(([family, model]) =>
    headless(`headless-root-${family}`, `Headless root, ${family}-style model id`, model),
  ),
  {
    id: 'subagent-generic',
    description: 'Generic agent_spec subagent (no named role), launched from a headless root',
    kind: 'headless',
    model: DEFAULT_MODEL,
    args: ['--auto-approve'],
    target: 'child',
    rootScript: [{ name: 'run_subagent', arguments: { execution: 'background', agent_spec: { goal: CHILD_TASK } } }],
  },
  ...['explorer', 'worker', 'mentor', 'reviewer', 'librarian'].map((role) => subagent(role)),
  ...['gpt', 'codex', 'anthropic'].map((family) => subagent('explorer', family)),
  ...['gpt', 'codex', 'anthropic'].map((family) => subagent('worker', family)),
  tui('tui-root', 'Interactive TUI root, default profile (bare)', DEFAULT_MODEL),
  ...Object.entries(FAMILY_MODELS).map(([family, model]) =>
    tui(`tui-root-${family}`, `Interactive TUI root, ${family}-style model id`, model),
  ),
  ...['plan', 'pair', 'mentor', 'orchestrator'].map(refused),
];

// ---------- Fake provider ----------

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
    ? content.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('')
    : content == null
    ? ''
    : JSON.stringify(content);

const isSystemRole = (role) => role === 'system' || role === 'developer';

/** A child's first request: no assistant turn yet, and the delegated task is the user content. */
function isChildFirstRequest(body) {
  const messages = body?.messages ?? [];
  if (messages.some((message) => message.role === 'assistant' || message.role === 'tool')) return false;
  return messages.some((message) => !isSystemRole(message.role) && textOf(message.content).includes(CHILD_TASK));
}

function frames(n, call) {
  const id = `chatcmpl-${n}`;
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  if (call) {
    const toolCall = {
      index: 0,
      id: `call_${n}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    };
    return [
      { id, choices: [{ delta: { role: 'assistant', tool_calls: [toolCall] } }] },
      { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage },
    ];
  }
  return [
    { id, choices: [{ delta: { role: 'assistant', content: 'done' } }] },
    { id, choices: [{ delta: {}, finish_reason: 'stop' }], usage },
  ];
}

async function startProvider(scenario) {
  const requests = [];
  let rootCount = 0;
  let onTarget;
  const targetCaptured = new Promise((resolve) => (onTarget = resolve));
  const held = [];
  let target = null;
  const reply = (res, n, call) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([...frames(n, call).map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: scenario.model }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // counted below as a request without a body
      }
      const child = isChildFirstRequest(body);
      requests.push({ url: req.url, child, body });
      const n = requests.length;
      const call = child ? undefined : scenario.rootScript?.[rootCount];
      if (!child) rootCount += 1;
      const isTarget = target === null && body !== null && (scenario.target === 'child' ? child : !child);
      if (isTarget) {
        target = { index: n - 1, body };
        onTarget(target);
        for (const release of held.splice(0)) release();
      }
      // A background launch returns at once. Hold the root's closing reply until the child has
      // asked the provider, or the headless run could end before the child's first request.
      if (scenario.target === 'child' && target === null && !call) {
        held.push(() => reply(res, n, undefined));
        return;
      }
      reply(res, n, call);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    targetCaptured,
    close: () =>
      new Promise((resolve) => {
        for (const release of held.splice(0)) release();
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// ---------- One isolated launch ----------

function isolatedEnvironment(root, scenario, baseUrl) {
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const env = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    TERM: scenario.kind === 'tui' ? 'xterm-256color' : 'dumb',
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
  const settingsDir =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Logs', 'term2-nodejs')
      : path.join(env.XDG_STATE_HOME, 'term2-nodejs');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { model: scenario.model, provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      sandbox: { enabled: false },
    }),
  );
  return { env, workspace, home };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function collectOutput(child) {
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return () => output;
}

const exited = (child) => new Promise((resolve) => child.once('close', resolve));

/** The promise's value, or `fallback` after `ms`. The timer never outlives the wait. */
async function within(ms, promise, fallback) {
  let timer;
  const deadline = new Promise((resolve) => (timer = setTimeout(resolve, ms, fallback)));
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve with the target, or null when the process ends or the deadline passes first. */
function targetOrEnd(provider, child) {
  return within(RUN_TIMEOUT_MS, Promise.race([provider.targetCaptured, exited(child).then(() => null)]), null);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = exited(child);
  child.kill('SIGTERM');
  if (
    (await within(
      8_000,
      closed.then(() => 'closed'),
      'running',
    )) !== 'closed'
  ) {
    child.kill('SIGKILL');
    await closed;
  }
}

async function launchHeadless(cli, scenario, provider, { env, workspace }) {
  const child = spawn(process.execPath, [cli, ...scenario.args, PROMPT], {
    env,
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = collectOutput(child);
  const closed = exited(child);
  const target = await targetOrEnd(provider, child);
  // Let a run that is about to finish do so; a child still working is stopped.
  if (target) await within(5_000, closed, null);
  await stop(child);
  return { target, output: output() };
}

// A pty for the TUI, as tests/helpers/terminal-e2e.ts does it. The TUI asks for the background
// colour and then Primary Device Attributes before Ink starts; answering DA1 like a terminal
// avoids its detection timeout. SIGTERM is passed on and the bridge exits only after the TUI has:
// a TUI that outlives the bridge keeps writing into the temporary home after it was removed.
const PYTHON_PTY_BRIDGE = `
import fcntl, os, pty, select, signal, struct, sys, termios
QUERIES = (b'\\x1b[c', b'\\x1b[0c')
carry = b''
def answer_da1(fd, chunk):
    global carry
    scan = carry + chunk
    for query in QUERIES:
        at = scan.find(query)
        while at >= 0:
            if at + len(query) > len(carry):
                os.write(fd, b'\\x1b[?62;22c')
            at = scan.find(query, at + 1)
    carry = scan[-3:]
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
def signal_child(number):
    try:
        os.kill(pid, number)
    except ProcessLookupError:
        pass
def terminate(_signal, _frame):
    signal_child(signal.SIGTERM)
    signal.alarm(3)
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGALRM, lambda _signal, _frame: signal_child(signal.SIGKILL))
stdin_open = True
while True:
    readers = [master] + ([sys.stdin.fileno()] if stdin_open else [])
    readable, _, _ = select.select(readers, [], [])
    if master in readable:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        os.write(sys.stdout.fileno(), chunk)
        answer_da1(master, chunk)
    if stdin_open and sys.stdin.fileno() in readable:
        chunk = os.read(sys.stdin.fileno(), 4096)
        if chunk:
            os.write(master, chunk)
        else:
            stdin_open = False
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

async function waitFor(check, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    if (check()) return true;
    await delay(25);
  }
  return check();
}

async function launchTui(cli, scenario, provider, { env, workspace, home }) {
  // The TUI publishes "composer idle" and the composer's text to this path when asked to.
  const idlePath = path.join(home, 'input-idle');
  const child = spawn('python3', ['-u', '-c', PYTHON_PTY_BRIDGE, process.execPath, cli, ...scenario.args], {
    env: { ...env, TERM2_HARNESS_IDLE_PATH: idlePath, CI: 'false' },
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = collectOutput(child);
  child.stdin.on('error', () => {});
  let target = null;
  try {
    const idle = await waitFor(() => Number.parseInt(readText(idlePath), 10) > 0, child, 60_000);
    if (idle) {
      child.stdin.write(PROMPT);
      const typed = await waitFor(
        () => {
          try {
            return JSON.parse(readText(`${idlePath}.composer`)).value === PROMPT;
          } catch {
            return false;
          }
        },
        child,
        30_000,
      );
      if (typed) {
        child.stdin.write('\r');
        target = await targetOrEnd(provider, child);
      }
    }
  } finally {
    await stop(child);
  }
  return { target, output: output() };
}

/** Temporary roots still on disk, removed on an interrupt as well as after each scenario. */
const liveRoots = new Set();
const removeRoot = (root) => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  liveRoots.delete(root);
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const root of liveRoots) removeRoot(root);
    process.exit(130);
  });
}

async function captureScenario(cli, scenario) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-prefix-')));
  liveRoots.add(root);
  const provider = await startProvider(scenario);
  try {
    const isolated = isolatedEnvironment(root, scenario, provider.baseUrl);
    const launch = scenario.kind === 'tui' ? launchTui : launchHeadless;
    const { target, output } = await launch(cli, scenario, provider, isolated);
    return { target, output, requests: provider.requests };
  } finally {
    await provider.close();
    removeRoot(root);
  }
}

// ---------- Measurement ----------

const estimateTokens = (chars) => Math.round(chars / 4);

/**
 * Split a system prompt at Markdown headings and at lines that are a lone opening XML-style tag.
 * A heuristic for finding large parts; with one system message the sizes sum to its size.
 */
function sectionsOf(text) {
  const sections = [];
  let current = { title: '(preamble)', chars: 0 };
  let openTag = null;
  for (const line of text.split('\n')) {
    const heading = openTag === null ? /^#{1,3} +(.+)$/.exec(line) : null;
    const tag = openTag === null ? /^<([A-Za-z][\w-]*)>$/.exec(line) : null;
    if (heading || tag) {
      if (current.chars > 0) sections.push(current);
      current = { title: heading ? heading[1].trim() : `<${tag[1]}>`, chars: 0 };
      if (tag) openTag = tag[1];
    }
    current.chars += line.length + 1;
    if (openTag !== null && line === `</${openTag}>`) {
      // Text after a closing tag (the environment line, say) is not part of the tagged block.
      sections.push(current);
      current = { title: `(after </${openTag}>)`, chars: 0 };
      openTag = null;
    }
  }
  if (current.chars > 0) sections.push(current);
  if (sections.length > 0) sections[sections.length - 1].chars -= 1; // no newline after the last line
  return sections.filter((section) => section.chars > 0).sort((a, b) => b.chars - a.chars);
}

function measure(body) {
  const messages = (body.messages ?? []).map((message) => ({
    role: message.role,
    text: textOf(message.content),
  }));
  const systemText = messages
    .filter((message) => isSystemRole(message.role))
    .map((message) => message.text)
    .join('\n');
  const systemChars = messages
    .filter((message) => isSystemRole(message.role))
    .reduce((sum, message) => sum + message.text.length, 0);
  const firstTurn = messages
    .filter((message) => !isSystemRole(message.role))
    .map((message) => ({ role: message.role, chars: message.text.length, head: message.text.slice(0, 80) }));
  const tools = (body.tools ?? [])
    .map((tool) => ({
      name: tool.function?.name ?? tool.name ?? '(unnamed)',
      chars: JSON.stringify(tool).length,
      descriptionChars: (tool.function?.description ?? tool.description ?? '').length,
    }))
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
  const toolChars = tools.reduce((sum, tool) => sum + tool.chars, 0);
  const firstTurnChars = firstTurn.reduce((sum, message) => sum + message.chars, 0);
  return {
    system: { chars: systemChars, estimatedTokens: estimateTokens(systemChars), sections: sectionsOf(systemText) },
    tools: { count: tools.length, chars: toolChars, estimatedTokens: estimateTokens(toolChars), items: tools },
    firstTurn: { chars: firstTurnChars, estimatedTokens: estimateTokens(firstTurnChars), messages: firstTurn },
    fixedPrefix: { chars: systemChars + toolChars, estimatedTokens: estimateTokens(systemChars + toolChars) },
  };
}

// ---------- Output ----------

const num = (value) => String(value).padStart(7);

function printScenario(result) {
  const { scenario } = result;
  console.log(`\n## ${scenario.id}: ${scenario.description}`);
  console.log(`   ${scenario.kind}, model ${scenario.model}, args: ${scenario.args.join(' ') || '(none)'}`);
  if (!result.captured) {
    console.log(`   ${result.refused ? 'REFUSED BY THE CLI, as expected' : 'NOT CAPTURED'}: ${result.reason}`);
    return;
  }
  const { system, tools, firstTurn, fixedPrefix } = result.measurement;
  console.log(
    `   request ${result.requestIndex + 1} of ${result.requestCount} seen by the provider, sent for model ${
      result.requestModel
    }`,
  );
  console.log(`   ${'chars'.padStart(7)} ${'~tok'.padStart(7)}`);
  console.log(`   ${num(fixedPrefix.chars)} ${num(fixedPrefix.estimatedTokens)}  FIXED PREFIX (system prompt + tools)`);
  console.log(`   ${num(system.chars)} ${num(system.estimatedTokens)}  system prompt`);
  for (const section of system.sections) {
    console.log(`   ${num(section.chars)} ${num(estimateTokens(section.chars))}    section: ${section.title}`);
  }
  console.log(`   ${num(tools.chars)} ${num(tools.estimatedTokens)}  tools (${tools.count})`);
  for (const tool of tools.items) {
    console.log(
      `   ${num(tool.chars)} ${num(estimateTokens(tool.chars))}    ${tool.name} (description ${tool.descriptionChars})`,
    );
  }
  console.log(
    `   ${num(firstTurn.chars)} ${num(firstTurn.estimatedTokens)}  first-turn messages, not part of the prefix`,
  );
  for (const message of firstTurn.messages) {
    console.log(
      `   ${num(message.chars)} ${num(estimateTokens(message.chars))}    ${message.role}: ${JSON.stringify(
        message.head,
      )}`,
    );
  }
}

function parseArguments(argv) {
  const options = { cli: path.join(repo, 'dist', 'cli.js'), json: false, list: false, dump: null, ids: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--cli' || arg === '--dump') {
      const value = argv[(i += 1)];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = path.resolve(value);
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else options.ids.push(arg);
  }
  const unknown = options.ids.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length > 0) throw new Error(`unknown scenario: ${unknown.join(', ')} (see --list)`);
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.list) {
    for (const scenario of SCENARIOS) console.log(`${scenario.id}\t${scenario.description}`);
    return;
  }
  if (!fs.existsSync(options.cli)) throw new Error(`no built CLI at ${options.cli}; run pnpm build or pass --cli`);
  if (options.dump) fs.mkdirSync(options.dump, { recursive: true });
  const selected = SCENARIOS.filter((scenario) => options.ids.length === 0 || options.ids.includes(scenario.id));
  const results = [];
  for (const scenario of selected) {
    if (!options.json) process.stderr.write(`capturing ${scenario.id}...\n`);
    const { target, output, requests } = await captureScenario(options.cli, scenario);
    const base = { scenario: { ...scenario, rootScript: undefined }, requestCount: requests.length };
    if (target) {
      results.push({
        ...base,
        captured: true,
        requestIndex: target.index,
        requestModel: target.body.model ?? null,
        measurement: measure(target.body),
      });
      if (options.dump) {
        fs.writeFileSync(path.join(options.dump, `${scenario.id}.json`), `${JSON.stringify(target.body, null, 2)}\n`);
      }
    } else {
      const tail = output
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .trim()
        .slice(-400);
      const seen = `${requests.length} request(s) reached the provider, none ${
        scenario.target === 'child' ? "was the child's first" : 'usable'
      }`;
      const refused = scenario.expectRefusal === true && requests.length === 0;
      results.push({
        ...base,
        captured: false,
        refused,
        reason: refused ? tail : `${seen}; last output: ${JSON.stringify(tail)}`,
      });
    }
  }
  if (options.json) {
    const report = {
      note: 'estimatedTokens is chars/4, an estimate, not a tokenizer count',
      probePrompt: PROMPT,
      results,
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Fixed prefix report. Sizes are characters; ~tok is chars/4, an estimate, not a tokenizer count.');
    console.log(`The probe prompt is ${JSON.stringify(PROMPT)}. Tool size is the JSON of the tool definition as sent.`);
    for (const result of results) printScenario(result);
  }
  // A capture that did not happen, or a refusal that stopped happening, makes the report incomplete.
  if (results.some((result) => (result.scenario.expectRefusal ? !result.refused : !result.captured))) {
    process.exitCode = 1;
  }
}

await main();
