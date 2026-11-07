#!/usr/bin/env node
// CI guard (Rule 6): Agents may not grow a baseline.
// Compares layer-allowlist.json, rule-baseline.json, reachability-allowlist.json,
// complexity-budget.json (and root-allowlist.json) against the merge base.
// Adding entries or raising ceilings fails CI; removing entries or lowering ceilings is allowed.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '..');

function getBaseCommit() {
  if (process.env.PR_BASE) return process.env.PR_BASE;
  if (process.env.MERGE_BASE) return process.env.MERGE_BASE;
  if (process.env.BASE_REF) return process.env.BASE_REF;
  if (process.env.GITHUB_BASE_REF) {
    try {
      const mb = execSync(`git merge-base HEAD origin/${process.env.GITHUB_BASE_REF}`, {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
      if (mb) return mb;
    } catch {}
  }
  try {
    const mb = execSync('git merge-base HEAD origin/main', { cwd: repo, encoding: 'utf8' }).trim();
    if (mb) return mb;
  } catch {}
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

const baseCommit = getBaseCommit();
const problems = [];

function parseAllowlist(text) {
  try {
    return JSON.parse(text);
  } catch {
    const matches = [...text.matchAll(/"([^"]+ -> [^"]+ \([^)]+\))"/g)].map((m) => m[1]);
    if (matches.length > 0) return matches;
    throw new Error('cannot parse layer-allowlist.json');
  }
}

// 1. layer-allowlist.json
const baseLayerText = showFile(baseCommit, 'scripts/layer-allowlist.json');
if (baseLayerText) {
  const baseEdges = new Set(parseAllowlist(baseLayerText));
  const currentEdges = new Set(parseAllowlist(fs.readFileSync(path.join(scripts, 'layer-allowlist.json'), 'utf8')));
  const added = [...currentEdges].filter((e) => !baseEdges.has(e));
  if (added.length > 0) {
    problems.push(
      `scripts/layer-allowlist.json grew by ${added.length} entry/entries: ${added.slice(0, 3).join('; ')}`,
    );
  }
}

// 2. reachability-allowlist.json
const baseReachText = showFile(baseCommit, 'scripts/reachability-allowlist.json');
if (baseReachText) {
  const baseReach = JSON.parse(baseReachText);
  const currentReach = JSON.parse(fs.readFileSync(path.join(scripts, 'reachability-allowlist.json'), 'utf8'));
  const added = Object.keys(currentReach).filter((k) => !(k in baseReach));
  if (added.length > 0) {
    problems.push(`scripts/reachability-allowlist.json grew: new entry ${added.join(', ')}`);
  }
}

// 3. rule-baseline.json
const baseRuleText = showFile(baseCommit, 'scripts/rule-baseline.json');
if (baseRuleText) {
  const baseRule = JSON.parse(baseRuleText);
  const currentRule = JSON.parse(fs.readFileSync(path.join(scripts, 'rule-baseline.json'), 'utf8'));

  const baseWire = new Set((baseRule.wireEventOutsideProtocol || []).map((e) => `${e.file} ${e.type}`));
  const currentWire = (currentRule.wireEventOutsideProtocol || []).map((e) => `${e.file} ${e.type}`);
  const addedWire = currentWire.filter((w) => !baseWire.has(w));
  if (addedWire.length > 0) {
    problems.push(`scripts/rule-baseline.json grew: wireEventOutsideProtocol added ${addedWire.join(', ')}`);
  }

  const baseJob = new Set(baseRule.jobNameExceptions || []);
  const currentJob = currentRule.jobNameExceptions || [];
  const addedJob = currentJob.filter((j) => !baseJob.has(j));
  if (addedJob.length > 0) {
    problems.push(`scripts/rule-baseline.json grew: jobNameExceptions added ${addedJob.join(', ')}`);
  }

  const baseUnused = new Set(baseRule.unusedExports || []);
  const currentUnused = currentRule.unusedExports || [];
  const addedUnused = currentUnused.filter((u) => !baseUnused.has(u));
  if (addedUnused.length > 0) {
    problems.push(`scripts/rule-baseline.json grew: unusedExports added ${addedUnused.length} entries`);
  }
}

// 4. complexity-budget.json
const baseBudgetText = showFile(baseCommit, 'scripts/complexity-budget.json');
if (baseBudgetText) {
  const baseBudget = JSON.parse(baseBudgetText);
  const currentBudget = JSON.parse(fs.readFileSync(path.join(scripts, 'complexity-budget.json'), 'utf8'));

  if (currentBudget.maxLayerEdges > baseBudget.maxLayerEdges) {
    problems.push(
      `scripts/complexity-budget.json raised ceiling: maxLayerEdges grew from ${baseBudget.maxLayerEdges} to ${currentBudget.maxLayerEdges}`,
    );
  }
  if (currentBudget.maxLines > baseBudget.maxLines) {
    problems.push(
      `scripts/complexity-budget.json raised ceiling: maxLines grew from ${baseBudget.maxLines} to ${currentBudget.maxLines}`,
    );
  }

  const baseCeilings = baseBudget.fileCeilings || {};
  const currentCeilings = currentBudget.fileCeilings || {};

  for (const [file, info] of Object.entries(currentCeilings)) {
    if (!baseCeilings[file]) {
      problems.push(`scripts/complexity-budget.json grew: new file ceiling for ${file}`);
    } else if (info.lines > baseCeilings[file].lines) {
      problems.push(
        `scripts/complexity-budget.json raised ceiling: ${file} lines ceiling grew from ${baseCeilings[file].lines} to ${info.lines}`,
      );
    }
  }
}

// 5. root-allowlist.json (if present in base)
const baseRootText = showFile(baseCommit, 'scripts/root-allowlist.json');
if (baseRootText) {
  const baseRoot = new Set(JSON.parse(baseRootText));
  const currentRoot = JSON.parse(fs.readFileSync(path.join(scripts, 'root-allowlist.json'), 'utf8'));
  const added = currentRoot.filter((r) => !baseRoot.has(r));
  if (added.length > 0) {
    problems.push(`scripts/root-allowlist.json grew: added root file ${added.join(', ')}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log(`baseline check passed (compared with ${baseCommit.slice(0, 7)})`);
