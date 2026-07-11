import type { ISettingsService, ILoggingService } from '../service-interfaces.js';
import type { SkillsService } from '../skills/skills-service.js';
import type { AgentConfig, AgentPermissions, AgentLimits, ModelPolicy } from './types.js';
import type { ResolvedAgentDefinition } from './resolved-agent.js';
import { resolveModelPolicy } from './model-resolver.js';
import { resolvePermissions, resolveLimits } from './permission-resolver.js';
import { resolveSkills } from './skill-resolver.js';
import { resolveTools } from './tools-resolver.js';

export interface AgentResolverDeps {
  settings: ISettingsService;
  logger: ILoggingService;
  skillsService?: SkillsService;
  /** Parent agent permissions (for nested agents). */
  parentPermissions?: AgentPermissions;
  /** Parent agent limits (for nested agents). */
  parentLimits?: AgentLimits;
  /** Parent model policy (for relative tier resolution). */
  parentModelPolicy?: ModelPolicy;
}

/**
 * Resolve an AgentConfig into a fully-resolved ResolvedAgentDefinition.
 * All model/tool/permission/limit/skill decisions happen here.
 *
 * Resolution errors are accumulated but do NOT prevent returning a
 * definition. The handle must check `resolutionErrors` before execution
 * and refuse to run if any fatal resolution errors exist.
 */
export function resolveAgent(config: AgentConfig, deps: AgentResolverDeps): ResolvedAgentDefinition {
  const errors: Array<{ code: string; message: string }> = [];

  // ── Model ─────────────────────────────────────────────
  const modelPolicy: ModelPolicy = config.model ?? 'balanced';
  let model: { provider: string; model: string };
  try {
    model = resolveModelPolicy(modelPolicy, deps.settings, deps.parentModelPolicy);
  } catch (err: any) {
    // Do NOT silently fall back. Accumulate the error and use balanced
    // as a placeholder so we can return a definition that reports the
    // error to the caller. The handle will refuse execution.
    model = resolveModelPolicy('balanced', deps.settings);
    errors.push({
      code: 'invalid_model_policy',
      message: err.message,
    });
  }

  // ── Permissions (public shape → internal coarse + scopes) ──
  const {
    permissions: resolvedPerms,
    filesystemScope,
    networkScope,
    agentsMaxDepth,
    errors: permErrors,
  } = resolvePermissions(config.permissions, deps.parentPermissions);
  for (const err of permErrors) {
    errors.push({
      code: err.code,
      message: `${err.message} (field: ${err.field})`,
    });
  }
  // ── Limits ────────────────────────────────────────────
  let limits = resolveLimits(config.limits, deps.parentLimits);

  // Intersect resolved agents.maxDepth with limits.maxDepth.
  // The permission-level agents.maxDepth acts as an additional ceiling on
  // the execution-tree nesting depth. It is clamped to the smaller of the two.
  if (agentsMaxDepth !== undefined) {
    limits = {
      ...limits,
      maxDepth: limits.maxDepth !== undefined ? Math.min(limits.maxDepth, agentsMaxDepth) : agentsMaxDepth,
    };
  }

  // ── Tools (config.tools ∩ permissions.tools ∩ coarse perms) ──
  const requestedTools = config.tools;
  const authorizedTools = config.permissions?.tools;
  const toolResult = resolveTools(requestedTools, resolvedPerms, authorizedTools);
  for (const err of toolResult.errors) {
    errors.push({
      code: err.code,
      message: `${err.message} (tool: ${err.toolName})`,
    });
  }
  const tools: string[] = toolResult.resolved;

  // ── Skills ────────────────────────────────────────────
  let skillInstructions = '';
  if (deps.skillsService && config.skills && config.skills.length > 0) {
    const skillResult = resolveSkills(config.skills, deps.skillsService);
    skillInstructions = skillResult.instructions;
    for (const err of skillResult.errors) {
      errors.push({
        code: err.code,
        message: `${err.message} (skill: ${err.skillName})`,
      });
    }
  }

  return {
    name: config.name ?? 'agent',
    instructions: config.instructions,
    model,
    permissions: resolvedPerms,
    limits,
    tools,
    skillInstructions,
    filesystemScope,
    networkScope,
    resolutionErrors: errors,
  };
}
