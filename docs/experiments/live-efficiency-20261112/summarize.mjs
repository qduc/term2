/* global process, Buffer, console */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.argv[2] ?? '.handoff/live-campaign');
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'wire-live/ledger.json'), 'utf8'));
const protocol = JSON.parse(fs.readFileSync(path.join(root, 'protocol.json'), 'utf8'));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const runs = fs.readdirSync(path.join(root, 'runs')).flatMap((id) => {
  const file = path.join(root, 'runs', id, 'result.json');
  if (!fs.existsSync(file)) return [];
  const result = read(file);
  const entries = ledger.filter((e) => e.runId === id);
  const manifest = read(path.join(root, 'runs', id, 'manifest.json'));
  const artifacts = Object.fromEntries(
    Object.keys(result.files).map((name) => {
      const file = path.join('/workspace/scratch/term2-pi-workspaces', id, name);
      const actual = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
      return [name, { expected: result.files[name], actual, match: actual === result.files[name] }];
    }),
  );
  const first = entries[0];
  let firstRequest = null;
  if (first) {
    const body = read(path.join(root, 'wire-live', `${first.id}-request.json`));
    const declarations = body.tools ?? body.input?.find((i) => i.type === 'additional_tools')?.tools ?? [];
    firstRequest = {
      requestBytes: first.requestBytes,
      serializedToolsBytes: Buffer.byteLength(JSON.stringify(declarations)),
      toolNames: declarations.map((t) => t.name ?? t.function?.name),
      input: first.priced?.totalInput,
      cacheRead: first.priced?.cacheRead,
      cacheWrite: first.priced?.cacheWrite,
    };
  }
  return [
    {
      ...result,
      manifest,
      artifacts,
      accountingIdsMatch: JSON.stringify(result.requestIds) === JSON.stringify(entries.map((e) => e.id)),
      allArtifactsMatch: Object.values(artifacts).every((a) => a.match),
      firstRequest,
      totals: entries.reduce(
        (t, e) => {
          if (e.priced) {
            t.requests++;
            for (const field of ['totalInput', 'uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'usd'])
              t[field] += e.priced[field] ?? 0;
          } else t.unknownUsage++;
          return t;
        },
        {
          requests: 0,
          totalInput: 0,
          uncachedInput: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          usd: 0,
          unknownUsage: 0,
        },
      ),
    },
  ];
});
const groups = [];
for (const provider of ['openai', 'anthropic'])
  for (const arm of ['t2', 'pi']) {
    const selected = runs.filter((r) => r.provider === provider && r.arm === arm);
    groups.push({
      provider,
      arm,
      runs: selected.length,
      qualityPasses: selected.filter((r) => r.qualityPass).length,
      checksPassed: selected.reduce((n, r) => n + (r.grade?.passed ?? 0), 0),
      checksTotal: selected.reduce((n, r) => n + (r.grade?.total ?? 0), 0),
      elapsedMs: selected.reduce((n, r) => n + r.elapsedMs, 0),
      ...selected.reduce(
        (t, r) => {
          for (const key of Object.keys(t)) t[key] += r.totals[key];
          return t;
        },
        {
          requests: 0,
          totalInput: 0,
          uncachedInput: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          usd: 0,
          unknownUsage: 0,
        },
      ),
    });
  }
const metered = ledger.filter((e) => e.mode === 'live');
const summary = {
  generatedAt: new Date().toISOString(),
  plannedRuns: protocol.plannedRuns.length,
  completedRuns: runs.length,
  qualityPasses: runs.filter((r) => r.qualityPass).length,
  groups,
  runs,
  budget: {
    approvedCapUsd: 10,
    meteredComparisonUsd: metered.reduce((n, e) => n + (e.priced?.usd ?? 0), 0),
    newUnknownUsageRequests: metered.filter((e) => !e.priced).map((e) => e.id),
    priorUncapturedExposureUsd: ledger.filter((e) => e.mode !== 'live').reduce((n, e) => n + e.reservedUsd, 0),
    priorReportedPiCostUsd: ledger.filter((e) => e.mode !== 'live').reduce((n, e) => n + (e.reportedPiCostUsd ?? 0), 0),
    totalConservativeExposureUsd: ledger.reduce((n, e) => n + (e.priced?.usd ?? e.reservedUsd), 0),
    costBasis:
      'Verified published standard prices applied to captured native usage, not provider invoices; prior uncaptured preflight held separately at its conservative maximum',
  },
  allAccountingIdsMatch: runs.every((r) => r.accountingIdsMatch),
  allArtifactsMatch: runs.every((r) => r.allArtifactsMatch),
  frozenHarnessSha256: protocol.harnessSha256,
};
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      completedRuns: summary.completedRuns,
      qualityPasses: summary.qualityPasses,
      groups,
      budget: summary.budget,
      allAccountingIdsMatch: summary.allAccountingIdsMatch,
      allArtifactsMatch: summary.allArtifactsMatch,
    },
    null,
    2,
  ),
);
