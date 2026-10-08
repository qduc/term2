#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const claimFile = path.join(root, 'docs/experiments/bdv-pilot/claims.json');
const evidencePath = 'docs/experiments/bdv-pilot/evidence.jsonl';
const evidenceFile = path.join(root, evidencePath);
const probePath = 'source/cli.integration.test.ts';
const runnerPath = 'scripts/bdv/run.mjs';
const timeoutMs = 120_000;
const probes = {
  'approval-reuse-integration': [
    'exec',
    'vitest',
    'run',
    '--reporter=json',
    '--config',
    'vitest.integration.config.ts',
    probePath,
    '-t',
    'an approved shell call does not approve a later call',
  ],
};

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function changedPaths(statusOutput) {
  return statusOutput
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((file) => file !== evidencePath);
}

export function runProcess(executable, args, { timeout = timeoutMs, env = process.env } = {}) {
  return spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, CI: '1', FORCE_COLOR: '0', NODE_ENV: 'test' },
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    killSignal: 'SIGTERM',
  });
}

export function evaluateRun({ exitCode, report, expectedCases, inputsStable }) {
  const assertions = (report?.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
  const scenarioResults = expectedCases.map((fullName) => {
    const matches = assertions.filter((result) => result.fullName === fullName);
    return {
      fullName,
      status: matches.length === 1 ? matches[0].status : matches.length === 0 ? 'missing' : 'duplicate',
    };
  });
  const accepted =
    exitCode === 0 &&
    inputsStable &&
    expectedCases.length > 0 &&
    new Set(expectedCases).size === expectedCases.length &&
    scenarioResults.length === expectedCases.length &&
    scenarioResults.every((result) => result.status === 'passed');
  return { accepted, scenarioResults };
}

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

async function captureInputs() {
  const [claimBytes, probeBytes, runnerBytes, status] = await Promise.all([
    readFile(claimFile),
    readFile(path.join(root, probePath)),
    readFile(path.join(root, runnerPath)),
    Promise.resolve(git(['status', '--porcelain=v1', '--untracked-files=all'])),
  ]);
  const head = git(['rev-parse', 'HEAD']);
  return {
    commit: head.status === 0 ? head.stdout.trim() : null,
    claimDigest: digest(claimBytes),
    probeDigest: digest(probeBytes),
    runnerDigest: digest(runnerBytes),
    dirtyPaths: status.status === 0 ? changedPaths(status.stdout) : ['<git-status-error>'],
  };
}

function sameInputs(before, after) {
  return (
    before.commit !== null &&
    before.commit === after.commit &&
    before.claimDigest === after.claimDigest &&
    before.probeDigest === after.probeDigest &&
    before.runnerDigest === after.runnerDigest &&
    before.dirtyPaths.length === 0 &&
    after.dirtyPaths.length === 0
  );
}

function normalizeOutput(value, tempDirectory) {
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replaceAll(root, '<repo>')
    .replaceAll(tempDirectory, '<temp>');
}

async function main() {
  const claimId = process.argv[2];
  const claimBytes = await readFile(claimFile);
  const claims = JSON.parse(claimBytes.toString('utf8')).claims;
  const claim = claims.find((item) => item.id === claimId);
  if (!claim || !probes[claim.probe]) {
    console.error(`Usage: pnpm bdv <claim-id>\nAvailable claims: ${claims.map((item) => item.id).join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const startedAt = new Date();
  const started = performance.now();
  const before = await captureInputs();
  const approvedProbe = before.probeDigest === claim.approvedProbeDigest;
  const preflightPassed =
    before.dirtyPaths.length === 0 &&
    before.claimDigest === digest(claimBytes) &&
    approvedProbe &&
    before.commit !== null;
  let result = { status: 1, signal: null, error: null, stdout: '', stderr: '' };
  let report = null;
  let command = ['pnpm', ...probes[claim.probe], '--outputFile', '<temp>/vitest-report.json'];
  let tempDirectory = '<not-created>';

  if (preflightPassed) {
    tempDirectory = await mkdtemp(path.join(tmpdir(), 'term2-bdv-'));
    const reportFile = path.join(tempDirectory, 'vitest-report.json');
    command = ['pnpm', ...probes[claim.probe], '--outputFile', reportFile];
    try {
      result = runProcess('pnpm', [...probes[claim.probe], '--outputFile', reportFile], { timeout: timeoutMs });
      try {
        const reportBytes = await readFile(reportFile);
        report = JSON.parse(reportBytes.toString('utf8'));
      } catch {
        report = null;
      }
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  const after = await captureInputs();
  const inputsStable = preflightPassed && sameInputs(before, after);
  const exitCode = result.status ?? 1;
  const evaluated = evaluateRun({
    exitCode,
    report,
    expectedCases: claim.acceptance.expectedCases,
    inputsStable,
  });
  const durationMs = Math.round(performance.now() - started);
  const structuredResult = {
    totalTests: report?.numTotalTests ?? null,
    passedTests: report?.numPassedTests ?? null,
    failedTests: report?.numFailedTests ?? null,
    scenarioResults: evaluated.scenarioResults,
  };
  const output = normalizeOutput(`${result.stdout ?? ''}${result.stderr ?? ''}`, tempDirectory);
  const evidence = {
    schemaVersion: 2,
    claimId,
    claimDigest: before.claimDigest,
    approvedProbeDigest: claim.approvedProbeDigest,
    probeDigest: before.probeDigest,
    runnerDigest: before.runnerDigest,
    commit: before.commit,
    commitAfter: after.commit,
    claimDigestAfter: after.claimDigest,
    probeDigestAfter: after.probeDigest,
    runnerDigestAfter: after.runnerDigest,
    inputsStable,
    dirtyPathsBefore: before.dirtyPaths,
    dirtyPathsAfter: after.dirtyPaths,
    startedAt: startedAt.toISOString(),
    durationMs,
    timeoutMs,
    timedOut: result.error?.code === 'ETIMEDOUT',
    command: command.map((part) => (part.startsWith(tempDirectory) ? '<temp>/vitest-report.json' : part)),
    exitCode,
    ...structuredResult,
    resultDigest: digest(JSON.stringify(structuredResult)),
    verdict: evaluated.accepted ? 'pass' : 'fail',
    outputDigest: digest(output),
    output,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
  };

  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await appendFile(evidenceFile, `${JSON.stringify(evidence)}\n`);
  process.stdout.write(output);
  console.log(`BDV ${claimId}: ${evidence.verdict}; evidence appended to ${evidencePath}`);
  if (!preflightPassed) {
    console.error(
      `BDV refused to run: ${
        !approvedProbe
          ? 'probe digest differs from the frozen contract'
          : 'working tree is dirty or Git state is unavailable'
      }`,
    );
  } else if (!inputsStable) {
    console.error('BDV rejected the run because executable inputs changed during the probe');
  }
  process.exitCode = evaluated.accepted ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
