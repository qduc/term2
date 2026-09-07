export function hasCompletedEvent(stdout) {
  return String(stdout || '')
    .split('\n')
    .some((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === 'completed' || event.type === 'final';
      } catch {
        return false;
      }
    });
}

export function classifyCellOutcome({
  exit,
  identityMatch,
  identityOk,
  conversationPath,
  stdout,
  stdoutEventCount,
  correctness,
}) {
  const match = identityMatch ?? {
    present: Boolean(identityOk),
    ok: Boolean(identityOk),
    reason: identityOk ? 'identity-match' : 'wrong-model',
  };
  if (match.reason === 'wrong-model' && match.present) {
    return { kind: 'infrastructure-failure', reason: 'wrong-model' };
  }
  if (!match.present) {
    return { kind: 'infrastructure-failure', reason: 'identity-missing' };
  }
  if (exit?.signal === 'SIGKILL') {
    return { kind: 'infrastructure-failure', reason: 'timeout-sigkill' };
  }
  const hasStdoutEvents = (stdoutEventCount ?? 0) > 0 || hasCompletedEvent(stdout);
  if (!conversationPath && !hasStdoutEvents) {
    return { kind: 'infrastructure-failure', reason: 'missing-conversation' };
  }
  if (exit?.code && exit.code !== 0 && !hasCompletedEvent(stdout)) {
    return { kind: 'infrastructure-failure', reason: 'non-zero-exit-without-completion' };
  }
  if (correctness?.correct) return { kind: 'correct', reason: correctness.reason ?? 'oracle-pass' };
  return { kind: 'incorrect', reason: correctness?.reason ?? 'oracle-fail' };
}

export function paidReportMode({ only, records, aborted }) {
  const onlyIsCellId = Boolean(only && records.length === 1 && records[0]?.cell?.cellId === only);
  if (aborted) {
    return {
      kind: 'invalid-abort',
      runInvalid: true,
      headline: 'INVALID: aborted after ' + aborted.reason,
      aborted,
    };
  }
  if (onlyIsCellId) {
    return { kind: 'incomplete-cell-only', runInvalid: false, aborted: null };
  }
  return { kind: 'aggregate', runInvalid: false, aborted: null };
}
