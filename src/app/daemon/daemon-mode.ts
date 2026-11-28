/**
 * Whether a local launcher routes through the singleton daemon. Opt-in until the
 * Step 14f default flip (`docs/plans/daemon/README.md`); `TERM2_IN_PROCESS=1` always
 * keeps the in-process host.
 */
export function daemonModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['TERM2_DAEMON_MODE'] === '1' && env['TERM2_IN_PROCESS'] !== '1';
}
