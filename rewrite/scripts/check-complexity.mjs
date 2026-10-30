#!/usr/bin/env node
// Keep the rewrite's size visible: allowlisted source edges may only shrink, and
// long files need a recorded reason. Budgets live in complexity-budget.json.
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

// The line limit is a prompt to look for a second job, not a target: a file that
// reads better whole keeps a ceiling, with the reason written next to it.
for (const full of files.sort()) {
  const file = path.relative(repo, full).split(path.sep).join('/');
  const lines = fs.readFileSync(full, 'utf8').split('\n').length - 1;
  const ceiling = budget.fileCeilings[file];
  if (ceiling && !ceiling.reason?.trim()) problems.push(`${file} has a ceiling without a reason.`);
  if (!ceiling && lines > budget.maxLines)
    problems.push(
      `${file} has ${lines} lines (limit ${budget.maxLines}). If it does more than one job, split it along that ` +
        'seam. If it reads better whole, give it a ceiling with a one-line reason.',
    );
  else if (ceiling && lines > ceiling.lines)
    problems.push(
      `${file} grew to ${lines} lines (ceiling ${ceiling.lines}, recorded reason: "${ceiling.reason}"). ` +
        'Split out the new job, or ' +
        'raise the ceiling and say in the reason why it still reads better as one file.',
    );
  else if (ceiling && lines <= budget.maxLines) hints.push(`remove the ceiling for ${file}`);
  else if (ceiling && lines < ceiling.lines) hints.push(`lower the ceiling for ${file} to ${lines}`);
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
