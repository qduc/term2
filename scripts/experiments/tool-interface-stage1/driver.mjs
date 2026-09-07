#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildSchedule } from './lib/schedule.mjs';
import { conversationEvents } from './lib/jsonl.mjs';
import { extractCellMetrics, modelMatchesPin } from './lib/extract.mjs';
import { scoreOracle, scorePair, aggregateReport } from './lib/score.mjs';
import { assertNoPromptLeaks } from './lib/leakage.mjs';
import {
  realSettingsPath,
  realConfigDir,
  writeIsolatedSettings,
  cellEnv,
  copyWorkspace,
} from './lib/isolation.mjs';
import { seedProjectAndGlobalMemory } from './lib/memory.mjs';
import { snapshotRunCodeHeader } from './snapshot-header.mjs';
import { snapshotFromRawSidecars } from './lib/traffic.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PINS = JSON.parse(fs.readFileSync(path.join(HERE, 'pins.json'), 'utf8'));
const TASKS_DIR = path.join(HERE, 'tasks');

function loadTasks() {
  return fs
    .readdirSync(TASKS_DIR)
    .filter((name) => fs.existsSync(path.join(TASKS_DIR, name, 'task.json')))
    .sort()
    .map((id) => {
      const dir = path.join(TASKS_DIR, id);
      const task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
      const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
      const oracle = JSON.parse(fs.readFileSync(path.join(dir, 'oracle.json'), 'utf8'));
      return { ...task, id: task.id ?? id, dir, prompt, oracle };
    });
}

function parseArgs(argv) {
  const args = {
    command: 'preflight',
    trials: PINS.driver.trials,
    timeoutMs: PINS.driver.timeoutMs,
    outputDir: path.join(os.homedir(), '.agents', 'runtime', 'tool-interface-stage1'),
    baselineWorktree: path.resolve(HERE, '../../..'),
    candidateWorktree: PINS.candidateWorktree,
    go: false,
    allowIdenticalCandidate: false,
    declareDescriptionTreatment: null,
    only: null,
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) {
    args.command = rest.shift();
  }
  while (rest.length) {
    const flag = rest.shift();
    const next = () => {
      const value = rest.shift();
      if (!value) throw new Error(flag + ' requires a value');
      return value;
    };
    if (flag === '--go') args.go = true;
    else if (flag === '--allow-identical-candidate') args.allowIdenticalCandidate = true;
    else if (flag === '--trials') args.trials = Number(next());
    else if (flag === '--timeout-ms') args.timeoutMs = Number(next());
    else if (flag === '--output-dir') args.outputDir = path.resolve(next());
    else if (flag === '--baseline-worktree') args.baselineWorktree = path.resolve(next());
    else if (flag === '--candidate-worktree') args.candidateWorktree = path.resolve(next());
    else if (flag === '--baseline-cli') args.baselineCli = path.resolve(next());
    else if (flag === '--candidate-cli') args.candidateCli = path.resolve(next());
    else if (flag === '--declare-description-treatment') args.declareDescriptionTreatment = path.resolve(next());
    else if (flag === '--only') args.only = next();
    else throw new Error('Unknown argument: ' + flag);
  }
  args.baselineCli = args.baselineCli ?? path.join(args.baselineWorktree, 'dist', 'cli.js');
  args.candidateCli = args.candidateCli ?? path.join(args.candidateWorktree, 'dist', 'cli.js');
  return args;
}

function gitRev(worktree) {
  const result = spawnSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git rev-parse failed in ' + worktree + ': ' + result.stderr);
  return result.stdout.trim();
}

function gitDirty(worktree) {
  const result = spawnSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' });
  return result.stdout.trim().length > 0;
}

function shaFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function spawnCommand(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function newestConversation(conversationsDir, afterMs) {
  const files = fs.readdirSync(conversationsDir).filter((name) => name.endsWith('.jsonl'));
  const ranked = files
    .map((name) => {
      const filePath = path.join(conversationsDir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .filter((entry) => entry.mtimeMs >= afterMs - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return ranked[0]?.filePath ?? null;
}

function extractFinalText(stdout) {
  const lines = stdout.split('\n').filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]);
      if (event.type === 'completed' && typeof event.finalText === 'string') return event.finalText;
      if (event.type === 'final' && typeof event.finalText === 'string') return event.finalText;
    } catch {
      /* ignore non-JSON */
    }
  }
  return stdout.trim();
}

async function maybeSnapshot(cliPath, settingsDir, label) {
  const distRoot = path.dirname(cliPath);
  try {
    const snapshot = await snapshotRunCodeHeader(distRoot, { settingsDir });
    return { ok: true, label, snapshot };
  } catch (error) {
    return { ok: false, label, error: error instanceof Error ? error.message : String(error) };
  }
}

function staticProseTreatment(baseline, candidate, declaredPath) {
  if (!baseline?.snapshot || !candidate?.snapshot) {
    return { comparable: false, unchanged: null, declared: Boolean(declaredPath) };
  }
  const unchanged = baseline.snapshot.staticProseSha256 === candidate.snapshot.staticProseSha256;
  if (unchanged) return { comparable: true, unchanged: true, declared: false };
  if (!declaredPath) {
    return {
      comparable: true,
      unchanged: false,
      declared: false,
      error: 'RUN_CODE_DESCRIPTION static prose differs between arms. Quote the full diff with --declare-description-treatment <file> or keep the candidate prose identical.',
    };
  }
  return {
    comparable: true,
    unchanged: false,
    declared: true,
    declarationSha256: shaFile(declaredPath),
    declarationPath: declaredPath,
  };
}

function providerPresence(summary) {
  const ids = new Set(summary.providerIds ?? []);
  return {
    zai: ids.has('zai'),
    DeepSeek: ids.has('DeepSeek'),
    note: 'codex is a built-in provider; zai and DeepSeek are custom and case-sensitive.',
  };
}

async function preflight(args, tasks) {
  const out = ensureDir(path.join(args.outputDir, 'preflight'));
  const baselineRev = gitRev(args.baselineWorktree);
  const candidateRev = fs.existsSync(path.join(args.candidateWorktree, '.git')) || fs.existsSync(args.candidateWorktree)
    ? gitRev(args.candidateWorktree)
    : null;
  const settingsPath = realSettingsPath();
  if (!fs.existsSync(settingsPath)) throw new Error('settings.json not found at ' + settingsPath);
  const isolatedSettingsDir = ensureDir(path.join(out, 'settings-shadow'));
  const isolatedSettings = path.join(isolatedSettingsDir, 'settings.json');
  const summary = writeIsolatedSettings({
    sourcePath: settingsPath,
    destPath: isolatedSettings,
    memoryDirectory: path.join(out, 'memory-unused'),
    pin: PINS.settingsPin,
  });
  const schedule = buildSchedule({ models: PINS.models, tasks, trials: args.trials });
  const baselineSnap = fs.existsSync(args.baselineCli)
    ? await maybeSnapshot(args.baselineCli, isolatedSettingsDir, 'baseline')
    : { ok: false, label: 'baseline', error: 'missing cli ' + args.baselineCli };
  const candidateSnap = fs.existsSync(args.candidateCli)
    ? await maybeSnapshot(args.candidateCli, isolatedSettingsDir, 'candidate')
    : { ok: false, label: 'candidate', error: 'missing cli ' + args.candidateCli };
  const leakage = [];
  for (const task of tasks) {
    try {
      assertNoPromptLeaks(task.prompt, baselineSnap.snapshot ?? { toolNames: [] });
    } catch (error) {
      leakage.push({ task: task.id, error: error.message });
    }
  }
  const treatment = staticProseTreatment(baselineSnap, candidateSnap, args.declareDescriptionTreatment);
  const identicalCandidate = candidateRev && candidateRev === baselineRev;
  const report = {
    generatedAt: new Date().toISOString(),
    pins: {
      baselineCommit: PINS.baselineCommit,
      originalBaselineCommit: PINS.originalBaselineCommit,
      previousAcceptedStage: PINS.previousAcceptedStage,
      models: PINS.models,
      settingsPin: PINS.settingsPin,
    },
    git: {
      baselineRev,
      candidateRev,
      baselineDirty: gitDirty(args.baselineWorktree),
      candidateDirty: candidateRev ? gitDirty(args.candidateWorktree) : null,
      baselineMatchesPin: baselineRev === PINS.baselineCommit,
      identicalCandidate,
    },
    clis: {
      baselineCli: args.baselineCli,
      candidateCli: args.candidateCli,
      baselineCliExists: fs.existsSync(args.baselineCli),
      candidateCliExists: fs.existsSync(args.candidateCli),
    },
    providers: providerPresence(summary),
    settingsSummary: summary,
    schedule,
    snapshots: { baseline: baselineSnap, candidate: candidateSnap },
    staticProseTreatment: treatment,
    leakage,
    estimated: {
      cells: schedule.totals.cells,
      timeoutMsPerCell: args.timeoutMs,
      serial: true,
      paid: Boolean(args.go),
      note: 'Serial paid cells. Do not launch without --go after protocol review.',
    },
    blockers: [],
  };
  if (baselineRev !== PINS.baselineCommit) {
    report.blockers.push('baseline worktree HEAD is not ' + PINS.baselineCommit);
  }
  if (!fs.existsSync(args.baselineCli)) {
    report.blockers.push('missing baseline CLI (pnpm build in the baseline worktree): ' + args.baselineCli);
  }
  if (!fs.existsSync(args.candidateCli)) {
    report.blockers.push('missing candidate CLI (pnpm build in the candidate worktree): ' + args.candidateCli);
  }
  if (!PINS.candidateCommitFinal) {
    report.blockers.push('candidateCommitFinal is null; c9a47777 was reviewed and is not final — refuse paid launch until a final hash is recorded');
  }
  if (identicalCandidate && args.go && !args.allowIdenticalCandidate) {
    report.blockers.push('candidate SHA equals baseline; refuse --go until the discovery candidate exists (or pass --allow-identical-candidate)');
  }
  if (!report.providers.zai || !report.providers.DeepSeek) {
    report.blockers.push('settings.json is missing custom providers zai and/or DeepSeek (case-sensitive)');
  }
  if (leakage.length) report.blockers.push('task prompt leakage');
  if (treatment.error) report.blockers.push(treatment.error);
  if (baselineSnap.ok && candidateSnap.ok) {
    const namesMatch =
      JSON.stringify(baselineSnap.snapshot.toolNames) === JSON.stringify(candidateSnap.snapshot.toolNames);
    report.nameListsMatch = namesMatch;
    if (!namesMatch) report.blockers.push('baseline/candidate header tool-name lists differ');
    if (baselineSnap.snapshot.toolNameCount < 8) {
      report.blockers.push('baseline header tool count looks like a stub registry');
    }
  }
  writeJson(path.join(out, 'preflight.json'), report);
  return report;
}

function gitInitWorkspace(workspace) {
  spawnSync('git', ['init'], { cwd: workspace, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'commit', '--allow-empty', '-m', 'seed'], {
    cwd: workspace,
    encoding: 'utf8',
  });
}

function prepareCell(cell, args, task) {
  const cellRoot = ensureDir(path.join(args.outputDir, 'cells', cell.cellId));
  const workspace = path.join(cellRoot, 'workspace');
  if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
  copyWorkspace(path.join(task.dir, 'workspace'), workspace);
  gitInitWorkspace(workspace);
  const isolated = cellEnv({ cellRoot, configDir: realConfigDir() });
  const settingsDir = ensureDir(path.join(isolated.paths.xdgState, 'term2-nodejs'));
  const settingsSummary = writeIsolatedSettings({
    sourcePath: realSettingsPath(),
    destPath: path.join(settingsDir, 'settings.json'),
    memoryDirectory: isolated.paths.memory,
    pin: PINS.settingsPin,
  });
  if (task.memory) {
    seedProjectAndGlobalMemory({
      memoryDirectory: isolated.paths.memory,
      workspacePath: workspace,
      projectMemories: task.memory.project,
      globalMemories: task.memory.global,
    });
  }
  return { cellRoot, workspace, isolated, settingsDir, settingsSummary };
}

async function runCell(cell, args, task, prepared) {
  const cli = cell.arm === 'baseline' ? args.baselineCli : args.candidateCli;
  const pin = cell.model;
  const started = Date.now();
  const result = await spawnCommand(
    process.execPath,
    [cli, '-p', pin.provider, '-m', pin.model, '-r', pin.reasoningEffort, '--auto-approve', '--json', '--quiet', task.prompt],
    { cwd: prepared.workspace, env: { ...process.env, ...prepared.isolated.env }, timeoutMs: args.timeoutMs },
  );
  const wallTimeMs = Date.now() - started;
  fs.writeFileSync(path.join(prepared.cellRoot, 'stdout.txt'), result.stdout);
  fs.writeFileSync(path.join(prepared.cellRoot, 'stderr.txt'), result.stderr);
  const conversationPath = newestConversation(prepared.isolated.paths.conversations, started);
  const events = conversationPath ? conversationEvents(conversationPath) : [];
  const distRoot = path.dirname(cli);
  const trafficRoot = path.join(prepared.isolated.paths.xdgState, 'term2-nodejs', 'logs', 'provider-traffic');
  const rawHeader = snapshotFromRawSidecars(trafficRoot);
  let constructionHeader = null;
  try {
    constructionHeader = await snapshotRunCodeHeader(distRoot, { settingsDir: prepared.settingsDir });
  } catch (error) {
    constructionHeader = { error: error instanceof Error ? error.message : String(error) };
  }
  const headerSnapshot = rawHeader.ok
    ? { ...rawHeader, constructionToolNameCount: constructionHeader?.toolNameCount ?? null }
    : constructionHeader;
  const metrics = extractCellMetrics({ events, wallTimeMs, headerSnapshot });
  const identityOk = modelMatchesPin(metrics.identity, pin);
  const files = {};
  if (task.oracle.kind === 'file-json-subset') {
    const filePath = path.join(prepared.workspace, task.oracle.path);
    files[task.oracle.path] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  }
  const finalText = extractFinalText(result.stdout);
  const correctness = scoreOracle(task.oracle, { finalText, files });
  const record = {
    cell,
    cli,
    exit: { code: result.code, signal: result.signal },
    conversationPath,
    identityOk,
    wrongModel: !identityOk,
    metrics,
    correctness,
    finalTextPreview: finalText.slice(0, 500),
  };
  writeJson(path.join(prepared.cellRoot, 'result.json'), record);
  if (record.wrongModel) {
    throw new Error('Wrong model for ' + cell.cellId + ': expected ' + pin.provider + '/' + pin.model + ' got ' + JSON.stringify(metrics.identity));
  }
  return record;
}

async function runPaid(args, tasks, preflightReport) {
  if (preflightReport.blockers.length) {
    throw new Error('Refusing --go; preflight blockers: ' + preflightReport.blockers.join('; '));
  }
  const records = [];
  for (const cell of preflightReport.schedule.cells) {
    if (args.only && cell.cellId !== args.only && cell.pairId !== args.only) continue;
    const task = tasks.find((entry) => entry.id === cell.task.id);
    const prepared = prepareCell(cell, args, task);
    const record = await runCell(cell, args, task, prepared);
    records.push(record);
  }
  const byPair = new Map();
  for (const record of records) {
    const pairId = record.cell.pairId;
    if (!byPair.has(pairId)) byPair.set(pairId, { pairId, modelId: record.cell.model.id, taskId: record.cell.task.id, trial: record.cell.trial });
    const pair = byPair.get(pairId);
    pair[record.cell.arm] = record;
  }
  const pairs = [...byPair.values()].map((pair) => ({
    ...pair,
    score: pair.baseline && pair.candidate ? scorePair({ baseline: pair.baseline, candidate: pair.candidate }) : null,
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    pairs,
    aggregate: aggregateReport(pairs.filter((pair) => pair.score)),
  };
  writeJson(path.join(args.outputDir, 'report.json'), report);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks();
  if (args.command === 'preflight' || args.command === 'run') {
    const report = await preflight(args, tasks);
    process.stdout.write(JSON.stringify({ command: 'preflight', blockers: report.blockers, estimated: report.estimated, git: report.git, output: path.join(args.outputDir, 'preflight', 'preflight.json') }, null, 2) + '\n');
    if (args.command === 'run' && args.go) {
      const paid = await runPaid(args, tasks, report);
      process.stdout.write(JSON.stringify({ command: 'run', rejectEfficiencyClaims: paid.aggregate.rejectEfficiencyClaims, correctnessRegressions: paid.aggregate.correctnessRegressions, output: path.join(args.outputDir, 'report.json') }, null, 2) + '\n');
    } else if (args.command === 'run' && !args.go) {
      process.stdout.write(JSON.stringify({ skippedPaid: true, reason: 'pass --go after protocol review to launch paid cells' }, null, 2) + '\n');
    }
    if (report.blockers.length && args.go) process.exitCode = 2;
    return;
  }
  throw new Error('Unknown command: ' + args.command + ' (use preflight|run)');
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  process.exitCode = 1;
});
