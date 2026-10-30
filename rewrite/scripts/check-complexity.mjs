#!/usr/bin/env node
// Ratchet the rewrite's size: allowlisted source edges and file lengths may
// only shrink. Budgets live in complexity-budget.json beside this script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '../..');
const budget = JSON.parse(fs.readFileSync(path.join(scripts, 'complexity-budget.json'), 'utf8'));
const edges = JSON.parse(fs.readFileSync(path.join(scripts, 'source-edge-allowlist.json'), 'utf8'));

const problems = [];
const hints = [];

if (edges.length > budget.maxSourceEdges)
  problems.push(
    `source-edge-allowlist.json has ${edges.length} edges (budget ${budget.maxSourceEdges}). ` +
      'Route the new dependency through an existing adapter instead of allowlisting it.',
  );
else if (edges.length < budget.maxSourceEdges) hints.push(`lower maxSourceEdges to ${edges.length}`);

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
};
walk(path.join(repo, 'rewrite/src'));

for (const full of files.sort()) {
  const file = path.relative(repo, full).split(path.sep).join('/');
  const lines = fs.readFileSync(full, 'utf8').split('\n').length - 1;
  const ceiling = budget.fileCeilings[file];
  const limit = ceiling ?? budget.maxLines;
  if (lines > limit)
    problems.push(
      ceiling === undefined
        ? `${file} has ${lines} lines (limit ${budget.maxLines}). Split it by job.`
        : `${file} grew to ${lines} lines (ceiling ${ceiling}). It is already over the limit; split it rather than grow it.`,
    );
  else if (ceiling !== undefined && lines <= budget.maxLines) hints.push(`remove the ceiling for ${file}`);
  else if (ceiling !== undefined && lines < ceiling) hints.push(`lower the ceiling for ${file} to ${lines}`);
}
for (const file of Object.keys(budget.fileCeilings))
  if (!fs.existsSync(path.join(repo, file))) hints.push(`remove the ceiling for missing ${file}`);

for (const hint of hints) console.log(`under budget: ${hint} in rewrite/scripts/complexity-budget.json`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(
  `complexity check passed (${edges.length} source edges, ${files.length} files, ` +
    `${Object.keys(budget.fileCeilings).length} over ${budget.maxLines} lines)`,
);
