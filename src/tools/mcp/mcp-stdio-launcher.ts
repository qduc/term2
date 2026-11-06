/**
 * The seam where stdio MCP servers are launched.
 *
 * The default launcher spawns the configured command as-is. The seam is
 * injectable so tests can observe launches and a future slice can rewrite the
 * spawn without touching the connection manager.
 */
export interface StdioLaunchSpec {
  /** Server config key, for launcher diagnostics. */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** What actually gets spawned. A sandboxed launcher rewrites this. */
export interface StdioSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export type StdioLauncher = (spec: StdioLaunchSpec) => Promise<StdioSpawnSpec>;

/** Runs the configured command as-is. Used until sandboxed launch lands. */
export const unsandboxedStdioLauncher: StdioLauncher = async (spec) => ({
  command: spec.command,
  args: spec.args,
  env: spec.env,
  ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
});
