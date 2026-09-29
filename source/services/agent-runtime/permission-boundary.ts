import path from 'node:path';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import { AGENT_SPEC_TOOL_NAMES, agentSpecToConfig } from './agent-spec.js';
import { resolveAgent } from './agent-resolver.js';
import type { ResolvedAgentDefinition } from './resolved-agent.js';
import type { ResolvedFilesystemScope, ResolvedNetworkScope } from './scope-resolver.js';
import type {
  AgentConfig,
  AgentLimits,
  AgentPermissions,
  AgentSpec,
  AgentSpecToolName,
  ResolvedAgentPermissions,
  RunErrorCode,
} from './types.js';

const AGENT_SPEC_FIELDS = new Set([
  'goal',
  'context',
  'tools',
  'permissions',
  'constraints',
  'doneWhen',
  'model',
  'budget',
]);
const AGENT_SPEC_TOOL_SET = new Set<AgentSpecToolName>(AGENT_SPEC_TOOL_NAMES);
const READ_TOOLS = new Set(['read_file', 'grep', 'glob', 'read_code_outline', 'code_context_search']);
const WRITE_TOOLS = new Set(['apply_patch', 'search_replace', 'create_file']);
const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

/**
 * The host-owned authority snapshot needed to attenuate a script request.
 * `tools` is the already-effective allowlist, not the parent's requested set.
 * An omitted scope means unrestricted authority on that axis; an empty scope
 * is an explicit denial.
 */
export interface AgentPermissionBoundaryParent {
  readonly tools: ReadonlyArray<string>;
  readonly permissions: ResolvedAgentPermissions;
  readonly filesystemScope?: ResolvedFilesystemScope;
  readonly networkScope?: ResolvedNetworkScope;
  readonly limits: AgentLimits;
  readonly worktreeScope?: ReadonlyArray<string>;
}

/** Options which are host state, rather than data supplied by the script. */
export interface ResolveAgentSpecForChildOptions {
  readonly settings: ISettingsService;
  readonly logger: ILoggingService;
  readonly parent: AgentPermissionBoundaryParent;
  readonly readOnly?: boolean;
  readonly planMode?: boolean;
  /** Opaque worktree names the parent has explicitly authorized. */
  readonly worktree?: unknown;
}

export type AgentSpecBoundaryErrorCode =
  | RunErrorCode
  | 'invalid_agent_spec'
  | 'missing_parent_authority'
  | 'unsupported_worktree_scope';

export interface AgentSpecBoundaryError {
  readonly code: AgentSpecBoundaryErrorCode;
  readonly message: string;
  readonly field?: string;
}

export type AgentSpecBoundaryResult =
  | {
      readonly ok: true;
      readonly spec: AgentSpec;
      readonly config: AgentConfig;
      readonly definition: ResolvedAgentDefinition;
      readonly worktree?: string;
    }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<AgentSpecBoundaryError>;
    };

/**
 * Adapt the existing resolved runtime definition into the authority snapshot
 * consumed by the script boundary. This is deliberately an adapter: the
 * interactive root currently does not expose a public effective-permissions
 * object of its own.
 */
export function parentAuthorityFromDefinition(
  definition: ResolvedAgentDefinition,
  options: { worktreeScope?: ReadonlyArray<string> } = {},
): AgentPermissionBoundaryParent {
  return {
    tools: [...definition.tools],
    permissions: { ...definition.permissions },
    ...(definition.filesystemScope
      ? {
          filesystemScope: { read: [...definition.filesystemScope.read], write: [...definition.filesystemScope.write] },
        }
      : {}),
    ...(definition.networkScope ? { networkScope: [...definition.networkScope] } : {}),
    limits: { ...definition.limits },
    ...(options.worktreeScope ? { worktreeScope: [...options.worktreeScope] } : {}),
  };
}

/**
 * Resolve and attenuate one untrusted, script-requested AgentSpec.
 *
 * The returned definition is safe to pass to the existing execution runner:
 * all requested tools, scopes, coarse capabilities, and nested-agent depth
 * are resolved through the existing AgentRuntime resolver against the host's
 * effective parent authority. Any resolution error is a rejection, rather
 * than a partially-authorized execution.
 */
