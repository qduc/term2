/** Source delegation contracts over the owning Session's native branch/task ports. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getCatalogModel } from '../../model/providers/model-catalog/catalog.js';
import { resolveOutputAllocation } from '../../engine/agent-runtime/model-context-policy.js';
import { adaptLegacyDefinition } from '../runtime/legacy-adapter.js';
import { resolveAgent } from '../../engine/agent-runtime/agent-resolver.js';
import { agentSpecToConfig } from '../../engine/agent-runtime/agent-spec.js';
import type { AgentSpec } from '../../engine/agent-runtime/types.js';
import { createRootBudget } from '../../engine/agent-runtime/execution-budget.js';
import type { ResolvedAgentDefinition } from '../../engine/agent-runtime/resolved-agent.js';
import type { ISubagentClient } from '../subagents/subagent-client-types.js';
import { ToolApprovalPolicyRegistry } from '../../session/approval/tool-approval-policy-registry.js';
import type { ExecutionContext } from '../../tools/execution-context.js';
import { resolveActiveEnforcement } from '../../config/profiles/active-profile.js';
import { SubagentPoolEntrySchema } from '../../config/settings/settings-schema.js';
import { SkillsService } from '../../tools/skills/skills-service.js';
import { buildInstructions, loadRoleDefinition, resolveSubagentSearchViaShell } from '../subagents/role-loader.js';
import { SubagentRolePoolSelector } from '../subagents/subagent-role-pool-selector.js';
import { SubagentToolFactory, SubagentToolPolicy, type ValidationCapture } from '../subagents/tool-policy.js';
import type { SubagentResult, SubagentDefinition, SubagentRunHandle } from '../subagents/types.js';
import { SUBAGENT_ROLES } from '../../tools/subagents/types.js';
import { DirectSubagentSessions } from './subagent-sessions.js';
import { SUBAGENT_RUN_NAME_PATTERN, SubagentRegistryError } from '../../tools/subagents/launch-contract.js';
import { pinWorkerWorktree } from '../subagents/worker-worktree.js';
import type { AnyToolDefinition, ToolRegistry } from '../../tools/types.js';
import type { ItemId, ReasoningEffort } from '../../model/index.js';
import type { DirectNestedAuthority } from '../../session/branches.js';
import type { DirectContextPort } from '../../session/capabilities.js';
import type {
  NestedRunRequest,
  Tool,
  ToolContext,
  ToolRegistry as NativeToolRegistry,
  Workspace,
} from '../../tools/index.js';
import type { ISettingsService, ILoggingService, ISessionContextService } from '../../shared/service-interfaces.js';
import type { SessionBrowser } from '../../session/conversation/session-browser.js';
import type { ConfigureTaskCheckInParams } from '../../tools/agent/configure-task-check-in.js';
import {
  createDirectDelegationCallbacks,
  backgroundReport,
  projectResult,
  type Launch,
  type ExecutionEvidence,
} from './subagent-callbacks.js';

type InvocationScope = <T>(name: string, context: unknown, operation: () => Promise<T>) => Promise<T>;
type ChildRegistry = NativeToolRegistry & { adaptTool(definition: AnyToolDefinition): Tool; dispose(): void };
type Selection = { settings: ISettingsService; logger: ILoggingService; sessionContext: ISessionContextService };

export type DirectSubagentToolsOptions = {
  readonly selection: Selection;
  readonly workspace: Workspace;
  readonly executionContext: ExecutionContext;
  readonly skillsService?: SkillsService;
  readonly readOnly: boolean;
  readonly graph: () => readonly AnyToolDefinition[];
  readonly targetInvocation?: InvocationScope;
  readonly toolContext: (invocation: unknown) => ToolContext;
  readonly createExecutionContext: (root: string) => ExecutionContext;
  readonly createRegistry: (
    definitions: ToolRegistry,
    binding: { executionContext: ExecutionContext; policies: ToolApprovalPolicyRegistry },
  ) => ChildRegistry;
  readonly remoteUnavailable: ReadonlySet<string>;
  /** The parent's session browser; legacy provisions it to the librarian only. */
  readonly sessionBrowser?: SessionBrowser;
  /** Legacy SubagentToolPolicy's advisory model client for a worker's YELLOW shell commands. */
  readonly advisoryClient?: ISubagentClient;
};

