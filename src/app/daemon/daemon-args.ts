/** Pure CLI argument parser for `term2 daemon [start|status|stop]` (zero runtime/IO imports). */

export type DaemonCliArgs = {
  readonly action: 'start' | 'status' | 'stop';
  readonly socketPath?: string;
  readonly stateDir?: string;
  readonly force?: boolean;
};

export function parseDaemonArgs(
  argv: readonly string[],
): { readonly ok: true; readonly args: DaemonCliArgs } | { readonly ok: false; readonly error: string } {
  let action: DaemonCliArgs['action'] = 'start';
  let socketPath: string | undefined;
  let stateDir: string | undefined;
  let force = false;
  let index = 0;

  const first = argv[0];
  if (first === 'start' || first === 'status' || first === 'stop') {
    action = first;
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--foreground') continue;
    if (token === '--force') {
      force = true;
      continue;
    }
    if (token === '--socket' || token.startsWith('--socket=')) {
      const value = token === '--socket' ? argv[++index] : token.slice('--socket='.length);
      if (!value) return { ok: false, error: '--socket requires a path' };
      socketPath = value;
      continue;
    }
    if (token === '--state-dir' || token.startsWith('--state-dir=')) {
      const value = token === '--state-dir' ? argv[++index] : token.slice('--state-dir='.length);
      if (!value) return { ok: false, error: '--state-dir requires a path' };
      stateDir = value;
      continue;
    }
    return { ok: false, error: `Unknown flag: ${token}` };
  }

  return {
    ok: true,
    args: {
      action,
      ...(socketPath ? { socketPath } : {}),
      ...(stateDir ? { stateDir } : {}),
      ...(force ? { force: true } : {}),
    },
  };
}
