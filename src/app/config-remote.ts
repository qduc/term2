/** Transport ownership is Session-wide, not owned by a replaceable tool graph. */
import type { ToolSurfaceOptions } from './tool-contract.js';

/**
 * Use for the INITIAL surface as well as prepared generations. The app retains
 * the original remote and closes it once, after Session shutdown drains every
 * generation. Discarding a candidate/retiring old tools must not disconnect SSH.
 * This does not connect, resolve a workspace, or confer any new authority.
 */
export function borrowDirectConfigSurfaceOptions(options: ToolSurfaceOptions): ToolSurfaceOptions {
  const remote = options.remote;
  if (!remote) return options;
  return {
    ...options,
    remote: {
      ...remote,
      runTool: (name, signal, operation) => remote.runTool(name, signal, operation),
      close: async () => {},
    },
  };
}
