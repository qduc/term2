/** Shared assembly result owned by the direct app, implemented in tool-surface.ts. */
import type { InteractionDecision, InteractionRequest, ToolContextSeed } from '../engine/index.js';
import type { Item, ReasoningEffort, ToolSpec } from '../model/index.js';
import type { ProviderRegistryDeps } from '../model/provider.js';
import type { ToolRegistry } from '../tools/index.js';
export type ProfileSelection = ProviderRegistryDeps;
export type ToolSurfaceOptions = { readonly autoApprove?: boolean; readonly interactive?: boolean };
export type AgentSurface = {
  readonly profileName: string;
  readonly instructions: string;
  readonly tools: readonly ToolSpec[];
  readonly reasoning?: ReasoningEffort;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  readonly notice: string | null;
  readonly runtime: {
    readonly tools: ToolRegistry;
    readonly toolContext: ToolContextSeed;
    readonly maxParallelToolCalls: number;
    dispose?(): void | Promise<void>;
  };
  /** Headless policy only; caller commits its decision through Session's Turn.answer. */
  decideInteraction(request: InteractionRequest, history: readonly Item[]): Promise<InteractionDecision>;
};