/** Legacy subagent-bridge toManagerDefinition: a resolved definition with its own root budget. */
function managerDefinition(value: ResolvedAgentDefinition): SubagentDefinition {
  const budget = createRootBudget({
    maxChildren: value.limits.maxChildren,
    maxDepth: value.limits.maxDepth,
    maxConcurrency: value.limits.maxConcurrency,
    maxTokens: value.limits.maxTokens,
  });
  return { ...adaptLegacyDefinition(value, budget), isRootExecution: true };
}

/** Legacy subagent-manager #resolveAgentSpec: run_subagent's own agent_spec, with no parent ceiling. */
function resolveRunSubagentSpec(
  spec: AgentSpec,
  deps: Pick<Selection, 'settings' | 'logger'> & { skillsService?: SkillsService },
): ResolvedAgentDefinition {
  if (spec.budget) {
    const unsupported = Object.keys(spec.budget).filter((key) => key !== 'maxTurns' && key !== 'maxTokens');
    if (unsupported.length > 0)
      throw new Error(`Unsupported AgentSpec budget fields in delegated runs: ${unsupported.join(', ')}`);
    for (const key of ['maxTurns', 'maxTokens'] as const) {
      const value = spec.budget[key];
      if (value !== undefined && (!Number.isInteger(value) || value <= 0))
        throw new Error(`AgentSpec budget.${key} must be a positive integer.`);
    }
  }
  const definition = resolveAgent(agentSpecToConfig(spec), deps);
  if (definition.resolutionErrors.length > 0)
    throw new Error(
      `Agent specification rejected: ${definition.resolutionErrors.map((error) => error.message).join('; ')}`,
    );
  return definition;
}

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
  const children = new Map<ChildRegistry, ToolApprovalPolicyRegistry>();
  let configureTaskCheckIn: DirectContextPort['configureTaskCheckIn'] | undefined;
  const pool = new SubagentRolePoolSelector(settings);
  // Tool evidence only, not a lifecycle registry: task state and results stay
  // in Session. Writes come from source wrappers; counts come from admitted
  // native Tool.execute entries, never model-requested tool_call items.
  const preparedEvidence = new WeakMap<NestedRunRequest, ExecutionEvidence>();
  const executionEvidence = new Map<string, ExecutionEvidence>();
  const sessions = new DirectSubagentSessions<SubagentDefinition>(
    (code, message) => new SubagentRegistryError(code as never, message),
    () => settings.get('subagent.asyncMessageCap') ?? 50,
  );
  const preparedSessions = new WeakMap<
    NestedRunRequest,
    { readonly key: string | undefined; readonly definition: SubagentDefinition }
  >();
  const current = (): ToolContext => {
    const context = scope.getStore();
    if (!context) throw new Error('Subagent operation has no admitted direct tool execution');
    context.signal.throwIfAborted();
    return context;
  };
  const withInvocation: InvocationScope = (name, invocation, operation) => {
    const context = options.toolContext(invocation);
    return scope.run(context, () =>
      options.targetInvocation ? options.targetInvocation(name, invocation, operation) : operation(),
    );
  };

  const prepare = async (
    params: Launch,
    mode: 'foreground' | 'background',
  ): Promise<NestedRunRequest & { readonly input: string }> => {
    const prior = sessions.prior(params, mode, current().subagents);
    const planMode = resolveActiveEnforcement(settings).denials.has('filesystem-mutation');
    let definition: SubagentDefinition;
    let task: string;
    let authorizedPath: string | undefined;
    if (prior?.definition) {
      // Legacy: a continuation keeps the definition and model it ran with; no second pool draw.
      definition = prior.definition;
      task = params.task ?? params.agent_spec?.goal ?? '';
      authorizedPath = params.authorizedWorktreePath;
    } else if (params.agent_spec) {
      // run_code's boundary already resolved a script child; run_subagent's own spec resolves once here.
      const resolved =
        params.resolvedDefinition ??
        resolveRunSubagentSpec(params.agent_spec, { settings, logger, skillsService: options.skillsService });
      definition = { ...managerDefinition(resolved), role: 'agent', isScriptGeneric: true };
      task = params.agent_spec.goal;
      authorizedPath = params.authorizedWorktreePath;
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
    // Legacy launches a writer without a worktree (in the workspace) and in a read-only session (its factory
    // then offers no writes); plan mode is refused earlier by the plan-mode interceptor.
    if (definition.canWrite && planMode) throw new Error('This session cannot delegate writes');
    // Children retain their admission root even if the parent later changes its lease.
    let executionContext = options.executionContext.isRemote()
      ? options.executionContext
      : options.createExecutionContext(options.executionContext.getCwd());
    let workspace = Object.freeze({ ...options.workspace, root: executionContext.getCwd() });
    let worktreePath: string | undefined;
    // Legacy's runners settle a failed pin as a failed run (empty result, the pin error), not a launch refusal.
    let pinFailure: string | undefined;
    if (params.worktree) {
      const pinned = await pinWorkerWorktree({
        name: params.worktree,
        role: definition.role,
        homeRoot: options.workspace.root,
        isRemote: executionContext.isRemote(),
        authorizedPath,
      });
      if (!pinned.ok) pinFailure = pinned.error;
      else {
        executionContext = pinned.executionContext;
        workspace = Object.freeze({ ...workspace, root: pinned.worktreePath });
        worktreePath = pinned.worktreePath;
      }
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
      ...(options.advisoryClient ? { agentClient: options.advisoryClient } : {}),
    });
    const factory = new SubagentToolFactory({
      settings,
      logger,
      executionContext,
      toolPolicy: policy,
      skillsService,
      readOnly: options.readOnly || planMode,
      ...(options.sessionBrowser ? { sessionBrowser: options.sessionBrowser } : {}),
    });
    // Reviewer remains evidence-only: its sole delegated path is another
    // native explorer branch, not inherited workspace or arbitrary agent tools.
    factory.setExplorerRunner(async (question) => run({ role: 'explorer', task: question }));
    const filesChanged: string[] = [];
    // Legacy's background runner captures diffs and validation; its foreground runner passes neither.
    const diffDeltas = mode === 'background' ? new Map<string, { added: number; deleted: number }>() : undefined;
    const validation: ValidationCapture | undefined = mode === 'background' ? {} : undefined;
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
      .buildToolDefinitions(
        definition,
        filesChanged,
        task,
        searchViaShell,
        // Legacy prompts only for a foreground child; a background child's tools never ask (execution-runner).
        mode === 'foreground',
        diffDeltas,
        validation,
        askOrchestrator,
      )
      .filter(
        (tool) =>
          // Legacy gives a named role its whole factory set; a script child keeps its parent's ceiling.
          (!definition.isScriptGeneric ||
            parentNames.has(tool.name) ||
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
    const registry = options.createRegistry(wrapped, { executionContext, policies });
    children.set(registry, policies);
    const evidence: ExecutionEvidence = {
      filesChanged,
      toolCounts: new Map(),
      maxTurns: definition.maxTurns,
      ...(worktreePath ? { worktreePath } : {}),
      ...(diffDeltas ? { diffDeltas } : {}),
      ...(validation ? { validation } : {}),
    };
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
    // Preserve the source child policy: explicit role allocation wins. Legacy's background runner otherwise
    // inherits the configured setting with the catalog default clamp; its foreground runner sends none.
    const maxOutputTokens =
      definition.maxTokens ??
      (mode === 'foreground'
        ? undefined
        : resolveOutputAllocation(
            getCatalogModel(definition.provider, definition.model),
            settings.get('agent.maxOutputTokens'),
            settings.getSource?.('agent.maxOutputTokens') === 'default',
          ));
    const request: NestedRunRequest & { readonly input: string } = Object.freeze({
      mode,
      ...(prior?.runId ? { runId: prior.runId } : {}),
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
        ...(prior?.history ?? []),
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
      Object.freeze({
        request,
        workspace,
        tools: countedRegistry,
        role: definition.role,
        label: task,
        ...(pinFailure !== undefined ? { failure: pinFailure } : {}),
        ...(mode === 'background' ? { report: backgroundReport(definition.role, evidence) } : {}),
      }),
    );
    preparedEvidence.set(request, evidence);
    preparedSessions.set(request, { key: prior?.key, definition });
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
    // Legacy SubagentAsyncRegistry.startRun name admission: same codes and text, which the async tool returns.
    const name = params.name;
    if (name !== undefined && !SUBAGENT_RUN_NAME_PATTERN.test(name))
      throw new SubagentRegistryError('invalid_name', `Invalid async subagent name: ${name}`);
    if (name !== undefined && context.subagents?.list().some((task) => task.name === name && !task.result))
      throw new SubagentRegistryError('name_in_use', `Async subagent name is already active: ${name}`);
    const result = await context.runNested(request);
    if (result.outcome.kind !== 'background')
      throw new Error(`Subagent admission did not return a background task: ${result.outcome.kind}`);
    executionEvidence.set(result.outcome.runId, preparedEvidence.get(request)!);
    const session = preparedSessions.get(request)!;
    sessions.record(result.outcome.runId, request.role ?? 'agent', session.key, request.items, session.definition);
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
    configureTaskCheckIn(params: ConfigureTaskCheckInParams) {
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
