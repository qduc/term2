import { compareNameSets } from './header.mjs';

const RAW_SOURCE = 'provider-traffic-raw';

export function scoreOracle(oracle, actual) {
  if (!oracle || typeof oracle !== 'object') {
    return { correct: false, reason: 'missing-oracle' };
  }
  if (oracle.kind === 'exact-token') {
    const text = typeof actual.finalText === 'string' ? actual.finalText.trim() : '';
    const expected = String(oracle.token);
    const found = text === expected || new RegExp('\\b' + escapeRegExp(expected) + '\\b').test(text);
    return { correct: found, reason: found ? 'token-match' : 'token-miss', expected, actual: text.slice(0, 500) };
  }
  if (oracle.kind === 'file-json-subset') {
    const file = actual.files?.[oracle.path];
    if (typeof file !== 'string') return { correct: false, reason: 'file-missing', expected: oracle.path };
    let parsed;
    try {
      parsed = JSON.parse(file);
    } catch {
      return { correct: false, reason: 'file-not-json' };
    }
    const ok = Object.entries(oracle.subset).every(([key, value]) => parsed?.[key] === value);
    return { correct: ok, reason: ok ? 'json-subset-match' : 'json-subset-miss', expected: oracle.subset, actual: parsed };
  }
  if (oracle.kind === 'exact-lines') {
    const text = typeof actual.finalText === 'string' ? actual.finalText.trim() : '';
    const expected = String(oracle.text).trim();
    return { correct: text === expected, reason: text === expected ? 'lines-match' : 'lines-miss', expected, actual: text.slice(0, 500) };
  }
  return { correct: false, reason: 'unknown-oracle-kind' };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headerReady(header) {
  return Boolean(header?.headerFound) && (header.combinedHeaderBytes ?? 0) > 0 && (header.toolNameCount ?? 0) > 0;
}

export function scorePair({ baseline, candidate }) {
  const baselineHeader = baseline.headerSnapshot ?? {};
  const candidateHeader = candidate.headerSnapshot ?? {};
  const nameListsMatch = compareNameSets(baselineHeader.toolNames ?? [], candidateHeader.toolNames ?? []);
  const baselineRaw = baselineHeader.source === RAW_SOURCE;
  const candidateRaw = candidateHeader.source === RAW_SOURCE;
  let pairInvalidReason = null;
  if (!baselineRaw || !candidateRaw) pairInvalidReason = 'raw-header-missing';
  else if (!headerReady(baselineHeader) || !headerReady(candidateHeader)) pairInvalidReason = 'empty-or-missing-run-code-header';
  else if (!nameListsMatch) pairInvalidReason = 'registry-name-set-mismatch';
  const fairness = {
    nameListsMatch,
    staticProseMatch:
      !baselineHeader.staticProseSha256 || baselineHeader.staticProseSha256 === candidateHeader.staticProseSha256,
    pairValid: pairInvalidReason === null,
    pairInvalidReason,
    baselineHeaderPresent: headerReady(baselineHeader),
    candidateHeaderPresent: headerReady(candidateHeader),
    baselineRaw,
    candidateRaw,
  };
  const baselineOutcome = baseline.outcome?.kind ?? (baseline.correctness?.correct ? 'correct' : 'incorrect');
  const candidateOutcome = candidate.outcome?.kind ?? (candidate.correctness?.correct ? 'correct' : 'incorrect');
  return {
    fairness,
    baselineOutcome,
    candidateOutcome,
    baselineCorrect: baselineOutcome === 'correct',
    candidateCorrect: candidateOutcome === 'correct',
    infrastructure: baselineOutcome === 'infrastructure-failure' || candidateOutcome === 'infrastructure-failure',
    headerBytes: {
      baseline: baselineHeader.combinedHeaderBytes ?? null,
      candidate: candidateHeader.combinedHeaderBytes ?? null,
      surface: 'non-interactive-cli',
    },
    promptTokens: {
      baseline: baseline.metrics?.usage?.promptTokensSum ?? null,
      candidate: candidate.metrics?.usage?.promptTokensSum ?? null,
    },
    perTurnPromptTokens: {
      baseline: baseline.metrics?.usage?.perTurnPromptTokens ?? [],
      candidate: candidate.metrics?.usage?.perTurnPromptTokens ?? [],
    },
    cacheReadTokensWithinArm: {
      baseline: baseline.metrics?.usage?.cacheReadTokensSum ?? null,
      candidate: candidate.metrics?.usage?.cacheReadTokensSum ?? null,
      comparableAcrossArms: false,
      note: 'run_code description sits in the cached prefix; baseline and candidate prefixes differ by construction. Compare cache only within an arm.',
    },
  };
}

export function aggregateReport(pairs, { maxInfrastructureFailureRate = 0.1 } = {}) {
  const byModel = new Map();
  const byStratum = new Map();
  let infraPairs = 0;
  for (const pair of pairs) {
    const modelId = pair.modelId;
    if (!byModel.has(modelId)) {
      byModel.set(modelId, {
        modelId,
        pairs: 0,
        validPairs: 0,
        scoredPairs: 0,
        baselineCorrect: 0,
        candidateCorrect: 0,
        invalidFairness: 0,
        infrastructure: 0,
      });
    }
    const row = byModel.get(modelId);
    row.pairs += 1;
    const stratum = pair.stratum || 'unspecified';
    if (!byStratum.has(stratum)) {
      byStratum.set(stratum, { stratum, pairs: 0, baselineCorrect: 0, candidateCorrect: 0, infrastructure: 0 });
    }
    const stratumRow = byStratum.get(stratum);
    stratumRow.pairs += 1;
    if (pair.score?.infrastructure) {
      infraPairs += 1;
      row.infrastructure += 1;
      stratumRow.infrastructure += 1;
      continue;
    }
    if (!pair.score?.fairness?.pairValid) {
      row.invalidFairness += 1;
      continue;
    }
    row.validPairs += 1;
    row.scoredPairs += 1;
    row.baselineCorrect += pair.score.baselineCorrect ? 1 : 0;
    row.candidateCorrect += pair.score.candidateCorrect ? 1 : 0;
    stratumRow.baselineCorrect += pair.score.baselineCorrect ? 1 : 0;
    stratumRow.candidateCorrect += pair.score.candidateCorrect ? 1 : 0;
  }
  const models = [...byModel.values()];
  const scoredModels = models.filter((row) => row.scoredPairs > 0);
  const correctnessRegressions = scoredModels.filter((row) => row.candidateCorrect < row.baselineCorrect);
  const infraRate = pairs.length === 0 ? 0 : infraPairs / pairs.length;
  const infraExceeded = infraRate > maxInfrastructureFailureRate;
  return {
    models,
    strata: [...byStratum.values()],
    correctnessRegressions: correctnessRegressions.map((row) => row.modelId),
    rejectEfficiencyClaims: correctnessRegressions.length > 0,
    infrastructureFailureRate: infraRate,
    maxInfrastructureFailureRate,
    infrastructureExceeded: infraExceeded,
    stopRule:
      'A candidate that reduces task correctness on any pinned model is rejected without efficiency analysis. Infrastructure failures are excluded from correctness counts and fail the run if they exceed the stated rate. Report correctness before any cost column. Report treated-nonessential and untreated-essential strata separately.',
    primaryMetricOrder: ['taskCorrectness', 'combinedHeaderBytes', 'perTurnPromptTokens'],
    headerSurface: 'non-interactive-cli-lower-bound',
  };
}
