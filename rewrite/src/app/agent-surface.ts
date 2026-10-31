/**
 * Everything the old agent builder decides about a request: instructions, tool
 * specs and generation settings. Calls source `buildAgent` with throwing stubs
 * for runtime callbacks, and never executes a tool (D1).
 */

import type { ReasoningEffort, ToolSpec } from '../model/index.js';
import type { ProviderRegistryDeps } from '../model/provider.js';

/**
 * Built by `cli.ts`. `settings` was constructed with `disableFilePersistence:
 * true` (D10), and `cli.ts` has already applied the chosen profile to
 * `app.activeProfileId` with `{ persist: false }`.
 */
export type ProfileSelection = ProviderRegistryDeps;

export type AgentSurface = {
  readonly profileName: string;
  readonly instructions: string;
  readonly tools: readonly ToolSpec[];
  readonly reasoning?: ReasoningEffort;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly notice: string | null;
};

export function loadSurface(_selection: ProfileSelection): AgentSurface {
  throw new Error('loadSurface is not implemented yet (M1 task 5)');
}
