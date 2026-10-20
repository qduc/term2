import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { inventory } from './inventory.mjs';

// Post-trial consistency audit. This does not alter the frozen comparator.
const out = path.resolve(process.argv[2]);
const root = path.resolve(import.meta.dirname, '../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (file) => JSON.parse(await readFile(path.join(out, file), 'utf8'));
const protocol = await json('frozen-protocol.json');
const snapshot = await json('fixture-snapshot.json');
const conditions = await json('conditions.json');
const summary = await json('summary.json');
assert.equal(hash(await readFile(path.join(out, 'frozen-protocol.json'))), conditions.protocolHash);
assert.equal(
  hash(
    execFileSync('git', ['show', `${conditions.revision}:experiments/run-code-reliability/protocol.json`], {
      cwd: root,
    }),
  ),
  conditions.protocolHash,
);
for (const [file, expected] of [
  ['run.mjs', conditions.runnerHash],
  ['inventory.mjs', conditions.inventoryHash],
]) {
  assert.equal(
    hash(
      execFileSync('git', ['show', `${conditions.revision}:experiments/run-code-reliability/${file}`], { cwd: root }),
    ),
    expected,
  );
}
assert.equal(hash(await readFile(path.join(root, 'dist/cli.js'))), conditions.cliHash);
assert.equal(summary.runs.length, 24);
const scripts = [];
const totals = {};
for (const arm of ['baseline', 'candidate'])
  totals[arm] = { scriptErrors: 0, scriptCalls: 0, oraclePasses: 0, durationMs: 0 };
for (const run of summary.runs) {
  const task = protocol.tasks.find((t) => t.id === run.task);
  const invocationBytes = await readFile(path.join(out, run.id, 'invocation.json'));
  const invocation = JSON.parse(invocationBytes);
  const eventBytes = await readFile(path.join(out, run.id, 'events.ndjson'));
  const stderr = await readFile(path.join(out, run.id, 'stderr.txt'));
  assert.equal(hash(invocationBytes), run.evidence.invocation);
  assert.equal(hash(eventBytes), run.evidence.events);
  assert.equal(hash(stderr), run.evidence.stderr);
  const expectedHashes = Object.fromEntries(Object.entries(snapshot[task.id]).map(([p, v]) => [p, hash(v)]));
  assert.deepEqual(invocation.before, expectedHashes);
  assert.deepEqual(await inventory(path.join(out, run.id, 'scratch')), expectedHashes);
  const events = eventBytes
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const starts = events.filter((e) => e.type === 'tool_started');
  const commands = events.filter((e) => e.type === 'command_message').map((e) => e.message);
  const completed = events.filter((e) => e.type === 'completed');
  assert.equal(completed.length, 1);
  assert.equal(starts.length, 1);
  assert.equal(commands.length, 1);
  assert.equal(starts[0].toolName, 'run_code');
  assert.equal(starts[0].toolCallId, commands[0].callId);
  assert.equal(commands[0].toolName, 'run_code');
  assert.equal(typeof commands[0].success, 'boolean');
  assert.equal(run.scriptErrors, Number(commands[0].success === false));
  let actual = null;
  try {
    actual = JSON.parse(completed[0].finalText);
  } catch {
    /* exact oracle rejects */
  }
  const expected = { facts: task.expected, missing: task.paths.filter((p) => !Object.hasOwn(snapshot[task.id], p)) };
  let oracle = true;
  try {
    assert.deepEqual(actual, expected);
  } catch {
    oracle = false;
  }
  assert.equal(run.oraclePass, oracle);
  const reads = (await readFile(path.join(out, run.id, 'reads.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(reads.every((r) => r.allowed && task.paths.some((p) => path.resolve(invocation.cwd, p) === r.resolved)));
  assert(task.paths.every((p) => reads.some((r) => r.resolved === path.resolve(invocation.cwd, p))));
  scripts.push({
    id: run.id,
    model: run.model,
    arm: run.arm,
    code: starts[0].arguments,
    success: commands[0].success,
    output: commands[0].output,
    finalText: completed[0].finalText,
    oraclePass: oracle,
    reads,
  });
  totals[run.arm].scriptErrors += run.scriptErrors;
  totals[run.arm].scriptCalls += starts.length;
  totals[run.arm].oraclePasses += Number(oracle);
  totals[run.arm].durationMs += run.durationMs;
}
assert.equal(totals.baseline.scriptErrors, summary.baselineErrors);
assert.equal(totals.candidate.scriptErrors, summary.candidateErrors);
const result = {
  passed: true,
  revision: conditions.revision,
  protocolHash: conditions.protocolHash,
  runs: scripts.length,
  totals,
  latencyRatio: totals.candidate.durationMs / totals.baseline.durationMs,
  fixtureSnapshotHash: hash(await readFile(path.join(out, 'fixture-snapshot.json'))),
  builtAgentHash: hash(await readFile(path.join(root, 'dist/agent.js'))),
  conclusion:
    'Raw events, fixture bytes and hashes agree with recorded results. Manual independent script/safety inspection still required.',
};
await writeFile(path.join(out, 'audit.json'), JSON.stringify(result, null, 2));
await writeFile(path.join(out, 'scripts-for-review.json'), JSON.stringify(scripts, null, 2));
console.log(JSON.stringify(result));
