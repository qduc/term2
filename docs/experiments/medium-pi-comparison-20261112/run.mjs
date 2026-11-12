/* global process, console, Buffer, URL, setTimeout, clearTimeout */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BudgetGateway, MODEL_IDS, RESERVATIONS } from './budget-gateway.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)),
  repo = path.resolve(here, '../../..');
const root = path.resolve(process.env.BENCH_ROOT ?? path.join(repo, '.handoff/campaign'));
const live = process.argv.includes('--live');
if (live && (process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1') {
  throw new Error('Live parent requires startup NODE_USE_ENV_PROXY=1; use launch.mjs');
}
const term2Cli = '/workspace/term2/.worktrees/bare-hillclimb/.handoff/bundles/baseline/cli.js';
const piCli = '/workspace/scratch/pi-comparison/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
const treeHash = (dir) => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else
        files.push([
          path.relative(dir, f),
          e.isSymbolicLink()
            ? { symlink: fs.readlinkSync(f) }
            : crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),
        ]);
    }
  };
  walk(dir);
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
};
const hash = (x) => crypto.createHash('sha256').update(x).digest('hex');
const write = (f, x) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(x, null, 2) + '\n');
};
const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(^|_)(API_KEY|TOKEN|SECRET)$/.test(k)));
const plan = [];
for (const [i, provider] of ['openai', 'anthropic'].entries())
  for (let rep = 1; rep <= (live ? 5 : 1); rep++)
    for (const arm of (rep + i) % 2 ? ['t2', 'pi'] : ['pi', 't2'])
      plan.push({ id: `medium-${live ? 'live-v3' : 'fixture'}-${provider}-r${rep}-${arm}`, provider, arm, rep });

// Preserve the interrupted attempt; only this unfinished case gets a fresh execution ID.
for (const spec of plan)
  if (live && spec.id === 'medium-live-v3-openai-r5-pi') spec.id = 'medium-live-v3-openai-r5-pi-restart1';

// Infrastructure recovery: retain the partial charge and defer only the interrupted case.
if (live) {
  const index = plan.findIndex((spec) => spec.id === 'medium-live-v3-anthropic-r1-pi');
  const [deferred] = plan.splice(index, 1);
  deferred.id = 'medium-live-v3-anthropic-r1-pi-restart1';
  plan.push(deferred);
}

