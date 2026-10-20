import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

async function inventory(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await inventory(directory, relative));
    else result[relative] = hash(await readFile(path.join(directory, entry.name)));
  }
  return result;
}

async function trial(out, protocol, task, model, arm, index, snapshot) {
  const id = `${task.id}-${index}-${arm}`;
  const directory = path.join(out, id);
  const scratch = path.join(directory, 'scratch');
  await mkdir(scratch, { recursive: true });
  const files = snapshot[task.id];
  for (const [relative, value] of Object.entries(files)) {
    const target = path.join(scratch, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value, { flag: 'wx' });
  }
  const before = await inventory(scratch);
  const audit = path.join(directory, 'reads.ndjson');
  await writeFile(audit, '');
  const manifest = path.join(directory, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ root: scratch, paths: task.paths, audit }));
  const method = protocol.incumbent + (arm === 'candidate' ? '\n' + protocol.candidateAddition : '');
  const prompt = `${method}\n${protocol.contract}\nQuestion: ${task.question}\nPaths: ${JSON.stringify(task.paths)}`;
  const args = [
    path.join(root, 'dist/cli.js'),
    '--json',
    '--auto-approve',
    '-p',
    model.provider,
    '-m',
    model.model,
    prompt,
  ];
  const invocation = JSON.stringify({ id, model, arm, prompt, cwd: scratch, before, args }, null, 2);
  await writeFile(path.join(directory, 'invocation.json'), invocation);
  let stdout = '',
    stderr = '',
    timedOut = false;
  const start = Date.now();
  const child = spawn(process.execPath, args, {
    cwd: scratch,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TERM2_CONVERSATIONS_DIR: path.join(directory, 'conversations'),
      TERM2_READ_STUDY_MANIFEST: manifest,
    },
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const terminate = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, protocol.deadlineMs);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const durationMs = Date.now() - start;
  await writeFile(path.join(directory, 'events.ndjson'), stdout);
  await writeFile(path.join(directory, 'stderr.txt'), stderr);
  const after = await inventory(scratch);
  let malformed = false;
  const events = stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        malformed = true;
        return [];
      }
    });
  const calls = events.filter((e) => e.type === 'tool_started');
  const scripts = events
    .filter((e) => e.type === 'command_message' && e.message.toolName === 'run_code')
    .map((e) => e.message);
  const completed = events.filter((e) => e.type === 'completed');
  const reads = (await readFile(audit, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const results = events.filter((e) => e.type === 'command_message').map((e) => e.message);
  const reconciled =
    calls.every(
      (call) => typeof call.toolCallId === 'string' && results.filter((m) => m.callId === call.toolCallId).length === 1,
    ) && results.every((m) => calls.filter((call) => call.toolCallId === m.callId).length === 1);
  const pathsInspected = task.paths.every((p) =>
    reads.some((r) => r.allowed && r.resolved === path.resolve(scratch, p)),
  );
  const expected = {
    facts: task.expected,
    missing: task.paths.filter((p) => !Object.hasOwn(files, p)),
  };
  let actual = null;
  try {
    actual = JSON.parse(completed.at(-1)?.finalText ?? '');
  } catch {
    /* Exact oracle fails. */
  }
  const record = {
    id,
    task: task.id,
    model,
    arm,
    ...result,
    timedOut,
    malformed,
    durationMs,
    scriptCalls: calls.filter((e) => e.toolName === 'run_code').length,
    scriptResults: scripts.length,
    scriptErrors: scripts.filter((m) => m.success === false).length,
    providerRetries: events.filter((e) => e.type === 'retry').length,
    fixturesPreserved: stable(before) === stable(after),
    reconciled,
    pathsInspected,
    deniedReads: reads.filter((r) => !r.allowed).length,
    forbiddenTopLevel: calls.some((e) => e.toolName !== 'run_code'),
    oraclePass: stable(actual) === stable(expected),
    expected,
    actual,
    uncertain:
      timedOut ||
      malformed ||
      result.code !== 0 ||
      completed.length !== 1 ||
      !scripts.length ||
      !reconciled ||
      !pathsInspected ||
      scripts.some((m) => typeof m.success !== 'boolean'),
    evidence: { events: hash(stdout), stderr: hash(stderr), invocation: hash(invocation) },
  };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(record, null, 2));
  console.log(
    JSON.stringify({
      type: 'trial_complete',
      id,
      pass: record.oraclePass,
      errors: record.scriptErrors,
      calls: record.scriptCalls,
      uncertain: record.uncertain,
    }),
  );
  return record;
}