export function resolveAgentSpecForChild(
  rawSpec: unknown,
  options: ResolveAgentSpecForChildOptions,
): AgentSpecBoundaryResult {
  const inputErrors = validateAgentSpec(rawSpec);
  const parent = options?.parent;
  const parentErrors = validateParentAuthority(parent);
  const worktreeResult = resolveWorktree(options?.worktree, parent?.worktreeScope);
  const errors = [...inputErrors, ...parentErrors, ...worktreeResult.errors];
  if (errors.length > 0) return { ok: false, errors };

  const spec = rawSpec as AgentSpec;
  const authority = parent!;
  const parentPermissions = toPublicParentPermissions(authority, {
    readOnly: options.readOnly === true,
    planMode: options.planMode === true,
  });
  const config = agentSpecToConfig(spec);
  const definition = resolveAgent(config, {
    settings: options.settings,
    logger: options.logger,
    parentPermissions,
    parentLimits: authority.limits,
  });

  const resolutionErrors = definition.resolutionErrors.map((error) => {
    const fieldMatch = /\(field: ([^)]+)\)$/.exec(error.message);
    return {
      code: normalizeErrorCode(error.code),
      message: error.message,
      ...(fieldMatch ? { field: fieldMatch[1] } : {}),
    };
  });
  resolutionErrors.push(...validateResolvedScopeTools(definition));
  if (authority.filesystemScope) {
    for (const axis of ['read', 'write'] as const) {
      if (definition.filesystemScope?.[axis].some((pattern) => !authority.filesystemScope![axis].includes(pattern))) {
        resolutionErrors.push({
          code: 'unsupported_permission_scope',
          field: `permissions.filesystem.${axis}`,
          message: 'Child filesystem patterns must exactly match an authorized parent pattern.',
        });
      }
    }
  }
  if (spec.permissions?.agents?.create === true) {
    resolutionErrors.push({
      code: 'unsupported_permission_scope',
      field: 'permissions.agents.create',
      message: 'Nested agent creation is not provisioned for AgentSpec executions.',
    });
  }
  if (resolutionErrors.length > 0) return { ok: false, errors: resolutionErrors };

  // A scope can derive a coarse flag in the general resolver even when no
  // matching tool was requested. At this boundary the effective tool list is
  // authoritative, so an unpaired scope must not make the existing tool
  // factory provision an extra capability.
  const boundedDefinition: ResolvedAgentDefinition = {
    ...definition,
    permissions: {
      ...definition.permissions,
      canRead: definition.tools.some((tool) => READ_TOOLS.has(tool)),
      canWrite: definition.tools.some((tool) => WRITE_TOOLS.has(tool)),
      canRunShell: definition.tools.includes('shell'),
      canSearchWeb: definition.tools.some((tool) => WEB_TOOLS.has(tool)),
      canUseNestedAgents: false,
    },
  };

  return {
    ok: true,
    spec,
    config,
    definition: boundedDefinition,
    ...(worktreeResult.worktree ? { worktree: worktreeResult.worktree } : {}),
  };
}

function normalizeErrorCode(code: string): AgentSpecBoundaryErrorCode {
  const known: Set<string> = new Set([
    'unsupported_structured_output',
    'unsupported_attachments',
    'invalid_model_policy',
    'unknown_skill',
    'unknown_tool',
    'budget_exhausted',
    'permission_denied',
    'unsupported_permission_scope',
    'invalid_scope_pattern',
    'unsupported_limit',
    'limit_validation_error',
    'limit_exceeded',
    'scope_violation',
    'provider_error',
    'cancelled',
    'agent_error',
    'invalid_attachment',
    'invalid_schema',
    'invalid_output',
  ]);
  return known.has(code) ? (code as RunErrorCode) : 'invalid_agent_spec';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): AgentSpecBoundaryError[] {
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => ({
      code: 'invalid_agent_spec' as const,
      field: field ? `${field}.${key}` : key,
      message: `Unsupported field "${field ? `${field}.` : ''}${key}" is rejected at the host boundary.`,
    }));
}

