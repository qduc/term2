import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HEADER_MARK, headerSnapshotFromDescription, compareNameSets, splitRunCodeDescription } from './lib/header.mjs';
import { buildSchedule } from './lib/schedule.mjs';
import { extractNestedCallMetrics, extractCellMetrics, modelMatchesPin } from './lib/extract.mjs';
import { scoreOracle, scorePair, aggregateReport } from './lib/score.mjs';
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
  const metrics = extractNestedCallMetrics('await tools.describe("grep");', '[0 tool calls: ; 1 schema lookup]');
  expect(metrics.modelVisibleSchemaLookups).toBe(1);
  expect(
    extractNestedCallMetrics('await tools.describe("grep");', '[0 tool calls: ]').modelVisibleSchemaLookups,
  ).toBeNull();
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

it('rejects a pair with empty headers or mismatched name sets', () => {
  const header = headerSnapshotFromDescription(HEADER_MARK + '\n- tools.read_file()');
  const ok = scorePair({
    baseline: { headerSnapshot: header, correctness: { correct: true } },
    candidate: { headerSnapshot: header, correctness: { correct: true } },
  });
  expect(ok.fairness.pairValid).toBe(true);
  const empty = scorePair({
    baseline: {
      headerSnapshot: { headerFound: false, combinedHeaderBytes: 0, toolNames: [] },
      correctness: { correct: true },
    },
    candidate: { headerSnapshot: header, correctness: { correct: true } },
  });
  expect(empty.fairness.pairValid).toBe(false);
  expect(empty.fairness.pairInvalidReason).toBe('empty-or-missing-run-code-header');
});

it('rejects efficiency claims when any model regresses on correctness', () => {
  const header = headerSnapshotFromDescription(HEADER_MARK + '\n- tools.read_file()');
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
  const header = headerSnapshotFromDescription(HEADER_MARK + '\n- tools.read_file()');
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