function compare(protocol, runs) {
  const pairs = protocol.tasks.flatMap((task) =>
    protocol.models.map((model) => {
      const find = (arm) =>
        runs.find((r) => r.task === task.id && r.model.provider === model.provider && r.arm === arm);
      return { task: task.id, baseline: find('baseline'), candidate: find('candidate') };
    }),
  );
  const sum = (arm, key, provider) =>
    runs.filter((r) => r.arm === arm && (!provider || r.model.provider === provider)).reduce((n, r) => n + r[key], 0);
  const baselineErrors = sum('baseline', 'scriptErrors'),
    candidateErrors = sum('candidate', 'scriptErrors');
  const workflowWins = protocol.tasks.filter((task) => {
    const subset = pairs.filter((p) => p.task === task.id);
    return (
      subset.some((p) => p.candidate.scriptErrors < p.baseline.scriptErrors) &&
      subset.every((p) => p.candidate.scriptErrors <= p.baseline.scriptErrors)
    );
  }).length;
  const p = protocol.promotion;
  const uncertain = runs.some((r) => r.uncertain) || pairs.length !== p.pairs;
  const regression =
    runs.some((r) => !r.fixturesPreserved || r.forbiddenTopLevel || r.deniedReads > 0) ||
    pairs.some(
      ({ baseline: a, candidate: b }) =>
        !b.oraclePass ||
        b.scriptErrors > a.scriptErrors ||
        b.scriptCalls > a.scriptCalls ||
        b.providerRetries > a.providerRetries,
    );
  const enough =
    baselineErrors >= p.minimumBaselineErrors &&
    baselineErrors - candidateErrors >= p.minimumAbsoluteReduction &&
    (baselineErrors - candidateErrors) / baselineErrors >= p.minimumRelativeReduction &&
    workflowWins >= p.minimumDistinctWorkflowWins &&
    protocol.models.every(
      (m) => sum('baseline', 'scriptErrors', m.provider) > sum('candidate', 'scriptErrors', m.provider),
    );
  const latencyRatio = sum('candidate', 'durationMs') / sum('baseline', 'durationMs');
  return {
    provisionalDecision: uncertain
      ? 'inconclusive'
      : regression
      ? 'reject'
      : !enough
      ? 'inconclusive'
      : latencyRatio > p.maximumAggregateLatencyRatio
      ? 'reject'
      : 'eligible-for-independent-review',
    baselineErrors,
    candidateErrors,
    workflowWins,
    latencyRatio,
    uncertain,
    regression,
    enough,
    note: 'Independent inspection of nested calls and raw evidence is required. No automatic installation.',
  };
}

if (!process.argv[2] || process.argv.length !== 3)
  throw new Error('Usage: node experiments/run-code-reliability/run.mjs <new-output-directory>');
const out = path.resolve(process.argv[2]);
await mkdir(out, { recursive: false });
const bytes = await readFile(path.join(here, 'protocol.json'));
const protocol = JSON.parse(bytes);
const snapshot = {};
for (const task of protocol.tasks) {
  snapshot[task.id] = { ...task.files };
  for (const relative of task.sources) snapshot[task.id][relative] = await readFile(path.join(root, relative), 'utf8');
}
await writeFile(path.join(out, 'fixture-snapshot.json'), JSON.stringify(snapshot, null, 2), { flag: 'wx' });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await writeFile(path.join(out, 'frozen-protocol.json'), bytes, { flag: 'wx' });
await writeFile(
  path.join(out, 'conditions.json'),
  JSON.stringify(
    {
      revision,
      protocolHash: hash(bytes),
      runnerHash: hash(await readFile(fileURLToPath(import.meta.url))),
      cliHash: hash(await readFile(path.join(root, 'dist/cli.js'))),
      node: process.version,
      models: protocol.models,
      startedAt: new Date().toISOString(),
      scope:
        'Explicit task-local instruction comparison, not a canonical skill mutation. Repeated-model strata are recorded separately, not treated as independent workflows. Production source stays unchanged.',
    },
    null,
    2,
  ),
);
const runs = [];
for (const [i, task] of protocol.tasks.entries()) {
  for (const arm of i % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
    runs.push(
      ...(await Promise.all(
        protocol.models.map((model, index) => trial(out, protocol, task, model, arm, index, snapshot)),
      )),
    );
  }
}
await writeFile(path.join(out, 'summary.json'), JSON.stringify({ ...compare(protocol, runs), runs }, null, 2));
console.log(JSON.stringify({ type: 'study_complete', ...compare(protocol, runs) }));