function validateAgentSpec(raw: unknown): AgentSpecBoundaryError[] {
  const spec = record(raw);
  if (!spec) return [{ code: 'invalid_agent_spec', message: 'AgentSpec must be a plain object.' }];
  const errors = unknownFields(spec, AGENT_SPEC_FIELDS, '');
  if (typeof spec.goal !== 'string' || spec.goal.trim().length === 0) {
    errors.push({ code: 'invalid_agent_spec', field: 'goal', message: 'AgentSpec.goal must be a non-empty string.' });
  }
  if ('context' in spec && record(spec.context) === undefined) {
    errors.push({ code: 'invalid_agent_spec', field: 'context', message: 'AgentSpec.context must be an object.' });
  }
  if ('tools' in spec) errors.push(...validateToolList(spec.tools, 'tools'));
  if ('constraints' in spec) {
    if (!Array.isArray(spec.constraints) || spec.constraints.some((item) => typeof item !== 'string')) {
      errors.push({
        code: 'invalid_agent_spec',
        field: 'constraints',
        message: 'AgentSpec.constraints must be an array of strings.',
      });
    }
  }
  if ('doneWhen' in spec && typeof spec.doneWhen !== 'string') {
    errors.push({ code: 'invalid_agent_spec', field: 'doneWhen', message: 'AgentSpec.doneWhen must be a string.' });
  }
  if ('model' in spec) errors.push(...validateModel(spec.model));
  if ('budget' in spec) errors.push(...validateBudget(spec.budget));
  if ('permissions' in spec) errors.push(...validatePermissions(spec.permissions));
  return errors;
}

function validateToolList(value: unknown, field: string): AgentSpecBoundaryError[] {
  if (!Array.isArray(value)) return [{ code: 'invalid_agent_spec', field, message: `${field} must be an array.` }];
  return value.flatMap((tool, index) =>
    typeof tool !== 'string' || !AGENT_SPEC_TOOL_SET.has(tool as AgentSpecToolName)
      ? [
          {
            code: 'unknown_tool' as const,
            field: `${field}.${index}`,
            message: `Unsupported AgentSpec tool "${String(tool)}".`,
          },
        ]
      : [],
  );
}

function validateModel(value: unknown): AgentSpecBoundaryError[] {
  if (value === 'efficient' || value === 'balanced' || value === 'capable') return [];
  const model = record(value);
  if (model && typeof model.provider === 'string' && model.provider && typeof model.model === 'string' && model.model) {
    const errors = unknownFields(model, new Set(['provider', 'model']), 'model');
    return errors;
  }
  return [
    { code: 'invalid_model_policy', field: 'model', message: 'AgentSpec.model is not a supported model policy.' },
  ];
}

function validateBudget(value: unknown): AgentSpecBoundaryError[] {
  const budget = record(value);
  if (!budget) return [{ code: 'invalid_agent_spec', field: 'budget', message: 'AgentSpec.budget must be an object.' }];
  const errors = unknownFields(budget, new Set(['maxTurns', 'maxTokens']), 'budget');
  for (const key of ['maxTurns', 'maxTokens'] as const) {
    if (key in budget && (!Number.isInteger(budget[key]) || (budget[key] as number) <= 0)) {
      errors.push({
        code: 'invalid_agent_spec',
        field: `budget.${key}`,
        message: `budget.${key} must be a positive integer.`,
      });
    }
  }
  return errors;
}

