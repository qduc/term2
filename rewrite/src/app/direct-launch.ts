/** Dispatch for the direct executable's modes. Each mode loads only when chosen, so ACP's stdout and a headless start stay light. */
import type { DirectLaunchRequest } from './direct-launch-types.js';

export { runDirectHeadlessOnHost } from './direct-launch-headless.js';
export type {
  DirectHeadlessHandle,
  DirectHeadlessRequest,
  DirectHeadlessResult,
  DirectLaunchRequest,
} from './direct-launch-types.js';

export async function launchDirect(request: DirectLaunchRequest): Promise<number> {
  switch (request.kind) {
    case 'interactive':
      return (await import('./direct-launch-tui.js')).launchTui(request);
    case 'acp':
      return (await import('./direct-launch-acp.js')).launchAcp(request);
    case 'control':
      return (await import('./direct-launch-control.js')).launchControl(request.argv);
    case 'discord':
      return (await import('./direct-launch-control.js')).launchDiscord(request.argv);
    case 'serve':
      return (await import('./direct-launch-serve.js')).launchServe(request);
  }
}
