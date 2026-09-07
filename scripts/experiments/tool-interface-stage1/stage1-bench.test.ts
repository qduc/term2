import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HEADER_MARK, headerSnapshotFromDescription, compareNameSets, splitRunCodeDescription } from './lib/header.mjs';
import { buildSchedule } from './lib/schedule.mjs';
import { extractNestedCallMetrics, extractCellMetrics, modelMatchesPin } from './lib/extract.mjs';
import { scoreOracle, scorePair, aggregateReport } from './lib/score.mjs';
import { classifyCellOutcome } from './lib/cell-outcome.mjs';
import { collectPreflightBlockers } from './lib/gates.mjs';
import { snapshotRunCodeHeader } from './snapshot-header.mjs';
import { findPromptLeaks, assertNoPromptLeaks } from './lib/leakage.mjs';
import { snapshotFromRawSidecars, extractRunCodeDescriptionFromRawBody, isNamesOnlyTools } from './lib/traffic.mjs';

const temporaryDirectories = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeTemp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-stage1-'));
  temporaryDirectories.push(dir);
  return dir;
};

const MODELS = [
  { id: 'luna', provider: 'codex', model: 'gpt-5.6-luna' },
  { id: 'glm', provider: 'zai', model: 'glm-5.3-flash' },
  { id: 'deepseek', provider: 'DeepSeek', model: 'deepseek-v4-flash' },
];
const TASKS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

it('balances arm-first order across pairs', () => {
  const schedule = buildSchedule({ models: MODELS, tasks: TASKS, trials: 3 });
  expect(schedule.totals.cells).toBe(72);
  expect(schedule.armFirstCounts.baseline).toBe(schedule.armFirstCounts.candidate);
  expect(schedule.pairs[0].arms[0]).toBe('baseline');
  expect(schedule.pairs[1].arms[0]).toBe('candidate');
});

it('splits static run_code prose from the header region', () => {
  const description =
    'Write a program.\n\n' +
    HEADER_MARK +
    ' (shapes are approximate):\n- tools.read_file({ path: string })\n- tools.grep({ pattern: string })';
  const split = splitRunCodeDescription(description);
  expect(split.headerFound).toBe(true);
  expect(split.staticProse).toContain('Write a program');
  expect(split.header.startsWith(HEADER_MARK)).toBe(true);
  const snapshot = headerSnapshotFromDescription(description);
  expect(snapshot.toolNames).toEqual(['read_file', 'grep']);
  expect(snapshot.combinedHeaderBytes).toBeGreaterThan(0);
});

it('compares tool-name sets not order', () => {
  expect(compareNameSets(['b', 'a'], ['a', 'b'])).toBe(true);
  expect(compareNameSets(['a'], ['a', 'b'])).toBe(false);
});

it('counts describe lookups separately from invalid params and recorded calls', () => {
  const script =
    'await tools.describe("grep");\nawait tools.grep({ search: 1 });\nawait tools.read_file({ path: "x" });';
  const result =
    'Invalid parameters for "grep": (root): bad\nSignature: tools.grep({ pattern: string })\n\n[1 tool calls: grep]';
  const metrics = extractNestedCallMetrics(script, result);
  expect(metrics.describeLookups).toBe(1);
  expect(metrics.invalidParamsAttempted).toBe(1);
  expect(metrics.recordedNestedCalls).toBe(1);
  expect(metrics.admittedNestedCallsKnown).toBe(false);
});

it('parses model-visible schema lookup telemetry from candidate summaries', () => {
  const onlyLookups = extractNestedCallMetrics('await tools.describe("grep");', '[no tool calls; 1 schema lookup]');
  expect(onlyLookups.modelVisibleSchemaLookups).toBe(1);
  expect(onlyLookups.recordedNestedCalls).toBe(0);
  const mixed = extractNestedCallMetrics(
    'await tools.describe("inspect");',
    '[1 tool call: inspect; 2 schema lookups]',
  );
  expect(mixed.modelVisibleSchemaLookups).toBe(2);
  expect(mixed.recordedNestedCalls).toBe(1);
  expect(extractNestedCallMetrics('', '[no tool calls]').modelVisibleSchemaLookups).toBeNull();
});

