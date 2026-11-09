/** Dispatch for the direct executable's modes. Each mode loads only when chosen, so ACP's stdout and a headless start stay light. */
import type { DirectLaunchRequest } from './launch-types.js';

export const INTERACTIVE_TERMINAL_REQUIRED = 'term2 needs an interactive terminal; for one-shot use: term2 "<prompt>"';

/** The headless runner, loaded only for a headless run: a static re-export initialized it for every mode. */
export async function loadDirectHeadless(): Promise<typeof import('./launch-headless.js').runDirectHeadlessOnHost> {
  return (await import('./launch-headless.js')).runDirectHeadlessOnHost;
}
export type {
  DirectHeadlessHandle,
  DirectHeadlessRequest,
  DirectHeadlessResult,
  DirectLaunchRequest,
} from './launch-types.js';

export async function launchDirect(request: DirectLaunchRequest): Promise<number> {
  switch (request.kind) {
    case 'interactive': {
      // Before the TUI's modules load: its terminal query then overlaps their initialization.
      const terminal = await (await import('./launch-tui-terminal.js')).prepareInteractiveTerminal(request);
      if (!terminal) return 1;
      return (await import('./launch-tui.js')).launchTui(request, terminal.background);
    }
    case 'acp':
      return (await import('./acp/launch-acp.js')).launchAcp(request);
    case 'control':
      return (await import('./launch-control.js')).launchControl(request.argv);
    case 'discord':
      return (await import('./launch-control.js')).launchDiscord(request.argv);
    case 'serve':
      return (await import('./launch-serve.js')).launchServe(request);
  }
}
