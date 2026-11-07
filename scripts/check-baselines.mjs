#!/usr/bin/env node
// CI guard: recorded deviations from a rule must carry reasons, and the reviewer sees every new one.
//
// Compares the gate exception files (layer-allowlist.json, rule-baseline.json, reachability-allowlist.json,
// complexity-budget.json, root-allowlist.json) against the merge base. A change may add an exception or raise a
// file ceiling when it judges the rule wrong for that case, but only with a reason a later reader can judge:
//   - a new entry must be an object with a reason (bare legacy strings cannot grow);
//   - a raised file ceiling must rewrite its reason to cover the new lines;
//   - the global line limit cannot rise here, that is the user's call.
// Every accepted deviation is printed (and written to the CI step summary) for the reviewer to confirm.
// Removing entries or lowering ceilings is always allowed. Policy: docs/architecture/layers.md#when-a-gate-fails.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import {
  RULES,
  failureMap,
  readDeviations,
  readWorkingTree,
  reasonProblem,
  repo,
  reportAndExit,
} from './gates/rules.mjs';

function getBaseCommit() {
  if (process.env.PR_BASE) return process.env.PR_BASE;
  if (process.env.MERGE_BASE) return process.env.MERGE_BASE;
  if (process.env.BASE_REF) return process.env.BASE_REF;
  const ref = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
  for (const candidate of [ref, 'origin/main']) {
    try {
      const mb = execSync(`git merge-base HEAD ${candidate}`, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (mb) return mb;
    } catch {}
  }
  return 'HEAD';
}

function showFile(commit, relativePath) {
  try {
    return execSync(`git show ${commit}:${relativePath}`, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// new path -> old path, repo-relative.
function getRenamedFiles(commit) {
  const renames = new Map();
  try {
    const out = execSync(`git diff -M --diff-filter=R --name-status ${commit}`, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    for (const line of out.trim().split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3 && parts[0].startsWith('R')) renames.set(parts[2].trim(), parts[1].trim());
    }
  } catch {}
  return renames;
}

const baseCommit = getBaseCommit();
const renames = getRenamedFiles(baseCommit);
// Paths in the exception files are repo-relative or relative to src/, depending on the file.
const oldPath = (p) => renames.get(p) ?? renames.get(`src/${p}`)?.replace(/^src\//, '');

const base = readDeviations((file) => showFile(baseCommit, file));
const current = readDeviations(readWorkingTree);

const index = (deviations) => {
  const map = new Map();
  for (const d of deviations) map.set(`${d.rule}\0${d.key}`, d);
  return map;
};
const baseIndex = index(base.deviations);
const EDGE = /^(.+?) -> (.+?) \((.+?) -> (.+?)\)$/;
const baseEdges = base.deviations
  .filter((d) => d.rule === 'layer-direction')
  .map((d) => d.key.match(EDGE))
  .filter(Boolean);

function baseEntryFor(d) {
  const direct = baseIndex.get(`${d.rule}\0${d.key}`);
  if (direct) return direct;
  if (d.rule === 'layer-direction') {
    // An edge whose ends were renamed is the same edge.
    const m = d.key.match(EDGE);
    if (!m) return undefined;
    const [, source, target] = m;
    const hit = baseEdges.find(
      ([, s, t]) => (s === source || s === oldPath(source)) && (t === target || t === oldPath(target)),
    );
    return hit ? { key: hit[0] } : undefined;
  }
  const [file, ...rest] = d.key.split(' ');
  const old = oldPath(file);
  return old ? baseIndex.get(`${d.rule}\0${[old, ...rest].join(' ')}`) : undefined;
}

const { map: failures, add } = failureMap();
const problem = add('baselines');
const accepted = [];

for (const d of current.deviations) {
  if (!base.present.has(d.file)) continue; // the exception file is new in this change; nothing to compare
  const before = baseEntryFor(d);
  const where = `${d.file}: [${d.rule}] ${d.key}`;
  if (!before) {
    if (d.legacy)
      problem(`${where} is a new bare entry; write it as an object with a reason (${RULES[d.rule].exceptions?.entry})`);
    else if (reasonProblem(d.reason)) problem(`${where} ${reasonProblem(d.reason)}`);
    else accepted.push({ ...d, change: 'new exception' });
  } else if (d.rule === 'file-size' && d.lines > before.lines) {
    if ((d.reason ?? '').trim() === (before.reason ?? '').trim())
      problem(
        `${where} ceiling rose ${before.lines} -> ${d.lines} but its reason is unchanged; say why the new lines still belong here`,
      );
    else if (reasonProblem(d.reason)) problem(`${where} ${reasonProblem(d.reason)}`);
    else accepted.push({ ...d, change: `ceiling ${before.lines} -> ${d.lines}` });
  } else if (d.rule === 'folder-fanout' && d.files > before.files) {
    if ((d.reason ?? '').trim() === (before.reason ?? '').trim())
      problem(
        `${where} ceiling rose ${before.files} -> ${d.files} but its reason is unchanged; say why the new files still belong here`,
      );
    else if (reasonProblem(d.reason)) problem(`${where} ${reasonProblem(d.reason)}`);
    else accepted.push({ ...d, change: `ceiling ${before.files} -> ${d.files}` });
  }
}

const baseBudget = base.budget;
const currentBudget = current.budget;
if (baseBudget && currentBudget) {
  if (currentBudget.maxLines > baseBudget.maxLines)
    problem(
      `scripts/complexity-budget.json maxLines rose ${baseBudget.maxLines} -> ${currentBudget.maxLines}; the global ` +
        'limit is a user decision, record a per-file ceiling instead',
    );
  if (
    currentBudget.maxFolderFiles &&
    baseBudget.maxFolderFiles &&
    currentBudget.maxFolderFiles > baseBudget.maxFolderFiles
  )
    problem(
      `scripts/complexity-budget.json maxFolderFiles rose ${baseBudget.maxFolderFiles} -> ${currentBudget.maxFolderFiles}; the global ` +
        'limit is a user decision, record a per-folder ceiling instead',
    );
  const newEdges = accepted.filter((d) => d.rule === 'layer-direction').length;
  if (currentBudget.maxLayerEdges > baseBudget.maxLayerEdges + newEdges)
    problem(
      `scripts/complexity-budget.json maxLayerEdges rose ${baseBudget.maxLayerEdges} -> ${currentBudget.maxLayerEdges} ` +
        `but only ${newEdges} reasoned edge(s) were added`,
    );
}

reportAndExit(failures);

if (accepted.length) {
  const lines = [
    `Recorded deviations added in this change (${accepted.length}). Each passed because it carries a reason.`,
    'Reviewer: confirm each reason holds, and that fixing the violation really costs more than the exception.',
    ...accepted.map((d) => `  [${d.rule}] ${d.key} (${d.change}, ${d.file})\n    reason: ${d.reason}`),
  ];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '### Recorded gate deviations in this change',
      '',
      'Each passed because it carries a reason. Reviewer: confirm each one holds.',
      '',
      '| Rule | Entry | Change | Reason |',
      '| --- | --- | --- | --- |',
      ...accepted.map((d) => `| ${d.rule} | \`${d.key}\` | ${d.change} | ${d.reason.replace(/\|/g, '\\|')} |`),
      '',
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
  }
}
console.log(`baseline check passed (compared with ${baseCommit.slice(0, 7)})`);
