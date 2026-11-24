#!/usr/bin/env node
// PR CI guard: raising scripts/ci-budget.json maxSeconds (or removing the budget file)
// requires both a concrete updated reason and owner approval via the `ci-budget-change` PR label.
// Keeping or lowering maxSeconds is always allowed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reasonProblem } from './gates/rules.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_REL = 'scripts/ci-budget.json';
const BUDGET_ABS = path.join(repo, BUDGET_REL);
const APPROVAL_LABEL = 'ci-budget-change';

function parseBudget(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`${label} must be a JSON object`);
  if (!Number.isInteger(parsed.maxSeconds) || parsed.maxSeconds <= 0) {
    throw new Error(`${label} maxSeconds must be a positive integer, got ${JSON.stringify(parsed.maxSeconds)}`);
  }
  const problem = reasonProblem(parsed.reason);
  if (problem) throw new Error(`${label} ${problem}`);
  return { maxSeconds: parsed.maxSeconds, reason: parsed.reason.trim() };
}

function readBaseBudget(baseRef) {
  if (!baseRef) return null;
  try {
    const raw = execFileSync('git', ['show', `${baseRef}:${BUDGET_REL}`], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseBudget(raw, `${baseRef}:${BUDGET_REL}`);
  } catch {
    return null;
  }
}

function hasApprovalLabel() {
  if (process.env.CI_BUDGET_APPROVED === 'true') return true;
  if (process.env.CI_BUDGET_APPROVED === 'false') return false;
  const repository = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  if (!repository || !prNumber) return false;
  // Query live PR state so reruns and label removals cannot reuse a stale event payload.
  const out = execFileSync(
    'gh',
    ['api', `repos/${repository}/pulls/${prNumber}`, '--jq', `any(.labels[]; .name == "${APPROVAL_LABEL}")`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  return out === 'true';
}

function main() {
  const baseRef = process.env.PR_BASE || '';
  const base = readBaseBudget(baseRef);

  if (!fs.existsSync(BUDGET_ABS)) {
    if (base && !hasApprovalLabel()) {
      console.error(`Deleting ${BUDGET_REL} requires owner approval (${APPROVAL_LABEL} PR label).`);
      process.exit(1);
    }
    if (!base) {
      console.error(`Missing ${BUDGET_REL}.`);
      process.exit(1);
    }
    console.log(`${BUDGET_REL} removal approved via ${APPROVAL_LABEL} label.`);
    return;
  }

  let current;
  try {
    current = parseBudget(fs.readFileSync(BUDGET_ABS, 'utf8'), BUDGET_REL);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (!base) {
    console.log(`CI budget check passed (new ${BUDGET_REL}: maxSeconds=${current.maxSeconds}s).`);
    return;
  }

  if (current.maxSeconds <= base.maxSeconds) {
    const note =
      current.maxSeconds < base.maxSeconds
        ? `lowered ${base.maxSeconds}s -> ${current.maxSeconds}s`
        : `unchanged at ${current.maxSeconds}s`;
    console.log(`CI budget check passed (${note}).`);
    return;
  }

  const failures = [];
  if (current.reason === base.reason) {
    failures.push(
      `${BUDGET_REL} maxSeconds rose ${base.maxSeconds}s -> ${current.maxSeconds}s, but its reason is unchanged; ` +
        'rewrite reason to explain why the higher limit is unavoidable.',
    );
  }
  if (!hasApprovalLabel()) {
    failures.push(
      `${BUDGET_REL} maxSeconds rose ${base.maxSeconds}s -> ${current.maxSeconds}s without owner approval ` +
        `(missing the "${APPROVAL_LABEL}" PR label).`,
    );
  }

  if (failures.length > 0) {
    for (const line of failures) console.error(line);
    process.exit(1);
  }

  console.log(
    `CI budget raise approved (${base.maxSeconds}s -> ${current.maxSeconds}s, label "${APPROVAL_LABEL}"):\n` +
      `  reason: ${current.reason}`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '### Approved CI budget raise',
      '',
      `- **Limit:** ${base.maxSeconds}s → ${current.maxSeconds}s`,
      `- **Approval:** \`${APPROVAL_LABEL}\` label present`,
      `- **Reason:** ${current.reason}`,
      '',
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
  }
}

main();
