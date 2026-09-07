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
  if (!baselineSnap?.ok) blockers.push('baseline header snapshot failed: ' + (baselineSnap?.error || 'unknown'));
  if (!candidateSnap?.ok) blockers.push('candidate header snapshot failed: ' + (candidateSnap?.error || 'unknown'));
  if (baselineSnap?.ok && (baselineSnap.snapshot?.headerFound !== true || (baselineSnap.snapshot?.toolNameCount ?? 0) < 8)) {
    blockers.push('baseline factory-bound header is empty or stub-sized');
  }
  if (candidateSnap?.ok && (candidateSnap.snapshot?.headerFound !== true || (candidateSnap.snapshot?.toolNameCount ?? 0) < 8)) {
    blockers.push('candidate factory-bound header is empty or stub-sized');
  }
  if (baselineSnap?.ok && candidateSnap?.ok) {
    const left = [...(baselineSnap.snapshot.toolNames ?? [])].sort().join(',');
    const right = [...(candidateSnap.snapshot.toolNames ?? [])].sort().join(',');
    if (left !== right) blockers.push('baseline/candidate header tool-name sets differ');
  }
  return blockers;
}
