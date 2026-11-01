/** Source delegation contracts over the owning Session's native branch/task ports. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AgentFactoryDeps } from '../../../source/lib/agent-factory.js';
import { getCatalogModel } from '../../../source/providers/model-catalog/catalog.js';
import { resolveOutputAllocation } from '../../../source/services/agent-runtime/model-context-policy.js';
import { adaptLegacyDefinition } from '../../../source/services/agent-runtime/legacy-adapter.js';
import {
  createRootAgentAuthoritySnapshot,
  resolveAgentSpecForChild,
} from '../../../source/services/agent-runtime/permission-boundary.js';
import { ToolApprovalPolicyRegistry } from '../../../source/services/approval/tool-approval-policy-registry.js';
import { ExecutionContext } from '../../../source/services/execution-context.js';
import { resolveActiveEnforcement } from '../../../source/services/profiles/active-profile.js';
import type { SessionAccessState } from '../../../source/services/session/session-access-state.js';
import { SubagentPoolEntrySchema } from '../../../source/services/settings/settings-schema.js';
import { SkillsService } from '../../../source/services/skills/skills-service.js';
import {
  buildInstructions,
  loadRoleDefinition,
  resolveSubagentSearchViaShell,
  ROLE_MAX_TURNS_DEFAULT,
} from '../../../source/services/subagents/role-loader.js';
import { SubagentRolePoolSelector } from '../../../source/services/subagents/subagent-role-pool-selector.js';
import { SubagentToolFactory, SubagentToolPolicy } from '../../../source/services/subagents/tool-policy.js';
import type {
  SubagentResult,
  SubagentDefinition,
  SubagentRunHandle,
} from '../../../source/services/subagents/types.js';
import { SUBAGENT_ROLES } from '../../../source/services/subagents/types.js';
import {
  deriveAuthorizedWorktreeScope,
  pinWorkerWorktree,
} from '../../../source/services/subagents/worker-worktree.js';
import type { AnyToolDefinition } from '../../../source/tools/types.js';
import type { ItemId, ReasoningEffort } from '../model/index.js';
import type { DirectNestedAuthority } from '../session/direct-branches.js';
import type { DirectContextPort } from '../session/direct-capabilities.js';
import { createSourceToolRegistry, sourceToolContext } from './source-tools.js';
import type { NestedRunRequest, Tool, ToolContext, Workspace } from '../tools/index.js';
import type { ProfileSelection } from './tool-contract.js';
import {
  createDirectDelegationCallbacks,
  projectResult,
  type Launch,
  type ExecutionEvidence,
} from './direct-subagent-callbacks.js';

export type DirectSubagentToolsOptions = {
  readonly selection: ProfileSelection;
  readonly workspace: Workspace;
  readonly executionContext: ExecutionContext;
  readonly skillsService?: SkillsService;
  readonly sessionAccess: SessionAccessState;
  readonly sessionId: string;
  readonly readOnly: boolean;
  readonly graph: () => readonly AnyToolDefinition[];
  readonly checkInterceptors: AgentFactoryDeps['checkToolInterceptors'];
  readonly withAnswer: <T>(answer: string, operation: () => Promise<T>) => Promise<T>;
  readonly targetInvocation?: AgentFactoryDeps['withToolInvocation'];
  readonly remoteUnavailable: ReadonlySet<string>;
};

// Named source roles grant workspace reads independently of the parent's prompt
// profile. AgentSpec children still inherit the parent's effective-tool ceiling.
const WORKSPACE_READ_TOOLS = new Set(['read_file', 'grep', 'glob', 'read_code_outline', 'code_context_search']);

/**
 * Build real source child definitions and policies, but never a source runner.
 * Every launch calls the active physical tool's ctx.runNested; Session owns
 * admission, IDs, budgets, approvals, tasks and terminal results. The lookup
 * accepts only requests prepared here, so model-facing input cannot forge a
 * child registry or workspace. Its caller still applies app billing authority.
 */