async function fakeProvider() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const dump = JSON.stringify(body),
      isAnthropic = new URL(req.url, 'http://localhost').pathname.endsWith('/messages');
    const hasResult =
      body.input?.some((x) => x.type === 'function_call_output') ||
      body.messages?.some((m) => Array.isArray(m.content) && m.content.some((x) => x.type === 'tool_result'));
    const runId = dump.match(/MEDIUM_PREFLIGHT:([a-z0-9-]+)/)?.[1];
    const declared = body.tools ?? body.input?.find((x) => x.type === 'additional_tools')?.tools ?? [];
    const name = declared.some((x) => x.name === 'shell') ? 'shell' : 'bash';
    const marker = runId ? path.join(root, 'outside-markers', runId) : '';
    const command = `mktemp -d && printf OK > "$TMPDIR/approval-marker" && printf OK > '${marker}'`;
    const args =
      name === 'shell'
        ? { command, description: 'Verify unsandboxed always-approve execution', timeout_ms: 10000 }
        : { command, timeout: 10 };
    const tool = !hasResult;
    if (tool && !runId) throw new Error('Missing preflight identity');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, value) => res.write(`${type ? 'event: ' + type + '\n' : ''}data: ${JSON.stringify(value)}\n\n`);
    if (isAnthropic) {
      send('message_start', {
        type: 'message_start',
        message: {
          id: 'fixture-message',
          type: 'message',
          role: 'assistant',
          content: [],
          model: body.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: tool ? { type: 'tool_use', id: 'fixture-call', name, input: {} } : { type: 'text', text: '' },
      });
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: tool
          ? { type: 'input_json_delta', partial_json: JSON.stringify(args) }
          : { type: 'text_delta', text: 'PREFLIGHT_OK' },
      });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      });
      send('message_stop', { type: 'message_stop' });
    } else {
      const item = tool
        ? { type: 'function_call', id: 'fc_fixture', call_id: 'fixture-call', name, arguments: JSON.stringify(args) }
        : {
            type: 'message',
            id: 'fixture-message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'PREFLIGHT_OK', annotations: [] }],
          };
      if (tool) {
        send('', { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } });
        send('', {
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: 0,
          delta: JSON.stringify(args),
        });
        send('', {
          type: 'response.function_call_arguments.done',
          item_id: item.id,
          output_index: 0,
          arguments: JSON.stringify(args),
        });
      }
      send('', { type: 'response.output_item.done', output_index: 0, item });
      send('', {
        type: 'response.completed',
        response: {
          id: tool ? 'fixture-response-tool' : 'fixture-response-final',
          status: 'completed',
          model: body.model,
          output: [item],
          usage: {
            input_tokens: 100,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
    }
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function run(spec, gateway) {
  const runRoot = path.join(root, 'runs', spec.id),
    workspace = path.join(
      '/workspace/scratch/term2-medium-workspaces',
      live ? spec.id : path.basename(root) + '-' + spec.id,
    );
  if (fs.existsSync(path.join(runRoot, 'result.json'))) return;
  if (fs.existsSync(path.join(runRoot, 'started.json')))
    throw new Error('Unsettled prior execution; inspect before resuming');
  fs.mkdirSync(runRoot, { recursive: true });
  const preparedFile = path.join(runRoot, 'prepared.json');
  let prepared;
  if (fs.existsSync(preparedFile)) prepared = JSON.parse(fs.readFileSync(preparedFile));
  else {
    const prep = spawnSync('python3', [path.join(here, 'prepare.py'), workspace], {
      cwd: repo,
      env: cleanEnv(),
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 8 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(runRoot, 'prepare-stderr.txt'), prep.stderr ?? '');
    if (prep.status !== 0) throw new Error(`Task preparation failed: ${prep.stderr?.slice(-1000)}`);
    prepared = JSON.parse(prep.stdout.trim());
    write(preparedFile, prepared);
  }
  const state = path.join(runRoot, 'state'),
    tmp = path.join(runRoot, 'tmp');
  for (const d of [
    state,
    tmp,
    path.join(tmp, 'agent/term2-nodejs'),
    path.join(state, 'pi'),
    path.join(root, 'outside-markers'),
  ])
    fs.mkdirSync(d, { recursive: true });
  const settings = {
    agent: {
      modelSelection: { provider: spec.provider, model: MODEL_IDS[spec.provider] },
      transport: 'http',
      maxOutputTokens: 32000,
    },
    shell: { autoApproveMode: 'always' },
    sandbox: { enabled: false },
    providers: [
      {
        id: 'anthropic',
        name: 'anthropic',
        type: 'anthropic',
        baseUrl: `${gateway.url}/anthropic/${spec.id}/v1`,
        apiKey: 'comparison-budget-gateway',
      },
    ],
  };
  write(path.join(state, 'term2-nodejs/settings.json'), settings);
  const piState = path.join(state, 'pi');
  write(path.join(piState, 'settings.json'), { defaultProjectTrust: 'always' });
  write(path.join(piState, 'models.json'), {
    providers: {
      openai: {
        baseUrl: `${gateway.url}/openai/${spec.id}/v1`,
        modelOverrides: { 'gpt-6-luna': { maxTokens: 32000 } },
      },
      anthropic: {
        baseUrl: `${gateway.url}/anthropic/${spec.id}`,
        modelOverrides: { 'claude-haiku-5-5': { maxTokens: 32000, compat: { supportsMessageThreads: true } } },
      },
    },
  });
  const env = {
    ...cleanEnv(),
    OPENAI_API_KEY: 'comparison-budget-gateway',
    ANTHROPIC_API_KEY: 'comparison-budget-gateway',
    OPENAI_BASE_URL: `${gateway.url}/openai/${spec.id}/v1`,
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: path.join(state, 'data'),
    XDG_CACHE_HOME: path.join(state, 'cache'),
    XDG_CONFIG_HOME: path.join(state, 'config'),
    PI_CODING_AGENT_DIR: piState,
    PI_OFFLINE: '1',
    TMPDIR: tmp,
    NODE_USE_ENV_PROXY: '1',
    AGENT_TRANSPORT: 'http',
    AGENT_MAX_OUTPUT_TOKENS: '32000',
    npm_config_store_dir: '/workspace/.pnpm-store',
    NO_COLOR: '1',
  };
  const prompt = live
    ? fs.readFileSync(path.join(here, 'task.md'), 'utf8')
    : `MEDIUM_PREFLIGHT:${spec.id} Follow the tool result, then reply PREFLIGHT_OK.`;
  const args =
    spec.arm === 't2'
      ? [
          term2Cli,
          '--provider',
          spec.provider,
          '--model',
          MODEL_IDS[spec.provider],
          '--reasoning',
          'medium',
          '--json',
          '--auto-approve',
          prompt,
        ]
      : [
          piCli,
          '--provider',
          spec.provider,
          '--model',
          MODEL_IDS[spec.provider],
          '--thinking',
          'medium',
          '--mode',
          'json',
          '--print',
          '--approve',
          '--skill',
          path.join(workspace, '.agents/skills'),
          prompt,
        ];
  write(path.join(runRoot, 'manifest.json'), {
    ...spec,
    mode: live ? 'live' : 'fixture',
    workspace,
    model: MODEL_IDS[spec.provider],
    effort: 'medium',
    maxOutputTokens: 32000,
    sandboxEnabled: false,
    approval: 'always',
    taskBase: prepared.baseCommit,
    term2Source: 'd277aa0f24eb3680fc68468474ede56da6a8188a',
    piVersion: '1.5.2',
    promptSha256: hash(prompt),
    settings,
    setupElapsedMs: prepared.setupElapsedMs,
  });
  fs.writeFileSync(path.join(runRoot, 'prompt.txt'), prompt);
  gateway.register(spec.id);
  write(path.join(runRoot, 'started.json'), { at: new Date().toISOString() });
  const start = Date.now(),
    child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }),
    stdout = [],
    stderr = [];
  child.stdout.on('data', (x) => stdout.push(x));
  child.stderr.on('data', (x) => stderr.push(x));
  let timedOut = false;
  const timers = [
    setTimeout(
      () => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* exited */
        }
      },
      live ? 1200000 : 60000,
    ),
    setTimeout(
      () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* exited */
        }
      },
      live ? 1205000 : 65000,
    ),
  ];
  const [exitCode, signal] = await once(child, 'exit');
  for (const t of timers) clearTimeout(t);
  const agentElapsedMs = Date.now() - start;
  await Promise.allSettled([...gateway.pending]);
  const rawOut = Buffer.concat(stdout).toString(),
    rawErr = Buffer.concat(stderr).toString();
  const sanitizedOut = rawOut
    .split('\n')
    .map((line) => {
      try {
        return JSON.stringify(gateway.safe(JSON.parse(line)));
      } catch {
        return gateway.safe(line);
      }
    })
    .join('\n');
  fs.writeFileSync(path.join(runRoot, 'stdout.jsonl'), sanitizedOut);
  fs.writeFileSync(path.join(runRoot, 'stderr.txt'), gateway.safe(rawErr));
  const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], {
    cwd: workspace,
    env: cleanEnv(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(runRoot, 'candidate.patch'), gateway.safe(diff.stdout ?? ''));
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: workspace, env: cleanEnv(), encoding: 'utf8' })
    .stdout.split('\0')
    .filter(Boolean);
  const extra = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: workspace,
    env: cleanEnv(),
    encoding: 'utf8',
  })
    .stdout.split('\0')
    .filter(Boolean);
  const sourceHashes = {};
  for (const name of [...tracked, ...extra]) {
    const f = path.join(workspace, name);
    if (!fs.existsSync(f)) {
      sourceHashes[name] = null;
      continue;
    }
    if (fs.lstatSync(f).isSymbolicLink()) {
      sourceHashes[name] = { symlink: fs.readlinkSync(f) };
      continue;
    }
    if (!fs.statSync(f).isFile()) continue;
    sourceHashes[name] = hash(fs.readFileSync(f));
    if (prepared.initialFiles[name] !== sourceHashes[name]) {
      const dest = path.join(runRoot, 'candidate-files', name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    }
  }
  write(path.join(runRoot, 'candidate-source.json'), sourceHashes);
  let grade = null;
  if (live) {
    const grading = spawnSync('python3', [path.join(here, 'grade.py'), workspace, runRoot], {
      cwd: repo,
      env: cleanEnv(),
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
    });
    fs.writeFileSync(
      path.join(runRoot, 'grading-driver.txt'),
      gateway.safe((grading.stdout ?? '') + (grading.stderr ?? '')),
    );
    if (grading.status !== 0) throw new Error('Grading infrastructure failed; retained native costs, stop and inspect');
    grade = JSON.parse(fs.readFileSync(path.join(runRoot, 'grade.json'), 'utf8'));
  }
  const entries = gateway.ledger.filter((e) => e.runId === spec.id);
  const fixturePass =
    !live &&
    exitCode === 0 &&
    entries.length === 2 &&
    rawOut.includes('PREFLIGHT_OK') &&
    (fs.existsSync(path.join(tmp, 'approval-marker')) ||
      fs.existsSync(path.join(tmp, 'agent/term2-nodejs/approval-marker'))) &&
    fs.existsSync(path.join(root, 'outside-markers', spec.id));
  const result = {
    ...spec,
    mode: live ? 'live' : 'fixture',
    exitCode,
    signal,
    timedOut,
    agentElapsedMs,
    totalElapsedMs: Date.now() - start,
    setupElapsedMs: prepared.setupElapsedMs,
    grade,
    qualityPass: live && exitCode === 0 && !timedOut && grade.pass,
    fixturePass,
    requestIds: entries.map((e) => e.id),
    meteredUsd: entries.reduce((s, e) => s + (e.priced?.usd ?? 0), 0),
    unknownUsageRequests: entries.filter((e) => !e.priced).map((e) => e.id),
    budgetExposureUsd: gateway.exposureUsd(),
    stdoutSha256: hash(rawOut),
    stderrSha256: hash(rawErr),
  };
  write(path.join(runRoot, 'result.json'), result);
  console.log(
    JSON.stringify({
      id: spec.id,
      exitCode,
      qualityPass: result.qualityPass,
      fixturePass,
      agentElapsedMs,
      requests: entries.length,
      meteredUsd: result.meteredUsd,
      exposureUsd: result.budgetExposureUsd,
    }),
  );
  if (!live && !fixturePass) throw new Error('Actual CLI approval/sandbox preflight failed');
  if (result.unknownUsageRequests.length) throw new Error('Unresolved native usage: retain reservation and stop');
}

