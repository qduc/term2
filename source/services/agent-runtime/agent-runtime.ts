import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import type { SkillsService } from '../skills/skills-service.js';
import type { AgentConfig, AgentHandle, AgentPermissions, AgentLimits, ModelPolicy } from './types.js';
import { resolveAgent, type AgentResolverDeps } from './agent-resolver.js';
import { AgentHandleImpl, type ExecutorFn } from './agent-handle.js';

export interface AgentRuntimeDeps {
  settings: ISettingsService;
  logger: ILoggingService;
  skillsService?: SkillsService;
  /** Executor that actually runs resolved agents. */
  executor: ExecutorFn;
  /** Parent agent context for nested agent creation. */
  parent?: {
    permissions?: AgentPermissions;
    limits?: AgentLimits;
    modelPolicy?: ModelPolicy;
  };
}

/**
 * Public facade for creating and running one-shot agents with typed
 * permissions, resource limits, file/network scopes, and nested-agent
 * authority.
 *
 * ## Quick start
 *
 * ```ts
 * import { AgentRuntime, createAgentRuntime } from './services/agent-runtime/index.js';
 *
 * // Compose a runtime backed by real subagent infrastructure:
 * const { runtime } = createAgentRuntime({
 *   settings, logger, sessionContextService, createClient,
 * });
 *
 * // Create a read-only agent restricted to src/
 * const handle = runtime.agent({
 *   name: 'code-reviewer',
 *   instructions: 'Review code for issues. Report findings concisely.',
 *   model: 'balanced',
 *   tools: ['read_file', 'grep', 'glob', 'read_code_outline'],
 *   permissions: {
 *     tools: ['read_file', 'grep', 'glob', 'read_code_outline'],
 *     filesystem: { read: ['src/**'] },
 *   },
 *   limits: { maxTurns: 10, timeoutMs: 30_000 },
 * });
 *
 * // Run one-shot
 * const result = await handle.run({
 *   task: 'Find potential null-pointer issues in the auth module.',
 *   context: { module: 'auth', language: 'typescript' },
 * });
 *
 * if (result.status === 'completed') {
 *   console.log(result.output);
 * } else {
 *   console.error(result.error?.code, result.error?.message);
 * }
 * ```
 *
 * ## Permission model
 *
 * Permissions are **narrowing only**: a child agent can never exceed its
 * parent's authority. Coarse flags (`canRead`, `canWrite`, `canRunShell`,
 * `canSearchWeb`, `canUseNestedAgents`) are intersected with the parent.
 * Fine-grained filesystem globs and network host scopes further restrict
 * coarse authority.
 *
 * | Field                  | Effect                                               |
 * |------------------------|------------------------------------------------------|
 * | `permissions.tools`    | Allowlisted tool names (subset of `config.tools`)    |
 * | `permissions.filesystem.read/write` | Glob patterns relative to workspace root |
 * | `permissions.network.hosts` | Allowed host[:port] patterns, or `['*']` for all |
 * | `permissions.agents.create` | `false` explicitly denies nested agent tools    |
 * | `permissions.agents.maxDepth` | Clamped with `limits.maxDepth`               |
 *
 * ## Limits
 *
 * All limit fields are **clamped** to parent maxima. The root
 * `AgentHandle.run()` call does NOT consume a child slot, so `maxChildren`
 * limits actual nested agents, not the root itself.
 *
 * Unsupported limits produce typed preflight rejections:
 * - `maxCost` → `limit_validation_error` (no provider-neutral pricing)
 * - `agents.allowedModels` → `unsupported_permission_scope`
 * - `web_fetch` with finite host scope → runtime `Permission denied` error
 *   (redirect-following not enforceable; use `hosts: ['*']`)
 */
export class AgentRuntime {
  #deps: AgentRuntimeDeps;

  constructor(deps: AgentRuntimeDeps) {
    this.#deps = deps;
  }

  /**
   * Resolve an AgentConfig into a runnable AgentHandle.
   * The handle is cheap to create; the expensive work (execution)
   * happens in handle.run().
   */
  agent(config: AgentConfig): AgentHandle {
    const resolverDeps: AgentResolverDeps = {
      settings: this.#deps.settings,
      logger: this.#deps.logger,
      skillsService: this.#deps.skillsService,
      parentPermissions: this.#deps.parent?.permissions,
      parentLimits: this.#deps.parent?.limits,
      parentModelPolicy: this.#deps.parent?.modelPolicy,
    };

    const definition = resolveAgent(config, resolverDeps);
    return new AgentHandleImpl(definition, this.#deps.logger, this.#deps.executor);
  }
}
