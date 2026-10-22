import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { oracle } from './cheap-fixtures.mjs';

const dir = path.resolve(process.argv[2]);
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const runs = summary.records.map((record) => {
  const calls = JSON.parse(fs.readFileSync(path.join(dir, `${record.id}-calls.json`), 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, `${record.id}-fixture.json`), 'utf8'));
  const dispatched = calls.filter((call) => call.dispatched);
  assert(
    dispatched.every((call) => Number.isFinite(call.usage?.total_tokens)),
    'Unknown accounting',
  );
  assert(dispatched.every((call) => JSON.stringify(call.resolvedModels) === JSON.stringify([summary.manifest.model])));
  assert(calls.every((call) => call.request.reasoning_effort === 'high'));
  const sum = (select) => dispatched.reduce((total, call) => total + (select(call.usage) ?? 0), 0);
  assert.equal(
    sum((usage) => usage.total_tokens),
    record.tokens,
  );
  const toolMessages = calls.at(-1).request.messages.filter((message) => message.role === 'tool');
  const artifact = oracle(fixture);
  assert(artifact.unrelatedPreserved, 'Policy failure on final disk');
  return {
    id: record.id,
    candidate: record.candidate,
    arm: record.arm,
    order: record.order,
    profileIdentity: record.profileIdentity,
    fixtureHash: record.fixtureHash,
    instructionHash: record.instructionHash,
    startedAt: record.startedAt,
    elapsedMs: record.elapsedMs,
    input: sum((usage) => usage.prompt_tokens),
    output: sum((usage) => usage.completion_tokens),
    total: record.tokens,
    cachedSubset: sum((usage) => usage.prompt_tokens_details?.cached_tokens),
    reasoningSubset: sum((usage) => usage.completion_tokens_details?.reasoning_tokens),
    providerCalls: dispatched.length,
    localRefusals: calls.filter((call) => !call.dispatched).length,
    observedToolResults: toolMessages.length,
    observedToolOutputBytes: toolMessages.reduce(
      (total, message) => total + Buffer.byteLength(JSON.stringify(message.content)),
      0,
    ),
    artifact,
    completion: 'capped/incomplete',
    askedBeforeEdit: record.askedBeforeEdit ?? null,
    answerSent: record.answerSent,
    instrumentError: record.instrumentError ?? null,
  };
});
const expectedRuns = summary.manifest.pairs.filter((pair) => !pair.unavailable).length * 2;
assert.equal(runs.length, expectedRuns);
assert.equal(new Set(runs.map((run) => `${run.candidate}/${run.arm}`)).size, expectedRuns);
for (const pair of summary.manifest.pairs.filter((pair) => !pair.unavailable)) {
  const paired = runs.filter((run) => run.candidate === pair.candidate);
  assert.equal(paired.length, 2);
  assert.equal(paired[0].fixtureHash, paired[1].fixtureHash);
  assert.equal(paired[0].instructionHash, paired[1].instructionHash);
}
if (summary.manifest.fixtureVersion === 1) {
  assert.equal(runs[0].id, 'e73a7a65-2066-4b0c-ad96-3edb7e9424ec');
  assert.equal(runs[0].total, 14748);
}
const openingTokens = summary.manifest.priorTokens ?? 0;
assert.equal(
  runs.reduce((total, run) => total + run.total, openingTokens),
  summary.experimentTokens,
);
const helper = JSON.parse(fs.readFileSync(path.join(dir, 'blind-review.json'), 'utf8'));
assert.equal(helper.response.model, summary.manifest.model);
assert(Number.isFinite(helper.usage.total_tokens));
const packetPath = path.join(dir, 'packet-reviews.json');
const packets = fs.existsSync(packetPath) ? JSON.parse(fs.readFileSync(packetPath, 'utf8')) : undefined;
for (const call of packets?.calls ?? []) {
  assert.equal(call.response.model, summary.manifest.model);
  assert.equal(call.request.reasoning_effort, 'high');
  assert(Number.isFinite(call.usage.total_tokens));
}
const packetTokens = packets?.calls.reduce((total, call) => total + call.usage.total_tokens, 0) ?? 0;
const result = {
  openingTokens,
  openingPaidRuns: summary.manifest.priorPaidRuns ?? 0,
  screenTokens: summary.experimentTokens - openingTokens,
  helperTokens: helper.usage.total_tokens + packetTokens,
  totalTokens: summary.experimentTokens + helper.usage.total_tokens + packetTokens,
  paidRuns: (summary.manifest.priorPaidRuns ?? 0) + runs.length + 1 + (packets?.calls.length ?? 0),
  helperVerdict: helper.response.choices[0].message.content
    ? 'inspect response'
    : 'incomplete; output allocation consumed by reasoning',
  runs,
  independentChecklists: packets?.calls.map((call) => ({
    usage: call.usage,
    checklist: call.checklist,
    error: call.error,
  })),
};
if (packets) {
  assert.equal(packets.totalTokens, result.totalTokens);
  assert.equal(packets.paidRuns, result.paidRuns);
}
assert(result.totalTokens <= 288000 && result.paidRuns <= 24);
fs.writeFileSync(path.join(dir, 'reconciled.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