fs.mkdirSync(root, { recursive: true });
const identities = {
  sourceTar: hash(fs.readFileSync(path.join(repo, '.handoff/task-source.tar'))),
  frozenHttpTree: treeHash(path.join(repo, '.handoff/grading-source')),
  supplement: hash(fs.readFileSync(path.join(repo, '.handoff/verifier/openrouter-supplement.mjs'))),
  term2BundleTree: treeHash(path.dirname(term2Cli)),
  piInstallTree: treeHash('/workspace/scratch/pi-comparison'),
};
const protocol = {
  identities,
  mode: live ? 'live' : 'fixture',
  plan,
  models: MODEL_IDS,
  effort: 'medium',
  maxOutputTokens: 32000,
  sandbox: false,
  approval: 'always',
  taskBase: 'c5f0002c3f086d3a7daf99c62fbcd5c6bbf6a3f8',
  taskReference: '7b63338f042bbb3830a828e366abf8213ffe7d5c',
  taskHash: hash(fs.readFileSync(path.join(here, 'task.md'))),
  runtime: process.version,
  term2Cli,
  piCli,
  concurrency: 1,
  agentTimeBoundary:
    'CLI spawn through exit; dependency setup, billing settlement and external grading reported separately',
  capUsd: 30,
  hashes: Object.fromEntries(
    ['run.mjs', 'prepare.py', 'grade.py', 'budget-gateway.mjs', 'task.md']
      .filter((n) => fs.existsSync(path.join(here, n)))
      .map((n) => [n, hash(fs.readFileSync(path.join(here, n)))]),
  ),
};
const protocolFile = path.join(root, live ? 'protocol-live.json' : 'protocol-fixture.json');
if (fs.existsSync(protocolFile) && fs.readFileSync(protocolFile, 'utf8') !== JSON.stringify(protocol, null, 2) + '\n')
  throw new Error('Frozen protocol changed');