it('reads model identity from session_init artifacts not argv', () => {
  const events = [
    { type: 'session_init', id: 's1', provider: 'DeepSeek', model: 'deepseek-v4-flash', reasoningEffort: 'medium' },
  ];
  const metrics = extractCellMetrics({ events, wallTimeMs: 10 });
  expect(
    modelMatchesPin(metrics.identity, { provider: 'DeepSeek', model: 'deepseek-v4-flash', reasoningEffort: 'medium' }),
  ).toBe(true);
  expect(
    modelMatchesPin(metrics.identity, { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'medium' }),
  ).toBe(false);
});

const rawHeader = (description) => ({
  ...headerSnapshotFromDescription(description),
  source: 'provider-traffic-raw',
});

it('rejects a pair with empty headers or mismatched name sets', () => {
  const header = rawHeader(HEADER_MARK + '\n- tools.read_file()');
  const ok = scorePair({
    baseline: { headerSnapshot: header, correctness: { correct: true } },
    candidate: { headerSnapshot: header, correctness: { correct: true } },
  });
  expect(ok.fairness.pairValid).toBe(true);
  const empty = scorePair({
    baseline: {
      headerSnapshot: { ...header, headerFound: false, combinedHeaderBytes: 0, toolNames: [], toolNameCount: 0 },
      correctness: { correct: true },
    },
    candidate: { headerSnapshot: header, correctness: { correct: true } },
  });
  expect(empty.fairness.pairValid).toBe(false);
  expect(empty.fairness.pairInvalidReason).toBe('empty-or-missing-run-code-header');
});

it('does not accept a well-formed construction header as a raw substitute', () => {
  const construction = {
    ...headerSnapshotFromDescription(HEADER_MARK + '\n- tools.read_file()\n- tools.grep()'),
    source: 'non-interactive-factory-bind',
    mode: 'non-interactive-factory-bind',
  };
  const scored = scorePair({
    baseline: { headerSnapshot: construction, correctness: { correct: true } },
    candidate: { headerSnapshot: construction, correctness: { correct: true } },
  });
  expect(scored.fairness.pairValid).toBe(false);
  expect(scored.fairness.pairInvalidReason).toBe('raw-header-missing');
});

it('rejects efficiency claims when any model regresses on correctness', () => {
  const header = rawHeader(HEADER_MARK + '\n- tools.read_file()');
  const pair = (modelId, baselineCorrect, candidateCorrect) => ({
    modelId,
    score: scorePair({
      baseline: { headerSnapshot: header, correctness: { correct: baselineCorrect } },
      candidate: { headerSnapshot: header, correctness: { correct: candidateCorrect } },
    }),
  });
  const report = aggregateReport([pair('luna', true, true), pair('glm', true, false), pair('deepseek', true, true)]);
  expect(report.correctnessRegressions).toEqual(['glm']);
  expect(report.rejectEfficiencyClaims).toBe(true);
  expect(report.primaryMetricOrder[0]).toBe('taskCorrectness');
});

it('scores file-json and token oracles', () => {
  expect(scoreOracle({ kind: 'exact-token', token: 'ora-keel-19' }, { finalText: 'ora-keel-19' }).correct).toBe(true);
  expect(
    scoreOracle(
      { kind: 'file-json-subset', path: 'config/gateway.json', subset: { listenPort: 9417 } },
      { files: { 'config/gateway.json': JSON.stringify({ listenPort: 9417, name: 'gateway' }) } },
    ).correct,
  ).toBe(true);
});

it('fails task prompts that leak tool signatures', () => {
  expect(findPromptLeaks('Use tools.grep to search', { toolNames: ['grep'] }).length).toBeGreaterThan(0);
  expect(() => assertNoPromptLeaks('Find the Northwind channel.', { toolNames: ['grep'] })).not.toThrow();
});

