/**
 * One turn's workspace snapshot (unattended only, decided when each model request is prepared, so a turn that
 * becomes unattended is snapshotted before its next tool call). Taken at most once per turn.
 */
export function unattendedSnapshot(
  turnId: string,
  reviews: { unattended(): boolean },
  port: import('../types.js').WorkspaceSnapshotPort | undefined,
): { take(): Promise<void>; report(): string | undefined } {
  let pending: Promise<void> | undefined;
  let taken: import('../../tools/workspace/workspace-snapshot.js').WorkspaceSnapshot | undefined;
  return {
    take() {
      if (!pending && port && reviews.unattended())
        pending = port.take(turnId).then(
          (result) => void (taken = result),
          (error: unknown) => void (taken = { kind: 'none', reason: `the snapshot failed (${String(error)})` }),
        );
      return pending ?? Promise.resolve();
    },
    report: () => (taken && port ? port.describe(taken) : undefined),
  };
}
