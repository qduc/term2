import type { AgentPermissions, AgentLimits, ResolvedAgentPermissions } from './types.js';
import type { ResolvedFilesystemScope, ResolvedNetworkScope } from './scope-resolver.js';
import { resolveFilesystemScopes, resolveNetworkScopes } from './scope-resolver.js';

// ─── Permission mapping errors ────────────────────────────────────

export interface PermissionResolutionError {
  code: 'unsupported_permission_scope' | 'invalid_scope_pattern';
  field: string;
  message: string;
}

// ─── Defaults ─────────────────────────────────────────────────────

/** Default effective permissions: no authority. */
export const DEFAULT_RESOLVED_PERMISSIONS: ResolvedAgentPermissions = Object.freeze({
  canRead: false,
  canWrite: false,
  canRunShell: false,
  canSearchWeb: false,
  canUseNestedAgents: false,
});

/** Default effective limits: conservative. */
export const DEFAULT_LIMITS: AgentLimits = Object.freeze({
  maxTurns: 20,
  maxTokens: undefined,
  maxCost: undefined,
  timeoutMs: undefined,
  maxChildren: undefined,
  maxDepth: undefined,
  maxConcurrency: undefined,
});

// ─── Permission narrowing helpers ─────────────────────────────────

/**
 * Derive coarse `canRead` from the public permission shape.
 * - `tools` listing any read-only tool grants read.
 * - `filesystem.read` present but empty also grants read.
 */
function deriveCanRead(perms: AgentPermissions): boolean {
  const readTools = new Set([
    'read_file',
    'grep',
    'glob',
    'read_code_outline',
    'code_context_search',
    'web_search',
    'web_fetch',
    'ask_user',
    'activate_skill',
  ]);
  if (perms.tools?.some((t) => readTools.has(t))) return true;
  if (perms.filesystem?.read !== undefined) return true;
  return false;
}

/** Derive coarse `canWrite` from the public permission shape. */
function deriveCanWrite(perms: AgentPermissions): boolean {
  const writeTools = new Set(['apply_patch', 'search_replace', 'create_file']);
  if (perms.tools?.some((t) => writeTools.has(t))) return true;
  if (perms.filesystem?.write !== undefined) return true;
  return false;
}

/** Derive coarse `canRunShell` from the public permission shape. */
function deriveCanRunShell(perms: AgentPermissions): boolean {
  if (perms.tools?.includes('shell')) return true;
  return false;
}

/** Derive coarse `canSearchWeb` from the public permission shape. */
function deriveCanSearchWeb(perms: AgentPermissions): boolean {
  const webTools = new Set(['web_search', 'web_fetch']);
  if (perms.tools?.some((t) => webTools.has(t))) return true;
  if (perms.network?.hosts !== undefined) return true;
  return false;
}

/** Derive coarse `canUseNestedAgents` from the public permission shape. */
function deriveCanUseNestedAgents(perms: AgentPermissions): boolean {
  // Explicit denial via agents.create: false overrides everything.
  if (perms.agents?.create === false) return false;
  const nestedTools = new Set(['run_subagent', 'ask_mentor']);
  if (perms.tools?.some((t) => nestedTools.has(t))) return true;
  if (perms.agents?.create === true) return true;
  return false;
}

// ─── Public → internal resolution ─────────────────────────────────

/**
 * Convert public AgentPermissions into the internal coarse
 * ResolvedAgentPermissions. Also resolves fine-grained filesystem
 * and network scopes via intersection with parent.
 */
