/** Shared assembly result owned by the direct app, implemented in tool-surface.ts. */
import type { InteractionDecision, InteractionRequest, ToolContextSeed } from '../engine/index.js';
import type { Item, ReasoningEffort, ToolSpec } from '../model/index.js';
import type { DirectRemoteWorkspace } from './direct-remote.js';
import type { ProviderRegistryDeps } from '../model/provider.js';
import type { ToolRegistry, Workspace } from '../tools/index.js';
export type ProfileSelection = ProviderRegistryDeps;
export type ToolSurfaceOptions = {
  readonly autoApprove?: boolean;
  readonly interactive?: boolean;
  /** Already-authorized workspace. Defaults only to the existing local CLI cwd.
   * Unsupported targets fail; assembly must never promote read access to write. */
  readonly workspace?: Workspace;
  /** Connected adapter for this exact authorized workspace; never a target relabel. */
  readonly remote?: DirectRemoteWorkspace;
  /** Already-loaded target instructions. Source profile gates remain authoritative. */
  readonly projectInstructions?: string;
  /** False when native Session context owns memory; always false over SSH. */
  readonly includeMemory?: boolean;
  readonly allowUnsandboxed?: boolean;
  readonly discordSend?: import('../../../source/services/discord/discord-outbound.js').DiscordSend;
  readonly isDiscordInputEnabled?: () => boolean;
};
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
    /** Adapt native-owned source leaves against this SAME surface's policy/lifecycle context. */
    adaptTool(definition: import('../../../source/tools/types.js').AnyToolDefinition): import('../tools/index.js').Tool;
    readonly tools: ToolRegistry;
    readonly toolContext: ToolContextSeed;
    readonly maxParallelToolCalls: number;
    dispose?(): void | Promise<void>;
  };
  /** Headless policy only; caller commits its decision through Session's Turn.answer. */
  decideInteraction(request: InteractionRequest, history: readonly Item[]): Promise<InteractionDecision>;
};
