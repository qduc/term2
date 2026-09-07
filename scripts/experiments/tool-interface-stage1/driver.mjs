#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildSchedule } from './lib/schedule.mjs';
import { conversationEvents, stdoutEvents } from './lib/jsonl.mjs';
import { extractCellMetrics, matchIdentity } from './lib/extract.mjs';
import { scoreOracle, scorePair, aggregateReport } from './lib/score.mjs';
import { assertNoPromptLeaks } from './lib/leakage.mjs';
import {
  realSettingsPath,
  realConfigDir,
  writeIsolatedSettings,
  cellEnv,
  copyWorkspace,
  createEphemeralAuthState,
  destroyEphemeralAuthState,
  harvestLogs,
} from './lib/isolation.mjs';
import { seedProjectAndGlobalMemory } from './lib/memory.mjs';
import { snapshotRunCodeHeader } from './snapshot-header.mjs';
import { snapshotFromRawSidecars } from './lib/traffic.mjs';
import { gitRev, gitDirty, sourceTreeMatchesPin } from './lib/git-pin.mjs';
import { classifyCellOutcome, paidReportMode } from './lib/cell-outcome.mjs';
import { collectPreflightBlockers } from './lib/gates.mjs';

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
    })
    .filter((task) => task.includeInPrimarySchedule !== false);
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
    declareDescriptionTreatment: null,
    only: null,
    resume: false,
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) args.command = rest.shift();
  while (rest.length) {
    const flag = rest.shift();
    const next = () => {
      const value = rest.shift();
      if (!value) throw new Error(flag + ' requires a value');
      return value;
    };
    if (flag === '--go') args.go = true;
    else if (flag === '--resume') args.resume = true;
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
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function newestConversation(conversationsDir, afterMs) {
  if (!conversationsDir || !fs.existsSync(conversationsDir)) return null;
  const files = fs.readdirSync(conversationsDir).filter((name) => name.endsWith('.jsonl') && !name.includes('index'));
  const ranked = files
    .map((name) => {
      const filePath = path.join(conversationsDir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .filter((entry) => entry.mtimeMs >= afterMs - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return ranked[0]?.filePath ?? null;
}

function discoverConversationPath(isolated, afterMs) {
  const dirs = [
    isolated.paths.conversations,
    path.join(isolated.paths.xdgData, 'term2', 'conversations'),
    path.join(isolated.paths.logs, 'conversations'),
  ];
  for (const dir of dirs) {
    const found = newestConversation(dir, afterMs);
    if (found) return found;
  }
  return null;
}

function extractFinalText(stdout) {
  const lines = stdout.split('\n').filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]);
      if (event.type === 'completed' && typeof event.finalText === 'string') return event.finalText;
      if (event.type === 'final' && typeof event.finalText === 'string') return event.finalText;
    } catch {
      /* ignore */
    }
  }
  return stdout.trim();
}

async function maybeSnapshot(cliPath, settingsDir, label, modelPin) {
  if (!fs.existsSync(cliPath)) return { ok: false, label, error: 'missing cli ' + cliPath };
  try {
    const snapshot = await snapshotRunCodeHeader(path.dirname(cliPath), {
      settingsDir,
      model: modelPin?.model,
      providerId: modelPin?.provider,
    });
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
      error:
        'RUN_CODE_DESCRIPTION static prose differs between arms. Quote the full diff with --declare-description-treatment.',
    };
  }
  return { comparable: true, unchanged: false, declared: true, declarationSha256: shaFile(declaredPath) };
}

function providerPresence(summary) {
  const ids = new Set(summary.providerIds ?? []);
  return { zai: ids.has('zai'), DeepSeek: ids.has('DeepSeek') };
}

function gitInitWorkspace(workspace) {
  spawnSync('git', ['init'], { cwd: workspace, encoding: 'utf8' });
}