export function resolvePermissions(
  child?: AgentPermissions,
  parent?: AgentPermissions,
): {
  permissions: ResolvedAgentPermissions;
  filesystemScope?: ResolvedFilesystemScope;
  networkScope?: ResolvedNetworkScope;
  /** Resolved agents.maxDepth from child intersected with parent. */
  agentsMaxDepth?: number;
  errors: PermissionResolutionError[];
} {
  const errors: PermissionResolutionError[] = [];

  // Validate remaining unsupported scopes
  if (child?.agents?.allowedModels && child.agents.allowedModels.length > 0) {
    errors.push({
      code: 'unsupported_permission_scope',
      field: 'agents.allowedModels',
      message: 'Fine-grained agent model whitelisting is not yet supported. Omit allowedModels for no restriction.',
    });
  }

  // ── Resolve agents.maxDepth (intersect child with parent) ──
  let agentsMaxDepth: number | undefined;
  if (child?.agents?.maxDepth !== undefined || parent?.agents?.maxDepth !== undefined) {
    if (child?.agents?.maxDepth !== undefined && parent?.agents?.maxDepth !== undefined) {
      agentsMaxDepth = Math.min(child.agents.maxDepth, parent.agents.maxDepth);
    } else {
      agentsMaxDepth = child?.agents?.maxDepth ?? parent?.agents?.maxDepth;
    }
  }

  // Resolve fine-grained filesystem scopes
  const fsResult = resolveFilesystemScopes(
    child?.filesystem ? { read: child.filesystem.read, write: child.filesystem.write } : undefined,
    parent?.filesystem ? { read: parent.filesystem.read, write: parent.filesystem.write } : undefined,
  );
  for (const err of fsResult.errors) {
    errors.push({ code: err.code, field: err.field, message: err.message });
  }

  // Resolve fine-grained network scopes
  const netResult = resolveNetworkScopes(
    child?.network ? { hosts: child.network.hosts } : undefined,
    parent?.network ? { hosts: parent.network.hosts } : undefined,
  );
  for (const err of netResult.errors) {
    errors.push({ code: err.code, field: err.field, message: err.message });
  }

  // Derive coarse flags from the public shape
  const childCoarse = child ? publicToCoarse(child) : undefined;
  const parentCoarse = parent ? publicToCoarse(parent) : undefined;

  let resolved: ResolvedAgentPermissions;

  if (!childCoarse && !parentCoarse) {
    resolved = { ...DEFAULT_RESOLVED_PERMISSIONS };
  } else if (!childCoarse && parentCoarse) {
    resolved = { ...parentCoarse };
  } else if (childCoarse && !parentCoarse) {
    resolved = {
      canRead: childCoarse.canRead,
      canWrite: childCoarse.canWrite,
      canRunShell: childCoarse.canRunShell,
      canSearchWeb: childCoarse.canSearchWeb,
      canUseNestedAgents: childCoarse.canUseNestedAgents,
    };
  } else {
    // Both present: intersect
    const p = parentCoarse!;
    resolved = {
      canRead: childCoarse!.canRead && p.canRead,
      canWrite: childCoarse!.canWrite && p.canWrite,
      canRunShell: childCoarse!.canRunShell && p.canRunShell,
      canSearchWeb: childCoarse!.canSearchWeb && p.canSearchWeb,
      canUseNestedAgents: childCoarse!.canUseNestedAgents && p.canUseNestedAgents,
    };
  }

  return {
    permissions: resolved,
    filesystemScope: fsResult.resolved,
    networkScope: netResult.resolved,
    agentsMaxDepth,
    errors,
  };
}

function publicToCoarse(perms: AgentPermissions): ResolvedAgentPermissions {
  return {
    canRead: deriveCanRead(perms),
    canWrite: deriveCanWrite(perms),
    canRunShell: deriveCanRunShell(perms),
    canSearchWeb: deriveCanSearchWeb(perms),
    canUseNestedAgents: deriveCanUseNestedAgents(perms),
  };
}

// ─── Limits resolution ────────────────────────────────────────────

/**
 * Compute effective limits by clamping child values to parent maxima.
 * The child may be more restrictive than the parent but never less.
 */
export function resolveLimits(child?: AgentLimits, parent?: AgentLimits): AgentLimits {
  if (!child && !parent) return { ...DEFAULT_LIMITS };
  if (!child && parent) return { ...parent };
  if (child && !parent) {
    return {
      maxTurns: child.maxTurns ?? DEFAULT_LIMITS.maxTurns,
      maxTokens: child.maxTokens ?? DEFAULT_LIMITS.maxTokens,
      maxCost: child.maxCost ?? DEFAULT_LIMITS.maxCost,
      timeoutMs: child.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
      maxChildren: child.maxChildren ?? DEFAULT_LIMITS.maxChildren,
      maxDepth: child.maxDepth ?? DEFAULT_LIMITS.maxDepth,
      maxConcurrency: child.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency,
    };
  }

  const p = parent!;
  return {
    maxTurns: clampOpt(child!.maxTurns, p.maxTurns, DEFAULT_LIMITS.maxTurns),
    maxTokens: clampOpt(child!.maxTokens, p.maxTokens),
    maxCost: clampOpt(child!.maxCost, p.maxCost),
    timeoutMs: clampOpt(child!.timeoutMs, p.timeoutMs),
    maxChildren: clampOpt(child!.maxChildren, p.maxChildren),
    maxDepth: clampOpt(child!.maxDepth, p.maxDepth),
    maxConcurrency: clampOpt(child!.maxConcurrency, p.maxConcurrency),
  };
}

function clampOpt(
  childVal: number | undefined,
  parentVal: number | undefined,
  defaultVal?: number,
): number | undefined {
  const effectiveParent = parentVal ?? defaultVal;
  if (childVal === undefined) return effectiveParent;
  if (effectiveParent === undefined) return childVal;
  return Math.min(childVal, effectiveParent);
}
