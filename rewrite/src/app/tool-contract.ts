/** Shared assembly result owned by the direct app, implemented in tool-surface.ts. */
import type { InteractionDecision, InteractionRequest, ToolContextSeed } from '../engine/index.js';
import type { Item, ModelRequest, ReasoningEffort, ToolSpec } from '../model/index.js';
import type { DirectRemoteWorkspace } from './direct-remote.js';
import type { ProviderRegistryDeps } from '../model/provider.js';
import type { ToolRegistry, Workspace } from '../tools/index.js';
export type ProfileSelection = ProviderRegistryDeps;
export type ToolSurfaceOptions = {
  /** App-owned local manager. Capture never starts connections; the surface never closes it. */
  readonly mcp?: {
    captureRequest(): {
      readonly source: import('../../../source/services/mcp/mcp-tool-source.js').McpToolSource;
      approvalPolicy(
        builtInNames: ReadonlySet<string>,
      ): Pick<
        import('../../../source/services/approval/non-interactive-approval-policy.js').NonInteractiveApprovalPolicyDeps,
        'mcpAllowlist' | 'isMcpTool' | 'isMcpAllowed'
      >;
    };
  };
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
/** One immutable request binding; retain tools AND policy through approvals/background execution. */
export type PreparedToolSurfaceRequest = {
  readonly request: ModelRequest;
  readonly tools: ToolRegistry;
  readonly decideInteraction: AgentSurface['decideInteraction'];
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
    /** Call once per actual model request, then layer native capabilities onto the returned pair.
     * The caller must route this request's interactions to its captured policy, not the newest one. */
    prepareRequestTools(request: ModelRequest): PreparedToolSurfaceRequest;
    /** Adapt native-owned source leaves against this SAME surface's policy/lifecycle context. */
    /** Withdraw the previous native leaf offering before building a replacement capability snapshot. */
    resetAdaptedTools(): void;
    adaptTool(definition: import('../../../source/tools/types.js').AnyToolDefinition): import('../tools/index.js').Tool;
    /** Only accepts this surface's host-prepared child requests. App checks billing separately. */
    resolveNestedAuthority(
      request: import('../tools/index.js').NestedRunRequest,
    ): import('../session/direct-branches.js').DirectNestedAuthority;
    bindTaskCheckIn(
      configure: import('../session/direct-capabilities.js').DirectContextPort['configureTaskCheckIn'],
    ): void;
    readonly tools: ToolRegistry;
    readonly toolContext: ToolContextSeed;
    readonly maxParallelToolCalls: number;
    dispose?(): void | Promise<void>;
  };
  /** Headless policy only; caller commits its decision through Session's Turn.answer. */
  decideInteraction(request: InteractionRequest, history: readonly Item[]): Promise<InteractionDecision>;
};
