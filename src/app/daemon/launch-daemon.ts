/**
 * CLI runner for `term2 daemon [start|status|stop]`.
 */
import { startTerm2Daemon } from './daemon.js';
import { connectOrStartDaemon, sendSingleRpc } from './daemon-bootstrap.js';
import type { DaemonCliArgs } from './daemon-args.js';

export async function launchDirectDaemon(args: DaemonCliArgs): Promise<number> {
  if (args.action === 'status' || args.action === 'stop') {
    const connected = await connectOrStartDaemon({
      clientKind: 'daemon_cli',
      allowAutoStart: false,
      allowIdleUpgrade: false,
      ...(args.socketPath ? { socketPath: args.socketPath } : {}),
      ...(args.stateDir ? { stateDir: args.stateDir } : {}),
    });
    try {
      const response =
        args.action === 'status'
          ? await sendSingleRpc(connected.socket, 'cli-status-1', 'daemon.status', {})
          : await sendSingleRpc(connected.socket, 'cli-stop-1', 'daemon.shutdown', {
              mode: args.force ? 'immediate' : 'graceful',
            });
      if (!response.ok) {
        process.stderr.write(`term2 daemon ${args.action}: ${response.error.message}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
      return 0;
    } finally {
      connected.socket.destroy();
    }
  }

  const handle = await startTerm2Daemon({
    ...(args.socketPath ? { socketPath: args.socketPath } : {}),
    ...(args.stateDir ? { stateDir: args.stateDir } : {}),
  });
  if (handle.kind === 'already_running') {
    return 0;
  }

  let signalCount = 0;
  const onSignal = (): void => {
    signalCount += 1;
    void handle.shutdown({ mode: signalCount > 1 ? 'immediate' : 'graceful' });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await handle.closed;
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
