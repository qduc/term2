/** Direct app assembly. Tool/policy construction lives at its single source boundary. */
import { createToolSurface } from './tool-surface.js';
import type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';
export type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';

/** Build the offered surface and its matching execution/policy capabilities together. */
export function loadSurface(selection: ProfileSelection, options?: ToolSurfaceOptions): AgentSurface {
  return createToolSurface(selection, options);
}
