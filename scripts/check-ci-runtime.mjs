#!/usr/bin/env node
// PR CI gate: fail if any CI lane's code-only execution time exceeds scripts/ci-budget.json.
//
// Measures only our code steps per lane (excluding runner queue wait, checkout, setup-tests,
// cache restore/save, and GitHub API checks) so external GitHub/network jitter does not fail PRs.
// Raising maxSeconds in scripts/ci-budget.json is gated by scripts/check-ci-budget.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_FILE = path.join(repo, 'scripts/ci-budget.json');
const IGNORED_JOBS = new Set(['changes', 'port']);
const EXTERNAL_STEP =
  /^(Set up job|Complete job|Post |Run actions\/checkout@|Run \.\/\.github\/actions\/setup-tests|Restore Next\.js build cache|Restore npm cache|Reject unapproved )/;

export function isCodeStep(step) {
  if (!step || step.conclusion === 'skipped' || !step.started_at || !step.completed_at) return false;
  return !EXTERNAL_STEP.test(step.name ?? '');
}

export function stepSeconds(step) {
  const start = Date.parse(step.started_at);
  const end = Date.parse(step.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 1000);
}

export function evaluateJobs(jobs, maxSeconds) {
  const lanes = [];
  for (const job of jobs) {
    if (IGNORED_JOBS.has(job.name) || job.conclusion === 'skipped') continue;
    const codeSteps = (job.steps ?? []).filter(isCodeStep).map((step) => ({
      name: step.name,
      seconds: stepSeconds(step),
    }));
    const totalSeconds = codeSteps.reduce((sum, step) => sum + step.seconds, 0);
    lanes.push({ name: job.name, seconds: totalSeconds, steps: codeSteps, over: totalSeconds > maxSeconds });
  }
  lanes.sort((a, b) => b.seconds - a.seconds);
  return lanes;
}

function fetchAttemptJobs(repository, runId, attempt) {
  const endpoint = `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs`;
  let lastError;
  for (let tries = 0; tries < 2; tries++) {
    try {
      const raw = execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const pages = JSON.parse(raw);
      return pages.flatMap((page) => page.jobs ?? []);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function main() {
  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
  const maxSeconds = budget.maxSeconds;
  if (!Number.isInteger(maxSeconds) || maxSeconds <= 0) {
    console.error(`Invalid maxSeconds in scripts/ci-budget.json: ${JSON.stringify(maxSeconds)}`);
    process.exit(1);
  }

  let jobs;
  if (process.env.CI_RUNTIME_JOBS_FILE) {
    const parsed = JSON.parse(fs.readFileSync(process.env.CI_RUNTIME_JOBS_FILE, 'utf8'));
    jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
  } else {
    const repository = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;
    const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
    if (!repository || !runId) {
      console.error('Missing GITHUB_REPOSITORY or GITHUB_RUN_ID.');
      process.exit(1);
    }
    try {
      jobs = fetchAttemptJobs(repository, runId, attempt);
    } catch (error) {
      // External GitHub API failure should not block a PR.
      console.warn(
        `Warning: could not query GitHub Actions API for run ${runId} (external error); skipping runtime gate.\n${error.message}`,
      );
      return;
    }
  }

  const lanes = evaluateJobs(jobs, maxSeconds);
  const offenders = lanes.filter((lane) => lane.over);

  console.log(
    `CI code-time budget: ${maxSeconds}s per lane (excludes checkout, setup-tests, cache restore, queue wait)`,
  );
  for (const lane of lanes) {
    const status = lane.over ? 'FAIL' : 'OK';
    const breakdown = lane.steps.map((s) => `${s.name}: ${s.seconds}s`).join(', ');
    console.log(`  [${status}] ${lane.name}: ${lane.seconds}s / ${maxSeconds}s (${breakdown})`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '### CI code-time budget',
      '',
      `Budget: **${maxSeconds}s** per lane (our code steps only; excludes queue wait, checkout, \`setup-tests\`, and cache steps).`,
      '',
      '| Lane | Code time | Budget | Status |',
      '| --- | ---: | ---: | --- |',
      ...lanes.map((lane) => `| \`${lane.name}\` | ${lane.seconds}s | ${maxSeconds}s | ${lane.over ? 'FAIL' : 'OK'} |`),
      '',
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
  }

  if (offenders.length > 0) {
    console.error('');
    console.error(
      `CI code-time gate failed: ${offenders
        .map((l) => `${l.name} (${l.seconds}s)`)
        .join(', ')} exceeded ${maxSeconds}s.`,
    );
    console.error(
      'Optimize the slow lane first. Raising maxSeconds in scripts/ci-budget.json requires owner approval ' +
        '(the ci-budget-change PR label) and a concrete updated reason.',
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
