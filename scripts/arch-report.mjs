#!/usr/bin/env node
// Scoreboard report for architecture metrics.
// Reads metrics directly from the files and updates maxLayerEdges to match current edges.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '..');

// 1. Allowlisted layer edges
const edgesPath = path.join(scripts, 'layer-allowlist.json');
const edges = JSON.parse(fs.readFileSync(edgesPath, 'utf8'));
const pairs = new Set();
for (const edge of edges) {
  const m = edge.match(/^(\S+) -> (\S+) \((\S+) -> (\S+)\)$/);
  if (m) pairs.add(`${m[3]}->${m[4]}`);
}

// 2. maxLayerEdges ceiling (ratchet: updates automatically if edges changed)
const budgetPath = path.join(scripts, 'complexity-budget.json');
const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
if (budget.maxLayerEdges !== edges.length) {
  budget.maxLayerEdges = edges.length;
  fs.writeFileSync(budgetPath, JSON.stringify(budget, null, 2) + '\n', 'utf8');
}

// 3 & 4. Rule baseline metrics
const ruleBaselinePath = path.join(scripts, 'rule-baseline.json');
const ruleBaseline = JSON.parse(fs.readFileSync(ruleBaselinePath, 'utf8'));
const nameExceptions = ruleBaseline.jobNameExceptions?.length ?? 0;
const unusedExports = ruleBaseline.unusedExports?.length ?? 0;

// 5 & 6. Large files in src (excluding generated)
const srcDir = path.join(repo, 'src');
const srcFiles = [];
function walkSrc(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(full);
    else if (/\.(tsx?|mts|cts)$/.test(entry.name) && !entry.name.includes('.generated.')) {
      srcFiles.push(full);
    }
  }
}
walkSrc(srcDir);

let over500 = 0;
let over1000 = 0;
for (const file of srcFiles) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').length - 1;
  if (lines > 500) over500++;
  if (lines > 1000) over1000++;
}

// 7. Loose .ts files directly in src/session/
const sessionDir = path.join(srcDir, 'session');
const looseSessionFiles = fs.existsSync(sessionDir)
  ? fs.readdirSync(sessionDir, { withFileTypes: true }).filter((e) => e.isFile() && /\.(tsx?|mts|cts)$/.test(e.name))
      .length
  : 0;

// 8. Agent handoff files in repo root
const handoffFiles = [
  'FIX_REPORT.md',
  'JOURNAL_REPAIR_REPORT.md',
  'CHANGE_MANIFEST.json',
  'JOURNAL_REPAIR_MANIFEST.json',
];
const rootHandoffCount = handoffFiles.filter((f) => fs.existsSync(path.join(repo, f))).length;

// 9. docs/ size and file count
const docsDir = path.join(repo, 'docs');
let docsFileCount = 0;
let docsBytes = 0;
let docsExpBytes = 0;

function walkDocs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDocs(full);
    } else if (entry.isFile()) {
      docsFileCount++;
      const size = fs.statSync(full).size;
      docsBytes += size;
      if (full.startsWith(path.join(docsDir, 'experiments'))) {
        docsExpBytes += size;
      }
    }
  }
}
if (fs.existsSync(docsDir)) {
  walkDocs(docsDir);
}

let docsMB = Math.round(docsBytes / (1024 * 1024));
let expMB = Math.round(docsExpBytes / (1024 * 1024));
try {
  const { execSync } = await import('node:child_process');
  const dOut = execSync('du -sm docs', { cwd: repo, encoding: 'utf8' }).trim();
  const eOut = execSync('du -sm docs/experiments', { cwd: repo, encoding: 'utf8' }).trim();
  if (dOut) docsMB = parseInt(dOut.split(/\s+/)[0], 10);
  if (eOut) expMB = parseInt(eOut.split(/\s+/)[0], 10);
} catch {
  // Fall back to apparent bytes
}

const report = [
  'Architecture scoreboard:',
  `- Allowlisted layer edges: ${edges.length} (${pairs.size} layer pairs)`,
  `- maxLayerEdges ceiling: ${budget.maxLayerEdges}`,
  `- Name exceptions (service/adapter/orchestrator): ${nameExceptions}`,
  `- Unused runtime exports: ${unusedExports}`,
  `- Files over 500 lines (excluding generated): ${over500}`,
  `- Files over 1,000 lines: ${over1000}`,
  `- Loose .ts files directly in src/session/: ${looseSessionFiles}`,
  `- Agent handoff files in repo root: ${rootHandoffCount}`,
  `- docs/ size: ${docsMB} MB, ${docsFileCount} files (docs/experiments is ${expMB} MB)`,
].join('\n');

console.log(report);
