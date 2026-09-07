export function collectPreflightBlockers({
  sourceMatch,
  baselineCliExists,
  candidateCliExists,
  candidateRev,
  candidateDirty,
  candidateCommitFinal,
  pendingFinalReview,
  providers,
  leakage,
  treatment,
  baselineSnap,
  candidateSnap,
  snapshotsByModel,
}) {
  const blockers = [];
  if (!sourceMatch?.matches) {
    blockers.push('baseline source/ is not equivalent to the pinned baseline commit (HEAD identity is ignored)');
  }
  if (!baselineCliExists) blockers.push('missing baseline CLI (pnpm build)');
  if (!candidateCliExists) blockers.push('missing candidate CLI (pnpm build)');
  if (!candidateCommitFinal) {
    blockers.push('candidateCommitFinal is unset — refuse paid launch');
  } else if (candidateRev !== candidateCommitFinal) {
    blockers.push('candidate HEAD ' + candidateRev + ' !== pinned final ' + candidateCommitFinal);
  }
  if (pendingFinalReview) {
    blockers.push('protocol review pending — refuse paid launch');
  }
  if (candidateDirty) blockers.push('candidate worktree is dirty');
  if (!providers?.zai || !providers?.DeepSeek) blockers.push('missing custom providers zai and/or DeepSeek');
  if (leakage?.length) blockers.push('task prompt leakage');
  if (treatment?.error) blockers.push(treatment.error);
  const pairs =
    snapshotsByModel && Object.keys(snapshotsByModel).length > 0
      ? Object.entries(snapshotsByModel)
      : [['representative', { baseline: baselineSnap, candidate: candidateSnap }]];
  for (const [id, pair] of pairs) {
    const prefix = id === 'representative' ? '' : id + ' ';
    if (!pair.baseline?.ok) {
      blockers.push(prefix + 'baseline header snapshot failed: ' + (pair.baseline?.error || 'unknown'));
    }
    if (!pair.candidate?.ok) {
      blockers.push(prefix + 'candidate header snapshot failed: ' + (pair.candidate?.error || 'unknown'));
    }
    if (
      pair.baseline?.ok &&
      (pair.baseline.snapshot?.headerFound !== true || (pair.baseline.snapshot?.toolNameCount ?? 0) < 8)
    ) {
      blockers.push(prefix + 'baseline factory-bound header is empty or stub-sized');
    }
    if (
      pair.candidate?.ok &&
      (pair.candidate.snapshot?.headerFound !== true || (pair.candidate.snapshot?.toolNameCount ?? 0) < 8)
    ) {
      blockers.push(prefix + 'candidate factory-bound header is empty or stub-sized');
    }
    if (pair.baseline?.ok && pair.candidate?.ok) {
      const left = [...(pair.baseline.snapshot.toolNames ?? [])].sort().join(',');
      const right = [...(pair.candidate.snapshot.toolNames ?? [])].sort().join(',');
      if (left !== right) blockers.push(prefix + 'baseline/candidate header tool-name sets differ');
    }
  }
  return blockers;
}
