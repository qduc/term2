#!/usr/bin/env node
// PR CI guard for the settled web-transcript architecture (docs/plans/web-client/web-transcript-single-source-spec.md,
// section 8). It is a reminder, not a lock: it asks for the owner's `architecture-change` PR label when a pull
// request changes what the architecture rests on:
//   - a changed or removed line of docs/contracts/wire-fold.api.txt (the shared fold's interface; added lines pass);
//   - a deleted or emptied check: scripts/generated-verification/wire.mjs or shell.mjs, or a file under
//     tests/web-client/browser/;
//   - any change to scripts/gates/architecture-rules.mjs (the rules have no exceptions; changing them is the exception).
// Modelled on check-ci-budget.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVAL_LABEL = 'architecture-change';
const API_REPORT = 'docs/contracts/wire-fold.api.txt';
const RULES = 'scripts/gates/architecture-rules.mjs';
const CHECKS = ['scripts/generated-verification/wire.mjs', 'scripts/generated-verification/shell.mjs'];
const FLOWS_DIR = 'tests/web-client/browser/';

const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const atBase = (base, file) => {
  try {
    return git('show', `${base}:${file}`);
  } catch {
    return null;
  }
};
const now = (file) => (fs.existsSync(path.join(repo, file)) ? fs.readFileSync(path.join(repo, file), 'utf8') : null);

function hasApprovalLabel() {
  if (process.env.ARCHITECTURE_CHANGE_APPROVED === 'true') return true;
  if (process.env.ARCHITECTURE_CHANGE_APPROVED === 'false') return false;
  const repository = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  if (!repository || !prNumber) return false;
  // Live PR state, so a removed label is not read from a stale event payload.
  const out = execFileSync(
    'gh',
    ['api', `repos/${repository}/pulls/${prNumber}`, '--jq', `any(.labels[]; .name == "${APPROVAL_LABEL}")`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  return out === 'true';
}

function main() {
  const base = process.env.PR_BASE || '';
  if (!base) {
    console.log('No PR base; architecture change check skipped (it runs on pull requests).');
    return;
  }
  const touched = [];

  const baseReport = atBase(base, API_REPORT);
  const report = now(API_REPORT);
  if (baseReport !== null) {
    const current = new Set((report ?? '').split('\n'));
    const removed = baseReport.split('\n').filter((line) => line && !current.has(line));
    if (removed.length)
      touched.push(
        `${API_REPORT}: ${removed.length} line(s) changed or removed, for example:\n` +
          removed
            .slice(0, 5)
            .map((line) => `      - ${line}`)
            .join('\n') +
          "\n    This is the shared fold's public interface (the future @qduc/agent-wire); a changed or removed member breaks its users.",
      );
  }

  const flows = git('ls-tree', '-r', '--name-only', base, '--', FLOWS_DIR).split('\n').filter(Boolean);
  for (const file of [...CHECKS, ...flows]) {
    if (atBase(base, file) === null) continue;
    const content = now(file);
    if (content === null || !content.trim())
      touched.push(
        `${file}: ${
          content === null ? 'deleted' : 'emptied'
        }. It is one of the checks that keep a reloaded transcript ` +
          'equal to the live one; weakening it removes that guarantee.',
      );
  }

  const baseRules = atBase(base, RULES);
  if (baseRules !== null && baseRules !== now(RULES))
    touched.push(
      `${RULES}: changed. These rules keep the browser on the shared fold; a change or exception here is a change to ` +
        'the architecture itself.',
    );

  if (touched.length === 0) {
    console.log('Architecture change check passed: nothing guarded was changed.');
    return;
  }
  if (hasApprovalLabel()) {
    console.log(`Guarded architecture changed, approved via the ${APPROVAL_LABEL} label:\n  ${touched.join('\n  ')}`);
    return;
  }
  console.error(
    `This pull request changes the settled web-transcript architecture:\n  ${touched.join('\n  ')}\n\n` +
      'If this was not intended, undo that part of the change. If it is intended, stop and ask the owner: they add the ' +
      `\`${APPROVAL_LABEL}\` label after reading the change. Do not add the label yourself. ` +
      'Why it is guarded: docs/plans/web-client/web-transcript-single-source-spec.md, section 8.',
  );
  process.exit(1);
}

main();
