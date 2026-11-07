#!/usr/bin/env node
// Keep the tree's size visible: allowlisted layer-crossing edges may only shrink, and
// long files need a recorded reason. Budgets live in complexity-budget.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureMap, reasonProblem, reportAndExit } from './gates/rules.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '..');
const budget = JSON.parse(fs.readFileSync(path.join(scripts, 'complexity-budget.json'), 'utf8'));
const edges = JSON.parse(fs.readFileSync(path.join(scripts, 'layer-allowlist.json'), 'utf8'));

const { map: failures, add } = failureMap();
const size = add('file-size');
const fanout = add('folder-fanout');
const hints = [];

if (edges.length > budget.maxLayerEdges)
  add('layer-direction')(
    `layer-allowlist.json has ${edges.length} edges but maxLayerEdges is ${budget.maxLayerEdges}; ` +
      'raise it only alongside a new edge that carries a reason',
  );
else if (edges.length < budget.maxLayerEdges) hints.push(`lower maxLayerEdges to ${edges.length}`);

const files = [];
const folderCounts = new Map();
const walk = (dir) => {
  let tsCount = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name)) {
      files.push(full);
      tsCount++;
    }
  }
  const relFolder = path.relative(repo, dir).split(path.sep).join('/');
  if (tsCount > 0) folderCounts.set(relFolder, tsCount);
};
walk(path.join(repo, 'src'));

// The line limit is a prompt to look for a second job, not a target: a file that
// reads better whole keeps a ceiling, with the reason written next to it.
for (const full of files.sort()) {
  const file = path.relative(repo, full).split(path.sep).join('/');
  const lines = fs.readFileSync(full, 'utf8').split('\n').length - 1;
  const ceiling = budget.fileCeilings[file];
  if (ceiling && reasonProblem(ceiling.reason)) size(`${file} ceiling ${reasonProblem(ceiling.reason)}`);
  if (!ceiling && lines > budget.maxLines) size(`${file} has ${lines} lines (limit ${budget.maxLines})`);
  else if (ceiling && lines > ceiling.lines)
    size(`${file} grew to ${lines} lines (ceiling ${ceiling.lines}; recorded reason: "${ceiling.reason}")`);
  else if (ceiling && lines <= budget.maxLines) hints.push(`remove the ceiling for ${file}`);
  else if (ceiling && lines < ceiling.lines) hints.push(`lower the ceiling for ${file} to ${lines}`);
}
for (const file of Object.keys(budget.fileCeilings))
  if (!fs.existsSync(path.join(repo, file))) hints.push(`remove the ceiling for missing ${file}`);

// A folder with dozens of direct files prompts looking for submodules: a folder
// that stays cohesive keeps a ceiling, with the reason written next to it.
const maxFolderFiles = budget.maxFolderFiles ?? 15;
const folderCeilings = budget.folderCeilings ?? {};
for (const [folder, count] of [...folderCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const ceiling = folderCeilings[folder];
  if (ceiling && reasonProblem(ceiling.reason)) fanout(`${folder} ceiling ${reasonProblem(ceiling.reason)}`);
  if (!ceiling && count > maxFolderFiles) fanout(`${folder} has ${count} direct files (limit ${maxFolderFiles})`);
  else if (ceiling && count > ceiling.files)
    fanout(`${folder} grew to ${count} direct files (ceiling ${ceiling.files}; recorded reason: "${ceiling.reason}")`);
  else if (ceiling && count <= maxFolderFiles) hints.push(`remove the folder ceiling for ${folder}`);
  else if (ceiling && count < ceiling.files) hints.push(`lower the folder ceiling for ${folder} to ${count}`);
}
for (const folder of Object.keys(folderCeilings))
  if (!fs.existsSync(path.join(repo, folder))) hints.push(`remove the folder ceiling for missing ${folder}`);

for (const hint of hints) console.log(`under budget: ${hint} in scripts/complexity-budget.json`);
reportAndExit(
  failures,
  `complexity check passed (${edges.length} layer edges, ${files.length} files, ` +
    `${Object.keys(budget.fileCeilings).length} over ${budget.maxLines} lines, ` +
    `${Object.keys(folderCeilings).length} folders over ${maxFolderFiles} files)`,
);
