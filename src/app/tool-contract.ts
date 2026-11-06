/** Shared assembly result owned by the direct app, implemented in tool-surface.ts. */
import path from 'node:path';
import { ExecutionContext } from '../tools/execution-context.js';
import type { InteractionDecision, InteractionRequest, ToolContextSeed } from '../engine/index.js';
import type { Item, ReasoningEffort, ToolSpec } from '../model/index.js';
import type { DirectRemoteWorkspace } from './remote.js';
import type { LoggingService } from '../session/logging/logging-service.js';
import type { ProviderRegistryDeps } from '../model/provider.js';
import type { ToolRegistry, Workspace } from '../tools/index.js';
/** App settings generations share the concrete logger whose configuration they update. */
export type ProfileSelection = ProviderRegistryDeps & { readonly logger: LoggingService };
export type ToolSurfaceOptions = {
  /** Runtime-only source output limit, owned by this session. */
  readonly trimConfig?: () => { maxCharacters: number; maxLines: number };
  /** App-owned local manager, shared across sessions/configured generations.
   * Capture ONCE per surface generation; never connect or close the manager here. */
  readonly mcp?: {
    captureRequest(): {
      readonly source: import('../tools/mcp/mcp-tool-source.js').McpToolSource;
      approvalPolicy(
        builtInNames: ReadonlySet<string>,
      ): Pick<
        import('../session/approval/non-interactive-approval-policy.js').NonInteractiveApprovalPolicyDeps,
        'mcpAllowlist' | 'isMcpTool' | 'isMcpAllowed'
      >;
    };
  };
  /** App-owned local home/lease shared across configured generations. Must match
   * the authorized workspace home; SSH always uses its connected adapter. */
  readonly localExecutionContext?: import('../tools/execution-context.js').ExecutionContext;
  readonly autoApprove?: boolean;
  readonly interactive?: boolean;
  /** The client owns a session browser, making model-requested rollover available. */
  readonly sessionBrowser?: boolean;
  /** The client's browser behind legacy's session_list/search/read script tools; local only. */
  readonly sessionBrowserSource?: Pick<
    import('../session/conversation/session-browser.js').SessionBrowser,
    'list' | 'search' | 'read'
  >;
  /** Already-authorized workspace. Defaults only to the existing local CLI cwd.
   * Unsupported targets fail; assembly must never promote read access to write. */
  readonly workspace?: Workspace;
  /** Connected adapter for this exact authorized workspace; never a target relabel. */
  readonly remote?: DirectRemoteWorkspace;
  /** Already-loaded target instructions. Source profile gates remain authoritative. */
  readonly projectInstructions?: string;
  /** False when native Session context owns memory; always false over SSH. */
  readonly includeMemory?: boolean;
  /** Prompt-only memory description when Session owns the actual memory tools.
   * Never enables source memory tools; it only keeps the source prompt truthful. */
  readonly promptMemoryEnabled?: boolean;
  readonly allowUnsandboxed?: boolean;
  readonly discordSend?: import('../clients/discord/discord-outbound.js').DiscordSend;
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
    /** Source-owned assembly slots for Session leaves and session capabilities. */
    readonly nativeToolSlots: {
      readonly beforeMemory: readonly string[];
      readonly beforeRollover: readonly string[];
      readonly beforeGoal: readonly string[];
      readonly sessions: boolean;
    };
    /** Adapt native-owned source leaves against this SAME surface's policy/lifecycle context. */
    /** Withdraw the previous native leaf offering before building a replacement capability snapshot. */
    resetAdaptedTools(): void;
    adaptTool(definition: import('../tools/types.js').AnyToolDefinition): import('../tools/index.js').Tool;
    /** Only accepts this surface's host-prepared child requests. App checks billing separately. */
    resolveNestedAuthority(
      request: import('../tools/index.js').NestedRunRequest,
    ): import('../session/branches.js').DirectNestedAuthority;
    bindTaskCheckIn(configure: import('../session/capabilities.js').DirectContextPort['configureTaskCheckIn']): void;
    /** The Session goal read by the root goal_check tool. */
    bindGoal(port: Pick<import('../session/capabilities.js').DirectContextPort, 'read' | 'commit'>): void;
    readonly tools: ToolRegistry;
    readonly toolContext: ToolContextSeed;
    readonly maxParallelToolCalls: number;
    dispose?(): void | Promise<void>;
  };
  /** Headless policy only; caller commits its decision through Session's Turn.answer. */
  decideInteraction(request: InteractionRequest, history: readonly Item[]): Promise<InteractionDecision>;
};

/** Native home/lease shared by configured surfaces; never publishes the frozen CLI global root. */
export class LocalExecutionContext extends ExecutionContext {
  private lease?: string;

  constructor(private readonly home: string) {
    super();
    if (!path.isAbsolute(home)) throw new Error(`Workspace home must be absolute: ${home}`);
  }

  override getCwd(): string {
    return this.lease ?? this.home;
  }

  override getHomeWorkspace(): string {
    return this.home;
  }

  override getActiveWorkspace(): string | undefined {
    return this.lease;
  }

  override enterWorkspace(root: string): void {
    if (!path.isAbsolute(root)) throw new Error(`Active workspace must be an absolute path, received: ${root}`);
    this.lease = root;
  }

  override exitWorkspace(): void {
    this.lease = undefined;
  }
}