it('extracts run_code header from raw sidecars and rejects names-only sanitized envelopes', () => {
  const description =
    'Write a program.\n\n' +
    HEADER_MARK +
    ':\n- tools.read_file({ path: string })\n- tools.memory_retrieve({ query: string })';
  expect(isNamesOnlyTools(['run_code', 'shell'])).toBe(true);
  expect(extractRunCodeDescriptionFromRawBody({ tools: ['run_code'] })).toBeNull();
  const extracted = extractRunCodeDescriptionFromRawBody({
    tools: [{ type: 'function', function: { name: 'run_code', description } }],
  });
  expect(extracted).toContain(HEADER_MARK);
  const root = makeTemp();
  const sessionDir = path.join(root, '2026-09-07', 'sess');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'req-1.json'), JSON.stringify({ sent: { body: { tools: ['run_code'] } } }));
  fs.writeFileSync(
    path.join(sessionDir, 'req-1_raw.json'),
    JSON.stringify({ body: { tools: [{ type: 'function', function: { name: 'run_code', description } }] } }),
  );
  const snapshot = snapshotFromRawSidecars(root);
  expect(snapshot.ok).toBe(true);
  expect(snapshot.combinedHeaderBytes).toBeGreaterThan(0);
  expect(snapshot.toolNames).toEqual(['read_file', 'memory_retrieve']);
});

it('marks cache incomparable across arms', () => {
  const header = rawHeader(HEADER_MARK + '\n- tools.read_file()');
  const scored = scorePair({
    baseline: {
      headerSnapshot: header,
      metrics: { usage: { cacheReadTokensSum: 100, promptTokensSum: 1000, perTurnPromptTokens: [1000] } },
      correctness: { correct: true },
    },
    candidate: {
      headerSnapshot: header,
      metrics: { usage: { cacheReadTokensSum: 400, promptTokensSum: 1400, perTurnPromptTokens: [1400] } },
      correctness: { correct: true },
    },
  });
  expect(scored.cacheReadTokensWithinArm.comparableAcrossArms).toBe(false);
});

it('classifies timeout and missing conversation as infrastructure, not incorrect', () => {
  expect(
    classifyCellOutcome({
      exit: { code: null, signal: 'SIGKILL' },
      identityOk: true,
      conversationPath: '/tmp/x.jsonl',
      stdout: '',
      correctness: { correct: false, reason: 'token-miss' },
    }).kind,
  ).toBe('infrastructure-failure');
  expect(
    classifyCellOutcome({
      exit: { code: 0, signal: null },
      identityOk: true,
      conversationPath: null,
      stdout: '',
      correctness: { correct: false },
    }).kind,
  ).toBe('infrastructure-failure');
  expect(
    classifyCellOutcome({
      exit: { code: 0, signal: null },
      identityOk: true,
      conversationPath: '/tmp/x.jsonl',
      stdout: '{"type":"completed","finalText":"nope"}',
      correctness: { correct: false, reason: 'token-miss' },
    }).kind,
  ).toBe('incorrect');
});

it('excludes infrastructure pairs from correctness and fails the infra rate', () => {
  const header = rawHeader(HEADER_MARK + '\n- tools.read_file()');
  const scored = scorePair({
    baseline: { headerSnapshot: header, correctness: { correct: true }, outcome: { kind: 'correct' } },
    candidate: {
      headerSnapshot: header,
      correctness: { correct: false },
      outcome: { kind: 'infrastructure-failure', reason: 'timeout-sigkill' },
    },
  });
  const report = aggregateReport([{ modelId: 'glm', stratum: 'untreated-essential', score: scored }], {
    maxInfrastructureFailureRate: 0.1,
  });
  expect(report.models[0].scoredPairs).toBe(0);
  expect(report.infrastructureExceeded).toBe(true);
  expect(report.correctnessRegressions).toEqual([]);
});

it('blocks paid launch while protocol review is pending even with a pinned candidate hash', () => {
  const header = {
    headerFound: true,
    toolNameCount: 20,
    toolNames: ['read_file', 'grep'],
    combinedHeaderBytes: 2000,
  };
  const blockers = collectPreflightBlockers({
    sourceMatch: { matches: true },
    baselineCliExists: true,
    candidateCliExists: true,
    candidateRev: '80f7488401c1043445cf3974f163633693c8c20f',
    candidateDirty: false,
    candidateCommitFinal: '80f7488401c1043445cf3974f163633693c8c20f',
    pendingFinalReview: true,
    providers: { zai: true, DeepSeek: true },
    leakage: [],
    treatment: { unchanged: true },
    baselineSnap: { ok: true, snapshot: header },
    candidateSnap: { ok: true, snapshot: header },
  });
  expect(blockers.some((line) => /protocol review pending/.test(line))).toBe(true);
});