function validatePermissions(value: unknown): AgentSpecBoundaryError[] {
  const permissions = record(value);
  if (!permissions)
    return [{ code: 'invalid_agent_spec', field: 'permissions', message: 'AgentSpec.permissions must be an object.' }];
  const errors = unknownFields(permissions, new Set(['tools', 'filesystem', 'network', 'agents']), 'permissions');
  if ('tools' in permissions) errors.push(...validateToolList(permissions.tools, 'permissions.tools'));
  errors.push(...validateScopeObject(permissions.filesystem, 'permissions.filesystem', ['read', 'write']));
  errors.push(...validateScopeObject(permissions.network, 'permissions.network', ['hosts']));
  if ('agents' in permissions) {
    const agents = record(permissions.agents);
    if (!agents) {
      errors.push({
        code: 'invalid_agent_spec',
        field: 'permissions.agents',
        message: 'permissions.agents must be an object.',
      });
    } else {
      errors.push(...unknownFields(agents, new Set(['create', 'maxDepth', 'allowedModels']), 'permissions.agents'));
      if ('create' in agents && typeof agents.create !== 'boolean') {
        errors.push({
          code: 'invalid_agent_spec',
          field: 'permissions.agents.create',
          message: 'agents.create must be boolean.',
        });
      }
      if ('maxDepth' in agents && (!Number.isInteger(agents.maxDepth) || (agents.maxDepth as number) < 0)) {
        errors.push({
          code: 'invalid_agent_spec',
          field: 'permissions.agents.maxDepth',
          message: 'agents.maxDepth must be a non-negative integer.',
        });
      }
      // An empty list is still an unsupported promise: there is no proof that
      // a future model allowlist will be enforced by the execution runner.
      if ('allowedModels' in agents) {
        errors.push({
          code: 'unsupported_permission_scope',
          field: 'permissions.agents.allowedModels',
          message: 'agents.allowedModels is not enforceable by the child execution boundary.',
        });
      }
    }
  }
  return errors;
}

function validateScopeObject(value: unknown, field: string, keys: string[]): AgentSpecBoundaryError[] {
  if (value === undefined) return [];
  const scope = record(value);
  if (!scope) return [{ code: 'invalid_agent_spec', field, message: `${field} must be an object.` }];
  const errors = unknownFields(scope, new Set(keys), field);
  for (const key of keys) {
    if (
      key in scope &&
      (!Array.isArray(scope[key]) || (scope[key] as unknown[]).some((item) => typeof item !== 'string'))
    ) {
      errors.push({
        code: 'invalid_agent_spec',
        field: `${field}.${key}`,
        message: `${field}.${key} must be an array of strings.`,
      });
    }
  }
  return errors;
}

function validateParentAuthority(parent: AgentPermissionBoundaryParent | undefined): AgentSpecBoundaryError[] {
  if (!parent || !Array.isArray(parent.tools) || !parent.permissions || !parent.limits || !record(parent.limits)) {
    return [
      { code: 'missing_parent_authority', message: 'A complete effective parent authority snapshot is required.' },
    ];
  }
  const errors: AgentSpecBoundaryError[] = [];
  for (const key of ['canRead', 'canWrite', 'canRunShell', 'canSearchWeb', 'canUseNestedAgents'] as const) {
    if (typeof parent.permissions[key] !== 'boolean') {
      errors.push({
        code: 'missing_parent_authority',
        field: `permissions.${key}`,
        message: 'Parent coarse permissions must be boolean.',
      });
    }
  }
  if (parent.tools.some((tool) => typeof tool !== 'string')) {
    errors.push({
      code: 'missing_parent_authority',
      field: 'tools',
      message: 'Parent effective tools must be strings.',
    });
  }
  if (
    parent.filesystemScope &&
    (!Array.isArray(parent.filesystemScope.read) || !Array.isArray(parent.filesystemScope.write))
  ) {
    errors.push({
      code: 'missing_parent_authority',
      field: 'filesystemScope',
      message: 'Parent filesystem scope must contain read and write arrays.',
    });
  }
  if (parent.networkScope && !Array.isArray(parent.networkScope)) {
    errors.push({
      code: 'missing_parent_authority',
      field: 'networkScope',
      message: 'Parent network scope must be an array.',
    });
  }
  if (
    parent.worktreeScope &&
    (!Array.isArray(parent.worktreeScope) || parent.worktreeScope.some((name) => typeof name !== 'string'))
  ) {
    errors.push({
      code: 'missing_parent_authority',
      field: 'worktreeScope',
      message: 'Parent worktree scope must be an array of names.',
    });
  }
  return errors;
}