async function preflight(args, tasks) {
  const out = ensureDir(path.join(args.outputDir, 'preflight'));
  const baselineRev = gitRev(args.baselineWorktree);
  const candidateRev = gitRev(args.candidateWorktree);
  const sourceMatch = sourceTreeMatchesPin(args.baselineWorktree, PINS.baselineCommit);
  const settingsPath = realSettingsPath();
  if (!fs.existsSync(settingsPath)) throw new Error('settings.json not found at ' + settingsPath);
  const ephemeral = createEphemeralAuthState();
  let summary;
  const snapshotsByModel = {};
  try {
    const settingsDir = ensureDir(path.join(ephemeral, 'term2-nodejs'));
    summary = writeIsolatedSettings({
      sourcePath: settingsPath,
      destPath: path.join(settingsDir, 'settings.json'),
      memoryDirectory: path.join(ephemeral, 'memory-unused'),
      pin: PINS.settingsPin,
    });
    for (const modelPin of PINS.models) {
      snapshotsByModel[modelPin.id] = {
        baseline: await maybeSnapshot(args.baselineCli, settingsDir, 'baseline-' + modelPin.id, modelPin),
        candidate: await maybeSnapshot(args.candidateCli, settingsDir, 'candidate-' + modelPin.id, modelPin),
      };
    }
  } finally {
    destroyEphemeralAuthState(ephemeral);
  }
  const representativeId = PINS.models.find((model) => model.id === 'glm')?.id ?? PINS.models[0].id;
  const baselineSnap = snapshotsByModel[representativeId]?.baseline;
  const candidateSnap = snapshotsByModel[representativeId]?.candidate;
  const leakage = [];
  const leakNames = {
    toolNames: [
      ...new Set(
        Object.values(snapshotsByModel).flatMap((pair) => [
          ...(pair.baseline?.snapshot?.toolNames ?? []),
          ...(pair.candidate?.snapshot?.toolNames ?? []),
        ]),
      ),
    ],
  };
  for (const task of tasks) {
    try {
      assertNoPromptLeaks(task.prompt, leakNames);
    } catch (error) {
      leakage.push({ task: task.id, error: error.message });
    }
  }
  const treatment = staticProseTreatment(baselineSnap, candidateSnap, args.declareDescriptionTreatment);
  const schedule = buildSchedule({ models: PINS.models, tasks, trials: args.trials });
  const providers = providerPresence(summary);
  const candidateDirty = gitDirty(args.candidateWorktree);
  const blockers = collectPreflightBlockers({
    sourceMatch,
    baselineCliExists: fs.existsSync(args.baselineCli),
    candidateCliExists: fs.existsSync(args.candidateCli),
    candidateRev,
    candidateDirty,
    candidateCommitFinal: PINS.candidateCommitFinal,
    pendingFinalReview: PINS.pendingFinalReview !== false,
    providers,
    leakage,
    treatment,
    baselineSnap,
    candidateSnap,
    snapshotsByModel,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    pins: {
      baselineCommit: PINS.baselineCommit,
      candidateCommitFinal: PINS.candidateCommitFinal,
      pendingFinalReview: PINS.pendingFinalReview !== false,
      models: PINS.models,
    },
    git: {
      baselineRev,
      candidateRev,
      baselineDirty: gitDirty(args.baselineWorktree),
      candidateDirty,
      sourceMatchesPin: sourceMatch,
      identicalCandidate: candidateRev === baselineRev,
    },
    clis: {
      baselineCli: args.baselineCli,
      candidateCli: args.candidateCli,
      baselineCliExists: fs.existsSync(args.baselineCli),
      candidateCliExists: fs.existsSync(args.candidateCli),
    },
    providers,
    settingsSummary: summary,
    schedule,
    snapshots: { baseline: baselineSnap, candidate: candidateSnap, byModel: snapshotsByModel },
    constructionHeaders: Object.fromEntries(
      Object.entries(snapshotsByModel).map(([id, pair]) => [
        id,
        {
          baselineBytes: pair.baseline?.snapshot?.combinedHeaderBytes ?? null,
          candidateBytes: pair.candidate?.snapshot?.combinedHeaderBytes ?? null,
          deltaBytes:
            pair.baseline?.ok && pair.candidate?.ok
              ? pair.candidate.snapshot.combinedHeaderBytes - pair.baseline.snapshot.combinedHeaderBytes
              : null,
          baselineCount: pair.baseline?.snapshot?.toolNameCount ?? null,
          candidateCount: pair.candidate?.snapshot?.toolNameCount ?? null,
          nameMatch:
            pair.baseline?.ok && pair.candidate?.ok
              ? [...(pair.baseline.snapshot.toolNames ?? [])].sort().join(',') ===
                [...(pair.candidate.snapshot.toolNames ?? [])].sort().join(',')
              : null,
          staticProseMatch:
            pair.baseline?.ok && pair.candidate?.ok
              ? pair.baseline.snapshot.staticProseSha256 === pair.candidate.snapshot.staticProseSha256
              : null,
        },
      ]),
    ),
    staticProseTreatment: treatment,
    leakage,
    headerSurface: 'non-interactive-cli-lower-bound',
    f3Note:
      'Interactive-max replica measurements (e.g. +8471 B) are not acceptance evidence. Bound production snapshots own the reproducible non-interactive figure; interactive session tools are absent here.',
    estimated: {
      cells: schedule.totals.cells,
      timeoutMsPerCell: args.timeoutMs,
      serial: true,
      paid: Boolean(args.go),
      strata: Object.fromEntries(
        tasks.reduce((map, task) => {
          const key = task.stratum || 'unspecified';
          map.set(key, (map.get(key) || 0) + 1);
          return map;
        }, new Map()),
      ),
    },
    blockers,
  };
  writeJson(path.join(out, 'preflight.json'), report);
  return report;
}

function prepareCell(cell, args, task) {
  const cellRoot = ensureDir(path.join(args.outputDir, 'cells', cell.cellId));
  const workspace = path.join(cellRoot, 'workspace');
  if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
  copyWorkspace(path.join(task.dir, 'workspace'), workspace);
  gitInitWorkspace(workspace);
  const ephemeralState = createEphemeralAuthState();
  const isolated = cellEnv({ cellRoot, configDir: realConfigDir(), ephemeralState });
  const settingsDir = ensureDir(path.join(ephemeralState, 'term2-nodejs'));
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
  return { cellRoot, workspace, isolated, settingsDir, settingsSummary, ephemeralState };
}

async function runCell(cell, args, task, prepared) {
  const cli = cell.arm === 'baseline' ? args.baselineCli : args.candidateCli;
  const pin = cell.model;
  const started = Date.now();
  let result;
  try {
    result = await spawnCommand(
      process.execPath,
      [cli, '-p', pin.provider, '-m', pin.model, '-r', pin.reasoningEffort, '--auto-approve', '--json', '--quiet', task.prompt],
      { cwd: prepared.workspace, env: { ...process.env, ...prepared.isolated.env }, timeoutMs: args.timeoutMs },
    );
  } finally {
    harvestLogs(prepared.ephemeralState, prepared.isolated.paths.logs);
    destroyEphemeralAuthState(prepared.ephemeralState);
  }
  const wallTimeMs = Date.now() - started;
  fs.writeFileSync(path.join(prepared.cellRoot, 'stdout.txt'), result.stdout);
  fs.writeFileSync(path.join(prepared.cellRoot, 'stderr.txt'), result.stderr);
  const conversationPath = discoverConversationPath(prepared.isolated, started);
  const fileEvents = conversationPath ? conversationEvents(conversationPath) : [];
  const liveEvents = stdoutEvents(result.stdout);
  const events = fileEvents.length ? fileEvents : liveEvents;
  const trafficRoot = path.join(prepared.isolated.paths.logs, 'provider-traffic');
  const rawHeader = snapshotFromRawSidecars(trafficRoot);
  const headerSnapshot = rawHeader.ok
    ? rawHeader
    : { ...rawHeader, source: rawHeader.source || 'missing-raw', headerFound: false, combinedHeaderBytes: 0, toolNames: [] };
  const metrics = extractCellMetrics({ events, wallTimeMs, headerSnapshot });
  const identityMatch = matchIdentity(metrics.identity, pin);
  const identityOk = identityMatch.ok;
  const files = {};
  if (task.oracle.kind === 'file-json-subset') {
    const filePath = path.join(prepared.workspace, task.oracle.path);
    files[task.oracle.path] = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  }
  const finalText = extractFinalText(result.stdout);
  const correctness = scoreOracle(task.oracle, { finalText, files });
  const outcome = classifyCellOutcome({
    exit: { code: result.code, signal: result.signal },
    identityMatch,
    identityOk,
    conversationPath,
    stdout: result.stdout,
    stdoutEventCount: liveEvents.length,
    correctness,
  });
  const record = {
    cell,
    cli,
    exit: { code: result.code, signal: result.signal },
    conversationPath,
    eventSource: fileEvents.length ? 'conversation-jsonl' : 'stdout-json',
    identityOk,
    identityMatch,
    wrongModel: identityMatch.reason === 'wrong-model',
    outcome,
    metrics,
    correctness,
    finalTextPreview: finalText.slice(0, 500),
  };
  writeJson(path.join(prepared.cellRoot, 'result.json'), record);
  return record;
}

function writePartialReport(args, records, extra = {}) {
  const byPair = new Map();
  for (const record of records) {
    const pairId = record.cell.pairId;
    if (!byPair.has(pairId)) {
      byPair.set(pairId, {
        pairId,
        modelId: record.cell.model.id,
        taskId: record.cell.task.id,
        trial: record.cell.trial,
        stratum: record.cell.task.stratum || 'unspecified',
      });
    }
    byPair.get(pairId)[record.cell.arm] = record;
  }
  const pairs = [...byPair.values()].map((pair) => ({
    ...pair,
    score: pair.baseline && pair.candidate ? scorePair({ baseline: pair.baseline, candidate: pair.candidate }) : null,
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    pairs,
    aggregate: aggregateReport(pairs.filter((pair) => pair.score)),
    ...extra,
  };
  writeJson(path.join(args.outputDir, 'report.json'), report);
  return report;
}

async function runPaid(args, tasks, preflightReport) {
  if (preflightReport.blockers.length) {
    throw new Error('Refusing --go; preflight blockers: ' + preflightReport.blockers.join('; '));
  }
  const records = [];
  let aborted = null;
  for (const cell of preflightReport.schedule.cells) {
    if (args.only && cell.cellId !== args.only && cell.pairId !== args.only) continue;
    const resultPath = path.join(args.outputDir, 'cells', cell.cellId, 'result.json');
    if (args.resume && fs.existsSync(resultPath)) {
      records.push(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
      continue;
    }
    const task = tasks.find((entry) => entry.id === cell.task.id);
    const prepared = prepareCell(cell, args, task);
    const record = await runCell(cell, args, task, prepared);
    records.push(record);
    if (record.wrongModel) {
      aborted = { reason: 'wrong-model', cellId: cell.cellId, identity: record.metrics.identity };
      break;
    }
    if (record.outcome?.reason === 'identity-missing') {
      aborted = { reason: 'identity-missing', cellId: cell.cellId, identity: record.metrics.identity };
      break;
    }
  }
  const mode = paidReportMode({ only: args.only, records, aborted });
  if (mode.kind === 'incomplete-cell-only') {
    writeJson(path.join(args.outputDir, 'report.json'), {
      generatedAt: new Date().toISOString(),
      note: '--only with a single cellId does not score a pair; pass pairId to rerun both arms, or --resume after both exist.',
      records,
    });
    return { aggregate: { rejectEfficiencyClaims: false, correctnessRegressions: [] }, aborted: null, incompleteOnly: true };
  }
  const extra =
    mode.kind === 'invalid-abort'
      ? { aborted: mode.aborted, runInvalid: true, invalidReason: mode.aborted.reason, headline: mode.headline }
      : {};
  return writePartialReport(args, records, extra);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks();
  if (args.command === 'preflight' || args.command === 'run') {
    const report = await preflight(args, tasks);
    process.stdout.write(
      JSON.stringify(
        {
          command: 'preflight',
          blockers: report.blockers,
          estimated: report.estimated,
          git: report.git,
          headerBytes: report.snapshots?.baseline?.snapshot?.combinedHeaderBytes ?? null,
          constructionHeaders: report.constructionHeaders,
          output: path.join(args.outputDir, 'preflight', 'preflight.json'),
        },
        null,
        2,
      ) + '\n',
    );
    if (args.command === 'run' && args.go) {
      const paid = await runPaid(args, tasks, report);
      process.stdout.write(
        JSON.stringify(
          {
            command: 'run',
            runInvalid: paid.runInvalid === true,
            headline: paid.headline ?? null,
            rejectEfficiencyClaims: paid.runInvalid ? true : paid.aggregate?.rejectEfficiencyClaims,
            correctnessRegressions: paid.aggregate?.correctnessRegressions,
            aborted: paid.aborted ?? null,
            output: path.join(args.outputDir, 'report.json'),
          },
          null,
          2,
        ) + '\n',
      );
    } else if (args.command === 'run' && !args.go) {
      process.stdout.write(JSON.stringify({ skippedPaid: true, reason: 'pass --go after final candidate review' }, null, 2) + '\n');
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
