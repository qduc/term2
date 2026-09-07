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

export function classifyCellOutcome({ exit, identityOk, conversationPath, stdout, correctness }) {
  if (!identityOk) {
    return { kind: 'infrastructure-failure', reason: 'wrong-model' };
  }
  if (exit?.signal === 'SIGKILL') {
    return { kind: 'infrastructure-failure', reason: 'timeout-sigkill' };
  }
  if (!conversationPath) {
    return { kind: 'infrastructure-failure', reason: 'missing-conversation' };
  }
  if (exit?.code && exit.code !== 0 && !hasCompletedEvent(stdout)) {
    return { kind: 'infrastructure-failure', reason: 'non-zero-exit-without-completion' };
  }
  if (correctness?.correct) return { kind: 'correct', reason: correctness.reason ?? 'oracle-pass' };
  return { kind: 'incorrect', reason: correctness?.reason ?? 'oracle-fail' };
}
