#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scorePair, aggregateReport, failClosedAggregate } from './lib/score.mjs';
import { stdoutEvents } from './lib/jsonl.mjs';
import { extractTreatedToolPath } from './lib/extract.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sidecarEffort(cellRoot) {
  const traffic = path.join(cellRoot, 'logs', 'provider-traffic');
  if (!fs.existsSync(traffic)) return { effort: null, source: 'missing-traffic' };
  const stack = [traffic];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name);
      if (fs.statSync(filePath).isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!name.endsWith('_raw.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const effort = raw?.body?.reasoning?.effort ?? raw?.body?.reasoning_effort ?? null;
        if (typeof effort === 'string') return { effort, source: 'provider-traffic-raw', sourceFile: name };
      } catch {
        /* skip */
      }
    }
  }
  return { effort: null, source: 'raw-present-no-effort' };
}

function treatedPathFor(cellRoot) {
  const stdoutPath = path.join(cellRoot, 'stdout.txt');
  if (!fs.existsSync(stdoutPath)) return { available: false };
  const events = stdoutEvents(fs.readFileSync(stdoutPath, 'utf8'));
  return { available: true, ...extractTreatedToolPath(events) };
}

export function rescoreSavedReport(report, { cellsRoot } = {}) {
  const pairs = (report.pairs ?? []).map((pair) => {
    const score =
      pair.baseline && pair.candidate ? scorePair({ baseline: pair.baseline, candidate: pair.candidate }) : null;
    const treated = {};
    if (cellsRoot && pair.baseline?.cell?.cellId) {
      treated.baseline = treatedPathFor(path.join(cellsRoot, pair.baseline.cell.cellId));
      treated.candidate = treatedPathFor(path.join(cellsRoot, pair.candidate.cell.cellId));
    }
    const effort = {};
    if (cellsRoot && pair.baseline?.cell?.cellId) {
      effort.baseline = sidecarEffort(path.join(cellsRoot, pair.baseline.cell.cellId));
      effort.candidate = sidecarEffort(path.join(cellsRoot, pair.candidate.cell.cellId));
    }
    return { ...pair, score, treatedToolPath: treated, rawEffort: effort };
  });
  const aggregate = failClosedAggregate(aggregateReport(pairs.filter((pair) => pair.score)));
  return {
    generatedAt: new Date().toISOString(),
    rescoredFrom: report.generatedAt ?? null,
    pairs,
    aggregate,
    runInvalid: aggregate.runInvalid,
    headline: aggregate.headline,
    note: 'Offline rescore of preserved cells. Original report.json was not modified.',
  };
}

function parseArgs(argv) {
  const args = { input: null, output: null };
  const rest = [...argv];
  while (rest.length) {
    const flag = rest.shift();
    if (flag === '--in') args.input = path.resolve(rest.shift());
    else if (flag === '--out') args.output = path.resolve(rest.shift());
    else throw new Error('Unknown argument: ' + flag);
  }
  if (!args.input || !args.output) throw new Error('Usage: rescore-report.mjs --in report.json --out report.rescored.json');
  if (path.resolve(args.input) === path.resolve(args.output)) {
    throw new Error('refusing to overwrite input report');
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const report = readJson(args.input);
  const cellsRoot = path.join(path.dirname(args.input), 'cells');
  const rescored = rescoreSavedReport(report, { cellsRoot: fs.existsSync(cellsRoot) ? cellsRoot : null });
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(rescored, null, 2) + '\n');
  process.stdout.write(
    JSON.stringify({ output: args.output, runInvalid: rescored.runInvalid, headline: rescored.headline }, null, 2) +
      '\n',
  );
}