it('blocks per-model name-set mismatches even when a representative pair matches', () => {
  const ok = {
    headerFound: true,
    toolNameCount: 20,
    toolNames: ['read_file', 'grep'],
    combinedHeaderBytes: 2000,
  };
  const blockers = collectPreflightBlockers({
    sourceMatch: { matches: true },
    baselineCliExists: true,
    candidateCliExists: true,
    candidateRev: '80f7488401c1043445cf3974f163633693c8c20f',
    candidateDirty: false,
    candidateCommitFinal: '80f7488401c1043445cf3974f163633693c8c20f',
    pendingFinalReview: false,
    providers: { zai: true, DeepSeek: true },
    leakage: [],
    treatment: {},
    baselineSnap: { ok: true, snapshot: ok },
    candidateSnap: { ok: true, snapshot: ok },
    snapshotsByModel: {
      glm: { baseline: { ok: true, snapshot: ok }, candidate: { ok: true, snapshot: ok } },
      luna: {
        baseline: { ok: true, snapshot: { ...ok, toolNames: ['read_file', 'apply_patch'], toolNameCount: 2 } },
        candidate: { ok: true, snapshot: { ...ok, toolNames: ['read_file', 'grep'], toolNameCount: 2 } },
      },
    },
  });
  expect(blockers.some((line) => /luna .*name sets differ/.test(line))).toBe(true);
});

it('blocks empty factory-bound headers and mismatched name sets', () => {
  const empty = collectPreflightBlockers({
    sourceMatch: { matches: true },
    baselineCliExists: true,
    candidateCliExists: true,
    candidateRev: '80f7488401c1043445cf3974f163633693c8c20f',
    candidateDirty: false,
    candidateCommitFinal: '80f7488401c1043445cf3974f163633693c8c20f',
    pendingFinalReview: false,
    providers: { zai: true, DeepSeek: true },
    leakage: [],
    treatment: {},
    baselineSnap: { ok: true, snapshot: { headerFound: false, toolNameCount: 0, toolNames: [] } },
    candidateSnap: { ok: true, snapshot: { headerFound: true, toolNameCount: 20, toolNames: ['read_file'] } },
  });
  expect(empty.some((line) => /empty or stub-sized/.test(line))).toBe(true);
  const mismatch = collectPreflightBlockers({
    sourceMatch: { matches: true },
    baselineCliExists: true,
    candidateCliExists: true,
    candidateRev: '80f7488401c1043445cf3974f163633693c8c20f',
    candidateDirty: false,
    candidateCommitFinal: '80f7488401c1043445cf3974f163633693c8c20f',
    pendingFinalReview: false,
    providers: { zai: true, DeepSeek: true },
    leakage: [],
    treatment: {},
    baselineSnap: {
      ok: true,
      snapshot: { headerFound: true, toolNameCount: 2, toolNames: ['read_file', 'grep'] },
    },
    candidateSnap: {
      ok: true,
      snapshot: { headerFound: true, toolNameCount: 2, toolNames: ['read_file', 'glob'] },
    },
  });
  expect(mismatch.some((line) => /name sets differ/.test(line))).toBe(true);
});

it('snapshots a factory-bound non-interactive header with at least 8 tools', async () => {
  const dist = path.resolve('dist');
  if (!fs.existsSync(path.join(dist, 'cli.js'))) return;
  const snap = await snapshotRunCodeHeader(dist, { model: 'glm-5.3-flash', providerId: 'zai' });
  expect(snap.headerFound).toBe(true);
  expect(snap.toolNameCount).toBeGreaterThanOrEqual(8);
  expect(snap.combinedHeaderBytes).toBeGreaterThan(0);
  expect(snap.interactiveMinusNonInteractive).toEqual(['session_list', 'session_search', 'session_read']);
  expect(snap.mode).toBe('non-interactive-factory-bind');
});
