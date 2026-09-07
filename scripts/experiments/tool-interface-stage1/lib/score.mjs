import { compareNameSets } from './header.mjs';

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

export function scorePair({ baseline, candidate }) {
  const baselineHeader = baseline.headerSnapshot ?? {};
  const candidateHeader = candidate.headerSnapshot ?? {};
  const nameListsMatch = compareNameSets(baselineHeader.toolNames ?? [], candidateHeader.toolNames ?? []);
  const baselineHeaderPresent = Boolean(baselineHeader.headerFound) && (baselineHeader.combinedHeaderBytes ?? 0) > 0;
  const candidateHeaderPresent = Boolean(candidateHeader.headerFound) && (candidateHeader.combinedHeaderBytes ?? 0) > 0;
  const staticProseMatch =
    !baseline.headerSnapshot?.staticProseSha256 ||
    baseline.headerSnapshot.staticProseSha256 === candidate.headerSnapshot?.staticProseSha256;
  const fairness = {
    nameListsMatch,
    staticProseMatch,
    pairValid: nameListsMatch && baselineHeaderPresent && candidateHeaderPresent,
    pairInvalidReason: !baselineHeaderPresent || !candidateHeaderPresent
      ? 'empty-or-missing-run-code-header'
      : nameListsMatch
        ? null
        : 'registry-name-set-mismatch',
    baselineHeaderPresent,
    candidateHeaderPresent,
  };
  return {
    fairness,
    baselineCorrect: Boolean(baseline.correctness?.correct),
    candidateCorrect: Boolean(candidate.correctness?.correct),
    headerBytes: {
      baseline: baseline.headerSnapshot?.combinedHeaderBytes ?? null,
      candidate: candidate.headerSnapshot?.combinedHeaderBytes ?? null,
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

export function aggregateReport(pairs) {
  const byModel = new Map();
  for (const pair of pairs) {
    const modelId = pair.modelId;
    if (!byModel.has(modelId)) {
      byModel.set(modelId, {
        modelId,
        pairs: 0,
        validPairs: 0,
        baselineCorrect: 0,
        candidateCorrect: 0,
        invalidFairness: 0,
      });
    }
    const row = byModel.get(modelId);
    row.pairs += 1;
    if (!pair.score.fairness.pairValid) {
      row.invalidFairness += 1;
      continue;
    }
    row.validPairs += 1;
    row.baselineCorrect += pair.score.baselineCorrect ? 1 : 0;
    row.candidateCorrect += pair.score.candidateCorrect ? 1 : 0;
  }
  const models = [...byModel.values()];
  const correctnessRegressions = models.filter((row) => row.candidateCorrect < row.baselineCorrect);
  const rejectEfficiencyClaims = correctnessRegressions.length > 0;
  return {
    models,
    correctnessRegressions: correctnessRegressions.map((row) => row.modelId),
    rejectEfficiencyClaims,
    stopRule:
      'A candidate that reduces task correctness on any pinned model is rejected without efficiency analysis. Report correctness before any cost column.',
    primaryMetricOrder: ['taskCorrectness', 'combinedHeaderBytes', 'perTurnPromptTokens'],
  };
}