function toPublicParentPermissions(
  parent: AgentPermissionBoundaryParent,
  mode: { readOnly: boolean; planMode: boolean },
): AgentPermissions {
  const tools = parent.tools.filter((tool) => {
    if (READ_TOOLS.has(tool) && !parent.permissions.canRead) return false;
    if (WRITE_TOOLS.has(tool) && (!parent.permissions.canWrite || mode.readOnly || mode.planMode)) return false;
    if (tool === 'shell' && !parent.permissions.canRunShell) return false;
    if (WEB_TOOLS.has(tool) && !parent.permissions.canSearchWeb) return false;
    if (tool === 'run_subagent' && !parent.permissions.canUseNestedAgents) return false;
    if (parent.filesystemScope) {
      if (tool === 'shell') return false;
      if (READ_TOOLS.has(tool) && parent.filesystemScope.read.length === 0) return false;
      if (WRITE_TOOLS.has(tool) && parent.filesystemScope.write.length === 0) return false;
    }
    if (parent.networkScope) {
      if (WEB_TOOLS.has(tool) && parent.networkScope.length === 0) return false;
      if (tool === 'web_fetch' && !parent.networkScope.includes('*')) return false;
    }
    return true;
  });
  return {
    tools,
    ...(parent.filesystemScope
      ? { filesystem: { read: [...parent.filesystemScope.read], write: [...parent.filesystemScope.write] } }
      : {}),
    ...(parent.networkScope ? { network: { hosts: [...parent.networkScope] } } : {}),
    agents: {
      create: parent.permissions.canUseNestedAgents,
      ...(parent.limits?.maxDepth !== undefined ? { maxDepth: parent.limits.maxDepth } : {}),
    },
  };
}

function validateResolvedScopeTools(definition: ResolvedAgentDefinition): AgentSpecBoundaryError[] {
  const errors: AgentSpecBoundaryError[] = [];
  if (definition.filesystemScope) {
    if (definition.filesystemScope.read.length === 0 && definition.tools.some((tool) => READ_TOOLS.has(tool))) {
      errors.push({
        code: 'permission_denied',
        field: 'permissions.filesystem.read',
        message: 'Filesystem read scope is explicitly empty.',
      });
    }
    if (definition.filesystemScope.write.length === 0 && definition.tools.some((tool) => WRITE_TOOLS.has(tool))) {
      errors.push({
        code: 'permission_denied',
        field: 'permissions.filesystem.write',
        message: 'Filesystem write scope is explicitly empty.',
      });
    }
    if (definition.tools.includes('shell')) {
      errors.push({
        code: 'unsupported_permission_scope',
        field: 'permissions.filesystem',
        message: 'Shell cannot be proven safe with a finite filesystem scope.',
      });
    }
  }
  if (definition.networkScope) {
    if (definition.networkScope.length === 0 && definition.tools.some((tool) => WEB_TOOLS.has(tool))) {
      errors.push({
        code: 'permission_denied',
        field: 'permissions.network.hosts',
        message: 'Network host scope is explicitly empty.',
      });
    }
    if (definition.tools.some((tool) => WEB_TOOLS.has(tool)) && !definition.networkScope.includes('*')) {
      errors.push({
        code: 'unsupported_permission_scope',
        field: 'permissions.network.hosts',
        message: 'Web tools cannot be proven usable with a finite network scope.',
      });
    }
  }
  return errors;
}

function resolveWorktree(
  requested: unknown,
  allowed: ReadonlyArray<string> | undefined,
): { worktree?: string; errors: AgentSpecBoundaryError[] } {
  if (requested === undefined) return { errors: [] };
  if (
    typeof requested !== 'string' ||
    requested.length === 0 ||
    requested.includes('\0') ||
    path.isAbsolute(requested) ||
    requested.split(/[\\/]/).includes('..')
  ) {
    return {
      errors: [
        {
          code: 'unsupported_worktree_scope',
          field: 'worktree',
          message: 'Worktree requests must be a non-empty opaque relative name.',
        },
      ],
    };
  }
  if (!allowed?.includes(requested)) {
    return {
      errors: [
        {
          code: 'unsupported_worktree_scope',
          field: 'worktree',
          message: `Worktree "${requested}" is not in the parent authority scope.`,
        },
      ],
    };
  }
  return { worktree: requested, errors: [] };
}
