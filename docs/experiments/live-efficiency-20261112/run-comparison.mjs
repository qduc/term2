/* global process, Buffer, URL, setTimeout, clearTimeout, console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { BudgetGateway, MODEL_IDS } from './budget-gateway.mjs';
import { WORKLOADS, prepareWorkload } from './workloads.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const root = path.resolve(process.env.BENCH_ROOT ?? path.join(repo, '.handoff/live-comparison'));
const cohort = process.env.BENCH_COHORT_TAG ?? '';
if (cohort && !/^[a-z0-9-]+$/.test(cohort)) throw new Error('Invalid cohort tag');
const piCli =
  process.env.BENCH_PI_CLI ??
  '/workspace/scratch/pi-comparison/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
const live = process.argv.includes('--live');
const only = process.argv.find((s) => s.startsWith('--only='))?.slice(7);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const write = (p, value) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
};
const plan = [];
for (let rep = 1; rep <= 2; rep++)
  for (const [i, task] of Object.keys(WORKLOADS).entries())
    for (const provider of ['openai', 'anthropic']) {
      const arms = (i + rep) % 2 ? ['t2', 'pi'] : ['pi', 't2'];
      for (const arm of arms)
        plan.push({
          id: `${cohort ? cohort + '-' : ''}${provider}-${task}-r${rep}-${arm}`,
          provider,
          task,
          rep,
          arm,
          cohort,
        });
    }

async function fakeProvider() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`${type ? 'event: ' + type + '\n' : ''}data: ${JSON.stringify(data)}\n\n`);
    if (new URL(req.url, 'http://127.0.0.1').pathname.endsWith('/messages')) {
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
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'PREFLIGHT_OK' },
      });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      });
      send('message_stop', { type: 'message_stop' });
    } else {
      const item = {
        type: 'message',
        id: 'fixture-message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'PREFLIGHT_OK', annotations: [] }],
      };
      send('', { type: 'response.output_item.done', output_index: 0, item });
      send('', {
        type: 'response.completed',
        response: {
          id: 'fixture-response',
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
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function runCandidate(spec, gateway, { fixture = false } = {}) {
  const runId = fixture ? `fixture-${spec.provider}-${spec.arm}` : spec.id;
  const runRoot = path.join(root, 'runs', runId);
  // Outside the Term2 checkout so Pi cannot inherit the checkout's AGENTS/skills.
  const workspace = path.join(process.env.BENCH_WORKSPACES_ROOT ?? '/workspace/scratch/term2-pi-workspaces', runId);
  if (fs.existsSync(path.join(runRoot, 'result.json'))) throw new Error(`Refusing to overwrite ${runId}`);
  const prepared = prepareWorkload(spec.task, workspace);
  const state = path.join(runRoot, 'state');
  fs.mkdirSync(state, { recursive: true });
  const term2Settings = {
    agent: {
      modelSelection: { provider: spec.provider, model: MODEL_IDS[spec.provider] },
      transport: 'http',
      maxOutputTokens: 32_000,
    },
    sandbox: { enabled: true },
    providers: [
      {
        id: 'anthropic',
        name: 'anthropic',
        type: 'anthropic',
        baseUrl: `${gateway.url}/anthropic/${runId}/v1`,
        apiKey: 'comparison-budget-gateway',
      },
    ],
  };
  write(path.join(state, 'term2-nodejs/settings.json'), term2Settings);
  const piState = path.join(state, 'pi');
  write(path.join(piState, 'settings.json'), { defaultProjectTrust: 'always' });
  write(path.join(piState, 'models.json'), {
    providers: {
      openai: { baseUrl: `${gateway.url}/openai/${runId}/v1`, modelOverrides: { 'gpt-6-luna': { maxTokens: 32_000 } } },
      anthropic: {
        baseUrl: `${gateway.url}/anthropic/${runId}`,
        // Preserve the native endpoint's thread capability behind this transparent gateway.
        modelOverrides: { 'claude-haiku-5-5': { maxTokens: 32_000, compat: { supportsMessageThreads: true } } },
      },
    },
  });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/(^|_)(API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key];
  Object.assign(env, {
    OPENAI_API_KEY: 'comparison-budget-gateway',
    OPENAI_BASE_URL: `${gateway.url}/openai/${runId}/v1`,
    ANTHROPIC_API_KEY: 'comparison-budget-gateway',
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: path.join(state, 'cache'),
    XDG_CONFIG_HOME: path.join(state, 'config'),
    PI_CODING_AGENT_DIR: piState,
    PI_OFFLINE: '1',
    BENCH_GATEWAY: gateway.url,
    BENCH_RUN_ID: runId,
    NODE_USE_ENV_PROXY: '1',
    AGENT_TRANSPORT: 'http',
    AGENT_MAX_OUTPUT_TOKENS: '32000',
    PATH: `/workspace/scratch/sandbox-bin:${process.env.PATH}`,
    NO_COLOR: '1',
  });
  const prompt = fixture ? 'Reply only PREFLIGHT_OK. Do not use tools.' : prepared.prompt;
  const args =
    spec.arm === 't2'
      ? [
          path.join(repo, 'dist/cli.js'),
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
  gateway.register(runId);
  write(path.join(runRoot, 'manifest.json'), {
    ...spec,
    runId,
    mode: fixture ? 'fixture' : 'live',
    sourceCommit: process.env.BENCH_MEASURED_SOURCE_COMMIT ?? '66dda24dada62cdf0c3d0e8efb5786d3e8d8d167',
    model: MODEL_IDS[spec.provider],
    reasoning: 'medium',
    maxOutputTokens: 32000,
    term2Profile: 'builtin:bare (shipped default)',
    sandboxEnabled: true,
    promptSha256: hash(prompt),
    initialFiles: Object.fromEntries(Object.entries(prepared.files).map(([p, c]) => [p, hash(c)])),
  });
  fs.writeFileSync(path.join(runRoot, 'prompt.txt'), prompt + '\n');
  const started = Date.now();
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const stdout = [],
    stderr = [];
  child.stdout.on('data', (c) => stdout.push(c));
  child.stderr.on('data', (c) => stderr.push(c));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Process already exited. */
    }
  }, 300_000);
  const killer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Process already exited. */
    }
  }, 305_000);
  const [exitCode, signal] = await once(child, 'exit');
  clearTimeout(timer);
  clearTimeout(killer);
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
  const currentFiles = {};
  function walk(dir, relative = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(relative, e.name);
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else currentFiles[rel] = hash(fs.readFileSync(path.join(dir, e.name)));
    }
  }
  walk(workspace);
  const unauthorized = Object.entries(prepared.files)
    .filter(([p, c]) => !p.startsWith('src/') && currentFiles[p] !== hash(c))
    .map(([p]) => p);
  const addedOutsideSource = Object.keys(currentFiles).filter((p) => !p.startsWith('src/') && !(p in prepared.files));
  const gradeEnv = { ...env };
  for (const key of Object.keys(gradeEnv))
    if (/(^|_)(API_KEY|TOKEN|SECRET)$/.test(key) || key.startsWith('BENCH_') || key === 'NODE_OPTIONS')
      delete gradeEnv[key];
  const isolation = [
    '--unshare-net',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--bind',
    workspace,
    workspace,
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--die-with-parent',
    process.execPath,
  ];
  const publicTest = spawnSync('bwrap', [...isolation, '--test', 'test/public.test.mjs'], {
    cwd: workspace,
    env: gradeEnv,
    encoding: 'utf8',
    timeout: 10_000,
  });
  fs.writeFileSync(path.join(runRoot, 'public-tests.txt'), publicTest.stdout + publicTest.stderr);
  const graded = fixture
    ? null
    : spawnSync('bwrap', [...isolation, path.join(here, 'grade-candidate.mjs'), spec.task, workspace], {
        cwd: workspace,
        env: gradeEnv,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
  let grade = null;
  if (graded) {
    fs.writeFileSync(path.join(runRoot, 'hidden-grader.txt'), (graded.stdout ?? '') + (graded.stderr ?? ''));
    try {
      if (graded.status !== 0) throw graded.error ?? new Error(`Grader exit ${graded.status}, signal ${graded.signal}`);
      grade = JSON.parse(graded.stdout.trim().split('\n').at(-1));
    } catch (e) {
      grade = {
        passed: 0,
        total: 1,
        pass: false,
        checks: [{ label: 'isolated-grader-completion', pass: false, error: String(e.message) }],
      };
    }
  }
  const requestEntries = gateway.ledger.filter((r) => r.runId === runId);
  const result = {
    ...spec,
    runId,
    mode: fixture ? 'fixture' : 'live',
    exitCode,
    signal,
    timedOut,
    elapsedMs: Date.now() - started,
    stdoutRawSha256: hash(rawOut),
    stdoutSanitizedSha256: hash(sanitizedOut),
    files: currentFiles,
    unauthorizedChanges: [...unauthorized, ...addedOutsideSource],
    publicTestsExitCode: publicTest.status,
    grade,
    qualityPass:
      !fixture &&
      exitCode === 0 &&
      !timedOut &&
      publicTest.status === 0 &&
      grade.pass &&
      unauthorized.length === 0 &&
      addedOutsideSource.length === 0,
    requestIds: requestEntries.map((r) => r.id),
    meteredUsd: requestEntries.reduce((n, r) => n + (r.priced?.usd ?? 0), 0),
    unknownUsageRequests: requestEntries.filter((r) => !r.priced).map((r) => r.id),
    budgetExposureUsd: gateway.exposureUsd(),
    fixtureReply: fixture
      ? requestEntries.length === 1 &&
        requestEntries.every((r) => r.status === 'metered') &&
        rawOut.includes('PREFLIGHT_OK')
      : undefined,
  };
  write(path.join(runRoot, 'result.json'), result);
  console.log(
    JSON.stringify({
      runId,
      exitCode,
      qualityPass: result.qualityPass,
      checks: grade && `${grade.passed}/${grade.total}`,
      requests: requestEntries.length,
      meteredUsd: result.meteredUsd,
      unknownUsageRequests: result.unknownUsageRequests,
      budgetExposureUsd: result.budgetExposureUsd,
      elapsedMs: result.elapsedMs,
      fixtureReply: result.fixtureReply,
    }),
  );
  return result;
}

async function main() {
  fs.mkdirSync(root, { recursive: true });
  write(path.join(root, 'protocol.json'), {
    approvedCapUsd: 10,
    plannedRuns: plan,
    models: MODEL_IDS,
    reasoning: 'medium',
    maxOutputTokens: 32000,
    pairedRepetitions: 2,
    repairPolicy: 'No fresh rework or grader feedback; natural within-run retries/repairs count',
    capabilities:
      'Shipped CLI surfaces retained; Term2 sandbox enabled; isolated project trust/auto-approval authorized for owned scratch workspaces',
    harnessSha256: Object.fromEntries(
      ['budget-gateway.mjs', 'grade-candidate.mjs', 'workloads.mjs', 'run-comparison.mjs'].map((p) => [
        p,
        hash(fs.readFileSync(path.join(here, p))),
      ]),
    ),
  });
  const fake = live ? undefined : await fakeProvider();
  const gateway = await new BudgetGateway({
    directory: path.join(root, live ? 'wire-live' : 'wire-fixture'),
    capUsd: 10,
    fixtureOrigins: fake ? { openai: fake.origin, anthropic: fake.origin } : undefined,
  }).start();
  try {
    if (live) {
      if (process.env.BENCH_LIVE_APPROVED_CAP_USD !== '10')
        throw new Error('Live run requires the explicit approved $10 cap');
      for (const spec of plan.filter((s) => !only || s.id === only)) {
        if (fs.existsSync(path.join(root, 'runs', spec.id, 'result.json'))) continue;
        await runCandidate(spec, gateway);
        if (gateway.ledger.some((r) => !r.priced && !r.settledForBudget))
          throw new Error('Unresolved usage: stop paid work and inspect retained reservation');
      }
    } else
      for (const provider of ['openai', 'anthropic'])
        for (const arm of ['t2', 'pi']) {
          const result = await runCandidate({ id: 'fixture', provider, arm, task: 'pagination', rep: 0 }, gateway, {
            fixture: true,
          });
          if (!result.fixtureReply || result.exitCode !== 0)
            throw new Error('Fixture did not traverse the shared meter');
        }
  } finally {
    await gateway.close();
    if (fake) await fake.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
