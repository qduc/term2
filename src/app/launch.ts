/** Dispatch for the direct executable's modes. Each mode loads only when chosen, so ACP's stdout and a headless start stay light. */
import type { DirectLaunchRequest } from './launch-types.js';

export const INTERACTIVE_TERMINAL_REQUIRED = 'term2 needs an interactive terminal; for one-shot use: term2 "<prompt>"';

export { runDirectHeadlessOnHost } from './launch-headless.js';
export type {
  DirectHeadlessHandle,
  DirectHeadlessRequest,
  DirectHeadlessResult,
  DirectLaunchRequest,
} from './launch-types.js';

export async function launchDirect(request: DirectLaunchRequest): Promise<number> {
  switch (request.kind) {
    case 'interactive':
      return (await import('./launch-tui.js')).launchTui(request);
    case 'acp':
      return (await import('./launch-acp.js')).launchAcp(request);
    case 'control':
      return (await import('./launch-control.js')).launchControl(request.argv);
    case 'discord':
      return (await import('./launch-control.js')).launchDiscord(request.argv);
    case 'serve':
      return (await import('./launch-serve.js')).launchServe(request);
  }
}
