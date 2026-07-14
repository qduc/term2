import type { ResolvedAgentPermissions, AgentLimits, ExactModelPolicy } from './types.js';
import type { ResolvedFilesystemScope, ResolvedNetworkScope } from './scope-resolver.js';

/**
 * Immutable internal definition of a fully-resolved agent.
 * Core executors consume only this type — they never load roles,
 * skills, or widen authority.
 *
 * Carries both coarse permission flags and fine-grained resolved scopes.
 * When scopes are undefined, no fine-grained restriction applies (legacy
 * coarse flag behavior). When scopes are defined, they MUST be enforced
 * at invocation time by tool wrappers.
 */
export interface ResolvedAgentDefinition {
  readonly name: string;
  /** Stable trusted-preset identity; distinct from the user-facing display name. */
  readonly legacyRole?: string;
  readonly instructions: string;
  readonly model: ExactModelPolicy;
  /** Internal coarse permission flags resolved from the public shape. */
  readonly permissions: ResolvedAgentPermissions;
  /** Resolved limits clamped to parent maxima. */
  readonly limits: AgentLimits;
  /** Resolved tool names available to the agent. */
  readonly tools: ReadonlyArray<string>;
  /** Resolved skill instruction bodies. */
  readonly skillInstructions: string;
  /** Resolved filesystem scopes (undefined = no fine-grained restriction). */
  readonly filesystemScope?: ResolvedFilesystemScope;
  /** Resolved network host scopes (undefined = no fine-grained restriction). */
  readonly networkScope?: ResolvedNetworkScope;
  /** Structured output schema request (undefined if not requested). */
  readonly outputSchema?: {
    schema: Record<string, unknown>;
    name?: string;
  };
  /** Errors accumulated during resolution. If non-empty the handle MUST refuse execution. */
  readonly resolutionErrors: ReadonlyArray<{
    code: string;
    message: string;
  }>;
}