write(protocolFile, protocol);
if (live && process.env.BENCH_LIVE_APPROVED_CAP_USD !== '30')
  throw new Error('Explicit approved cumulative cap required');
if (live) {
  const shared = '/workspace/term2/.worktrees/cache-lookback/.handoff/live-campaign/wire-live';
  const target = path.join(root, 'wire-live');
  if (!fs.existsSync(target)) fs.symlinkSync(shared, target, 'dir');
  if (fs.realpathSync(target) !== fs.realpathSync(shared))
    throw new Error('Live ledger must be the existing cumulative campaign ledger');
  if (!fs.existsSync(path.join(shared, 'ledger.json'))) throw new Error('Existing live ledger missing');
}
const fake = live ? null : await fakeProvider();
const gateway = await new BudgetGateway({
  directory: path.join(root, live ? 'wire-live' : 'wire-fixture'),
  capUsd: 30,
  fixtureOrigins: fake ? { openai: fake.origin, anthropic: fake.origin } : undefined,
}).start();
try {
  for (const spec of plan) {
    if (live && gateway.exposureUsd() + RESERVATIONS[spec.provider] + 0.01 > 30) {
      write(path.join(root, 'budget-pause.json'), {
        beforeRun: spec.id,
        exposureUsd: gateway.exposureUsd(),
        requiredReservationUsd: RESERVATIONS[spec.provider],
      });
      throw new Error('Insufficient approved headroom for next run; ask before expanding cap');
    }
    await run(spec, gateway);
  }
} finally {
  await gateway.close();
  if (fake) await fake.close();
}