export function createDirectSubagentTools(options: DirectSubagentToolsOptions) {
  const { settings, logger, sessionContext } = options.selection;
  const scope = new AsyncLocalStorage<ToolContext>();
  const authorities = new WeakMap<NestedRunRequest, DirectNestedAuthority>();
  const children = new Map<ReturnType<typeof createSourceToolRegistry>, ToolApprovalPolicyRegistry>();
  let configureTaskCheckIn: DirectContextPort['configureTaskCheckIn'] | undefined;
  const pool = new SubagentRolePoolSelector(settings);
  // Tool evidence only, not a lifecycle registry: task state and results stay
  // in Session. Writes come from source wrappers; counts come from admitted
  // native Tool.execute entries, never model-requested tool_call items.
  const preparedEvidence = new WeakMap<NestedRunRequest, ExecutionEvidence>();
  const executionEvidence = new Map<string, ExecutionEvidence>();
  const current = (): ToolContext => {
    const context = scope.getStore();
    if (!context) throw new Error('Subagent operation has no admitted direct tool execution');
    context.signal.throwIfAborted();
    return context;
  };
  const withInvocation: NonNullable<AgentFactoryDeps['withToolInvocation']> = (name, invocation, operation) => {
    const context = sourceToolContext(invocation);
    return scope.run(context, () =>
      options.targetInvocation ? options.targetInvocation(name, invocation, operation) : operation(),
    );
  };

  const prepare = async (
    params: Launch,
    mode: 'foreground' | 'background',
  ): Promise<NestedRunRequest & { readonly input: string }> => {
    current();
    if (params.continue_run_id)
      throw new Error('Continuing a prior subagent run is not available in the native Session');
    const planMode = resolveActiveEnforcement(settings).denials.has('filesystem-mutation');
    let definition: SubagentDefinition;
    let task: string;
    let authorizedPath: string | undefined;
    if (params.agent_spec) {
      const worktrees = deriveAuthorizedWorktreeScope({
        homeRoot: options.workspace.root,
        isRemote: options.executionContext.isRemote(),
        readOnly: options.readOnly,
        planMode,
      });
      const parent = createRootAgentAuthoritySnapshot({
        effectiveTools: options.graph().map((tool) => tool.name),
        limits: { maxTurns: settings.get('agent.maxTurns') ?? ROLE_MAX_TURNS_DEFAULT },
        readOnly: options.readOnly,
        planMode,
        filesystemScope: {
          read: ['**'],
          write: options.readOnly || planMode ? [] : ['**'],
        },
        worktreeScope: worktrees,
        worktreePaths: worktrees.authorizedPaths,
      });
      const bounded = resolveAgentSpecForChild(params.agent_spec, {
        settings,
        logger,
        parent: parent.parent,
        readOnly: options.readOnly,
        planMode,
        worktree: params.worktree,
      });
      if (!bounded.ok) throw new Error(bounded.errors.map((error) => error.message).join('; '));
      definition = { ...adaptLegacyDefinition(bounded.definition), role: 'agent', isScriptGeneric: true };
      task = bounded.spec.goal;
      authorizedPath = bounded.authorizedWorktreePath;
      if (params.authorizedWorktreePath !== undefined && params.authorizedWorktreePath !== authorizedPath)
        throw new Error('Resolved AgentSpec worktree identity changed before admission');
    } else {
      if (!params.role || !params.task) throw new Error('Subagent launch requires a role/task or agent_spec');
      const loaded = loadRoleDefinition(params.role, settings);
      const pooledRole = SUBAGENT_ROLES.find((role) => role === params.role);
      definition = pooledRole ? pool.resolveForSpawn(pooledRole, loaded) : loaded;
      task = params.task;
      if (definition.role === 'mentor' && !params.mentorConsultation) {
        const mentors = SubagentPoolEntrySchema.array().parse(settings.get('agent.mentorPool'));
        if (mentors.length > 1 || (!mentors.length && settings.get('agent.mentorSamples') > 1))
          throw new Error(
            'Multi-consultation mentor runs require ask_mentor; native named/background tasks do not aggregate consultations',
          );
        if (mentors[0]) params = { ...params, mentorModel: mentors[0] };
      }
      if (definition.role === 'mentor' && params.mentorModel)
        definition = {
          ...definition,
          provider: params.mentorModel.provider,
          model: params.mentorModel.model,
          reasoningEffort: params.mentorModel.reasoningEffort ?? settings.get('agent.mentorReasoningEffort'),
        };
    }
    if (
      options.executionContext.isRemote() &&
      (definition.filesystemScope !== undefined || definition.role === 'librarian')
    )
      throw new Error('Native SSH subagents do not provide local memory or local filesystem-scope validation');
    if (definition.canWrite && (options.readOnly || planMode)) throw new Error('This session cannot delegate writes');
    if (definition.canWrite && !params.worktree)
      throw new Error('Write-capable subagents require an existing worktree');
    // Children retain their admission root even if the parent later changes its lease.
    let executionContext = options.executionContext.isRemote()
      ? options.executionContext
      : ExecutionContext.pin(options.executionContext.getCwd());
    let workspace = Object.freeze({ ...options.workspace, root: executionContext.getCwd() });
    if (params.worktree) {
      const pinned = await pinWorkerWorktree({
        name: params.worktree,
        role: definition.role,
        homeRoot: options.workspace.root,
        isRemote: executionContext.isRemote(),
        authorizedPath,
      });
      if (!pinned.ok) throw new Error(pinned.error);
      executionContext = pinned.executionContext;
      workspace = Object.freeze({ ...workspace, root: pinned.worktreePath });
    }
    current();
    let skillsService = workspace.root === options.workspace.root ? options.skillsService : undefined;
    if (!executionContext.isRemote() && !skillsService) {
      skillsService = new SkillsService(logger, executionContext.getCwd());
      skillsService.discoverSkills();
    }
    const policies = new ToolApprovalPolicyRegistry();
    const policy = new SubagentToolPolicy({
      settings,
      logger,
      sessionContextService: sessionContext,
      executionContext,
    });
    const factory = new SubagentToolFactory({
      settings,
      logger,
      executionContext,
      toolPolicy: policy,
      skillsService,
      readOnly: options.readOnly || planMode,
    });
    // Reviewer remains evidence-only: its sole delegated path is another
    // native explorer branch, not inherited workspace or arbitrary agent tools.
    factory.setExplorerRunner(async (question) => run({ role: 'explorer', task: question }));
    const filesChanged: string[] = [];
    const searchViaShell = resolveSubagentSearchViaShell(settings, definition.canRunShell);
    const parentNames = new Set(options.graph().map((tool) => tool.name));
    const askOrchestrator =
      mode === 'background'
        ? (question: string) => {
            const ask = current().askOrchestrator;
            if (!ask) throw new Error('Session orchestrator question port is unavailable');
            return ask(question);
          }
        : undefined;
    const definitions = factory
      .buildToolDefinitions(definition, filesChanged, task, searchViaShell, true, undefined, undefined, askOrchestrator)
      .filter(
        (tool) =>
          (parentNames.has(tool.name) ||
            (!definition.isScriptGeneric && definition.canRead && WORKSPACE_READ_TOOLS.has(tool.name)) ||
            (askOrchestrator && tool.name === 'ask_orchestrator') ||
            (definition.role === 'reviewer' && tool.name === 'run_explorer')) &&
          (!executionContext.isRemote() || !options.remoteUnavailable.has(tool.name)),
      )
      .map(
        (tool): AnyToolDefinition => ({
          ...tool,
          parallelSafe:
            typeof tool.parallelSafe === 'function'
              ? (input, invocation) =>
                  withInvocation(tool.name, invocation, async () =>
                    (tool.parallelSafe as (input: unknown, invocation: unknown) => boolean | Promise<boolean>)(
                      input,
                      invocation,
                    ),
                  )
              : tool.parallelSafe,
          needsApproval: (input, invocation) =>
            withInvocation(tool.name, invocation, async () => tool.needsApproval(input, invocation)),
          execute: (input, invocation, details) =>
            withInvocation(tool.name, invocation, async () => {
              // Source empty-scope semantics must not turn an explicit denial into
              // an unrestricted read/write in this native authority snapshot.
              const write = ['apply_patch', 'search_replace', 'create_file'].includes(tool.name);
              const read = WORKSPACE_READ_TOOLS.has(tool.name);
              if (
                (write && definition.filesystemScope?.write.length === 0) ||
                (read && definition.filesystemScope?.read.length === 0)
              )
                throw new Error(`No filesystem ${write ? 'write' : 'read'} scope for ${tool.name}`);
              return tool.execute(input, invocation, details);
            }),
        }),
      );
    const wrapped = factory.buildAgentTools(definitions, {
      providerId: definition.provider,
      approvalPolicyRegistry: policies,
    });
    const registry = createSourceToolRegistry(wrapped, {
      policies,
      settings,
      sessionAccess: options.sessionAccess,
      sessionId: options.sessionId,
      withAnswer: options.withAnswer,
      checkInterceptors: options.checkInterceptors,
    });
    children.set(registry, policies);
    const evidence: ExecutionEvidence = { filesChanged, toolCounts: new Map() };
    const countedTools = new WeakMap<Tool, Tool>();
    const counted = (tool: Tool): Tool => {
      let adapted = countedTools.get(tool);
      if (!adapted) {
        adapted = {
          ...tool,
          execute(input, context) {
            evidence.toolCounts.set(tool.spec.name, (evidence.toolCounts.get(tool.spec.name) ?? 0) + 1);
            return tool.execute(input, context);
          },
        };
        countedTools.set(tool, adapted);
      }
      return adapted;
    };
    const countedRegistry = {
      get(name: string) {
        const tool = registry.get(name);
        return tool ? counted(tool) : undefined;
      },
      available: (context: Pick<ToolContext, 'workspace' | 'settings'>) => registry.available(context).map(counted),
    };
    // Preserve the source child policy: explicit role allocation wins; otherwise
    // inherit the configured setting with the same catalog default clamp.
    const maxOutputTokens =
      definition.maxTokens ??
      resolveOutputAllocation(
        getCatalogModel(definition.provider, definition.model),
        settings.get('agent.maxOutputTokens'),
        settings.getSource?.('agent.maxOutputTokens') === 'default',
      );
    const request: NestedRunRequest & { readonly input: string } = Object.freeze({
      mode,
      ...(params.name ? { name: params.name } : {}),
      role: definition.role,
      // Original caller field for the native task producer; never reconstruct from label or history.
      input: params.agent_spec ? params.agent_spec.goal : params.task!,
      label: task,
      instructions: buildInstructions(
        definition,
        definitions,
        searchViaShell,
        settings,
        executionContext,
        skillsService,
      ),
      items: Object.freeze([
        { type: 'user_message' as const, id: randomUUID() as ItemId, content: [{ type: 'text' as const, text: task }] },
      ]),
      toolNames: Object.freeze(wrapped.map((tool) => tool.name)),
      model: Object.freeze({ provider: definition.provider, model: definition.model }),
      ...(definition.reasoningEffort !== 'default' ? { reasoning: definition.reasoningEffort as ReasoningEffort } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      // Keep source maxTurns; the owning root RunBudget remains the tool-call
      // containment authority rather than inventing a new per-child workload cap.
      budget: Object.freeze({ maxModelCalls: definition.maxTurns, maxToolCalls: Number.MAX_SAFE_INTEGER }),
    });
    authorities.set(
      request,
      Object.freeze({ request, workspace, tools: countedRegistry, role: definition.role, label: task }),
    );
    preparedEvidence.set(request, evidence);
    return request;
  };
  const run = async (params: Launch): Promise<SubagentResult> => {
    const context = current();
    const request = await prepare(params, 'foreground');
    const result = await context.runNested(request);
    const evidence = preparedEvidence.get(request)!;
    const runId = result.runId ?? (result.outcome.kind === 'background' ? result.outcome.runId : undefined);
    if (runId) executionEvidence.set(runId, evidence);
    return projectResult(result, request.role ?? 'agent', evidence);
  };
  const start = async (params: Launch): Promise<SubagentRunHandle> => {
    const context = current();
    const request = await prepare(params, 'background');
    const result = await context.runNested(request);
    if (result.outcome.kind !== 'background')
      throw new Error(`Subagent admission did not return a background task: ${result.outcome.kind}`);
    executionEvidence.set(result.outcome.runId, preparedEvidence.get(request)!);
    return {
      runId: result.outcome.runId,
      ...(params.name ? { name: params.name } : {}),
      role: request.role ?? 'agent',
      status: 'running',
      task: request.input,
    };
  };
  const callbacks = createDirectDelegationCallbacks(settings, { current, run, start }, executionEvidence);
  return {
    callbacks,
    withInvocation,
    bindTaskCheckIn(configure: DirectContextPort['configureTaskCheckIn']) {
      configureTaskCheckIn = configure;
    },
    setTaskCheckInPolicy(
      target: { kind: 'shell' | 'subagent'; id: string },
      policy: { enabled?: boolean; intervalMs?: number; nextDueInMs?: number },
    ) {
      current();
      if (!configureTaskCheckIn) throw new Error('Session task check-in authority is not bound');
      const result = configureTaskCheckIn(target.id, policy);
      if (!result.ok) throw new Error(`Task check-in configuration refused: ${result.code}`);
    },
    configureTaskCheckIn(params: Parameters<NonNullable<AgentFactoryDeps['configureTaskCheckIn']>>[0]) {
      current();
      if (!configureTaskCheckIn) throw new Error('Session task check-in authority is not bound');
      const result = configureTaskCheckIn(params.target, {
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.interval_seconds !== undefined ? { intervalMs: params.interval_seconds * 1000 } : {}),
        ...(params.next_check_in_seconds !== undefined ? { nextDueInMs: params.next_check_in_seconds * 1000 } : {}),
      });
      return result.ok
        ? { ok: true, message: `Task check-in configuration updated for ${params.target}.` }
        : { ok: false, error: result.code };
    },
    resolveNestedAuthority(request: NestedRunRequest): DirectNestedAuthority {
      const authority = authorities.get(request);
      if (!authority) throw new Error('Nested request was not prepared by this session tool surface');
      return authority;
    },
    dispose() {
      for (const [registry, policies] of children) {
        registry.dispose();
        policies.clear();
      }
      children.clear();
      executionEvidence.clear();
      configureTaskCheckIn = undefined;
      scope.disable();
    },
  };
}
